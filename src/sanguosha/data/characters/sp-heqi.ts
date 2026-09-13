import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { cancelCardTargetForOwner } from '../../engine/target-cancellation'
import { getDistance, getAttackRange } from '../../engine/distance'
import { equipmentSlotsOf } from '../../engine/equipment-slots'
import { registerSkillRuntime, replaceTemporarySkills, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, DistributeCardsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 贺齐（三国杀 OL 经典身份 SP）。
 *
 * 【绮胄】：锁定技，你根据装备区里牌的花色数获得以下技能：1种以上-短兵；
 *          2种以上-英姿；3种以上-奋威；4种-澜疆（复用已有的 'yingzi'）。
 * 【闪袭】：出牌阶段限一次，X=你当前空装备栏数量，选择一名攻击范围不包含
 *          你的其他角色A，你与其至多共展示X张手牌，弃置其中所有的闪；
 *          若确实弃置了闪，你获得A一张本次未被展示的牌。
 *
 * 短兵/奋威/澜疆本项目此前不存在，按官方文本各自实现；短兵官方原文本身
 * 只是"可多选一名距离1的角色为目标"，未强制新目标必须为距离1
 * （引擎的 extraSlashTargets 只按数量+1，不做距离过滤），这是相对官方
 * 文本的已知简化，已在批次回复里说明。
 */

const QIZHOU = 'qizhou'
const SHANXI = 'shanxi'
const DUANBING = 'duanbing'
const YINGZI = 'yingzi'
const FENWEI = 'fenwei'
const LANJIANG = 'lanjiang'
const WEI_PILE = 'fenwei-wei'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function grantedQizhouSkillsOf(state: SanguoshaState, ownerId: PlayerId): string[] {
  return (state.players.find((candidate) => candidate.id === ownerId)?.temporaryGrantedSkills ?? [])
    .filter((entry) => entry.source === QIZHOU)
    .map((entry) => entry.skillId)
}

function recomputeQizhou(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const before = grantedQizhouSkillsOf(host.state, ownerId)
  if (!owner?.alive) { replaceTemporarySkills(host.state, ownerId, QIZHOU, []); return }
  const suits = new Set(
    Object.values(owner.zones.equipment)
      .filter((cardId): cardId is CardId => Boolean(cardId))
      .map((cardId) => host.state.cards[cardId]?.suit)
      .filter((suit) => Boolean(suit)),
  )
  const tiers = [DUANBING, YINGZI, FENWEI, LANJIANG]
  const next = tiers.slice(0, suits.size)
  replaceTemporarySkills(host.state, ownerId, QIZHOU, next)
  if (next.length !== before.length || next.some((id, index) => id !== before[index])) {
    host.dispatch('SkillActivated', { skillId: QIZHOU, skillName: '绮胄', playerId: ownerId, logText: `${owner.nickname}的【绮胄】重新结算：${next.length > 0 ? next.join('、') : '（无）'}` }, { sourceId: ownerId })
  }
}

registerSkillRuntime({
  id: QIZHOU,
  onGameStart(host, ownerId) { recomputeQizhou(host, ownerId) },
  triggers: [
    {
      event: 'EquipmentZoneLoss',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        recomputeQizhou(host, ownerId)
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId }
        if (!payload.cardId || host.state.cards[payload.cardId]?.category !== 'equipment') return
        recomputeQizhou(host, ownerId)
      },
    },
  ],
})

registerSkillRuntime({
  id: DUANBING,
  extraSlashTargets() { return 1 },
})

