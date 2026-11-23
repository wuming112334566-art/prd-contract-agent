/** 运行期配置：全部从环境变量读，key 只在服务端出现，不进前端 bundle */
export interface RuntimeConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  feishuAppId: string
  feishuAppSecret: string
  figmaToken: string
  /** 代码根目录：项目选择器默认打开的位置 */
  codeRoot: string
}

export function resolveConfig(env: Record<string, string | undefined>): RuntimeConfig {
  return {
    baseUrl: (env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || '',
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || 45000,
    feishuAppId: env.FEISHU_APP_ID || '',
    feishuAppSecret: env.FEISHU_APP_SECRET || '',
    figmaToken: env.FIGMA_TOKEN || '',
    codeRoot: env.CODE_ROOT || '',
  }
}

export function hasLlm(config: RuntimeConfig): boolean {
  return Boolean(config.baseUrl && config.apiKey && config.model)
}

export function hasFeishu(config: RuntimeConfig): boolean {
  return Boolean(config.feishuAppId && config.feishuAppSecret)
}

export function hasFigma(config: RuntimeConfig): boolean {
  return Boolean(config.figmaToken)
}

export function engineLabel(config: RuntimeConfig): string {
  return hasLlm(config) ? config.model : '未配置模型'
}
