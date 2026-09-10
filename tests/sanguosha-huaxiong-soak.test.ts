import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 华雄定向压测。
 *
 * 【耀武】挂在「受到伤害后」，而且把一个请求发给**伤害来源**——
 * 来源可能是任何人、可能在排队期间死掉。所以刻意配上会改伤害、
 * 会防止伤害、会把伤害换成失去体力的角色。
 */

function run(count: number, playerCount: number, prefix: string, cast: string[]) {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'sunshangxiang', 'caopi', 'zhenji']
  const characterIds = [...cast]
  while (characterIds.length < playerCount) characterIds.push(filler[characterIds.length - cast.length])
  const results = []
  for (let index = 0; index < count; index += 1) {
    results.push(runSoakGame({ seed: `${prefix}-${playerCount}-${index}`, playerCount, characterIds: characterIds.slice(0, playerCount) }))
  }
  return results
}

const total = (results: ReturnType<typeof run>, key: string): number =>
  results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)

describe('华雄压测', () => {
  it('五人局 120 局全部正常结束', () => {
    for (const result of run(120, 5, 'huaxiong', ['huaxiong'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 80 局全部正常结束', () => {
    for (const result of run(80, 8, 'huaxiong', ['huaxiong'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 疠火把红色普通【杀】改成火【杀】：仍然是红色的【杀】，照样触发
      ['chengpu', ['huaxiong', 'chengpu', 'zhangfei', 'zhaoyun']],
      // 绝情把伤害换成失去体力：那种情况下走不到「伤害后」
      ['jueqing', ['huaxiong', 'zhangchunhua', 'guanyu', 'machao']],
      // 无言防止锦囊伤害；潜袭只禁使用和打出，不影响伤害后的触发
      ['xushu-madai', ['huaxiong', 'xushu', 'madai', 'huangzhong']],
      // 父魂合成的混色【杀】是无色的：不该触发
      ['gxzb', ['huaxiong', 'guanxingzhangbao', 'zhaoyun', 'caopi']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of run(40, cast.length + 1, `huaxiong-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('耀武确实被跑到了', () => {
    const results = run(120, 6, 'huaxiong-cover', ['huaxiong'])
    expect(total(results, 'skill:yaowu'), '耀武至少被触发过一次').toBeGreaterThan(0)
  }, 300_000)
})
