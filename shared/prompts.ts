import type { PageContract, SpecPage, Stack } from './types'
import type { StepId } from './pipeline'

/**
 * Agent 的四个抽取步骤提示词。
 * 服务端调用大模型时直接用这里；前端「Agent 提示词」页签展示同一份文本，
 * 保证「演示看到的」和「实际跑的是」同一套，不另写一份说明。
 */

export type PromptStepId = Exclude<StepId, 'artifacts' | 'code'>

export interface PromptContext {
  prd: string
  stack: Stack
  uiLib: string
  /** 现有代码摘要：先读代码，代码里已有的事实不再作为缺口 */
  code?: string
  partial?: Partial<PageContract>
}

export const SYSTEM_PROMPT = [
  '你是一名资深前端架构师，负责把需求文档转成「页面契约」。',
  '硬性规则：',
  '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。',
  '2. 不许编造 PRD 与接口文档里不存在的内容。凡是推断出来的，source 必须写 "assumption"。',
  '3. 字段 name 用英文 camelCase；label 保留 PRD 里的中文原名。',
  '4. 中后台页面默认按「筛选区 / 操作区 / 列表区 / 分页区」组织。',
  '5. 宁可少写，也不要写空话：detail 里不要出现「按需」「合理」这类无法验收的词。',
  '6. 一份文档里写了多个页面时，只生成当前约定的那一页，不要把它们混在一起；',
  '   不要写「本文档包含多个页面 / 其余页面需逐页生成 / 是否确认」这类范围问题——页面清单由工具的页面列表负责。',
  '7. 材料里有「设计稿」段落时：每个画板就是一个页面，画板里的文案是 UI 上真实出现的字段。',
  '   字段的中文名和顺序以设计稿为准；设计稿与 PRD 不一致时，以设计稿为准，并把差异写进 openQuestions。',
  '   画板清单同时也是「这份材料包含哪些页面」的依据。',
  '8. 材料里有「现有代码」时：先读代码，再读 PRD。代码是现状的唯一事实源。',
  '   分页默认值与可选条数、字段类型/长度/枚举、接口路径与参数、状态与权限处理，代码里已经有的直接采用，source 写 "code"，不要写进 openQuestions。',
  '9. 需求缺口只写「代码与 PRD 冲突」或「两边都没写」的地方；冲突要写成「代码是 A，PRD 要 B」这种能判定的问题。',
  '   代码里能读到的事实不要拿去问产品——那不是在找缺口，是在浪费评审会。',
].join('\n')

function context(ctx: PromptContext): string {
  const code = ctx.code?.trim()
  return [
    `技术栈：${ctx.stack}；组件库：${ctx.uiLib || '未指定'}`,
    ...(code ? ['现有代码（先读代码，再读需求文档）：', '"""', code, '"""'] : []),
    '需求文档：',
    '"""',
    ctx.prd.trim(),
    '"""',
  ].join('\n')
}

function previous(ctx: PromptContext): string {
  return ctx.partial ? `已抽取的部分契约（在其基础上补全，不要重复返回）：\n${JSON.stringify(ctx.partial)}` : ''
}

