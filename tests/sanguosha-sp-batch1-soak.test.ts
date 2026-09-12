import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第一批（袁术、杨修、陈琳、张星彩、关银屏、曹昂、何太后、
 * 刘协、马云騄、糜竺）的合并压测。按住阵容轮转，让每一局都必然有本批
 * 人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['yuanshu', 'yangxiu', 'chenlin', 'zhangxingcai', 'guanyinping', 'caoang', 'hetaihou', 'liuxie', 'mayunlu', 'mizhu']

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

describe('SP 独立历史人物第一批合并压测', () => {
  it('八人局 80 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 80; index += 1) {
      const [result] = runBatch(1, 8, `sp1-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 60 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 60; index += 1) {
      const [result] = runBatch(1, 5, `sp1-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 100; index += 1) {
      results.push(...runBatch(1, 8, `sp1-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['yongsi', '庸肆'],
      ['danlao', '啖酪'], ['jilei', '鸡肋'],
      ['bifa', '笔伐'], ['songci', '颂词'],
      ['shenxian', '甚贤'], ['qiangwu', '枪舞'],
      ['xuehen', '雪恨'], ['huxiao', '虎啸'],
      ['kangkai', '慷忾'],
      ['zhendu', '鸩毒'], ['qiluan', '戚乱'],
      ['tianming', '天命'], ['mizhao', '密诏'],
      ['fengpo', '凤魄'],
      ['ziyuan', '资援'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    // 伪帝借主公技是否触发依赖当局是否真的抽到标准三主公之一，不强求每次合并压测都命中
    // 巨贾、马术是锁定技，不发 SkillActivated，覆盖由 typecheck/build 与「正常结束」压测盯
  }, 900_000)
})
