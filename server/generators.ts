import type { Artifacts, ContractField, ContractRegion, PageContract } from '../shared/types'

/** 契约 → 可交付物。全部是确定性模板，保证同一份契约永远产出同一份代码 */

const pascal = (id: string) =>
  id
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join('')

const dateOf = (iso: string) => iso.slice(0, 10)

function regionFields(contract: PageContract, region: ContractRegion): ContractField[] {
  const byName = new Map(contract.fields.map((field) => [field.name, field]))
  return region.fields.map((name) => byName.get(name)).filter((field): field is ContractField => Boolean(field))
}

const findRegion = (contract: PageContract, id: string) => contract.regions.find((region) => region.id === id)

const tableFields = (contract: PageContract): ContractField[] => {
  const table = findRegion(contract, 'table')
  return table ? regionFields(contract, table) : contract.fields
}

const filterFields = (contract: PageContract): ContractField[] => {
  const filter = findRegion(contract, 'filter-bar')
  return filter ? regionFields(contract, filter) : []
}

const formFields = (contract: PageContract): ContractField[] => {
  const form = findRegion(contract, 'form')
  return form ? regionFields(contract, form) : []
}

const isFormPage = (contract: PageContract) => Boolean(findRegion(contract, 'form')) && !findRegion(contract, 'table')

/** 骨架只实现这六个通用状态；模型给的业务状态（如「未查询初始态」）属于业务逻辑，不代写 */
const BASELINE_STATE_KEYS = new Set(['loading', 'empty', 'error', 'timeout', 'noPermission', 'partialMask'])

const baselineStates = (contract: PageContract) => contract.states.filter((state) => BASELINE_STATE_KEYS.has(state.key))

const domainStates = (contract: PageContract) => contract.states.filter((state) => !BASELINE_STATE_KEYS.has(state.key))

const getApi = (contract: PageContract) => contract.apis.find((api) => api.method === 'GET')

/** 路径里带 {id} 的接口不能直接 fetch，生成器宁可留 TODO 也不产出跑不通的代码 */
const isCallable = (path: string) => !path.includes('{')

const toMswPath = (path: string) => path.replace(/\{(\w+)\}/g, ':$1')

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function scalar(value: unknown): string {
  if (typeof value === 'string') {
    if (!value) return '""'
    const plain = /^[/\w\u4e00-\u9fa5][^:#[\]{}"']*$/.test(value)
    return plain ? value : JSON.stringify(value)
  }
  return String(value)
}

function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    return value
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${scalar(item)}`
        return `${pad}- ${toYaml(item, indent + 2).trimStart()}`
      })
      .join('\n')
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    if (!entries.length) return '{}'
    return entries
      .map(([key, item]) => {
        if (isScalar(item)) return `${pad}${key}: ${scalar(item)}`
        if (Array.isArray(item) && !item.length) return `${pad}${key}: []`
        return `${pad}${key}:\n${toYaml(item, indent + 2)}`
      })
      .join('\n')
  }
  return `${pad}${scalar(value)}`
}

function buildYaml(contract: PageContract): string {
  const header = [
    `# 页面契约 · ${contract.page.title}`,
    `# 生成引擎：${contract.meta.engine}`,
    `# 规则：source=assumption 的条目必须人工确认后才算通过评审`,
    `# source=code 的条目取自现有代码（${contract.meta.codePath ?? '未记录路径'}），不需要再问`,
    '',
  ].join('\n')
  return `${header}${toYaml(contract)}\n`
}

function componentImports(contract: PageContract, layout: 'list' | 'form'): string[] {
  const fields = layout === 'form' ? formFields(contract) : [...filterFields(contract), ...tableFields(contract)]
  const names = new Set(['Button', 'Empty', 'Skeleton'])
  names.add(layout === 'form' ? 'Form' : 'Table')
  if (fields.some((field) => field.type === 'enum')) names.add('Select')
  if (fields.some((field) => field.type === 'boolean')) names.add('Switch')
  if (fields.length) names.add('Input')
  if (layout === 'list' && findRegion(contract, 'pagination')) names.add('Pagination')
  if (layout === 'form') names.add('Input')
  return [...names].sort()
}

function pagePrelude(contract: PageContract, layout: 'list' | 'form'): string {
  const component = `${pascal(contract.page.id)}Page`
  const states = baselineStates(contract)
  const stateKeys = states.map((state) => `'${state.key}'`).join(' | ')
  const stateEntries = states
    .map((state) => `  { key: '${state.key}', label: '${state.label}', copy: '${(state.copy ?? state.ui).replace(/'/g, '')}' },`)
    .join('\n')
  const domain = domainStates(contract)
  const domainNote = domain.length
    ? `\n// 契约里还有 ${domain.length} 个业务状态，骨架不代写，需要按业务补：\n${domain
        .map((state) => `//   · ${state.label}：${state.trigger}`)
        .join('\n')}`
    : ''
  const columns =
    layout === 'list'
      ? `\n\nconst COLUMNS = [\n${tableFields(contract)
          .map((field) => `  { key: '${field.name}', title: '${field.label}' },`)
          .join('\n')}\n]`
      : ''

  return `/**
 * ${contract.page.title} —— 由页面契约生成（v${contract.meta.version}，${dateOf(contract.meta.generatedAt)}）
 * 契约：contracts/${contract.page.id}.contract.yaml
 * 交付要求：五态必须实现；样式只引用 design token；TODO 处需人工补齐
 */
