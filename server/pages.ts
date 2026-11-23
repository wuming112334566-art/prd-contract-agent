import type { PageCandidate, PageContract } from '../shared/types'
import type { RuntimeConfig } from './config'
import { callJson } from './engine/llm'

const PAGE_PROMPT = `列出这份材料里包含的**所有页面**。

「页面」= 一个独立路由，或一个独立的弹窗/抽屉（有自己的字段和操作）。
不要把「筛选条件」「列表字段」「接口」「验收标准」这类小节当成页面。

只输出 JSON：
{ "pages": [ { "title": "数据报表", "route": "/data-report", "hint": "三个 Tab：佩戴情况 / 房颤事件 / 物流信息" } ] }

规则：
1. title 用材料里的叫法，不要自己改名。
2. 拿不准路由就留空字符串。
3. 最多 12 个，按材料里的出现顺序。
4. 如果材料本身只有一个页面，就只返回一个。`

/** 设计稿画板是现成的页面候选，但还得回到需求文档里过一遍范围，见 filterDesignPages */
export function pagesFromDesign(groups: Array<{ frame: string; texts: string[] }>): PageCandidate[] {
  return groups
    .filter((group) => !/未命名/.test(group.frame))
    .map((group) => ({
      title: group.frame,
      hint: group.texts.slice(0, 4).join('、'),
      source: 'design' as const,
    }))
}

const SCOPE_PROMPT = `下面是本期需求文档，和设计稿里的画板名清单。
只留下**本期需求真正要做**的画板：文档里没提的、或只在统计口径 / 数据来源 / 已有功能里被引用的，都删掉。

只输出 JSON，frames 里的名字逐字照抄画板名、保持原顺序，不要新增、不要改名：
{ "frames": ["数据报表", "导出列表"] }`

/**
 * 设计稿同一个画布上常留着历史版本的画板，画板名本身说明不了它属不属于本期。
 * 让模型对着需求文档筛一遍，只留范围内的——不新增页面，页面清单仍然来自设计稿。
 */
export async function filterDesignPages(
  pages: PageCandidate[],
  doc: string,
  config: RuntimeConfig,
): Promise<PageCandidate[]> {
  const payload = await callJson<{ frames?: string[] }>(
    config,
    '你是资深需求分析师，擅长从需求文档里界定本期页面范围。只输出 JSON。',
    `${SCOPE_PROMPT}\n\n设计稿画板：\n${pages.map((page) => `- ${page.title}`).join('\n')}\n\n需求文档：\n"""\n${doc.slice(0, 8000)}\n"""`,
  )

  const keep = new Set((payload.frames ?? []).map((name) => String(name).trim()))
  const kept = pages.filter((page) => keep.has(page.title))
  // 模型把画板删光或答非所问时，退回设计稿原样，别给一份空清单
  return kept.length ? kept : pages
}

/** 设计稿段拼进正文时的起始标记：它只是字段来源，不能当页面清单，切片和识别都要按它切开 */
export const DESIGN_SECTION = '## 设计稿（'

const MULTI_PAGE = /(?:本文档|该文档|文档|这份材料|材料).{0,30}(?:多个|若干|\d+\s*个).{0,12}页面|多个页面|其余页面/
const SCOPE_CONFIRM = /本次只生成|逐页|是否确认|确认只生成|一次性生成全部/

/**
 * 「本文档包含多个页面，本次只生成 X，是否确认？」不是需求缺口：
 * 生成哪一页由用户在页面清单里勾选，工具自己知道。两个条件都命中才删，避免误伤真问题。
 */
export function dropScopeQuestions(contract: PageContract): { contract: PageContract; dropped: string[] } {
  const dropped: string[] = []
  const openQuestions = contract.openQuestions.filter((item) => {
    if (!MULTI_PAGE.test(item.question) || !SCOPE_CONFIRM.test(item.question)) return true
    dropped.push(item.question)
    return false
  })
  return dropped.length ? { contract: { ...contract, openQuestions }, dropped } : { contract, dropped }
}

/**
 * 切出某一页的正文：从标题出现的位置往后取，再把全文里「全局/背景/角色/权限」这类通用段落带在前面。
 * 设计稿那一段单独保留，并只留下与这一页同名的画板。
 */
export function sliceForPage(prd: string, title: string, limit = 6000): string {
  const designIndex = prd.indexOf(DESIGN_SECTION)
  const doc = designIndex >= 0 ? prd.slice(0, designIndex) : prd
  const design = designIndex >= 0 ? prd.slice(designIndex) : ''

  const index = doc.indexOf(title)
  const sliced = index < 0 ? doc : doc.slice(index, index + limit)
  const before = index < 0 ? '' : doc.slice(0, index)

  const globalBits = before
    .split(/\n{2,}/)
    .filter((block) => /全局|通用|背景|角色|权限|账号|术语|约定/.test(block))
    .slice(0, 6)
    .join('\n\n')

  const designLines = design
    .split('\n')
    .filter((line) => (line.startsWith('- ') ? line.includes(title) : true))
    .join('\n')

  const parts = [
    `本次只生成「${title}」这一页。材料里还有其他页面属于正常情况，` +
      '不要把「文档包含多个页面」写成需求缺口，缺口只写这一页真正没写清的地方。',
  ]
  if (globalBits) parts.push(`## 全局说明（从全文提取）\n${globalBits}`)
  parts.push(`## ${title}\n${sliced}`)
  if (designLines.trim()) parts.push(designLines)

  return parts.join('\n\n')
}

export async function detectPagesWithModel(prd: string, config: RuntimeConfig): Promise<PageCandidate[]> {
  const payload = await callJson<{ pages?: Array<{ title?: string; route?: string; hint?: string }> }>(
    config,
    '你是资深前端架构师，擅长把需求文档拆成页面清单。只输出 JSON。',
    `${PAGE_PROMPT}\n\n材料：\n"""\n${prd.slice(0, 12000)}\n"""`,
  )

  const pages = (payload.pages ?? [])
    .filter((page) => typeof page.title === 'string' && page.title.trim())
    .slice(0, 12)
    .map((page) => ({
      title: String(page.title).trim(),
      route: page.route?.trim() || undefined,
      hint: page.hint?.trim() || undefined,
      source: 'prd' as const,
    }))

  if (!pages.length) throw new Error('没识别出页面，可能是材料太短或结构太散')
  return pages
}
