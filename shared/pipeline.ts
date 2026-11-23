import type { GenerateResult, PageContract } from './types'

/** 六步流水线：先读代码，再读 PRD；服务端按序执行，前端按序点亮 */
export type StepId = 'code' | 'scope' | 'fields' | 'states' | 'edges' | 'artifacts'
export type StepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface StepMeta {
  id: StepId
  title: string
  hint: string
}

export const STEPS: StepMeta[] = [
  { id: 'code', title: '读取现有代码', hint: '分页 / 接口 / 枚举 / 字段长度优先取代码' },
  { id: 'scope', title: '抽取页面与区域', hint: 'PRD → 页面 / 路由 / 区域 / 角色' },
  { id: 'fields', title: '抽取字段与类型', hint: '字段 / 类型 / 长度 / 单位 / 接口' },
  { id: 'states', title: '穷举页面状态', hint: 'loading · empty · error · 超时 · 无权限' },
  { id: 'edges', title: '边界用例与缺口', hint: '极值 / 连点 / 慢网 / PRD 缺口' },
  { id: 'artifacts', title: '生成下游产物', hint: '骨架 / Mock / E2E / 自测清单' },
]

export type AgentEvent =
  | { type: 'status'; step: StepId; status: StepStatus; summary?: string }
  | { type: 'log'; step: StepId; text: string }
  | { type: 'partial'; contract: PageContract }
  | { type: 'result'; result: GenerateResult }
  | { type: 'error'; message: string }
