import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { adjustDamageAmount, BAGUA_ACTION_ID, hasArmor } from '@/sanguosha/engine/equipment'
import { clearArmorSuppressionForCard, isArmorSuppressed, suppressArmor, suppressArmorForCard } from '@/sanguosha/engine/armor-suppression'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { locateOwnedCard, moveCard, setCardNature, type ZoneRef } from '@/sanguosha/engine/zones'
import type { PlayerId } from '@/sanguosha/engine/types'
import type { RespondCardRequest } from '@/sanguosha/engine/requests'

function gameWith(seed: string): SanguoshaGame {
  const characterIds = ['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']
  const game = new SanguoshaGame({
    seed,
    setup: {
      mode: 'identity', generalChoices: 1,
      players: characterIds.map((_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: true })),
    },
  })
  const identities = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade'] as const
  game.state.players.forEach((candidate, index) => {
    candidate.characterId = characterIds[index]!
    candidate.identity = identities[index]!
  })
  game.start()
  game.state.phase = 'play'
  game.state.currentPlayerId = 'p0'
  game.state.pendingRequests = []
  game.state.skillResolution = null
  game.state.cardResolution = null
  return game
}

function zoneOf(game: SanguoshaGame, cardId: string): ZoneRef {
  for (const candidate of game.state.players) {
    const owned = locateOwnedCard(game.state, candidate.id, cardId, { includeCharacterPiles: true })
    if (owned) return owned
  }
  if (game.state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (game.state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (game.state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  throw new Error(`找不到牌所在区域：${cardId}`)
}

function take(game: SanguoshaGame, name: string, to: ZoneRef): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === name)
  if (!card) throw new Error(`找不到【${name}】`)
  moveCard(game.state, card.id, zoneOf(game, card.id), to)
  return card.id
}

function player(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((candidate) => candidate.id === playerId)!
}

function physicalSlash(game: SanguoshaGame, nature: 'normal' | 'fire' | 'thunder' = 'normal'): string {
  const slash = take(game, nature === 'normal' ? '杀' : `${nature === 'fire' ? '火' : '雷'}杀`, { kind: 'hand', playerId: 'p0' })
  setCardNature(game.state, slash, nature)
  return slash
}

function startPhysicalSlash(game: SanguoshaGame, slash: string): void {
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slash) && candidate.asCardName === '杀' && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('找不到对 p1 使用的合法物理【杀】')
  game.act('p0', action.id)
}

function passDodge(game: SanguoshaGame): void {
  const request = game.state.pendingRequests[0] as RespondCardRequest | undefined
  if (!request || request.kind !== 'respond-card' || request.requiredCardName !== '闪') {
    throw new Error('没有等待【闪】的响应请求')
  }
  const actionId = request.actionIds.find((id) => id.includes('pass'))
  expect(actionId).toBeTruthy()
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: actionId! } })
}

function invariants(game: SanguoshaGame): void {
  assertGameInvariants(game.state)
}

