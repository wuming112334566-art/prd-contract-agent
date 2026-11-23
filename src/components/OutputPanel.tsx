import { useEffect, useState } from 'react'
import { PROMPTS, PROMPT_STEPS, SPEC_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../../shared/prompts'
import { assumptionCount, fullPrd } from '../../shared/types'
import type { Artifacts, ContractQuestion, GenerateInput, PageContract, PageResult, SpecPage } from '../../shared/types'
import { generateSpec } from '../api'

type TabId = 'yaml' | 'skeleton' | 'mock' | 'e2e' | 'checklist' | 'questions' | 'spec' | 'prompts'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'yaml', label: '页面契约' },
  { id: 'skeleton', label: '页面骨架' },
  { id: 'mock', label: 'Mock' },
  { id: 'e2e', label: 'E2E' },
  { id: 'checklist', label: '自测清单' },
  { id: 'questions', label: '需求缺口' },
  { id: 'spec', label: '完整需求' },
  { id: 'prompts', label: 'Agent 提示词' },
]

/** 这两个页签不依赖产物，契约一出来就能看 */
const TEXT_TABS: TabId[] = ['questions', 'prompts']

const FILES: Record<Exclude<TabId, 'questions' | 'spec' | 'prompts'>, (pageId: string) => string> = {
  yaml: (pageId) => `${pageId}.contract.yaml`,
  skeleton: () => 'Page.tsx',
  mock: () => 'handlers.ts',
  e2e: (pageId) => `${pageId}.spec.ts`,
  checklist: () => 'checklist.md',
}

interface OutputPanelProps {
  input: GenerateInput
  results: PageResult[]
  active: number
  onSelect: (index: number) => void
  running: boolean
  elapsedMs: number
}

