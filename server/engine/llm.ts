import type { RuntimeConfig } from '../config'

/** 调任意 OpenAI 兼容网关；json=true 强制 JSON 输出，否则返回纯文本（用于生成 Markdown） */
async function complete(
  config: RuntimeConfig,
  system: string,
  user: string,
  options: { json?: boolean; temperature?: number } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: options.temperature ?? 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  if (options.json) body.response_format = { type: 'json_object' }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`网关 ${response.status}：${text.slice(0, 160)}`)
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error('网关返回空内容')
  return content
}

/** 调任意 OpenAI 兼容网关，只取 JSON，失败由调用方回退规则引擎 */
export async function callJson<T>(config: RuntimeConfig, system: string, user: string): Promise<T> {
  const content = await complete(config, system, user, { json: true })

  const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    throw new Error(`返回内容不是合法 JSON：${cleaned.slice(0, 120)}`)
  }
}

/** 去掉模型可能给整篇 Markdown 包上的代码围栏（正文里真正的代码块不受影响） */
function stripOuterFence(markdown: string): string {
  let text = markdown.trim()
  const first = text.split('\n')[0]?.trim() ?? ''
  if (/^```(markdown|md)?$/i.test(first)) text = text.slice(text.indexOf('\n') + 1)
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop()
  return lines.join('\n').trim()
}

/** 生成纯文本（Markdown）内容 */
export async function callText(
  config: RuntimeConfig,
  system: string,
  user: string,
  temperature = 0.3,
): Promise<string> {
  const content = await complete(config, system, user, { temperature })
  return stripOuterFence(content)
}
