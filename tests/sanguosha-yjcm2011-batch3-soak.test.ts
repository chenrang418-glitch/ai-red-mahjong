import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 一将成名 2011 第三批 + 全 11 人的联合压测。
 *
 * 通用压测从全部武将里随机取阵容，新武将被抽中的概率很低——
 * 「几百局没崩」证明不了他们的技能真的跑过。这里把阵容按住，
 * 让每一局都必然有他们在场，然后按计数器确认技能确实被发动过。
 */

const BATCH_THREE = ['xusheng', 'chengong', 'gaoshun']
const YJCM2011 = [
  'caozhi', 'yujin', 'zhangchunhua', 'fazheng',
  'masu', 'xushu', 'lingtong', 'wuguotai',
  'xusheng', 'chengong', 'gaoshun',
]

function runBatch(count: number, playerCount: number, prefix: string, cast: string[], offset = 0) {
  const results = []
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'sunshangxiang', 'caopi', 'zhenji']
  for (let index = 0; index < count; index += 1) {
    /*
     * 阵容按局轮换，让 11 个人都轮得到上场——固定取前 N 个的话，
     * 排在后面的几位一局都跑不到。
     */
    const rotated = [...cast.slice((index + offset) % cast.length), ...cast.slice(0, (index + offset) % cast.length)]
    const characterIds = [...rotated]
    while (characterIds.length < playerCount) characterIds.push(filler[characterIds.length - rotated.length])
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

describe('一将成名 2011 第三批压测', () => {
  it('五人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 5, 'yjcm11b3', BATCH_THREE)) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 8, 'yjcm11b3', BATCH_THREE)) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 破军 × 旋风 × 甘露 × 枭姬：装备离场那一串交互
      ['pojun-equip', ['xusheng', 'lingtong', 'wuguotai', 'sunshangxiang']],
      // 明策 × 陷阵 × 恩怨：回合外使用杀 + 定向修正
      ['mingce-xianzhen', ['chengong', 'gaoshun', 'fazheng', 'zhangfei']],
      // 禁酒 × 毅重：黑色的酒当杀
      ['jinjiu-yizhong', ['gaoshun', 'yujin', 'zhaoyun', 'guanyu']],
      // 破军 × 行殇 × 落英：死亡清理
      ['pojun-death', ['xusheng', 'caopi', 'caozhi', 'machao']],
      // 智迟 × 无言 × 绝情：伤害管线上的三个防止 / 替换
      ['zhichi-wuyan', ['chengong', 'xushu', 'zhangchunhua', 'huangzhong']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of runBatch(40, cast.length + 1, `mix-${name}`, cast)) {
        expect(result.finished, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('三个人的技能确实被跑到了，不是空过', () => {
    const results = runBatch(120, 6, 'yjcm11b3-cover', BATCH_THREE)
    expect(total(results, 'skill:pojun'), '破军至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:mingce'), '明策至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:zhichi'), '智迟是锁定技，回合外挨打就该跑到').toBeGreaterThan(0)
    expect(total(results, 'skill:xianzhen'), '陷阵至少被用过一次').toBeGreaterThan(0)
    /*
     * 【禁酒】是「牌身份被改写」的锁定技，不派发技能事件——
     * 只看 `skill:jinjiu` 会永远是 0，看起来像 AI 完全不会用它。
     * 真正该数的是**实体【酒】被当成【杀】用了几次**。
     */
    expect(total(results, 'viewas:酒->杀'), '禁酒把酒当杀用过').toBeGreaterThan(0)
  }, 300_000)
})

describe('一将成名 2011 十一人联合压测', () => {
  it('八人局 200 局全部正常结束，而且 11 个人都上过场', () => {
    const results = runBatch(200, 8, 'yjcm11-all', YJCM2011)
    for (const result of results) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
    /*
     * 阵容按局轮换，所以 11 个人都该上过场。
     * 这一条守的是「这批压测真的覆盖了全包」，不是随手跑了 200 局。
     */
    const seen = new Set(results.flatMap((result) => result.characterIds ?? []))
    for (const characterId of YJCM2011) {
      expect(seen.has(characterId), `${characterId} 一局都没上过场`).toBe(true)
    }
  }, 300_000)

  it('五人局 120 局全部正常结束', () => {
    for (const result of runBatch(120, 5, 'yjcm11-all', YJCM2011)) {
      expect(result.finished, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)
})
