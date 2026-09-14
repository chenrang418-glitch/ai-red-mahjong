import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { handleEquipmentLost } from '../../engine/equipment'
import { ABOLISHABLE_SLOTS, abolishSlot, restoreSlot, abolishedSlotsOf } from '../../engine/equipment-slots'
import { executeUseCardAction } from '../../engine/cards/basic'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 霍峻（三国杀 OL 经典身份 SP）。
 *
 * 【穷守】：锁定技，游戏开始时废除你所有装备栏，摸4张牌；你的手牌上限+4。
 * 【奋锐】：结束阶段，你可以弃置1张牌，然后复原1个被废除的装备栏，并从
 *          牌堆中随机使用1张合法的对应类型装备牌；本局首次因此真正造成
 *          过伤害之前，若存在装备数量比你少的角色，可以对其中一名造成
 *          伤害，伤害值为双方装备数量之差。
 */

const QIONGSHOU = 'qiongshou'
const FENRUI = 'fenrui'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function equipmentCount(state: SanguoshaState, playerId: PlayerId): number {
  const player = playerOf(state, playerId)
  return player ? Object.values(player.zones.equipment).filter(Boolean).length : 0
}

registerSkillRuntime({
  id: QIONGSHOU,
  maxCardsBonus() { return 4 },
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    for (const slot of ABOLISHABLE_SLOTS) {
      const equipped = owner.zones.equipment[slot]
      if (equipped) {
        moveCard(host.state, equipped, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
        handleEquipmentLost(host as never, ownerId, equipped)
      }
      abolishSlot(host.state, ownerId, slot)
    }
    host.dispatch('SkillActivated', { skillId: QIONGSHOU, skillName: '穷守', playerId: ownerId, logText: `${owner.nickname}发动【穷守】，废除所有装备栏` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 4, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: FENRUI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0 || abolishedSlotsOf(host.state, ownerId).length === 0) return
      host.queueSkill({ skillId: FENRUI, ownerId, step: 'ask-cost', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-cost') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: FENRUI, ownerId, step: 'ask-cost', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【奋锐】：可以弃置一张牌，复原一个装备栏', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask-cost') {
      const [costId] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      if (!owner?.alive || !costId || !owner.zones.hand.includes(costId)) return
      const abolished = abolishedSlotsOf(host.state, ownerId)
      if (abolished.length === 0) return
      moveCard(host.state, costId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [costId], reason: FENRUI }, { sourceId: ownerId, cardIds: [costId] })
      const options = abolished.map((slot) => ({ id: slot, label: slot }))
      host.askSkill({
        skillId: FENRUI, ownerId, step: 'pick-slot', data: {},
        build: (requestId) => ({
          id: requestId, kind: 'choose-option' as const, playerId: ownerId,
          prompt: '【奋锐】：选择复原一个装备栏', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }
    if (resolution.step === 'pick-slot') {
      const slot = (response.payload as { optionId?: string }).optionId as EquipmentSlot | undefined
      if (!owner?.alive || !slot) return
      restoreSlot(host.state, ownerId, slot)
      host.dispatch('SkillActivated', { skillId: FENRUI, skillName: '奋锐', playerId: ownerId, logText: `${owner.nickname}发动【奋锐】，复原了${slot}` }, { sourceId: ownerId })
      const candidates = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.equipmentSlot === slot)
      if (candidates.length === 0) return
      const cardId = candidates[host.rng.nextInt(candidates.length)]
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: FENRUI }, { targetId: ownerId, cardIds: [cardId] })
      const card = host.state.cards[cardId]
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `fenrui-equip:${cardId}`, playerId: ownerId, label: '',
        cardIds: [cardId], targetIds: [ownerId], targetMin: 1, targetMax: 1, asCardName: card?.name ?? '',
      })
      if (owner.marks['fenrui-damage-used']) return
      const myCount = equipmentCount(host.state, ownerId)
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && equipmentCount(host.state, candidate.id) < myCount).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: FENRUI, ownerId, step: 'pick-damage-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【奋锐】：可以对一名装备数量比你少的角色造成伤害', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-damage-target') {
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !victimId || !playerOf(host.state, victimId)?.alive) return
      const x = equipmentCount(host.state, ownerId) - equipmentCount(host.state, victimId)
      if (x <= 0) return
      owner.marks['fenrui-damage-used'] = 1
      resolveDamage(host as never, { sourceId: ownerId, targetId: victimId, amount: x, nature: 'normal', cardName: null })
    }
  },
})

export const HUOJUN: CharacterDefinition = {
  id: 'huojun',
  name: '霍峻',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: QIONGSHOU, name: '穷守', description: '锁定技，游戏开始时废除你所有装备栏，摸4张牌；你的手牌上限+4。' },
    { id: FENRUI, name: '奋锐', description: '结束阶段，你可以弃置1张牌，然后复原1个被废除的装备栏，并从牌堆中随机使用1张合法的对应类型装备牌；本局首次因此真正造成过伤害之前，若存在装备数量比你少的角色，可以对其中一名造成伤害，伤害值为双方装备数量之差。' },
  ],
}
