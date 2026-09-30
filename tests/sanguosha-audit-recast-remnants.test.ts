import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { moveCard } from '@/sanguosha/engine/zones'
import type { GameEvent } from '@/sanguosha/engine/events'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

function createGame(seed: string) {
  return new SanguoshaGame({ seed, setup: {
    mode: 'identity', generalChoices: 1,
    players: ['p0', 'p1', 'p2', 'p3', 'p4'].map((id, index) => ({ id, nickname: `玩家${index}`, isHuman: true })),
  } })
}

function huiyunGame(seed: string, cardCount: number, emptyPile = false, preferredCardName?: string) {
  const game = createGame(seed)
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players[0]!.characterId = 'huban'
  game.state.players[1]!.characterId = 'zhangfei'
  game.state.currentPlayerId = 'p0'
  game.state.normalTurnPlayerId = 'p0'
  game.state.phase = 'play'
  const preferred = preferredCardName
    ? game.state.zones.drawPile.find(id => game.state.cards[id]?.name === preferredCardName)
    : undefined
  expect(preferredCardName ? preferred : true).toBeTruthy()
  const cards = [...(preferred ? [preferred] : []), ...game.state.zones.drawPile.filter(id => id !== preferred).slice(0, cardCount - (preferred ? 1 : 0))]
  expect(cards).toHaveLength(cardCount)
  for (const id of cards) moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
  if (emptyPile) {
    for (const id of [...game.state.zones.drawPile])
      moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'discardPile' })
  }
  assertGameInvariants(game.state)
  return { game, cards }
}

function resolveHuiyun(game: SanguoshaGame, optionId: '1' | '2', shownCardId: string) {
  const runtime = getSkillRuntime('huiyun-followup')!
  const resolution = { skillId: 'huiyun', ownerId: 'p0', step: 'offer', data: { targetId: 'p1', shownCardId } }
  const target = game.state.players.find(player => player.id === 'p1')!
  const handBefore = [...target.zones.hand]
  const costIds = optionId === '1' ? handBefore : handBefore.filter(id => id === shownCardId)
  const drawCount = costIds.length
  expect(drawCount).toBeGreaterThan(0)
  const order: string[] = []
  const gainEvents: GameEvent[] = []
  game.events.on('CardZoneMoved', context => {
    if (context.event.payload.fromKind === 'hand' && context.event.payload.fromPlayerId === 'p1'
      && context.event.payload.toKind === 'discardPile') order.push(`cost:${context.event.payload.cardId}`)
  })
  game.events.on('LoseCard', context => {
    const payload = context.event.payload
    if (payload.playerId === 'p1' && payload.reason === 'huiyun') order.push('lose')
  })
  game.events.on('DrawAttempt', context => {
    if (context.event.payload.playerId === 'p1') order.push(`attempt:${context.event.payload.count}`)
  })
  game.events.on('GainCard', context => {
    if (context.event.payload.playerId === 'p1') {
      order.push('gain')
      gainEvents.push(context.event)
    }
  })
  runtime.resume!(game as never, 'p0', resolution as never, { payload: { optionId } } as never)
  expect(game.state.players.find(player => player.id === 'p1')!.zones.hand).toHaveLength(handBefore.length - costIds.length + drawCount)
  expect(gainEvents).toHaveLength(1)
  expect(gainEvents[0]!.payload).toMatchObject({ playerId: 'p1', reason: 'huiyun', isDraw: true })
  expect(gainEvents[0]!.cardIds).toHaveLength(drawCount)
  expect(gainEvents[0]!.targetId).toBe('p1')
  expect(order.indexOf('lose')).toBeGreaterThan(order.findIndex(item => item.startsWith('cost:')))
  expect(order.indexOf('lose')).toBeLessThan(order.indexOf(`attempt:${drawCount}`))
  expect(order.indexOf(`attempt:${drawCount}`)).toBeLessThan(order.indexOf('gain'))
  assertGameInvariants(game.state)
}

