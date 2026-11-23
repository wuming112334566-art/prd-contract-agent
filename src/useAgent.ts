import { useCallback, useEffect, useState } from 'react'
import type { AgentEvent, StepId, StepStatus } from '../shared/pipeline'
import type { GenerateInput, PageResult } from '../shared/types'
import { fetchHealth, streamAgent } from './api'

export interface StepRun {
  status: StepStatus
  summary: string
  logs: string[]
}

export type StepsState = Record<StepId, StepRun>

export interface AgentState {
  running: boolean
  steps: StepsState
  results: PageResult[]
  active: number
  currentPage: string
  engine: string
  sources: { feishu: boolean; figma: boolean } | null
  elapsedMs: number
  error: string
}

function initialSteps(): StepsState {
  const make = (): StepRun => ({ status: 'pending', summary: '', logs: [] })
  return { code: make(), scope: make(), fields: make(), states: make(), edges: make(), artifacts: make() }
}

function initialState(): AgentState {
  return {
    running: false,
    steps: initialSteps(),
    results: [],
    active: 0,
    currentPage: '',
    engine: '检测中…',
    sources: null,
    elapsedMs: 0,
    error: '',
  }
}

export function useAgent() {
  const [state, setState] = useState<AgentState>(initialState)

  useEffect(() => {
    fetchHealth()
      .then((health) => setState((prev) => ({ ...prev, engine: health.engine, sources: health.sources ?? null })))
      .catch(() => setState((prev) => ({ ...prev, engine: '未配置模型' })))
  }, [])

  const apply = useCallback((event: AgentEvent) => {
    setState((prev) => {
      switch (event.type) {
        case 'status': {
          const current = prev.steps[event.step]
          return {
            ...prev,
            steps: {
              ...prev.steps,
              [event.step]: {
                ...current,
                status: event.status,
                summary: event.summary ?? current.summary,
                logs: event.status === 'failed' ? [...current.logs, '该步骤失败'] : current.logs,
              },
            },
          }
        }
        case 'log':
          return {
            ...prev,
            steps: {
              ...prev.steps,
              [event.step]: { ...prev.steps[event.step], logs: [...prev.steps[event.step].logs, event.text] },
            },
          }
        case 'error':
          return { ...prev, error: event.message, running: false }
        default:
          return prev
      }
    })
  }, [])

  /** pages 为空 = 只生成一页；否则按顺序逐页生成，每页一套契约和产物 */
  const run = useCallback(
    async (input: GenerateInput, pages: string[]) => {
      setState((prev) => ({
        ...prev,
        running: true,
        error: '',
        results: [],
        active: 0,
        steps: initialSteps(),
        elapsedMs: 0,
      }))

      const queue = pages.length ? pages : ['']
      let succeeded = 0

      for (const page of queue) {
        setState((prev) => ({ ...prev, currentPage: page, steps: initialSteps() }))

        let captured: PageResult | null = null
        try {
          await streamAgent({ ...input, page: page || undefined }, (event) => {
            if (event.type === 'result') {
              captured = {
                page: page || event.result.contract.page.title,
                contract: event.result.contract,
                artifacts: event.result.artifacts,
              }
              setState((prev) => ({
                ...prev,
                engine: event.result.engine,
                elapsedMs: event.result.elapsedMs,
                results: [...prev.results, captured as PageResult],
                active: prev.results.length,
              }))
              return
            }
            apply(event)
          })
        } catch (error) {
          setState((prev) => ({ ...prev, error: (error as Error).message, running: false }))
          return
        }

        if (!captured) break
        succeeded += 1
      }

      setState((prev) => ({
        ...prev,
        running: false,
        currentPage: '',
        active: prev.results.length ? prev.results.length - 1 : prev.active,
      }))
      if (!succeeded) {
        setState((prev) => ({ ...prev, error: prev.error || '生成失败，检查上一步的报错' }))
      }
    },
    [apply],
  )

  const select = useCallback((index: number) => setState((prev) => ({ ...prev, active: index })), [])

  const reset = useCallback(() => {
    setState((prev) => ({ ...initialState(), engine: prev.engine, sources: prev.sources }))
  }, [])

  return { state, run, reset, select }
}
