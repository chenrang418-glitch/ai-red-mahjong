import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 一将成名 2012 第二批的定向压测。
 *
 * 通用压测从全部武将里随机取阵容，新武将被抽中的概率很低——
 * 「几百局没崩」证明不了他们的技能真的跑过。这里把阵容按住，
 * 让每一局都必然有他们在场，然后按计数器确认技能确实被发动过。
 */

const BATCH_TWO = ['liaohua', 'guanxingzhangbao', 'madai', 'chengpu']

function runBatch(count: number, playerCount: number, prefix: string, cast: string[]) {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'sunshangxiang', 'caopi', 'zhenji']
  const characterIds = [...cast]
  while (characterIds.length < playerCount) characterIds.push(filler[characterIds.length - cast.length])
  const results = []
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

describe('一将成名 2012 第二批压测', () => {
  it('五人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 5, 'yjcm12b2', BATCH_TWO)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 8, 'yjcm12b2', BATCH_TWO)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 当先的额外出牌阶段 × 巧变跳阶段 × 持纲替换阶段：三种改阶段的效果同桌
      ['phases', ['liaohua', 'zhanghe', 'shen-sunquan', 'liushan']],
      // 父魂的子牌 × 潜袭的颜色禁令 × 气海的花色禁令
      ['locks', ['guanxingzhangbao', 'madai', 'shenhuangzhong', 'guanyu']],
      // 疠火的自伤 × 醇醪的救援 × 涅槃、不屈：濒死窗口上叠四层
      ['dying', ['chengpu', 'pangtong', 'zhoutai', 'liaohua']],
      // 第二批四个人自己凑一桌：技能之间互相踩
      ['batch2', BATCH_TWO],
      // 和 2012 第一批同桌：将驰的禁令、权计、奇策、贞烈
      ['with-batch1', ['liaohua', 'caozhang', 'xunyou', 'wangyi']],
      // 和 2011 同桌：陷阵的次数豁免、破军的扣置牌、恩怨
      ['with-2011', ['guanxingzhangbao', 'gaoshun', 'xusheng', 'fazheng']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of runBatch(40, cast.length + 1, `mix12b2-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('四个人的技能确实被跑到了，不是空过', () => {
    const results = runBatch(120, 6, 'yjcm12b2-cover', BATCH_TWO)
    expect(total(results, 'skill:dangxian'), '当先是锁定技，每个廖化回合都该发动').toBeGreaterThan(0)
    expect(total(results, 'skill:fuhun'), '父魂至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'viewas:杀'), '父魂主动使用那条路真的印出过虚拟【杀】').toBeGreaterThan(0)
    expect(total(results, 'skill:qianxi'), '潜袭至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:lihuo'), '疠火至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:chunlao'), '醇醪至少被发动过一次').toBeGreaterThan(0)
    /*
     * 【伏枥】是限定技，而且要真的濒死才有机会——比其他技能罕见得多，
     * 所以单独用更大的样本去数，不和上面那一批混成同一个门槛。
     */
    const long = runBatch(120, 5, 'yjcm12b2-fuli', ['liaohua', 'zhangfei', 'guanyu', 'zhaoyun'])
    expect(total(long, 'skill:fuli'), '伏枥至少被发动过一次').toBeGreaterThan(0)
  }, 300_000)
})