registerSkillRuntime({
  id: FENWEI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(FENWEI) || owner.zones.hand.length === 0) return []
    return [{ id: FENWEI, label: '奋威：至多将3张手牌置于至多3名角色武将牌上，称为"威"，摸等量的牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== FENWEI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(FENWEI) || owner.zones.hand.length === 0) return
    owner.usedLimitedSkills.push(FENWEI)
    const recipientIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: FENWEI, ownerId, step: 'place', data: {},
      build: (requestId): DistributeCardsRequest => ({
        id: requestId, kind: 'distribute-cards', playerId: ownerId,
        prompt: '【奋威】：至多将3张手牌置于至多3名角色的武将牌上（每人1张），称为"威"',
        timeoutMs: 25_000, optional: true,
        cardIds: [...owner.zones.hand], recipientIds, min: 0, max: 3,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'place') {
      if (!owner?.alive) return
      const assignments = (response.payload as { assignments?: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments ?? []
      const usedRecipients = new Set<PlayerId>()
      const placed: Array<{ recipientId: PlayerId; cardId: CardId }> = []
      for (const entry of assignments) {
        if (!entry?.cardId || !entry.recipientId || placed.length >= 3) continue
        if (usedRecipients.has(entry.recipientId)) continue
        if (!owner.zones.hand.includes(entry.cardId)) continue
        if (!playerOf(host.state, entry.recipientId)?.alive) continue
        usedRecipients.add(entry.recipientId)
        placed.push(entry)
      }
      if (placed.length === 0) return
      host.dispatch('SkillActivated', { skillId: FENWEI, skillName: '奋威', playerId: ownerId, logText: `${owner.nickname}发动【奋威】，放置${placed.length}张"威"` }, { sourceId: ownerId })
      for (const { recipientId, cardId } of placed) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: recipientId, pile: WEI_PILE })
      }
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: placed.map((entry) => entry.cardId), reason: FENWEI }, { sourceId: ownerId, cardIds: placed.map((entry) => entry.cardId) })
      drawCards(host.state, host.rng, ownerId, placed.length, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    if (resolution.step === 'cancel-ask') {
      const { targetId, weiCardId } = resolution.data as { targetId: PlayerId; weiCardId: CardId }
      const accepted = (response.payload as { optionId?: string }).optionId === 'yes'
      const target = playerOf(host.state, targetId)
      if (!accepted || !owner?.alive || !target?.alive || !target.characterPiles?.[WEI_PILE]?.includes(weiCardId)) {
        host.resumeCardTarget()
        return
      }
      moveCard(host.state, weiCardId, { kind: 'characterPile', playerId: targetId, pile: WEI_PILE }, { kind: 'discardPile' })
      cancelCardTargetForOwner(host, ownerId)
      host.dispatch('SkillActivated', { skillId: FENWEI, skillName: '奋威', playerId: ownerId, targetId, logText: `${owner.nickname}发动【奋威】，弃置"威"取消${target.nickname}的目标` }, { sourceId: ownerId, targetId })
      host.resumeCardTarget()
    }
  },
  interceptBystanderTarget(host, ownerId, context) {
    if (context.category !== 'trick') return false
    const target = playerOf(host.state, context.targetId)
    const weiPile = target?.characterPiles?.[WEI_PILE] ?? []
    if (weiPile.length === 0) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    host.askSkill({
      skillId: FENWEI, ownerId, step: 'cancel-ask', data: { targetId: context.targetId, weiCardId: weiPile[0] },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【奋威】：弃置${target!.nickname}的"威"，取消其作为此锦囊目标？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '弃置"威"，取消目标' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
})

function askLanjiangDraw(host: SkillHost, ownerId: PlayerId, data: { candidateIds: PlayerId[]; index: number }): void {
  const { candidateIds, index } = data
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const targetId = candidateIds[index]
  const target = targetId ? playerOf(host.state, targetId) : undefined
  if (!target?.alive) {
    if (index + 1 < candidateIds.length) { askLanjiangDraw(host, ownerId, { candidateIds, index: index + 1 }); return }
    startLanjiangPhase2(host, ownerId)
    return
  }
  host.askSkill({
    skillId: LANJIANG, ownerId, step: 'ask-draw', data,
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: targetId,
      prompt: `【澜疆】：是否让${owner.nickname}摸一张牌？`, timeoutMs: 15_000, optional: true,
      options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }],
    }),
  })
}

function startLanjiangPhase2(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const equalIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length === owner.zones.hand.length).map((candidate) => candidate.id)
  if (equalIds.length === 0) { startLanjiangPhase3(host, ownerId); return }
  host.askSkill({
    skillId: LANJIANG, ownerId, step: 'damage-target', data: {},
    build: (requestId: string): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId,
      prompt: '【澜疆】：可以对一名手牌数与你相同的角色造成1点伤害', timeoutMs: 20_000, optional: true,
      candidateIds: equalIds, min: 0, max: 1,
    }),
  })
}

function startLanjiangPhase3(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const lessIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length < owner.zones.hand.length).map((candidate) => candidate.id)
  if (lessIds.length === 0) return
  host.askSkill({
    skillId: LANJIANG, ownerId, step: 'draw-target', data: {},
    build: (requestId: string): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId,
      prompt: '【澜疆】：可以令一名手牌数比你少的角色摸一张牌', timeoutMs: 20_000, optional: true,
      candidateIds: lessIds, min: 0, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: LANJIANG,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length >= owner.zones.hand.length).map((candidate) => candidate.id)
      if (candidateIds.length === 0) { startLanjiangPhase2(host, ownerId); return }
      host.queueSkill({ skillId: LANJIANG, ownerId, step: 'ask-draw', data: { candidateIds, index: 0 } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask-draw') askLanjiangDraw(host, ownerId, prompt.data as { candidateIds: PlayerId[]; index: number })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask-draw') {
      const { candidateIds, index } = resolution.data as { candidateIds: PlayerId[]; index: number }
      if ((response.payload as { optionId?: string }).optionId === 'yes' && owner?.alive) {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
        host.dispatch('SkillActivated', { skillId: LANJIANG, skillName: '澜疆', playerId: ownerId, logText: `${owner.nickname}发动【澜疆】，摸1张牌` }, { sourceId: ownerId })
      }
      if (index + 1 < candidateIds.length) { askLanjiangDraw(host, ownerId, { candidateIds, index: index + 1 }); return }
      startLanjiangPhase2(host, ownerId)
      return
    }
    if (resolution.step === 'damage-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (targetId && playerOf(host.state, targetId)?.alive && owner?.alive) {
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
      }
      startLanjiangPhase3(host, ownerId)
      return
    }
    if (resolution.step === 'draw-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (targetId && playerOf(host.state, targetId)?.alive) {
        drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
      }
    }
  },
})

