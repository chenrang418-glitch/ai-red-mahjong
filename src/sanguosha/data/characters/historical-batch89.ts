import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, UseCardRequest } from '../../engine/requests'
import { registerSkillRuntime, replaceTemporarySkills, recheckZeroHpAfterSkillLoss, type SkillHost } from '../../engine/skills/runtime'
import { moveCard, setCardAlias } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { giveCards, giveOwnedCards } from '../../engine/hand-transfer'
import { discardCardsByIds } from '../../engine/discard-all'
import { DAMAGE_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { isCardUseProhibited, isTargetProhibited, characterSkillIdsOf } from '../../engine/skills/runtime'
import { executeUseCardAction, skillDiscardCardUseActions, skillHandCardUseActions } from '../../engine/cards/basic'
import { beginSkillCardUseFromProcessing, skillProcessingCardUseActions } from '../../engine/cards/basic'
import { beginVirtualSlash } from '../../engine/cards/basic'
import type { LegalAction } from '../../engine/actions'
import { recover } from '../../engine/recover'
import { swapHands } from '../../engine/hand-transfer'
import { loseHp } from '../../engine/hp'
import { recoverTo } from '../../engine/recover'
import { canPindian, claimPindianCards, finishPindianSettlement, registerPindianContinuation, startPindian } from '../../engine/pindian'
import { usedThisPhase, markUsedThisPhase } from '../../engine/phase-usage'
import { canTarget, getAttackRange, getDistance } from '../../engine/distance'
import { startGroupCardDecision, registerGroupCardDecision } from '../../engine/group-card-decision'
import { revealTopCards } from '../../engine/draw'
import { suppressEquipmentEffectsUntilTurnEnd } from '../../engine/equipment-suppression'
import { skillDisplayName } from '../../engine/presentation'

export const XU_KUN_FA_ZHU = 'fa-zhu-xukun-b89'
export const MOU_CAO_ANG_FENG_MIN = 'feng-min-mou-caoang-b89'
export const MOU_CAO_ANG_ZHI_WANG = 'zhi-wang-mou-caoang-b89'
export const LIU_YANG_JING_YIN = 'jing-yin-liuyang-b89'
export const LIU_YANG_CHI_XING = 'chi-xing-liuyang-b89'
export const BIAN_YUE_BI_ZU = 'bi-zu-bianyue-b89'
export const BIAN_YUE_WU_XIE = 'wu-xie-bianyue-b89'
export const MOU_DIANWEI_KANGYONG = 'kang-yong-mou-dianwei-b89'
export const MOU_DIANWEI_KUANGZHAN = 'kuang-zhan-mou-dianwei-b89'
export const MOU_JUSHOU_MUWANG = 'mu-wang-mou-jushou-b89'
export const XING_SUN_SHANGXIANG_SA_YING = 'sa-ying-star-sunshangxiang-b89'
export const XING_SUN_SHANGXIANG_JIAOHAO = 'jiao-hao-star-sunshangxiang-b89'
export const MOU_CHENLIN_YAOZUO = 'yao-zuo-mou-chenlin-b89'
export const MOU_CHENLIN_ZHUANWEN = 'zhuan-wen-mou-chenlin-b89'
export const MOU_HUCHEER_KONGWU = 'kong-wu-mou-hucheer-b89'
export const HUANG_WUDIE_SHUANGRUI = 'shuang-rui-huangwudie-b89'
export const HUANG_WUDIE_FUXIE = 'fu-xie-huangwudie-b89'
export const HUANG_WUDIE_SHOUXING = 'shou-xing-huangwudie-b89'
export const HUANG_WUDIE_SHAXUE = 'sha-xue-huangwudie-b89'
const MOU_DIANWEI_KUANGZHAN_TAG = `${MOU_DIANWEI_KUANGZHAN}:pindian`
const XING_SUN_SHANGXIANG_JIAOHAO_TAG = `${XING_SUN_SHANGXIANG_JIAOHAO}:pindian`
const MOU_CHENLIN_YAOZUO_GROUP = `${MOU_CHENLIN_YAOZUO}:secret-give`

type Batch89State = {
  xukun?: Record<PlayerId, { cards: CardId[]; targets: PlayerId[]; cursor: number }>
  caoangEquipUse?: Record<PlayerId, number>
  caoangZhiWangUse?: Record<PlayerId, { cardId: CardId; actorId: PlayerId }>
  liuyangOffturnUsed?: Record<PlayerId, number>
  liuyangPlaySlashes?: Record<PlayerId, { turnNumber: number; phasePlayerId: PlayerId; cards: CardId[] }>
  bianYueTargets?: Record<PlayerId, { turnNumber: number; counts: Record<string, number>; disabledTurn?: number }>
  mouDianweiHeal?: Record<PlayerId, { turnNumber: number; amount: number }>
  mouDianweiWins?: Record<PlayerId, { turnNumber: number; opponentIds: PlayerId[] }>
  mouDianweiFlow?: Record<PlayerId, { turnNumber: number; remaining: number; awaitingSlash: boolean }>
  mouJushouMuwang?: Record<PlayerId, { turnNumber: number; cardId: CardId }>
  mouJushouLocks?: Record<PlayerId, Array<{ armedAtTurn: number; cardIds: CardId[] }>>
  mouJushouUseFlow?: Record<PlayerId, { cardIds: CardId[]; pendingCardId?: CardId }>
  starSunShangxiangSaYing?: Record<PlayerId, { roundNumber: number; cardNames: string[] }>
  starSunShangxiangJiaohao?: Record<PlayerId, { winnerId: PlayerId; cardIds: CardId[] }>
  mouChenlinIgnoredCards?: Record<PlayerId, CardId[]>
  mouChenlinDamageBonus?: Record<PlayerId, { turnNumber: number; targets: Record<PlayerId, number> }>
  mouChenlinWenzhang?: Record<PlayerId, { targetId: PlayerId; cardIds: CardId[]; damageIds: CardId[]; cursor: number; pendingCardId?: CardId }>
  mouHucheerFlow?: Record<PlayerId, { targetId: PlayerId; remaining: number; damaged: boolean }>
  huangWudieTemporarySkills?: Record<PlayerId, { turnNumber: number; ids: string[] }>
}
const dataOf = (state: SanguoshaState): Batch89State => {
  const root = state as SanguoshaState & { paperSanguoshaB89?: Batch89State }
  return root.paperSanguoshaB89 ??= {}
}
const playerOf = (state: SanguoshaState, id: PlayerId) => state.players.find((player) => player.id === id)
const alive = (host: SkillHost, id: PlayerId) => playerOf(host.state, id)?.alive === true
const isDamageCard = (state: SanguoshaState, id: CardId) => {
  const card = state.cards[id]
  return !!card && (card.name === '杀' || card.name === '火杀' || card.name === '雷杀' || DAMAGE_TRICKS.has(card.name))
}

// 徐琨【筏铸】：先重铸，再逐名分配；每名获得牌的角色各自获得一次不限距离的杀机会。
registerSkillRuntime({
  id: 'zuo-jun-mou-jushou-b89',
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, 'zuo-jun-mou-jushou-b89')) return []
    return [{ id: `skill:zuo-jun-mou-jushou-b89`, label: '发动【佐军】：令一名角色摸三张牌并选择效果' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:zuo-jun-mou-jushou-b89') throw new Error('谋·沮授【佐军】动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, 'zuo-jun-mou-jushou-b89')) return
    markUsedThisPhase(host.state, ownerId, 'zuo-jun-mou-jushou-b89')
    host.askSkill({ skillId: 'zuo-jun-mou-jushou-b89', ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【佐军】：选择一名角色', timeoutMs: 25_000,
      optional: false, candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'TurnEnd', handle(host, _ownerId, context) {
      const { playerId, turnNumber } = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      if (!playerId) return
      const records = dataOf(host.state).mouJushouLocks?.[playerId]
      if (!records) return
      const remaining = records.filter((record) => (turnNumber ?? host.state.turnNumber) <= record.armedAtTurn)
      if (remaining.length) dataOf(host.state).mouJushouLocks![playerId] = remaining
      else delete dataOf(host.state).mouJushouLocks![playerId]
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const playerId = context.event.sourceId
      const flow = playerId ? dataOf(host.state).mouJushouUseFlow?.[playerId] : undefined
      const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
      if (!flow?.pendingCardId || payload.sourceSkillId !== 'zuo-jun-mou-jushou-b89'
        || payload.cardId !== flow.pendingCardId) return
      flow.cardIds = flow.cardIds.filter((cardId) => cardId !== flow.pendingCardId)
      delete flow.pendingCardId
      host.queueSkill({ skillId: 'zuo-jun-mou-jushou-b89', ownerId: playerId!, step: 'use-next-card', data: {} })
    }, allowDeadOwner: true },
  ],
  handLimitExempt(state, ownerId, cardId) {
    return dataOf(state).mouJushouLocks?.[ownerId]?.some((record) => record.cardIds.includes(cardId)) ?? false
  },
  prohibitsCardUse(state, ownerId, context) {
    const locked = new Set(dataOf(state).mouJushouLocks?.[ownerId]?.flatMap((record) => record.cardIds) ?? [])
    return Boolean(context.cardIds?.some((cardId) => locked.has(cardId)))
  },
  prohibitsResponseCard(state, ownerId, _responderId, cardId) {
    return dataOf(state).mouJushouLocks?.[ownerId]?.some((record) => record.cardIds.includes(cardId)) ?? false
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'use-next-card') return
    const flow = dataOf(host.state).mouJushouUseFlow?.[ownerId]
    const target = playerOf(host.state, ownerId)
    if (!flow || !target?.alive) {
      if (flow) discardCardsByIds(host, ownerId, flow.cardIds, 'zuo-jun-mou-jushou-b89')
      delete dataOf(host.state).mouJushouUseFlow?.[ownerId]
      return
    }
    flow.cardIds = flow.cardIds.filter((cardId) => target.zones.hand.includes(cardId))
    const actions = flow.cardIds.flatMap((cardId) => skillHandCardUseActions(host.state, ownerId, cardId))
      .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card'
        && action.cardIds.length === 1 && flow.cardIds.includes(action.cardIds[0]!))
    if (!actions.length) {
      discardCardsByIds(host, ownerId, flow.cardIds, 'zuo-jun-mou-jushou-b89')
      delete dataOf(host.state).mouJushouUseFlow?.[ownerId]
      return
    }
    const actionIds = [...actions.map(({ id }) => id), 'respond-pass']
    host.askSkill({ skillId: 'zuo-jun-mou-jushou-b89', ownerId, step: 'use-card', data: { actionIds }, build: (id): UseCardRequest => ({
      id, kind: 'use-card', playerId: ownerId, prompt: '【佐军】：使用其中任意张牌；选择“不再使用”后弃置其余牌',
      timeoutMs: 25_000, optional: false, actionIds,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.step === 'target'
      ? (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      : undefined
    if (resolution.step === 'target') {
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const drawn = drawCards(host.state, host.rng, targetId!, 3, (name, payload) => host.dispatch(name, payload))
      host.askSkill({ skillId: 'zuo-jun-mou-jushou-b89', ownerId, step: 'mode', data: { targetId, drawn }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: targetId!, prompt: '【佐军】：选择一项', timeoutMs: 25_000, optional: false,
        options: [
          { id: 'seal', label: '这些牌不能使用/打出且不计入手牌上限，直到你的下回合结束' },
          { id: 'use', label: '失去1点体力，摸一张牌，然后使用其中任意张牌' },
        ],
      }) })
      return
    }
    if (resolution.step === 'mode') {
      const { targetId: recipientId, drawn } = resolution.data as { targetId: PlayerId; drawn: CardId[] }
      const target = playerOf(host.state, recipientId)
      const mode = (response.payload as { optionId?: string }).optionId
      if (!target?.alive) return
      if (mode === 'seal') {
        const locks = dataOf(host.state).mouJushouLocks ??= {}
        if (drawn.length) (locks[recipientId] ??= []).push({ armedAtTurn: host.state.turnNumber, cardIds: drawn })
        return
      }
      if (mode !== 'use') return
      loseHp(host, recipientId, 1, 'zuo-jun-mou-jushou-b89')
      if (!playerOf(host.state, recipientId)?.alive) return
      const extra = drawCards(host.state, host.rng, recipientId, 1, (name, payload) => host.dispatch(name, payload))
      dataOf(host.state).mouJushouUseFlow ??= {}
      dataOf(host.state).mouJushouUseFlow![recipientId] = { cardIds: [...drawn, ...extra] }
      host.queueSkill({ skillId: 'zuo-jun-mou-jushou-b89', ownerId: recipientId, step: 'use-next-card', data: {} })
      return
    }
    if (resolution.step !== 'use-card') return
    const flow = dataOf(host.state).mouJushouUseFlow?.[ownerId]
    const actionId = (response.payload as { actionId?: string }).actionId
    if (!flow) return
    if (!actionId || actionId === 'respond-pass') {
      discardCardsByIds(host, ownerId, flow.cardIds.filter((cardId) => playerOf(host.state, ownerId)?.zones.hand.includes(cardId)), 'zuo-jun-mou-jushou-b89')
      delete dataOf(host.state).mouJushouUseFlow?.[ownerId]
      return
    }
    const action = flow.cardIds.flatMap((cardId) => skillHandCardUseActions(host.state, ownerId, cardId))
      .find((candidate): candidate is Extract<LegalAction, { kind: 'use-card' }> => candidate.kind === 'use-card' && candidate.id === actionId)
    if (!action || action.cardIds.length !== 1) {
      host.queueSkill({ skillId: 'zuo-jun-mou-jushou-b89', ownerId, step: 'use-next-card', data: {} })
      return
    }
    flow.pendingCardId = action.cardIds[0]
    executeUseCardAction(host as never, ownerId, { ...action, sourceSkillId: 'zuo-jun-mou-jushou-b89' })
  },
})

