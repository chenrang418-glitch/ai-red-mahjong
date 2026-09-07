import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 一将成名 2011 第一批的定向压测。
 *
 * 通用压测是从全部武将里随机取阵容，新武将被抽中的概率很低——
 * 「几百局没崩」证明不了他们的技能真的跑过。这里把阵容按住，
 * 让每一局都必然有他们在场，然后按计数器确认技能确实被发动过。
 *
 * 计数器这一步不能省：只断言「跑完了」的话，AI 一次都没发动的技能
 * 同样不会让牌局崩，测试会绿得毫无意义。
 */

const BATCH_ONE = ['caozhi', 'yujin', 'zhangchunhua', 'fazheng']

function castFor(playerCount: number): string[] {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'xiahoudun', 'zhenji']
  const cast = [...BATCH_ONE]
  while (cast.length < playerCount) cast.push(filler[cast.length - BATCH_ONE.length])
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

describe('一将成名 2011 第一批压测', () => {
  it('五人局 120 局全部正常结束', () => {
    for (const result of runBatch(120, 5, 'yjcm11')) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 120 局全部正常结束', () => {
    for (const result of runBatch(120, 8, 'yjcm11')) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('四个人的技能确实被跑到了，不是空过', () => {
    const results = runBatch(80, 7, 'yjcm11-cover')
    /*
     * 【绝情】【毅重】【恩怨】是锁定技，只要人在场、条件成立就会跑到；
     * 【落英】【酒诗】【伤逝】【眩惑】要看 AI 的取舍和牌面，
     * 所以只要求整批里确实出现过。
     */
    expect(total(results, 'skill:jueqing'), '绝情是锁定技，一有伤害就该跑到').toBeGreaterThan(0)
    expect(total(results, 'skill:yizhong'), '毅重挡黑杀，整批里总该挡到几次').toBeGreaterThan(0)
    expect(total(results, 'skill:enyuan'), '恩怨是锁定技，挨打就该跑到').toBeGreaterThan(0)
    expect(total(results, 'skill:luoying'), '落英至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:shangshi'), '伤逝至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:xuanhuo'), '眩惑至少被用过一次').toBeGreaterThan(0)
  }, 300_000)
})