function emptySlotCount(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return 0
  return equipmentSlotsOf(state, ownerId).filter((slot) => !owner.zones.equipment[slot as EquipmentSlot]).length
}

registerSkillRuntime({
  id: SHANXI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SHANXI)) return []
    const x = emptySlotCount(state, ownerId)
    if (x <= 0) return []
    const candidateIds = state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && getDistance(state, candidate.id, ownerId) > getAttackRange(state, candidate.id)).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return []
    return [{ id: SHANXI, label: '闪袭：选择攻击范围不包含你的角色，展示手牌并弃闪' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== SHANXI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SHANXI)) return
    const x = emptySlotCount(host.state, ownerId)
    if (x <= 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && getDistance(host.state, candidate.id, ownerId) > getAttackRange(host.state, candidate.id)).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(SHANXI)
    host.askSkill({
      skillId: SHANXI, ownerId, step: 'pick-target', data: { x },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【闪袭】：选择攻击范围不包含你的一名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-target') {
      const { x } = resolution.data as { x: number }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      host.dispatch('SkillActivated', { skillId: SHANXI, skillName: '闪袭', playerId: ownerId, targetId, logText: `${owner.nickname}发动【闪袭】` }, { sourceId: ownerId, targetId })
      const ownMax = Math.min(x, owner.zones.hand.length)
      if (ownMax <= 0) { startShanxiTargetReveal(host, ownerId, targetId, x, []); return }
      host.askSkill({
        skillId: SHANXI, ownerId, step: 'own-reveal', data: { targetId, x },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【闪袭】：展示至多${ownMax}张你的手牌`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: ownMax,
        }),
      })
      return
    }
    if (resolution.step === 'own-reveal') {
      const { targetId, x } = resolution.data as { targetId: PlayerId; x: number }
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((cardId) => owner?.zones.hand.includes(cardId))
      startShanxiTargetReveal(host, ownerId, targetId, x, picked)
      return
    }
    if (resolution.step === 'target-reveal') {
      const { targetId, ownShown } = resolution.data as { targetId: PlayerId; ownShown: CardId[] }
      const target = playerOf(host.state, targetId)
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((cardId) => target?.zones.hand.includes(cardId))
      finishShanxi(host, ownerId, targetId, [...ownShown, ...picked])
    }
  },
})

function startShanxiTargetReveal(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, x: number, ownShown: CardId[]): void {
  const target = playerOf(host.state, targetId)
  const remaining = Math.min(x - ownShown.length, target?.zones.hand.length ?? 0)
  if (remaining <= 0 || !target?.alive) { finishShanxi(host, ownerId, targetId, ownShown); return }
  host.askSkill({
    skillId: SHANXI, ownerId, step: 'target-reveal', data: { targetId, ownShown },
    build: (requestId: string): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: targetId,
      prompt: `【闪袭】：可以展示至多${remaining}张手牌`, timeoutMs: 20_000, optional: true,
      purpose: 'skill', cardIds: [...(target.zones.hand)], hiddenCardSlots: [], min: 0, max: remaining,
    }),
  })
}

function finishShanxi(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, shown: CardId[]): void {
  const target = playerOf(host.state, targetId)
  if (shown.length === 0) return
  host.dispatch('CardMove', { cardIds: shown, reason: 'shanxi', revealed: true }, { sourceId: ownerId })
  const dodgeIds = shown.filter((cardId) => host.state.cards[cardId]?.name === '闪')
  for (const cardId of dodgeIds) {
    const from = target?.zones.hand.includes(cardId) ? { kind: 'hand' as const, playerId: targetId } : { kind: 'hand' as const, playerId: ownerId }
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
  }
  if (dodgeIds.length > 0) {
    host.dispatch('LoseCard', { playerId: targetId, cardIds: dodgeIds, reason: 'shanxi' }, { sourceId: ownerId, cardIds: dodgeIds })
    host.dispatch('SkillActivated', { skillId: SHANXI, skillName: '闪袭', playerId: ownerId, logText: `${playerOf(host.state, ownerId)!.nickname}发动【闪袭】，弃置${dodgeIds.length}张闪` }, { sourceId: ownerId })
    if (target?.alive) {
      const hidden = target.zones.hand.filter((cardId) => !shown.includes(cardId))
      if (hidden.length > 0) {
        const cardId = hidden[host.rng.nextInt(hidden.length)]
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SHANXI }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
    }
  }
}

export const HEQI: CharacterDefinition = {
  id: 'heqi',
  name: '贺齐',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: QIZHOU, name: '绮胄', description: '锁定技，你根据装备区里牌的花色数获得以下技能：1种以上-短兵；2种以上-英姿；3种以上-奋威；4种-澜疆。' },
    { id: SHANXI, name: '闪袭', description: '出牌阶段限一次，X为你当前空装备栏数量，选择一名攻击范围不包含你的其他角色，你与其至多共展示X张手牌，弃置其中所有的闪；若确实弃置了闪，你获得其一张本次未被展示的牌。' },
  ],
}