registerSkillRuntime({
  id: XU_KUN_FA_ZHU,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || payload.phase !== 'prepare' || !alive(host, ownerId)) return
    host.queueSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'recast', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'recast') {
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
        .filter((id) => !isDamageCard(host.state, id))
      if (!cardIds.length) return
      host.askSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'recast-cards', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【筏铸】：选择任意张区域内非伤害牌重铸',
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: cardIds.length,
      }) })
      return
    }
    if (prompt.step === 'give') {
      const cards = prompt.data.cards as CardId[]
      if (!cards.length) return
      const recipients = host.state.players.filter((player) => player.alive && player.id !== ownerId)
      host.askSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'give-targets', data: { cards }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【筏铸】：选择至多等量角色各获得一张重铸牌',
        timeoutMs: 25_000, optional: true, candidateIds: recipients.map((player) => player.id), min: 0, max: Math.min(cards.length, recipients.length),
      }) })
      return
    }
    if (prompt.step === 'use-slash') {
      const targetId = prompt.data.targetId as PlayerId | undefined
      if (targetId && alive(host, targetId)) host.queueSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'use-next', data: {} })
      return
    }
    if (prompt.step === 'use-next') {
      const flow = dataOf(host.state).xukun?.[ownerId]
      if (!flow || flow.cursor >= flow.targets.length) return
      const userId = flow.targets[flow.cursor]
      if (!userId || !alive(host, userId)) {
        flow.cursor += 1
        host.queueSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'use-next', data: {} })
        return
      }
      const targets = host.state.players.filter((player) => player.alive && player.id !== userId
        && !isTargetProhibited(host.state, userId, player.id, '杀', characterSkillIdsOf))
      if (!targets.length) {
        flow.cursor += 1
        host.queueSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'use-next', data: {} })
        return
      }
      host.askSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'slash-target', data: { targetId: userId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: userId, prompt: '【筏铸】：是否对一名角色使用一张不限距离的【杀】？',
        timeoutMs: 25_000, optional: true, candidateIds: targets.map((player) => player.id), min: 0, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'recast-cards') {
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      const valid = selected.filter((cardId) => (owner.zones.hand.includes(cardId)
        || Object.values(owner.zones.equipment).includes(cardId)) && !isDamageCard(host.state, cardId))
      const actuallyRecast = discardCardsByIds(host as never, ownerId, valid, 'recast', 'other')
      const gained = drawCards(host.state, host.rng, ownerId, actuallyRecast.length, (name, payload) => host.dispatch(name, payload))
      if (gained.length) host.queueSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'give', data: { cards: gained } })
      return
    }
    if (resolution.step === 'give-targets') {
      const cards = resolution.data.cards as CardId[]
      const targets = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])].slice(0, cards.length)
      const distributed: Array<{ targetId: PlayerId; cardId: CardId }> = []
      for (let index = 0; index < targets.length; index += 1) {
        const targetId = targets[index]!
        const cardId = cards[index]!
        if (!alive(host, targetId) || !playerOf(host.state, ownerId)?.zones.hand.includes(cardId)) continue
        const given = giveCards(host, ownerId, targetId, [cardId], XU_KUN_FA_ZHU)
        if (given.length) distributed.push({ targetId, cardId })
      }
      dataOf(host.state).xukun ??= {}
      dataOf(host.state).xukun![ownerId] = { cards: distributed.map((item) => item.cardId), targets: distributed.map((item) => item.targetId), cursor: 0 }
      if (distributed.length) host.queueSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'use-next', data: {} })
      return
    }
    if (resolution.step === 'slash-target') {
      const targets = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const state = dataOf(host.state).xukun?.[ownerId]
      const targetId = state?.targets[state.cursor]
      const selected = targets[0]
      if (targetId && selected && alive(host, targetId) && alive(host, selected)) host.beginVirtualSlash({ sourceId: targetId, targetId: selected,
        sourceSkillId: XU_KUN_FA_ZHU, ignoreDistance: true })
      if (state) state.cursor += 1
      host.queueSkill({ skillId: XU_KUN_FA_ZHU, ownerId, step: 'use-next', data: {} })
    }
  },
})

registerSkillRuntime({
  id: MOU_CAO_ANG_FENG_MIN,
  triggers: [{ event: 'EquipmentZoneLoss', handle(host, ownerId, context) {
    if (!alive(host, ownerId)) return
    const payload = context.event.payload as { playerId?: PlayerId }
    const turn = host.state.turnNumber
    const used = dataOf(host.state).caoangEquipUse ??= {}
    if (used[ownerId] === turn) return
    used[ownerId] = turn
    const target = payload.playerId ? playerOf(host.state, payload.playerId) : undefined
    const empty = target ? Object.values(target.zones.equipment).filter((id) => !id).length : 0
    if (empty > 0) drawCards(host.state, host.rng, ownerId, empty, (name, data) => host.dispatch(name, data))
  } }],
})

registerSkillRuntime({
  id: MOU_CAO_ANG_ZHI_WANG,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId === ownerId && payload.phase === 'end' && alive(host, ownerId))
      host.queueSkill({ skillId: MOU_CAO_ANG_ZHI_WANG, ownerId, step: 'discard-equipment', data: {} })
  } }, { event: 'AfterCardUse', handle(host, ownerId, context) {
    const use = dataOf(host.state).caoangZhiWangUse?.[ownerId]
    if (use && context.event.sourceId === use.actorId && context.event.cardIds?.includes(use.cardId))
      delete dataOf(host.state).caoangZhiWangUse![ownerId]
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'discard-equipment') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const ids = Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))
      if (!ids.length) return
      const discarded = discardCardsByIds(host as never, ownerId, ids, MOU_CAO_ANG_ZHI_WANG)
      if (!discarded.length) return
      const damage = host.state.zones.discardPile.filter((id) => isDamageCard(host.state, id))
      if (damage.length) host.queueSkill({ skillId: MOU_CAO_ANG_ZHI_WANG, ownerId, step: 'choose-damage-card', data: { damage } })
      return
    }
    if (prompt.step === 'choose-damage-card') {
      const candidates = (prompt.data.damage as CardId[]).filter((id) => host.state.zones.discardPile.includes(id) && isDamageCard(host.state, id))
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_CAO_ANG_ZHI_WANG, ownerId, step: 'choose-damage-card', data: { damage: candidates }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【质亡】：选择弃牌堆中的一张伤害牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'choose-actor') {
      const cardId = prompt.data.cardId as CardId
      const actors = host.state.players.filter((player) => player.alive && player.id !== ownerId
        && skillDiscardCardUseActions(host.state, player.id, cardId, MOU_CAO_ANG_ZHI_WANG).length > 0)
      if (!actors.length) return
      host.askSkill({ skillId: MOU_CAO_ANG_ZHI_WANG, ownerId, step: 'choose-actor', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【质亡】：选择一名能使用此牌的其他角色', timeoutMs: 25_000,
        optional: false, candidateIds: actors.map((player) => player.id), min: 1, max: 1,
      }) })
      return
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-damage-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const available = resolution.data.damage as CardId[]
      if (cardId && available.includes(cardId) && host.state.zones.discardPile.includes(cardId))
        host.queueSkill({ skillId: MOU_CAO_ANG_ZHI_WANG, ownerId, step: 'choose-actor', data: { cardId } })
      return
    }
    if (resolution.step === 'choose-actor') {
      const actorId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = resolution.data.cardId as CardId
      if (!actorId || !alive(host, actorId) || !host.state.zones.discardPile.includes(cardId)) return
      const actions = skillDiscardCardUseActions(host.state, actorId, cardId, MOU_CAO_ANG_ZHI_WANG)
      if (!actions.length) return
      host.askSkill({ skillId: MOU_CAO_ANG_ZHI_WANG, ownerId, step: 'use-damage-card', data: { actorId, cardId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: actorId, prompt: '【质亡】：选择使用此伤害牌的合法方式', timeoutMs: 25_000,
        optional: false, options: actions.map((action) => ({ id: action.id, label: action.label })),
      }) })
      return
    }
    if (resolution.step === 'use-damage-card') {
      const actorId = resolution.data.actorId as PlayerId
      const cardId = resolution.data.cardId as CardId
      const actionId = (response.payload as { optionId?: string }).optionId
      if (!actionId || !alive(host, actorId) || !host.state.zones.discardPile.includes(cardId)) return
      const valid = skillDiscardCardUseActions(host.state, actorId, cardId, MOU_CAO_ANG_ZHI_WANG).some((action) => action.id === actionId)
      if (!valid) return
      dataOf(host.state).caoangZhiWangUse ??= {}
      dataOf(host.state).caoangZhiWangUse![ownerId] = { actorId, cardId }
      if (!host.beginSkillCardUseFromDiscard(actorId, cardId, MOU_CAO_ANG_ZHI_WANG, actionId))
        delete dataOf(host.state).caoangZhiWangUse![ownerId]
      return
    }
  },
  modifyDamageSource(state, ownerId, context) {
    const use = dataOf(state).caoangZhiWangUse?.[ownerId]
    return use && context.cardId === use.cardId && context.targetId === ownerId ? null : undefined
  },
})

