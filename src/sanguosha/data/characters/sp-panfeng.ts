import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { beginVirtualSlash } from '../../engine/cards/basic'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 潘凤（三国杀 OL 经典身份 SP）。
 *
 * 【狂斧】：出牌阶段限一次，选择一名装备区有牌的角色，弃置其一张装备牌，
 *          然后视为对其使用一张无距离限制的【杀】（`beginVirtualSlash`，
 *          `countUsage: true` 照常占用出杀次数，只是不吃距离）；结算完毕后
 *          按「弃置的装备是不是潘凤自己的」和「这张杀有没有真的造成过
 *          伤害」（复用 `card-damage-ledger.ts`）两两组合决定后续效果。
 */

const KUANGFU = 'kuangfu'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: KUANGFU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(KUANGFU)) return []
    const hasCandidate = state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && Object.values(candidate.zones.equipment).some(Boolean))
    if (!hasCandidate) return []
    return [{ id: KUANGFU, label: '狂斧：弃置一名角色的装备牌，视为使用无距离限制的杀' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== KUANGFU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(KUANGFU)) return
    const candidateIds = host.state.players
      .filter((candidate) => candidate.alive && candidate.id !== ownerId && Object.values(candidate.zones.equipment).some(Boolean))
      .map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: KUANGFU, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【狂斧】：选择一名装备区有牌的角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const equipped = target ? Object.values(target.zones.equipment).filter((cardId): cardId is CardId => !!cardId) : []
      if (!target?.alive || equipped.length === 0) return
      host.askSkill({
        skillId: KUANGFU, ownerId, step: 'pick', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【狂斧】：弃置${target.nickname}的一张装备牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: equipped, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !owner.turnUsedSkills || owner.turnUsedSkills.includes(KUANGFU)) return
      const slot = cardId ? (Object.keys(target.zones.equipment) as Array<keyof typeof target.zones.equipment>)
        .find((key) => target.zones.equipment[key] === cardId) : undefined
      if (!cardId || !slot) return
      owner.turnUsedSkills.push(KUANGFU)
      const fromOwnEquipment = targetId === ownerId
      moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'discardPile' })
      handleEquipmentLost(host as never, targetId, cardId)
      host.dispatch('SkillActivated', { skillId: KUANGFU, skillName: '狂斧', playerId: ownerId, targetId, logText: `${owner.nickname}发动【狂斧】，弃置${target.nickname}的装备牌` }, { sourceId: ownerId, targetId })
      host.state.pendingKuangfu = { ownerId, targetId, fromOwnEquipment }
      const began = beginVirtualSlash(host as never, { sourceId: ownerId, targetId, sourceSkillId: KUANGFU, countUsage: true })
      if (!began) delete host.state.pendingKuangfu
      return
    }

    if (resolution.step === 'discard-2') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((cardId) => owner.zones.hand.includes(cardId))
      if (valid.length === 0) return
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: KUANGFU }, { sourceId: ownerId, cardIds: valid })
    }
  },

  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
      const pending = host.state.pendingKuangfu
      if (!pending || pending.ownerId !== ownerId || payload.sourceSkillId !== KUANGFU || !payload.cardId) return
      delete host.state.pendingKuangfu
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, pending.targetId)
      if (!owner?.alive) return
      const dealtDamage = cardDamageDealt(host.state, payload.cardId) > 0
      if (!pending.fromOwnEquipment && !dealtDamage) {
        host.queueSkill({ skillId: KUANGFU, ownerId, step: 'discard-2', data: {} })
      } else if (pending.fromOwnEquipment && dealtDamage && target?.alive) {
        drawCards(host.state, host.rng, ownerId, 2, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      }
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-2') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: KUANGFU, ownerId, step: 'discard-2', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【狂斧】：弃置2张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [],
        min: Math.min(2, owner.zones.hand.length), max: Math.min(2, owner.zones.hand.length),
      }),
    })
  },
})

export const PANFENG: CharacterDefinition = {
  id: 'panfeng',
  name: '潘凤',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: KUANGFU, name: '狂斧', description: '出牌阶段限一次，弃置一名角色装备区一张牌，视为使用一张无距离限制的【杀】；若装备不属于自己且这次杀未造成伤害，弃置2张手牌；若装备属于自己且这次杀造成伤害，摸2张牌。' },
  ],
}
