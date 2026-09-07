import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 马岱定向压测。
 *
 * 【潜袭】动的是**用牌合法性**：给别人挂一条颜色禁令。这类效果最容易
 * 把牌局逼进死角——被禁的人一张牌都用不出、AI 找不到合法动作、
 * 或者禁令漏清挂到下一个回合。所以这里刻意配上手牌少、
 * 以及依赖特定颜色出牌的角色。
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

describe('马岱压测', () => {
  it('五人局 120 局全部正常结束', () => {
    for (const result of run(120, 5, 'madai', ['madai'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 80 局全部正常结束', () => {
    for (const result of run(80, 8, 'madai', ['madai'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 武圣只吃红牌：被禁红色时他的转化会整片消失
      ['wusheng', ['madai', 'guanyu', 'zhangfei', 'zhaoyun']],
      // 气海也禁花色：两套用牌禁令叠在同一个人身上
      ['qihai', ['madai', 'shenhuangzhong', 'guanyu', 'huangzhong']],
      // 父魂的子牌同样要被禁令拦住
      ['fuhun', ['madai', 'guanxingzhangbao', 'zhaoyun', 'machao']],
      // 当先的额外出牌阶段里禁令照样生效
      ['dangxian', ['madai', 'liaohua', 'guanyu', 'huangzhong']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of run(40, cast.length + 1, `madai-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('潜袭确实被跑到了', () => {
    const results = run(120, 6, 'madai-cover', ['madai'])
    expect(total(results, 'skill:qianxi'), '潜袭至少被发动过一次').toBeGreaterThan(0)
  }, 300_000)
})
