import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第十二批（卫兹、梁兴、刘辟、曹腾、郭图、轲比能、牛辅、
 * 袁姬、刘焉、丁原）的合并压测。按住阵容轮转，让每一局都必然有本批人物在
 * 场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['weizi', 'liangxing', 'liupi', 'caoteng', 'guotu', 'kebineng', 'niufu', 'yuanji', 'liuyan', 'dingyuan']

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

describe('SP 独立历史人物第十二批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp12-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp12-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp12-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['yuanzi', '援资'], ['liejie', '烈节'],
      ['lulue', '掳掠'], ['zhuixi', '追袭'],
      ['yicheng', '易城'],
      ['yongzu', '拥族'],
      ['qushi', '趋势'], ['weijie', '诿解'],
      ['pingduan', '平端'],
      ['shisuan', '蓍算'], ['zonglue', '纵掠'],
      ['jieyan', '节言'], ['jinghua', '镜花'], ['shuiyue', '水月'],
      ['tushe', '图射'], ['limu', '立牧'],
      ['cixiao', '慈孝'], ['xianlu', '先率'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 清流是"游戏开始选势力+首次濒死被救后换势力"的一次性/条件触发技能，
     * 在压缩规模压测里较难稳定命中，不点名。叛弑随"义子"mark动态授予/回收，
     * 同理不强行点名。
     */
  }, 1_200_000)
})
