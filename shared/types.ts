/**
 * 页面契约（Page Contract）的类型定义 —— 前后端唯一事实源。
 * 服务端产出、前端渲染、生成器消费都依赖这里，不允许各自再定义一份。
 */

/** code = 取自现有代码：代码里已有的事实不再作为需求缺口 */
export type SourceTag = 'prd' | 'api' | 'code' | 'assumption'
export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum'
export type Stack = 'react' | 'vue'

export interface ContractField {
  /** 英文标识，生成代码时直接用 */
  name: string
  /** PRD 里的中文名 */
  label: string
  type: FieldType
  maxLength?: number
  unit?: string
  options?: string[]
  display?: string
  source: SourceTag
}

export interface ContractRegion {
  id: string
  label: string
  desc: string
  /** 引用 ContractField.name，字段只在这里存一次 */
  fields: string[]
}

export interface ContractState {
  key: string
  label: string
  trigger: string
  ui: string
  copy?: string
  action?: string
  source: SourceTag
}

export interface ContractApi {
  method: string
  path: string
  params: string[]
  errorCodes: Array<{ code: number; ui: string }>
  source: SourceTag
}

export interface ContractInteraction {
  desc: string
  needConfirm: boolean
  source: SourceTag
}

export interface ContractTracking {
  event: string
  params: string[]
  source: SourceTag
}

export interface ContractEdgeCase {
  scenario: string
  expect: string
  source: SourceTag
}

export interface ContractQuestion {
  question: string
  impact: string
  blocking: boolean
  /** 答案可枚举时给候选选项；空则用自由文本输入 */
  options?: string[]
  /** 'choice' = 有选项，'text' = 自由文本 */
  kind?: 'choice' | 'text'
}

/** 用户对一个需求缺口的回复 */
export interface QuestionAnswer {
  question: string
  answer: string
}

/** 生成完整需求 .md 的输入：一个页面的契约 + 该页缺口的回复 */
export interface SpecPage {
  contract: PageContract
  answers: QuestionAnswer[]
}

export interface ContractMeta {
  stack: Stack
  uiLib: string
  engine: string
  generatedAt: string
  version: string
  /** 契约依据的现有代码路径（没有读代码时为空） */
  codePath?: string
}

export interface PageContract {
  page: { id: string; title: string; route: string; roles: string[] }
  regions: ContractRegion[]
  fields: ContractField[]
  states: ContractState[]
  apis: ContractApi[]
  interactions: ContractInteraction[]
  tracking: ContractTracking[]
  edgeCases: ContractEdgeCase[]
  openQuestions: ContractQuestion[]
  acceptance: string[]
  meta: ContractMeta
}

export interface GenerateInput {
  prd: string
  stack: Stack
  uiLib: string
  /** 只生成这一页（多页文档分批时用）；为空表示整份材料 */
  page?: string
  /** 现有代码摘要：生成时先读它，代码里已有的事实不再作为缺口 */
  code?: string
  /** 代码摘要的来源路径，只用于展示和审计 */
  codePath?: string
  /** 从链接读回来的正文：只参与生成，不显示在输入框里 */
  docText?: string
}

/**
 * 生成时真正使用的 PRD：链接读回来的正文 + 手动粘贴的正文。
 * 读回来的内容不展示，但生成和切片都要算上。
 */
export function fullPrd(input: Pick<GenerateInput, 'prd' | 'docText'>): string {
  return [input.docText?.trim(), input.prd.trim()].filter(Boolean).join('\n\n')
}

/** 从现有代码里读到的确定性事实 */
export interface CodeFacts {
  pagination?: {
    pageSize?: number
    pageSizes?: number[]
    showSizeChanger?: boolean
    /** 命中的原始代码行，便于回查 */
    evidence: string
  }
  apis: string[]
}

export interface CodeScanResult {
  path: string
  files: number
  digest: string
  facts: CodeFacts
  /** 实际进入摘要的文件（相对路径），用于在日志里说明到底读了哪些 */
  matched: string[]
  /** 通过路由表定位到的页面目录（相对路径），没有则为空 */
  focus?: string
  truncated: boolean
}

/** 项目选择器里的一个子文件夹 */
export interface ProjectEntry {
  name: string
  path: string
  /** 有 package.json / .git 等标记，基本可以确定是项目根 */
  isProject: boolean
}

export interface ProjectRoot {
  label: string
  path: string
}

/** 项目选择器的一层目录 */
export interface ProjectListing {
  path: string
  parent: string | null
  /** 本机磁盘（Windows 下是 C:\ / D:\ …），用来跨盘切换 */
  drives: string[]
  roots: ProjectRoot[]
  entries: ProjectEntry[]
  /** 子文件夹太多时只返回前面这些 */
  truncated: boolean
}

/** 一份材料里识别出的一个页面 */
export interface PageCandidate {
  title: string
  hint?: string
  route?: string
  source: 'design' | 'prd'
}

export interface DetectResult {
  pages: PageCandidate[]
}

/** 一页的生成结果 */
export interface PageResult {
  page: string
  contract: PageContract
  artifacts: Artifacts
}

export interface Artifacts {
  yaml: string
  skeleton: string
  mock: string
  e2e: string
  checklist: string
}

/** 从链接读回来的资料：飞书文档正文 / Figma 设计稿字段 */
export interface SourceInfo {
  kind: 'feishu' | 'figma' | 'unknown'
  label: string
  url: string
  chars?: number
  fields?: number
  error?: string
}

export interface ResolveResult {
  text: string
  sources: SourceInfo[]
  truncated: boolean
  originalLength: number
  pages: PageCandidate[]
  /** 设计稿里有、但需求文档没提，按本期范围剔掉的画板 */
  excluded: string[]
}

export interface GenerateResult {
  contract: PageContract
  artifacts: Artifacts
  engine: string
  elapsedMs: number
}

/** 契约里被标记为假设的条目，都需要人工确认后才算通过评审 */
export function assumptionCount(contract: PageContract): number {
  const entries: SourceTag[] = [
    ...contract.fields.map((i) => i.source),
    ...contract.states.map((i) => i.source),
    ...contract.apis.map((i) => i.source),
    ...contract.interactions.map((i) => i.source),
    ...contract.tracking.map((i) => i.source),
    ...contract.edgeCases.map((i) => i.source),
  ]
  return entries.filter((i) => i === 'assumption').length
}
