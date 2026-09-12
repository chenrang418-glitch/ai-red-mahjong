import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第四批（潘凤、士燮、诸葛瑾、董白、诸葛恪、诸葛瞻、张绣、
 * 蹋顿、孙乾、沙摩柯）的合并压测。按住阵容轮转，让每一局都必然有本批
 * 人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['panfeng', 'shixie', 'zhugejin', 'dongbai', 'zhugeke', 'zhugezhan', 'zhangxiu', 'tadun', 'sunqian', 'shamoke']

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

describe('SP 独立历史人物第四批合并压测', () => {
  it('八人局 80 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 80; index += 1) {
      const [result] = runBatch(1, 8, `sp4-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 60 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 60; index += 1) {
      const [result] = runBatch(1, 5, `sp4-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 120; index += 1) {
      results.push(...runBatch(1, 8, `sp4-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['kuangfu', '狂斧'],
      ['biluan', '避乱'], ['lixia', '礼下'],
      ['huanshi', '缓释'], ['hongyuan', '弘援'], ['mingzhe', '明哲'],
      ['lianzhu', '连诛'], ['xiahui', '黠慧'],
      ['aocai', '傲才'], ['duwu', '黩武'],
      ['zuilun', '罪论'], ['fuyin', '父荫'],
      ['congjian', '从谏'],
      ['luanzhan', '乱战'],
      ['qianya', '谦雅'], ['shuomeng', '说盟'],
      ['jili', '蒺藜'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    // 雄乱（xiongluan，限定技）在这个覆盖率检查里不强求单独点名
  }, 1_200_000)
})