registerSkillRuntime({
  id: LIU_YANG_JING_YIN,
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; reason?: string; fromKind?: string; fromPlayerId?: PlayerId | null }
      const id = payload.cardId
      if (!id || !alive(host, ownerId) || !payload.fromPlayerId || payload.fromPlayerId === host.state.currentPlayerId
        || host.state.cards[id]?.name !== '杀' && host.state.cards[id]?.name !== '火杀' && host.state.cards[id]?.name !== '雷杀') return
      const used = dataOf(host.state).liuyangOffturnUsed ??= {}
      if (used[ownerId] === host.state.turnNumber) return
      const sourceId = payload.fromPlayerId
      const candidates = host.state.players.filter((player) => player.alive && player.id !== sourceId)
      if (!candidates.length) return
      used[ownerId] = host.state.turnNumber
      host.queueSkill({ skillId: LIU_YANG_JING_YIN, ownerId, step: 'gain-used-slash', data: { cardId: id, sourceId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'gain-used-slash') {
      const candidates = host.state.players.filter((player) => player.alive && player.id !== prompt.data.sourceId)
      host.askSkill({ skillId: LIU_YANG_JING_YIN, ownerId, step: 'choose-recipient', data: prompt.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【经音】：令使用回合外【杀】的角色之外的一名角色获得此【杀】',
        timeoutMs: 25_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 0, max: 1,
      }) })
      return
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = resolution.data.cardId as CardId
      if (!targetId || !alive(host, targetId) || !host.state.zones.discardPile.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: LIU_YANG_JING_YIN }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      return
    }
  },
})

registerSkillRuntime({
  id: LIU_YANG_CHI_XING,
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null; fromKind?: string; reason?: string }
      const id = payload.cardId
      if (!id || !payload.fromPlayerId || payload.fromKind !== 'processingArea' || payload.reason !== 'other'
        || host.state.phase !== 'play' || !host.state.currentPlayerId
        || !['杀', '火杀', '雷杀'].includes(host.state.cards[id]?.name ?? '')) return
      const record = dataOf(host.state).liuyangPlaySlashes ??= {}
      const current = record[ownerId]
      const entry = !current || current.turnNumber !== host.state.turnNumber || current.phasePlayerId !== host.state.currentPlayerId
        ? (record[ownerId] = { turnNumber: host.state.turnNumber, phasePlayerId: host.state.currentPlayerId, cards: [] }) : current
      if (!entry.cards.includes(id)) entry.cards.push(id)
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (!payload.playerId || payload.phase !== 'play') return
      const record = dataOf(host.state).liuyangPlaySlashes?.[ownerId]
      if (record?.turnNumber === host.state.turnNumber && record.phasePlayerId === payload.playerId && record.cards.length) {
        delete dataOf(host.state).liuyangPlaySlashes![ownerId]
        host.queueSkill({ skillId: LIU_YANG_CHI_XING, ownerId, step: 'resolve-phase-slashes', data: { cards: record.cards } })
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'resolve-phase-slashes') {
      const cards = prompt.data.cards as CardId[]
      host.askSkill({ skillId: LIU_YANG_CHI_XING, ownerId, step: 'choose-draw', data: { cards }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【迟行】：是否摸${cards.length}张牌？`, timeoutMs: 25_000,
        optional: true, options: [{ id: 'draw', label: '摸牌并可使用其中一张杀' }, { id: 'skip', label: '不摸牌' }],
      }) })
      return
    }
    if (prompt.step === 'choose-slash') {
      const cards = (prompt.data.cards as CardId[]).filter((id) => host.state.zones.discardPile.includes(id))
      const actions = cards.flatMap((cardId) => skillDiscardCardUseActions(host.state, ownerId, cardId, LIU_YANG_CHI_XING))
      if (!actions.length) return
      host.askSkill({ skillId: LIU_YANG_CHI_XING, ownerId, step: 'use-one-slash', data: { actions }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【迟行】：选择使用一张仍在弃牌堆且合法的【杀】', timeoutMs: 25_000,
        optional: true, options: actions.map((action) => ({ id: action.id, label: action.label })),
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-draw') {
      if ((response.payload as { optionId?: string }).optionId !== 'draw') return
      const cards = resolution.data.cards as CardId[]
      drawCards(host.state, host.rng, ownerId, cards.length, (name, payload) => host.dispatch(name, payload))
      host.queueSkill({ skillId: LIU_YANG_CHI_XING, ownerId, step: 'choose-slash', data: { cards } })
      return
    }
    if (resolution.step !== 'use-one-slash') return
    const actionId = (response.payload as { optionId?: string }).optionId
    const actions = resolution.data.actions as Array<{ id: string; cardIds: CardId[] }>
    const action = actions.find((entry) => entry.id === actionId)
    const cardId = action?.cardIds[0]
    if (actionId && cardId && host.state.zones.discardPile.includes(cardId)
      && skillDiscardCardUseActions(host.state, ownerId, cardId, LIU_YANG_CHI_XING).some((candidate) => candidate.id === actionId))
      host.beginSkillCardUseFromDiscard(ownerId, cardId, LIU_YANG_CHI_XING, actionId)
  },
})

export const XU_KUN_B89: CharacterDefinition = {
  id: 'xu-kun-b89', name: '徐琨', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [{ id: XU_KUN_FA_ZHU, name: '筏铸', description: '准备阶段，你可以重铸你区域内任意张非伤害牌然后将因此获得的牌交给至多等量名角色各一张，以此法获得牌的角色可以依次使用一张【杀】（不限距离）。' }],
}
export const MOU_CAO_ANG_B89: CharacterDefinition = {
  id: 'mou-caoang-b89', name: '谋·曹昂', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: MOU_CAO_ANG_FENG_MIN, name: '丰愍', locked: true, description: '锁定技，每回合限一次，有角色失去装备区的牌后，你摸其装备区空位数张牌。' },
    { id: MOU_CAO_ANG_ZHI_WANG, name: '质亡', locked: true, description: '锁定技，结束阶段，你弃置装备区所有牌。若你以此法弃牌，选择弃牌堆中一张伤害牌并令一名其他角色使用之（此牌对你造成的伤害视为无来源）。' },
  ],
}
export const LIU_YANG_B89: CharacterDefinition = {
  id: 'liu-yang-b89', name: '柳婒', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'standard',
  skills: [
    { id: LIU_YANG_JING_YIN, name: '经音', description: '每回合限一次，当有角色于其回合外使用的【杀】进入弃牌堆后，你可令除使用者之外的一名角色获得此【杀】，且此牌无次数限制。' },
    { id: LIU_YANG_CHI_XING, name: '迟行', description: '一名角色出牌阶段结束时，若此阶段有【杀】进入弃牌堆，你可以摸等量的牌。若其中有【杀】你可以使用其中一张。' },
  ],
}

registerSkillRuntime({
  id: BIAN_YUE_BI_ZU,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const record = dataOf(state).bianYueTargets?.[ownerId]
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || record?.disabledTurn === state.turnNumber) return []
    return [{ id: `skill:${BIAN_YUE_BI_ZU}`, label: '发动【庇族】：令所有与自己手牌数相同的角色摸一张牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${BIAN_YUE_BI_ZU}`) throw new Error('卞玥【庇族】动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
    const targetIds = host.state.players.filter((player) => player.alive && player.zones.hand.length === owner.zones.hand.length)
      .map((player) => player.id)
    for (const targetId of targetIds) drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
    host.dispatch('SkillActivated', { skillId: BIAN_YUE_BI_ZU, skillName: '庇族', playerId: ownerId, targetIds }, { sourceId: ownerId })
  },
  triggers: [{ event: 'SkillActivated', handle(host, ownerId, context) {
    if (!alive(host, ownerId)) return
    const event = context.event.payload as { targetIds?: PlayerId[] }
    if (!Array.isArray(event.targetIds)) return
    const key = [...event.targetIds].sort().join('|')
    const byOwner = dataOf(host.state).bianYueTargets ??= {}
    const record = byOwner[ownerId]?.turnNumber === host.state.turnNumber
      ? byOwner[ownerId]!
      : (byOwner[ownerId] = { turnNumber: host.state.turnNumber, counts: {} })
    record.counts[key] = (record.counts[key] ?? 0) + 1
    if (record.counts[key] === 2 && record.disabledTurn !== host.state.turnNumber) {
      record.disabledTurn = host.state.turnNumber
      recover(host, ownerId, 1, ownerId)
    }
  } }, { event: 'TurnEnd', handle(host, ownerId) {
    const record = dataOf(host.state).bianYueTargets?.[ownerId]
    if (record?.disabledTurn === host.state.turnNumber) record.disabledTurn = undefined
  } }],
})

registerSkillRuntime({
  id: BIAN_YUE_WU_XIE,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId }
    if (event.playerId === ownerId && alive(host, ownerId))
      host.queueSkill({ skillId: BIAN_YUE_WU_XIE, ownerId, step: 'choose-target', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-target') return
    const candidateIds = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: BIAN_YUE_WU_XIE, ownerId, step: 'swap-hands', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【无胁】：选择一名其他角色交换手牌', timeoutMs: 25_000,
      optional: true, candidateIds, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'swap-hands') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !alive(host, ownerId) || !alive(host, targetId) || targetId === ownerId) return
    swapHands(host, ownerId, targetId, BIAN_YUE_WU_XIE)
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    for (const cardId of [...owner.zones.hand]) {
      if (isDamageCard(host.state, cardId)) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
    }
  },
})

