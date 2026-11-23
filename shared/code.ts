import type { CodeFacts, PageContract } from './types'

/**
 * 代码事实：分页、接口这些在现有代码里已经定死的东西。
 * 契约要引用它们（source=code），并且不再拿它们去问产品。
 * 这里只做纯文本解析，不碰文件系统，前后端都能用。
 */

const PAGE_SIZE = /(?:defaultPageSize|DEFAULT_PAGE_SIZE|initialPageSize|pageSize|PAGE_SIZE)\s*[:=]\s*(\d+)/
const PAGE_SIZES = /(?:pageSizeOptions|PAGE_SIZE_OPTIONS|pageSizes|PAGE_SIZES)\s*[:=]\s*\[([^\]]+)\]/
const SIZE_CHANGER = /(?:showSizeChanger\s*[:=]\s*true|showSizeChanger(?=[\s/>]))/

const linesOf = (code: string, pattern: RegExp) => code.match(new RegExp(`^.*${pattern.source}.*$`, 'gm')) ?? []

/** 同一个仓库里各页的分页值可能不同，取出现最多的那个作为「全局现状」 */
function mostCommon<T>(items: T[]): T | undefined {
  const counts = new Map<T, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

const parseSizes = (line: string): number[] =>
  (line.match(/\[([^\]]+)\]/)?.[1] ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)

export function extractCodeFacts(code: string): CodeFacts {
  const facts: CodeFacts = { apis: [] }

  const sizeLines = linesOf(code, PAGE_SIZE)
  const sizesLines = linesOf(code, PAGE_SIZES)
  const changerLines = linesOf(code, SIZE_CHANGER)

  const sizeValues = sizeLines.map((line) => Number(line.match(PAGE_SIZE)?.[1])).filter((value) => Number.isFinite(value))
  const sizeArrays = sizesLines.map(parseSizes).filter((values) => values.length > 0)
  const pageSize = mostCommon(sizeValues)
  const pageSizes = mostCommon(sizeArrays.map((values) => values.join(',')))?.split(',').map(Number)
  const showSizeChanger = changerLines.length > 0

  if (pageSize || pageSizes?.length || showSizeChanger) {
    const evidence =
      sizeLines.find((line) => Number(line.match(PAGE_SIZE)?.[1]) === pageSize) ?? sizesLines[0] ?? changerLines[0] ?? ''
    facts.pagination = {
      pageSize,
      pageSizes: pageSizes?.length ? pageSizes : undefined,
      showSizeChanger,
      evidence: evidence.trim().slice(0, 120),
    }
  }

  const withMethod = [...code.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\(\s*['"`](\/[A-Za-z0-9_\-/{}.$:]+)['"`]/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  )
  const withRequest = [...code.matchAll(/\b(?:request|fetch|http)\(\s*['"`](\/[A-Za-z0-9_\-/{}.$:]+)['"`]/g)].map(
    (match) => match[1],
  )
  const bare = [...code.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/{}.$:]+)['"`]/g)].map((match) => match[1])
  facts.apis = [...new Set([...withMethod, ...withRequest, ...bare])].slice(0, 12)
  return facts
}

/** 「默认每页 20 条；可选 10/20/50」；一个值都没读到时返回空串 */
export function describePagination(pagination: NonNullable<CodeFacts['pagination']>): string {
  const bits: string[] = []
  if (pagination.pageSize) bits.push(`默认每页 ${pagination.pageSize} 条`)
  if (pagination.pageSizes?.length) bits.push(`可选 ${pagination.pageSizes.join('/')}`)
  if (pagination.showSizeChanger) bits.push('支持切换每页条数')
  return bits.join('；')
}

const PAGE_SIZE_QUESTION = /每页|pageSize/i
// 同一句里还问了别的事（导出范围、跳页、权限……）就说明代码没答完，必须留着
const OTHER_TOPIC =
  /导出|下载|跳页|pageNo|页码|排序|筛选|权限|角色|脱敏|审批|通知|删除|新建|单位|币种|接口|字段|状态|超时|错误码|文案|路由|埋点/i
const CONFLICT_QUESTION = /冲突|不一致|代码.*PRD|PRD.*代码/i

/**
 * 把代码事实并进契约：分页区写清真实配置，并丢掉「分页没写清」这类已有答案的缺口。
 * 只处理分页——这是最常被误提、且代码里一定有的那类事实。
 */
export function applyCodeFacts(
  contract: PageContract,
  code: string,
  facts: CodeFacts = extractCodeFacts(code),
): { contract: PageContract; dropped: string[] } {
  const desc = facts.pagination ? describePagination(facts.pagination) : ''
  if (!desc) return { contract, dropped: [] }

  const dropped: string[] = []
  const openQuestions = contract.openQuestions.filter((item) => {
    // 代码与 PRD 真的冲突时保留：那才是需要产品拍板的缺口
    if (!PAGE_SIZE_QUESTION.test(item.question) || OTHER_TOPIC.test(item.question) || CONFLICT_QUESTION.test(item.question)) {
      return true
    }
    dropped.push(item.question)
    return false
  })

  const note = `列表分页：${desc}（取自现有代码）`
  const isPaginationRegion = (region: PageContract['regions'][number]) =>
    region.id === 'pagination' || /分页/.test(region.label)
  const hasPagination = contract.regions.some(isPaginationRegion)
  const regions = hasPagination
    ? contract.regions.map((region) => (isPaginationRegion(region) ? { ...region, desc: note } : region))
    : contract.regions.some((region) => region.id === 'table')
      ? [...contract.regions, { id: 'pagination', label: '分页区', desc: note, fields: [] }]
      : contract.regions

  return { contract: { ...contract, regions, openQuestions }, dropped }
}
