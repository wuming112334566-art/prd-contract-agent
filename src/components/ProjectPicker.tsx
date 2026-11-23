import { useCallback, useEffect, useState } from 'react'
import type { ProjectListing } from '../../shared/types'
import { listProjects } from '../api'

interface ProjectPickerProps {
  open: boolean
  /** 打开时从哪一层开始：上次选过的目录 / 手输的路径 */
  initialPath?: string
  onClose: () => void
  onPick: (path: string) => void
}

/**
 * 项目选择弹框：服务端列目录，前端逐层进入，选中哪个文件夹就把它当项目根。
 * 浏览器拿不到本地绝对路径，所以浏览走 /api/projects，而不是 <input type="file">。
 */
export function ProjectPicker({ open, initialPath, onClose, onPick }: ProjectPickerProps) {
  const [listing, setListing] = useState<ProjectListing | null>(null)
  const [jump, setJump] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (target: string) => {
    setLoading(true)
    setError('')
    try {
      const next = await listProjects(target)
      setListing(next)
      setJump(next.path)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load(initialPath ?? '')
  }, [open, initialPath, load])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div
        className="picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="picker-head">
          <div>
            <h3 id="picker-title">选择项目文件夹</h3>
            <p className="picker-sub">选中后点「生成页面契约」，会先读这里的代码</p>
          </div>
          <button type="button" className="ghost small" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="picker-body">
          <div className="picker-path">
            <button
              type="button"
              className="ghost small"
              onClick={() => listing?.parent && void load(listing.parent)}
              disabled={!listing?.parent || loading}
            >
              上一级
            </button>
            <input
              className="picker-input"
              value={jump}
              onChange={(event) => setJump(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void load(jump)
              }}
              spellCheck={false}
              aria-label="目录路径"
            />
            <button type="button" className="ghost small" onClick={() => void load(jump)} disabled={loading || !jump.trim()}>
              跳转
            </button>
          </div>

          <div className="picker-roots">
            {listing?.drives.length ? (
              <>
                <span className="picker-label">磁盘</span>
                {listing.drives.map((drive) => (
                  <button
                    key={drive}
                    type="button"
                    className="ghost small"
                    title={drive}
                    onClick={() => void load(drive)}
                    disabled={loading}
                  >
                    {drive.replace(/\\$/, '')}
                  </button>
                ))}
                <span className="picker-sep" aria-hidden="true" />
              </>
            ) : null}
            {listing?.roots.map((root) => (
              <button
                key={root.path}
                type="button"
                className="ghost small"
                title={root.path}
                onClick={() => void load(root.path)}
                disabled={loading}
              >
                {root.label}
              </button>
            ))}
          </div>

          {error && <p className="picker-error">{error}</p>}

          <div className="picker-list">
            {loading ? (
              <p className="picker-empty">读取中…</p>
            ) : listing?.entries.length ? (
              listing.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="picker-row"
                  title={entry.path}
                  onClick={() => void load(entry.path)}
                >
                  <span className="picker-mark" aria-hidden="true">
                    ▸
                  </span>
                  <span className="picker-name">{entry.name}</span>
                  {entry.isProject && <span className="tag ok">项目</span>}
                  <span className="picker-enter">进入</span>
                </button>
              ))
            ) : (
              <p className="picker-empty">这个目录下没有子文件夹，可以直接选它</p>
            )}
            {listing?.truncated && <p className="picker-empty">文件夹太多，只显示前 300 个；可以用路径直接跳转</p>}
          </div>
        </div>

        <div className="picker-foot">
          <span className="picker-current" title={listing?.path}>
            {listing?.path ?? '—'}
          </span>
          <button
            type="button"
            className="picker-confirm"
            onClick={() => listing && onPick(listing.path)}
            disabled={!listing || loading}
          >
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  )
}
