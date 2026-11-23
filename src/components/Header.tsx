interface HeaderProps {
  engine: string
  running: boolean
  onReset: () => void
}

export function Header({ engine, running, onReset }: HeaderProps) {
  const missing = engine === '未配置模型'
  const badgeClass = running ? 'badge live' : missing ? 'badge warn' : 'badge'

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          ⇄
        </span>
        <div className="brand-text">
          <h1>页面契约 Agent</h1>
          <p>PRD → 页面契约 → 骨架 / Mock / E2E / 自测清单</p>
        </div>
      </div>
      <div className="topbar-right">
        <span className={badgeClass}>
          <span className="dot" aria-hidden="true" />
          {running ? '正在执行' : engine}
        </span>
        <button type="button" className="ghost" onClick={onReset}>
          重置
        </button>
      </div>
    </header>
  )
}
