import type { AgentEvent } from '../shared/pipeline'
import type { GenerateInput, PageCandidate, ProjectListing, ResolveResult, SpecPage } from '../shared/types'

export interface HealthInfo {
  engine: string
  llm: boolean
  model: string
  sources: { feishu: boolean; figma: boolean }
}

export async function fetchHealth(): Promise<HealthInfo> {
  const response = await fetch('/api/health')
  if (!response.ok) throw new Error('健康检查失败')
  return (await response.json()) as HealthInfo
}

/** 读取飞书文档 / Figma 设计稿，返回拼好的纯文本 */
export async function resolveSources(urls: string): Promise<ResolveResult> {
  const response = await fetch('/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  })
  const payload = (await response.json()) as ResolveResult & { message?: string }
  if (!response.ok) throw new Error(payload.message ?? `读取失败：HTTP ${response.status}`)
  return payload
}

/** 列一层目录，给项目选择弹框用 */
export async function listProjects(path?: string): Promise<ProjectListing> {
  const query = path?.trim() ? `?path=${encodeURIComponent(path.trim())}` : ''
  const response = await fetch(`/api/projects${query}`)
  const payload = (await response.json()) as ProjectListing & { message?: string }
  if (!response.ok) throw new Error(payload.message ?? `读取目录失败：HTTP ${response.status}`)
  return payload
}

/** 让模型把材料拆成页面清单 */
export async function detectPages(prd: string): Promise<PageCandidate[]> {
  const response = await fetch('/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prd }),
  })
  const payload = (await response.json()) as { pages?: PageCandidate[]; message?: string }
  if (!response.ok) throw new Error(payload.message ?? `识别失败：HTTP ${response.status}`)
  return payload.pages ?? []
}

/** 生成完整需求 .md：把契约 + 缺口回复交给模型，返回一份可直接开发的规格 */
export async function generateSpec(pages: SpecPage[], prd: string): Promise<string> {
  const response = await fetch('/api/spec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pages, prd }),
  })
  const payload = (await response.json()) as { md?: string; message?: string }
  if (!response.ok) throw new Error(payload.message ?? `生成失败：HTTP ${response.status}`)
  return payload.md ?? ''
}

/**
 * 读 SSE 流。服务端把「步骤状态 / 日志 / 契约增量 / 最终产物」都压成 data: 事件，
 * 前端按事件类型各自处理，不再需要轮询。
 */
export async function streamAgent(input: GenerateInput, onEvent: (event: AgentEvent) => void): Promise<void> {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok || !response.body) {
    throw new Error(`生成失败：HTTP ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((item) => item.startsWith('data:'))
      const payload = line?.slice(5).trim()
      if (!payload) continue
      onEvent(JSON.parse(payload) as AgentEvent)
    }
  }
}
