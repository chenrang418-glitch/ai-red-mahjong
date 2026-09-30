import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第五批（王平、祖茂、徐氏、严畯、费祎、潘濬、周鲂、黄祖、
 * 凌操、袁谭袁尚）的合并压测。按住阵容轮转，让每一局都必然有本批人物
 * 在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['wangping', 'zumao', 'xushi', 'yanjun', 'feiyi', 'panjun', 'zhoufang', 'huangzu', 'lingcao', 'yuantanyuanshang']

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

describe('SP 独立历史人物第五批合并压测', () => {
  it('八人局 80 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 80; index += 1) {
      const [result] = runBatch(1, 8, `sp5-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 60 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 60; index += 1) {
      const [result] = runBatch(1, 5, `sp5-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 120; index += 1) {
      results.push(...runBatch(1, 8, `sp5-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['feijun', '飞军'], ['binglue', '兵略'],
      ['yinbing', '引兵'], ['juedi', '绝地'],
      ['wengua', '问卦'],
      ['guanchao', '观潮'],
      ['yanru-odd', '晏如（奇）'], ['yanru-even', '晏如（偶）'],
      ['guanwei', '观微'], ['gongqing', '公清'],
      ['youdi', '诱敌'], ['duanfa', '断发'],
      ['wangong', '挽弓'],
      ['dujin', '独进'],
      ['neifa', '内伐'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    // 伏诛（fuzhu）/逊贤（xunxian）/和衷（hezhong）条件较苛刻，这里不强求单独点名
  }, 1_200_000)
})
