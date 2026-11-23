import { STEPS } from '../shared/pipeline'
import type { AgentEvent } from '../shared/pipeline'
import { applyCodeFacts, describePagination, extractCodeFacts } from '../shared/code'
import { PROMPTS, SYSTEM_PROMPT } from '../shared/prompts'
import type { PromptStepId } from '../shared/prompts'
import { fullPrd } from '../shared/types'
import type { CodeFacts, GenerateInput, PageContract } from '../shared/types'
import { scanCode } from './code'
import type { RuntimeConfig } from './config'
import { engineLabel, hasLlm } from './config'
import { callJson } from './engine/llm'
import { emptyContract, finalize, mergePartial } from './engine/normalize'
import { buildArtifacts } from './generators'
import { dropScopeQuestions, sliceForPage } from './pages'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function summarize(patch: Partial<PageContract>): string {
  const parts: string[] = []
  if (patch.page) parts.push(`页面 ${patch.page.title ?? ''}`.trim())
  if (patch.regions?.length) parts.push(`区域 ${patch.regions.length}`)
  if (patch.fields?.length) parts.push(`字段 ${patch.fields.length}`)
  if (patch.apis?.length) parts.push(`接口 ${patch.apis.length}`)
  if (patch.states?.length) parts.push(`状态 ${patch.states.length}`)
  if (patch.edgeCases?.length) parts.push(`边界 ${patch.edgeCases.length}`)
  if (patch.openQuestions?.length) parts.push(`缺口 ${patch.openQuestions.length}`)
  return parts.join(' · ') || '已更新'
}

/** 一次模型调用 = 一步；失败重试一次，再失败就把错误抛给界面，绝不拿假数据糊过去 */
async function callStep(
  step: PromptStepId,
  prd: string,
  input: GenerateInput,
  contract: PageContract,
  config: RuntimeConfig,
  code: string,
) {
  const prompt = PROMPTS[step].build({ prd, stack: input.stack, uiLib: input.uiLib, partial: contract, code })
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const patch = await callJson<Partial<PageContract>>(config, SYSTEM_PROMPT, prompt)
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('模型返回的不是 JSON 对象')
      return patch
    } catch (error) {
      lastError = error as Error
      if (attempt === 0) await sleep(800)
    }
  }
  throw lastError ?? new Error('模型调用失败')
}

