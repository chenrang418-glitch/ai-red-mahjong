/**
 * 三国杀无头压测。CI 里跑的是 tests/sanguosha-ai-soak.test.ts 的中等规模版本，
 * 这个脚本用于验收前的大批量跑：
 *
 *   node scripts/sanguosha-soak.mjs 500
 *
 * 任何一局失败都会打印 seed，用同一个 seed 就能精确复现。
 */
import { runSoakGame } from '../src/sanguosha/ai/soak.ts'

const perCount = Number(process.argv[2] ?? 100)
const counts = [5, 8]
let failures = 0

for (const playerCount of counts) {
  const started = Date.now()
  const turns = []
  const camps = {}
  for (let index = 0; index < perCount; index += 1) {
    const seed = `soak-${playerCount}-${index}`
    try {
      const result = runSoakGame({ seed, playerCount })
      if (!result.finished) throw new Error('牌局没有正常结束')
      turns.push(result.turns)
      camps[result.winningCamp ?? 'none'] = (camps[result.winningCamp ?? 'none'] ?? 0) + 1
    } catch (cause) {
      failures += 1
      console.error(`失败：seed=${seed} 人数=${playerCount}`)
      console.error(cause instanceof Error ? cause.message : cause)
    }
  }
  const average = Math.round(turns.reduce((sum, value) => sum + value, 0) / Math.max(turns.length, 1))
  console.log(
    `${playerCount} 人局 ${perCount} 局：完成 ${turns.length}，平均 ${average} 回合，`
    + `最长 ${Math.max(...turns, 0)} 回合，阵营 ${JSON.stringify(camps)}，耗时 ${Date.now() - started}ms`,
  )
}

if (failures > 0) {
  console.error(`共 ${failures} 局失败`)
  process.exit(1)
}
console.log('压测通过')
