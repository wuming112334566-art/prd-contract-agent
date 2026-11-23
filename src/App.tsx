import { useEffect, useRef, useState } from 'react'
import type { GenerateInput, PageCandidate } from '../shared/types'
import { Header } from './components/Header'
import { OutputPanel } from './components/OutputPanel'
import { PrdPanel } from './components/PrdPanel'
import { TracePanel } from './components/TracePanel'
import { DEFAULT_INPUT, SAMPLES } from './samples'
import { useAgent } from './useAgent'

/** 演示用参数：?sample=stock-board 预置样例，&autorun=1 打开即跑（录屏时省一次点击） */
function readLaunchParams(): GenerateInput {
  const params = new URLSearchParams(window.location.search)
  const sample = SAMPLES.find((item) => item.id === params.get('sample'))
  return sample ? { ...DEFAULT_INPUT, prd: sample.prd } : DEFAULT_INPUT
}

export default function App() {
  const [draft, setDraft] = useState<GenerateInput>(readLaunchParams)
  const [pages, setPages] = useState<PageCandidate[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const { state, run, reset, select } = useAgent()
  const launched = useRef(false)

  useEffect(() => {
    if (launched.current || !new URLSearchParams(window.location.search).has('autorun')) return
    launched.current = true
    void run(draft, [])
  }, [draft, run])

  const applyPages = (list: PageCandidate[]) => {
    setPages(list)
    setSelected(list.map((page) => page.title))
  }

  const togglePage = (title: string) => {
    setSelected((prev) => (prev.includes(title) ? prev.filter((item) => item !== title) : [...prev, title]))
  }

  const selectAll = (checked: boolean) => {
    setSelected(checked ? pages.map((page) => page.title) : [])
  }

  const start = () => {
    // 页面顺序按清单来，而不是勾选顺序
    const queue = pages.filter((page) => selected.includes(page.title)).map((page) => page.title)
    void run(draft, queue)
  }

  return (
    <div className="app">
      <Header engine={state.engine} running={state.running} onReset={reset} />
      <main className="workspace">
        <div className="side">
          <PrdPanel
            value={draft}
            onChange={setDraft}
            pages={pages}
            selected={selected}
            onPagesChange={applyPages}
            onToggle={togglePage}
            onSelectAll={selectAll}
            onRun={start}
            running={state.running}
            error={state.error}
            sources={state.sources}
          />
          <TracePanel steps={state.steps} running={state.running} currentPage={state.currentPage} />
        </div>
        <OutputPanel
          input={draft}
          results={state.results}
          active={state.active}
          onSelect={select}
          running={state.running}
          elapsedMs={state.elapsedMs}
        />
      </main>
    </div>
  )
}