export const PROMPTS: Record<PromptStepId, { title: string; build: (ctx: PromptContext) => string }> = {
  scope: {
    title: '第一步：抽取页面与区域',
    build: (ctx) =>
      [
        context(ctx),
        '',
        '请抽取页面骨架，输出 JSON：',
        '{',
        '  "page": { "id": "kebab-case", "title": "中文页面名", "route": "/xxx", "roles": ["可访问角色"] },',
        '  "regions": [{ "id": "filter-bar|toolbar|table|pagination|form|dialog", "label": "中文名", "desc": "该区域放什么" }]',
        '}',
        '规则：route 无法从 PRD 得出时由你按语义给出，标在 regions 之外无需标注；roles 为空时写 ["user"]。',
      ].join('\n'),
  },
  fields: {
    title: '第二步：抽取字段与接口',
    build: (ctx) =>
      [
        context(ctx),
        '',
        previous(ctx),
        '',
        '请抽取字段与接口，输出 JSON：',
        '{',
        '  "fields": [{ "name": "camelCase", "label": "中文名", "type": "string|number|boolean|date|enum",',
        '               "maxLength": 32, "unit": "元", "options": ["枚举值"], "display": "展示规则", "source": "prd|api|assumption" }],',
        '  "regions": [{ "id": "已有区域 id", "fields": ["该区域里的字段 name"] }],',
        '  "apis": [{ "method": "GET", "path": "/api/xxx", "params": ["字段 name"], "errorCodes": [{ "code": 401, "ui": "跳登录" }], "source": "prd|api|assumption" }]',
        '}',
        '规则：字符串字段必须给 maxLength（PRD 未说明时给 50 并标 assumption）；金额字段必须给 unit；枚举字段必须给 options。',
        '现有代码里能读到的字段类型、长度、枚举、接口参数，按代码写并把 source 标成 "code"，不要标 assumption。',
        '只抽这个页面真正用到的字段，不要把文档里其他页面的字段混进来；列表的列、筛选条件、弹窗表单都算这个页面的字段。',
        'name 必须表意：名称类用 xxxName，编号/号码类用 xxxNo（不要用 xxxIds），多选筛选的多 ID 才用 xxxIds，时间点用 xxxAt 或 xxxTime，时间范围用 xxxRange。',
      ].join('\n'),
  },
  states: {
    title: '第三步：穷举页面状态',
    build: (ctx) =>
      [
        context(ctx),
        '',
        previous(ctx),
        '',
        '请穷举这个页面的所有状态与交互，输出 JSON：',
        '{',
        '  "states": [{ "key": "loading|empty|error|timeout|noPermission|partialMask", "label": "中文名",',
        '               "trigger": "什么情况进入该状态", "ui": "UI 表现", "copy": "文案", "action": "给用户的出路", "source": "prd|assumption" }],',
        '  "interactions": [{ "desc": "点击 X 做什么", "needConfirm": true, "source": "prd|assumption" }]',
        '}',
        '规则：loading / empty / error / timeout / noPermission 五个状态必须全部出现，PRD 没写的一律标 assumption，不要省略。',
      ].join('\n'),
  },
  edges: {
    title: '第四步：边界用例与需求缺口',
    build: (ctx) =>
      [
        context(ctx),
        '',
        previous(ctx),
        '',
        '请输出边界用例、埋点、自测清单和「需求缺口」，输出 JSON：',
        '{',
        '  "edgeCases": [{ "scenario": "极值场景", "expect": "期望表现", "source": "prd|assumption" }],',
        '  "tracking": [{ "event": "page_action", "params": ["字段 name"], "source": "prd|assumption" }],',
        '  "acceptance": ["可勾选的自测项"],',
        '  "openQuestions": [{ "question": "要问产品/后端的问题", "impact": "不问清会怎样", "blocking": true,',
        '                     "kind": "choice|text", "options": ["选项A", "选项B"] }]',
        '}',
        '规则：openQuestions 必须来自 PRD 真实缺口（状态没写、权限没说、单位没定、删除无二次确认……），',
        '代码里已经有的分页、接口、枚举、字段长度一律不要问，直接按代码写进契约并把 source 标成 "code"；只有代码与 PRD 冲突、或两边都没写时才写缺口。',
        '每条都要说清「不问清会导致什么返工」，不要写「建议进一步确认」这种废话。',
        '答案能枚举的（是否需要二次确认、权限角色、单位是元还是分……），给 kind:"choice" 并列出 2~4 个互斥的中文 options；',
        '答案开放、需要写一段话的（异常文案、业务规则口径……），给 kind:"text" 且不给 options。',
        '不要写「本文档包含多个页面 / 本次只生成了哪一页」这类范围问题：本次生成哪一页由用户勾选决定，不需要产品确认。',
      ].join('\n'),
  },
}

export const PROMPT_STEPS: PromptStepId[] = ['scope', 'fields', 'states', 'edges']

/** 第 5 步（回复缺口后触发）：把契约 + 回复融合成一份可直接开发的完整需求 Markdown */
export const SPEC_SYSTEM_PROMPT = [
  '你是一名资深前端架构师，负责把「页面契约」和需求缺口的确认回复，合并成一份完整、可直接交给开发 Agent 的需求规格（Markdown）。',
  '硬性规则：',
  '1. 只输出 Markdown 正文，不要用代码围栏包住整篇，不要任何解释性前言或后记。',
  '2. 必须覆盖这些章节：页面信息 / 页面结构（区域）/ 字段清单 / 页面状态 / 接口 / 交互 / 埋点 / 边界用例 / 需求确认结论 / 验收标准 / 附录（原始需求原文）。',
  '3. 需求缺口要写成「结论」而不是悬而未决的问题：把每条缺口和它的回复融合成一句确定的决策，并标注阻塞与否。',
  '4. 不得编造契约里没有的内容；契约里 source=assumption 的条目要在文档里显式标注「待确认」，source=code 的条目注明「取自现有代码」。',
  '5. 字段、接口、状态这类结构化信息用表格或列表完整列出，不要省略，不要让开发 Agent 再去猜。',
  '6. 有多个页面时，每个页面用一级标题（#）分隔，并在文档开头给出目录。',
].join('\n')

export function buildSpecPrompt(pages: SpecPage[], prd?: string): string {
  const pageBlocks = pages.map((page, index) => {
    const answered = page.contract.openQuestions.map((question) => ({
      question: question.question,
      impact: question.impact,
      blocking: question.blocking,
      answer: page.answers.find((item) => item.question === question.question)?.answer ?? '',
    }))
    return [
      `### 页面 ${index + 1}：${page.contract.page.title}`,
      '页面契约（JSON）：',
      '```json',
      JSON.stringify(page.contract, null, 2),
      '```',
      '需求缺口的确认回复：',
      '```json',
      JSON.stringify(answered, null, 2),
      '```',
    ].join('\n')
  })

  const parts = [...pageBlocks]
  if (prd?.trim()) parts.push(`原始需求原文：\n"""\n${prd.trim()}\n"""`)
  parts.push(
    `请输出${pages.length === 1 ? '该页面' : `这 ${pages.length} 个页面`}的完整需求规格 Markdown。` +
      (pages.length > 1 ? '多个页面时，每个页面用一级标题分隔，并在开头加目录。' : ''),
  )
  return parts.join('\n\n')
}
