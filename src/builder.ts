#! /usr/bin/env node

require("v8-compile-cache")

import * as ts from "typescript"
import * as path from "path"
import * as babel from "@babel/core"
import { readdir, ensureDir, unlink, outputFile, outputJson } from "fs-extra-p"
import BluebirdPromise from "bluebird-lst"
import { transpile, checkErrors } from "./util"

transpile(async (basePath: string, config: ts.ParsedCommandLine, tsConfig: any) => {
  const compilerOptions = config.options
  if (tsConfig.declaration !== false) {
    compilerOptions.declaration = true
  }

  compilerOptions.noEmitOnError = true

  const program = ts.createProgram(config.fileNames, compilerOptions, ts.createCompilerHost(compilerOptions))
  checkErrors(ts.getPreEmitDiagnostics(program))

  const compilerOutDir = path.resolve(program.getCurrentDirectory(), compilerOptions.outDir!!)
  if (compilerOutDir == null) {
    throw new Error("outDir is not specified in the compilerOptions")
  }

  await ensureDir(compilerOutDir)

  const fileToSourceMap: any = {}
  const promises: Array<Promise<any>> = []
  const emittedFiles = new Set<string>()
  const currentDirectory = program.getCurrentDirectory()
  const emitResult = program.emit(undefined, (fileName, data) => {
    const file = path.resolve(currentDirectory, fileName)
    emittedFiles.add(file)

    if (file.endsWith(".js")) {
      const sourceMapFileName = `${file}.map`
      processCompiled(data, fileToSourceMap[sourceMapFileName], file, sourceMapFileName, promises, currentDirectory)
    }
    else if (file.endsWith(".js.map")) {
      fileToSourceMap[file] = data
    }
    else {
      promises.push(outputFile(file, data))
    }
  })

  checkErrors(emitResult.diagnostics)
  if (emitResult.emitSkipped) {
    throw new Error("Emit skipped")
  }

  await Promise.all(promises)
  await removeOld(compilerOutDir, emittedFiles)
})
  .catch(error => {
    console.error(error.stack || error.message || error)
    // noinspection TypeScriptValidateJSTypes
    process.exit(-1)
  })

async function removeOld(outDir: string, emittedFiles: Set<string>): Promise<any> {
  await BluebirdPromise.map(await readdir(outDir), file => {
    const fullPath = path.resolve(outDir, file)
    if (!file.includes(".")) {
      return removeOld(fullPath, emittedFiles)
    }

    if ((file.endsWith(".js") || file.endsWith(".js.map") || file.endsWith(".d.ts")) && !emittedFiles.has(fullPath)) {
      return unlink(fullPath)
    }
    return null
  })
}

function processCompiled(code: string, sourceMap: string, jsFile: string, sourceMapFileName: string, promises: Array<Promise<any>>, currentDirectory: string) {
  const options: any = {
    inputSourceMap: sourceMap == null ? null : JSON.parse(sourceMap),
    sourceMaps: true,
    filename: jsFile,
    root: currentDirectory,
  }
  const result = babel.transform(code, options)

  const match = code.match(regex)!!
  const sourceMapUrl = match[1] || match[2]

  // add marker, so, babel-jest can easily detect is file required to be processed or not (maybe processed by IDE TS compiler)
  promises.push(
    outputFile(jsFile, result.code.replace(regex, "") + `\n// __ts-babel@6.0.4` + `\n//# sourceMappingURL=${sourceMapUrl}`),
    outputJson(sourceMapFileName, result.map))
}

const innerRegex = /[#@] sourceMappingURL=([^\s'"]*)/
const regex = RegExp(
  "(?:" +
  "/\\*" +
  "(?:\\s*\r?\n(?://)?)?" +
  "(?:" + innerRegex.source + ")" +
  "\\s*" +
  "\\*/" +
  "|" +
  "//(?:" + innerRegex.source + ")" +
  ")" +
  "\\s*"
)