import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 程普定向压测。
 *
 * 两个技能各自踩在一条危险路径上：【疠火】在结算收束之后让自己失去体力
 * （很容易把自己打进濒死、甚至在别人的濒死流程里再套一层），
 * 【醇醪】直接插在濒死救援的循环里。所以这里刻意配上会反复制造濒死的角色。
 */

function run(count: number, playerCount: number, prefix: string, cast: string[]) {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'sunshangxiang', 'caopi', 'zhenji']
  const characterIds = [...cast]
  while (characterIds.length < playerCount) characterIds.push(filler[characterIds.length - cast.length])
  const results = []
  for (let index = 0; index < count; index += 1) {
    results.push(runSoakGame({ seed: `${prefix}-${playerCount}-${index}`, playerCount, characterIds: characterIds.slice(0, playerCount) }))
  }
  return results
}

function total(results: ReturnType<typeof run>, key: string): number {
  return results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)
}

describe('程普压测', () => {
  it('五人局 120 局全部正常结束', () => {
    for (const result of run(120, 5, 'chengpu', ['chengpu'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 80 局全部正常结束', () => {
    for (const result of run(80, 8, 'chengpu', ['chengpu'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 禁酒：醇醪不该被它拦住，而且两者同桌不能把濒死流程卡死
      ['jinjiu', ['chengpu', 'gaoshun', 'zhangfei', 'zhaoyun']],
      // 涅槃、不屈也挂在濒死上：三个救援入口叠在同一个窗口里
      ['dying', ['chengpu', 'pangtong', 'zhoutai', 'huangzhong']],
      // 藤甲把普通【杀】的伤害改掉、对火【杀】反而加伤：疠火的代价判据要经得起
      ['tengjia', ['chengpu', 'menghuo', 'guanyu', 'machao']],
      // 绝情把伤害换成失去体力：那种情况下疠火不该失去体力
      ['jueqing', ['chengpu', 'zhangchunhua', 'zhaoyun', 'huangzhong']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of run(40, cast.length + 1, `chengpu-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('疠火和醇醪确实被跑到了', () => {
    const results = run(120, 6, 'chengpu-cover', ['chengpu'])
    expect(total(results, 'skill:lihuo'), '疠火至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:chunlao'), '醇醪至少被发动过一次').toBeGreaterThan(0)
  }, 300_000)
})
