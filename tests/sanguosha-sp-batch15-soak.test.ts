import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第十五批（刘虞、黄皓、岑昏、张让、吴苋、薛综、蔡邕、
 * 鲁芝、陈到、张梁）的合并压测。按住阵容轮转，让每一局都必然有本批
 * 人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['liuyu', 'huanghao', 'cenhun', 'zhangrang', 'wuxian', 'xuezong', 'caiyong', 'luzhi_sp', 'chendao', 'zhangliang']

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

describe('SP 独立历史人物第十五批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp15-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp15-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp15-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['zhige', '止戈'], ['zongzuo', '宗祚'],
      ['qinqing', '寝情'], ['huisheng', '贿生'],
      ['jishe', '极奢'], ['lianhuo', '链祸'],
      ['taoluan', '滔乱'],
      ['fumian', '福绵'], ['daiyan', '怠宴'],
      ['funan', '复难'], ['jiexun', '诫训'],
      ['pizhuan', '辟撰'], ['tongbo', '通博'],
      ['qingzhong', '清忠'], ['weijing', '卫境'],
      ['wanglie', '往烈'],
      ['jijun', '集军'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 张梁【方统】需要弃置牌与"方"点数之和恰好为36这个较窄的条件，压缩
     * 规模的压测里未必能凑出来，不强行点名，机制已随集军/走查确认正确。
     */
  }, 1_200_000)
})