registerSkillRuntime({
  id: MOU_DIANWEI_KANGYONG,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      const owner = playerOf(host.state, ownerId)
      if (event.playerId !== ownerId || !owner?.alive) return
      const amount = recoverTo(host, ownerId, owner.maxHp, ownerId, MOU_DIANWEI_KANGYONG)
      const records = dataOf(host.state).mouDianweiHeal ??= {}
      records[ownerId] = { turnNumber: event.turnNumber ?? host.state.turnNumber, amount }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      if (event.playerId !== ownerId) return
      const records = dataOf(host.state).mouDianweiHeal
      const record = records?.[ownerId]
      delete records?.[ownerId]
      if (!record || record.turnNumber !== (event.turnNumber ?? host.state.turnNumber) || record.amount <= 0) return
      const owner = playerOf(host.state, ownerId)
      if (owner?.alive) loseHp(host, ownerId, Math.min(record.amount, Math.max(0, owner.hp - 1)), MOU_DIANWEI_KANGYONG)
    } },
  ],
})

registerSkillRuntime({
  id: MOU_DIANWEI_KUANGZHAN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, MOU_DIANWEI_KUANGZHAN)
      || !state.players.some((player) => player.alive && player.id !== ownerId && canPindian(state, player.id))) return []
    return [{ id: `skill:${MOU_DIANWEI_KUANGZHAN}`, label: '发动【狂战】：摸牌至体力上限并进行相应次数的拼点' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MOU_DIANWEI_KUANGZHAN}`) throw new Error('谋·典韦【狂战】动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, MOU_DIANWEI_KUANGZHAN)) return
    const drawCount = Math.max(0, owner.maxHp - owner.zones.hand.length)
    markUsedThisPhase(host.state, ownerId, MOU_DIANWEI_KUANGZHAN)
    const gained = drawCards(host.state, host.rng, ownerId, drawCount, (name, payload) => host.dispatch(name, payload))
    if (!gained.length) return
    dataOf(host.state).mouDianweiFlow ??= {}
    dataOf(host.state).mouDianweiFlow![ownerId] = { turnNumber: host.state.turnNumber, remaining: gained.length, awaitingSlash: false }
    host.queueSkill({ skillId: MOU_DIANWEI_KUANGZHAN, ownerId, step: 'choose-pindian-target', data: {} })
  },
  triggers: [
    { event: 'PindianEnd', handle(host, ownerId, context) {
      const result = context.event.payload as { initiatorId?: PlayerId; opponentId?: PlayerId; outcome?: 'initiator-win' | 'opponent-win' | 'tie' }
      if (!result.initiatorId || !result.opponentId || !result.outcome
        || result.initiatorId !== ownerId && result.opponentId !== ownerId) return
      const records = dataOf(host.state).mouDianweiWins ??= {}
      const record = records[ownerId]?.turnNumber === host.state.turnNumber
        ? records[ownerId]!
        : (records[ownerId] = { turnNumber: host.state.turnNumber, opponentIds: [] })
      const won = result.initiatorId === ownerId ? result.outcome === 'initiator-win' : result.outcome === 'opponent-win'
      const opponentId = result.initiatorId === ownerId ? result.opponentId : result.initiatorId
      if (won && !record.opponentIds.includes(opponentId)) record.opponentIds.push(opponentId)
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const flow = dataOf(host.state).mouDianweiFlow?.[ownerId]
      const payload = context.event.payload as { sourceSkillId?: string }
      if (!flow?.awaitingSlash || payload.sourceSkillId !== MOU_DIANWEI_KUANGZHAN) return
      flow.awaitingSlash = false
      if (flow.remaining > 0) host.queueSkill({ skillId: MOU_DIANWEI_KUANGZHAN, ownerId, step: 'choose-pindian-target', data: {} })
      else delete dataOf(host.state).mouDianweiFlow![ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-pindian-target') return
    const flow = dataOf(host.state).mouDianweiFlow?.[ownerId]
    if (!flow || flow.turnNumber !== host.state.turnNumber || flow.remaining <= 0) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && canPindian(host.state, player.id))
    if (!candidates.length) {
      delete dataOf(host.state).mouDianweiFlow![ownerId]
      return
    }
    host.askSkill({ skillId: MOU_DIANWEI_KUANGZHAN, ownerId, step: 'pindian-target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: `【狂战】：选择一名角色拼点（还可进行${flow.remaining}次）`,
      timeoutMs: 25_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pindian-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const flow = dataOf(host.state).mouDianweiFlow?.[ownerId]
    if (!flow || !targetId || !alive(host, targetId) || !canPindian(host.state, targetId)) {
      host.queueSkill({ skillId: MOU_DIANWEI_KUANGZHAN, ownerId, step: 'choose-pindian-target', data: {} })
      return
    }
    startPindian(host as never, { id: `${MOU_DIANWEI_KUANGZHAN}:${host.state.seq}`, initiatorId: ownerId,
      opponentId: targetId, reason: MOU_DIANWEI_KUANGZHAN, continuationTag: MOU_DIANWEI_KUANGZHAN_TAG })
  },
})

registerPindianContinuation(MOU_DIANWEI_KUANGZHAN_TAG, (pindianHost, result) => {
  const host = pindianHost as unknown as SkillHost
  const ownerId = result.initiatorId
  const owner = playerOf(host.state, ownerId)
  const flow = dataOf(host.state).mouDianweiFlow?.[ownerId]
  if (!owner?.alive || !flow || flow.turnNumber !== host.state.turnNumber) return
  flow.remaining = Math.max(0, flow.remaining - 1)
  const opponent = playerOf(host.state, result.opponentId)
  let started = false
  if (result.outcome === 'initiator-win') {
    const wins = dataOf(host.state).mouDianweiWins ??= {}
    const wonAgainst = wins[ownerId]?.turnNumber === host.state.turnNumber
      ? wins[ownerId]!
      : (wins[ownerId] = { turnNumber: host.state.turnNumber, opponentIds: [] })
    if (!wonAgainst.opponentIds.includes(result.opponentId)) wonAgainst.opponentIds.push(result.opponentId)
    const currentWins = wins[ownerId]
    const excluded = currentWins.turnNumber === host.state.turnNumber ? currentWins.opponentIds : []
    const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId && !excluded.includes(player.id)
      && canTarget(host.state, ownerId, player.id)
      && !isTargetProhibited(host.state, ownerId, player.id, '杀', characterSkillIdsOf))
    if (targets.length) started = host.beginVirtualSlash({ sourceId: ownerId, targetIds: targets.map((player) => player.id),
      maxTargets: targets.length, sourceSkillId: MOU_DIANWEI_KUANGZHAN })
  } else if (opponent?.alive && canTarget(host.state, opponent.id, ownerId)
    && !isTargetProhibited(host.state, opponent.id, ownerId, '杀', characterSkillIdsOf)) {
    started = host.beginVirtualSlash({ sourceId: opponent.id, targetId: ownerId, sourceSkillId: MOU_DIANWEI_KUANGZHAN })
  }
  if (started) flow.awaitingSlash = true
  else if (flow.remaining > 0) host.queueSkill({ skillId: MOU_DIANWEI_KUANGZHAN, ownerId, step: 'choose-pindian-target', data: {} })
  else delete dataOf(host.state).mouDianweiFlow![ownerId]
})

export const MOU_DIANWEI_B89: CharacterDefinition = {
  id: 'mou-dianwei-b89', name: '谋·典韦', kingdom: 'wei', gender: 'male', maxHp: 5, initialHp: 4, pack: 'sp',
  skills: [
    { id: MOU_DIANWEI_KUANGZHAN, name: '狂战', description: '出牌阶段限一次，将手牌摸至体力上限并进行X次拼点，若你赢视为对所有本回合拼点未赢的其他角色使用一张【杀】，若你未赢，其视为对你使用一张【杀】。（X为你以此法获得的牌数）' },
    { id: MOU_DIANWEI_KANGYONG, name: '亢勇', locked: true, description: '锁定技，回合开始时，将体力回满，回合结束时，失去等量体力（至少保留一点）。' },
  ],
}

export const BIAN_YUE_B89: CharacterDefinition = {
  id: 'bian-yue-b89', name: '卞玥', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'standard',
  skills: [
    { id: BIAN_YUE_BI_ZU, name: '庇族', description: '出牌阶段，你可令所有手牌数与你相同的角色摸一张牌。若本回合存在两次技能目标完全一致，此技能本回合失效且你回复一点体力。' },
    { id: BIAN_YUE_WU_XIE, name: '无胁', description: '回合结束时，你可以选择一名其他角色，与其交换手牌，随后你将手牌中全部伤害牌放置在牌堆底。' },
  ],
}

registerSkillRuntime({
  id: MOU_JUSHOU_MUWANG,
  triggers: [{ event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const { cardId, fromPlayerId } = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null }
    const card = cardId ? host.state.cards[cardId] : undefined
    if (!cardId || fromPlayerId !== ownerId || !host.state.zones.discardPile.includes(cardId)
      || !card || (card.category !== 'basic' && !(card.category === 'trick' && INSTANT_TRICKS.has(card.name)))) return
    const records = dataOf(host.state).mouJushouMuwang ??= {}
    const record = records[ownerId]
    if (!record || record.turnNumber !== host.state.turnNumber) {
      records[ownerId] = { turnNumber: host.state.turnNumber, cardId }
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MOU_JUSHOU_MUWANG },
        { sourceId: ownerId, targetId: ownerId, cardIds: [cardId], sourceSkillId: MOU_JUSHOU_MUWANG })
      return
    }
    if (record.cardId === cardId) host.queueSkill({ skillId: MOU_JUSHOU_MUWANG, ownerId, step: 'discard-one', data: { cardId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-one') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (!cardIds.length) return
    host.askSkill({ skillId: MOU_JUSHOU_MUWANG, ownerId, step: 'discard-one', data: prompt.data, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【暮往】：弃置一张牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard-one') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (cardId) discardCardsByIds(host, ownerId, [cardId], MOU_JUSHOU_MUWANG)
  },
})

export const MOU_JUSHOU_B89: CharacterDefinition = {
  id: 'mou-jushou-b89', name: '谋·沮授', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: 'zuo-jun-mou-jushou-b89', name: '佐军', description: '出牌阶段限一次，你可选择一名角色，令其摸三张牌并选择一项：1.这些牌无法使用且不计入手牌上限，直到其下回合结束；2.失去1点体力，再摸一张牌并使用其中任意张牌，然后弃置没使用的牌。' },
    { id: MOU_JUSHOU_MUWANG, name: '暮往', locked: true, description: '锁定技，当你每回合第一次失去的一张基本牌或普通锦囊牌进入弃牌堆时，你将之收回手牌。你本回合再次失去此牌后弃置一张牌。' },
  ],
}

registerSkillRuntime({
  id: XING_SUN_SHANGXIANG_JIAOHAO,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, XING_SUN_SHANGXIANG_JIAOHAO)) return []
    const equipmentCount = Object.values(owner.zones.equipment).filter(Boolean).length
    return state.players.some((target) => target.alive && target.id !== ownerId
      && Object.values(target.zones.equipment).filter(Boolean).length <= equipmentCount && canPindian(state, target.id))
      ? [{ id: `skill:${XING_SUN_SHANGXIANG_JIAOHAO}`, label: '发动【骄豪】：与一名装备数不大于你的角色拼点' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${XING_SUN_SHANGXIANG_JIAOHAO}`) throw new Error('星·孙尚香【骄豪】动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, XING_SUN_SHANGXIANG_JIAOHAO)) return
    const equipmentCount = Object.values(owner.zones.equipment).filter(Boolean).length
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
      && Object.values(target.zones.equipment).filter(Boolean).length <= equipmentCount && canPindian(host.state, target.id))
    if (!candidates.length) return
    markUsedThisPhase(host.state, ownerId, XING_SUN_SHANGXIANG_JIAOHAO)
    host.askSkill({ skillId: XING_SUN_SHANGXIANG_JIAOHAO, ownerId, step: 'pindian-target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【骄豪】：选择一名装备区牌数不大于你的角色拼点',
      timeoutMs: 25_000, optional: false, candidateIds: candidates.map((target) => target.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pindian-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = playerOf(host.state, ownerId)
      if (!targetId || !owner?.alive || !alive(host, targetId)) return
      const equipmentCount = Object.values(owner.zones.equipment).filter(Boolean).length
      if (Object.values(playerOf(host.state, targetId)!.zones.equipment).filter(Boolean).length > equipmentCount || !canPindian(host.state, targetId)) return
      startPindian(host as never, { id: `${XING_SUN_SHANGXIANG_JIAOHAO}:${host.state.seq}`, initiatorId: ownerId,
        opponentId: targetId, reason: XING_SUN_SHANGXIANG_JIAOHAO, continuationTag: XING_SUN_SHANGXIANG_JIAOHAO_TAG })
      return
    }
    if (resolution.step === 'effect') {
      const flow = dataOf(host.state).starSunShangxiangJiaohao?.[ownerId]
      if (!flow) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'gain') claimPindianCards(host as never, flow.winnerId, flow.cardIds)
      else if (optionId === 'slash') {
        const targets = host.state.players.filter((target) => target.alive && target.id !== flow.winnerId
          && canTarget(host.state, flow.winnerId, target.id)
          && !isTargetProhibited(host.state, flow.winnerId, target.id, '杀', characterSkillIdsOf))
        if (targets.length) {
          host.askSkill({ skillId: XING_SUN_SHANGXIANG_JIAOHAO, ownerId, step: 'winner-slash-target', data: { winnerId: flow.winnerId, cardIds: flow.cardIds }, build: (id): ChooseTargetsRequest => ({
            id, kind: 'choose-targets', playerId: flow.winnerId, prompt: '【骄豪】：选择【杀】的目标', timeoutMs: 25_000,
            optional: false, candidateIds: targets.map((target) => target.id), min: 1, max: 1,
          }) })
          return
        }
      }
      delete dataOf(host.state).starSunShangxiangJiaohao?.[ownerId]
      finishPindianSettlement(host as never)
      return
    }
    if (resolution.step === 'winner-slash-target') {
      const { winnerId, cardIds } = resolution.data as { winnerId: PlayerId; cardIds: CardId[] }
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !alive(host, winnerId) || !alive(host, targetId)
        || !canTarget(host.state, winnerId, targetId)
        || isTargetProhibited(host.state, winnerId, targetId, '杀', characterSkillIdsOf)) {
        delete dataOf(host.state).starSunShangxiangJiaohao?.[ownerId]
        finishPindianSettlement(host as never)
        return
      }
      dataOf(host.state).starSunShangxiangJiaohao![ownerId] = { winnerId, cardIds }
      if (!host.beginVirtualSlash({ sourceId: winnerId, targetId, sourceSkillId: XING_SUN_SHANGXIANG_JIAOHAO })) {
        delete dataOf(host.state).starSunShangxiangJiaohao?.[ownerId]
        finishPindianSettlement(host as never)
      }
      return
    }
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const flow = dataOf(host.state).starSunShangxiangJiaohao?.[ownerId]
    const payload = context.event.payload as { sourceSkillId?: string }
    if (!flow || payload.sourceSkillId !== XING_SUN_SHANGXIANG_JIAOHAO) return
    delete dataOf(host.state).starSunShangxiangJiaohao?.[ownerId]
    finishPindianSettlement(host as never)
  } }],
})

