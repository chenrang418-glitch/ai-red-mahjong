import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第十批（公孙瓒、张宝、张济、管亥、孙邵、武安国、马休
 * 马铁、卢植、华歆、马日磾）的合并压测。按住阵容轮转，让每一局都必然有
 * 本批人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['gongsunzan', 'zhangbao', 'zhangji', 'guanhai', 'sunshao', 'wuanguo', 'maxiumatie', 'luzhi', 'huaxin', 'maridi']

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

describe('SP 独立历史人物第十批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp10-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp10-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp10-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['zhoufu', '咒缚'], ['yingbing', '影兵'],
      ['lueming', '掠命'],
      ['xiewei', '卸尾'], ['youque', '诱阙'],
      ['bizheng', '弼政'], ['yidian', '佚典'],
      ['liyong', '历勇'],
      ['kenshang', '垦伤'],
      ['mingren', '明任'], ['zhenliang', '贞良'],
      ['caozhao', '草诏'], ['xibing', '息兵'],
      ['bingjie', '秉节'], ['zhengding', '正订'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 义从是锁定的被动数值型技能（无 SkillActivated 计数点），马术同理。
     * 屯军是限定技，依赖掠命发动次数累计，AI 通用启发式在压测规模里较难
     * 稳定触发，不点名。
     */
  }, 1_200_000)
})
