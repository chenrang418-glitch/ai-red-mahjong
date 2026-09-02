import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { GameSetup, Identity, SanguoshaState } from '@/sanguosha/engine/types'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 3,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

function startedGame(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  return game
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const player of state.players) {
    if (player.zones.hand.includes(cardId)) return { kind: 'hand', playerId: player.id }
    if (player.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: player.id }
    for (const [slot, equipped] of Object.entries(player.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: player.id, slot: slot as keyof typeof player.zones.equipment }
    }
  }
  throw new Error(`找不到卡牌：${cardId}`)
}

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName && !game.state.players.find((player) => player.id === playerId)!.zones.hand.includes(candidate.id))!
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function passCurrentRescuer(game: SanguoshaGame): void {
  const request = game.state.pendingRequests[0]
  expect(request?.kind).toBe('rescue')
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
}

describe('伤害、濒死、救援、死亡与奖惩', () => {
  it('按伤害时机结算，并允许技能取消或修改伤害', () => {
    const game = startedGame('damage-timing')
    const seen: string[] = []
    game.events.on('BeforeDamage', (context) => {
      seen.push(context.event.name)
      context.event.payload.amount = 2
    })
    game.events.on('DamageCaused', (context) => { seen.push(context.event.name) })
    game.events.on('DamageInflicted', (context) => { seen.push(context.event.name) })
    game.events.on('Damaged', (context) => { seen.push(context.event.name) })
    game.events.on('AfterDamage', (context) => { seen.push(context.event.name) })
    game.damage({ sourceId: 'p0', targetId: 'p1' })
    expect(game.state.players[1].hp).toBe(2)
    expect(seen).toEqual(['BeforeDamage', 'DamageCaused', 'DamageInflicted', 'Damaged', 'AfterDamage'])

    game.events.on('BeforeDamage', (context) => { context.cancel() }, 10)
    game.damage({ sourceId: 'p0', targetId: 'p1' })
    expect(game.state.players[1].hp).toBe(2)
  })

  it('普通伤害不触发铁索传导，也不解除横置状态', () => {
    const game = startedGame('normal-no-chain')
    game.state.players[1].chained = true
    game.state.players[3].chained = true
    game.damage({ sourceId: 'p0', targetId: 'p1', nature: 'normal' })
    expect(game.state.players[1]).toMatchObject({ hp: 3, chained: true })
    expect(game.state.players[3]).toMatchObject({ hp: 4, chained: true })
    expect(game.state.damageChain).toBeNull()
  })

  it('火焰伤害按目标后的座次传导相同点数并解除所有横置', () => {
    const game = startedGame('fire-chain-order')
    game.state.players[1].chained = true
    game.state.players[3].chained = true
    game.state.players[4].chained = true
    const damaged: string[] = []
    game.events.on('Damaged', (context) => { damaged.push(context.event.targetId!) })
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 2, nature: 'fire' })
    expect(damaged).toEqual(['p1', 'p3', 'p4'])
    expect([game.state.players[1].hp, game.state.players[3].hp, game.state.players[4].hp]).toEqual([2, 2, 2])
    expect(game.state.players.filter((player) => ['p1', 'p3', 'p4'].includes(player.id)).every((player) => !player.chained)).toBe(true)
    expect(game.state.damageChain).toBeNull()
  })

  it('桃能救援任意濒死角色，Request 与牌局状态可序列化', () => {
    const game = startedGame('peach-rescue')
    const peachId = giveCard(game, 'p2', '桃')
    const askedPlayers: string[] = []
    game.events.on('AskForPeach', (context) => {
      askedPlayers.push(String((context.event.payload as { responderId?: string }).responderId))
    })
    game.state.players[1].hp = 1
    game.damage({ sourceId: 'p2', targetId: 'p1' })
    // 没有救援手段的角色应立即跳过，只询问真正能出桃的玩家。
    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'rescue', playerId: 'p2', dyingPlayerId: 'p1', requiredRecover: 1 })
    expect(askedPlayers).toEqual(['p2'])
    expect(JSON.parse(JSON.stringify(game.state)).dying.requestId).toBe(request.id)

    game.respond({ requestId: request.id, playerId: 'p2', payload: { actionId: `rescue-card:${peachId}` } })
    expect(game.state.players[1]).toMatchObject({ hp: 1, alive: true })
    expect(game.state.dying).toBeNull()
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.zones.discardPile).toContain(peachId)
    expect(game.state.decisions).toHaveLength(1)
    assertCardConservation(game.state)
  })

  it('酒仅能由濒死者自救，且救援从濒死者本人起依次询问', () => {
    const game = startedGame('wine-rescue')
    const wineId = giveCard(game, 'p1', '酒')
    game.state.players[1].hp = 1
    // p0 的回合里 p1 濒死：先问 p1 自己，而不是回合角色 p0
    game.damage({ targetId: 'p1' })
    const selfRequest = game.state.pendingRequests[0]
    expect(selfRequest).toMatchObject({ kind: 'rescue', playerId: 'p1' })
    expect(selfRequest.kind === 'rescue' && selfRequest.actionIds, '酒只有濒死者本人能用')
      .toContain(`rescue-card:${wineId}`)
    game.respond({ requestId: selfRequest.id, playerId: 'p1', payload: { actionId: `rescue-card:${wineId}` } })
    expect(game.state.players[1].hp).toBe(1)
    expect(game.state.dying).toBeNull()
  })

  it('别人手上的酒不会触发无效求桃请求', () => {
    const game = startedGame('wine-not-shared')
    // 固定为没有桃转化/蛊惑能力的武将，确保这个用例只验证【酒】的救援边界。
    game.state.players.forEach((player) => { player.characterId = 'lvbu' })
    for (const player of game.state.players) {
      for (const cardId of [...player.zones.hand]) {
        if (['桃', '酒'].includes(game.state.cards[cardId].name)) {
          moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
        }
      }
    }
    const wineId = giveCard(game, 'p0', '酒')
    game.state.players[1].hp = 1
    game.damage({ targetId: 'p1' })
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.dying).toBeNull()
    expect(game.state.players[1].alive).toBe(false)
    expect(game.state.players[0].zones.hand).toContain(wineId)
  })

  it('无人救援后死亡、公开身份、弃置区域，并由伤害来源获得反贼奖励', () => {
    const game = startedGame('rebel-death')
    game.state.players[1].hp = 1
    const killer = game.state.players[2]
    const killerHandBefore = killer.zones.hand.length
    game.damage({ sourceId: killer.id, targetId: 'p1' })
    while (game.state.dying) passCurrentRescuer(game)
    expect(game.state.players[1]).toMatchObject({ alive: false, identityRevealed: true })
    expect(game.state.players[1].zones.hand).toHaveLength(0)
    expect(killer.zones.hand).toHaveLength(killerHandBefore + 3)
    expect(game.state.status).toBe('playing')
    assertCardConservation(game.state)
  })

  it('主公杀死忠臣时弃置主公的手牌和装备', () => {
    const game = startedGame('loyalist-penalty')
    const lord = game.state.players[0]
    const weapon = Object.values(game.state.cards).find((card) => card.equipmentSlot === 'weapon')!
    moveCard(game.state, weapon.id, locate(game.state, weapon.id), { kind: 'equipment', playerId: lord.id, slot: 'weapon' })
    game.state.players[2].hp = 1
    game.damage({ sourceId: lord.id, targetId: 'p2' })
    while (game.state.dying) passCurrentRescuer(game)
    expect(lord.zones.hand).toHaveLength(0)
    expect(lord.zones.equipment.weapon).toBeNull()
    expect(game.state.zones.discardPile).toContain(weapon.id)
    assertCardConservation(game.state)
  })

  it('主公死亡后由统一胜负判定结束牌局并公开全部身份', () => {
    const game = startedGame('lord-death')
    game.state.players[0].hp = 1
    game.damage({ sourceId: 'p1', targetId: 'p0' })
    while (game.state.dying) passCurrentRescuer(game)
    expect(game.state.status).toBe('game-over')
    expect(game.state.result).toMatchObject({ winningCamp: 'rebel' })
    expect(game.state.players.every((player) => player.identityRevealed)).toBe(true)
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('单独取消 BeforeDeath 不会留下 0 体力悬空角色', () => {
    const game = startedGame('cancel-death-invariant')
    game.events.on('BeforeDeath', (context) => { context.cancel() })
    game.state.players[1].hp = 1
    game.damage({ targetId: 'p1' })
    while (game.state.dying) passCurrentRescuer(game)
    expect(game.state.players[1].alive).toBe(false)
  })

  it('拒绝错误玩家、非法 actionId 和已经过期的救援响应', () => {
    const game = startedGame('invalid-rescue')
    game.state.players[1].hp = 1
    game.damage({ targetId: 'p1' })
    const request = game.state.pendingRequests[0]
    expect(() => game.respond({ requestId: request.id, playerId: 'p2', payload: { actionId: 'rescue-pass' } })).toThrow('响应玩家')
    expect(() => game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'not-legal' } })).toThrow('actionId')
    passCurrentRescuer(game)
    expect(() => game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })).toThrow('不存在')
  })
})
