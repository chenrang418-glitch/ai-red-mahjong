import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 刘表定向压测。
 *
 * 【自守】接管摸牌阶段并跳过出牌阶段，【宗室】动的是手牌上限——
 * 两者都靠「现存势力数」，而那个数会随着阵亡实时变。所以刻意配上
 * 多势力、会跳阶段、会改上限的角色。
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

describe('刘表压测', () => {
  it('五人局 120 局全部正常结束', () => {
    for (const result of run(120, 5, 'liubiao', ['liubiao'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 80 局全部正常结束', () => {
    for (const result of run(80, 8, 'liubiao', ['liubiao'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 伏枥读同一个计数器；当先给的额外出牌阶段和自守跳过的阶段位分属两处
      ['liaohua', ['liubiao', 'liaohua', 'zhangfei', 'zhaoyun']],
      // 多势力同桌：势力数随阵亡一路往下掉
      ['kingdoms', ['liubiao', 'caocao', 'sunquan', 'shenzhaoyun']],
      // 巧变、放权也跳阶段；持纲会把判定位跑成出牌阶段
      ['phases', ['liubiao', 'zhanghe', 'liushan', 'shen-sunquan']],
      // 好施、裸衣、突袭同样接管摸牌阶段：接管入口只有一个发问位
      ['drawphase', ['liubiao', 'lusu', 'dianwei', 'zhangliao']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of run(40, cast.length + 1, `liubiao-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('自守确实被跑到了', () => {
    const results = run(120, 6, 'liubiao-cover', ['liubiao'])
    expect(total(results, 'skill:zishou'), '自守至少被发动过一次').toBeGreaterThan(0)
    // 宗室是锁定技，不发 SkillActivated，覆盖由单元测试盯
  }, 300_000)
})
