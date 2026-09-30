import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { setCardNature } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

type DamageNature = 'normal' | 'fire'

function gameWith(seed = 'slash-transfer-ineffective', characterIds = ['zhangfei', 'daqiao', 'zhangfei', 'zhangfei', 'zhangfei']): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = characterIds[index]
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
  return game
}

function takeFromDrawPile(game: SanguoshaGame, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  return cardId
}

function giveNamed(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = takeFromDrawPile(game, cardName)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

function takeOrdinarySlash(game: SanguoshaGame): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === '杀'
    && (game.state.cards[id].damageNature ?? 'normal') === 'normal')
  if (!cardId) throw new Error('牌堆里没有普通【杀】')
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  return cardId
}

function transferSingleSlash(options: { armor?: '藤甲'; nature?: DamageNature; seed?: string } = {}) {
  const game = gameWith(options.seed)
  let armorId: string | undefined
  if (options.armor) {
    armorId = takeFromDrawPile(game, options.armor)
    game.state.players[2]!.zones.equipment.armor = armorId
  }
  const slashId = takeOrdinarySlash(game)
  game.state.players[0]!.zones.hand.push(slashId)
  if (options.nature === 'fire') setCardNature(game.state, slashId, 'fire')
  const liuliCost = giveNamed(game, 'p1', '桃')
  const target = game.state.players[2]!
  const targetHp = target.hp
  const events = { cardUsed: 0, targetSpecified: 0, targetConfirmed: 0, damageInflicted: 0, damaged: 0, settled: [] as number[] }
  game.events.on('CardUsed', (context) => { if (context.event.cardIds?.includes(slashId)) events.cardUsed += 1 })
  game.events.on('TargetSpecified', (context) => { if (context.event.payload.cardId === slashId) events.targetSpecified += 1 })
  game.events.on('TargetConfirmed', (context) => { if (context.event.payload.cardId === slashId) events.targetConfirmed += 1 })
  game.events.on('DamageInflicted', (context) => { if (context.event.cardIds?.includes(slashId)) events.damageInflicted += 1 })
  game.events.on('Damaged', (context) => { if (context.event.cardIds?.includes(slashId)) events.damaged += 1 })
  game.events.on('DamageSettled', (context) => {
    if (context.event.payload.cardId === slashId) events.settled.push(Number(context.event.payload.finalAmount ?? 0))
  })

  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slashId) && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('构造不出张飞对大乔使用的【杀】')
  game.act('p0', action.id)
  const invoke = game.state.pendingRequests[0]
  if (invoke?.kind !== 'choose-option' || !invoke.prompt.includes('流离'))
    throw new Error(`没有得到大乔流离选项请求：${invoke?.kind ?? 'none'}`)
  game.respond({ requestId: invoke.id, playerId: 'p1', payload: { optionId: 'yes' } })
  const cost = game.state.pendingRequests[0]
  if (cost?.kind !== 'choose-cards') throw new Error(`没有得到流离弃牌请求：${cost?.kind ?? 'none'}`)
  game.respond({ requestId: cost.id, playerId: 'p1', payload: { cardIds: [liuliCost] } })
  const chooseTarget = game.state.pendingRequests[0]
  if (chooseTarget?.kind !== 'choose-targets') throw new Error(`没有得到流离目标请求：${chooseTarget?.kind ?? 'none'}`)
  if (!chooseTarget.candidateIds.includes('p2')) throw new Error('藤甲目标不在流离候选中')
  game.respond({ requestId: chooseTarget.id, playerId: 'p1', payload: { targetIds: ['p2'] } })
  return { game, slashId, target, targetHp, events, armorId, postTransfer: game.state.pendingRequests[0] }
}