describe('audit: 青釭剑穿甲仅绑定当前实体杀', () => {
  it('真实普通杀的2点伤害穿过白银狮子；清算后甲仍装备且后续同源技能伤害封顶', () => {
    const game = gameWith('audit-qinggang-scope-silver-two')
    const qinggang = take(game, '青釭剑', { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    const silverLion = take(game, '白银狮子', { kind: 'equipment', playerId: 'p1', slot: 'armor' })
    const slash = physicalSlash(game)
    player(game, 'p0').marks.luoyi = 1
    const hpBefore = player(game, 'p1').hp

    startPhysicalSlash(game, slash)
    expect(game.state.armorSuppressions).toContainEqual(expect.objectContaining({
      sourceId: 'p0', targetIds: ['p1'], cardId: slash, expiry: 'card-use-end', skillId: 'equip:qinggangjian',
    }))
    expect(adjustDamageAmount(game.state, 'p0', 'p1', 2, 'normal', '杀', slash)).toBe(2)
    passDodge(game)

    expect(player(game, 'p1').hp).toBe(hpBefore - 2)
    expect(player(game, 'p1').zones.equipment.armor).toBe(silverLion)
    expect(player(game, 'p0').zones.equipment.weapon).toBe(qinggang)
    expect(game.state.armorSuppressions?.some((entry) => entry.cardId === slash)).toBe(false)
    expect(adjustDamageAmount(game.state, 'p0', 'p1', 2, 'normal', null)).toBe(1)
    invariants(game)
  })

  it('青釭剑的实体杀与无载体虚拟杀都不开放八卦阵响应', () => {
    const physical = gameWith('audit-qinggang-bagua-physical')
    take(physical, '青釭剑', { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    take(physical, '八卦阵', { kind: 'equipment', playerId: 'p1', slot: 'armor' })
    const slash = physicalSlash(physical)
    startPhysicalSlash(physical, slash)
    const physicalResponse = physical.state.pendingRequests[0] as RespondCardRequest
    expect(physicalResponse.actionIds).not.toContain(BAGUA_ACTION_ID)
    expect(physical.state.armorSuppressions?.some((entry) => entry.cardId === slash && entry.targetIds.includes('p1'))).toBe(true)
    passDodge(physical)
    expect(physical.state.armorSuppressions?.some((entry) => entry.cardId === slash)).toBe(false)
    invariants(physical)

    const virtual = gameWith('audit-qinggang-bagua-virtual')
    take(virtual, '青釭剑', { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    take(virtual, '八卦阵', { kind: 'equipment', playerId: 'p1', slot: 'armor' })
    expect(virtual.beginVirtualSlash({ sourceId: 'p0', targetId: 'p1', sourceSkillId: 'audit-virtual' })).toBe(true)
    const virtualResponse = virtual.state.pendingRequests[0] as RespondCardRequest
    const virtualSlashId = virtual.state.cardResolution?.cardId
    expect(virtualResponse.actionIds).not.toContain(BAGUA_ACTION_ID)
    expect(virtualSlashId).toBeTruthy()
    expect(virtual.state.armorSuppressions?.some((entry) => entry.cardId === virtualSlashId && entry.targetIds.includes('p1'))).toBe(true)
    passDodge(virtual)
    expect(virtual.state.armorSuppressions?.some((entry) => entry.cardId === virtualSlashId)).toBe(false)
    invariants(virtual)
  })

  it('正在穿甲的杀不压制同源另一张牌的防具查询', () => {
    const game = gameWith('audit-qinggang-scope-other-card')
    take(game, '青釭剑', { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    take(game, '白银狮子', { kind: 'equipment', playerId: 'p1', slot: 'armor' })
    const slash = physicalSlash(game)
    const otherCard = take(game, '桃', { kind: 'hand', playerId: 'p0' })
    startPhysicalSlash(game, slash)

    expect(adjustDamageAmount(game.state, 'p0', 'p1', 2, 'normal', '杀', slash)).toBe(2)
    expect(adjustDamageAmount(game.state, 'p0', 'p1', 2, 'normal', '桃', otherCard)).toBe(1)
    expect(adjustDamageAmount(game.state, 'p0', 'p1', 2, 'normal', null)).toBe(1)
    expect(hasArmor(game.state, 'p1', '白银狮子', 'p0', '桃', null, otherCard)).toBe(true)
    expect(hasArmor(game.state, 'p1', '白银狮子', 'p0', '杀', null, slash)).toBe(false)
    passDodge(game)
    invariants(game)
  })

  it('旧 turn-end 来源压制有无 cardId 都继续生效', () => {
    const game = gameWith('audit-qinggang-scope-turn-end')
    const silverLion = take(game, '白银狮子', { kind: 'equipment', playerId: 'p1', slot: 'armor' })
    const slash = physicalSlash(game)
    suppressArmor(game.state, 'p0', 'p1', 'audit-turn-end')
    suppressArmorForCard(game.state, 'p0', 'p1', slash, 'audit-card-use')

    expect(isArmorSuppressed(game.state, 'p1', 'p0')).toBe(true)
    expect(isArmorSuppressed(game.state, 'p1', 'p0', slash)).toBe(true)
    expect(hasArmor(game.state, 'p1', '白银狮子', 'p0')).toBe(false)
    expect(hasArmor(game.state, 'p1', '白银狮子', 'p0', undefined, undefined, slash)).toBe(false)
    clearArmorSuppressionForCard(game.state, 'p0', slash)
    expect(game.state.armorSuppressions?.some((entry) => entry.expiry === 'turn-end' && entry.targetIds.includes('p1'))).toBe(true)
    expect(isArmorSuppressed(game.state, 'p1', 'p0', slash)).toBe(true)
    expect(player(game, 'p1').zones.equipment.armor).toBe(silverLion)
    invariants(game)
  })
})