registerPindianContinuation(XING_SUN_SHANGXIANG_JIAOHAO_TAG, (pindianHost, result) => {
  const host = pindianHost as unknown as SkillHost
  const winnerId = result.outcome === 'initiator-win' ? result.initiatorId
    : result.outcome === 'opponent-win' ? result.opponentId : null
  if (!winnerId) {
    finishPindianSettlement(host as never)
    return
  }
  const ownerId = result.initiatorId
  if (!playerOf(host.state, ownerId)?.alive) {
    finishPindianSettlement(host as never)
    return
  }
  const cardIds = [result.initiatorCardId, result.opponentCardId]
  const targets = host.state.players.filter((target) => target.alive && target.id !== winnerId
    && canTarget(host.state, winnerId, target.id)
    && !isTargetProhibited(host.state, winnerId, target.id, '杀', characterSkillIdsOf))
  dataOf(host.state).starSunShangxiangJiaohao ??= {}
  dataOf(host.state).starSunShangxiangJiaohao![ownerId] = { winnerId, cardIds }
  host.askSkill({ skillId: XING_SUN_SHANGXIANG_JIAOHAO, ownerId, step: 'effect', data: {}, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【骄豪】：令拼点赢的角色获得拼点牌，或使用一张【杀】',
    timeoutMs: 25_000, optional: true, options: [
      { id: 'gain', label: '令其获得拼点牌' },
      ...(targets.length ? [{ id: 'slash', label: '令其使用一张【杀】' }] : []),
    ],
  }) })
  return 'defer-settlement'
})

registerSkillRuntime({
  id: XING_SUN_SHANGXIANG_SA_YING,
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const record = dataOf(state).starSunShangxiangSaYing?.[ownerId]
    const used = record?.roundNumber === state.roundNumber ? record.cardNames : []
    const allowedNames = (['杀', '闪', '桃', '酒'] as const).filter((name) => !used.includes(name))
    const equipment = Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))
    return equipment.flatMap((cardId) => allowedNames.map((asCardName) => ({ cardId, asCardName,
      label: `【飒影】：将装备区里的牌当【${asCardName}】使用或打出` })))
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const { cardName, fromKind } = context.event.payload as { cardName?: string; fromKind?: string }
      if (context.event.sourceId !== ownerId || fromKind !== 'equipment'
        || !['杀', '闪', '桃', '酒'].includes(cardName ?? '')) return
      const records = dataOf(host.state).starSunShangxiangSaYing ??= {}
      const record = records[ownerId]?.roundNumber === host.state.roundNumber
        ? records[ownerId]!
        : (records[ownerId] = { roundNumber: host.state.roundNumber, cardNames: [] })
      if (!record.cardNames.includes(cardName!)) record.cardNames.push(cardName!)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const { playerId, cardName, fromKind } = context.event.payload as { playerId?: PlayerId; cardName?: string; fromKind?: string }
      if (playerId !== ownerId || fromKind !== 'equipment' || !['杀', '闪', '桃', '酒'].includes(cardName ?? '')) return
      const records = dataOf(host.state).starSunShangxiangSaYing ??= {}
      const record = records[ownerId]?.roundNumber === host.state.roundNumber
        ? records[ownerId]!
        : (records[ownerId] = { roundNumber: host.state.roundNumber, cardNames: [] })
      if (!record.cardNames.includes(cardName!)) record.cardNames.push(cardName!)
    } },
  ],
})

export const XING_SUN_SHANGXIANG_B89: CharacterDefinition = {
  id: 'xing-sun-shangxiang-b89', name: '星·孙尚香', kingdom: 'wu', gender: 'female', maxHp: 4, pack: 'sp',
  skills: [
    { id: XING_SUN_SHANGXIANG_SA_YING, name: '飒影', description: '每轮每种牌名限一次，当你需要使用一张【杀】或【闪】时，你可以使用一张装备牌，然后视为使用之；当你需要使用一张【桃】或【酒】时，你可以收回装备区里的一张牌，然后视为使用之。' },
    { id: XING_SUN_SHANGXIANG_JIAOHAO, name: '骄豪', description: '出牌阶段限一次，你可以与装备区牌数小于等于你的角色拼点，然后你可以令拼点赢的角色获得拼点的牌或者令其使用一张【杀】。' },
  ],
}

function finishChenlinWenzhang(host: SkillHost, ownerId: PlayerId): void {
  const flow = dataOf(host.state).mouChenlinWenzhang?.[ownerId]
  if (!flow) return
  for (const cardId of [...flow.cardIds].reverse()) {
    if (host.state.zones.processingArea.includes(cardId))
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
  }
  delete dataOf(host.state).mouChenlinWenzhang?.[ownerId]
}

function chenlinWenzhangActions(host: SkillHost, ownerId: PlayerId, cardId: CardId) {
  const flow = dataOf(host.state).mouChenlinWenzhang?.[ownerId]
  if (!flow || !alive(host, ownerId) || !alive(host, flow.targetId)) return []
  return skillProcessingCardUseActions(host.state, ownerId, cardId)
    .filter((action) => action.targetIds.includes(flow.targetId))
}

