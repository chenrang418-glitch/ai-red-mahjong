import { drawCards } from '../../engine/draw'
import { movePickedCard } from '../../engine/card-pick'
import { giveCards } from '../../engine/hand-transfer'
import { getDistance } from '../../engine/distance'
import { isSlotAbolished } from '../../engine/equipment-slots'
import { executeUseCardAction } from '../../engine/cards/basic'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 吕范（三国杀 OL 经典身份 SP）。
 *
 * 【调度】：出牌阶段开始时，可以获得距离1以内一名角色装备区1张牌，然后将
 *          其交给另一名角色。若该角色使用此牌，你摸1；若不使用，其摸1。
 * 【典财】：其他角色出牌阶段结束时，若你于此阶段失去至少X张牌
 *          （X=min(你当前体力值,5)），你可以将手牌摸至你的体力上限。
 */

const DIAODU = 'diaodu'
const DIANCAI = 'diancai'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function equippedCardsOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  return Object.values(player.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))
}

registerSkillRuntime({
  id: DIAODU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && getDistance(host.state, ownerId, candidate.id) <= 1 && equippedCardsOf(host.state, candidate.id).length > 0).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: DIAODU, ownerId, step: 'pick-source', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-source') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: DIAODU, ownerId, step: 'pick-source', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【调度】：选择距离1以内一名角色，获得其装备区1张牌', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-source') {
      const [sourceId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      const equipped = sourceId ? equippedCardsOf(host.state, sourceId) : []
      if (!owner?.alive || !source?.alive || equipped.length === 0) return
      if (equipped.length === 1) { commitDiaoduTake(host, ownerId, sourceId!, equipped[0]); return }
      host.askSkill({
        skillId: DIAODU, ownerId, step: 'pick-card', data: { sourceId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【调度】：选择获得${source.nickname}装备区的1张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: equipped, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-card') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !cardId || !equippedCardsOf(host.state, sourceId).includes(cardId)) return
      commitDiaoduTake(host, ownerId, sourceId, cardId)
      return
    }
    if (resolution.step === 'pick-recipient') {
      const { cardId } = resolution.data as { cardId: CardId }
      const [recipientId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !recipientId || !owner.zones.hand.includes(cardId)) return
      const recipient = playerOf(host.state, recipientId)
      if (!recipient?.alive) return
      giveCards(host as never, ownerId, recipientId, [cardId], DIAODU)
      const card = host.state.cards[cardId]
      const slot = card?.equipmentSlot as EquipmentSlot | undefined
      const canUse = Boolean(slot) && !isSlotAbolished(host.state, recipientId, slot!)
      const options = [{ id: 'no', label: '不使用' }]
      if (canUse) options.unshift({ id: 'yes', label: `使用【${card?.name}】` })
      host.askSkill({
        skillId: DIAODU, ownerId, step: 'ask-use', data: { cardId, recipientId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: recipientId,
          prompt: `【调度】：是否使用${card?.name ?? ''}？`, timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }
    if (resolution.step === 'ask-use') {
      const { cardId, recipientId } = resolution.data as { cardId: CardId; recipientId: PlayerId }
      const recipient = playerOf(host.state, recipientId)
      if (!owner?.alive || !recipient?.alive || !recipient.zones.hand.includes(cardId)) return
      const accepted = (response.payload as { optionId?: string }).optionId === 'yes'
      if (accepted) {
        const card = host.state.cards[cardId]
        executeUseCardAction(host as never, recipientId, {
          id: `diaodu-use:${cardId}`, kind: 'use-card', playerId: recipientId, label: '',
          cardIds: [cardId], targetIds: [recipientId], targetMin: 1, targetMax: 1, asCardName: card?.name ?? '',
        })
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      } else {
        drawCards(host.state, host.rng, recipientId, 1, (name, payload) => { host.dispatch(name, payload) })
      }
    }
  },
})

function commitDiaoduTake(host: SkillHost, ownerId: PlayerId, sourceId: PlayerId, cardId: CardId): void {
  const owner = playerOf(host.state, ownerId)!
  host.dispatch('SkillActivated', { skillId: DIAODU, skillName: '调度', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【调度】` }, { sourceId: ownerId, targetId: sourceId })
  movePickedCard(host as never, sourceId, cardId, { kind: 'hand', playerId: ownerId })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: DIAODU }, { sourceId, targetId: ownerId, cardIds: [cardId] })
  const recipientIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
  if (recipientIds.length === 0) return
  host.askSkill({
    skillId: DIAODU, ownerId, step: 'pick-recipient', data: { cardId },
    build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId,
      prompt: '【调度】：将这张牌交给另一名角色', timeoutMs: 20_000, optional: false,
      candidateIds: recipientIds, min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: DIANCAI,
  triggers: [
    {
      // 记账窗口：谁的出牌阶段都要重置——典财数的是"吕范自己"在这个出牌阶段
      // 实例里失去的牌，不是阶段主人的牌。
      event: 'PlayPhase',
      handle(host, ownerId, context) {
        void ownerId
        const payload = context.event.payload as { playerId?: PlayerId }
        if (!payload.playerId) return
        host.state.diancaiLedger = { phaseInstanceId: `play-${host.state.turnNumber}-${host.state.seq}`, playPlayerId: payload.playerId, count: 0 }
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const ledger = host.state.diancaiLedger
        if (!ledger) return
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId !== ownerId) return
        ledger.count += (payload.cardIds ?? []).length
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || !payload.playerId || payload.playerId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const ledger = host.state.diancaiLedger
        const lost = ledger && ledger.playPlayerId === payload.playerId ? ledger.count : 0
        const threshold = Math.min(owner.hp, 5)
        if (threshold <= 0 || lost < threshold) return
        host.queueSkill({ skillId: DIANCAI, ownerId, step: 'ask', data: {} })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: DIANCAI, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【典财】：是否将手牌摸至体力上限？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【典财】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const n = owner.maxHp - owner.zones.hand.length
    if (n <= 0) return
    host.dispatch('SkillActivated', { skillId: DIANCAI, skillName: '典财', playerId: ownerId, logText: `${owner.nickname}发动【典财】，摸牌至体力上限` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, n, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const LVFAN: CharacterDefinition = {
  id: 'lvfan',
  name: '吕范',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: DIAODU, name: '调度', description: '出牌阶段开始时，可以获得距离1以内一名角色装备区1张牌，然后将其交给另一名角色。若该角色使用此牌，你摸1；若不使用，其摸1。' },
    { id: DIANCAI, name: '典财', description: '其他角色出牌阶段结束时，若你于此阶段失去至少X张牌（X为你当前体力值且最多5），你可以将手牌摸至体力上限。' },
  ],
}
