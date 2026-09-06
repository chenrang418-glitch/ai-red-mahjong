import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 第五批神将的定向压测。
 *
 * 通用压测是从全部武将里随机取阵容，新武将被抽中的概率很低——
 * 「几百局没崩」证明不了他们的技能真的跑过。这里把阵容按住，
 * 让每一局都必然有他们在场，然后按计数器确认技能确实被发动过。
 *
 * 计数器这一步不能省：只断言「跑完了」的话，AI 一次都没发动的技能
 * 同样不会让牌局崩，测试会绿得毫无意义。
 */

const BATCH_FIVE = ['shenhuatuo', 'shenlusu']

function castFor(playerCount: number): string[] {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'xiahoudun', 'zhenji']
  const cast = [...BATCH_FIVE]
  while (cast.length < playerCount) cast.push(filler[cast.length - BATCH_FIVE.length])
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

describe('第五批神将压测', () => {
  it('五人局 60 局全部正常结束', () => {
    for (const result of runBatch(60, 5, 'god5')) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('七人局 40 局全部正常结束', () => {
    for (const result of runBatch(40, 7, 'god5')) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('两个人的技能确实被跑到了，不是空过', () => {
    const results = runBatch(60, 7, 'god5-cover')
    /*
     * 榻谟是开局技能，每一局都该被问到；五灵、定州、智盟是主动技，
     * 看 AI 的取舍，所以只要求整批里确实出现过。
     */
    expect(total(results, 'skill:wuling'), '五灵至少要被发动过').toBeGreaterThan(0)
    expect(
      total(results, 'skill:dingzhou') + total(results, 'skill:zhimeng'),
      '神鲁肃至少有一个主动技被用过',
    ).toBeGreaterThan(0)
  }, 300_000)
})
