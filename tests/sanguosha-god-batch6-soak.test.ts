import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 第六批神将的定向压测。
 *
 * 通用压测是从全部武将里随机取阵容，新武将被抽中的概率很低——
 * 「几百局没崩」证明不了他们的技能真的跑过。这里把阵容按住，
 * 让每一局都必然有他们在场，然后按计数器确认技能确实被发动过。
 *
 * 计数器这一步不能省：只断言「跑完了」的话，AI 一次都没发动的技能
 * 同样不会让牌局崩，测试会绿得毫无意义。
 */

const BATCH_SIX = ['shenzhangjiao', 'shendianwei', 'shensunquan', 'shenhuangzhong']

function castFor(playerCount: number): string[] {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'xiahoudun', 'zhenji']
  const cast = [...BATCH_SIX]
  while (cast.length < playerCount) cast.push(filler[cast.length - BATCH_SIX.length])
  return cast.slice(0, playerCount)
}

function runBatch(count: number, playerCount: number, prefix: string) {
  const results = []
  for (let index = 0; index < count; index += 1) {
    results.push(runSoakGame({
      seed: `${prefix}-${playerCount}-${index}`,
      playerCount,
      characterIds: castFor(playerCount),
    }))
  }
  return results
}

function total(results: ReturnType<typeof runBatch>, key: string): number {
  return results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)
}

describe('第六批神将压测', () => {
  it('五人局 60 局全部正常结束', () => {
    for (const result of runBatch(60, 5, 'god6')) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('七人局 40 局全部正常结束', () => {
    for (const result of runBatch(40, 7, 'god6')) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('四个人的技能确实被跑到了，不是空过', () => {
    const results = runBatch(60, 7, 'god6-cover')
    /*
     * 【异兆】【捐甲】【挈挟】【驭衡】是锁定技，只要人在场就该跑到；
     * 【摧决】【裂穹】【斩决】要看 AI 的取舍，所以只要求整批里确实出现过。
     */
    expect(total(results, 'skill:yizhao'), '异兆是锁定技，每局都该跑到').toBeGreaterThan(0)
    expect(total(results, 'skill:juanjia'), '捐甲游戏开始时就发动').toBeGreaterThan(0)
    expect(total(results, 'skill:qiexie'), '挈挟每个准备阶段都该问').toBeGreaterThan(0)
    expect(total(results, 'skill:yuheng'), '驭衡每个回合开始都该问').toBeGreaterThan(0)
    expect(total(results, 'skill:cuijue'), '摧决至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:lieqiong'), '裂穹至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:zhanjue'), '斩决至少被用过一次').toBeGreaterThan(0)
  }, 300_000)
})

describe('24 神联合压测', () => {
  /**
   * 24 名神将第一次全部进入同一个项目，这里让他们同桌打。
   *
   * 八人局每局取 8 名神将，跨局轮换，保证 24 个人都被跑到。
   */
  const GODS = [
    'shenguanyu', 'shenlvmeng', 'shenzhouyu', 'shenzhugeliang',
    'shencaocao', 'shenlvbu', 'shenzhaoyun', 'shensimayi',
    'shenliubei', 'shenluxun', 'shenzhangliao', 'shenganning',
    'shenguojia', 'shenxunyu', 'shensunce', 'shentaishici',
    'shenhuatuo', 'shenlusu', 'shenjiangwei', 'shenmachao',
    'shenzhangjiao', 'shendianwei', 'shensunquan', 'shenhuangzhong',
  ]

  function godCast(playerCount: number, offset: number): string[] {
    return Array.from({ length: playerCount }, (_, index) => GODS[(offset + index) % GODS.length])
  }

  it('五人全神局 120 局全部正常结束', () => {
    for (let index = 0; index < 120; index += 1) {
      const result = runSoakGame({
        seed: `gods-all-5-${index}`,
        playerCount: 5,
        characterIds: godCast(5, index),
      })
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('八人全神局 120 局全部正常结束，而且 24 名神将都上过场', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 120; index += 1) {
      const cast = godCast(8, index)
      cast.forEach((characterId) => seen.add(characterId))
      const result = runSoakGame({
        seed: `gods-all-8-${index}`,
        playerCount: 8,
        characterIds: cast,
      })
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
    expect(seen.size, '24 名神将全部上过场').toBe(GODS.length)
  }, 600_000)
})
