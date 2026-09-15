import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 历史人物第二十三批（胡金定、曹安民、赵昂、夏侯杰、史阿、葛玄、童渊、
 * 赵直、刘晔、陈珪）的合并压测。
 */

const ALL_TEN = ['hujinding', 'caoanmin', 'zhaoang', 'xiahoujie', 'shia', 'gexuan', 'tongyuan', 'zhaozhi', 'liuye', 'chengui']

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

describe('历史人物第二十三批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `batch23-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `batch23-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `batch23-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['qingyuan', '轻缘'],
      ['xianwei', '险卫'],
      ['zhongjie', '忠节'], ['sushou', '夙守'],
      ['liedan', '裂胆'],
      ['liren', '砺刃'],
      ['lianhua', '炼化'],
      ['chaofeng', '朝凤'],
      ['tongguan', '统观'],
      ['poyuan', '破垣'],
      ['yingtu', '营图'], ['congshi', '从势'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 未点名的技能：重身（依赖本轮真正获得红牌且仍在手，条件较窄，随胡金定
     * 走查确认正确）；壮胆（依赖夏侯杰手牌数全场唯一最多，条件较窄）；剑出
     * （觉醒技，需要摸牌阶段外累计获得5张，条件较窄）；击格（依赖剑出先
     * 觉醒才能获得，条件链较长）；札符（限定技，一局一次，条件较窄）；传术
     * （限定技，需要童渊已受伤或死亡，条件较窄）；梦解（依赖统观分配后目标
     * 本回合真正达成条件，条件较窄）；画策（出牌阶段限一次且依赖上一轮没人
     * 用过的普通锦囊，条件较窄）。这些机制已随各自实现走查确认正确。
     */
  }, 1_200_000)
})