registerSkillRuntime({
  id: MOU_CHENLIN_YAOZUO,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, MOU_CHENLIN_YAOZUO)) return []
    return state.players.some((player) => player.alive && player.id !== ownerId)
      ? [{ id: `skill:${MOU_CHENLIN_YAOZUO}`, label: '发动【邀作】：所有其他角色同时选择是否交牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MOU_CHENLIN_YAOZUO}`) throw new Error('谋·陈琳【邀作】动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, MOU_CHENLIN_YAOZUO)) return
    markUsedThisPhase(host.state, ownerId, MOU_CHENLIN_YAOZUO)
    const participants = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    startGroupCardDecision(host as never, {
      id: `${MOU_CHENLIN_YAOZUO}:${host.state.seq}`, tag: MOU_CHENLIN_YAOZUO_GROUP,
      skillId: MOU_CHENLIN_YAOZUO, playerIds: participants, prompt: '【邀作】：可秘密交给谋·陈琳一张牌',
      cardIdsFor: (playerId) => {
        const player = playerOf(host.state, playerId)
        return player ? [...player.zones.hand, ...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      }, min: 0, max: 1,
      timeoutMs: 25_000, data: { ownerId },
    })
  },
  handLimitExempt(state, ownerId, cardId) {
    return dataOf(state).mouChenlinIgnoredCards?.[ownerId]?.includes(cardId) ?? false
  },
  globalOutgoingDamage(state, ownerId, sourceId, context) {
    if (sourceId !== ownerId) return null
    const record = dataOf(state).mouChenlinDamageBonus?.[ownerId]
    const bonus = record?.turnNumber === state.turnNumber ? record.targets[context.targetId] ?? 0 : 0
    return bonus > 0 ? { amount: context.amount + bonus } : null
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'finish' || !alive(host, ownerId)) return
      host.askSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'end-target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【撰文】：选择一名角色执行此技能，或取消',
        timeoutMs: 25_000, optional: true, candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 1,
      }) })
    } },
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
      if (payload.playerId !== ownerId || !payload.cardId) return
      const cards = dataOf(host.state).mouChenlinIgnoredCards?.[ownerId]
      if (cards) dataOf(host.state).mouChenlinIgnoredCards![ownerId] = cards.filter((id) => id !== payload.cardId)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (context.event.sourceId !== ownerId || !targetId) return
      const record = dataOf(host.state).mouChenlinDamageBonus?.[ownerId]
      if (record?.turnNumber !== host.state.turnNumber || !record.targets[targetId]) return
      record.targets[targetId] -= 1
      if (record.targets[targetId] <= 0) delete record.targets[targetId]
    } },
    { event: 'AfterCardUse', allowDeadOwner: true, handle(host, ownerId, context) {
      const flow = dataOf(host.state).mouChenlinWenzhang?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
      if (!flow?.pendingCardId || payload.sourceSkillId !== MOU_CHENLIN_ZHUANWEN || payload.cardId !== flow.pendingCardId) return
      flow.cursor += 1
      delete flow.pendingCardId
      host.queueSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'use-damage-cards', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'wenzhang-mode') {
      const flow = dataOf(host.state).mouChenlinWenzhang?.[ownerId]
      if (!flow) return
      const hasDamage = flow.damageIds.length > 0
      const hasOther = flow.cardIds.some((cardId) => !flow.damageIds.includes(cardId))
      if (!hasDamage && !hasOther) return finishChenlinWenzhang(host, ownerId)
      host.askSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'wenzhang-mode', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【撰文】：选择对指定角色执行的一项', timeoutMs: 25_000,
        optional: false, options: [
          ...(hasDamage ? [{ id: 'damage', label: `对其使用展示牌中的伤害牌（${flow.damageIds.length}张）` }] : []),
          ...(hasOther ? [{ id: 'gain', label: `令其获得展示牌中的非伤害牌（${flow.cardIds.length - flow.damageIds.length}张）` }] : []),
        ],
      }) })
      return
    }
    if (prompt.step !== 'use-damage-cards') return
    const flow = dataOf(host.state).mouChenlinWenzhang?.[ownerId]
    if (!flow || !alive(host, ownerId) || !alive(host, flow.targetId)) return finishChenlinWenzhang(host, ownerId)
    while (flow.cursor < flow.damageIds.length) {
      const cardId = flow.damageIds[flow.cursor]!
      if (!host.state.zones.processingArea.includes(cardId)) { flow.cursor += 1; continue }
      const actions = chenlinWenzhangActions(host, ownerId, cardId)
      if (!actions.length) { flow.cursor += 1; continue }
      if (actions.length === 1) {
        flow.pendingCardId = cardId
        if (beginSkillCardUseFromProcessing(host as never, ownerId, cardId, MOU_CHENLIN_ZHUANWEN, actions[0]!.id)) return
        delete flow.pendingCardId
        flow.cursor += 1
        continue
      }
      host.askSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'choose-damage-action', data: { cardId, actionIds: actions.map(({ id }) => id), actions }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【撰文】：选择对${playerOf(host.state, flow.targetId)?.nickname ?? '目标'}使用【${host.state.cards[cardId]?.name ?? '伤害牌'}】的合法方式`,
        timeoutMs: 25_000, optional: false, options: actions.map((action) => ({ id: action.id, label: action.label })),
      }) })
      return
    }
    finishChenlinWenzhang(host, ownerId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'end-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !alive(host, targetId)) return
      const count = Math.min(5, playerOf(host.state, ownerId)?.zones.hand.length ?? 0)
      const cardIds = revealTopCards(host.state, host.rng, count, MOU_CHENLIN_ZHUANWEN,
        (name, payload) => host.dispatch(name, payload))
      const damageIds = cardIds.filter((cardId) => isDamageCard(host.state, cardId))
      dataOf(host.state).mouChenlinWenzhang ??= {}
      dataOf(host.state).mouChenlinWenzhang![ownerId] = { targetId, cardIds, damageIds, cursor: 0 }
      host.queueSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'wenzhang-mode', data: {} })
      return
    }
    if (resolution.step === 'recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const fastestId = resolution.data.fastestId as PlayerId
      if (!targetId || targetId === fastestId || !alive(host, fastestId) || !alive(host, targetId)) return
      const count = Math.min(5, playerOf(host.state, ownerId)?.zones.hand.length ?? 0)
      const cardIds = revealTopCards(host.state, host.rng, count, MOU_CHENLIN_ZHUANWEN,
        (name, payload) => host.dispatch(name, payload))
      const damageIds = cardIds.filter((cardId) => isDamageCard(host.state, cardId))
      dataOf(host.state).mouChenlinWenzhang ??= {}
      dataOf(host.state).mouChenlinWenzhang![ownerId] = { targetId, cardIds, damageIds, cursor: 0 }
      host.queueSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'wenzhang-mode', data: {} })
      return
    }
    if (resolution.step === 'wenzhang-mode') {
      const flow = dataOf(host.state).mouChenlinWenzhang?.[ownerId]
      if (!flow) return
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode === 'gain') {
        const gained: CardId[] = []
        for (const cardId of flow.cardIds) {
          const isDamage = flow.damageIds.includes(cardId)
          if (isDamage || !host.state.zones.processingArea.includes(cardId) || !alive(host, flow.targetId)) continue
          moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: flow.targetId })
          gained.push(cardId)
        }
        if (gained.length) host.dispatch('GainCard', { playerId: flow.targetId, cardIds: gained, reason: MOU_CHENLIN_ZHUANWEN },
          { sourceId: ownerId, targetId: flow.targetId, cardIds: gained, sourceSkillId: MOU_CHENLIN_ZHUANWEN })
        finishChenlinWenzhang(host, ownerId)
      } else if (mode === 'damage') host.queueSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'use-damage-cards', data: {} })
      else finishChenlinWenzhang(host, ownerId)
      return
    }
    if (resolution.step === 'choose-damage-action') {
      const flow = dataOf(host.state).mouChenlinWenzhang?.[ownerId]
      const cardId = resolution.data.cardId as CardId
      const actionId = (response.payload as { optionId?: string }).optionId
      if (!flow || cardId !== flow.damageIds[flow.cursor] || !actionId
        || !(resolution.data.actionIds as string[]).includes(actionId)) {
        host.queueSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'use-damage-cards', data: {} })
        return
      }
      const action = chenlinWenzhangActions(host, ownerId, cardId).find((candidate) => candidate.id === actionId)
      if (!action) { flow.cursor += 1; host.queueSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'use-damage-cards', data: {} }); return }
      flow.pendingCardId = cardId
      if (!beginSkillCardUseFromProcessing(host as never, ownerId, cardId, MOU_CHENLIN_ZHUANWEN, action.id)) {
        delete flow.pendingCardId
        flow.cursor += 1
        host.queueSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'use-damage-cards', data: {} })
      }
    }
  },
})

registerGroupCardDecision(MOU_CHENLIN_YAOZUO_GROUP, (rawHost, decision) => {
  const host = rawHost as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  const successfulGivers = new Set<PlayerId>()
  const handGivers = new Set<PlayerId>()
  const ignored = dataOf(host.state).mouChenlinIgnoredCards ??= {}
  for (const [fromId, submitted] of Object.entries(decision.responses)) {
    if (!submitted) continue
    const cardId = submitted[0]
    if (!cardId || !playerOf(host.state, ownerId)?.alive) continue
    const gaveFromHand = playerOf(host.state, fromId as PlayerId)?.zones.hand.includes(cardId) ?? false
    const given = giveOwnedCards(host, fromId as PlayerId, ownerId, [cardId], MOU_CHENLIN_YAOZUO)
    if (!given.length) continue
    successfulGivers.add(fromId as PlayerId)
    if (gaveFromHand) handGivers.add(fromId as PlayerId)
    ignored[ownerId] ??= []
    if (!ignored[ownerId]!.includes(cardId)) ignored[ownerId]!.push(cardId)
  }
  const bonusRecords = dataOf(host.state).mouChenlinDamageBonus ??= {}
  const bonus = bonusRecords[ownerId]?.turnNumber === host.state.turnNumber
    ? bonusRecords[ownerId]!
    : (bonusRecords[ownerId] = { turnNumber: host.state.turnNumber, targets: {} })
  for (const playerId of decision.playerIds) {
    if (!handGivers.has(playerId)) bonus.targets[playerId] = (bonus.targets[playerId] ?? 0) + 1
  }
  const requestIds = new Set(Object.values(decision.requestIds))
  const decisions = host.state.decisions.filter((entry) => requestIds.has(entry.requestId))
  const fastestId = decisions.find((entry) => successfulGivers.has(entry.playerId)
    && ((entry.payload as { cardIds?: CardId[] }).cardIds?.length ?? 0) > 0)?.playerId
  if (!fastestId || !alive(host, ownerId)) return
  const candidates = host.state.players.filter((player) => player.alive && player.id !== fastestId)
  if (!candidates.length) return
  host.askSkill({ skillId: MOU_CHENLIN_YAOZUO, ownerId, step: 'recipient', data: { fastestId }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: fastestId, prompt: '【邀作】：选择另一名角色，对其执行【撰文】',
    timeoutMs: 25_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
  }) })
})

registerSkillRuntime({
  id: MOU_CHENLIN_ZHUANWEN,
  handLimitExempt(state, ownerId, cardId) {
    return dataOf(state).mouChenlinIgnoredCards?.[ownerId]?.includes(cardId) ?? false
  },
})

export const MOU_CHENLIN_B89: CharacterDefinition = {
  id: 'mou-chenlin-b89', name: '谋·陈琳', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: MOU_CHENLIN_YAOZUO, name: '邀作', description: '出牌阶段限一次，所有其他角色可选择交给你一张牌，你以此法获得的牌不计入手牌上限，最快者选择另一名其他角色，视为你对其所选角色使用“撰文”。未交给你手牌的角色，本回合你下次对其造成的伤害+1。' },
    { id: MOU_CHENLIN_ZHUANWEN, name: '撰文', description: '结束阶段，你可展示牌堆顶X张牌并选择一项对一名角色执行：1.对其使用其中的伤害牌；2.其获得其中的非伤害牌。结算后其余牌放置牌堆顶。（X为你的手牌数且至多为5）' },
  ],
}

// 谋·胡车儿【孔武】：展示并弃同花色手牌后，按目标剩余同类别牌数逐次使用杀。
registerSkillRuntime({
  id: MOU_HUCHEER_KONGWU,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, MOU_HUCHEER_KONGWU)) return []
    return state.players.some((target) => target.alive && target.id !== ownerId && target.zones.hand.length
      && canTarget(state, ownerId, target.id) && !isTargetProhibited(state, ownerId, target.id, '杀', characterSkillIdsOf))
      ? [{ id: `skill:${MOU_HUCHEER_KONGWU}`, label: '发动【孔武】：展示手牌并连续使用【杀】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MOU_HUCHEER_KONGWU}`) throw new Error('谋·胡车儿【孔武】动作不匹配')
    if (usedThisPhase(host.state, ownerId, MOU_HUCHEER_KONGWU)) return
    const targets = host.state.players.filter((target) => target.alive && target.id !== ownerId && target.zones.hand.length
      && canTarget(host.state, ownerId, target.id) && !isTargetProhibited(host.state, ownerId, target.id, '杀', characterSkillIdsOf))
    if (!targets.length) return
    markUsedThisPhase(host.state, ownerId, MOU_HUCHEER_KONGWU)
    host.askSkill({ skillId: MOU_HUCHEER_KONGWU, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【孔武】：选择一名有手牌的其他角色', timeoutMs: 25_000,
      optional: false, candidateIds: targets.map((target) => target.id), min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'AfterCardUse', allowDeadOwner: true, handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== MOU_HUCHEER_KONGWU) return
      const flow = dataOf(host.state).mouHucheerFlow?.[ownerId]
      if (!flow) return
      if (flow.remaining) host.queueSkill({ skillId: MOU_HUCHEER_KONGWU, ownerId, step: 'next-slash', data: {} })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const flow = dataOf(host.state).mouHucheerFlow?.[ownerId]
      const payload = context.event.payload as { finalAmount?: number }
      if (flow && context.event.sourceId === ownerId && context.event.targetId === flow.targetId
        && context.event.sourceSkillId === MOU_HUCHEER_KONGWU && (payload.finalAmount ?? 0) > 0) flow.damaged = true
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const flow = dataOf(host.state).mouHucheerFlow?.[ownerId]
      if (!flow) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, flow.targetId)
      if (owner?.alive) {
        if (!flow.damaged) {
          const count = Math.max(0, owner.maxHp - owner.zones.hand.length)
          if (count) drawCards(host.state, host.rng, ownerId, count, (name, drawPayload) => host.dispatch(name, drawPayload))
        }
        if (target?.alive && target.zones.hand.length <= owner.zones.hand.length && target.hp <= owner.hp)
          suppressEquipmentEffectsUntilTurnEnd(host.state, target.id, host.state.turnNumber, 1)
      }
      delete dataOf(host.state).mouHucheerFlow?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'next-slash') return
    const flow = dataOf(host.state).mouHucheerFlow?.[ownerId]
    const target = flow && playerOf(host.state, flow.targetId)
    if (!flow || !target?.alive || !playerOf(host.state, ownerId)?.alive || flow.remaining <= 0) return
    flow.remaining -= 1
    if (!canTarget(host.state, ownerId, target.id) || isTargetProhibited(host.state, ownerId, target.id, '杀', characterSkillIdsOf)) {
      flow.remaining = 0
      return
    }
    if (!beginVirtualSlash(host as never, { sourceId: ownerId, targetId: target.id,
      sourceSkillId: MOU_HUCHEER_KONGWU, countUsage: false })) {
      if (flow.remaining) host.queueSkill({ skillId: MOU_HUCHEER_KONGWU, ownerId, step: 'next-slash', data: {} })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive || !target.zones.hand.length) return
      host.askSkill({ skillId: MOU_HUCHEER_KONGWU, ownerId, step: 'show-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【孔武】：选择并展示其一张手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'show-card') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const shownId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const shown = shownId && host.state.cards[shownId]
    if (!target?.alive || !shownId || !shown || !target.zones.hand.includes(shownId)) return
    host.dispatch('CardMove', { playerId: targetId, cardIds: [shownId], reason: MOU_HUCHEER_KONGWU, revealed: true },
      { sourceId: ownerId, targetId, cardIds: [shownId], sourceSkillId: MOU_HUCHEER_KONGWU })
    const sameSuit = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === shown.suit)
    if (sameSuit.length) discardCardsByIds(host, targetId, sameSuit, MOU_HUCHEER_KONGWU)
    const count = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))]
      .filter((cardId) => host.state.cards[cardId]?.category === shown.category).length
    dataOf(host.state).mouHucheerFlow ??= {}
    dataOf(host.state).mouHucheerFlow![ownerId] = { targetId, remaining: count, damaged: false }
    if (count) host.queueSkill({ skillId: MOU_HUCHEER_KONGWU, ownerId, step: 'next-slash', data: {} })
  },
})

