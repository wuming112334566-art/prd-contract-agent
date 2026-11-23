import { fullPrd } from '../../shared/types'
import type { GenerateInput, PageContract, SourceTag, FieldType } from '../../shared/types'
import type { RuntimeConfig } from '../config'

export const CONTRACT_VERSION = '0.3'

export function emptyContract(input: GenerateInput, engine: string): PageContract {
  return {
    page: { id: 'page', title: '未命名页面', route: '/page', roles: ['user'] },
    regions: [],
    fields: [],
    states: [],
    apis: [],
    interactions: [],
    tracking: [],
    edgeCases: [],
    openQuestions: [],
    acceptance: [],
    meta: {
      stack: input.stack,
      uiLib: input.uiLib,
      engine,
      generatedAt: new Date().toISOString(),
      version: CONTRACT_VERSION,
      codePath: input.codePath?.trim() || undefined,
    },
  }
}

const asSource = (value: unknown): SourceTag =>
  value === 'prd' || value === 'api' || value === 'code' ? value : 'assumption'

const FIELD_TYPES: FieldType[] = ['string', 'number', 'boolean', 'date', 'enum']
const asType = (value: unknown): FieldType => (FIELD_TYPES.includes(value as FieldType) ? (value as FieldType) : 'string')

const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() ? value.trim() : fallback)

function mergeBy<T>(prev: T[], next: T[] | undefined, key: (item: T) => string): T[] {
  if (!next?.length) return prev
  const map = new Map(prev.map((item) => [key(item), item]))
  for (const item of next) {
    const k = key(item)
    const existing = map.get(k)
    map.set(k, existing ? Object.assign({}, existing, item) : item)
  }
  return [...map.values()]
}

function mergeRegions(prev: PageContract['regions'], next: PageContract['regions'] | undefined) {
  if (!next?.length) return prev
  const map = new Map(prev.map((region) => [region.id, region]))
  for (const region of next) {
    const id = text(region.id, 'content')
    const existing = map.get(id) ?? { id, label: id, desc: '', fields: [] as string[] }
    const fields = [...new Set([...existing.fields, ...(region.fields ?? [])])]
    map.set(id, { ...existing, ...region, id, fields })
  }
  return [...map.values()]
}

/** 把一步的产出并进已有契约，数组按业务主键去重，重复生成也不会越滚越大 */
export function mergePartial(base: PageContract, patch: Partial<PageContract>): PageContract {
  return {
    ...base,
    page: { ...base.page, ...(patch.page ?? {}) },
    regions: mergeRegions(base.regions, patch.regions),
    fields: mergeBy(base.fields, patch.fields, (item) => item.name),
    states: mergeBy(base.states, patch.states, (item) => item.key),
    apis: mergeBy(base.apis, patch.apis, (item) => `${item.method} ${item.path}`),
    interactions: mergeBy(base.interactions, patch.interactions, (item) => item.desc),
    tracking: mergeBy(base.tracking, patch.tracking, (item) => item.event),
    edgeCases: mergeBy(base.edgeCases, patch.edgeCases, (item) => item.scenario),
    openQuestions: mergeBy(base.openQuestions, patch.openQuestions, (item) => item.question),
    acceptance: [...new Set([...base.acceptance, ...(patch.acceptance ?? [])])],
    meta: { ...base.meta, ...(patch.meta ?? {}) },
  }
}

const BASE_STATES: Record<string, Omit<PageContract['states'][number], 'source'>> = {
  loading: { key: 'loading', label: '加载中', trigger: '首屏或筛选条件变化后的请求中', ui: '骨架屏，保留表格列宽避免抖动' },
  empty: { key: 'empty', label: '空态', trigger: '接口返回 0 条数据', ui: '表格区域居中空态插画', copy: '暂无数据', action: '提供「新建」入口' },
  error: { key: 'error', label: '错误态', trigger: '接口 500 / 业务失败', ui: '整页错误占位', copy: '加载失败', action: '重试按钮' },
  timeout: { key: 'timeout', label: '超时态', trigger: '请求超过 3s 未返回', ui: '骨架屏转超时提示', copy: '网络较慢，请稍后重试', action: '重试按钮' },
  noPermission: { key: 'noPermission', label: '无权限', trigger: '接口 403 或角色不在可访问列表', ui: '整页无权限提示', action: '联系管理员申请权限' },
}

const BASE_STATE_KEYS = Object.keys(BASE_STATES)

const STATE_LABEL: Record<string, string> = {
  loading: '加载中',
  empty: '空态',
  error: '错误态',
  timeout: '超时态',
  noPermission: '无权限',
  partialMask: '部分脱敏',
}

/** 模型漏字段是常态，这里统一补空值再剔掉不能用的条目，避免界面出现 undefined */
function keepUsable<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const value = key(item)
    if (!value || seen.has(value)) return false
    seen.add(value)
    return true
  })
}

/**
 * 归一化：模型返回的脏数据在这里一次性修好，下游生成器就不用到处做防御。
 * 同时补齐五态基线——前端最低交付标准，PRD 没写也要显式列出来并标 assumption。
 */