function lianzhuYang(seed: string, emptyPile = false, replacement = false) {
  const game = createGame(seed)
  game.state.status = 'playing'
  game.state.pendingRequests = []
  const [owner, actor] = game.state.players
  owner!.characterId = 'clan-wukuang-b67'
  actor!.characterId = 'clan-wangchang-b67'
  game.state.currentPlayerId = actor!.id
  game.state.phase = 'play'
  const selected = game.state.zones.drawPile.slice(0, 2)
  expect(selected).toHaveLength(2)
  moveCard(game.state, selected[0]!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
  moveCard(game.state, selected[1]!, { kind: 'drawPile' }, { kind: 'hand', playerId: actor!.id })
  if (emptyPile) {
    for (const id of [...game.state.zones.drawPile])
      moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'discardPile' })
  }
  if (replacement) actor!.grantedSkills.push('zanrun-sunhong:b61')
  assertGameInvariants(game.state)
  const action = game.legalActions(actor!.id).find(candidate => candidate.id === 'skill:lianzhu-clan-wukuang-b67')
  expect(action).toBeDefined()
  game.act(actor!.id, action!.id)
  const targetRequest = game.state.pendingRequests.at(-1)!
  if (targetRequest.kind !== 'choose-cards') throw new Error('联诛阳应先选择当前角色重铸牌')
  game.respond({ requestId: targetRequest.id, playerId: actor!.id, payload: { cardIds: [selected[1]!] } })
  const ownerRequest = game.state.pendingRequests.at(-1)!
  if (ownerRequest.kind !== 'choose-cards') throw new Error('联诛阳应再选择吴匡重铸牌')
  return { game, ownerId: owner!.id, actorId: actor!.id, selected, ownerRequest }
}

function resolveLianzhuYang(seed: string, emptyPile = false, replacement = false) {
  const { game, ownerId, actorId, selected, ownerRequest } = lianzhuYang(seed, emptyPile, replacement)
  const events: Array<{ name: string; playerId?: string; reason?: string; isDraw?: unknown; targetId?: string; cardIds?: string[]; cancelled?: boolean }> = []
  for (const name of ['LoseCard', 'DrawAttempt', 'GainCard'] as const) game.events.on(name, context => {
    const payload = context.event.payload
    events.push({ name, playerId: String(payload.playerId ?? ''), reason: String(payload.reason ?? ''), isDraw: payload.isDraw,
      targetId: context.event.targetId, cardIds: context.event.cardIds, cancelled: context.cancelled })
  })
  game.respond({ requestId: ownerRequest.id, playerId: ownerId, payload: { cardIds: [selected[0]!] } })
  if (replacement) {
    const choice = game.state.pendingRequests.at(-1)!
    expect(choice).toMatchObject({ kind: 'choose-option', playerId: actorId })
    game.respond({ requestId: choice.id, playerId: choice.playerId, payload: { optionId: 'no' } })
  }
  const gains = events.filter(event => event.name === 'GainCard')
  expect(gains).toHaveLength(2)
  for (const gain of gains) {
    expect(gain.reason).toBe('recast')
    expect(gain.isDraw).toBe(true)
    expect(gain.targetId).toBe(gain.playerId)
    expect(gain.cardIds).toHaveLength(1)
  }
  assertGameInvariants(game.state)
  if (replacement) {
    expect(events.filter(event => event.name === 'DrawAttempt' && event.playerId === actorId).map(event => event.cancelled))
      .toEqual([true, false])
  }
  expect(events.map(event => `${event.name}:${event.playerId}`)).toEqual([
    `LoseCard:${actorId}`, `DrawAttempt:${actorId}`, `GainCard:${actorId}`,
    `LoseCard:${ownerId}`, `DrawAttempt:${ownerId}`, `GainCard:${ownerId}`,
  ])
  return { game, events }
}

describe('审计：历史批次残留的重铸直接摸牌', () => {
  it('晖云选项一先重铸全部手牌，再按总数摸牌', () => {
    const { game, cards } = huiyunGame('audit-recast-huiyun-normal', 3)
    resolveHuiyun(game, '1', 'not-held-by-target')
  })

  it('晖云选项一牌堆空时从重洗后的弃牌堆摸足相同数量', () => {
    const { game, cards } = huiyunGame('audit-recast-huiyun-reshuffle', 3, true)
    resolveHuiyun(game, '1', 'not-held-by-target')
  })

  it('晖云选项二只重铸展示牌并保留目标其余手牌', () => {
    const { game, cards } = huiyunGame('audit-recast-huiyun-option-two', 2, false, '闪')
    resolveHuiyun(game, '2', cards[0]!)
  })

  it('联诛阳依次结算当前角色、吴匡的两次重铸摸牌', () => {
    resolveLianzhuYang('audit-recast-lianzhu-order')
  })

  it('联诛阳两次重铸均从耗尽后的弃牌堆重洗并保持顺序', () => {
    resolveLianzhuYang('audit-recast-lianzhu-reshuffle', true)
  })

  it('联诛阳首名角色摸牌被谮润拒绝后恢复并完成双方重铸', () => {
    resolveLianzhuYang('audit-recast-lianzhu-zanrun', false, true)
  })
})
