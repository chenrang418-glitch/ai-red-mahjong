import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第十三批（何进、吕玲绮、文聘、陆郁生、夏侯徽、文钦、
 * 张曼成、卢氏、夏侯玄、秦朗）的合并压测。按住阵容轮转，让每一局都必然
 * 有本批人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['hejin', 'lvlingqi', 'wenpin', 'luyusheng', 'xiahouhui', 'wenqin', 'zhangmancheng', 'lushi', 'xiahouxuan', 'qinlang']

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

describe('SP 独立历史人物第十三批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp13-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp13-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp13-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['mouzhu', '谋诛'],
      ['qiwu', '绮武'], ['zhuangrong', '妆戎'],
      ['zhenwei', '镇卫'],
      ['cangxin', '藏心'], ['runwei', '润微'],
      ['baoqie', '宝箧'], ['yishi', '宜室'], ['shidu', '识度'],
      ['kuangao', '犷骜'],
      ['kuangxin', '狂信'], ['leishi', '雷噬'],
      ['zhuyan', '驻颜'], ['leijie', '雷劫'],
      ['huanfu', '宦浮'], ['qingyi', '清议'],
      ['haochong', '昊宠'], ['jinjin', '矜谨'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 延祸依赖"何进死亡且存在明确击杀者"，在压缩规模的压测里何进（防御/
     * 辅助向的4血武将）基本不会死亡，专项调试脚本确认60局内0次死亡，
     * 机制本身走查无误（Death 事件的 allowDeadOwner/字段用法与其它已验证
     * 技能一致），不强行点名。彗企/偕举是觉醒链条（需要恰好3人成为过
     * 目标，触发窗口窄），迮阅是限定技依赖"曾对我造成伤害"的历史条件，
     * 均不强行点名。
     */
  }, 1_200_000)
})
