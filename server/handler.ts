import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentEvent } from '../shared/pipeline'
import type { GenerateInput, SpecPage } from '../shared/types'
import { runAgent } from './agent'
import type { RuntimeConfig } from './config'
import { engineLabel, hasFeishu, hasFigma, hasLlm } from './config'
import { validateInput } from './engine/normalize'
import { detectPagesWithModel, DESIGN_SECTION } from './pages'
import { listProjects } from './projects'
import { resolveSources } from './sources'
import { generateSpec } from './spec'

const readJson = async <T>(req: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

/**
 * 挂在 vite 的 /api 上：dev 和 preview 都走同一个进程，
 * 因此 LLM_API_KEY 永远只在服务端，前端 bundle 里拿不到。
 */
export function createApiMiddleware(config: RuntimeConfig) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/'

    if (path === '/health') {
      sendJson(res, 200, {
        engine: engineLabel(config),
        llm: hasLlm(config),
        model: config.model,
        sources: { feishu: hasFeishu(config), figma: hasFigma(config) },
      })
      return
    }

    // 识别页面清单：一份材料里有几个页面
    if (path === '/pages' && req.method === 'POST') {
      let body: { prd?: string }
      try {
        body = await readJson<{ prd?: string }>(req)
      } catch {
        sendJson(res, 400, { message: '请求体不是合法 JSON' })
        return
      }
      const prd = String(body.prd ?? '').trim()
      if (prd.length < 40) {
        sendJson(res, 422, { message: '先把材料贴进来，再识别页面' })
        return
      }
      // 设计稿段只是字段来源：识别页面前切掉，否则画板会被当成页面，历史画板也会混进来
      const doc = prd.split(DESIGN_SECTION)[0].trim()
      const material = doc.length >= 40 ? doc : prd
      try {
        sendJson(res, 200, { pages: await detectPagesWithModel(material, config) })
      } catch (error) {
        sendJson(res, 422, { message: (error as Error).message })
      }
      return
    }

    // 项目选择器：列一层目录，前端弹框里选文件夹
    if (path === '/projects' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        sendJson(res, 200, await listProjects(config, url.searchParams.get('path') ?? undefined))
      } catch (error) {
        sendJson(res, 422, { message: (error as Error).message })
      }
      return
    }

    // 读取飞书文档 / Figma 设计稿：一次性请求，返回拼好的纯文本
    if (path === '/sources' && req.method === 'POST') {
      let body: { urls?: string }
      try {
        body = await readJson<{ urls?: string }>(req)
      } catch {
        sendJson(res, 400, { message: '请求体不是合法 JSON' })
        return
      }
      try {
        sendJson(res, 200, await resolveSources(String(body.urls ?? ''), config))
      } catch (error) {
        sendJson(res, 422, { message: (error as Error).message })
      }
      return
    }

    // 生成完整需求 .md：把契约 + 缺口回复融合成一份可直接开发的规格（模型生成）
    if (path === '/spec' && req.method === 'POST') {
      let body: { pages?: SpecPage[]; prd?: string }
      try {
        body = await readJson<{ pages?: SpecPage[]; prd?: string }>(req)
      } catch {
        sendJson(res, 400, { message: '请求体不是合法 JSON' })
        return
      }
      if (!hasLlm(config)) {
        sendJson(res, 422, { message: '没有配置模型：在 .env 里填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 后再试。' })
        return
      }
      const pages = (body.pages ?? []).filter((page) => page && page.contract && page.contract.page)
      if (!pages.length) {
        sendJson(res, 422, { message: '缺少页面契约' })
        return
      }
      try {
        sendJson(res, 200, { md: await generateSpec(pages, body.prd, config) })
      } catch (error) {
        sendJson(res, 422, { message: (error as Error).message })
      }
      return
    }

    if (path !== '/generate' || req.method !== 'POST') {
      sendJson(res, 404, { message: 'not found' })
      return
    }

    let input: GenerateInput
    try {
      input = await readJson<GenerateInput>(req)
    } catch {
      sendJson(res, 400, { message: '请求体不是合法 JSON' })
      return
    }

    res.writeHead(200, SSE_HEADERS)
    const send = (event: AgentEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    const invalid = validateInput(input, config)
    if (invalid) {
      send({ type: 'error', message: invalid })
      res.end()
      return
    }

    try {
      for await (const event of runAgent(input, config)) send(event)
    } catch (error) {
      send({ type: 'error', message: (error as Error).message })
    }
    res.end()
  }
}