export const MOU_HUCHEER_B89: CharacterDefinition = {
  id: 'mou-hucheer-b89', name: '谋·胡车儿', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [{ id: MOU_HUCHEER_KONGWU, name: '孔武', description: '出牌阶段限一次，你可以选择一名其他角色并展示其一张手牌。该角色弃置手牌中所有与此牌花色相同的牌，然后你视为对其使用X张【杀】（X为该角色手牌和装备区里与此牌类别相同的牌数）。若其没有因此受到伤害，你将手牌摸至体力上限。此阶段结束时，若其手牌数和体力值均小于等于你，其装备区里的牌失效至其下回合结束且下回合摸牌阶段摸牌数减一。' }],
}

export const HUANG_WUDIE_B89: CharacterDefinition = {
  id: 'huang-wudie-b89', name: '黄舞蝶', kingdom: 'shu', gender: 'female', maxHp: 4, pack: 'yjcm2011',
  skills: [
    { id: HUANG_WUDIE_SHUANGRUI, name: '双锐', description: '准备阶段，你可以选择一名其他角色，视为对其使用一张无距离限制的【杀】。若其不在你攻击范围内，此【杀】不可响应，你获得“狩星”直到回合结束；若其在你攻击范围内，此【杀】伤害+1，你获得“铩雪”直到回合结束。' },
    { id: HUANG_WUDIE_FUXIE, name: '伏械', description: '出牌阶段，你可以弃置一张武器牌或失去一个其他技能，令一名其他角色弃置两张牌。' },
    { id: HUANG_WUDIE_SHOUXING, name: '狩星', description: '出牌阶段，你可以选择一名攻击范围外的其他角色，将X张牌当一张不计入次数的【杀】对其使用（X为你计算与其的距离）。', granted: true },
    { id: HUANG_WUDIE_SHAXUE, name: '铩雪', description: '当你对其他角色造成伤害后，你可以摸两张牌，然后弃置X张牌（X为你计算与其的距离）。', granted: true },
  ],
}

function huangTempActive(state: SanguoshaState, ownerId: PlayerId, skillId: string): boolean {
  const record = dataOf(state).huangWudieTemporarySkills?.[ownerId]
  return record?.turnNumber === state.turnNumber && record.ids.includes(skillId)
}

function grantHuangTempSkill(host: SkillHost, ownerId: PlayerId, skillId: string): void {
  const records = dataOf(host.state).huangWudieTemporarySkills ??= {}
  const record = records[ownerId]?.turnNumber === host.state.turnNumber
    ? records[ownerId]!
    : (records[ownerId] = { turnNumber: host.state.turnNumber, ids: [] })
  if (!record.ids.includes(skillId)) record.ids.push(skillId)
  replaceTemporarySkills(host.state, ownerId, `${HUANG_WUDIE_SHUANGRUI}:turn`, record.ids)
}

registerSkillRuntime({
  id: HUANG_WUDIE_SHUANGRUI,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'prepare' || !playerOf(host.state, ownerId)?.alive
        || isCardUseProhibited(host.state, ownerId, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null })) return
      const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
        && !isTargetProhibited(host.state, ownerId, target.id, '杀', characterSkillIdsOf))
      if (!candidates.length) return
      host.askSkill({ skillId: HUANG_WUDIE_SHUANGRUI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【双锐】：是否选择一名其他角色，对其使用【杀】？',
        timeoutMs: 25_000, optional: true, candidateIds: candidates.map((target) => target.id), min: 1, max: 1,
      }) })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      replaceTemporarySkills(host.state, ownerId, `${HUANG_WUDIE_SHUANGRUI}:turn`, [])
      delete dataOf(host.state).huangWudieTemporarySkills?.[ownerId]
    } },
  ],
  resume(host, ownerId, _resolution, response) {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId) return
    const target = playerOf(host.state, targetId)
    if (!target?.alive || isTargetProhibited(host.state, ownerId, target.id, '杀', characterSkillIdsOf)) return
    const inRange = getDistance(host.state, ownerId, target.id) <= getAttackRange(host.state, ownerId)
    const grantedSkill = inRange ? HUANG_WUDIE_SHAXUE : HUANG_WUDIE_SHOUXING
    grantHuangTempSkill(host, ownerId, grantedSkill)
    const started = beginVirtualSlash(host as never, {
      sourceId: ownerId, targetId: target.id, sourceSkillId: HUANG_WUDIE_SHUANGRUI,
      ignoreDistance: true, countUsage: false, damageBonus: inRange ? 1 : 0,
      noDodgeTargetIds: inRange ? [] : [target.id],
    })
    if (!started) {
      replaceTemporarySkills(host.state, ownerId, `${HUANG_WUDIE_SHUANGRUI}:turn`, [])
      delete dataOf(host.state).huangWudieTemporarySkills?.[ownerId]
    }
  },
})