import { useCallback, useEffect, useState } from 'react'
// TODO 替换为团队组件库的真实导出
import { ${componentImports(contract, layout).join(', ')} } from '${contract.meta.uiLib || '@your/ui'}'

type PageState = ${stateKeys || "'error'"}

const STATE_META: Array<{ key: PageState; label: string; copy: string }> = [
${stateEntries}
]${domainNote}${columns}

export default function ${component}() {`
}

function loadHook(contract: PageContract, layout: 'list' | 'form'): string {
  const api = getApi(contract)
  const comment = api ? `// TODO 接真实接口：${api.method} ${api.path}` : '// TODO 这个页面没有 GET 接口，详情数据从哪来要确认'

  if (!api || !isCallable(api.path)) {
    return `  const load = useCallback(async () => {
    ${comment}
    setState(null)
  }, [])`
  }

  const resolve =
    layout === 'form'
      ? `      // TODO 把 data 回填到表单：form.setFieldsValue(data)
      setState(null)`
      : `      setState(data.list?.length ? null : 'empty')`

  return `  const load = useCallback(async () => {
    setState('loading')
    try {
      ${comment}
      const response = await fetch('${api.path}')
      const data = await response.json()
      // 403 → 'noPermission'；500 → 'error'；超 3s → 'timeout'；0 条 → 'empty'
${resolve}
    } catch {
      setState('error')
    }
  }, [])`
}

const stateBranch = `  useEffect(() => {
    void load()
  }, [load])

  if (state) {
    const meta = STATE_META.find((item) => item.key === state)
    return state === 'loading' ? (
      <Skeleton rows={8} />
    ) : (
      <Empty description={meta?.copy} action={<Button onClick={load}>重试</Button>} />
    )
  }`

function buildListSkeleton(contract: PageContract): string {
  const filters = filterFields(contract)
    .map((field) => {
      const placeholder = `${field.label}${field.type === 'enum' ? '（请选择）' : ''}`
      const limit = field.maxLength ? ` maxLength={${field.maxLength}}` : ''
      if (field.type === 'enum') {
        const options = field.options?.length ? `        {/* 枚举值待确认：${field.options.join(' / ')} */}\n` : ''
        return `${options}        <Select placeholder="${placeholder}" aria-label="${field.label}" />`
      }
      return `        <Input placeholder="${placeholder}" aria-label="${field.label}"${limit} />`
    })
    .join('\n')
  const pagination = findRegion(contract, 'pagination') ? '\n      <Pagination total={0} showSizeChanger />\n' : ''

  return `${pagePrelude(contract, 'list')}
  const [state, setState] = useState<PageState | null>('loading')

${loadHook(contract, 'list')}

${stateBranch}

  return (
    <div className="${contract.page.id}">
      {/* 筛选区 · 契约 region: filter-bar */}
      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void load() }}>
${filters || '        <Input placeholder="待补充筛选条件" />'}
        <Button type="submit">查询</Button>
      </form>

      <Table columns={COLUMNS} dataSource={[]} rowKey="${tableFields(contract)[0]?.name ?? 'id'}" />
${pagination}    </div>
  )
}
`
}

function buildFormSkeleton(contract: PageContract): string {
  const items = formFields(contract)
    .map((field) => {
      const control =
        field.type === 'enum'
          ? `<Select placeholder="请选择${field.label}" />`
          : field.type === 'boolean'
            ? '<Switch />'
            : `<Input${field.maxLength ? ` maxLength={${field.maxLength}}` : ''} />`
      const meta = [field.type, field.unit ? `单位 ${field.unit}` : ''].filter(Boolean).join(' · ')
      const options = field.options?.length ? `（待确认：${field.options.join(' / ')}）` : ''
      return `        {/* ${field.label} · ${meta}${options} */}
        <Form.Item label="${field.label}" name="${field.name}">
          ${control}
        </Form.Item>`
    })
    .join('\n')
  const writeApi = contract.apis.find((api) => api.method !== 'GET')

  return `${pagePrelude(contract, 'form')}
  const [state, setState] = useState<PageState | null>('loading')

${loadHook(contract, 'form')}

  const submit = useCallback(async () => {
    // TODO 离开页面前提示未保存（beforeunload）
    // TODO 提交：${writeApi ? `${writeApi.method} ${writeApi.path}` : '接口未定义'}
    // TODO 需要从路由取 id，并把 409 / 422 映射到字段级错误
  }, [])

${stateBranch}

  return (
    <div className="${contract.page.id}">
      <Form layout="vertical" onFinish={submit}>
${items || '        {/* 契约里没有表单字段，先人工补 */}'}

        <Button type="primary" htmlType="submit">
          保存
        </Button>
      </Form>
    </div>
  )
}
`
}

