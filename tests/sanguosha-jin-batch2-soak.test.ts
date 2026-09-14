import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 晋系专项第二批（晋司马懿、晋张春华、羊祜、石苞、文鸯、卫瓘、杨艳、
 * 杨芷、王濬、司马孚）的合并压测。按住阵容轮转，让每一局都必然有本批
 * 人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['jin_simayi', 'jin_zhangchunhua', 'yanghu', 'shibao', 'wenyang', 'weiguan', 'yangyan', 'yangzhi', 'wangjun', 'simafu']

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

describe('晋系专项第二批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `jin2-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `jin2-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `jin2-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['buchen', '不臣'], ['xiongzhi', '雄志'], ['quanbian', '权变'],
      ['huishi2', '慧识'], ['qingleng', '清冷'], ['xuanmu', '宣穆'],
      ['huaiyuan', '怀远'], ['chongxin', '崇信'],
      ['zhuosheng', '擢升'],
      ['lvli', '膂力'],
      ['zhongyun', '忠允'], ['shenpin', '神品'],
      ['xianwan', '娴婉'], ['xuanbei', '选备'],
      ['maihuo', '埋祸'], ['wanyi', '婉嫕'],
      ['changqu', '长驱'], ['tongye', '统业'],
      ['beiyu', '备预'], ['duchi', '督持'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 鹰视（锁定技，无离散发动时机，只影响可见性）不单独点名；德彰/仇决/
     * 背水（觉醒技，分别需要"绥牌清空"/"手牌与体力差≥3"/"手牌或体力<2"
     * 才会触发，压缩规模的压测里未必凑得齐）不强行点名，机制已随各自
     * 实现走查确认正确。
     */
  }, 1_200_000)
})
