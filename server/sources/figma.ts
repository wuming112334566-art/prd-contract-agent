import type { RuntimeConfig } from '../config'

/** Figma 节点树只用到这几个字段，避免把整个 payload 类型化一遍 */
interface FigmaNode {
  id: string
  name: string
  type: string
  characters?: string
  children?: FigmaNode[]
}

export interface FigmaRef {
  fileKey: string
  nodeId?: string
}

export function parseFigmaUrl(raw: string): FigmaRef | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null
  const match = url.pathname.match(/^\/(?:design|file|proto)\/([A-Za-z0-9]+)/)
  if (!match) return null
  const nodeId = url.searchParams.get('node-id')?.replace('-', ':') ?? undefined
  return { fileKey: match[1], nodeId }
}

/** 按钮 / 导航类文案不是字段名，混进来会让契约变脏 */
const UI_TEXTS = new Set([
  '查询',
  '搜索',
  '重置',
  '新建',
  '新增',
  '编辑',
  '删除',
  '导出',
  '导入',
  '保存',
  '取消',
  '确定',
  '提交',
  '返回',
  '上一步',
  '下一步',
  '上一页',
  '下一页',
  '批量操作',
  '更多',
  '查看',
  '详情',
  '关闭',
  '刷新',
  '确认',
])

/** 全局导航类画板整块跳过 */
const CHROME_FRAME = /侧边栏|侧栏|导航|菜单|sidebar|topbar|顶部栏|底部栏|面包屑|标签栏/i

const VARIANT_FRAME = /^画板\s*-\s*\d+$/

function isFieldLabel(text: string): boolean {
  if (text.length < 2 || text.length > 12) return false
  if (/^[\d\s.,:%+\-/()（）]+$/.test(text)) return false
  if (/(:|：)$/.test(text)) return false
  if (/^(请|共\d|总计|暂无|已选|全部)/.test(text)) return false
  if (/^\d+月$/.test(text)) return false
  if (UI_TEXTS.has(text)) return false
  return true
}

interface Budget {
  left: number
}

function collectTexts(node: FigmaNode, sink: Set<string>, budget: Budget, depth: number) {
  if (budget.left <= 0 || depth > 6) return
  budget.left -= 1

  if (node.type === 'TEXT' && node.characters) {
    const text = node.characters.replace(/\s+/g, ' ').trim()
    if (isFieldLabel(text)) sink.add(text)
  }
  for (const child of node.children ?? []) collectTexts(child, sink, budget, depth + 1)
}

export interface FigmaGroup {
  frame: string
  texts: string[]
}

export interface FigmaDesign {
  label: string
  groups: FigmaGroup[]
  fields: string[]
  outline: string
}

export async function readFigma(raw: string, config: RuntimeConfig): Promise<FigmaDesign> {
  const ref = parseFigmaUrl(raw)
  if (!ref) throw new Error('这不像 Figma 链接')
  if (!config.figmaToken) throw new Error('没配 FIGMA_TOKEN，去 Figma → Settings → Security 生成一个')

  const endpoint = ref.nodeId
    ? `https://api.figma.com/v1/files/${ref.fileKey}/nodes?ids=${encodeURIComponent(ref.nodeId)}&depth=4`
    : `https://api.figma.com/v1/files/${ref.fileKey}?depth=3`

  let response = await fetch(endpoint, { headers: { 'X-Figma-Token': config.figmaToken } })
  // Figma 偶发 500/404 抖动，重试一次再下结论，别在演示时掉链子
  if (!response.ok) {
    await new Promise((resolve) => setTimeout(resolve, 700))
    response = await fetch(endpoint, { headers: { 'X-Figma-Token': config.figmaToken } })
  }
  if (response.status === 404) {
    console.error('[figma] 404', endpoint, '| 若连续出现，多半是 Figma 侧限流（它返回 404 而不是 429）')
    throw new Error('Figma 读不到这个文件：可能是文件不在当前 token 的账号下，或调用太频繁被限流，过几分钟再试')
  }
  if (response.status === 403) throw new Error('Figma token 过期或没有该文件权限，重新生成一个个人 token 再试')
  if (!response.ok) throw new Error(`Figma 接口报错：HTTP ${response.status}`)

  const payload = (await response.json()) as {
    document?: FigmaNode
    nodes?: Record<string, { document?: FigmaNode }>
  }

  const roots = ref.nodeId
    ? Object.values(payload.nodes ?? {})
        .map((item) => item.document)
        .filter((item): item is FigmaNode => Boolean(item))
    : payload.document
      ? [payload.document]
      : []
  if (!roots.length) throw new Error('Figma 链接里的节点不存在，检查 node-id 参数')

  // 顶层画板 = 页面。同名画板（多状态稿）合并成一组，字段保序去重。
  const grouped = new Map<string, Set<string>>()
  const budget: Budget = { left: 8000 }

  for (const root of roots) {
    // 画板才是页面：画布上的 COMPONENT（表格组件之类）和 GROUP（零散分组）都不是路由，
    // 它们照样有文本层，混进来就会变成一页根本不存在的页面
    const frames = (root.children ?? []).filter(
      (child) => child.type === 'FRAME' || child.type === 'SECTION',
    )
    // 链接直接指向某个画板时，root 自己就是那一页
    const usable = frames.length ? frames : root.type === 'CANVAS' ? [] : [root]
    if (!usable.length) {
      throw new Error('这个页面里没有画板（Frame / Section）：组件不算页面，确认链接指向的是设计稿所在的那一页')
    }
    for (const frame of usable) {
      const name = frame.name.trim()
      if (CHROME_FRAME.test(name) || VARIANT_FRAME.test(name)) continue
      const sink = grouped.get(name) ?? new Set<string>()
      collectTexts(frame, sink, budget, 0)
      grouped.set(name, sink)
    }
  }

  const groups: FigmaGroup[] = [...grouped.entries()]
    .map(([frame, texts]) => ({ frame: frame || '未命名画板', texts: [...texts].slice(0, 24) }))
    .filter((group) => group.texts.length >= 2)
    .slice(0, 10)

  if (!groups.length) throw new Error('设计稿里没找到可用的文本图层（可能是纯图形稿，或者文字都被转成了路径）')

  /**
   * 左侧导航会被复制进每一个画板，所以「在多数画板里都出现的同一个词」一定是全局导航，不是字段。
   * 这是纯数据判断，不依赖图层名——设计稿里那层常常叫 Frame 12 或者干脆没名字。
   */
  const frequency = new Map<string, number>()
  for (const group of groups) {
    for (const text of group.texts) frequency.set(text, (frequency.get(text) ?? 0) + 1)
  }
  const chromeThreshold = Math.max(2, Math.ceil(groups.length * 0.7))
  const isChrome = (text: string) => groups.length >= 4 && (frequency.get(text) ?? 0) >= chromeThreshold

  const cleaned = groups
    .map((group) => ({ frame: group.frame, texts: group.texts.filter((text) => !isChrome(text)) }))
    .filter((group) => group.texts.length >= 2)

  const usableGroups = cleaned.length ? cleaned : groups
  const fields = [...new Set(usableGroups.flatMap((group) => group.texts))].slice(0, 60)
  const outline = usableGroups
    .map((group) => `- ${group.frame}：${group.texts.slice(0, 12).join('、')}`)
    .join('\n')

  const nodeName = roots[0].name.trim()
  const label = nodeName && !VARIANT_FRAME.test(nodeName) && !/^(页面|page|画板|画布)$/i.test(nodeName)
    ? `Figma · ${nodeName}`
    : 'Figma 设计稿'

  return { label, groups: usableGroups, fields, outline }
}
