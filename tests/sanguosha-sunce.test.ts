import { describe, expect, it } from 'vitest'
import { getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HUNZI, JIANG, ZHIBA } from '@/sanguosha/data/characters/mountain-sunce'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

function gameWith(characters = ['sunce', 'zhouyu', 'zhangfei', 'zhangfei', 'zhangfei']): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: characters.map((_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed: 'sunce', setup })
  const identities: Identity[] = ['lord', 'loyalist', 'rebel', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = characters[index]
    player.maxHp = (getCharacter(characters[index])?.maxHp ?? 4) + (index === 0 ? 1 : 0)
    player.hp = player.maxHp
  })
  game.start()
  while (game.state.pendingRequests.length) answer(game, { optionId: 'no' })
  game.state.currentPlayerId = 'p1'
  game.state.phase = 'play'
  return game
}

function answer(game: SanguoshaGame, payload: Record<string, unknown>): void {
  const request = game.state.pendingRequests[0]
  if (!request) throw new Error('没有请求')
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const player = game.state.players.find((candidate) => candidate.id === playerId)!
  game.state.zones.discardPile.push(...player.zones.hand)
  player.zones.hand = []
}

function giveRank(game: SanguoshaGame, playerId: PlayerId, rank: number): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].rank === rank)!
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function zhibaAction(game: SanguoshaGame) {
  return game.legalActions('p1').find((action) => action.skillId === ZHIBA)
}

function answerPindian(game: SanguoshaGame, playerId: PlayerId, cardId: string): void {
  const request = game.state.pendingRequests.find((candidate) => candidate.playerId === playerId)!
  game.respond({ requestId: request.id, playerId, payload: { cardIds: [cardId] } })
}

