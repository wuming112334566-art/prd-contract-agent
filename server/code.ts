import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { CodeScanResult } from '../shared/types'
import { describePagination, extractCodeFacts } from '../shared/code'

/**
 * 读现有代码，压成一份给模型看的摘要：文件清单 + 命中行片段 + 确定性事实。
 * 「先读代码再读 PRD」的入口：用户给一个本地目录，这里只提取与页面契约相关的部分，
 * 不把整个仓库塞进上下文。
 *
 * 给了页面标题时会先查路由表（config/routes.ts），把扫描范围收到该页面的目录，
 * 再补上 BaseTable / 常量 / services 这些共享代码——大仓库里只扫「页面」那几十个文件。
 */

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue'])
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'public',
  'assets',
  'static',
  // mock / 测试 / 文档不是页面现状，留着只会把 mock 里的 pageSize、/api/ 假路径顶上来
  'mock',
  'mocks',
  '__mocks__',
  'tests',
  'test',
  '__tests__',
  'e2e',
  'cypress',
  'docs',
  'deploy',
])
const MAX_FILES = 360
const MAX_FILE_CHARS = 48_000
const MAX_DEPTH = 8
const DIGEST_LIMIT = 9_000
const MAX_SNIPPET_FILES = 6
const MAX_SNIPPET_LINES = 36

/** 遍历顺序：src 优先，src 里 pages 优先；大仓库不会因为文件多而漏掉页面 */
const DIR_PRIORITY = ['src', 'app', 'pages', 'views', 'components', 'services', 'models', 'hooks', 'values', 'constants', 'utils', 'config']
const dirRank = (name: string) => {
  const index = DIR_PRIORITY.indexOf(name.toLowerCase())
  return index === -1 ? DIR_PRIORITY.length : index
}

const PATH_HINT = /(page|list|table|form|index|api|service|request|constant|enum|type|hook|store|mock)/i
const INTEREST =
  /page_?sizes?|pagination|columns|maxLength|\/api\/|\b(?:GET|POST|PUT|PATCH|DELETE)\(|fetch\(|axios|options\s*:|enum\s+|无权限|暂无|403|noPermission|empty/i

const ROUTE_FILES = ['config/routes.ts', 'config/routes.js', 'src/routes.ts', 'src/router.ts', 'src/router/index.ts']

interface LoadedFile {
  rel: string
  text: string
  score: number
}

const normalize = (path: string) => path.replace(/\\/g, '/')

async function collectFiles(dir: string, depth: number, out: string[], limit = MAX_FILES): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= limit) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  entries.sort((a, b) => dirRank(a.name) - dirRank(b.name) || a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (out.length >= limit) return
    // 忽略隐藏目录（.git / .next 等）和测试文件，它们不是页面现状
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(full, depth + 1, out, limit)
    } else if (entry.isFile() && CODE_EXT.has(extname(entry.name)) && !/\.(test|spec)\.[tj]sx?$|\.d\.ts$/.test(entry.name)) {
      out.push(full)
    }
  }
}

async function readCapped(file: string): Promise<string> {
  const text = await readFile(file, 'utf8')
  return text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) : text
}

const isUnder = (rel: string, dir: string) => {
  const path = normalize(rel)
  const base = normalize(dir)
  return path === base || path.startsWith(`${base}/`)
}

/** 页面目录 + BaseTable / 常量 / services：这些才是契约真正要用到的共享代码 */
const isShared = (rel: string) =>
  /(^|\/)src\/(components\/BaseTable|values\/(constants|enum)|services\/|utils\/request)/i.test(normalize(rel))

/**
 * 用页面标题查路由表，拿到该页面的组件目录。
 * 例：name: '数据报表' + component: './OperatorReport' → <root>/src/pages/OperatorReport
 */
