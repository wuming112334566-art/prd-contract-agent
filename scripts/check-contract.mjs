#!/usr/bin/env node
/**
 * 契约校验：把「契约能不能进评审」变成一条可执行的规则，而不是靠人看。
 * 校验的是确定性规则，不调模型、不联网 —— 所以可以放进 CI 当门禁。
 *
 *   node scripts/check-contract.mjs                       # 校验 out/ 下全部契约
 *   node scripts/check-contract.mjs path/to/x.contract.json
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_STATES = ['loading', 'empty', 'error', 'timeout', 'noPermission']
const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'enum']
const SOURCES = ['prd', 'api', 'code', 'assumption']

function walk(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else if (name.endsWith('.contract.json')) found.push(full)
  }
  return found
}

function collect(target) {
  let full = target
  try {
    statSync(full)
  } catch {
    full = join(root, target)
  }
  return statSync(full).isDirectory() ? walk(full) : [full]
}

function lint(contract) {
  const errors = []
  const warnings = []
  const fail = (message) => errors.push(message)
  const warn = (message) => warnings.push(message)

  if (!contract?.page) {
    fail('缺少 page 节点')
    return { errors, warnings }
  }
  if (!contract.page.id) fail('page.id 为空')
  if (!String(contract.page.route ?? '').startsWith('/')) fail('page.route 必须以 / 开头')
  if (!Array.isArray(contract.page.roles) || contract.page.roles.length === 0) fail('page.roles 为空')

  const fields = Array.isArray(contract.fields) ? contract.fields : []
  const names = new Set()
  for (const field of fields) {
    if (!field.name) fail('字段缺少 name')
    if (names.has(field.name)) fail(`字段 name 重复：${field.name}`)
    names.add(field.name)
    if (!FIELD_TYPES.includes(field.type)) fail(`字段 ${field.name} 的 type 非法：${field.type}`)
    if (!SOURCES.includes(field.source)) fail(`字段 ${field.name} 的 source 非法：${field.source}`)
    if (field.type === 'string' && !field.maxLength) fail(`字符串字段 ${field.name} 缺 maxLength`)
    // 金额类字段没写单位会直接产生 100 倍事故，其他数字字段只提示
    if (field.type === 'number' && !field.unit) {
      const moneyLike = /金额|价格|价|费用|成本|余额|额/.test(field.label ?? '')
      if (moneyLike) fail(`金额字段 ${field.name} 缺 unit`)
      else warn(`数字字段 ${field.name} 没写单位（个数 / 件 / 元？）`)
    }
    if (field.type === 'enum' && !field.options?.length) warn(`枚举字段 ${field.name} 没写 options`)
  }

  const regions = Array.isArray(contract.regions) ? contract.regions : []
  if (regions.length === 0) fail('没有任何区域')
  // 同一个字段可以同时出现在筛选区和列表区，只要能对上就行
  const assigned = new Set()
  for (const region of regions) {
    for (const name of region.fields ?? []) {
      if (!names.has(name)) fail(`区域 ${region.id} 引用了不存在的字段：${name}`)
      assigned.add(name)
    }
  }
  for (const field of fields) {
    if (!assigned.has(field.name)) fail(`字段 ${field.name} 没有归属区域`)
  }

  const states = Array.isArray(contract.states) ? contract.states : []
  const stateKeys = new Set(states.map((state) => state.key))
  for (const key of BASELINE_STATES) {
    if (!stateKeys.has(key)) fail(`缺少基线状态：${key}`)
  }
  if (stateKeys.size !== states.length) fail('states 存在重复 key')
  for (const state of states) {
    if (!state.trigger) fail(`状态 ${state.key} 没写触发条件，这种条目等于没写`)
  }

  const apis = Array.isArray(contract.apis) ? contract.apis : []
  if (apis.length === 0) warn('没有定义接口')
  for (const api of apis) {
    if (!/^[A-Z]+$/.test(api.method ?? '')) fail(`接口 method 非法：${api.method}`)
    if (!String(api.path ?? '').startsWith('/')) fail(`接口 path 必须从 / 开始：${api.path}`)
    if (!api.errorCodes?.length) warn(`接口 ${api.path} 没写错误码映射`)
  }

  for (const question of contract.openQuestions ?? []) {
    if (!question.question) fail('存在空问题')
    if (!question.impact) fail(`问题缺少影响说明：${question.question}`)
  }

  const assumptions = [
    ...fields,
    ...states,
    ...apis,
    ...(contract.interactions ?? []),
    ...(contract.tracking ?? []),
    ...(contract.edgeCases ?? []),
  ].filter((item) => item.source === 'assumption').length

  return { errors, warnings, stats: { fields: fields.length, regions: regions.length, states: states.length, apis: apis.length, questions: (contract.openQuestions ?? []).length, assumptions } }
}

const targets = process.argv[2] ? collect(process.argv[2]) : collect(join(root, 'out'))

if (targets.length === 0) {
  console.error('没找到契约文件，先跑 node scripts/run-sample.mjs')
  process.exit(1)
}

let failed = 0
for (const file of targets) {
  const contract = JSON.parse(readFileSync(file, 'utf8'))
  const { errors, warnings, stats } = lint(contract)
  const label = file.replace(root, '').replace(/^[\\/]/, '')
  if (errors.length) {
    failed += 1
    console.log(`✗ ${label}`)
    for (const error of errors) console.log(`    · ${error}`)
  } else {
    const s = stats
    console.log(`✓ ${label}  （${s.fields} 字段 / ${s.regions} 区域 / ${s.states} 状态 / ${s.apis} 接口 / ${s.questions} 缺口 / ${s.assumptions} 条待确认）`)
  }
  for (const warning of warnings) console.log(`    ! ${warning}`)
}

console.log(failed ? `\n${failed} 份契约未通过校验` : `\n${targets.length} 份契约全部通过校验`)
process.exit(failed ? 1 : 0)
