#!/usr/bin/env node
/**
 * 语法校验：out/ 下所有生成的 ts/tsx 必须能被 TypeScript 解析。
 * 「AI 生成的代码能过 review」这句话得有东西兜底，这就是那一层。
 *
 *   node scripts/check-generated.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'out')

let files
try {
  files = readdirSync(root)
} catch {
  console.error('还没有 out/ 目录，先跑 node scripts/run-sample.mjs')
  process.exit(1)
}

const targets = []
for (const entry of files) {
  const dir = join(root, entry)
  if (!statSync(dir).isDirectory()) continue
  for (const name of readdirSync(dir)) {
    if (/\.(tsx?|jsx?)$/.test(name)) targets.push(join(dir, name))
  }
}

let failed = 0
for (const file of targets) {
  const result = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  const errors = (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
  if (errors.length) {
    failed += 1
    console.log(`✗ ${file.replace(root, '')} → ${ts.flattenDiagnosticMessageText(errors[0].messageText, ' ')}`)
  } else {
    console.log(`✓ ${file.replace(root, '')}`)
  }
}

console.log(failed ? `\n${failed} 个文件有语法错误` : `\n${targets.length} 个文件全部通过语法检查`)
process.exit(failed ? 1 : 0)
