import { useEffect, useRef } from 'react'
import { STEPS } from '../../shared/pipeline'
import type { StepStatus } from '../../shared/pipeline'
import type { StepsState } from '../useAgent'

const STATUS_TEXT: Record<StepStatus, string> = {
  pending: '等待',
  running: '执行中',
  done: '完成',
  failed: '失败',
}

interface TracePanelProps {
  steps: StepsState
  running: boolean
  currentPage: string
}

export function TracePanel({ steps, running, currentPage }: TracePanelProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const logCount = STEPS.reduce((sum, step) => sum + steps[step.id].logs.length, 0)
  const done = STEPS.filter((step) => steps[step.id].status === 'done').length

  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [logCount, running])

  return (
    <section className="panel trace-panel">
      <div className="panel-head">
        <h2>
          <span className="step-no">2</span> Agent 执行过程
        </h2>
        <span className="hint">
          {currentPage ? `${currentPage} · ` : ''}
          {done}/{STEPS.length} 步
        </span>
      </div>

      <div className="steps" ref={scroller}>
        {STEPS.map((meta, index) => {
          const run = steps[meta.id]
          return (
            <article key={meta.id} className={`step ${run.status}`}>
              <div className="step-head">
                <span className="step-dot" aria-hidden="true" />
                <span className="step-title">
                  {index + 1}. {meta.title}
                </span>
                <span className="step-status">{STATUS_TEXT[run.status]}</span>
              </div>
              {run.summary && <p className="step-summary">{run.summary}</p>}
              {run.logs.length > 0 && (
                <div className="logs">
                  {run.logs.map((log, logIndex) => (
                    <p key={`${meta.id}-${logIndex}`} className="log">
                      {log}
                    </p>
                  ))}
                </div>
              )}
              {run.status === 'pending' && <p className="step-hint">{meta.hint}</p>}
            </article>
          )
        })}
      </div>
    </section>
  )
}
