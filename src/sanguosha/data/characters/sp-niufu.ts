import { moveCard } from '../../engine/zones'
import { flipCharacter } from '../../engine/character-state'
import { loseHp } from '../../engine/hp'
import { handleEquipmentLost } from '../../engine/equipment'
import { executeUseCardAction } from '../../engine/cards/basic'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 牛辅（三国杀 OL 经典身份 SP）。
 *
 * 【蓍算】：锁定技，受到伤害后，弃置1张牌，然后伤害来源选择一项：1.失去
 *          1点体力 2.交给牛辅其装备区1张牌 3.将其武将牌翻面。
 * 【纵掠】：出牌阶段限一次，将1张牌当【杀】使用；若此杀造成伤害后，该牌
 *          的实体牌不是【杀】（或没有实体牌），牛辅获得目标各区域（手牌/
 *          装备/判定区，各至多1张）的牌。
 */

const SHISUAN = 'shisuan'
const ZONGLUE = 'zonglue'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: SHISUAN,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: SHISUAN, ownerId, step: 'discard', data: { sourceId: context.event.sourceId ?? null } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) { proceedShisuan(host, ownerId, (prompt.data as { sourceId: PlayerId | null }).sourceId); return }
    host.askSkill({
      skillId: SHISUAN, ownerId, step: 'discard', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【蓍算】：弃置1张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'discard') {
      const { sourceId } = resolution.data as { sourceId: PlayerId | null }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardId && owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: SHISUAN }, { sourceId: ownerId, cardIds: [cardId] })
        host.dispatch('SkillActivated', { skillId: SHISUAN, skillName: '蓍算', playerId: ownerId, logText: `${owner.nickname}发动【蓍算】` }, { sourceId: ownerId })
      }
      proceedShisuan(host, ownerId, sourceId)
      return
    }
    if (resolution.step === 'source-choice') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const source = playerOf(host.state, sourceId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!source?.alive) return
      if (optionId === 'losehp') {
        loseHp(host as never, sourceId, 1, SHISUAN)
      } else if (optionId === 'give') {
        const slot = Object.entries(source.zones.equipment).find(([, id]) => id)?.[0] as EquipmentSlot | undefined
        if (slot) {
          const cardId = source.zones.equipment[slot]!
          moveCard(host.state, cardId, { kind: 'equipment', playerId: sourceId, slot }, { kind: 'hand', playerId: ownerId })
          handleEquipmentLost(host as never, sourceId, cardId)
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SHISUAN }, { sourceId, targetId: ownerId, cardIds: [cardId] })
        }
      } else if (optionId === 'flip') {
        flipCharacter(host, sourceId, SHISUAN)
      }
    }
  },
})

function proceedShisuan(host: SkillHost, ownerId: PlayerId, sourceId: PlayerId | null): void {
  const source = sourceId ? playerOf(host.state, sourceId) : undefined
  if (!source?.alive) return
  const hasEquipment = Object.values(source.zones.equipment).some(Boolean)
  const options = [{ id: 'losehp', label: '失去1点体力' }, { id: 'flip', label: '将武将牌翻面' }]
  if (hasEquipment) options.splice(1, 0, { id: 'give', label: '交给牛辅装备区1张牌' })
  host.askSkill({
    skillId: SHISUAN, ownerId, step: 'source-choice', data: { sourceId: source.id },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: source.id,
      prompt: '【蓍算】：选择一项', timeoutMs: 20_000, optional: false, options,
    }),
  })
}

