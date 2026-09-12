import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentZone, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 王平（三国杀 OL 经典身份 SP）。
 *
 * 【飞军】：出牌阶段限一次，王平弃置1张牌，然后选择一项：A. 选择一名
 *          手牌数比王平多的角色，令其交给王平一张手牌；B. 选择一名
 *          装备数比王平多的角色，令其弃置装备区一张牌。
 * 【兵略】：锁定技，某名角色第一次成为王平【飞军】的目标时，王平摸2张牌
 *          （不区分是哪个分支，用一个持久化的「已触发过」集合记账）。
 */

const FEIJUN = 'feijun'
const BINGLUE = 'binglue'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function equipCount(player: { zones: { equipment: EquipmentZone } }): number {
  return Object.values(player.zones.equipment).filter(Boolean).length
}

// 兵略是锁定技，效果完全由 triggerBinglue（飞军命中时调用）驱动，这里只登记 id。
registerSkillRuntime({ id: BINGLUE })

function triggerBinglue(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  host.state.bingluTargets ??= {}
  host.state.bingluTargets[ownerId] ??= []
  if (host.state.bingluTargets[ownerId].includes(targetId)) return
  host.state.bingluTargets[ownerId].push(targetId)
  drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
  host.dispatch('SkillActivated', { skillId: BINGLUE, skillName: '兵略', playerId: ownerId, targetId, logText: `${owner.nickname}发动【兵略】，摸牌` }, { sourceId: ownerId, targetId })
}

registerSkillRuntime({
  id: FEIJUN,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(FEIJUN)) return []
    const ownEquip = equipCount(owner)
    const hasA = state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > owner.zones.hand.length)
    const hasB = state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && equipCount(candidate) > ownEquip)
    if (!hasA && !hasB) return []
    return [{ id: FEIJUN, label: '飞军：弃置一张牌，然后选择一项' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== FEIJUN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(FEIJUN)) return
    host.askSkill({
      skillId: FEIJUN, ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【飞军】：弃置一张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      owner.turnUsedSkills.push(FEIJUN)
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: FEIJUN }, { sourceId: ownerId, cardIds: [cardId] })
      const ownEquip = equipCount(owner)
      const hasA = host.state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > owner.zones.hand.length)
      const hasB = host.state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && equipCount(candidate) > ownEquip)
      const options: Array<{ id: string; label: string }> = []
      if (hasA) options.push({ id: 'A', label: '选择一名手牌数比你多的角色，令其交给你一张手牌' })
      if (hasB) options.push({ id: 'B', label: '选择一名装备数比你多的角色，令其弃置装备区一张牌' })
      if (options.length === 0) return
      host.dispatch('SkillActivated', { skillId: FEIJUN, skillName: '飞军', playerId: ownerId, logText: `${owner.nickname}发动【飞军】` }, { sourceId: ownerId })
      if (options.length === 1) {
        host.askSkill({
          skillId: FEIJUN, ownerId, step: 'target', data: { branch: options[0].id },
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: `【飞军】：${options[0].label}`, timeoutMs: 20_000, optional: false,
            candidateIds: host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
              && (options[0].id === 'A' ? candidate.zones.hand.length > owner.zones.hand.length : equipCount(candidate) > ownEquip)).map((candidate) => candidate.id),
            min: 1, max: 1,
          }),
        })
        return
      }
      host.askSkill({
        skillId: FEIJUN, ownerId, step: 'branch', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【飞军】：选择一项', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }

    if (resolution.step === 'branch') {
      const branch = (response.payload as { optionId?: string }).optionId
      if (branch !== 'A' && branch !== 'B') return
      const ownEquip = equipCount(owner)
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
        && (branch === 'A' ? candidate.zones.hand.length > owner.zones.hand.length : equipCount(candidate) > ownEquip)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: FEIJUN, ownerId, step: 'target', data: { branch },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【飞军】：选择目标', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const { branch } = resolution.data as { branch: 'A' | 'B' }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      triggerBinglue(host, ownerId, targetId!)
      if (branch === 'A') {
        if (target.zones.hand.length === 0) return
        host.askSkill({
          skillId: FEIJUN, ownerId, step: 'give', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId!,
            prompt: `【飞军】：交给${owner.nickname}一张手牌`, timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      const equipped = Object.entries(target.zones.equipment).filter(([, cardId]) => cardId).map(([, cardId]) => cardId as CardId)
      if (equipped.length === 0) return
      host.askSkill({
        skillId: FEIJUN, ownerId, step: 'discard-equip', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId!,
          prompt: '【飞军】：弃置装备区一张牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: equipped, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: FEIJUN }, { sourceId: targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: FEIJUN }, { targetId: ownerId, cardIds: [cardId] })
      return
    }

    if (resolution.step === 'discard-equip') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const slot = target ? (Object.keys(target.zones.equipment) as Array<keyof typeof target.zones.equipment>).find((key) => target.zones.equipment[key] === cardId) : undefined
      if (!target?.alive || !cardId || !slot) return
      moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: FEIJUN }, { sourceId: targetId, cardIds: [cardId] })
    }
  },
})

export const WANGPING: CharacterDefinition = {
  id: 'wangping',
  name: '王平',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: FEIJUN, name: '飞军', description: '出牌阶段限一次，弃置一张牌，然后选择一项：选择一名手牌数比你多的角色，令其交给你一张手牌；或选择一名装备数比你多的角色，令其弃置装备区一张牌。' },
    { id: BINGLUE, name: '兵略', description: '锁定技，某名角色第一次成为你【飞军】的目标时，你摸2张牌。' },
  ],
}