const buildSkeleton = (contract: PageContract) => (isFormPage(contract) ? buildFormSkeleton(contract) : buildListSkeleton(contract))

function mockValue(field: ContractField): string {
  switch (field.type) {
    case 'number':
      return field.unit === '元' ? '1280.5' : '12'
    case 'boolean':
      return 'true'
    case 'date':
      return `'2026-11-16 10:00:00'`
    case 'enum':
      return `'待处理'`
    default:
      return `'${field.label}示例'`
  }
}

function buildMock(contract: PageContract): string {
  const api = contract.apis[0]
  const method = (api?.method ?? 'GET').toLowerCase()
  const path = toMswPath(api?.path ?? '/api/placeholder')
  const row = contract.fields.map((field) => `    ${field.name}: ${mockValue(field)},`).join('\n')
  const body = method === 'get' ? 'ROWS' : 'ROWS[0]'

  return `import { delay, http, HttpResponse } from 'msw'

/** 演示用：?__state=empty|error|timeout|noPermission 切换契约里的状态，无需改代码 */
const ROWS = [
  {
${row}
  },
]

const pageState = (request: Request) => new URL(request.url).searchParams.get('__state')

export const handlers = [
  http.${method}('${path}', async ({ request }) => {
    const state = pageState(request)

    if (state === 'loading') {
      await delay(1500)
      return HttpResponse.json({ code: 0, data: ${body} })
    }
    if (state === 'timeout') {
      await delay(4000)
      return HttpResponse.json({ code: 0, data: ${body} })
    }
    if (state === 'empty') {
      return HttpResponse.json({ code: 0, data: ${method === 'get' ? '[]' : 'null'} })
    }
    if (state === 'noPermission') {
      return HttpResponse.json({ code: 403, message: '无权限访问' }, { status: 403 })
    }
    if (state === 'error') {
      return HttpResponse.json({ code: 500, message: '服务异常' }, { status: 500 })
    }
    return HttpResponse.json({ code: 0, data: ${body} })
  }),
]
`
}

function buildE2e(contract: PageContract): string {
  // 只测骨架真正实现的状态，否则那 10 条业务状态用例必然红
  const cases = baselineStates(contract)
    .map(
      (state) =>
        `  { key: '${state.key}', label: '${state.label}', expectText: '${(state.copy ?? state.ui).replace(/'/g, '')}' },`,
    )
    .join('\n')
  const edge = contract.edgeCases[0]
  const edgeBlock = edge
    ? `
  test('边界：${edge.scenario}', async ({ page }) => {
    await page.goto(ROUTE)
    // 期望：${edge.expect}
    await expect(page.locator('body')).toBeVisible()
  })
`
    : ''

  return `import { expect, test } from '@playwright/test'

const ROUTE = '${contract.page.route}'

/** 状态用例来自契约 states，契约新增状态时这里自动跟着长 */
const STATE_CASES = [
${cases}
]

test.describe('${contract.page.title} · 契约状态覆盖', () => {
  for (const item of STATE_CASES) {
    test(\`\${item.label} 可见\`, async ({ page }) => {
      await page.goto(\`\${ROUTE}?__state=\${item.key}\`)
      await expect(page.getByText(item.expectText).first()).toBeVisible({ timeout: 5000 })
    })
  }
${edgeBlock}})`
}

function buildChecklist(contract: PageContract): string {
  const stateRows = contract.states
    .map((state) => `| ${state.label} | ${state.trigger} | ${state.ui} | \`${state.source}\` |`)
    .join('\n')
  const edgeRows = contract.edgeCases.map((edge) => `- [ ] ${edge.scenario} → ${edge.expect}`).join('\n')
  const questionRows = contract.openQuestions
    .map((item) => `- [${item.blocking ? 'x' : ' '}] ${item.question}${item.blocking ? '（阻塞）' : ''} — ${item.impact}`)
    .join('\n')

  return `# ${contract.page.title} · 提测自测清单

> 由页面契约生成，接口：${contract.apis.map((api) => `${api.method} ${api.path}`).join('，') || '未定义'}
> 可访问角色：${contract.page.roles.join(' / ')}

## 一、状态覆盖（提测前逐项点一遍）

| 状态 | 触发条件 | 期望表现 | 来源 |
| --- | --- | --- | --- |
${stateRows}

## 二、边界用例

${edgeRows || '- 无'}

## 三、评审会必须问清（问不完不许开工）

${questionRows || '- 无'}

## 四、验收口径

${contract.acceptance.map((item) => `- [ ] ${item}`).join('\n')}
`
}

export function buildArtifacts(contract: PageContract): Artifacts {
  return {
    yaml: buildYaml(contract),
    skeleton: buildSkeleton(contract),
    mock: buildMock(contract),
    e2e: buildE2e(contract),
    checklist: buildChecklist(contract),
  }
}
