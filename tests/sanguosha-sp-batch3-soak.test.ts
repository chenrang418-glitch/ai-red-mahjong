import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第三批（程昱、曹爽、张昌蒲、吕虔、蒋干、诸葛诞、许靖、
 * 高览、李傕、郭汜）的合并压测。按住阵容轮转，让每一局都必然有本批人物
 * 在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['chengyu', 'caoshuang', 'zhangchangpu', 'lvqian', 'jianggan', 'zhuge_dan', 'xujing', 'gaolan', 'lijue', 'guosi']

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

describe('SP 独立历史人物第三批合并压测', () => {
  it('八人局 80 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 80; index += 1) {
      const [result] = runBatch(1, 8, `sp3-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 60 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 60; index += 1) {
      const [result] = runBatch(1, 5, `sp3-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 100; index += 1) {
      results.push(...runBatch(1, 8, `sp3-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['shefu', '设伏'], ['benyu', '贲育'],
      ['tuogu', '托孤'], ['shanzhuan', '擅专'],
      ['yanjiao', '严教'], ['shengshen', '省身'],
      ['weilu', '威虏'], ['zengdao', '赠刀'],
      ['weicheng', '伪诚'], ['daoshu', '盗书'],
      ['gongao', '功獒'],
      ['yuxu', '誉虚'],
      ['xiying', '袭营'],
      ['langxi', '狼袭'], ['yisuan', '亦算'],
      ['tanbei', '贪狈'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    // 举义（juyi）/威重（weizhong）需要体力上限满足特定条件才能觉醒，实荐（shijian）
    // 需要目标在同一回合内使用两张牌，伺盗（sidao）需要连续两次同目标用牌，
    // 这几个条件性较强的技能不强求在这个覆盖率检查里单独点名。
  }, 900_000)
})
