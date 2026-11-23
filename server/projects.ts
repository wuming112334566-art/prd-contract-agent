import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import type { ProjectListing, ProjectRoot } from '../shared/types'
import type { RuntimeConfig } from './config'

/**
 * 项目选择器的后端：列一层目录，标出哪些文件夹像项目根。
 * 浏览器拿不到本地绝对路径，所以目录浏览放在服务端做——服务本来就跑在本机。
 */

const MAX_ENTRIES = 300
/** 这些目录不是项目，点进去也只会浪费一次点击（Windows 下大小写不敏感） */
const SKIP = new Set([
  'node_modules',
  'appdata',
  'application data',
  'local settings',
  'system volume information',
  'recovery',
  'perflogs',
  'inetpub',
  'onedrivetemp',
  'drvpath',
  'program files',
  'program files (x86)',
  'programdata',
  'windows',
  'msocache',
  'config.msi',
])

export function projectRoots(config: RuntimeConfig): ProjectRoot[] {
  const roots: ProjectRoot[] = []
  const add = (label: string, target: string) => {
    if (!target.trim()) return
    const path = resolve(target)
    if (!roots.some((root) => root.path === path)) roots.push({ label, path })
  }
  add('代码根目录', config.codeRoot)
  add('用户目录', homedir())
  add('当前目录', process.cwd())
  return roots
}

/** Windows 下枚举盘符，让用户能从 C:\ 切到 D:\；其他系统就是根目录 */
async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/']
  const found = await Promise.all(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter) => {
      const root = `${letter}:\\`
      const info = await stat(root).catch(() => null)
      return info?.isDirectory() ? root : ''
    }),
  )
  return found.filter((root): root is string => Boolean(root))
}

async function isProject(dir: string): Promise<boolean> {
  const marks = await Promise.all(
    ['package.json', '.git', 'pnpm-workspace.yaml'].map((name) => stat(join(dir, name)).catch(() => null)),
  )
  return marks.some(Boolean)
}

export async function listProjects(config: RuntimeConfig, target?: string): Promise<ProjectListing> {
  const roots = projectRoots(config)
  const requested = resolve(target?.trim() || roots[0]?.path || process.cwd())
  const info = await stat(requested).catch(() => null)
  if (!info) throw new Error(`目录不存在：${requested}`)

  // 传进来的是文件时，从它所在目录开始
  const dir = info.isDirectory() ? requested : dirname(requested)
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    throw new Error(`没有权限读取目录：${dir}`)
  }

  const folders = dirents.filter((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('$')) return false
    return !SKIP.has(entry.name.toLowerCase())
  })
  const entries = await Promise.all(
    folders.slice(0, MAX_ENTRIES).map(async (entry) => {
      const path = join(dir, entry.name)
      return { name: entry.name, path, isProject: await isProject(path) }
    }),
  )
  // 项目排前面，同组按名字排，省得用户在一堆缓存目录里找
  entries.sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name))

  return {
    path: dir,
    parent: parse(dir).root === dir ? null : dirname(dir),
    drives: await listDrives(),
    roots,
    entries,
    truncated: folders.length > MAX_ENTRIES,
  }
}
