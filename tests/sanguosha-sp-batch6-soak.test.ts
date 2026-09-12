import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第六批（陆抗、徐荣、樊稠、卑弥呼、麹义、淳于琼、刘琦、
 * 司马徽、陆凯、曹性）的合并压测。按住阵容轮转，让每一局都必然有本批
 * 人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['lukang', 'xurong', 'fanchou', 'beimihu', 'quyi', 'chunyuqiong', 'liuqi', 'simahui', 'lukai', 'caoxing']

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

describe('SP 独立历史人物第六批合并压测', () => {
  it('八人局 40 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 40; index += 1) {
      const [result] = runBatch(1, 8, `sp6-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 30 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 5, `sp6-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 100; index += 1) {
      results.push(...runBatch(1, 8, `sp6-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['jueyan', '决堰'],
      ['xionghuo', '凶镬'], ['shajue', '杀绝'],
      ['xingluan', '兴乱'],
      ['liangying', '粮营'], ['shishou', '失守'],
      ['wenji', '问计'],
      ['jianjie', '荐杰'],
      ['xuanzhu', '玄注'],
      ['liushi', '流矢'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 谦节/伏骑/骄恣/仓储是纯锁定技/被动数值修正，不走 SkillActivated 播报，
     * 计数器天然是 0，不在这里点名。
     * 破势/拜假/称好/隐士/杀绝二段/蚕食/謇谔 条件较苛刻，这里不强求单独点名。
     */
  }, 1_200_000)
})
