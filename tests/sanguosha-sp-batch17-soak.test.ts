import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * SP 独立历史人物第十七批（杜夫人、曹嵩、卞夫人、郭照、曹宪曹华、
 * 环淑君、潘淑、杜畿、赵俨、曹节）的合并压测。按住阵容轮转，让每一局都
 * 必然有本批人物在场，再按计数器确认技能真的被发动过。
 */

const ALL_TEN = ['dufuren', 'caosong', 'bianfuren', 'guozhao', 'caoxian_caohua', 'huanshujun', 'panshu', 'duji', 'zhaoyan', 'caojie']

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

describe('SP 独立历史人物第十七批合并压测', () => {
  it('八人局 30 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 30; index += 1) {
      const [result] = runBatch(1, 8, `sp17-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 20 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 20; index += 1) {
      const [result] = runBatch(1, 5, `sp17-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 80; index += 1) {
      results.push(...runBatch(1, 8, `sp17-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['yise', '异色'], ['shunshi', '顺世'],
      ['lilu', '礼赂'], ['yizheng', '翊正'],
      ['wanwei', '挽危'], ['yuejian', '约俭'],
      ['jiaoyu', '椒遇'], ['neixun', '内训'],
      ['huamu', '化木'],
      ['huanpei', '环佩'],
      ['weiyi', '威仪'], ['jinzhi', '锦织'],
      ['andong', '安东'], ['yingshi', '应势'],
      ['tongxie', '同协'],
      ['shouxi', '守玺'], ['huimin', '惠民'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
    /*
     * 曹宪曹华【前盟】是锁定技，只在化木/良缘改变灵杉玉树数量时被动
     * 触发，不单独点名（跟着化木/良缘一起被走查覆盖）；【良缘】需要先
     * 通过化木攒够灵杉/玉树，压缩规模的压测里未必攒得齐；【羁肆】是
     * 限定技且需要本局先实际发动过化木/良缘，同样不强行点名。
     * 环淑君【妙心】是锁定技被动跟着受伤触发，不单独点名。
     */
  }, 1_200_000)
})
