import type { SourceInfo, ResolveResult } from '../../shared/types'
import type { RuntimeConfig } from '../config'
import { hasLlm } from '../config'
import { DESIGN_SECTION, filterDesignPages, pagesFromDesign } from '../pages'
import { parseFeishuUrl, readFeishu } from './feishu'
import { parseFigmaUrl, readFigma } from './figma'

/** 长文档先压缩到这个长度，再交给 Agent；剩下的额度留给提示词和输出 */
const TEXT_LIMIT = 14000

export function extractUrls(input: string): string[] {
  const found = input.match(/https?:\/\/[^\s，,、)）"'<>]+/g) ?? []
  return [...new Set(found.map((url) => url.replace(/[。；;:：]+$/, '')))]
}

const POSITIVE = /页面|原型|字段|交互|接口|功能|流程|需求|规则|状态|权限|按钮|列表|表单|弹窗/g
const NEGATIVE = /附录|变更记录|评审记录|名词解释|版本历史|术语表|参考资料/

function scoreBlock(block: string): number {
  const hits = (block.match(POSITIVE) ?? []).length
  return hits * 2 - (NEGATIVE.test(block) ? 6 : 0)
}

/**
 * 长 PRD 不可能整篇塞进上下文，按小节打分挑「跟页面最相关」的段落，
 * 而不是粗暴截断前 N 字——PRD 的结构信息往往就在中后段。
 */
export function condense(text: string, limit = TEXT_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }

  const blocks = text.split(/\n(?=#{1,6}\s)/).filter(Boolean)
  if (blocks.length < 2) return { text: text.slice(0, limit), truncated: true }

  const ranked = blocks
    .map((block, index) => ({ block, index, score: scoreBlock(block) }))
    .sort((a, b) => b.score - a.score)

  const picked: typeof ranked = []
  let total = 0
  for (const item of ranked) {
    if (total + item.block.length > limit) continue
    picked.push(item)
    total += item.block.length
  }

  const kept = picked
    .sort((a, b) => a.index - b.index)
    .map((item) => item.block)
    .join('\n')

  return { text: kept || text.slice(0, limit), truncated: true }
}

interface Resolved {
  kind: SourceInfo['kind']
  url: string
  label: string
  text?: string
  fields?: string[]
  outline?: string
  groups?: Array<{ frame: string; texts: string[] }>
  error?: string
}

/**
 * 设计稿和 PRD 几分钟内不会变，缓存住有两个好处：
 * 1) 同一个文档反复生成不用重复拉；
 * 2) Figma 调太勤会被限流——它限流时返回的是 404 而不是 429，看起来像「没权限」，很容易误判。
 */
const CACHE_TTL = 5 * 60 * 1000
const cache = new Map<string, { at: number; value: Resolved }>()

async function resolveWithRetry(url: string, config: RuntimeConfig): Promise<Resolved> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    console.log('[sources] cache hit', url.slice(0, 60))
    return hit.value
  }

  console.log('[sources] cache miss', url.slice(0, 60))
  const first = await resolveOne(url, config)
  const value = first.error ? await resolveOne(url, config) : first
  console.log('[sources]', value.kind, value.error ?? 'ok', value.fields ? `${value.fields.length} 字段` : '')
  if (!value.error) cache.set(url, { at: Date.now(), value })
  return value
}

async function resolveOne(url: string, config: RuntimeConfig): Promise<Resolved> {
  if (parseFeishuUrl(url)) {
    try {
      const doc = await readFeishu(url, config)
      return { kind: 'feishu', url, label: doc.label, text: doc.text }
    } catch (error) {
      return { kind: 'feishu', url, label: '飞书文档', error: (error as Error).message }
    }
  }
  if (parseFigmaUrl(url)) {
    try {
      const design = await readFigma(url, config)
      return {
        kind: 'figma',
        url,
        label: design.label,
        fields: design.fields,
        outline: design.outline,
        groups: design.groups,
      }
    } catch (error) {
      return { kind: 'figma', url, label: 'Figma 设计稿', error: (error as Error).message }
    }
  }
  return { kind: 'unknown', url, label: url, error: '链接类型不认识：只支持飞书文档（docx / wiki）和 Figma 设计稿' }
}

export async function resolveSources(raw: string, config: RuntimeConfig): Promise<ResolveResult> {
  const urls = extractUrls(raw)
  if (!urls.length) throw new Error('没找到链接，粘一个飞书文档或 Figma 设计稿的地址进来')

  // 串行读取：两个外部接口并发时 Figma 会偶发 404（限流表现），串行稳定得多
  const results: Resolved[] = []
  for (const url of urls) {
    results.push(await resolveWithRetry(url, config))
  }
  const usable = results.filter((item) => !item.error)
  if (!usable.length) {
    throw new Error(results.map((item) => `${item.label}：${item.error}`).join('\n'))
  }

  const parts: string[] = []
  const docs = usable.filter((item) => item.kind === 'feishu' && item.text)
  if (docs.length) {
    const body = docs.map((item) => item.text ?? '').join('\n\n')
    // 文档正文常常没有 markdown 标题，先补一行 H1，否则页面标题会被后面的「## 设计稿」抢走
    const firstLine = body.split('\n').map((line) => line.trim()).find(Boolean) ?? '需求文档'
    const rest = body.startsWith(firstLine) ? body.slice(firstLine.length).replace(/^\n+/, '') : body
    parts.push(`# ${firstLine.slice(0, 40)}\n\n${rest}`)
  }

  const docText = docs.map((item) => item.text ?? '').join('\n')

  for (const design of usable.filter((item) => item.kind === 'figma')) {
    if (!design.groups?.length) continue
    const block = [
      `${DESIGN_SECTION}${design.label}）`,
      '每个画板就是一个页面，下面是页面上真实出现的字段文案（按 UI 顺序）：',
      design.outline,
    ]
    // PRD 太薄时，设计稿兜底当字段来源
    if (docText.length < 300) block.push('', `字段：${design.fields?.join('、') ?? ''}`)
    parts.push(block.join('\n'))
  }

  const composed = parts.join('\n\n').trim()
  if (!composed) throw new Error('链接读到了，但没提取到能用的内容')

  const { text, truncated } = condense(composed)
  const note = truncated
    ? `（注：原文 ${composed.length} 字，已按与页面相关的段落截取 ${text.length} 字。要看全文请直接打开原文档。）\n\n`
    : ''

  const designPages = pagesFromDesign(usable.flatMap((item) => item.groups ?? []))
  // 设计稿同一个画布上常留着历史画板、也不区分组件：拿需求文档把不属于本期的筛掉，没配模型就保持原样
  let pages = designPages
  let excluded: string[] = []
  if (designPages.length && docText.trim() && hasLlm(config)) {
    try {
      pages = await filterDesignPages(designPages, docText, config)
      excluded = designPages.filter((page) => !pages.includes(page)).map((page) => page.title)
    } catch (error) {
      console.warn('[sources] 页面范围没对齐，按设计稿原样返回：', (error as Error).message)
    }
  }

  return {
    text: `${note}${text}`,
    truncated,
    originalLength: composed.length,
    pages,
    excluded,
    sources: results.map<SourceInfo>((item) => ({
      kind: item.kind,
      label: item.label,
      url: item.url,
      chars: item.text?.length,
      fields: item.fields?.length,
      error: item.error,
    })),
  }
}