export function finalize(contract: PageContract): PageContract {
  const fields = contract.fields.map((field, index) => {
    const name = text(field.name, `field${index + 1}`)
    const type = asType(field.type)
    return {
      ...field,
      name,
      label: text(field.label, name),
      type,
      maxLength: type === 'string' ? field.maxLength ?? 50 : undefined,
      source: asSource(field.source),
    }
  })
  const deduped = mergeBy<PageContract['fields'][number]>([], fields, (item) => item.name)

  const states = [...contract.states]
  for (const key of BASE_STATE_KEYS) {
    if (!states.some((state) => state.key === key)) {
      states.push({ ...BASE_STATES[key], source: 'assumption' })
    }
  }
  const cleanStates = mergeBy(
    [],
    states.map((state) => ({
      ...state,
      key: text(state.key, 'error'),
      label: text(state.label, STATE_LABEL[state.key] ?? state.key),
      trigger: text(state.trigger, '触发条件待确认'),
      ui: text(state.ui, '待设计确认'),
      source: asSource(state.source),
    })),
    (item) => item.key,
  )

  const known = new Set(deduped.map((field) => field.name))
  const regions = contract.regions.map((region) => ({
    ...region,
    id: text(region.id, 'content'),
    label: text(region.label, '主内容区'),
    fields: (region.fields ?? []).filter((name) => known.has(name)),
  }))
  const assigned = new Set(regions.flatMap((region) => region.fields))
  const orphans = deduped.filter((field) => !assigned.has(field.name)).map((field) => field.name)
  if (orphans.length) {
    if (regions.length) regions[0].fields.push(...orphans)
    else regions.push({ id: 'content', label: '主内容区', desc: '页面主体', fields: orphans })
  }

  const acceptance = contract.acceptance.length
    ? contract.acceptance
    : [...cleanStates.map((state) => `${state.label}：${state.trigger}时表现符合契约`), '契约中所有 assumption 条目已人工确认']

  // 空区域在骨架里会变成空 section，除非它是分页区（本来就没有字段）
  const keptRegions = regions.filter((region) => region.fields.length > 0 || region.id === 'pagination')

  const route = text(contract.page.route, `/${text(contract.page.id, 'page')}`)

  const openQuestions = keepUsable(
    contract.openQuestions.map((item) => {
      const options = Array.isArray(item.options)
        ? [...new Set(item.options.map((option) => String(option).trim()).filter(Boolean))].slice(0, 6)
        : undefined
      return {
        ...item,
        question: text(item.question, ''),
        impact: text(item.impact, '影响范围需要和产品确认'),
        options: options?.length ? options : undefined,
        kind: options?.length ? ('choice' as const) : ('text' as const),
      }
    }),
    (item) => item.question,
  )
  const edgeCases = keepUsable(
    contract.edgeCases.map((item) => ({ ...item, scenario: text(item.scenario, ''), expect: text(item.expect, '') })),
    (item) => item.scenario,
  )
  const interactions = keepUsable(
    contract.interactions.map((item) => ({ ...item, desc: text(item.desc, '') })),
    (item) => item.desc,
  )
  const tracking = keepUsable(
    contract.tracking.map((item) => ({ ...item, event: text(item.event, '') })),
    (item) => item.event,
  )
  const apis = keepUsable(
    contract.apis.map((item) => ({ ...item, path: text(item.path, '') })),
    (item) => item.path,
  )

  return {
    ...contract,
    page: {
      id: text(contract.page.id, 'page'),
      title: text(contract.page.title, '未命名页面'),
      route: route.startsWith('/') ? route : `/${route}`,
      roles: contract.page.roles.length ? contract.page.roles : ['user'],
    },
    regions: keptRegions.length ? keptRegions : regions,
    fields: deduped,
    states: cleanStates,
    openQuestions,
    edgeCases,
    interactions,
    tracking,
    apis,
    acceptance,
  }
}

const URL_PATTERN = /https?:\/\/[^\s)）]+/g

/** 去掉链接和标点后还剩多少字：链接再多也不等于有内容 */
function bodyLength(prd: string): number {
  return prd.replace(URL_PATTERN, '').replace(/[\s、，,。.:：;；\-—_/|*#>`]/g, '').length
}

export function validateInput(input: GenerateInput, config: RuntimeConfig): string | null {
  const prd = fullPrd(input)
  if (!prd.trim()) return '还没有需求文档：贴飞书 / Figma 链接后点「读取」'

  const links = prd.match(URL_PATTERN) ?? []
  const body = bodyLength(prd)

  // 只贴链接是最常见的误用：工具读不到链接里的内容，必须当场说清楚，不能生成一张空表糊弄过去
  if (body < 40 && links.length > 0) {
    return `检测到 ${links.length} 个链接，但没有正文。点输入框上方的「读取」把文档读进来，或者把正文复制粘贴进来。`
  }
  if (body < 40) return `正文只有 ${body} 个字，太短了抽不出字段。给一段能看出页面上有哪几块、有哪些字段的描述（至少 40 字）。`
  if (config.model && prd.length > 20000) return 'PRD 超过 20000 字，请分段生成'
  return null
}