describe('流离转移后仍须检查新目标的杀有效性', () => {
  it('普通杀转给藤甲目标后不造成伤害，事件、牌归宿和续接唯一收束', () => {
    const { game, slashId, target, targetHp, events, armorId, postTransfer } = transferSingleSlash({ armor: '藤甲' })
    if (postTransfer?.kind === 'respond-card') {
      game.respond({ requestId: postTransfer.id, playerId: 'p2', payload: { actionId: 'respond-pass' } })
    }
    expect(game.state.players[0]!.hp).toBe(4)
    expect(target.hp, '藤甲应令转入的普通杀对新目标无效').toBe(targetHp)
    expect(events.cardUsed).toBe(1)
    expect(events.targetSpecified, '初始目标和新目标各指定一次').toBe(2)
    expect(events.targetConfirmed).toBe(2)
    expect(events.damageInflicted).toBe(0)
    expect(events.damaged).toBe(0)
    expect(events.settled).toEqual([])
    expect(target.zones.equipment.armor).toBe(armorId)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(game.state.zones.processingArea).not.toContain(slashId)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('转给无防具目标时仍正常求闪并造成一点伤害', () => {
    const { game, slashId, target, targetHp, events, postTransfer } = transferSingleSlash({ seed: 'slash-transfer-no-armor' })
    expect(postTransfer).toMatchObject({ kind: 'respond-card', playerId: 'p2', requiredCardName: '闪' })
    if (postTransfer?.kind === 'respond-card')
      game.respond({ requestId: postTransfer.id, playerId: 'p2', payload: { actionId: 'respond-pass' } })
    expect(target.hp).toBe(targetHp - 1)
    expect(events.damageInflicted).toBe(1)
    expect(events.damaged).toBe(1)
    expect(events.settled).toEqual([1])
    expect(events.cardUsed).toBe(1)
    expect(events.targetSpecified).toBe(2)
    expect(events.targetConfirmed).toBe(2)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('火杀转给藤甲目标仍能求闪，放弃后受两点火焰伤害', () => {
    const { game, slashId, target, targetHp, events, postTransfer } = transferSingleSlash({ armor: '藤甲', nature: 'fire', seed: 'slash-transfer-fire-vine' })
    expect(postTransfer).toMatchObject({ kind: 'respond-card', playerId: 'p2', requiredCardName: '闪' })
    if (postTransfer?.kind === 'respond-card')
      game.respond({ requestId: postTransfer.id, playerId: 'p2', payload: { actionId: 'respond-pass' } })
    expect(target.hp).toBe(targetHp - 2)
    expect(events.damageInflicted).toBe(1)
    expect(events.damaged).toBe(1)
    expect(events.settled).toEqual([2])
    expect(events.cardUsed).toBe(1)
    expect(events.targetSpecified).toBe(2)
    expect(events.targetConfirmed).toBe(2)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('Fangtian多目标中将大乔目标流离给藤甲目标，只跳过该目标且其余目标各结算一次', () => {
    const game = gameWith('slash-transfer-fangtian-multi', ['zhangfei', 'zhangfei', 'daqiao', 'zhangfei', 'zhangfei'])
    const halberdId = takeFromDrawPile(game, '方天画戟')
    game.state.players[0]!.zones.equipment.weapon = halberdId
    const slashId = takeOrdinarySlash(game)
    game.state.players[0]!.zones.hand.push(slashId)
    game.state.zones.discardPile.push(...game.state.players[0]!.zones.hand.filter((id) => id !== slashId))
    game.state.players[0]!.zones.hand = [slashId]
    const liuliCost = giveNamed(game, 'p2', '桃')
    const armorId = takeFromDrawPile(game, '藤甲')
    game.state.players[3]!.zones.equipment.armor = armorId
    const hpBefore = game.state.players.map((player) => player.hp)
    expect(game.state.cards[slashId]!.damageNature ?? 'normal').toBe('normal')
    const events = { cardUsed: 0, targetSpecified: 0, targetConfirmed: 0, damaged: 0, damagedTargets: [] as string[] }
    game.events.on('CardUsed', (context) => { if (context.event.cardIds?.includes(slashId)) events.cardUsed += 1 })
    game.events.on('TargetSpecified', (context) => { if (context.event.payload.cardId === slashId) events.targetSpecified += 1 })
    game.events.on('TargetConfirmed', (context) => { if (context.event.payload.cardId === slashId) events.targetConfirmed += 1 })
    game.events.on('Damaged', (context) => {
      if (!context.event.cardIds?.includes(slashId)) return
      events.damaged += 1
      if (context.event.targetId) events.damagedTargets.push(context.event.targetId)
    })

    game.act('p0', 'skill:fangtian')
    const targets = game.state.pendingRequests[0]
    expect(targets?.kind).toBe('choose-targets')
    if (targets?.kind !== 'choose-targets') return
    game.respond({ requestId: targets.id, playerId: 'p0', payload: { targetIds: ['p2', 'p1', 'p4'] } })
    const invoke = game.state.pendingRequests[0]
    if (invoke?.kind !== 'choose-option' || !invoke.prompt.includes('流离')) throw new Error('Fangtian首目标未触发流离')
    game.respond({ requestId: invoke.id, playerId: 'p2', payload: { optionId: 'yes' } })
    const cost = game.state.pendingRequests[0]
    if (cost?.kind !== 'choose-cards') throw new Error('流离未请求弃牌')
    game.respond({ requestId: cost.id, playerId: 'p2', payload: { cardIds: [liuliCost] } })
    const redirect = game.state.pendingRequests[0]
    if (redirect?.kind !== 'choose-targets') throw new Error('流离未请求新目标')
    expect(redirect.candidateIds).toContain('p3')
    game.respond({ requestId: redirect.id, playerId: 'p2', payload: { targetIds: ['p3'] } })
    let guard = 0
    while (game.state.pendingRequests.length) {
      if (guard++ > 10) throw new Error('多目标杀未收敛')
      const request = game.state.pendingRequests[0]
      expect(request.kind, '完成流离后只应留下普通闪响应').toBe('respond-card')
      if (request.kind !== 'respond-card') return
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    }

    expect(game.state.players[1]!.hp).toBe(hpBefore[1] - 1)
    expect(game.state.players[2]!.hp).toBe(hpBefore[2])
    expect(game.state.players[3]!.hp, JSON.stringify({ events, nature: game.state.cards[slashId]!.damageNature ?? 'normal',
      hp: game.state.players.map((player) => player.hp), armorId, armorStillEquipped: game.state.players[3]!.zones.equipment.armor,
      cardResolution: game.state.cardResolution })).toBe(hpBefore[3])
    expect(game.state.players[4]!.hp).toBe(hpBefore[4] - 1)
    expect(events.cardUsed).toBe(1)
    expect(events.targetSpecified).toBe(2)
    expect(events.targetConfirmed).toBe(4)
    expect(events.damaged).toBe(2)
    expect(game.state.players[3]!.zones.equipment.armor).toBe(armorId)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('大乔放弃流离后继续结算也不能绕过原目标的藤甲', () => {
    const game = gameWith('slash-transfer-liuli-decline', ['zhangfei', 'daqiao', 'zhangfei', 'zhangfei', 'zhangfei'])
    const armorId = takeFromDrawPile(game, '藤甲')
    game.state.players[1]!.zones.equipment.armor = armorId
    const slashId = giveNamed(game, 'p0', '杀')
    const targetHp = game.state.players[1]!.hp
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slashId) && candidate.targetIds.includes('p1'))
    if (!action) throw new Error('构造不出对大乔的普通杀')
    game.act('p0', action.id)
    const invoke = game.state.pendingRequests[0]
    if (invoke?.kind !== 'choose-option' || !invoke.prompt.includes('流离')) throw new Error('原目标未触发流离')
    game.respond({ requestId: invoke.id, playerId: 'p1', payload: { optionId: 'no' } })
    const resumed = game.state.pendingRequests[0]
    if (resumed?.kind === 'respond-card')
      game.respond({ requestId: resumed.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })

    expect(game.state.players[1]!.hp, '放弃流离后藤甲仍应令普通杀无效').toBe(targetHp)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })
})
