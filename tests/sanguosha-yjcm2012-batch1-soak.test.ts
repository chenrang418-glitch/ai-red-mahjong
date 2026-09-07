import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 一将成名 2012 第一批的定向压测。
 *
 * 通用压测从全部武将里随机取阵容，新武将被抽中的概率很低——
 * 「几百局没崩」证明不了他们的技能真的跑过。这里把阵容按住，
 * 让每一局都必然有他们在场，然后按计数器确认技能确实被发动过。
 */

const BATCH_ONE = ['caozhang', 'zhonghui', 'xunyou', 'wangyi']

function runBatch(count: number, playerCount: number, prefix: string, cast: string[]) {
  const results = []
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'sunshangxiang', 'caopi', 'zhenji']
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

describe('一将成名 2012 第一批压测', () => {
  it('五人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 5, 'yjcm12b1', BATCH_ONE)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 8, 'yjcm12b1', BATCH_ONE)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 将驰 × 陷阵 × 毅重：出杀次数 / 距离 / 无效三条规则叠在一起
      ['jiangchi-xianzhen', ['caozhang', 'gaoshun', 'yujin', 'zhangfei']],
      // 权计 × 绝情：伤害被换成失去体力时权计不该触发
      ['quanji-jueqing', ['zhonghui', 'zhangchunhua', 'guanyu', 'zhaoyun']],
      // 奇策 × 无言 × 智迟：虚拟锦囊撞上两种「无效 / 防止」
      ['qice-wuyan', ['xunyou', 'xushu', 'chengong', 'machao']],
      // 贞烈 × 明策 × 眩惑：回合外被指使着用牌时，使用者是谁
      ['zhenlie-mingce', ['wangyi', 'chengong', 'fazheng', 'huangzhong']],
      // 秘计 × 恩怨：一次给同一个人多张
      ['miji-enyuan', ['wangyi', 'fazheng', 'wuguotai', 'lingtong']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of runBatch(40, cast.length + 1, `mix12-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('四个人的技能确实被跑到了，不是空过', () => {
    const results = runBatch(120, 6, 'yjcm12b1-cover', BATCH_ONE)
    expect(total(results, 'skill:jiangchi'), '将驰至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:quanji'), '权计至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:qice'), '奇策至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:zhiyu'), '智愚至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:zhenlie'), '贞烈至少被用过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:miji'), '秘计至少被用过一次').toBeGreaterThan(0)
    /*
     * 【自立】要攒够三张「权」才觉醒，【排异】还要觉醒之后才有——
     * 这两条比其他技能罕见得多，所以单独用更大的样本去数，
     * 而不是把它们混进上面那一批里当成同一个门槛。
     */
    const long = runBatch(120, 5, 'yjcm12b1-zili', ['zhonghui', 'zhangfei', 'guanyu', 'zhaoyun'])
    expect(total(long, 'skill:zili'), '自立至少觉醒过一次').toBeGreaterThan(0)
    expect(total(long, 'skill:paiyi'), '排异至少被用过一次').toBeGreaterThan(0)
  }, 300_000)
})