registerSkillRuntime({
  id: HUANG_WUDIE_SHOUXING,
  activeActions(state, ownerId) {
    if (!huangTempActive(state, ownerId, HUANG_WUDIE_SHOUXING) || state.phase !== 'play'
      || state.currentPlayerId !== ownerId || isCardUseProhibited(state, ownerId, '杀', { dyingPlayerId: state.dying?.playerId ?? null })) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const owned = owner.zones.hand.length + Object.values(owner.zones.equipment).filter(Boolean).length
    return state.players.some((target) => target.alive && target.id !== ownerId
      && getDistance(state, ownerId, target.id) > getAttackRange(state, ownerId)
      && owned >= getDistance(state, ownerId, target.id)
      && !isTargetProhibited(state, ownerId, target.id, '杀', characterSkillIdsOf))
      ? [{ id: `skill:${HUANG_WUDIE_SHOUXING}`, label: '发动【狩星】：将距离张牌当【杀】使用' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${HUANG_WUDIE_SHOUXING}` || !huangTempActive(host.state, ownerId, HUANG_WUDIE_SHOUXING)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
      && getDistance(host.state, ownerId, target.id) > getAttackRange(host.state, ownerId)
      && owner.zones.hand.length + Object.values(owner.zones.equipment).filter(Boolean).length >= getDistance(host.state, ownerId, target.id)
      && !isTargetProhibited(host.state, ownerId, target.id, '杀', characterSkillIdsOf))
    if (!candidates.length) return
    host.askSkill({ skillId: HUANG_WUDIE_SHOUXING, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【狩星】：选择一名攻击范围外的角色',
      timeoutMs: 25_000, optional: false, candidateIds: candidates.map((target) => target.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = playerOf(host.state, ownerId)
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || target.id === ownerId) return
      const count = getDistance(host.state, ownerId, target.id)
      const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      if (count <= getAttackRange(host.state, ownerId) || cards.length < count
        || isTargetProhibited(host.state, ownerId, target.id, '杀', characterSkillIdsOf)) return
      host.askSkill({ skillId: HUANG_WUDIE_SHOUXING, ownerId, step: 'materials', data: { targetId, count }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【狩星】：选择恰好${count}张牌作为【杀】的材料`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (resolution.step !== 'materials') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    const count = Number(resolution.data.count)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owned = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    if (!owner?.alive || !target?.alive || selected.length !== count || new Set(selected).size !== count
      || selected.some((cardId) => !owned.includes(cardId)) || isTargetProhibited(host.state, ownerId, targetId, '杀', characterSkillIdsOf)) return
    const [carrierId, ...costIds] = selected
    if (costIds.length) discardCardsByIds(host, ownerId, costIds, HUANG_WUDIE_SHOUXING)
    setCardAlias(host.state, carrierId!, '杀')
    beginVirtualSlash(host as never, { sourceId: ownerId, targetId, sourceSkillId: HUANG_WUDIE_SHOUXING,
      cardId: carrierId, ignoreDistance: true, countUsage: false })
  },
})

registerSkillRuntime({
  id: HUANG_WUDIE_SHAXUE,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { finalAmount?: number }
    const targetId = context.event.targetId
    if (!huangTempActive(host.state, ownerId, HUANG_WUDIE_SHAXUE) || context.event.sourceId !== ownerId
      || !targetId || targetId === ownerId || (payload.finalAmount ?? 0) <= 0) return
    host.queueSkill({ skillId: HUANG_WUDIE_SHAXUE, ownerId, step: 'invoke', data: { targetId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke' || !huangTempActive(host.state, ownerId, HUANG_WUDIE_SHAXUE)) return
    host.askSkill({ skillId: HUANG_WUDIE_SHAXUE, ownerId, step: 'invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【铩雪】：是否摸两张牌并弃置X张牌？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '摸两张牌并弃牌' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !huangTempActive(host.state, ownerId, HUANG_WUDIE_SHAXUE)) return
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      const targetId = resolution.data.targetId as PlayerId
      const count = Math.max(0, getDistance(host.state, ownerId, targetId))
      const owner = playerOf(host.state, ownerId)
      if (!owner || count <= 0) return
      const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      const actual = Math.min(count, cards.length)
      if (!actual) return
      host.askSkill({ skillId: HUANG_WUDIE_SHAXUE, ownerId, step: 'discard', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【铩雪】：弃置${actual}张牌（与受伤角色的距离为${count}）`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: actual, max: actual,
      }) })
      return
    }
    if (resolution.step === 'discard') {
      const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cards.length) discardCardsByIds(host, ownerId, cards, HUANG_WUDIE_SHAXUE)
    }
  },
})

function huangFuxieSkills(state: SanguoshaState, ownerId: PlayerId): string[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.characterId || owner.characterSkillsDisabled) return []
  return characterSkillIdsOf(owner.characterId).filter((skillId) => skillId !== HUANG_WUDIE_FUXIE
    && !(owner.permanentlyLostSkills ?? []).includes(skillId))
}

function askHuangFuxieTarget(host: SkillHost, ownerId: PlayerId): void {
  const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
    && (target.zones.hand.length + Object.values(target.zones.equipment).filter(Boolean).length > 0))
  if (!candidates.length) return
  host.askSkill({ skillId: HUANG_WUDIE_FUXIE, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【伏械】：选择一名有牌的其他角色', timeoutMs: 25_000,
    optional: false, candidateIds: candidates.map((target) => target.id), min: 1, max: 1,
  }) })
}

registerSkillRuntime({
  id: HUANG_WUDIE_FUXIE,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const weapon = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .some((cardId) => state.cards[cardId]?.category === 'equipment' && state.cards[cardId]?.equipmentSlot === 'weapon')
    return weapon || huangFuxieSkills(state, ownerId).length > 0
      ? [{ id: `skill:${HUANG_WUDIE_FUXIE}`, label: '发动【伏械】：弃置武器或失去技能，令角色弃置两张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${HUANG_WUDIE_FUXIE}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((cardId) => host.state.cards[cardId]?.category === 'equipment' && host.state.cards[cardId]?.equipmentSlot === 'weapon')
    const skills = huangFuxieSkills(host.state, ownerId)
    const options = [
      ...(cards.length ? [{ id: 'weapon', label: '弃置一张武器牌' }] : []),
      ...(skills.length ? [{ id: 'skill', label: '失去一个其他技能' }] : []),
    ]
    if (!options.length) return
    host.askSkill({ skillId: HUANG_WUDIE_FUXIE, ownerId, step: 'cost-type', data: { weapons: cards }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【伏械】：选择支付的代价', timeoutMs: 25_000,
      optional: false, options,
    }) })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'target') askHuangFuxieTarget(host, ownerId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost-type') {
      const type = (response.payload as { optionId?: string }).optionId
      if (type === 'weapon') {
        const owner = playerOf(host.state, ownerId)
        const candidates = (resolution.data.weapons as CardId[]).filter((cardId) => owner
          && (owner.zones.hand.includes(cardId) || Object.values(owner.zones.equipment).includes(cardId)))
        if (!candidates.length) return
        host.askSkill({ skillId: HUANG_WUDIE_FUXIE, ownerId, step: 'weapon-cost', data: {}, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【伏械】：选择弃置的武器牌', timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      } else if (type === 'skill') {
        const skills = huangFuxieSkills(host.state, ownerId)
        if (!skills.length) return
        host.askSkill({ skillId: HUANG_WUDIE_FUXIE, ownerId, step: 'skill-cost', data: {}, build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: ownerId, prompt: '【伏械】：选择失去的其他技能', timeoutMs: 25_000,
          optional: false, options: skills.map((skillId) => ({ id: skillId, label: skillDisplayName(skillId) })),
        }) })
      }
      return
    }
    if (resolution.step === 'weapon-cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = playerOf(host.state, ownerId)
      if (!cardId || !owner || !((owner.zones.hand.includes(cardId) || Object.values(owner.zones.equipment).includes(cardId))
        && host.state.cards[cardId]?.category === 'equipment' && host.state.cards[cardId]?.equipmentSlot === 'weapon')) return
      if (!discardCardsByIds(host, ownerId, [cardId], HUANG_WUDIE_FUXIE).length) return
      askHuangFuxieTarget(host, ownerId)
      return
    }
    if (resolution.step === 'skill-cost') {
      const skillId = (response.payload as { optionId?: string }).optionId
      if (!skillId || !huangFuxieSkills(host.state, ownerId).includes(skillId)) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      owner.permanentlyLostSkills ??= []
      if (!owner.permanentlyLostSkills.includes(skillId)) owner.permanentlyLostSkills.push(skillId)
      recheckZeroHpAfterSkillLoss(host as never, ownerId)
      if (owner.alive && !host.state.dying) askHuangFuxieTarget(host, ownerId)
      else if (owner.alive) host.queueSkill({ skillId: HUANG_WUDIE_FUXIE, ownerId, step: 'target', data: {} })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.id === ownerId) return
      const candidates = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
      const count = Math.min(2, candidates.length)
      if (!count) return
      host.askSkill({ skillId: HUANG_WUDIE_FUXIE, ownerId, step: 'discard-target', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: '【伏械】：选择弃置两张牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (resolution.step === 'discard-target') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owned = target ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (target?.alive && selected.length === Math.min(2, owned.length) && selected.every((cardId) => owned.includes(cardId)))
        discardCardsByIds(host, targetId, selected, HUANG_WUDIE_FUXIE)
    }
  },
})

export const HISTORICAL_BATCH89_CHARACTERS: readonly CharacterDefinition[] = [
  XU_KUN_B89, MOU_CAO_ANG_B89, LIU_YANG_B89, MOU_DIANWEI_B89, MOU_HUCHEER_B89,
  BIAN_YUE_B89, XING_SUN_SHANGXIANG_B89, MOU_JUSHOU_B89, MOU_CHENLIN_B89, HUANG_WUDIE_B89,
]

