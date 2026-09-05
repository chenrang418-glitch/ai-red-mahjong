/**
 * 纸上三国无头压测。CI 里跑的是 tests/sanguosha-ai-soak.test.ts 的中等规模版本，
 * 这个脚本用于验收前的大批量跑：
 *
 *   node scripts/sanguosha-soak.mjs 500
 *   node scripts/sanguosha-soak.mjs 200 --characters=pangtong,wolongzhuge
 *
 * 任何一局失败都会打印 seed，用同一个 seed 就能精确复现。
 */
import { runSoakGame } from '../src/sanguosha/ai/soak.ts'

const perCount = Number(process.argv[2] ?? 100)
const characterIds = process.argv.find((value) => value.startsWith('--characters='))
  ?.slice('--characters='.length).split(',').filter(Boolean)
const counts = [5, 8]
let failures = 0

for (const playerCount of counts) {
  const started = Date.now()
  const turns = []
  const camps = {}
  const counters = {}
  for (let index = 0; index < perCount; index += 1) {
    const seed = `soak-${playerCount}-${index}`
    try {
      const result = runSoakGame({ seed, playerCount, characterIds })
      if (!result.finished) throw new Error('牌局没有正常结束')
      turns.push(result.turns)
      camps[result.winningCamp ?? 'none'] = (camps[result.winningCamp ?? 'none'] ?? 0) + 1
      for (const [key, value] of Object.entries(result.counters ?? {})) counters[key] = (counters[key] ?? 0) + value
    } catch (cause) {
      failures += 1
      console.error(`失败：seed=${seed} 人数=${playerCount}`)
      console.error(cause instanceof Error ? cause.message : cause)
    }
  }
  const average = Math.round(turns.reduce((sum, value) => sum + value, 0) / Math.max(turns.length, 1))
  console.log(
    `${playerCount} 人局 ${perCount} 局${characterIds?.length ? `（固定 ${characterIds.join('、')}）` : ''}：完成 ${turns.length}，平均 ${average} 回合，`
    + `最长 ${Math.max(...turns, 0)} 回合，阵营 ${JSON.stringify(camps)}，耗时 ${Date.now() - started}ms`,
  )
  // 专项压测时把机制计数打出来：某个关键机制 0 次就说明这轮压根没测到它
  if (characterIds?.length) {
    const shown = Object.entries(counters)
      .filter(([key]) => key.startsWith('skill:') || key.startsWith('viewas:') || key.startsWith('skip:') || key === 'recover')
      .sort((left, right) => right[1] - left[1])
    console.log(`  机制计数：${shown.map(([key, value]) => `${key}=${value}`).join(' ') || '（无）'}`)
  }
}

if (failures > 0) {
  console.error(`共 ${failures} 局失败`)
  process.exit(1)
}
console.log('压测通过')
