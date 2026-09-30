import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { drawCards } from '@/sanguosha/engine/draw'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { moveCard } from '@/sanguosha/engine/zones'

function newGame(seed: string) {
  return new SanguoshaGame({ seed, setup: {
    mode: 'identity', generalChoices: 1,
    players: ['p0', 'p1', 'p2', 'p3', 'p4'].map((id, index) => ({ id, nickname: `玩家${index}`, isHuman: true })),
  } })
}

/** Keep exactly these real cards in discard and place every other card in p1's hand. */
function stageReshuffle(game: SanguoshaGame, retainedCount = 40) {
  const retained = game.state.zones.drawPile.slice(0, retainedCount)
  for (const id of [...game.state.zones.drawPile]) {
    moveCard(game.state, id, { kind: 'drawPile' }, retained.includes(id)
      ? { kind: 'discardPile' }
      : { kind: 'hand', playerId: 'p1' })
  }
  assertGameInvariants(game.state)
}

function emptyDrawPileToDiscard(game: SanguoshaGame) {
  for (const id of [...game.state.zones.drawPile])
    moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'discardPile' })
  assertGameInvariants(game.state)
}

function startRecastWithDrawReplacement(seed: string) {
  const game = newGame(seed)
  const identities = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade'] as const
  game.state.players.forEach((player, index) => {
    player.characterId = 'zhangfei'
    player.identity = identities[index]!
  })
  game.start()
  game.state.phase = 'play'
  game.state.currentPlayerId = 'p0'
  game.state.normalTurnPlayerId = 'p0'

  const recastCard = game.state.zones.drawPile.find(id => game.state.cards[id]!.name === '铁索连环')!
  expect(recastCard).toBeDefined()
  moveCard(game.state, recastCard, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
  stageReshuffle(game)
  game.state.players[0]!.grantedSkills.push('zanrun-sunhong:b61')
  game.act('p0', `play:recast:${recastCard}`)
  expect(game.state.skillResolution?.skillId).toBe('zanrun-sunhong:b61')
  expect(game.state.drawOperationReplay).toBeDefined()

  const request = game.state.pendingRequests.at(-1)!
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  expect(game.state.drawOperationReplay).toBeUndefined()
  expect(game.state.skillResolution).toBeNull()
  assertGameInvariants(game.state)
  return game
}

describe('审计：drawCards旧/新签名共享局内RNG', () => {
  it('交错旧/新签名的重洗牌序与局内RNG快照一致', () => {
    const legacy = newGame('audit-draw-rng-interleave')
    const explicit = newGame('audit-draw-rng-interleave')
    stageReshuffle(legacy)
    stageReshuffle(explicit)

    const firstLegacy = drawCards(legacy.state, 'p0', 4)
    const firstExplicit = drawCards(explicit.state, 'p0', 4)
    expect(firstLegacy).toEqual(firstExplicit)
    expect(legacy.rng.snapshot()).toBe(explicit.rng.snapshot())
    expect(legacy.state.rngState).toBe(legacy.rng.snapshot())

    emptyDrawPileToDiscard(legacy)
    emptyDrawPileToDiscard(explicit)
    const secondLegacy = drawCards(legacy.state, legacy.rng, 'p0', 4)
    const secondExplicit = drawCards(explicit.state, 'p0', 4)

    expect(secondLegacy).toEqual(secondExplicit)
    expect(legacy.rng.snapshot()).toBe(explicit.rng.snapshot())
    expect(legacy.state.zones.drawPile).toEqual(explicit.state.zones.drawPile)
    assertGameInvariants(legacy.state)
    assertGameInvariants(explicit.state)
  })

  it('旧签名摸牌后保存恢复，后续牌序与显式调用分支一致', () => {
    const game = newGame('audit-draw-rng-restore')
    stageReshuffle(game)
    const first = drawCards(game.state, 'p0', 4)
    expect(game.state.rngState).toBe(game.rng.snapshot())
    const restored = SanguoshaGame.restore(game.serialize())

    emptyDrawPileToDiscard(game)
    emptyDrawPileToDiscard(restored)
    const nextLegacy = drawCards(game.state, 'p0', 4)
    const nextRestored = drawCards(restored.state, restored.rng, 'p0', 4)
    expect(nextLegacy).toEqual(nextRestored)
    expect(game.rng.snapshot()).toBe(restored.rng.snapshot())
    expect(game.state.zones.drawPile).toEqual(restored.state.zones.drawPile)
    assertGameInvariants(game.state)
    assertGameInvariants(restored.state)
    expect(first).toHaveLength(4)
  })

  it('谮润拒绝触发真实DrawAttempt回放后，replaceState绑定的新RNG继续旧签名流', () => {
    const game = startRecastWithDrawReplacement('audit-draw-rng-replay-replace-state')
    const restoredControl = SanguoshaGame.restore(game.serialize())

    // The root operation has been replayed after the replacement choice and the game
    // state was restored in place. Force the next old-signature call to reshuffle.
    emptyDrawPileToDiscard(game)
    emptyDrawPileToDiscard(restoredControl)
    const oldSignatureCards = drawCards(game.state, 'p0', 5)
    const explicitCards = drawCards(restoredControl.state, restoredControl.rng, 'p0', 5)

    expect(oldSignatureCards).toEqual(explicitCards)
    expect(game.rng.snapshot()).toBe(restoredControl.rng.snapshot())
    expect(game.state.rngState).toBe(game.rng.snapshot())
    expect(game.state.zones.drawPile).toEqual(restoredControl.state.zones.drawPile)
    assertGameInvariants(game.state)
    assertGameInvariants(restoredControl.state)
  })
})