async function findPageDir(root: string, page?: string): Promise<string | null> {
  const title = page?.trim()
  if (!title) return null
  const pagesRoot = join(root, 'src', 'pages')

  let routesText = ''
  for (const candidate of ROUTE_FILES) {
    const file = join(root, candidate)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) continue
    routesText = await readFile(file, 'utf8').catch(() => '')
    if (routesText) break
  }

  if (routesText) {
    const single = routesText.indexOf(`name: '${title}'`)
    const double = routesText.indexOf(`name: "${title}"`)
    const index = single >= 0 ? single : double
    if (index >= 0) {
      const start = Math.max(0, index - 400)
      const windowText = routesText.slice(start, index + 600)
      const nameAt = index - start
      const components = [...windowText.matchAll(/component:\s*['"]([^'"]+)['"]/g)]
      const nearest = components
        .map((match) => ({ match, distance: Math.abs((match.index ?? 0) - nameAt) }))
        .sort((a, b) => a.distance - b.distance)[0]?.match
      const component = nearest?.[1] ?? ''
      if (component.startsWith('./')) {
        const sub = component.replace(/^\.\//, '').replace(/\.(tsx?|jsx?)$/, '')
        const direct = join(pagesRoot, sub)
        const info = await stat(direct).catch(() => null)
        if (info) return info.isDirectory() ? direct : dirname(direct)
        const first = join(pagesRoot, sub.split(/[\\/]/)[0])
        const firstInfo = await stat(first).catch(() => null)
        if (firstInfo?.isDirectory()) return first
      }
    }
  }

  // 没有路由表时，按目录名猜（英文页面名）
  const wanted = title.toLowerCase().replace(/[\s_-]/g, '')
  const entries = await readdir(pagesRoot, { withFileTypes: true }).catch(() => [])
  const hit = entries.find(
    (entry) => entry.isDirectory() && entry.name.toLowerCase().replace(/[\s_-]/g, '') === wanted,
  )
  return hit ? join(pagesRoot, hit.name) : null
}

