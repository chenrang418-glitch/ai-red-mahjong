import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第二批（曹纯、戏志才、郝昭、王基、董允、秦宓、伊籍、田畴、
 * 田豫、陆绩）的合并压测。按住阵容轮转，让每一局都必然有本批人物在场，
 * 再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['caochun', 'xizhicai', 'haozhao', 'wangji', 'dongyun', 'qinmi', 'yiji', 'tianchou', 'tianyu', 'luji']

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

describe('SP 独立历史人物第二批合并压测', () => {
  it('八人局 80 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 80; index += 1) {
      const [result] = runBatch(1, 8, `sp2-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 60 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 60; index += 1) {
      const [result] = runBatch(1, 5, `sp2-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 100; index += 1) {
      results.push(...runBatch(1, 8, `sp2-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['shanjia', '缮甲'],
      ['xizhicai-tiandu', '天妒'], ['chouce', '筹策'],
      ['zhengu', '镇骨'],
      ['qizhi', '奇制'], ['jinqu', '进趋'],
      ['bingzheng', '秉正'], ['sheyan', '舍宴'],
      ['jianzheng', '谏征'], ['zhuandui', '专对'],
      ['jijie', '机捷'], ['jiyuan', '急援'],
      ['shandao', '善刀'],
      ['saodi', '扫狄'], ['zhuitao', '追讨'],
      ['yili', '遗礼'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    // 先辅（xianfu）、怀橘/整论是锁定技/被动或依赖伤害才生效，不强求在这个覆盖率检查里单独点名
  }, 900_000)
})
