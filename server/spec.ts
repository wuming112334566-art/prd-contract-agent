import type { SpecPage } from '../shared/types'
import { SPEC_SYSTEM_PROMPT, buildSpecPrompt } from '../shared/prompts'
import type { RuntimeConfig } from './config'
import { callText } from './engine/llm'

/**
 * 把页面契约 + 缺口回复融合成一份完整需求 .md。
 * 这一步用模型生成（不是确定性模板）：让模型理解契约与结论，产出自然、自包含的开发规格。
 */
export async function generateSpec(pages: SpecPage[], prd: string | undefined, config: RuntimeConfig): Promise<string> {
  return callText(config, SPEC_SYSTEM_PROMPT, buildSpecPrompt(pages, prd))
}