registerSkillRuntime({
  id: ZONGLUE,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(ZONGLUE)) return []
    return [{ id: ZONGLUE, label: '纵掠：将1张牌当【杀】使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZONGLUE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(ZONGLUE)) return
    host.askSkill({
      skillId: ZONGLUE, ownerId, step: 'pick-card', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【纵掠】：选择1张牌当【杀】使用', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: ZONGLUE, ownerId, step: 'pick-target', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【纵掠】：选择目标', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-target') {
      const { cardId } = resolution.data as { cardId: CardId }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive || !owner.zones.hand.includes(cardId)) return
      owner.turnUsedSkills.push(ZONGLUE)
      host.dispatch('SkillActivated', { skillId: ZONGLUE, skillName: '纵掠', playerId: ownerId, logText: `${owner.nickname}发动【纵掠】` }, { sourceId: ownerId, targetId })
      host.state.niufuZongluePending = { ownerId, targetId, cardId }
      // beginVirtualSlash 要求 cardId 的有效牌名本来就是"杀"；纵掠是把任意一张
      // 牌当杀用，走 executeUseCardAction 的 asCardName 转化，和多子卡当杀
      // （马休马铁【垦伤】）同一条路子。
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `zonglue:${cardId}`, playerId: ownerId,
        cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1,
        asCardName: '杀', label: '【纵掠】：当【杀】使用',
      })
      return
    }
    if (resolution.step === 'pick-loot') {
      const { targetId, zones } = resolution.data as { targetId: PlayerId; zones: Array<{ kind: 'equipment' | 'judgingArea'; slot?: EquipmentSlot; cardId: CardId }> }
      const chosenIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      for (const entry of zones) {
        if (!chosenIds.includes(entry.cardId)) continue
        if (entry.kind === 'equipment' && entry.slot) {
          moveCard(host.state, entry.cardId, { kind: 'equipment', playerId: targetId, slot: entry.slot }, { kind: 'hand', playerId: ownerId })
          handleEquipmentLost(host as never, targetId, entry.cardId)
        } else {
          moveCard(host.state, entry.cardId, { kind: 'judgingArea', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        }
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [entry.cardId], reason: ZONGLUE }, { sourceId: targetId, targetId: ownerId, cardIds: [entry.cardId] })
      }
    }
  },
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const pending = host.state.niufuZongluePending
      if (!pending || pending.ownerId !== ownerId || context.event.sourceId !== ownerId || context.event.targetId !== pending.targetId) return
      host.state.niufuZongluePending = undefined
      const cardName = host.state.cards[pending.cardId]?.name
      if (cardName === '杀') return
      const target = playerOf(host.state, pending.targetId)
      const owner = playerOf(host.state, ownerId)
      if (!target?.alive || !owner?.alive) return
      if (target.zones.hand.length > 0) {
        const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
        moveCard(host.state, cardId, { kind: 'hand', playerId: pending.targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZONGLUE }, { sourceId: pending.targetId, targetId: ownerId, cardIds: [cardId] })
      }
      const zones: Array<{ kind: 'equipment' | 'judgingArea'; slot?: EquipmentSlot; cardId: CardId }> = []
      for (const [slot, cardId] of Object.entries(target.zones.equipment)) {
        if (cardId) { zones.push({ kind: 'equipment', slot: slot as EquipmentSlot, cardId }); break }
      }
      if (target.zones.judgingArea.length > 0) zones.push({ kind: 'judgingArea', cardId: target.zones.judgingArea[0] })
      if (zones.length === 0) return
      host.askSkill({
        skillId: ZONGLUE, ownerId, step: 'pick-loot', data: { targetId: pending.targetId, zones },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【纵掠】：选择获得装备区/判定区各至多1张牌', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: zones.map((entry) => entry.cardId), hiddenCardSlots: [], min: 0, max: zones.length,
        }),
      })
    },
  }],
})

export const NIUFU: CharacterDefinition = {
  id: 'niufu',
  name: '牛辅',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: SHISUAN, name: '蓍算', description: '锁定技，受到伤害后，弃置1张牌，然后伤害来源选择：失去1点体力；交给你其装备区1张牌；将其武将牌翻面。' },
    { id: ZONGLUE, name: '纵掠', description: '出牌阶段限一次，将1张牌当【杀】使用；若此杀造成伤害后该牌不是【杀】，你获得目标手牌区（随机1张）、装备区、判定区各至多1张牌。' },
  ],
}
