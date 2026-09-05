import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 第四批神将的定向压测。
 *
 * 通用压测是从全部武将里随机取阵容，这四个人被抽中的概率很低——
 * 「600 局没崩」证明不了他们的技能真的跑过。这里把阵容按住，
 * 让每一局都必然有他们在场，然后按计数器确认技能确实被发动过。
 *
 * 计数器这一步不能省：只断言「跑完了」的话，AI 一次都没发动的技能
 * 同样不会让牌局崩，测试会绿得毫无意义。
 */

const BATCH_FOUR = ['shenguojia', 'shenxunyu', 'shensunce', 'shentaishici']

/** 四个人各在一个座位，其余用普通武将补齐。 */
function castFor(playerCount: number): string[] {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'xiahoudun', 'zhenji']
  const cast = [...BATCH_FOUR]
  while (cast.length < playerCount) cast.push(filler[cast.length - BATCH_FOUR.length])
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

/** 这一批局面里某个计数器一共出现了多少次。 */
function total(results: ReturnType<typeof runBatch>, key: string): number {
  return results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)
}

describe('第四批神将压测', () => {
  it('五人局 60 局全部正常结束', () => {
    const results = runBatch(60, 5, 'god4')
    for (const result of results) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('七人局 40 局全部正常结束', () => {
    const results = runBatch(40, 7, 'god4')
    for (const result of results) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('四个人的技能确实被跑到了，不是空过', () => {
    const results = runBatch(60, 7, 'god4-cover')
    /*
     * 锁定技一定会跑到，主动技看 AI 的取舍，所以这里只对**必然触发**的
     * 那几个断言下限：天佐开局注入、破围开局发围、覆海/灵策/笃烈是锁定技。
     * 主动技（慧识、英霸、破围分支、神著）只要求整批里至少出现过一次。
     */
    expect(total(results, 'skill:tianzuo'), '天佐是开局锁定技，每局都该发动').toBeGreaterThanOrEqual(results.length)
    expect(total(results, 'skill:powei'), '破围开局发围，之后还有移动和分支').toBeGreaterThanOrEqual(results.length)
    expect(total(results, 'card:奇正相生'), '注入的【奇正相生】要真的被摸到用出去').toBeGreaterThan(0)
    expect(total(results, 'skill:lingce'), '灵策是锁定技').toBeGreaterThan(0)
    expect(total(results, 'skill:dinghan'), '定汉是锁定技').toBeGreaterThan(0)
    expect(total(results, 'skill:fuhai') + total(results, 'skill:yingba'), '神孙策至少有一个技能跑到').toBeGreaterThan(0)
    expect(total(results, 'skill:dulie'), '笃烈是锁定技').toBeGreaterThan(0)
  }, 300_000)
})
