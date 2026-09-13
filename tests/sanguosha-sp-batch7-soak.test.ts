import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第七批（孙皓、吴景、牵招、鲍信、杨阜、袁涣、杜袭、蒋琬、
 * 朱儁、陶谦）的合并压测。按住阵容轮转，让每一局都必然有本批人物在场，
 * 再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['sunhao', 'wujing', 'qianzhao', 'baoxin', 'yangfu', 'yuanhuan', 'duxi', 'jiangwan', 'zhujun', 'taoqian']

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

describe('SP 独立历史人物第七批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp7-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp7-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp7-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['canshi2', '残蚀'],
      ['heji', '合击'],
      ['weifu', '威抚'],
      ['mutao', '募讨'], ['yimou', '毅谋'],
      ['suyi', '肃衣'],
      ['deru', '德辱'], ['linjie', '临节'],
      ['quxi', '驱徙'], ['bixiong', '避凶'],
      ['xufa', '蓄发'],
      ['cuipo', '摧破'],
      ['zongluan', '纵乱'], ['wenren', '温仁'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 仇海/归命/流兵/屏忠/招祸 是纯锁定技/被动数值修正，不一定走
     * SkillActivated 播报，这里不强求单独点名。
     * 自若要求恰好打出当前手牌最左/最右侧那张牌，AI 洗牌后触发概率很低，
     * 不强求在这批压测规模里必然命中。
     */
  }, 1_200_000)
})
