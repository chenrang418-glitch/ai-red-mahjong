import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第十六批（夏侯霸、张翼、罗宪、傅肜、马承、霍峻、
 * 赵统赵广、张勋、孙翊、朱建平）的合并压测。按住阵容轮转，让每一局都
 * 必然有本批人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['xiahouba', 'zhangyi', 'luoxian', 'furong', 'macheng', 'huojun', 'zhaotong_zhaoguang', 'zhangxun', 'sunyi', 'zhujianping']

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

describe('SP 独立历史人物第十六批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp16-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp16-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp16-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['baobian', '豹变'],
      ['dianjun', '殿军'], ['kangrui', '亢锐'],
      ['daili', '带砺'],
      ['xiaosi', '效死'],
      ['chenglie', '骋烈'],
      ['qiongshou', '穷守'], ['fenrui', '奋锐'],
      ['yizan', '翊赞'], ['qingren', '青刃'],
      ['suizheng', '随征'],
      ['jiqiao', '激峭'],
      ['xiangmian', '相面'], ['tianji', '天机'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 马承【马术】是纯距离修正（distanceModifier），没有离散的"发动"时机，
     * 不会派发 SkillActivated，不强行点名。
     * 赵统赵广【龙渊】需要一局内累计发动至少3次翊赞才会觉醒，压缩规模的
     * 压测里未必凑得齐，不强行点名；孙翊【凶疑】需要她本人先进入濒死，
     * 属于条件触发的稀有事件，同样不强行点名，机制已随卫境/激峭等同类
     * 实现走查确认正确。
     */
  }, 1_200_000)
})
