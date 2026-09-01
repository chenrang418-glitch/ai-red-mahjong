import { describe, expect, it } from 'vitest'
import { describeEvent } from '@/sanguosha/engine/log'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { GameEvent } from '@/sanguosha/engine/events'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

function startedGame(seed = 'log-test'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = 'guanyu'
  })
  game.start()
  return game
}

function event(name: GameEvent['name'], payload: Record<string, unknown>, extra: Partial<GameEvent> = {}): GameEvent {
  return { id: 'e1', seq: 1, name, payload, ...extra }
}

describe('战报只描述公开信息', () => {
  it('别人摸到的牌不写牌名，自己的写', () => {
    const game = startedGame()
    const cardId = game.state.players[1].zones.hand[0]
    const name = game.state.cards[cardId].name

    const forOther = describeEvent(game.state, event('GainCard', { playerId: 'p1', cardIds: [cardId], reason: 'draw' }), 'p0')
    expect(forOther).toBe('玩家1 获得 1 张牌（摸牌）')
    expect(forOther).not.toContain(name)
    expect(forOther).not.toContain(cardId)

    const forSelf = describeEvent(game.state, event('GainCard', { playerId: 'p0', cardIds: [cardId] }), 'p0')
    expect(forSelf).toContain(name)
  })

  it('回合、伤害、回复、濒死都有可读描述', () => {
    const game = startedGame()
    expect(describeEvent(game.state, event('TurnStart', { playerId: 'p2' }), 'p0')).toContain('玩家2')
    expect(describeEvent(game.state, event('Damaged', { amount: 2 }, { sourceId: 'p1', targetId: 'p3', damageNature: 'fire' }), 'p0'))
      .toBe('玩家1 对 玩家3 造成 2 点火焰伤害')
    expect(describeEvent(game.state, event('Recover', { playerId: 'p0', amount: 1 }), 'p0')).toContain('回复 1 点体力')
    expect(describeEvent(game.state, event('EnterDying', { playerId: 'p4' }), 'p0')).toContain('濒死')
  })

  it('死亡时公开身份是规则允许的', () => {
    const game = startedGame()
    const text = describeEvent(game.state, event('Death', { playerId: 'p1', identity: 'rebel' }), 'p0')
    expect(text).toBe('玩家1 阵亡（反贼）')
  })

  it('判定牌是翻开的公开信息，可以写出来', () => {
    const game = startedGame()
    const judgeCardId = game.state.zones.drawPile[0]
    const text = describeEvent(game.state, event('JudgeResult', { playerId: 'p1', judgeCardId, reason: '八卦阵' }), 'p0')
    expect(text).toContain(game.state.cards[judgeCardId].name)
    expect(text).toContain('八卦阵')
  })

  it('未登记的事件不产生噪音', () => {
    const game = startedGame()
    expect(describeEvent(game.state, event('PhaseStart', { phase: 'draw' }), 'p0')).toBeNull()
    expect(describeEvent(game.state, event('BeforeDamage', {}), 'p0')).toBeNull()
  })

  it('实际对局中，别人手牌的真实 id 不会进入任何一条战报', () => {
    const game = startedGame('log-privacy')
    const entries: string[] = []
    for (const name of ['TurnStart', 'CardUsed', 'CardResponded', 'Damaged', 'GainCard', 'Death'] as const) {
      game.events.on(name, (context) => {
        const text = describeEvent(game.state, context.event, 'p0')
        if (text) entries.push(text)
      })
    }
    // 推几个阶段，让事件真的发生
    for (let index = 0; index < 6; index += 1) {
      if (game.state.pendingRequests.length > 0) break
      game.advancePhase()
    }
    const serialized = entries.join('\n')
    for (const player of game.state.players) {
      if (player.id === 'p0') continue
      for (const cardId of player.zones.hand) expect(serialized).not.toContain(cardId)
    }
    expect(entries.length).toBeGreaterThan(0)
  })
})
