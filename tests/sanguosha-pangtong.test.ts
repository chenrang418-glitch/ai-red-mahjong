import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'
import { moveCard, type ZoneRef } from '@/sanguosha/engine/zones'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
}

function gameWithPangtong(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = index === 0 ? 'pangtong' : 'zhangfei'
  })
  game.start()
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
  return game
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error(`找不到卡牌：${cardId}`)
}

function giveCard(game: SanguoshaGame, playerId: PlayerId, predicate: (cardId: string) => boolean): string {
  const cardId = Object.keys(game.state.cards).find((id) => predicate(id))
  if (!cardId) throw new Error('找不到测试牌')
  moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId })
  return cardId
}

describe('庞统', () => {
  it('连环可将梅花手牌当铁索连环使用或重铸，其他花色不能转化', () => {
    const game = gameWithPangtong('pangtong-lianhuan')
    for (const cardId of [...game.state.players[0].zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    const club = giveCard(game, 'p0', (id) => game.state.cards[id].suit === 'club' && game.state.cards[id].name !== '铁索连环')
    const heart = giveCard(game, 'p0', (id) => game.state.cards[id].suit === 'heart')
    const actions = game.legalActions('p0')

    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(club) && action.asCardName === '铁索连环')).toBe(true)
    expect(actions.some((action) => action.id === `play:recast:viewas:${club}`)).toBe(true)
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(heart) && action.asCardName === '铁索连环')).toBe(false)

    const handBefore = game.state.players[0].zones.hand.length
    game.act('p0', `play:recast:viewas:${club}`)
    expect(game.state.zones.discardPile).toContain(club)
    expect(game.state.players[0].zones.hand).toHaveLength(handBefore)
    assertGameInvariants(game.state)
  })

  it('涅槃弃置所有区域牌、重置横置翻面、摸三张并回复至三点，且限一次', () => {
    const game = gameWithPangtong('pangtong-niepan')
    const owner = game.state.players[0]
    const weapon = Object.values(game.state.cards).find((card) => card.equipmentSlot === 'weapon')!
    moveCard(game.state, weapon.id, locate(game.state, weapon.id), { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    const delayed = Object.values(game.state.cards).find((card) => card.name === '乐不思蜀')!
    moveCard(game.state, delayed.id, locate(game.state, delayed.id), { kind: 'judgingArea', playerId: 'p0' })
    owner.faceDown = true
    owner.chained = true
    owner.hp = 1

    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'normal' })
    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-option', playerId: 'p0' })
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'niepan-invoke' } })

    expect(owner).toMatchObject({ hp: 3, alive: true, faceDown: false, chained: false })
    expect(owner.zones.hand).toHaveLength(3)
    expect(owner.zones.equipment.weapon).toBeNull()
    expect(owner.zones.judgingArea).toEqual([])
    expect(owner.usedLimitedSkills).toContain('niepan')
    expect(game.state.dying).toBeNull()

    owner.hp = 1
    game.damage({ sourceId: 'p1', targetId: 'p0' })
    expect(game.state.pendingRequests.some((candidate) => candidate.kind === 'choose-option' && candidate.prompt.includes('涅槃'))).toBe(false)
    assertGameInvariants(game.state)
  })

  it('属性传导中发动涅槃后会继续结算剩余横置角色', () => {
    const game = gameWithPangtong('pangtong-niepan-chain-resume')
    const owner = game.state.players[0]
    const next = game.state.players[1]
    owner.hp = 1
    owner.chained = true
    next.chained = true
    const nextHp = next.hp

    game.damage({ sourceId: 'p2', targetId: 'p0', amount: 1, nature: 'fire', cardName: '火攻' })
    expect(game.state.damageChain?.remainingTargetIds).toContain('p1')
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'niepan-invoke' } })

    expect(owner.hp).toBe(3)
    expect(next.hp).toBe(nextHp - 1)
    expect(game.state.damageChain).toBeNull()
    expect(owner.chained).toBe(false)
    expect(next.chained).toBe(false)
    assertGameInvariants(game.state)
  })
})
