import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 独立历史人物第二十批（周群、蒲元、马元义、骆统、向朗、刘璿、荀勖、马邈、
 * 曹豹、张裕）的合并压测。
 */

const ALL_TEN = ['zhouqun', 'puyuan', 'mayuanyi', 'luotong', 'xianglang', 'liuxuan', 'xunxu', 'mamiao', 'caobao', 'zhangyu']

function rotate(offset: number, size: number): string[] {
  return Array.from({ length: size }, (_, index) => ALL_TEN[(offset + index) % ALL_TEN.length])
}

function runBatch(count: number, playerCount: number, prefix: string, cast: string[]) {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'sunshangxiang', 'caopi', 'zhenji']
  const characterIds = [...cast]
  while (characterIds.length < playerCount) characterIds.push(filler[characterIds.length - cast.length])
  const results = []
  for (let index = 0; index < count; index += 1) {
    results.push(runSoakGame({ seed: `${prefix}-${playerCount}-${index}`, playerCount, characterIds: characterIds.slice(0, playerCount) }))
  }
  return results
}

const total = (results: ReturnType<typeof runBatch>, key: string): number =>
  results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)

describe('独立历史人物第二十批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `batch20-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `batch20-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `batch20-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['tianhou', '天候'], ['chanshuo', '谶说'],
      ['qisi', '奇思'],
      ['jibing', '集兵'],
      ['renzheng', '仁政'],
      ['kanji', '勘集'],
      ['mogui', '漠规'], ['rencheng', '仁诚'],
      ['diyin', '笛音'],
      ['zhangguan', '仗关'], ['congfeng', '从风'],
      ['poyin', '迫饮'], ['yanjiu', '厌酒'],
      ['xiangchen', '相谶'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 未点名的技能：往京/兵祸（依赖集兵先真正打出兵，覆盖依赖集兵是否发动）；
     * 进谏（依赖伤害发生的具体交叉时机）；愆正（依赖成为杀/普通锦囊目标，条件较窄）；
     * 遵谏（觉醒技，需要漠规三选项全部移除，条件较窄）；博洽（需要三张花色/牌型
     * 全不同的手牌，条件较窄）；命定（限定技，需要进入濒死）。这些机制已随各自
     * 实现走查确认正确。
     */
  }, 1_200_000)
})