/** 六步流水线：先读代码，四步由模型抽取，最后一步把契约编译成产物 */
export async function* runAgent(input: GenerateInput, config: RuntimeConfig): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now()
  const engine = engineLabel(config)

  if (!hasLlm(config)) {
    yield {
      type: 'error',
      message: '没有配置模型：在 .env 里填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 后再试。这个工具不做规则兜底，宁可报错也不出假结果。',
    }
    return
  }

  let contract = emptyContract(input, engine)
  let stepIndex = 0
  const material = fullPrd(input)
  // 多页材料里只生成选中那一页：切出该页正文，其余页面不参与
  const prd = input.page ? sliceForPage(material, input.page) : material
  // 先读代码：代码里已经有的事实，后面不再当成需求缺口
  let code = input.code?.trim() ?? ''
  let codeFacts: CodeFacts | undefined

  for (const step of STEPS) {
    stepIndex += 1
    yield { type: 'status', step: step.id, status: 'running' }

    if (step.id === 'code') {
      // 生成时才扫代码：省掉一次「读代码」点击，也保证读的就是当前磁盘状态
      let scannedFiles = 0
      let truncated = false
      if (!code && input.codePath?.trim()) {
        try {
          const scan = await scanCode(input.codePath, input.page)
          code = scan.digest
          codeFacts = scan.facts
          scannedFiles = scan.files
          truncated = scan.truncated
          yield { type: 'log', step: step.id, text: `扫描 ${input.codePath}：${scan.files} 个文件，摘要命中 ${scan.matched.length} 个` }
          if (scan.focus) yield { type: 'log', step: step.id, text: `页面代码：${scan.focus}` }
          if (scan.matched.length) {
            const listed = scan.matched.slice(0, 4).join('、')
            yield {
              type: 'log',
              step: step.id,
              text: `命中：${listed}${scan.matched.length > 4 ? ` 等 ${scan.matched.length} 个` : ''}`,
            }
          }
        } catch (error) {
          yield { type: 'status', step: step.id, status: 'failed' }
          yield { type: 'error', message: `读代码失败：${(error as Error).message}。改好项目路径或清空后再试。` }
          return
        }
      }
      if (!code) {
        yield { type: 'log', step: step.id, text: '没提供现有代码：本次只按 PRD 生成，分页/接口这类事实可能被误当成缺口' }
        yield { type: 'status', step: step.id, status: 'done', summary: '未提供代码，跳过' }
        continue
      }
      const facts = extractCodeFacts(code)
      const pagination = facts.pagination ? describePagination(facts.pagination) : ''
      const source = scannedFiles ? `${input.codePath}（${scannedFiles} 个文件${truncated ? '，摘要已截断' : ''}）` : input.codePath || '手动提供'
      yield { type: 'log', step: step.id, text: `代码来源：${source}（摘要 ${code.length} 字）` }
      if (pagination) yield { type: 'log', step: step.id, text: `分页：${pagination}（以代码为准）` }
      if (facts.apis.length) yield { type: 'log', step: step.id, text: `接口：${facts.apis.join('、')}` }
      const summary = [pagination, facts.apis.length ? `${facts.apis.length} 个接口` : ''].filter(Boolean).join(' · ')
      yield { type: 'status', step: step.id, status: 'done', summary: summary || '已读取，未识别到结构化事实' }
      continue
    }

    if (step.id === 'artifacts') {
      contract = finalize(contract)
      const artifacts = buildArtifacts(contract)
      const lines = (value: string) => value.split('\n').length
      const logs = [
        `页面骨架 ${lines(artifacts.skeleton)} 行：通用状态分支、字段列、TODO 标记齐全`,
        `Mock ${lines(artifacts.mock)} 行：?__state= 可切通用状态，业务状态需自行补`,
        `E2E ${lines(artifacts.e2e)} 行：只测骨架真正实现的通用状态`,
        `自测清单 ${lines(artifacts.checklist)} 行，需求缺口 ${contract.openQuestions.length} 个`,
      ]
      for (const log of logs) {
        await sleep(90)
        yield { type: 'log', step: step.id, text: log }
      }
      yield { type: 'status', step: step.id, status: 'done', summary: `${contract.states.length} 个状态已覆盖` }
      yield { type: 'result', result: { contract, artifacts, engine, elapsedMs: Date.now() - startedAt } }
      return
    }

    const stepStartedAt = Date.now()
    yield { type: 'log', step: step.id, text: `调用 ${config.model}…${input.page ? `（只生成「${input.page}」）` : ''}` }

    let patch: Partial<PageContract>
    try {
      patch = await callStep(step.id, prd, input, contract, config, code)
    } catch (error) {
      yield { type: 'status', step: step.id, status: 'failed' }
      yield {
        type: 'error',
        message: `第 ${stepIndex} 步失败：${(error as Error).message}。模型这条路没有兜底，改好再重试。`,
      }
      return
    }

    yield { type: 'log', step: step.id, text: `模型返回：${summarize(patch)}（${((Date.now() - stepStartedAt) / 1000).toFixed(1)}s）` }
    contract = mergePartial(contract, patch)

    // 缺口生成完立刻用代码事实兜一次底：分页这类代码里已有的，不进评审清单
    let summary = summarize(patch)
    if (step.id === 'edges') {
      const applied = applyCodeFacts(contract, code, codeFacts)
      contract = applied.contract
      if (applied.dropped.length) {
        yield { type: 'log', step: step.id, text: `按代码已有事实跳过 ${applied.dropped.length} 个缺口（分页参数以代码为准）` }
      }
      const scoped = dropScopeQuestions(contract)
      contract = scoped.contract
      if (scoped.dropped.length) {
        yield { type: 'log', step: step.id, text: `跳过 ${scoped.dropped.length} 个「本文档包含多个页面」范围提示：生成哪一页由页面清单决定` }
      }
      if (applied.dropped.length || scoped.dropped.length) {
        summary = summarize({ ...patch, openQuestions: contract.openQuestions })
      }
    }

    yield { type: 'partial', contract }
    yield { type: 'status', step: step.id, status: 'done', summary }
  }
}
