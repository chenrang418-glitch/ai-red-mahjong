import { describe, expect, it } from 'vitest'
import { emptySuspicion, hostility, observeEvent, PROTECTED } from '@/sanguosha/ai/belief'
import { runSoakBatch } from '@/sanguosha/ai/soak'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'
import type { PlayerView } from '@/sanguosha/engine/view'

/**
 * AI 的阵营判断。
 *
 * 最重要的一条：**AI 只能看 PlayerView**，未公开身份在那里就是 null。
 * 难度不能靠偷看身份来做，所以这里专门验证「看不到就是看不到」。
 */

function viewOf(viewerId: string, seed = 'belief'): { view: PlayerView; game: SanguoshaGame } {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = identities[index] === 'lord'
    player.characterId = 'machao'
  })
  game.start()
  return { view: game.viewFor(viewerId), game }
}

describe('AI 阵营判断', () => {
  it('PlayerView 里看不到别人的未公开身份', () => {
    const { view } = viewOf('p2')
    const others = view.players.filter((player) => player.id !== 'p2')
    // 主公开局公开，其余都必须是 null
    expect(others.filter((player) => player.identity !== null).map((player) => player.identity)).toEqual(['lord'])
    // 自己的身份自己看得到
    expect(view.players.find((player) => player.id === 'p2')!.identity).toBe('loyalist')
  })

  it('忠臣绝不把主公当目标，反贼把主公当首选', () => {
    const loyalist = viewOf('p2').view
    const rebel = viewOf('p1').view
    const blank = emptySuspicion(loyalist)

    expect(hostility(loyalist, blank, 'p0')).toBeLessThanOrEqual(PROTECTED)
    expect(hostility(rebel, blank, 'p0')).toBeGreaterThan(0)
    // 谁都不该把自己当目标
    expect(hostility(loyalist, blank, 'p2')).toBeLessThanOrEqual(PROTECTED)
  })

  it('忠臣对未知身份有温和的正向先验，否则开局根本没有目标', () => {
    const { view } = viewOf('p2')
    const blank = emptySuspicion(view)
    expect(hostility(view, blank, 'p1')).toBeGreaterThan(0)
  })

  it('内奸开局保护主公，主公快死时转而打反贼', () => {
    const { view, game } = viewOf('p4')
    const suspicion = emptySuspicion(view)
    expect(hostility(view, suspicion, 'p0')).toBeLessThanOrEqual(PROTECTED)

    game.state.players[0].hp = 2
    const lowView = game.viewFor('p4')
    suspicion.p1 = 4
    expect(hostility(lowView, suspicion, 'p1')).toBeGreaterThan(8)
  })

  it('observeEvent 真的会改变 suspicion——之前这套推断从没被调用过', () => {
    const { view } = viewOf('p2')
    const suspicion = emptySuspicion(view)

    // 打主公 → 更像反贼
    observeEvent(suspicion, view, { name: 'Damaged', sourceId: 'p1', targetId: 'p0', payload: { amount: 1 } })
    expect(suspicion.p1).toBeGreaterThan(0)

    // 给主公回血 → 更像忠臣
    observeEvent(suspicion, view, { name: 'Recover', sourceId: 'p3', targetId: 'p0', payload: { playerId: 'p0', amount: 1 } })
    expect(suspicion.p3).toBeLessThan(0)

    // 主公打了谁，谁就更像反贼
    observeEvent(suspicion, view, { name: 'Damaged', sourceId: 'p0', targetId: 'p4', payload: { amount: 1 } })
    expect(suspicion.p4).toBeGreaterThan(0)
  })

  it('五人局阵营胜率不再一边倒', () => {
    // 上限刻意留宽：这是防止回归的护栏，不是精调后的期望值。
    // 曾经反贼胜率高到 85%，原因是忠臣开局眼里没有任何敌人。
    const results = runSoakBatch(120, 5, 'balance')
    const wins = { lord: 0, rebel: 0, renegade: 0 } as Record<string, number>
    for (const result of results) {
      if (result.winningCamp) wins[result.winningCamp] = (wins[result.winningCamp] ?? 0) + 1
    }

    expect(results).toHaveLength(120)
    expect(wins.rebel / results.length).toBeLessThan(0.65)
    expect(wins.lord / results.length).toBeGreaterThan(0.2)
  }, 15_000)
})
