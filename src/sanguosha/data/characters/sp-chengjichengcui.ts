import { moveCard } from '../../engine/zones'
import { executeUseCardAction } from '../../engine/cards/basic'
import { applyForcedIdentity } from '../../engine/forced-identity'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 成济成倅（三国杀 OL 经典身份 SP）。
 *
 * 【透髓】：将任意张（至少1张）牌置于牌堆底，视为使用一张【杀】；这张杀
 *          需要N张【闪】才能抵消（N=置入牌堆底的牌数）。
 * 【畜鸣】：锁定技，成济成倅对其他角色造成的伤害，或其他角色对他造成的
 *          伤害：若没有实体牌造成，此伤害+1；若有实体牌造成，本回合结束时
 *          由另一方将当时那张实体牌（若仍在弃牌堆）拿回手里，自己选择将其
 *          当【过河拆桥】或【借刀杀人】对成济成倅使用——用的是真实那张牌，
 *          不生成虚拟牌，靠 `applyForcedIdentity` 的按 Card ID 身份改写
 *          （scope:'card'）实现。
 */

const TOUSUI = 'tousui'
const CHUMING = 'chuming'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: TOUSUI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: TOUSUI, label: '透髓：将任意张牌置于牌堆底，视为使用一张杀' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== TOUSUI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: TOUSUI, ownerId, step: 'pick-cards', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【透髓】：选择任意张牌置于牌堆底', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-cards') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (valid.length === 0) return
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: TOUSUI }, { sourceId: ownerId, cardIds: valid })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: TOUSUI, ownerId, step: 'pick-target', data: { n: valid.length },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【透髓】：选择视为使用【杀】的目标', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-target') {
      const { n } = resolution.data as { n: number }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.dispatch('SkillActivated', { skillId: TOUSUI, skillName: '透髓', playerId: ownerId, logText: `${owner.nickname}发动【透髓】，需要${n}张闪才能抵消` }, { sourceId: ownerId, targetId })
      host.state.chengjiTousuiPending = { ownerId, targetId, n }
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: TOUSUI })
    }
  },
  dodgeResponsesFor(state, ownerId, sourceId, targetId) {
    const pending = state.chengjiTousuiPending
    if (!pending || pending.ownerId !== ownerId || pending.ownerId !== sourceId || pending.targetId !== targetId) return 1
    return pending.n
  },
  triggers: [{
    event: 'CardResolved',
    handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId) host.state.chengjiTousuiPending = undefined
    },
  }],
})

registerSkillRuntime({
  id: CHUMING,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      if (!targetId) return
      const isOwnerSource = sourceId === ownerId && targetId !== ownerId
      const isOwnerTarget = targetId === ownerId && sourceId && sourceId !== ownerId
      if (!isOwnerSource && !isOwnerTarget) return
      const payload = context.event.payload as { amount?: number; cardId?: CardId | null; cardName?: string | null }
      const otherId = isOwnerSource ? targetId : sourceId!
      if (!payload.cardId) {
        payload.amount = (typeof payload.amount === 'number' ? payload.amount : 0) + 1
        host.dispatch('SkillActivated', { skillId: CHUMING, skillName: '畜鸣', playerId: ownerId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【畜鸣】，伤害+1` }, { sourceId: ownerId })
        return
      }
      host.state.chengjiChumingPending = { turnNumber: host.state.turnNumber, ownerId, otherId, cardId: payload.cardId }
    },
  }, {
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      if ((context.event.payload as { phase?: string }).phase !== 'discard') return
      const pending = host.state.chengjiChumingPending
      if (!pending || pending.turnNumber !== host.state.turnNumber || pending.ownerId !== ownerId) return
      host.state.chengjiChumingPending = undefined
      if (!host.state.zones.discardPile.includes(pending.cardId)) return
      const other = playerOf(host.state, pending.otherId)
      const owner = playerOf(host.state, ownerId)
      if (!other?.alive || !owner?.alive) return
      const canDismantle = owner.zones.hand.length > 0 || Object.values(owner.zones.equipment).some(Boolean)
      const canBorrow = !!owner.zones.equipment.weapon
      if (!canDismantle && !canBorrow) return
      // 真实那张牌拿回手里，之后按选定的牌名走标准使用管线，不生成虚拟牌
      moveCard(host.state, pending.cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: pending.otherId })
      host.dispatch('GainCard', { playerId: pending.otherId, cardIds: [pending.cardId], reason: CHUMING }, { targetId: pending.otherId, cardIds: [pending.cardId] })
      const options: Array<{ id: string; label: string }> = []
      if (canDismantle) options.push({ id: '过河拆桥', label: '当【过河拆桥】使用' })
      if (canBorrow) options.push({ id: '借刀杀人', label: '当【借刀杀人】使用' })
      host.queueSkill({ skillId: CHUMING, ownerId, step: 'declare', data: { cardId: pending.cardId, otherId: pending.otherId, options } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'declare') return
    const { cardId, otherId, options } = prompt.data as { cardId: CardId; otherId: PlayerId; options: Array<{ id: string; label: string }> }
    const other = playerOf(host.state, otherId)
    if (!other?.alive || !other.zones.hand.includes(cardId)) return
    host.askSkill({
      skillId: CHUMING, ownerId, step: 'declare', data: { cardId, otherId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: otherId,
        prompt: '【畜鸣】：将这张牌当哪张牌对成济成倅使用？', timeoutMs: 20_000, optional: false, options,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'declare') return
    const { cardId, otherId } = resolution.data as { cardId: CardId; otherId: PlayerId }
    const other = playerOf(host.state, otherId)
    const owner = playerOf(host.state, ownerId)
    const declared = (response.payload as { optionId?: string }).optionId
    if (!other?.alive || !owner?.alive || !other.zones.hand.includes(cardId) || (declared !== '过河拆桥' && declared !== '借刀杀人')) return
    applyForcedIdentity(host.state, {
      ownerId: otherId, scope: 'card', cardId, asCardName: declared, nature: 'normal',
      ignoreDistance: false, unlimitedUses: false, skillId: CHUMING, expiry: 'manual',
    })
    host.dispatch('SkillActivated', { skillId: CHUMING, skillName: '畜鸣', playerId: ownerId, logText: `${other.nickname}将造成伤害的牌当【${declared}】对${owner.nickname}使用` }, { sourceId: otherId, targetId: ownerId })
    executeUseCardAction(host as never, otherId, {
      kind: 'use-card', id: `chuming:${cardId}`, playerId: otherId,
      cardIds: [cardId], targetIds: [ownerId], targetMin: 1, targetMax: 1,
      asCardName: declared, label: `【畜鸣】：当【${declared}】使用`,
    })
  },
})

export const CHENGJI_CHENGCUI: CharacterDefinition = {
  id: 'chengjichengcui',
  name: '成济成倅',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: TOUSUI, name: '透髓', description: '将任意张（至少1张）牌置于牌堆底，视为使用一张【杀】，需要N张【闪】才能抵消（N=置入的牌数）。' },
    { id: CHUMING, name: '畜鸣', description: '锁定技，你对其他角色造成的伤害或其他角色对你造成的伤害：若没有实体牌造成，此伤害+1；若有，本回合结束时由另一方将该牌视为对你使用一张【过河拆桥】。' },
  ],
}
