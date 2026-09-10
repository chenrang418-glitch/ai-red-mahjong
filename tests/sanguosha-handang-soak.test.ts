import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 韩当定向压测。
 *
 * 【弓骑】动的是回合级【杀】规则，【解烦】是一次全场同时决定——
 * 两者都容易和别的「改杀次数 / 改装备」的技能打架，所以刻意配上它们。
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

describe('韩当压测', () => {
  it('五人局 120 局全部正常结束', () => {
    for (const result of run(120, 5, 'handang', ['handang'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 80 局全部正常结束', () => {
    for (const result of run(80, 8, 'handang', ['handang'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 疠火也改杀、也弃牌：两条回合级修正叠在一起
      ['chengpu', ['handang', 'chengpu', 'zhangfei', 'zhaoyun']],
      // 父魂打中会拿到咆哮（无限杀）：和弓骑的 +1 次聚合
      ['gxzb', ['handang', 'guanxingzhangbao', 'guanyu', 'machao']],
      // 陷阵的定向次数豁免 + 禁酒：次数聚合的另一侧
      ['gaoshun', ['handang', 'gaoshun', 'zhangfei', 'huangzhong']],
      // 解烦弃武器会触发枭姬 / 白银狮子这类「失去装备」的效果
      ['equip-loss', ['handang', 'sunshangxiang', 'caocao', 'zhaoyun']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of run(40, cast.length + 1, `handang-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('弓骑和解烦确实被跑到了', () => {
    const results = run(120, 6, 'handang-cover', ['handang'])
    expect(total(results, 'skill:gongqi'), '弓骑至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:jiefan'), '解烦至少被发动过一次').toBeGreaterThan(0)
  }, 300_000)
})