function scoreFile(rel: string, text: string, focusRel: string): number {
  let score = PATH_HINT.test(rel) ? 2 : 0
  if (/(^|[\\/])(pages|views|app)[\\/]/i.test(rel)) score += 2
  if (/(^|[\\/])src[\\/](pages|services|models|values)[\\/]/i.test(rel)) score += 2
  if (focusRel && isUnder(rel, focusRel)) score += 20
  if (isShared(rel)) score += 8
  if (/pageSize|pagination|columns|maxLength|\/api\/|\b(?:GET|POST|PUT|PATCH|DELETE)\(/i.test(text)) score += 3
  return score
}

/** 只取「跟契约有关」的命中行，带一行上下文；不相关的大文件不会挤占上下文 */
function pickSnippets(text: string): string {
  const lines = text.split('\n')
  const picked = new Set<number>()
  lines.forEach((line, index) => {
    if (!INTEREST.test(line)) return
    for (let n = Math.max(0, index - 1); n <= Math.min(lines.length - 1, index + 1); n += 1) picked.add(n)
  })
  return [...picked]
    .sort((a, b) => a - b)
    .slice(0, MAX_SNIPPET_LINES)
    .map((index) => {
      const line = lines[index].trimEnd()
      return `L${index + 1}: ${line.length > 180 ? `${line.slice(0, 180)}…` : line}`
    })
    .join('\n')
}

function head(text: string): string {
  return text.split('\n').slice(0, 50).join('\n').trimEnd()
}

function factsBlock(facts: ReturnType<typeof extractCodeFacts>): string {
  const lines = ['## 代码事实（现有实现，优先于 PRD；引用时 source 写 "code"）']
  const pagination = facts.pagination ? describePagination(facts.pagination) : ''
  if (pagination) lines.push(`- 分页：${pagination}（命中代码：${facts.pagination?.evidence}）`)
  // 原始值单独给一行：摘要可能被再次解析（例如缺口兜底），中文描述里没有 key=value
  if (facts.pagination) {
    const raw = [
      facts.pagination.pageSize ? `pageSize=${facts.pagination.pageSize}` : '',
      facts.pagination.pageSizes?.length ? `pageSizeOptions=[${facts.pagination.pageSizes.join(',')}]` : '',
      facts.pagination.showSizeChanger ? 'showSizeChanger=true' : '',
    ].filter(Boolean)
    if (raw.length) lines.push(`- 分页原始值：${raw.join('；')}`)
  }
  if (facts.apis.length) lines.push(`- 接口：${facts.apis.join('、')}`)
  if (lines.length === 1) lines.push('- 没识别到分页或接口配置，按下面的代码片段理解现有实现')
  return lines.join('\n')
}

export async function scanCode(target: string, page?: string): Promise<CodeScanResult> {
  const root = resolve(target.trim())
  const info = await stat(root).catch(() => null)
  if (!info) throw new Error(`路径不存在：${target.trim()}`)

  const focusDir = info.isDirectory() ? await findPageDir(root, page) : null
  const focusRel = focusDir ? relative(root, focusDir) : ''

  const files: string[] = []
  if (info.isFile()) {
    if (!CODE_EXT.has(extname(root))) throw new Error('只支持 .ts / .tsx / .js / .jsx / .vue 文件')
    files.push(root)
  } else {
    // 先收页面目录，保证大仓库里目标页不会被 360 个文件的上限挤掉
    if (focusDir) await collectFiles(focusDir, 0, files, 120)
    // 再收共享代码：BaseTable / 常量决定分页，services 决定接口
    for (const sub of ['src/components/BaseTable', 'src/values']) {
      const dir = join(root, sub)
      const info = await stat(dir).catch(() => null)
      if (info?.isDirectory()) await collectFiles(dir, 0, files, 80)
    }
    await collectFiles(root, 0, files)
  }
  const unique = [...new Set(files)]
  if (!unique.length) throw new Error('没找到可读的代码文件（.ts / .tsx / .js / .jsx / .vue），确认目录选对了')

  const loaded: LoadedFile[] = []
  for (const file of unique) {
    const text = await readCapped(file).catch(() => '')
    if (!text) continue
    const rel = info.isFile() ? basename(root) : relative(root, file)
    loaded.push({ rel, text, score: scoreFile(rel, text, focusRel) })
  }

  // 页面里出现 Api.ReportQueryApi.xxx 时，把对应的 src/services/ReportQuery 也读进来
  if (focusRel) {
    const focusText = loaded.filter((item) => isUnder(item.rel, focusRel)).map((item) => item.text).join('\n')
    const names = new Set(
      [...focusText.matchAll(/Api\.([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1].replace(/Api$/, '')),
    )
    for (const name of [...names].slice(0, 6)) {
      const dir = join(root, 'src', 'services', name)
      const dirInfo = await stat(dir).catch(() => null)
      if (!dirInfo) continue
      const serviceFiles: string[] = []
      await collectFiles(dirInfo.isDirectory() ? dir : dirname(dir), 0, serviceFiles, 40)
      for (const file of serviceFiles) {
        const rel = relative(root, file)
        if (loaded.some((item) => item.rel === rel)) continue
        const text = await readCapped(file).catch(() => '')
        if (!text) continue
        loaded.push({ rel, text, score: scoreFile(rel, text, focusRel) })
      }
    }
  }

  loaded.sort((a, b) => b.score - a.score)

  const focusLoaded = focusRel ? loaded.filter((item) => isUnder(item.rel, focusRel)) : []
  const sharedLoaded = loaded.filter((item) => isShared(item.rel))
  // 有页面目录时，分页/接口事实只从「本页 + 共享代码」里取，避免被别的页面带偏
  const factSources = focusLoaded.length ? [...focusLoaded, ...sharedLoaded] : loaded
  const facts = extractCodeFacts(factSources.map((item) => item.text).join('\n'))
  const blocks = [factsBlock(facts)]

  const sharedCore = sharedLoaded.filter((item) => !/services\//.test(normalize(item.rel)))
  const sharedService = sharedLoaded.filter((item) => /services\//.test(normalize(item.rel)))
  const pool = focusLoaded.length
    ? [
        ...focusLoaded.slice(0, 3),
        ...sharedCore.slice(0, 1),
        ...sharedService.slice(0, 1),
        ...loaded.filter((item) => !isUnder(item.rel, focusRel) && !isShared(item.rel)).slice(0, 1),
      ]
    : (loaded.filter((item) => item.score > 0).length ? loaded.filter((item) => item.score > 0) : loaded).slice(0, MAX_SNIPPET_FILES)

  const selected = pool.filter((item, index) => pool.findIndex((other) => other.rel === item.rel) === index).slice(0, MAX_SNIPPET_FILES)
  const matched: string[] = []
  for (const item of selected) {
    const snippet = pickSnippets(item.text)
    if (!snippet) continue
    blocks.push(`### ${item.rel}\n\`\`\`\n${snippet}\n\`\`\``)
    matched.push(item.rel)
  }
  // 一行业都没命中时，至少给模型看看文件开头，不能只剩一句「没识别到」
  if (blocks.length === 1) {
    for (const item of loaded.slice(0, 2)) {
      blocks.push(`### ${item.rel}\n\`\`\`\n${head(item.text)}\n\`\`\``)
      matched.push(item.rel)
    }
  }

  let digest = blocks.join('\n\n')
  const truncated = digest.length > DIGEST_LIMIT
  if (truncated) {
    digest = `${digest.slice(0, DIGEST_LIMIT)}\n…（代码摘要已截断，共扫到 ${unique.length} 个文件；片段不够时缩小目录范围再读）`
  }

  return { path: root, files: unique.length, digest, facts, matched, focus: focusRel || undefined, truncated }
}
