import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第十一批（王朗、郭皇后、孔淑、赵忠、蔡瑁、董翓、成济成倅、
 * 朱灵、阎柔、曹羲）的合并压测。按住阵容轮转，让每一局都必然有本批人物在
 * 场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['wanglang', 'guohuanghou', 'kongshu', 'zhaozhong', 'caimao', 'donghe', 'chengjichengcui', 'zhuling', 'yanrou', 'caoxi']

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

describe('SP 独立历史人物第十一批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp11-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp11-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp11-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['gushe', '鼓舌'],
      ['jiaozhao', '矫诏'], ['danxin', '殚心'],
      ['leiluan', '累卵'], ['fuchao', '覆巢'],
      ['pengbi', '朋比'], ['dici', '抵慈'],
      ['zuolian', '佐练'], ['jingzhou', '精舟'],
      ['bianyu', '鞭御'], ['fengyao', '凤瑶'],
      ['tousui', '透髓'], ['chuming', '畜鸣'],
      ['jixian', '急陷'],
      ['qiutao', '仇讨'],
      ['gangshu', '刚述'], ['jianxuan', '谏旋'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 狡威是纯锁定被动数值型技能（无 SkillActivated 计数点），不点名。
     * 隐天/蔽日都是一次性被动加成，触发依赖"任意角色回复体力/摸牌以外获得
     * 牌"这类间接条件，在压缩规模的压测里较难稳定命中，不点名。
     * 襄戍是限定技，依赖"本回合已经造成过伤害"，同样不强行点名。
     */
  }, 1_200_000)
})
