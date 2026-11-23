import type { RuntimeConfig } from '../config'

const BASE = 'https://open.feishu.cn/open-apis'

/** tenant_access_token 有效期 2 小时，缓存到过期前 1 分钟 */
let tokenCache: { value: string; expiresAt: number } | null = null

export interface FeishuRef {
  kind: string
  token: string
}

export function parseFeishuUrl(raw: string): FeishuRef | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!/(^|\.)(feishu\.cn|larksuite\.com|feishu-pre\.cn)$/.test(url.hostname)) return null
  const match = url.pathname.match(/^\/(docx|docs|wiki|sheets|base|mindnotes)\/([A-Za-z0-9]+)/)
  if (!match) return null
  return { kind: match[1], token: match[2] }
}

const PERMISSION_HINT =
  '这个应用读不到该文档：在文档右上角「···」里添加文档应用（或把文档放进该应用可访问的知识库），然后再试一次。'

interface FeishuResponse {
  code: number
  msg?: string
  tenant_access_token?: string
  expire?: number
  error?: { field_violations?: Array<{ field?: string; description?: string }> }
  data?: {
    content?: string
    node?: { obj_token?: string; obj_type?: string; title?: string }
  }
}

async function tenantToken(config: RuntimeConfig): Promise<string> {
  if (tokenCache && tokenCache.expiresAt - Date.now() > 60_000) return tokenCache.value

  const response = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: config.feishuAppId, app_secret: config.feishuAppSecret }),
  })
  const payload = (await response.json()) as FeishuResponse
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`飞书应用凭证无效（${payload.msg ?? payload.code}），检查 FEISHU_APP_ID / FEISHU_APP_SECRET`)
  }
  tokenCache = {
    value: payload.tenant_access_token,
    expiresAt: Date.now() + (payload.expire ?? 7200) * 1000,
  }
  return tokenCache.value
}

async function callFeishu(path: string, token: string): Promise<FeishuResponse> {
  const response = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return (await response.json()) as FeishuResponse
}

function explain(payload: FeishuResponse): string {
  const { code, msg } = payload
  // 99992402：参数校验失败，最常见的是文档 ID 被换行/复制截断（飞书要求至少 27 位）
  if (code === 99992402) {
    const detail = payload.error?.field_violations?.[0]?.description ?? '字段校验未通过'
    return `这个文档 ID 不合法（${detail}）。链接多半被换行或复制截断了，请重新完整复制一次。`
  }
  // 1770002 / 1770024 / 99991672 / 131006：文档不存在、无权限、应用未获得云文档权限
  if (code === 1770002 || code === 1770024 || code === 99991672 || code === 131006) return PERMISSION_HINT
  if (code === 99991663 || code === 10001) return '飞书 access token 失效，检查应用凭证是否正确、应用是否已发布版本'
  return `飞书接口报错：${msg ?? code}`
}

export interface FeishuDoc {
  label: string
  text: string
  chars: number
}

/** 文档开头的「主要变更内容说明 / 变更记录」块：日期、@人、改动条目，不是需求正文 */
const CHANGELOG_HEADING = /^(?:主要)?(?:变更|修订|更新|版本|修改)(?:内容)?(?:说明|记录|历史)[：:]?$/
/** 真正的章节标题：Markdown 标题、一、二、三、，第 X 章 */
const SECTION_HEADING = /^(?:#{1,6}\s+\S|[一二三四五六七八九十]+、|第[一二三四五六七八九十]+[章节])/
const MAX_CHANGELOG_LINES = 12
const LONG_LINE = 80

/**
 * 去掉文档最前面的变更记录块。
 * 只处理「第一行就是变更说明」的情况，且最多删 12 行、遇到真正的章节标题或长段落就停，
 * 宁可少删，也不把需求正文吃掉。
 */
export function stripLeadingChangelog(text: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim())
  if (start < 0 || !CHANGELOG_HEADING.test(lines[start].trim())) return text

  let end = start + 1
  while (end < lines.length && end - start <= MAX_CHANGELOG_LINES) {
    const line = lines[end].trim()
    if (SECTION_HEADING.test(line) || line.length > LONG_LINE) break
    // 短标题 + 后面紧跟长段落，通常就是正文第一节的标题，停在这里
    const next = lines.slice(end + 1).map((item) => item.trim()).find(Boolean) ?? ''
    const titleLike =
      line.length > 0 &&
      line.length <= 24 &&
      next.length > LONG_LINE &&
      !/^(?:[-*•]|\d+[.、]|@|\d{4})/.test(line)
    if (titleLike) break
    end += 1
  }

  const rest = lines.slice(end).join('\n').replace(/^\s*\n/, '').trim()
  // 通篇只有变更说明时，清空不如保留
  return rest || text
}

export async function readFeishu(raw: string, config: RuntimeConfig): Promise<FeishuDoc> {
  const ref = parseFeishuUrl(raw)
  if (!ref) throw new Error('这不像飞书文档链接')
  if (ref.kind === 'sheets' || ref.kind === 'base') {
    throw new Error('表格 / 多维表格还没接：先把内容复制成文本，或在飞书里导出为文档再贴链接')
  }
  if (ref.kind === 'docs') throw new Error('这是旧版文档，请在飞书里「转为新版文档」后再贴链接')
  // 飞书 docx 的 document_id 至少 27 位；短了基本就是复制/换行被截断，先给出人话而不是等接口报错
  if (ref.kind === 'docx' && ref.token.length < 27) {
    throw new Error(`文档 ID 只有 ${ref.token.length} 位（飞书要求 27 位），链接被截断了。重新完整复制一次再试。`)
  }

  const token = await tenantToken(config)
  let documentId = ref.token
  let title = ''

  if (ref.kind === 'wiki') {
    const node = await callFeishu(`/wiki/v2/spaces/get_node?token=${ref.token}&obj_type=wiki`, token)
    if (node.code !== 0) throw new Error(explain(node))
    const target = node.data?.node
    if (target?.obj_type !== 'docx') throw new Error(`知识库节点类型是 ${target?.obj_type ?? '未知'}，目前只支持 docx 文档`)
    documentId = target.obj_token ?? ''
    title = target.title ?? ''
  }

  const payload = await callFeishu(`/docx/v1/documents/${documentId}/raw_content?lang=0`, token)
  if (payload.code !== 0) throw new Error(explain(payload))

  const content = String(payload.data?.content ?? '').trim()
  if (!content) throw new Error('文档读到了，但正文是空的')

  const text = stripLeadingChangelog(content)
  return { label: title ? `飞书文档《${title}》` : '飞书文档', text, chars: text.length }
}
