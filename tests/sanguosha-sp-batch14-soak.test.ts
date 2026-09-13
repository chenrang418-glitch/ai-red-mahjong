import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第十四批（贺齐、陈武董袭、吕范、刘巴、邓芝、孙登、
 * 孙茹、程秉、阮籍、周妃）的合并压测。按住阵容轮转，让每一局都必然
 * 有本批人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['heqi', 'chenwu_dongxi', 'lvfan', 'liuba', 'dengzhi', 'sundeng', 'sunru', 'chengbing', 'ruanji', 'zhoufei']

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

describe('SP 独立历史人物第十四批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp14-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp14-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp14-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['qizhou', '绮胄'], ['shanxi', '闪袭'],
      ['duanxie', '断绁'], ['fenming', '奋命'],
      ['diaodu', '调度'], ['diancai', '典财'],
      ['tongdu', '统度'], ['zhubi', '铸币'],
      ['xiuhao', '修好'], ['sujian', '素俭'],
      ['kuangbi', '匡弼'],
      ['chishi', '持室'], ['weimian', '慰勉'],
      ['jingzao', '经造'], ['enyu', '恩遇'],
      ['zhaowen', '昭文'],
      ['kongsheng', '箜声'], ['liangyin', '良姻'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 贺齐【绮胄】衍生的短兵/英姿/奋威/澜疆分别需要装备区凑齐1/2/3/4种
     * 花色，压缩规模的压测里未必凑得齐（尤其澜疆的4种），不强行点名
     * 这四个衍生技能，只点名绮胄本身（锁定技每次装备变化都会重算，
     * 一定会跑）。
     */
  }, 1_200_000)
})
