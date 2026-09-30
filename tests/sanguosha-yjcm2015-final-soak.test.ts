import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 一将成名 2014 收官（蔡夫人、沮授）+ 一将成名 2015 全部 11 人的合并压测。
 *
 * 通用压测从全部武将里随机取阵容，新武将被抽中的概率很低——按住阵容轮转，
 * 让每一局都必然有本批人物在场，再按计数器确认技能真的被发动过。
 * 主公技（曹叡【兴衰】、刘谌【勤王】、孙休【诏缚】）和纯被动/锁定技
 * （曹休【千驹】、张嶷【矢志】）不发 `SkillActivated`，覆盖由本文件的
 * 「正常结束」压测和此前的 typecheck/build 盯，不在计数器清单里。
 */

const ALL_THIRTEEN = [
  'caifuren', 'jushou',
  'caorui', 'caoxiu', 'zhongyao', 'liuchen', 'xiahoushi', 'zhangni',
  'sunxiu', 'zhuzhi', 'quanzong', 'gongsunyuan', 'guotufengji',
]

function rotate(offset: number, size: number): string[] {
  return Array.from({ length: size }, (_, index) => ALL_THIRTEEN[(offset + index) % ALL_THIRTEEN.length])
}

function runBatch(count: number, playerCount: number, prefix: string, cast: string[]) {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'sunshangxiang', 'caopi', 'zhenji']
  const characterIds = [...cast]
  while (characterIds.length < playerCount) characterIds.push(filler[characterIds.length - cast.length])
  const results = []
  for (let index = 0; index < count; index += 1) {
    results.push(runSoakGame({
      seed: `${prefix}-${playerCount}-${index}`,
      playerCount,
      characterIds: characterIds.slice(0, playerCount),
    }))
  }
  return results
}

const total = (results: ReturnType<typeof runBatch>, key: string): number =>
  results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)

describe('一将成名 2014 收官 + 2015 全 13 人合并压测', () => {
  it('曹叡【兴衰】的惩罚伤害等待先前濒死与伤害链完全结束', () => {
    const [result] = runBatch(1, 8, 'yjcm15final-r53-8', rotate(53, 8))
    expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
  }, 60_000)

  it('八人局 80 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 80; index += 1) {
      const [result] = runBatch(1, 8, `yjcm15final-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 60 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 60; index += 1) {
      const [result] = runBatch(1, 5, `yjcm15final-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('主动/触发技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 100; index += 1) {
      results.push(...runBatch(1, 8, `yjcm15final-cov${index}`, rotate(index, 8)))
    }
    for (const [skillId, name] of [
      ['qieting', '窃听'], ['xianzhou', '献州'],
      ['jianying', '渐营'], ['shibei', '矢北'],
      ['huituo', '恢拓'], ['mingjian', '明鉴'],
      ['qingxi', '倾袭'],
      ['huomo', '活墨'], ['zuoding', '佐定'],
      ['liuchen-zhanjue', '战绝'],
      ['qiaoshi', '樵拾'], ['yanyu', '燕语'],
      ['wurong', '怃戎'],
      ['yanzhu', '宴诛'], ['xingxue', '兴学'],
      ['anguo', '安国'],
      ['yaoming', '邀名'],
      ['huaiyi', '怀异'],
      ['jigong', '急攻'], ['shifei', '饰非'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
  }, 900_000)
})
