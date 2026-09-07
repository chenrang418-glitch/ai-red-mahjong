import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 一将成名 2011 第二批的定向压测。
 *
 * 通用压测从全部武将里随机取阵容，新武将被抽中的概率很低——
 * 「几百局没崩」证明不了他们的技能真的跑过。这里把阵容按住，
 * 让每一局都必然有他们在场，然后按计数器确认技能确实被发动过。
 *
 * 计数器这一步不能省：只断言「跑完了」的话，AI 一次都没发动的技能
 * 同样不会让牌局崩，测试会绿得毫无意义。
 */

const BATCH_TWO = ['masu', 'xushu', 'lingtong', 'wuguotai']
const BATCH_ONE = ['caozhi', 'yujin', 'zhangchunhua', 'fazheng']

function runBatch(count: number, playerCount: number, prefix: string, cast: string[]) {
  const results = []
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'xiahoudun', 'zhenji', 'sunshangxiang']
  const characterIds = [...cast]
  while (characterIds.length < playerCount) characterIds.push(filler[characterIds.length - cast.length])
  for (let index = 0; index < count; index += 1) {
    results.push(runSoakGame({
      seed: `${prefix}-${playerCount}-${index}`,
      playerCount,
      characterIds: characterIds.slice(0, playerCount),
    }))
  }
  return results
}

function total(results: ReturnType<typeof runBatch>, key: string): number {
  return results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)
}

describe('一将成名 2011 第二批压测', () => {
  it('五人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 5, 'yjcm11b2', BATCH_TWO)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 8, 'yjcm11b2', BATCH_TWO)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('第一批 + 第二批混合八人局 120 局全部正常结束', () => {
    const mixed = [...BATCH_ONE, ...BATCH_TWO]
    for (const result of runBatch(120, 8, 'yjcm11mix', mixed)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('神将 + 一将成名混合八人局 120 局全部正常结束', () => {
    const mixed = ['shenzhangjiao', 'shendianwei', 'shensunquan', 'shenhuangzhong', ...BATCH_TWO]
    for (const result of runBatch(120, 8, 'yjcm11god', mixed)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('四个人的技能确实被跑到了，不是空过', () => {
    const results = runBatch(120, 7, 'yjcm11b2-cover', BATCH_TWO)
    /*
     * 【无言】【挥泪】是锁定技，条件成立就跑；
     * 【心战】【举荐】【旋风】【甘露】【补益】要看 AI 的取舍和牌面，
     * 所以只要求整批里确实出现过。
     */
    expect(total(results, 'skill:wuyan'), '无言是锁定技，一有锦囊伤害就该跑到').toBeGreaterThan(0)
    expect(total(results, 'skill:xinzhan'), '心战至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:huilei'), '挥泪至少触发过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:jujian'), '举荐至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:xuanfeng'), '旋风至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:ganlu'), '甘露至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:buyi'), '补益至少被用过一次').toBeGreaterThan(0)
  }, 300_000)
})
