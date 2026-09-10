import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 步练师定向压测。
 *
 * 【安恤】动的是别人手牌之间的转移（获得来源、暗牌隐私），
 * 【追忆】挂在死亡管线上、而且是**死人**在做决定——
 * 这两条都最容易和别的「获得牌」「死亡后」技能撞车，所以刻意配上它们。
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

const total = (results: ReturnType<typeof run>, key: string): number =>
  results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)

describe('步练师压测', () => {
  it('五人局 120 局全部正常结束', () => {
    for (const result of run(120, 5, 'bulianshi', ['bulianshi'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 80 局全部正常结束', () => {
    for (const result of run(80, 8, 'bulianshi', ['bulianshi'])) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 恩怨按「从谁那里得到的」记账：安恤的转移必须记对来源
      ['fazheng', ['bulianshi', 'fazheng', 'zhangfei', 'zhaoyun']],
      // 行殇也挂在 Death 上：两个死亡后技能的先后
      ['caopi', ['bulianshi', 'caopi', 'guanyu', 'huangzhong']],
      // 挥泪同样是「自己死时」：两个 allowDeadOwner 撞在同一次死亡里
      ['masu', ['bulianshi', 'masu', 'zhaoyun', 'machao']],
      // 驭衡会把安恤 / 追忆随机发给别人：拥有者不是步练师时也要通用
      ['yuheng', ['bulianshi', 'shensunquan', 'zhangfei', 'guanyu']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of run(40, cast.length + 1, `bulianshi-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 300_000)

  it('安恤和追忆确实被跑到了', () => {
    const results = run(120, 6, 'bulianshi-cover', ['bulianshi'])
    expect(total(results, 'skill:anxu'), '安恤至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:zhuiyi'), '追忆至少被发动过一次').toBeGreaterThan(0)
  }, 300_000)
})
