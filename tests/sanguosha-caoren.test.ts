import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { decideResponse } from '@/sanguosha/ai'
import { GameRng } from '@/sanguosha/engine/rng'
import { flipCharacter, isFaceDown } from '@/sanguosha/engine/character-state'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 曹仁【据守】与通用的「翻面」机制。
 *
 * 据守本身很简单，真正要钉住的是翻面：它是一条**公共角色状态**，
 * 不是曹仁的私有开关。所以这里既测据守，也单独测「任何角色被翻面之后
 * 会跳过整个回合、并翻回正面」——以后神曹操、放逐都走同一条路。
 */

function gameWith(characterIds: string[], seed = 'caoren'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index]
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

/**
 * 随手回应一个请求：能放弃就放弃，必须选够数量的（弃牌阶段）就挑前几张。
 *
 * 一律用 `{ optionId:'no', cardIds:[] }` 这种大杂烩 payload 是不行的——
 * 弃牌阶段的 min 大于 0，会直接被校验打回「卡牌选择非法」。
 */
function answerAnything(game: SanguoshaGame): void {
  const request = game.state.pendingRequests[0]
  if (!request) return
  const payload: Record<string, unknown> = { optionId: 'no', actionId: 'respond-pass', targetIds: [] }
  if (request.kind === 'choose-cards') {
    payload.cardIds = [...request.cardIds, ...request.hiddenCardSlots].slice(0, request.min)
  }
  if (request.kind === 'choose-targets') payload.targetIds = request.candidateIds.slice(0, request.min)
  if (request.kind === 'choose-general') payload.characterId = request.candidates[0]
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

/** 把回合推进到某人的结束阶段，途中的请求一律放弃。 */
function toFinishPhase(game: SanguoshaGame, playerId: PlayerId): void {
  for (let guard = 0; guard < 60; guard += 1) {
    if (game.state.currentPlayerId === playerId && game.state.phase === 'finish') return
    if (pending(game)) { answerAnything(game); continue }
    game.advancePhase()
  }
  throw new Error('没能推进到结束阶段')
}

/** 一路推进直到轮到某人的回合开始（不处理请求以外的事）。 */
function advanceToTurnOf(game: SanguoshaGame, playerId: PlayerId): void {
  for (let guard = 0; guard < 200; guard += 1) {
    if (game.state.currentPlayerId === playerId && game.state.turnNumber > 1) return
    if (pending(game)) { answerAnything(game); continue }
    game.advancePhase()
  }
  throw new Error('没能推进到目标角色的回合')
}

const FILLER = ['caoren', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('曹仁【据守】', () => {
  it('结束阶段发问，摸三张牌并翻面', () => {
    const game = gameWith(FILLER)
    toFinishPhase(game, 'p0')
    const ask = pending(game)
    expect(ask?.prompt, '结束阶段应当问据守').toContain('据守')
    expect(ask.playerId).toBe('p0')

    const handBefore = game.state.players[0].zones.hand.length
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(game.state.players[0].zones.hand.length, '摸三张').toBe(handBefore + 3)
    expect(isFaceDown(game.state, 'p0'), '摸完必须翻面').toBe(true)
    assertGameInvariants(game.state)
  })

  it('可以放弃：不摸牌也不翻面', () => {
    const game = gameWith(FILLER)
    toFinishPhase(game, 'p0')
    const ask = pending(game)
    const handBefore = game.state.players[0].zones.hand.length
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })

    expect(game.state.players[0].zones.hand.length).toBe(handBefore)
    expect(isFaceDown(game.state, 'p0')).toBe(false)
    assertGameInvariants(game.state)
  })

  it('没有据守的角色，结束阶段不会被问', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    toFinishPhase(game, 'p0')
    expect(pending(game)?.prompt ?? '').not.toContain('据守')
  })

  it('牌堆见底时也不会崩，摸到多少算多少', () => {
    const game = gameWith(FILLER)
    toFinishPhase(game, 'p0')
    // 只留一张可摸的牌，弃牌堆也清空
    const rest = game.state.zones.drawPile.slice(1)
    game.state.zones.drawPile = game.state.zones.drawPile.slice(0, 1)
    game.state.zones.discardPile.push(...rest)
    const handBefore = game.state.players[0].zones.hand.length

    game.respond({ requestId: pending(game)!.id, playerId: 'p0', payload: { optionId: 'yes' } })

    // 弃牌堆会被洗回牌堆，所以三张仍然摸得满
    expect(game.state.players[0].zones.hand.length).toBe(handBefore + 3)
    expect(isFaceDown(game.state, 'p0')).toBe(true)
    assertGameInvariants(game.state)
  })
})

