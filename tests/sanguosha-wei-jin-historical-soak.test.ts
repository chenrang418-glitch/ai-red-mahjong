import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 魏晋—汉末独立人物补完批（钟琰、嵇康、宣公主、清河公主、曹宇、薛灵芸、
 * 夏侯令女、刘宏、唐姬、王允）的合并压测。
 */

const ALL_TEN = ['zhongyan', 'jikang', 'xuangongzhu', 'qinghegongzhu', 'caoyu', 'xuelingyun', 'xiahoulingnv', 'liuhong', 'tangji', 'wangyun']

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

describe('魏晋—汉末独立人物补完批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `weijin-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `weijin-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `weijin-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['bolan', '博览'], ['yifa', '仪法'],
      ['qingxian', '清弦'], ['juexiang', '绝响'],
      ['gaoling', '高陵'], ['qimei', '齐眉'], ['zhuiji', '追姬'],
      ['zhengou', '谮构'], ['changji', '长姬'],
      ['gongjie', '恭节'], ['xiangxu', '相胥'],
      ['siqi', '思泣'], ['qiaozhi', '巧织'],
      ['fuping', '浮萍'], ['weilie', '炜烈'],
      ['yujue', '鬻爵'], ['tuxing', '图兴'],
      ['kangge', '抗歌'],
      ['lianji', '连计'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 未点名的技能：和弦/柔弦/烈弦/激弦（绝响随机授予其一，覆盖依赖随机数，
     * 不强行要求四个全中）；襄胙（限定技+需进入濒死，压缩规模里未必凑齐）；
     * 节烈（需要绑定角色以外的角色造成伤害，条件较窄）；执笏（鬻爵派生技，
     * 需先发动鬻爵并造成伤害）；谋逞/矜功（觉醒技，需连计产生的杀曾经命中，
     * 触发链更长）。这些机制已随各自实现走查确认正确。
     */
  }, 1_200_000)
})
