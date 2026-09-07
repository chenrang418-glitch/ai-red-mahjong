import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 关兴张苞定向压测。
 *
 * 【父魂】同时接了两条路：出牌阶段的主动使用（印虚拟【杀】走正常管线）
 * 和响应求牌时的多牌转化（公共机制）。后者被随机阵容抽中的概率很低，
 * 所以这里刻意配上会逼人打出【杀】的角色。
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

function total(results: ReturnType<typeof run>, key: string): number {
  return results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)
}

describe('关兴张苞压测', () => {
  it('五人局 120 局全部正常结束', () => {
    for (const result of run(120, 5, 'gxzb', ['guanxingzhangbao'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 当先给的额外出牌阶段里也能用父魂；打中之后拿到咆哮，出杀不限次
      ['dangxian', ['guanxingzhangbao', 'liaohua', 'zhangfei', 'zhaoyun']],
      // 将驰的「本回合不能出杀」和父魂撞在一起
      ['jiangchi', ['guanxingzhangbao', 'caozhang', 'guanyu', 'huangzhong']],
      // 龙魂也走多牌转化：两套多牌机制同桌
      ['longhun', ['guanxingzhangbao', 'shenzhaoyun', 'zhangfei', 'machao']],
      // 毅重按黑色算：混色父魂杀是无色的，不该被当成黑牌
      ['yizhong', ['guanxingzhangbao', 'yujin', 'zhaoyun', 'huangzhong']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of run(40, cast.length + 1, `gxzb-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('父魂确实被跑到了，主动使用那条路也真的走过', () => {
    const results = run(120, 6, 'gxzb-cover', ['guanxingzhangbao'])
    expect(total(results, 'skill:fuhun'), '父魂至少被发动过一次').toBeGreaterThan(0)
    /*
     * `viewas:杀` 记的是「印的名字为空、当作【杀】用了」——也就是父魂印出来的
     * 那张虚拟【杀】真的走完了正常使用管线。这条和 `skill:fuhun` 分开看：
     * 后者响应求牌时也会加，只有它大于零证明不了主动使用那条路跑过。
     *
     * **授技本身在这里数不出来**：临时拿到的【武圣】是转化技，用它出杀记的是
     * `viewas:<牌名>->杀`，和关羽自己的武圣混在一起；【咆哮】是锁定技，
     * 根本不发 `SkillActivated`。所以授技由单元测试盯，压测只负责证明
     * 这两条路在真实牌局里都跑过而且不崩。
     */
    expect(total(results, 'viewas:杀'), '主动使用那条路真的印出过虚拟【杀】').toBeGreaterThan(0)
  }, 300_000)
})