describe('翻面是公共机制，不是曹仁的私有开关', () => {
  it('背面朝上的角色轮到回合时翻回正面，并跳过整个回合', () => {
    // 用没有翻面技能的张飞，证明这条规则不依赖曹仁
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const victim = game.state.players.find((player) => player.id !== game.state.currentPlayerId)!
    flipCharacter(game, victim.id, '测试', true)
    expect(isFaceDown(game.state, victim.id)).toBe(true)

    const handBefore = victim.zones.hand.length
    advanceToTurnOf(game, victim.id)

    expect(isFaceDown(game.state, victim.id), '回合开始就翻回正面').toBe(false)
    expect(game.state.skippedPhases, '整个回合的阶段都被跳过').toContain('draw')
    expect(game.state.skippedPhases).toContain('play')
    expect(victim.zones.hand.length, '被跳过的回合不摸牌').toBe(handBefore)
    assertGameInvariants(game.state)
  })

  it('跳过之后牌局照常交给下一名角色', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const victim = game.state.players.find((player) => player.id !== game.state.currentPlayerId)!
    flipCharacter(game, victim.id, '测试', true)
    advanceToTurnOf(game, victim.id)

    const turnBefore = game.state.turnNumber
    game.advancePhase()
    expect(game.state.currentPlayerId, '应当换人').not.toBe(victim.id)
    expect(game.state.turnNumber).toBe(turnBefore + 1)
    assertGameInvariants(game.state)
  })

  it('只跳过一个回合，下一轮恢复正常', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const victim = game.state.players.find((player) => player.id !== game.state.currentPlayerId)!
    flipCharacter(game, victim.id, '测试', true)
    advanceToTurnOf(game, victim.id)
    game.advancePhase()

    // 再转一圈回到他
    const handBefore = victim.zones.hand.length
    for (let guard = 0; guard < 200; guard += 1) {
      if (game.state.currentPlayerId === victim.id && game.state.phase === 'draw') break
      if (pending(game)) { answerAnything(game); continue }
      game.advancePhase()
    }
    game.advancePhase()
    expect(victim.zones.hand.length, '这一回合应当正常摸牌').toBeGreaterThan(handBefore)
    assertGameInvariants(game.state)
  })

  it('重复翻到同一面不产生事件', () => {
    const game = gameWith(FILLER)
    const seen: unknown[] = []
    game.events.on('CharacterFlip', (context) => { seen.push(context.event.payload) })
    flipCharacter(game, 'p1', '测试', true)
    flipCharacter(game, 'p1', '测试', true)
    expect(seen, '第二次是无效操作，不该再发一条').toHaveLength(1)
  })

  it('死亡角色不能被翻面', () => {
    const game = gameWith(FILLER)
    game.state.players[1].alive = false
    game.state.players[1].identityRevealed = true
    flipCharacter(game, 'p1', '测试', true)
    expect(isFaceDown(game.state, 'p1')).toBe(false)
  })

  it('翻面状态能过 JSON——联机断线重连要靠它', () => {
    const game = gameWith(FILLER)
    flipCharacter(game, 'p1', '测试', true)
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.state)))
    expect(isFaceDown(restored.state, 'p1')).toBe(true)
    assertGameInvariants(restored.state)
  })

  it('翻面状态对所有人可见——这是公开信息', () => {
    const game = gameWith(FILLER)
    flipCharacter(game, 'p1', '测试', true)
    const view = game.viewFor('p2')
    expect(view.players.find((player) => player.id === 'p1')?.faceDown).toBe(true)
  })
})

describe('据守的 AI 取舍', () => {
  function ask(game: SanguoshaGame) {
    toFinishPhase(game, 'p0')
    return pending(game)!
  }
  function choose(game: SanguoshaGame, request: ReturnType<typeof ask>): string {
    const response = decideResponse(
      { view: game.viewFor('p0'), difficulty: 'normal', rng: new GameRng('ai'), suspicion: {} },
      request,
    )
    return (response.payload as { optionId: string }).optionId
  }

  it('手牌见底时会发动', () => {
    const game = gameWith(FILLER)
    const request = ask(game)
    const owner = game.state.players[0]
    game.state.zones.discardPile.push(...owner.zones.hand.slice(1))
    owner.zones.hand = owner.zones.hand.slice(0, 1)
    expect(choose(game, request)).toBe('yes')
  })

  it('手牌宽裕又不缺血时不会白让一个回合', () => {
    const game = gameWith(FILLER)
    const request = ask(game)
    const owner = game.state.players[0]
    while (owner.zones.hand.length < 6) owner.zones.hand.push(game.state.zones.drawPile.shift()!)
    expect(choose(game, request), '别每回合无脑据守').toBe('no')
  })
})
