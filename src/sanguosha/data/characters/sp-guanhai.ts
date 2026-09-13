import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { canTarget } from '../../engine/distance'
import { canUseSlash, hasSlashUsesBypass } from '../../engine/slash-rules'
import { hasUnlimitedSlash } from '../../engine/equipment'
import { startPindian, registerPindianContinuation } from '../../engine/pindian'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 管亥（三国杀 OL 经典身份 SP）。
 *
 * 【卸尾】：需要使用【杀】或使用/打出【闪】时，可以将2张手牌置于武将牌上
 *          （称为"饵"，可累积），视为使用一张【杀】或打出一张【闪】。杀走
 *          `beginVirtualSlash` 纯虚拟杀；闪走引擎已有的"成为杀目标后插入
 *          发问"（`interceptTarget`）+ 目标取消（等价于成功闪避的伤害
 *          结果，官方"视为打出一张闪"的规则效果与之一致）。
 * 【诱阙】：出牌阶段，若拥有黑桃"饵"，可用点数最小的一枚"饵"与一名角色
 *          拼点（复用拼点核心新增的 `initiatorForcedCardId` 强制拼点牌
 *          接口）；没赢的角色弃置点数大于其拼点牌的所有手牌，然后视为
 *          对赢的角色使用一张杀；这张杀造成伤害后管亥摸2张牌；若结算后
 *          管亥没有黑桃"饵"，本 Play Phase【诱阙】失效。
 */

const XIEWEI = 'xiewei'
const XIEWEI_INVOKE = 'xiewei-invoke'
const BAIT_PILE = 'er'
const YOUQUE = 'youque'
const YOUQUE_INVOKE = 'youque-invoke'
const YOUQUE_TAG = 'youque-pindian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function baitOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  return playerOf(state, playerId)?.characterPiles[BAIT_PILE] ?? []
}

function hasSpadeBait(state: SanguoshaState, playerId: PlayerId): boolean {
  return baitOf(state, playerId).some((cardId) => state.cards[cardId]?.suit === 'spade')
}

function youqueDisabled(state: SanguoshaState, ownerId: PlayerId): boolean {
  const entry = state.guanhaiYouqueDisabled
  return !!entry && entry.turnNumber === state.turnNumber && entry.ownerId === ownerId
}

