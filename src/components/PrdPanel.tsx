import { useState } from 'react'
import { fullPrd } from '../../shared/types'
import type { GenerateInput, PageCandidate } from '../../shared/types'
import { detectPages, resolveSources } from '../api'
import { ProjectPicker } from './ProjectPicker'

interface PrdPanelProps {
  value: GenerateInput
  onChange: (next: GenerateInput) => void
  pages: PageCandidate[]
  selected: string[]
  onPagesChange: (pages: PageCandidate[]) => void
  onToggle: (title: string) => void
  onSelectAll: (checked: boolean) => void
  onRun: () => void
  running: boolean
  error: string
  sources: { feishu: boolean; figma: boolean } | null
}

const MIN_LENGTH = 40

type Tone = 'ok' | 'warn' | 'error'

interface Notice {
  tone: Tone
  text: string
}

export function PrdPanel({
  value,
  onChange,
  pages,
  selected,
  onPagesChange,
  onToggle,
  onSelectAll,
  onRun,
  running,
  error,
  sources,
}: PrdPanelProps) {
  const [links, setLinks] = useState('')
  const [reading, setReading] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const codePath = value.codePath ?? ''
  const codeName = codePath.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const tooShort = fullPrd(value).trim().length < MIN_LENGTH
  const allSelected = pages.length > 0 && selected.length === pages.length

  const updateCodePath = (next: string) => onChange({ ...value, codePath: next })
  const updateLinks = (next: string) => {
    setLinks(next)
    // 链接一改，之前读到的正文和页面清单就作废了
    if (value.docText) {
      onChange({ ...value, docText: undefined })
      onPagesChange([])
    }
  }

  const pickProject = (path: string) => {
    setPickerOpen(false)
    updateCodePath(path)
  }

  const readLinks = async () => {
    setReading(true)
    setNotice(null)
    try {
      const result = await resolveSources(links)
      // 读回来的正文只参与生成，不铺到输入框里
      onChange({ ...value, docText: result.text })
      const failed = result.sources.filter((item) => item.error)
      setNotice(failed.length ? { tone: 'warn', text: `有 ${failed.length} 个链接没读到：${failed[0].error}` } : null)
      if (result.pages?.length) {
        onPagesChange(result.pages)
      } else {
        // 飞书文档没有画板信息：读完直接让模型拆一次页面，省掉再点「识别页面」
        try {
          onPagesChange(await detectPages(result.text))
        } catch (error) {
          setNotice({ tone: 'warn', text: `页面没识别出来：${(error as Error).message}` })
        }
      }
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message })
    } finally {
      setReading(false)
    }
  }

  const detect = async () => {
    setDetecting(true)
    setNotice(null)
    try {
      const list = await detectPages(fullPrd(value))
      onPagesChange(list)
      setNotice({ tone: 'ok', text: `识别到 ${list.length} 个页面，勾选后可以一次生成多份契约` })
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message })
    } finally {
      setDetecting(false)
    }
  }

  const placeholder = sources && !sources.feishu && !sources.figma
    ? '没配凭证，只能直接粘正文'
    : '贴飞书 / Figma 链接，空格分隔'

  return (
    <section className="panel input-panel">
      <div className="panel-head">
        <h2>
          <span className="step-no">1</span> 输入需求
        </h2>
        <span className="hint">
          {fullPrd(value).length} 字{codeName ? ` · 代码 ${codeName}` : ''}
        </span>
      </div>

      <div className="input-body">
        <div className="link-row">
          <input
            type="text"
            value={codePath}
            onChange={(event) => updateCodePath(event.target.value)}
            placeholder="选择项目：点「生成页面契约」时自动读代码"
            spellCheck={false}
            aria-label="现有代码路径"
          />
          <button type="button" className="ghost" onClick={() => setPickerOpen(true)}>
            选择项目…
          </button>
        </div>

        <div className="link-row">
          <input
            type="text"
            value={links}
            onChange={(event) => updateLinks(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            aria-label="文档或设计稿链接"
          />
          <button type="button" className="ghost" onClick={() => void readLinks()} disabled={reading || !links.trim()}>
            {reading ? '读取中…' : '读取'}
          </button>
        </div>

        {notice && <p className={`link-status ${notice.tone}`}>{notice.text}</p>}

        {pages.length > 0 ? (
          <div className="pages">
            <div className="pages-head">
              <span>识别到 {pages.length} 个页面</span>
              <div className="pages-actions">
                {/* 清单是从设计稿/文档推出来的，判断错了得有路子按文档重来 */}
                <button type="button" className="ghost small" onClick={() => void detect()} disabled={detecting || tooShort}>
                  {detecting ? '识别中…' : '重新识别'}
                </button>
                <button type="button" className="ghost small" onClick={() => onSelectAll(!allSelected)}>
                  {allSelected ? '全不选' : '全选'}
                </button>
              </div>
            </div>
            <ul>
              {pages.map((page) => (
                <li key={page.title}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(page.title)}
                      onChange={() => onToggle(page.title)}
                    />
                    <span className="page-title">{page.title}</span>
                    {page.hint && <span className="page-hint">{page.hint}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="pages-empty">
            <button type="button" className="ghost small" onClick={() => void detect()} disabled={detecting || tooShort}>
              {detecting ? '识别中…' : '识别页面'}
            </button>
            <span>读取后会自动识别页面；没识别出来可以点按钮重试</span>
          </div>
        )}
      </div>

      {/* 生成按钮固定在面板底部：页面清单再长也不会把它顶出可视区 */}
      <div className="input-foot">
        <button type="button" className="run" onClick={onRun} disabled={running || tooShort || (pages.length > 0 && !selected.length)}>
          {running ? '生成中…' : selected.length > 0 ? `生成 ${selected.length} 页契约` : '生成页面契约'}
        </button>
        {tooShort && <p className="tip">先贴需求文档链接并点「读取」；读完才能生成契约</p>}
        {error && <p className="error">{error}</p>}
      </div>

      <ProjectPicker
        open={pickerOpen}
        initialPath={codePath}
        onClose={() => setPickerOpen(false)}
        onPick={pickProject}
      />
    </section>
  )
}
