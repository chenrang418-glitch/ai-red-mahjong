import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 魏吴群独立历史人物补完批（乐进、李典、曹洪、曹芳、孙鲁育、荀谌、宗预、
 * 张奋、孙资刘放、乐綝）的合并压测。
 */

const ALL_TEN = ['yuejin', 'lidian', 'caohong', 'caofang', 'sunluyu', 'xunchen', 'zongyu', 'zhangfen', 'sunzi_liufang', 'yuechen']

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

describe('魏吴群独立历史人物补完批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `batch22-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `batch22-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `batch22-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['xiaoguo', '骁果'],
      ['xunxun', '恂恂'], ['wangxi', '忘隙'],
      ['huyuan', '护援'],
      ['zhimin', '置民'],
      ['meibu', '魅步'], ['mumu', '穆穆'],
      ['fenglue', '锋略'], ['anyong', '暗涌'],
      ['qiao', '气傲'],
      ['xianzhu', '陷筑'], ['chaixie', '拆械'],
      ['qinshen', '勤慎'], ['weidang', '伪谠'],
      ['poerui', '破锐'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 未点名的技能：拒谏（主公技，只有曹芳恰好坐主公位时才可能发动，条件较
     * 窄）；止息（孙鲁育魅步授予的临时技能，跟随魅步触发概率走，已随魅步一起
     * 走查确认正确）；承赏（需要一次目标含异势力、且未造成伤害的用牌，条件
     * 较窄）；望橹（锁定技，只搬运装备/额外阶段状态，不走 SkillActivated
     * 广播，压测计数器天然看不到，已随张奋实现走查确认正确）；共护（锁定技，
     * 需要连续两回合外满足触发条件才会真正升级，条件较窄，已随乐綝实现走查
     * 确认正确）。这些机制已随各自实现走查确认正确。
     */
  }, 1_200_000)
})
