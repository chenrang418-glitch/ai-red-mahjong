// 把网页版的核心逻辑同步到小程序项目。
// 这几个文件是纯 TypeScript，不碰任何浏览器 API，所以两边可以完全一致——
// 小程序缺的 structuredClone 和 Array.at 由 miniprogram/utils/polyfill.ts 补，
// 不需要在这里改代码。规则或 AI 一改，跑一次这个脚本就同步过去了。
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = resolve(root, 'src/game')
const TARGET_DIR = resolve(root, 'miniprogram/core')

// persistence.ts 不在列：它直接用 localStorage 和 IndexedDB，
// 小程序那边要换成 wx 的存储，属于真正需要另写的部分。
const FILES = ['engine.ts', 'ai.ts', 'shanten.ts', 'types.ts', 'win.ts', 'tiles.ts', 'timing.ts']

mkdirSync(TARGET_DIR, { recursive: true })

let changed = 0
for (const name of FILES) {
  const from = resolve(SOURCE_DIR, name)
  const to = resolve(TARGET_DIR, name)
  const next = readFileSync(from, 'utf8')
  let current = ''
  try {
    current = readFileSync(to, 'utf8')
  } catch {
    // 目标还不存在，当成有改动
  }
  if (current === next) continue
  copyFileSync(from, to)
  changed += 1
  console.log(`  同步 ${name}`)
}

console.log(changed ? `核心逻辑已同步 ${changed} 个文件` : '核心逻辑已经是最新的')
