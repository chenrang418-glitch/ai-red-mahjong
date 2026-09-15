import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 独立历史人物第十九批（王昶、曹髦、庞会、胡班、诸葛尚、刘永、雷铜、吴兰、
 * 张陵、兀突骨）的合并压测。
 */

const ALL_TEN = ['wangchang', 'caomao', 'panghui', 'huban', 'zhugeshang', 'liuyong', 'leitong', 'wulan', 'zhangling', 'wutugu']

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

describe('独立历史人物第十九批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `batch19-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `batch19-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `batch19-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['kaiji', '开济'], ['pingxi', '平袭'],
      ['qianlong', '潜龙'], ['fensi', '忿肆'],
      ['yiyong', '异勇'], ['suchou', '夙仇'],
      ['huiyun', '晖云'],
      ['sangu', '三顾'],
      ['zhuning', '诛佞'],
      ['kuiji', '溃击'],
      ['cuirui', '挫锐'],
      ['huqi', '虎骑'], ['shoufu', '授符'],
      ['ranshang', '燃殇'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 未点名的技能：决讨（限定技+需体力为1，压缩规模里未必凑齐）；助势（主公技，
     * 需担任主公且友方魏角色回复体力，条件较窄）；轶祖（需成为杀/决斗目标且体力
     * 条件成立）；封乡（依赖诛佞先标记"隙"，覆盖依赖诛佞是否发动）；悍勇（需
     * 体力<轮数且使用南蛮/万箭，条件较窄）。这些机制已随各自实现走查确认正确。
     */
  }, 1_200_000)
})