describe('山包孙策', () => {
  it('注册经典基础信息与三项开局技能', () => {
    const character = getCharacter('sunce')!
    expect([character.kingdom, character.gender, character.maxHp, character.pack]).toEqual(['wu', 'male', 4, 'mountain'])
    expect(skillIdsOf('sunce')).toEqual([JIANG, HUNZI, ZHIBA])
  })

  it('使用决斗与红杀、成为其目标时各产生一次可放弃的激昂', () => {
    const game = gameWith()
    const redSlash = Object.values(game.state.cards).find((card) => card.name === '杀' && card.color === 'red')!
    game.dispatch('TargetSpecified', { cardId: redSlash.id, cardName: '杀', targetIds: ['p1', 'p2'] }, { sourceId: 'p0', cardIds: [redSlash.id] })
    ;(game as unknown as { settle(): void }).settle()
    expect(game.state.pendingRequests).toHaveLength(1)
    answer(game, { optionId: 'no' })
    const before = game.state.players[0].zones.hand.length
    game.dispatch('TargetConfirmed', { cardId: redSlash.id, cardName: '杀', targetId: 'p0' }, { sourceId: 'p1', targetId: 'p0', cardIds: [redSlash.id] })
    ;(game as unknown as { settle(): void }).settle()
    answer(game, { optionId: 'yes' })
    expect(game.state.players[0].zones.hand.length).toBe(before + 1)
  })

  it('黑杀不触发激昂', () => {
    const game = gameWith()
    const blackSlash = Object.values(game.state.cards).find((card) => card.name === '杀' && card.color === 'black')!
    game.dispatch('TargetSpecified', { cardId: blackSlash.id, cardName: '杀', targetIds: ['p1'] }, { sourceId: 'p0' })
    ;(game as unknown as { settle(): void }).settle()
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('决斗和多目标红杀都按一次用牌事件只产生一次激昂', () => {
    const duel = gameWith()
    duel.dispatch('TargetSpecified', { cardName: '决斗', targetIds: ['p1', 'p2'] }, { sourceId: 'p0' }); (duel as unknown as { settle(): void }).settle()
    expect(duel.state.pendingRequests).toHaveLength(1)
    answer(duel, { optionId: 'no' })

    const slash = gameWith()
    const red = Object.values(slash.state.cards).find((card) => card.name === '杀' && card.color === 'red')!
    slash.dispatch('TargetSpecified', { cardId: red.id, cardName: '杀', targetIds: ['p1', 'p2', 'p3'] }, { sourceId: 'p0', cardIds: [red.id] }); (slash as unknown as { settle(): void }).settle()
    expect(slash.state.pendingRequests).toHaveLength(1)
  })

  it('1血准备阶段强制魂姿且只觉醒一次，复用英姿与英魂', () => {
    const game = gameWith()
    const sunce = game.state.players[0]
    sunce.hp = 1
    const oldMax = sunce.maxHp
    game.dispatch('PhaseStart', { playerId: 'p0', phase: 'prepare' })
    expect(sunce.maxHp).toBe(oldMax - 1)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).toEqual(expect.arrayContaining(['yingzi', 'yinghun']))
    game.dispatch('PhaseStart', { playerId: 'p0', phase: 'prepare' })
    expect(sunce.maxHp).toBe(oldMax - 1)
  })

  it('非主公、非吴势力或任一方无手牌时没有制霸动作', () => {
    const game = gameWith()
    expect(zhibaAction(game)).toBeTruthy()
    game.state.players[0].identity = 'rebel'
    expect(zhibaAction(game)).toBeUndefined()
    game.state.players[0].identity = 'lord'
    game.state.players[1].characterId = 'zhangfei'
    expect(zhibaAction(game)).toBeUndefined()
    game.state.players[1].characterId = 'zhouyu'
    clearHand(game, 'p0')
    expect(zhibaAction(game)).toBeUndefined()
  })

  it('魂姿前必须接受；主公赢后可获得两张真实拼点牌', () => {
    const game = gameWith()
    clearHand(game, 'p0'); clearHand(game, 'p1')
    const lordCard = giveRank(game, 'p0', 13)
    const actorCard = giveRank(game, 'p1', 1)
    game.act('p1', zhibaAction(game)!.id)
    expect(game.state.pendingRequests.every((request) => request.kind === 'choose-cards')).toBe(true)
    answerPindian(game, 'p1', actorCard)
    answerPindian(game, 'p0', lordCard)
    expect(game.state.pendingRequests[0]?.playerId).toBe('p0')
    answer(game, { optionId: 'yes' })
    expect(game.state.players[0].zones.hand).toEqual(expect.arrayContaining([lordCard, actorCard]))
    expect(game.state.pindianSettlement).toBeNull()
    assertGameInvariants(game.state)
  })

  it('魂姿后可以拒绝且拒绝仍消耗挑战者本阶段次数', () => {
    const game = gameWith()
    game.state.players[0].awakenedSkills.push(HUNZI)
    game.act('p1', zhibaAction(game)!.id)
    expect(game.state.pendingRequests[0]?.playerId).toBe('p0')
    answer(game, { optionId: 'no' })
    expect(zhibaAction(game)).toBeUndefined()
    expect(game.state.pindian).toBeNull()
  })

  it('挑战者获胜时拼点牌正常弃置，平局按没赢处理', () => {
    const game = gameWith()
    clearHand(game, 'p0'); clearHand(game, 'p1')
    const lordCard = giveRank(game, 'p0', 1)
    const actorCard = giveRank(game, 'p1', 13)
    game.act('p1', zhibaAction(game)!.id)
    answerPindian(game, 'p1', actorCard); answerPindian(game, 'p0', lordCard)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([lordCard, actorCard]))
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('制霸待收牌窗口可序列化恢复，放弃后两张实体牌才进入弃牌堆', () => {
    const game = gameWith()
    clearHand(game, 'p0'); clearHand(game, 'p1')
    const lordCard = giveRank(game, 'p0', 13); const actorCard = giveRank(game, 'p1', 1)
    game.act('p1', zhibaAction(game)!.id)
    answerPindian(game, 'p1', actorCard); answerPindian(game, 'p0', lordCard)
    expect(game.state.pindianSettlement?.cardIds).toEqual(expect.arrayContaining([lordCard, actorCard]))
    const restored = SanguoshaGame.restore(game.serialize())
    answer(restored, { optionId: 'no' })
    expect(restored.state.pindianSettlement).toBeNull()
    expect(restored.state.zones.discardPile).toEqual(expect.arrayContaining([lordCard, actorCard]))
    assertGameInvariants(restored.state)
  })
})