registerSkillRuntime({
  id: XIEWEI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return []
    if (!canUseSlash(state, ownerId, hasUnlimitedSlash(state, ownerId)) && !hasSlashUsesBypass(state, ownerId)) return []
    return [{ id: XIEWEI_INVOKE, label: '卸尾：将2张手牌置为饵，视为使用一张【杀】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== XIEWEI_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return
    host.askSkill({
      skillId: XIEWEI, ownerId, step: 'pick-cards', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【卸尾】：选择2张手牌置为"饵"', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
      }),
    })
  },
  interceptTarget(host, ownerId, context) {
    if (context.cardName !== '杀') return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return false
    host.askSkill({
      skillId: XIEWEI, ownerId, step: 'dodge-ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【卸尾】：是否将2张手牌置为"饵"，视为打出一张【闪】？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-cards') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (valid.length !== 2) return
      for (const id of valid) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: BAIT_PILE })
      host.dispatch('SkillActivated', { skillId: XIEWEI, skillName: '卸尾', playerId: ownerId, logText: `${owner.nickname}发动【卸尾】，置入2枚"饵"` }, { sourceId: ownerId })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && canTarget(host.state, ownerId, candidate.id)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: XIEWEI, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【卸尾】：选择视为使用【杀】的目标', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || targetId === ownerId || !playerOf(host.state, targetId)?.alive) return
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: XIEWEI })
      return
    }

    if (resolution.step === 'dodge-ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'yes' || owner.zones.hand.length < 2) { host.resumeCardTarget(); return }
      host.askSkill({
        skillId: XIEWEI, ownerId, step: 'dodge-pick', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【卸尾】：选择2张手牌置为"饵"', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
        }),
      })
      return
    }

    if (resolution.step === 'dodge-pick') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (valid.length !== 2) { host.resumeCardTarget(); return }
      for (const id of valid) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: BAIT_PILE })
      const current = host.state.cardResolution
      if (current?.kind === 'slash' && current.targetId === ownerId) current.targetCancelled = true
      host.dispatch('SkillActivated', { skillId: XIEWEI, skillName: '卸尾', playerId: ownerId, logText: `${owner.nickname}发动【卸尾】，视为打出一张【闪】` }, { sourceId: ownerId })
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({
  id: YOUQUE,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || youqueDisabled(state, ownerId)) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || !hasSpadeBait(state, ownerId)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)) return []
    return [{ id: YOUQUE_INVOKE, label: '诱阙：用点数最小的"饵"与一名角色拼点' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YOUQUE_INVOKE || youqueDisabled(host.state, ownerId)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !hasSpadeBait(host.state, ownerId)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: YOUQUE, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【诱阙】：选择一名角色拼点', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive || target.zones.hand.length === 0) return
    const bait = baitOf(host.state, ownerId)
    if (bait.length === 0) return
    const minRank = Math.min(...bait.map((cardId) => host.state.cards[cardId]?.rank ?? 99))
    const lowest = bait.filter((cardId) => (host.state.cards[cardId]?.rank ?? 99) === minRank)
    const chosen = lowest[host.rng.nextInt(lowest.length)]
    if (!chosen) return
    startPindian(host as never, {
      id: `youque-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
      reason: YOUQUE, continuationTag: YOUQUE_TAG, timeoutMs: 20_000,
      initiatorForcedCardId: chosen,
    })
  },
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const pending = host.state.guanhaiPendingSlashDamage
      if (!pending || pending.turnNumber !== host.state.turnNumber || pending.sourceId !== context.event.sourceId || pending.targetId !== context.event.targetId) return
      const payload = context.event.payload as { cardName?: string }
      host.state.guanhaiPendingSlashDamage = undefined
      if (payload.cardName !== '杀') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      drawCards(host.state, host.rng, ownerId, 2, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      host.dispatch('SkillActivated', { skillId: YOUQUE, skillName: '诱阙', playerId: ownerId, logText: `${owner.nickname}发动【诱阙】，摸2张牌` }, { sourceId: ownerId })
    },
  }],
})

registerPindianContinuation(YOUQUE_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  if (result.outcome === 'tie') return
  const winnerId = result.outcome === 'initiator-win' ? result.initiatorId : result.opponentId
  const loserId = result.outcome === 'initiator-win' ? result.opponentId : result.initiatorId
  const loserRank = result.outcome === 'initiator-win' ? result.opponentRank : result.initiatorRank
  const loser = playerOf(host.state, loserId)
  const winner = playerOf(host.state, winnerId)
  if (!loser?.alive || !winner?.alive) return
  const toDiscard = loser.zones.hand.filter((cardId) => (host.state.cards[cardId]?.rank ?? 0) > loserRank)
  if (toDiscard.length > 0) {
    for (const cardId of toDiscard) moveCard(host.state, cardId, { kind: 'hand', playerId: loserId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: loserId, cardIds: toDiscard, reason: YOUQUE }, { sourceId: loserId, cardIds: toDiscard })
  }
  const ownerId = result.initiatorId
  host.state.guanhaiPendingSlashDamage = { turnNumber: host.state.turnNumber, sourceId: loserId, targetId: winnerId }
  skillHost.beginVirtualSlash({ sourceId: loserId, targetId: winnerId, sourceSkillId: YOUQUE })
  if (!hasSpadeBait(host.state, ownerId)) {
    host.state.guanhaiYouqueDisabled = { turnNumber: host.state.turnNumber, ownerId }
  }
})

export const GUANHAI: CharacterDefinition = {
  id: 'guanhai',
  name: '管亥',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: XIEWEI, name: '卸尾', description: '需要使用【杀】或使用/打出【闪】时，可以将2张手牌置于武将牌上（称为"饵"，可累积），视为使用一张【杀】或打出一张【闪】。' },
    { id: YOUQUE, name: '诱阙', description: '出牌阶段，若拥有黑桃"饵"，可用点数最小的一枚"饵"与一名角色拼点，没赢的角色弃置点数大于其拼点牌的所有手牌，视为对赢的角色使用一张【杀】，此杀造成伤害后你摸2张牌；结算后若你没有黑桃"饵"，本回合出牌阶段此技能失效。' },
  ],
}
