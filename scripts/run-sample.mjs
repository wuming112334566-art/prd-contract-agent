#!/usr/bin/env node
/**
 * 拿示例 PRD 跑一遍完整流水线，产物落盘到 out/。
 * 演示录制时直接用它产出「任务记录 + 产物」，也方便在 CI 里做冒烟。
 *
 *   node scripts/run-sample.mjs                 # 默认 order-list
 *   node scripts/run-sample.mjs stock-board     # 换一个示例
 *   BASE=http://localhost:5180 node scripts/run-sample.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = process.env.BASE ?? 'http://localhost:5180'
const sampleId = process.argv[2] ?? 'order-list'

const prd = await readFile(join(root, 'samples', `${sampleId}.prd.md`), 'utf8')
const startedAt = Date.now()

const response = await fetch(`${base}/api/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prd, stack: 'react', uiLib: '@company/ui' }),
})

if (!response.ok || !response.body) {
  throw new Error(`生成失败：HTTP ${response.status}`)
}

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const events = []

for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const frames = buffer.split('\n\n')
  buffer = frames.pop() ?? ''
  for (const frame of frames) {
    const line = frame.split('\n').find((item) => item.startsWith('data:'))
    if (!line) continue
    events.push(JSON.parse(line.slice(5).trim()))
  }
}

const result = events.find((event) => event.type === 'result')
if (!result) {
  const failure = events.find((event) => event.type === 'error')
  throw new Error(`流水线没有产出结果：${failure?.message ?? '未知错误'}`)
}

const { contract, artifacts } = result.result
const outDir = join(root, 'out', contract.page.id)
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, `${contract.page.id}.contract.yaml`), artifacts.yaml, 'utf8')
await writeFile(join(outDir, `${contract.page.id}.contract.json`), JSON.stringify(contract, null, 2), 'utf8')
await writeFile(join(outDir, 'Page.tsx'), artifacts.skeleton, 'utf8')
await writeFile(join(outDir, 'handlers.ts'), artifacts.mock, 'utf8')
await writeFile(join(outDir, `${contract.page.id}.spec.ts`), artifacts.e2e, 'utf8')
await writeFile(join(outDir, 'checklist.md'), artifacts.checklist, 'utf8')

const logs = events.filter((event) => event.type === 'log')
console.log(`\n引擎：${result.result.engine}   总耗时：${Date.now() - startedAt}ms\n`)
console.log('执行过程：')
for (const event of logs) console.log(`  · [${event.step}] ${event.text}`)
console.log(`\n契约：${contract.page.title}  ${contract.page.route}`)
console.log(`  字段 ${contract.fields.length} · 区域 ${contract.regions.length} · 状态 ${contract.states.length} · 接口 ${contract.apis.length}`)
console.log(`  边界 ${contract.edgeCases.length} · 埋点 ${contract.tracking.length} · 缺口 ${contract.openQuestions.length}`)
console.log(`  需人工确认的 assumption：${contract.fields.filter((field) => field.source === 'assumption').length} 个字段`)
console.log('\n需求缺口（拿去开评审会）：')
for (const item of contract.openQuestions) console.log(`  ${item.blocking ? '[阻塞]' : '[一般]'} ${item.question}`)
console.log(`\n产物已写入 out/${contract.page.id}/\n`)
