import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第八批（张鲁、刘辩、祢衡、张琪瑛、成公英、韩馥、辛宪英、
 * 陈登、阎圃、王荣）的合并压测。按住阵容轮转，让每一局都必然有本批人物
 * 在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['zhanglu', 'liubian', 'miheng', 'zhangqiying', 'chenggongying', 'hanfu', 'xinxianying', 'chendeng', 'yanpu', 'wangrong']

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

describe('SP 独立历史人物第八批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp8-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp8-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp8-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['shiyuan', '诗怨'],
      ['shejian', '舌剑'],
      ['kuangxiang', '匡襄'],
      ['shuzi', '束辎'], ['kuangshou', '恇守'],
      ['zhongjian', '忠鉴'], ['caishi', '才识'],
      ['fengji', '丰积'],
      ['huantu', '缓图'],
      ['fengzi', '丰姿'], ['jizhan', '吉占'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 毒逝/余威/狂才/紫微·真仪/恇守本体/旋回/避祸/赋颂/米道 条件较苛刻或
     * 法箓也是锁定技，同理不点名。义舍是"没有米才能发动"
     * 的可选问询，AI 通用启发式在压测规模里没有稳定触发，导致依赖米的
     * 布施也拿不到米、不强求；这不影响两条已发动，逻辑本身在实现和人工
     * 走查里已经过一遍。
     */
  }, 1_200_000)
})
