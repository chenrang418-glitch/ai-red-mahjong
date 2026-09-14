import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 晋势力专项第一批（司马师、司马昭、王元姬、杜预、羊徽瑜、司马伷、贾充、
 * 张华、周处、王祥）的合并压测。按住阵容轮转，让每一局都必然有本批
 * 人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['simashi', 'simazhao', 'wangyuanji', 'duyu', 'yanghuiyu', 'simazhou', 'jiachong', 'zhanghua', 'zhouchu', 'wangxiang']

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

describe('晋势力专项第一批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `jin1-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `jin1-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `jin1-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['taoyin', '韬隐'], ['yimie', '夷灭'], ['ruilue', '睿略'], ['tairan', '泰然'],
      ['tuishi', '推弑'], ['choufa', '筹伐'], ['zhaoran', '昭然'],
      ['shiren', '识人'], ['yanxi', '宴戏'],
      ['sanchen', '三陈'],
      ['huirong', '慧容'], ['ciwei', '慈威'], ['caiyuan', '才媛'],
      ['caiwang', '才望'],
      ['xiongshu', '凶竖'], ['jianhui', '奸回'],
      ['bihun', '弼昏'], ['chuanwu', '穿屋'], ['jianhe', '剑合'],
      ['shanduan', '善断'],
      ['bingxin', '冰心'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 成务（主公技，锁定技，无离散发动时机）、纳降（锁定技，只在建立强化
     * 名单时静默记账，效果并入才望统计）、昭讨/破竹（需要本局先攒够3次
     * 三陈才会觉醒，压缩规模的压测里未必凑得齐）、义烈（需要2张同色手牌
     * 才能发动，条件较苛刻）不强行点名，机制已随各自实现走查确认正确。
     */
  }, 1_200_000)
})
