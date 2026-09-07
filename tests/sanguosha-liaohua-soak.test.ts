import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 廖化定向压测。
 *
 * 【当先】改的是**回合调度**，不是一个孤立的技能：额外阶段和跳过、
 * 阶段替换、额外回合、翻面、阵亡收束全都挤在同一条路径上。
 * 所以这里刻意让他和会动阶段的角色同桌，而不是只跑纯随机阵容。
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

describe('廖化压测', () => {
  it('五人局 120 局全部正常结束', () => {
    for (const result of run(120, 5, 'liaohua', ['liaohua'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('和会动阶段的角色同桌各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 巧变跳阶段 / 放权让渡回合 × 当先的额外阶段
      ['qiaobian-fangquan', ['liaohua', 'zhanghe', 'liushan', 'zhangfei']],
      // 持纲把判定位跑成出牌阶段：一个回合里出现三个出牌阶段
      ['chigang', ['liaohua', 'shen-sunquan', 'guanyu', 'zhaoyun']],
      // 涅槃 / 不屈：濒死窗口上再叠一个限定技
      ['dying', ['liaohua', 'pangtong', 'zhoutai', 'huangzhong']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of run(40, cast.length + 1, `liaohua-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('当先和伏枥确实被跑到了', () => {
    const results = run(120, 6, 'liaohua-cover', ['liaohua'])
    expect(total(results, 'skill:dangxian'), '当先是锁定技，每个廖化回合都该发动').toBeGreaterThan(0)
    expect(total(results, 'skill:fuli'), '伏枥至少被发动过一次').toBeGreaterThan(0)
  }, 300_000)
})
