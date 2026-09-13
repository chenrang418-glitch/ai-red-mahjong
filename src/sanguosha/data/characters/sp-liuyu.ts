import { moveCard } from '../../engine/zones'
import { recover } from '../../engine/recover'
import { gainMaxHp, loseMaxHp } from '../../engine/hp'
import { handleEquipmentLost } from '../../engine/equipment'
import { canTarget } from '../../engine/distance'
import { livingKingdoms, livingKingdomCount } from '../../engine/living-kingdoms'
import { executeUseCardAction } from '../../engine/cards/basic'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘虞（三国杀 OL 经典身份 SP）。
 *
 * 【止戈】：出牌阶段限一次，若你的手牌数大于体力值，选择一名攻击范围
 *          包含你的其他角色A，A选择使用一张杀，或将装备区一张牌交给你。
 * 【宗祚】：锁定技，游戏开始时体力上限和体力值各增加X（X为当前存活势力
 *          数）；每当一个势力的最后一名存活角色死亡后，你减1点体力上限。
 */

const ZHIGE = 'zhige'
const ZONGZUO = 'zongzuo'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function hasSlash(state: SanguoshaState, playerId: PlayerId): boolean {
  return playerOf(state, playerId)?.zones.hand.some((id) => state.cards[id]?.name === '杀') ?? false
}

function hasEquipment(state: SanguoshaState, playerId: PlayerId): boolean {
  const player = playerOf(state, playerId)
  return player ? Object.values(player.zones.equipment).some(Boolean) : false
}

registerSkillRuntime({
  id: ZHIGE,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(ZHIGE) || owner.zones.hand.length <= owner.hp) return []
    const candidateIds = state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
      && canTarget(state, candidate.id, ownerId)
      && (hasSlash(state, candidate.id) || hasEquipment(state, candidate.id))).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return []
    return [{ id: ZHIGE, label: '止戈：选择一名攻击范围包含你的角色' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHIGE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(ZHIGE) || owner.zones.hand.length <= owner.hp) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
      && canTarget(host.state, candidate.id, ownerId)
      && (hasSlash(host.state, candidate.id) || hasEquipment(host.state, candidate.id))).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(ZHIGE)
    host.askSkill({
      skillId: ZHIGE, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【止戈】：选择一名攻击范围包含你的角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      host.dispatch('SkillActivated', { skillId: ZHIGE, skillName: '止戈', playerId: ownerId, targetId, logText: `${owner.nickname}发动【止戈】` }, { sourceId: ownerId, targetId })
      const options: Array<{ id: string; label: string }> = []
      if (hasSlash(host.state, targetId)) options.push({ id: 'slash', label: '使用一张杀' })
      if (hasEquipment(host.state, targetId)) options.push({ id: 'give', label: '交给刘虞装备区一张牌' })
      if (options.length === 0) return
      host.askSkill({
        skillId: ZHIGE, ownerId, step: 'target-choose', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【止戈】：选择一项', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }
    if (resolution.step === 'target-choose') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'slash') {
        const slashes = target.zones.hand.filter((id) => host.state.cards[id]?.name === '杀')
        if (slashes.length === 0) return
        host.askSkill({
          skillId: ZHIGE, ownerId, step: 'pick-slash-card', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: '【止戈】：使用一张杀', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: slashes, hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      const slots = Object.entries(target.zones.equipment).filter(([, id]) => id) as Array<[EquipmentSlot, CardId]>
      if (slots.length === 0) return
      host.askSkill({
        skillId: ZHIGE, ownerId, step: 'pick-equipment', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【止戈】：交给刘虞一件装备', timeoutMs: 20_000, optional: false,
          options: slots.map(([slot, cardId]) => ({ id: slot, label: host.state.cards[cardId]?.name ?? slot })),
        }),
      })
      return
    }
    if (resolution.step === 'pick-slash-card') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      const slashCandidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== targetId && canTarget(host.state, targetId, candidate.id)).map((candidate) => candidate.id)
      if (slashCandidateIds.length === 0) return
      host.askSkill({
        skillId: ZHIGE, ownerId, step: 'pick-slash-target', data: { targetId, cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: targetId,
          prompt: '【止戈】：选择杀的目标', timeoutMs: 20_000, optional: false,
          candidateIds: slashCandidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-slash-target') {
      const { targetId, cardId } = resolution.data as { targetId: PlayerId; cardId: CardId }
      const target = playerOf(host.state, targetId)
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!target?.alive || !victimId || !target.zones.hand.includes(cardId)) return
      executeUseCardAction(host as never, targetId, {
        kind: 'use-card', id: `zhige-slash:${cardId}`, playerId: targetId, label: '',
        cardIds: [cardId], targetIds: [victimId], targetMin: 1, targetMax: 1, asCardName: '杀',
      })
      return
    }
    if (resolution.step === 'pick-equipment') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const slot = (response.payload as { optionId?: string }).optionId as EquipmentSlot | undefined
      if (!target?.alive || !slot) return
      const cardId = target.zones.equipment[slot]
      if (!cardId) return
      moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'hand', playerId: ownerId })
      handleEquipmentLost(host as never, targetId, cardId)
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHIGE }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
    }
  },
})

registerSkillRuntime({
  id: ZONGZUO,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const x = livingKingdomCount(host.state)
    if (x <= 0) return
    gainMaxHp(host as never, ownerId, x, ZONGZUO)
    recover(host as never, ownerId, x, ownerId)
    host.state.zongzuoLivingKingdoms = [...livingKingdoms(host.state)]
    host.dispatch('SkillActivated', { skillId: ZONGZUO, skillName: '宗祚', playerId: ownerId, logText: `${owner.nickname}发动【宗祚】，体力上限与体力各+${x}` }, { sourceId: ownerId })
  },
  triggers: [{
    event: 'Death',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const before = new Set(host.state.zongzuoLivingKingdoms ?? [])
      const after = livingKingdoms(host.state)
      host.state.zongzuoLivingKingdoms = [...after]
      const extinct = [...before].filter((kingdom) => !after.has(kingdom))
      if (extinct.length === 0) return
      void context
      loseMaxHp(host as never, ownerId, extinct.length, ZONGZUO)
      host.dispatch('SkillActivated', { skillId: ZONGZUO, skillName: '宗祚', playerId: ownerId, logText: `${owner.nickname}发动【宗祚】，体力上限-${extinct.length}` }, { sourceId: ownerId })
    },
  }],
})

export const LIUYU: CharacterDefinition = {
  id: 'liuyu',
  name: '刘虞',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: ZHIGE, name: '止戈', description: '出牌阶段限一次，若你的手牌数大于体力值，选择一名攻击范围包含你的其他角色，其选择使用一张杀，或将装备区一张牌交给你。' },
    { id: ZONGZUO, name: '宗祚', description: '锁定技，游戏开始时体力上限和体力值各增加X（X为当前存活势力数）；每当一个势力的最后一名存活角色死亡后，你减1点体力上限。' },
  ],
}