function download(fileName: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

export function OutputPanel({ input, results, active, onSelect, running, elapsedMs }: OutputPanelProps) {
  const [tab, setTab] = useState<TabId>('yaml')
  const [copied, setCopied] = useState(false)
  // 需求缺口的回复：answers[页面 key][问题原文] = 回复
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({})
  // 用户手动补充的问题：PRD 之外想追问的，也会一起进「完整需求」
  const [extras, setExtras] = useState<Record<string, ContractQuestion[]>>({})
  // 完整需求 .md：模型生成，按「回复签名」缓存，回复一变就重生成
  const [specState, setSpecState] = useState<{ signature: string; md: string } | null>(null)
  const [specLoading, setSpecLoading] = useState(false)
  const [specError, setSpecError] = useState('')
  const [specNonce, setSpecNonce] = useState(0)
  const [exportingAll, setExportingAll] = useState(false)

  const current = results[active] ?? null
  const contract = current?.contract ?? null
  const artifacts = current?.artifacts ?? null

  useEffect(() => {
    if (artifacts) setTab('yaml')
    // 只在「新一次生成」时回到契约页；切换页面时保留当前页签，方便逐页回复缺口
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.length])

  useEffect(() => {
    if (results.length === 0) {
      setAnswers({})
      setExtras({})
    }
  }, [results.length])

  const pageKey = contract ? contract.page.id || contract.page.title : ''
  const pageAnswers = answers[pageKey] ?? {}
  const baseQuestions = contract?.openQuestions ?? []
  const questions = [...baseQuestions, ...(extras[pageKey] ?? [])]
  const totalQuestions = questions.length
  const answeredCount = questions.filter((item) => (pageAnswers[item.question] ?? '').trim()).length
  const allAnswered = answeredCount === totalQuestions
  const remaining = totalQuestions - answeredCount

  const onAnswer = (question: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [pageKey]: { ...(prev[pageKey] ?? {}), [question]: answer } }))
  }

  const addExtra = (text: string) => {
    const question = text.trim()
    if (!question || questions.some((item) => item.question === question)) return false
    setExtras((prev) => {
      const list = prev[pageKey] ?? []
      // 连按回车时防重：同一个问题只留一条
      if (list.some((item) => item.question === question)) return prev
      return {
        ...prev,
        [pageKey]: [
          ...list,
          { question, impact: '评审时补充确认，不确认会影响开发口径', blocking: false, kind: 'text' as const },
        ],
      }
    })
    return true
  }

  const removeExtra = (question: string) => {
    setExtras((prev) => ({ ...prev, [pageKey]: (prev[pageKey] ?? []).filter((item) => item.question !== question) }))
    onAnswer(question, '')
  }

  // 回复签名：answers 一变，spec 就失效、自动重生成
  const specSignature = contract
    ? JSON.stringify(questions.map((item) => (pageAnswers[item.question] ?? '').trim()))
    : ''

  useEffect(() => {
    if (tab !== 'spec' || !contract || !allAnswered) return
    if (specState?.signature === specSignature) return
    let cancelled = false
    setSpecLoading(true)
    setSpecError('')
    const pages: SpecPage[] = [
      {
        contract: { ...contract, openQuestions: questions },
        answers: questions.map((item) => ({
          question: item.question,
          answer: (pageAnswers[item.question] ?? '').trim(),
        })),
      },
    ]
    generateSpec(pages, fullPrd(input))
      .then((md) => {
        if (!cancelled) setSpecState({ signature: specSignature, md })
      })
      .catch((error) => {
        if (!cancelled) setSpecError((error as Error).message)
      })
      .finally(() => {
        if (!cancelled) setSpecLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, contract, allAnswered, specSignature, specNonce])

  const retrySpec = () => {
    setSpecError('')
    setSpecState(null)
    setSpecNonce((n) => n + 1)
  }

  const specMd = specState?.md ?? ''

  const isTextTab = TEXT_TABS.includes(tab)
  const isSpecTab = tab === 'spec'
  const code = isSpecTab ? specMd : isTextTab ? '' : (artifacts?.[tab as keyof Artifacts] ?? '')
  const fileName = isSpecTab
    ? contract
      ? `${contract.page.id}.requirements.md`
      : ''
    : isTextTab || !contract
      ? ''
      : FILES[tab as keyof typeof FILES](contract.page.id)

  const onCopy = async () => {
    if (!code) return
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  /** 所有页面都回复完缺口后，一次模型调用把每页完整需求合并成一份 .md，直接丢给开发 Agent */
  const exportAll = async () => {
    const pages: SpecPage[] = []
    for (const item of results) {
      const key = item.contract.page.id || item.contract.page.title
      const qa = answers[key] ?? {}
      const pageQuestions = [...item.contract.openQuestions, ...(extras[key] ?? [])]
      if (pageQuestions.length && !pageQuestions.every((question) => (qa[question.question] ?? '').trim())) continue
      pages.push({
        contract: { ...item.contract, openQuestions: pageQuestions },
        answers: pageQuestions.map((question) => ({
          question: question.question,
          answer: (qa[question.question] ?? '').trim(),
        })),
      })
    }
    if (!pages.length) return
    setExportingAll(true)
    try {
      const md = await generateSpec(pages, fullPrd(input))
      download('requirements.all.md', md)
    } catch (error) {
      window.alert(`导出失败：${(error as Error).message}`)
    } finally {
      setExportingAll(false)
    }
  }

  return (
    <section className="panel output-panel">
      <div className="panel-head">
        <h2>
          <span className="step-no">3</span> 输出产物
        </h2>
        {contract && (
          <div className="stats">
            <span>{contract.fields.length} 字段</span>
            <span>{contract.states.length} 状态</span>
            <span>{contract.edgeCases.length} 边界</span>
            <span className={questions.some((item) => item.blocking) ? 'warn' : ''}>{questions.length} 缺口</span>
            {elapsedMs > 0 && <span className="muted">{(elapsedMs / 1000).toFixed(1)}s</span>}
          </div>
        )}
      </div>

      {!contract ? (
        <div className="placeholder">
          <p className="placeholder-title">这一步会得到什么</p>
          <p className="placeholder-text">
            把需求文档变成一份「开发规格」：这个页面有哪几块、每个字段什么类型多长、有哪几种状态、接口长什么样，
            以及 PRD 里没写清、需要去问产品的地方。
          </p>
          <ol className="placeholder-steps">
            <li>
              <b>贴飞书 / Figma 链接</b>，点「读取」（正文不用贴进来）
            </li>
            <li>
              <b>有项目就点「选择项目」</b>，生成时会自动读代码
            </li>
            <li>
              <b>点「生成页面契约」</b>，30 秒左右
            </li>
            <li>
              <b>先看这一版「需求缺口」</b>，逐个回复后生成完整需求 .md
            </li>
          </ol>
          <p className="placeholder-foot">一份材料里有多个页面时，勾选后可以一次生成多份契约。</p>
        </div>
      ) : (
        <>
          {contract.fields.length === 0 && (
            <p className="warn-banner">
              这次一个字段都没抽到，产物是空的。多半是输入里只有链接或几句描述——我读不到链接里的内容，
              把 PRD 正文贴进来再生成一次。
            </p>
          )}
          <div className="page-tabs">
            {results.map((item, index) => (
              <button
                key={item.page}
                type="button"
                className={index === active ? 'page-tab active' : 'page-tab'}
                onClick={() => onSelect(index)}
              >
                {item.page}
              </button>
            ))}
          </div>

          <div className="tabs" role="tablist">
            {TABS.map((item) => {
              const disabled = !TEXT_TABS.includes(item.id) && !artifacts
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={tab === item.id ? 'tab active' : 'tab'}
                  onClick={() => setTab(item.id)}
                  disabled={disabled}
                >
                  {item.label}
                </button>
              )
            })}
          </div>

          {tab === 'questions' ? (
            <QuestionsPanel
              contract={contract}
              questions={questions}
              baseCount={baseQuestions.length}
              answers={pageAnswers}
              onAnswer={onAnswer}
              onAdd={addExtra}
              onRemove={removeExtra}
            />
          ) : tab === 'prompts' ? (
            <PromptsPanel input={input} />
          ) : tab === 'spec' && !allAnswered ? (
            <div className="spec-wrap">
              <p className="spec-hint">
                还有 <strong className="warn">{remaining}</strong> 个缺口没回复。
                到「需求缺口」页签把每个问题都回复完，就能生成完整需求 .md。
              </p>
              <button type="button" className="ghost" onClick={() => setTab('questions')}>
                去回复
              </button>
            </div>
          ) : tab === 'spec' && specLoading ? (
            <div className="spec-wrap">
              <p className="generating">正在调用模型生成完整需求…</p>
            </div>
          ) : tab === 'spec' && specError ? (
            <div className="spec-wrap">
              <p className="error">{specError}</p>
              <button type="button" className="ghost" onClick={retrySpec}>
                重新生成
              </button>
            </div>
          ) : (
            <>
              <div className="code-bar">
                <span className="file-name">{fileName}</span>
                <div className="code-actions">
                  <button type="button" className="ghost small" onClick={onCopy} disabled={!code}>
                    {copied ? '已复制' : '复制'}
                  </button>
                  <button type="button" className="ghost small" onClick={() => download(fileName, code)} disabled={!code}>
                    {isSpecTab ? '下载 .md' : '下载'}
                  </button>
                  {isSpecTab && results.length > 1 && (
                    <button type="button" className="ghost small" onClick={exportAll} disabled={exportingAll}>
                      {exportingAll ? '生成中…' : '导出全部页面'}
                    </button>
                  )}
                </div>
              </div>
              <div className="code-wrap">
                {code ? (
                  <pre className="code">
                    <code>{code}</code>
                  </pre>
                ) : (
                  <p className="generating">{running ? '产物生成中…' : '暂无内容'}</p>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

function PromptsPanel({ input }: { input: GenerateInput }) {
  const ctx = { prd: fullPrd(input), stack: input.stack, uiLib: input.uiLib, code: input.code }

  return (
    <div className="prompts-wrap">
      <p className="prompts-note">
        这就是 Agent 真正发给模型的内容，PRD 原样嵌入。没配 key 时走规则引擎、这份提示词不参与运行，但字段定义和流程是同一套。
      </p>
      <article className="prompt">
        <h3>System</h3>
        <pre className="code">
          <code>{SYSTEM_PROMPT}</code>
        </pre>
      </article>
      {PROMPT_STEPS.map((step) => (
        <article key={step} className="prompt">
          <h3>{PROMPTS[step].title}</h3>
          <pre className="code">
            <code>{PROMPTS[step].build(ctx)}</code>
          </pre>
        </article>
      ))}
      <article className="prompt">
        <h3>第 5 步：生成完整需求（模型，回复缺口后触发）</h3>
        <pre className="code">
          <code>{SPEC_SYSTEM_PROMPT}</code>
        </pre>
        <p className="prompts-note">
          用户消息 = 页面契约 JSON + 缺口确认回复 + 原始需求原文，要求模型输出完整需求规格 Markdown。
        </p>
      </article>
    </div>
  )
}

function QuestionsPanel({
  contract,
  questions,
  baseCount,
  answers,
  onAnswer,
  onAdd,
  onRemove,
}: {
  contract: PageContract
  questions: ContractQuestion[]
  baseCount: number
  answers: Record<string, string>
  onAnswer: (question: string, answer: string) => void
  onAdd: (question: string) => boolean
  onRemove: (question: string) => void
}) {
  const [draft, setDraft] = useState('')
  const total = questions.length
  const extraCount = total - baseCount
  const blocking = questions.filter((item) => item.blocking).length
  const answered = questions.filter((item) => (answers[item.question] ?? '').trim()).length

  const add = () => {
    if (onAdd(draft)) setDraft('')
  }

  return (
    <div className="questions-wrap">
      <div className="questions-head">
        <p>
          {baseCount > 0 ? (
            <>
              PRD 没写清的地方一共 <strong>{baseCount}</strong> 处
            </>
          ) : (
            <>PRD 里没自动挖出缺口</>
          )}
          {extraCount > 0 && (
            <>
              ，另有 <strong>{extraCount}</strong> 处是你补充的
            </>
          )}
          {blocking > 0 && (
            <>
              ；其中 <strong className="warn">{blocking}</strong> 处会阻塞开发
            </>
          )}
          。
        </p>
        <p className="muted">另有 {assumptionCount(contract)} 条 assumption 需要人工确认后才能算契约通过。</p>
      </div>

      {total === 0 ? (
        <p className="generating">这份 PRD 写得挺完整，没挖出缺口。有要补充的，在下面加一条。</p>
      ) : (
        <>
          <ol className="questions">
            {questions.map((item, index) => {
              const extra = index >= baseCount
              return (
                <li key={item.question} className={item.blocking ? 'question blocking' : 'question'}>
                  <span className="q-index">Q{index + 1}</span>
                  <div className="q-body">
                    <p className="q-text">{item.question}</p>
                    <p className="q-impact">不问清：{item.impact}</p>
                    <AnswerControl
                      key={item.question}
                      question={item}
                      value={answers[item.question] ?? ''}
                      onCommit={(value) => onAnswer(item.question, value)}
                    />
                  </div>
                  {extra ? (
                    <span className="q-actions">
                      <span className="tag ok">补充</span>
                      <button type="button" className="ghost small" onClick={() => onRemove(item.question)}>
                        删除
                      </button>
                    </span>
                  ) : item.blocking ? (
                    <span className="tag warn">阻塞</span>
                  ) : null}
                </li>
              )
            })}
          </ol>
          <div className="questions-foot">
            <span>
              已回复 <strong>{answered}</strong> / {total}
            </span>
            {answered === total ? (
              <span className="ok">缺口已全部回复，切到「完整需求」页签生成 .md</span>
            ) : (
              <span className="muted">全部回复后即可生成完整需求 .md</span>
            )}
          </div>
        </>
      )}

      <div className="q-add">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
          placeholder="还有要补充的问题？写一条，比如「导出文件名规则未定义」"
          aria-label="补充问题"
        />
        <button type="button" className="ghost" onClick={add} disabled={!draft.trim()}>
          添加问题
        </button>
      </div>
      <p className="q-add-hint">补充的问题和 PRD 缺口一样要回复，也会一起进「完整需求」。</p>
    </div>
  )
}

function AnswerControl({
  question,
  value,
  onCommit,
}: {
  question: ContractQuestion
  value: string
  onCommit: (value: string) => void
}) {
  const options = question.options?.length ? question.options : []
  const [custom, setCustom] = useState(options.length > 0 && value !== '' && !options.includes(value))

  if (!options.length) {
    return (
      <div className="q-answer">
        <textarea
          className="q-input"
          rows={2}
          value={value}
          placeholder="回复这个问题…"
          onChange={(event) => onCommit(event.target.value)}
        />
      </div>
    )
  }

  return (
    <div className="q-answer">
      <div className="q-options">
        {options.map((option) => (
          <label key={option} className="q-option">
            <input
              type="radio"
              name={question.question}
              checked={!custom && value === option}
              onChange={() => {
                setCustom(false)
                onCommit(option)
              }}
            />
            <span>{option}</span>
          </label>
        ))}
        <label className="q-option">
          <input
            type="radio"
            name={question.question}
            checked={custom}
            onChange={() => {
              setCustom(true)
              onCommit('')
            }}
          />
          <span>其他</span>
        </label>
      </div>
      {custom && (
        <input
          className="q-input"
          value={value}
          placeholder="自定义回复…"
          autoFocus
          onChange={(event) => onCommit(event.target.value)}
        />
      )}
    </div>
  )
}
