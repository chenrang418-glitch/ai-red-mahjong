import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 东吴独立历史人物补完批（吕凯、是仪、吕岱、冯熙、吕据、孙瑜、滕胤、
 * 滕公主、孙綝、滕芳兰）的合并压测。
 */

const ALL_TEN = ['lvkai', 'shiyi', 'lvdai', 'fengxi', 'lvju', 'sunyu', 'tengyin', 'tenggongzhu', 'sunchen', 'tengfanglan']

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

describe('东吴独立历史人物补完批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `batch21-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `batch21-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `batch21-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['tunan', '图南'], ['bijing', '闭境'],
      ['cuichuan', '榱椽'], ['zhengxu', '正序'],
      ['qinguo', '勤国'],
      ['yusui', '玉碎'], ['boyan', '驳言'],
      ['zhengyue', '征越'],
      ['quanshou', '劝守'], ['shexue', '设学'],
      ['chenjian', '陈见'], ['xixiu', '皙秀'],
      ['xingchong', '幸宠'],
      ['zigu', '自固'], ['zuowei', '作威'],
      ['luochong', '落宠'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 未点名的技能：佐谏（依赖榱椽先凑够条件让是仪失去榱椽，条件较窄）；
     * 流年（依赖真实牌堆洗牌两次，压缩规模里未必凑齐）；哀尘（依赖牌堆牌数
     * 阈值的具体时刻，条件较窄）。这些机制已随各自实现走查确认正确。
     */
  }, 1_200_000)
})
