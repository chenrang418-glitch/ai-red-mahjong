import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { takeOverDrawPhase } from '../../engine/draw-phase-takeover'
import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { characterSkillIdsOf, effectiveCardColor, effectiveCardSuit, getSkillRuntime, isCardProtectedFromDiscard, registerSkillRuntime, skillsOf, type SkillHost, type SkillRuntime } from '../../engine/skills/runtime'
import { effectiveCardName, moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, DamageNature, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { LegalAction } from '../../engine/actions'
import { declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { hiddenHandSlot } from '../../engine/cards/host'
import { locateOwnedCard } from '../../engine/zones'
import { startGroupCardDecision, registerGroupCardDecision } from '../../engine/group-card-decision'
import { canTarget, getAttackRange, getDistance } from '../../engine/distance'
import { transferSlashTarget } from '../../engine/cards/basic'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { loseHp } from '../../engine/hp'
import { giveCards } from '../../engine/hand-transfer'
import { restoreCharacter } from '../../engine/character-state'
import { lockCardColor } from '../../engine/card-play-lock'
import { recover } from '../../engine/recover'
import { canPindian, finishPindianSettlement, registerPindianContinuation, startPindian, type PindianResult } from '../../engine/pindian'
import { DELAYED_TRICKS, DAMAGE_TRICKS, INSTANT_TRICKS, instantTrickActions } from '../../engine/cards/tricks'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CharacterDefinition } from './types'

const XIJUE = 'xi-jue-zhanghulecheng-b63'
const JUE_MARK = '爵'
const CANMOU = 'canmou-xinchang-b63'
const CONGJIAN = 'congjian-xinchang-b63'
const FULUE = 'fulue-peiyuanshao-b63'
const TAOHUAI = 'taohuai-duanwei-b63'
const MEIYAN = 'meiyan-qiaoguolao-b63'
const ZHUOYU = 'zhuoyu-qiaoguolao-b63'
const ZUOBAO = 'zuobao-qiaoguolao-b63'
const QIAO_DEBATE = 'qiaoguolao-b63-debate'
const QIAO_DEBATE_TAG = 'qiaoguolao-b63-debate'
const SAYING = 'saying-sunyuan-b63'
const TONGXIN = 'tongxin-sunyuan-b63'
const XINGZUO = 'xingzuo-ruanyu-b63'
const MIAOXIAN = 'miaoxian-ruanyu-b63'
const ZEXING = 'zexing-tangtang-b63'
const ZHIYI = 'zhiyi-tangtang-b63'
const HEXU = 'hexu-dongyuan-b63'
const ZEGUANG = 'zeguang-dongyuan-b63'
const CHENGEN = 'chengen-dongyuan-b63'
const BAZHAN = 'bazhan-fanyufeng-b63'
const JIAOYING = 'jiaoying-fanyufeng-b63'

type XijueState = SanguoshaState & {
  xijueTurnDamage?: Record<PlayerId, { turnNumber: number; amount: number }>
}
type XinChangState = SanguoshaState & {
  xinChangDamagedByTricks?: Record<PlayerId, CardId[]>
}
type PeiYuanShaoState = SanguoshaState & {
  fulueModesThisTurn?: Record<PlayerId, { turnNumber: number; modes: Array<'damage' | 'gain'> }>
  fulueDamageBonus?: Record<CardId, { ownerId: PlayerId; sourceId: PlayerId; turnNumber: number }>
  fuluePendingCard?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; mode: 'damage' | 'gain'; turnNumber: number }>
  fulueCounterGain?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId }>
}
type DuanWeiState = SanguoshaState & {
  taohuaiPending?: Record<CardId, { ownerId: PlayerId; mode: 'yang' | 'yin'; qualifies: boolean }>
}
type QiaoGuoLaoState = SanguoshaState & {
  qiaoZhuoyuTurn?: Record<PlayerId, number>
}
type SunYuanState = SanguoshaState & {
  sunYuanRangePairs?: Array<{ ownerId: PlayerId; otherId: PlayerId; roundNumber: number }>
  sunYuanTongxinQueued?: string[]
  sunYuanTongxinSlashes?: Record<PlayerId, CardId[]>
}
type RuanYuState = SanguoshaState & {
  ruanyuExchangeCount?: Record<PlayerId, { turnNumber: number; count: number }>
  ruanyuRedUsePending?: Record<CardId, { ownerId: PlayerId; turnNumber: number; remainingHandIds: CardId[] }>
}
type TangTangState = SanguoshaState & {
  tangTangTargetsThisTurn?: Record<PlayerId, { turnNumber: number; targetIds: PlayerId[] }>
  tangTangShownCard?: Record<PlayerId, CardId>
  tangTangColorUsed?: Record<PlayerId, number>
}
type DongYuanState = SanguoshaState & {
  dongYuanRecast?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; cardIds: CardId[] }>
  dongYuanFreeDistanceCards?: Record<PlayerId, CardId>
}
type FanYuFengState = SanguoshaState & {
  fanYuFengQuietTurns?: Record<PlayerId, { turnNumber: number; usedCardAfterGain: boolean }>
}

function sunYuanSlashActions(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): Array<Extract<LegalAction, { kind: 'use-card' }>> {
  const actions: Array<Extract<LegalAction, { kind: 'use-card' }>> = []
  const source = playerOf(state, sourceId)
  if (!source?.alive || !playerOf(state, targetId)?.alive) return actions
  const add = (cardId: CardId, label: string, sourceSkillId = SAYING, nature?: DamageNature) => {
    actions.push(...declaredCardActions(state, sourceId, cardId, '杀', label, {
      sourceSkillId, nature, ignoreSlashQuota: true,
    }).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card'
      && action.targetIds.length === 1 && action.targetIds[0] === targetId))
  }
  for (const cardId of source.zones.hand) {
    if (effectiveCardName(state, cardId) === '杀') add(cardId, '【飒影】使用【杀】')
    for (const runtime of skillsOf(state, sourceId, characterSkillIdsOf)) {
      for (const option of runtime.viewAs?.(state, sourceId) ?? []) {
        if (option.cardId === cardId && option.asCardName === '杀') add(cardId, option.label, runtime.id, option.nature)
      }
    }
  }
  return [...new Map(actions.map((action) => [action.id, action])).values()]
}

function sunYuanDiscardOptions(state: SanguoshaState, playerId: PlayerId, discarderId: PlayerId): { cardIds: CardId[]; hiddenCardSlots: string[] } {
  const player = playerOf(state, playerId)
  if (!player) return { cardIds: [], hiddenCardSlots: [] }
  const visible = [...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id)), ...player.zones.judgingArea]
    .filter((cardId) => !isCardProtectedFromDiscard(state, playerId, cardId, discarderId))
  const hidden = player.zones.hand.flatMap((cardId, index) => isCardProtectedFromDiscard(state, playerId, cardId, discarderId)
    ? [] : [hiddenHandSlot(playerId, index)])
  return { cardIds: visible, hiddenCardSlots: hidden }
}

interface QiaoOpinion { playerId: PlayerId; cardId: CardId }
interface QiaoDebateData {
  ownerId: PlayerId
  kind: 'meiyan' | 'zhuoyu'
  opinions: QiaoOpinion[]
  sourceId?: PlayerId
  originalTargetId?: PlayerId
  slashCardId?: CardId
  participantIds: PlayerId[]
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function markCount(state: SanguoshaState, ownerId: PlayerId): number {
  return Math.max(0, playerOf(state, ownerId)?.marks[JUE_MARK] ?? 0)
}

function askOption(host: SkillHost, ownerId: PlayerId, step: string, prompt: string, data: Record<string, unknown>, options: Array<{ id: string; label: string }>, receiverId = ownerId): void {
  host.askSkill({
    skillId: XIJUE,
    ownerId,
    step,
    data,
    build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: receiverId, prompt, timeoutMs: 25_000,
      optional: true, options,
    }),
  })
}

function basicHandIds(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return (playerOf(state, ownerId)?.zones.hand ?? []).filter((id) => state.cards[id]?.category === 'basic')
}

function askBasicCost(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const cardIds = basicHandIds(host.state, ownerId)
  if (!cardIds.length) return
  host.askSkill({
    skillId: XIJUE, ownerId, step: 'xiaoguo-cost', data: { targetId },
    build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId,
      prompt: '【袭爵】：弃置一张基本牌发动【骁果】', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
}

function askEquipCost(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  const equipment = target
    ? Object.entries(target.zones.equipment).flatMap(([slot, id]) => id ? [{ id, slot: slot as EquipmentSlot }] : [])
    : []
  if (!target?.alive || !equipment.length) return
  host.askSkill({
    skillId: XIJUE, ownerId, step: 'xiaoguo-equipment', data: { targetId, equipment },
    build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: targetId,
      prompt: '【骁果】：选择一张装备牌弃置', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: equipment.map(({ id: cardId }) => cardId), hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
}

function uniqueMaximum(state: SanguoshaState, value: (playerId: PlayerId) => number): PlayerId | null {
  const alive = state.players.filter((candidate) => candidate.alive)
  if (!alive.length) return null
  const maximum = Math.max(...alive.map(({ id }) => value(id)))
  const leaders = alive.filter(({ id }) => value(id) === maximum)
  return leaders.length === 1 ? leaders[0]!.id : null
}

function qiaoParticipants(state: SanguoshaState, ownerId: PlayerId, relation: 'atLeast' | 'atMost'): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return state.players.filter((candidate) => candidate.alive
    && (relation === 'atLeast' ? candidate.hp >= owner.hp : candidate.hp <= owner.hp))
    .map((candidate) => candidate.id)
}

function beginQiaoDebate(host: SkillHost, data: Omit<QiaoDebateData, 'opinions'>): void {
  startGroupCardDecision(host, {
    id: `${QIAO_DEBATE}:${host.state.seq}`,
    tag: QIAO_DEBATE_TAG,
    skillId: data.kind === 'meiyan' ? MEIYAN : ZHUOYU,
    playerIds: data.participantIds,
    prompt: '【议事】：秘密选择一张手牌作为意见牌（有手牌时须选择）',
    cardIdsFor: (playerId) => playerOf(host.state, playerId)?.zones.hand ?? [],
    minFor: (_playerId, cardIds) => cardIds.length ? 1 : 0,
    max: 1,
    timeoutMs: 25_000,
    data: { ...data },
  })
}

function qiaoDebateResult(state: SanguoshaState, opinions: QiaoOpinion[], spadesAsHearts: boolean): 'red' | 'black' | null {
  let red = 0
  let black = 0
  for (const { playerId, cardId } of opinions) {
    const card = state.cards[cardId]
    if (!card) continue
    const color = spadesAsHearts && effectiveCardSuit(state, playerId, cardId) === 'spade'
      ? 'red'
      : effectiveCardColor(state, playerId, cardId)
    if (color === 'red') red += card.rank
    else if (color === 'black') black += card.rank
  }
  return red > black ? 'red' : black > red ? 'black' : null
}

function qiaoDiscardOpinions(host: SkillHost, opinions: QiaoOpinion[], ownerId: PlayerId): void {
  for (const { playerId, cardId } of opinions) {
    const player = playerOf(host.state, playerId)
    if (!player?.zones.hand.includes(cardId) || isCardProtectedFromDiscard(host.state, playerId, cardId, ownerId)) continue
    moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: '妁语' }, { sourceId: ownerId, targetId: playerId, cardIds: [cardId] })
  }
}

function finishQiaoDebate(host: SkillHost, data: QiaoDebateData, spadesAsHearts: boolean): void {
  const owner = playerOf(host.state, data.ownerId)
  if (!owner?.alive) {
    if (data.kind === 'zhuoyu') host.resumeCardTarget()
    return
  }
  const result = qiaoDebateResult(host.state, data.opinions, spadesAsHearts)
  if (data.kind === 'meiyan') {
    if (result === 'red') {
      for (const opinion of data.opinions) {
        if (qiaoDebateResult(host.state, [opinion], spadesAsHearts) !== 'red') continue
        const player = playerOf(host.state, opinion.playerId)
        if (!player?.zones.hand.includes(opinion.cardId) || opinion.playerId === data.ownerId) continue
        moveCard(host.state, opinion.cardId, { kind: 'hand', playerId: opinion.playerId }, { kind: 'hand', playerId: data.ownerId })
        host.dispatch('LoseCard', { playerId: opinion.playerId, cardIds: [opinion.cardId], reason: '媒言' }, { sourceId: data.ownerId, targetId: opinion.playerId, cardIds: [opinion.cardId] })
        host.dispatch('GainCard', { playerId: data.ownerId, cardIds: [opinion.cardId], reason: '媒言' }, { sourceId: data.ownerId, targetId: data.ownerId, cardIds: [opinion.cardId] })
      }
    } else if (result === 'black') {
      const recipients = new Set<PlayerId>([data.ownerId])
      for (const opinion of data.opinions) {
        if (qiaoDebateResult(host.state, [opinion], spadesAsHearts) === 'red') recipients.add(opinion.playerId)
      }
      for (const playerId of recipients) {
        if (playerOf(host.state, playerId)?.alive) drawCards(host.state, host.rng, playerId, 1, (name, payload) => { host.dispatch(name, payload) })
      }
    }
    return
  }

  if (result !== 'red' || !data.sourceId || !data.originalTargetId || !data.slashCardId) {
    host.resumeCardTarget()
    return
  }
  qiaoDiscardOpinions(host, data.opinions, data.ownerId)
  const candidates = host.state.players.filter((candidate) => candidate.alive
    && !data.participantIds.includes(candidate.id)
    && candidate.id !== data.sourceId
    && candidate.id !== data.originalTargetId
    && canTarget(host.state, data.sourceId!, candidate.id, Number.POSITIVE_INFINITY, data.slashCardId))
  if (!candidates.length) {
    host.resumeCardTarget()
    return
  }
  host.askSkill({
    skillId: ZHUOYU,
    ownerId: data.ownerId,
    step: 'redirect',
    data: { ...data, spadesAsHearts },
    build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: data.ownerId, prompt: '【妁语】：选择一名未参与议事的角色，令其成为此【杀】的新目标',
      timeoutMs: 25_000, optional: false, candidateIds: candidates.map(({ id: playerId }) => playerId), min: 1, max: 1,
    }),
  })
}

registerGroupCardDecision(QIAO_DEBATE_TAG, (groupHost, decision) => {
  const host = groupHost as SkillHost
  const base = decision.data as Omit<QiaoDebateData, 'opinions'>
  const opinions: QiaoOpinion[] = []
  for (const playerId of decision.playerIds) {
    const cardId = decision.responses[playerId]?.[0]
    if (cardId && playerOf(host.state, playerId)?.zones.hand.includes(cardId)) opinions.push({ playerId, cardId })
  }
  const data: QiaoDebateData = { ...base, opinions }
  const owner = playerOf(host.state, data.ownerId)
  if (owner?.alive && data.participantIds.includes(data.ownerId) && opinions.some(({ playerId }) => playerId === data.ownerId)
    && !owner.usedLimitedSkills.includes(ZUOBAO)) {
    host.askSkill({
      skillId: ZUOBAO,
      ownerId: data.ownerId,
      step: 'zuobao',
      data: { ...data },
      build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: data.ownerId, prompt: '【作保】：你可以令此次议事中所有黑桃意见牌视为红桃',
        timeoutMs: 25_000, optional: true, options: [{ id: 'use', label: '发动【作保】' }, { id: 'decline', label: '不发动' }],
      }),
    })
    return
  }
  finishQiaoDebate(host, data, false)
})

function isOrdinaryTrick(state: SanguoshaState, action: Extract<LegalAction, { kind: 'use-card' }>): boolean {
  const card = state.cards[action.cardIds[0] ?? '']
  return Boolean((card?.category === 'trick' || INSTANT_TRICKS.has(action.asCardName))
    && INSTANT_TRICKS.has(action.asCardName) && !DELAYED_TRICKS.has(action.asCardName))
}

function extraLegalTargets(state: SanguoshaState, action: Extract<LegalAction, { kind: 'use-card' }>): PlayerId[] {
  const cardId = action.cardIds[0]
  if (!cardId) return []
  const actions = instantTrickActions(state, action.playerId, cardId, action.asCardName, { allowOneAdditionalTarget: true })
  const candidates = new Set<PlayerId>()
  for (const candidate of actions) {
    if (candidate.kind !== 'use-card' || candidate.targetIds.length !== action.targetIds.length + 1) continue
    if (!action.targetIds.every((targetId) => candidate.targetIds.includes(targetId))) continue
    for (const targetId of candidate.targetIds) {
      if (!action.targetIds.includes(targetId)) candidates.add(targetId)
    }
  }
  return [...candidates]
}

function askXinChangInvoke(
  host: SkillHost,
  ownerId: PlayerId,
  skillId: string,
  step: string,
  prompt: string,
  data: Record<string, unknown>,
): void {
  host.askSkill({
    skillId, ownerId, step, data,
    build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
    }),
  })
}

function resumeXinChangPlay(
  host: SkillHost,
  ownerId: PlayerId,
  resolution: { step: string; data: Record<string, unknown> },
  response: { payload: unknown },
): void {
  const data = resolution.data as {
    action: Extract<LegalAction, { kind: 'use-card' }>
    canmouTargets: PlayerId[]
    fromjianTarget?: PlayerId
    canmouDone?: boolean
  }
  const action = data.action
  const optionId = (response.payload as { optionId?: string }).optionId
  const continueAfterCanmou = (nextAction: Extract<LegalAction, { kind: 'use-card' }>) => {
    if (data.fromjianTarget && !nextAction.targetIds.includes(ownerId)) {
      askXinChangInvoke(host, ownerId, CONGJIAN, 'fromjian-invoke', '【从鉴】：是否成为此普通锦囊牌的额外目标？若此牌结算后对你造成伤害，你摸两张牌。', {
        action: nextAction, canmouTargets: [], canmouDone: true, fromjianTarget: data.fromjianTarget,
      })
      return
    }
    executeUseCardAction(host as never, nextAction.playerId, nextAction)
  }

  if (resolution.step === 'canmou-invoke') {
    if (optionId !== 'yes' || data.canmouTargets.length === 0) {
      continueAfterCanmou(action)
      return
    }
    host.askSkill({
      skillId: CANMOU, ownerId, step: 'canmou-target', data,
      build: (id) => ({
        id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【参谋】：为此普通锦囊牌选择一个额外目标', timeoutMs: 25_000,
        optional: false, candidateIds: data.canmouTargets, min: 1, max: 1,
      }),
    })
    return
  }

  if (resolution.step === 'canmou-target') {
    const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
    if (!targetId || !data.canmouTargets.includes(targetId) || action.targetIds.includes(targetId)) {
      continueAfterCanmou(action)
      return
    }
    continueAfterCanmou({ ...action, targetIds: [...action.targetIds, targetId] })
    return
  }

  if (resolution.step === 'fromjian-invoke') {
    if (optionId === 'yes' && !action.targetIds.includes(ownerId)) {
      executeUseCardAction(host as never, action.playerId, { ...action, targetIds: [...action.targetIds, ownerId] })
      return
    }
    executeUseCardAction(host as never, action.playerId, action)
  }
}

const xinChangRuntime: Pick<SkillRuntime, 'interceptPlayAction' | 'resume' | 'triggers'> = {
  interceptPlayAction(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>): boolean {
    if (!isOrdinaryTrick(host.state, action)) return false
    const sourceIsUniqueMaxHand = uniqueMaximum(host.state, (id) => playerOf(host.state, id)?.zones.hand.length ?? -1) === action.playerId
    const canmouTargets = sourceIsUniqueMaxHand ? extraLegalTargets(host.state, action) : []
    const uniqueMaxHp = uniqueMaximum(host.state, (id) => playerOf(host.state, id)?.hp ?? -1)
    const fromjianTarget = action.targetIds.length === 1
      && action.targetIds[0] !== ownerId
      && action.targetIds[0] === uniqueMaxHp
      ? action.targetIds[0]
      : undefined
    if (!canmouTargets.length && !fromjianTarget) return false

    const data = { action, canmouTargets, fromjianTarget }
    if (canmouTargets.length) {
      askXinChangInvoke(host, ownerId, CANMOU, 'canmou-invoke', '【参谋】：是否为此普通锦囊牌增加一个目标？', data)
    } else {
      askXinChangInvoke(host, ownerId, CONGJIAN, 'fromjian-invoke', '【从鉴】：是否成为此普通锦囊牌的额外目标？若此牌结算后对你造成伤害，你摸两张牌。', data)
    }
    return true
  },
  resume(host, ownerId, resolution, response) {
    resumeXinChangPlay(host, ownerId, { step: resolution.step, data: resolution.data ?? {} }, response)
  },
  triggers: [
    {
      event: 'DamageSettled',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const payload = context.event.payload as { finalAmount?: number; cardId?: CardId | null; cardName?: string | null }
        if (!(payload.finalAmount && payload.finalAmount > 0) || !payload.cardId || !payload.cardName) return
        if (!isOrdinaryTrick(host.state, {
          id: 'resolved', kind: 'use-card', playerId: context.event.sourceId ?? ownerId,
          cardIds: [payload.cardId], targetIds: [ownerId], targetMin: 0, targetMax: 99,
          asCardName: payload.cardName, label: '',
        })) return
        const damaged = (host.state as XinChangState).xinChangDamagedByTricks ??= {}
        const cards = damaged[ownerId] ??= []
        if (!cards.includes(payload.cardId)) cards.push(payload.cardId)
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
        if (!payload.cardId) return
        const state = host.state as XinChangState
        const records = state.xinChangDamagedByTricks ??= {}
        const cards = records[ownerId] ?? []
        if (!cards.includes(payload.cardId)) return
        records[ownerId] = cards.filter((cardId) => cardId !== payload.cardId)
        if (playerOf(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 2, (name, eventPayload) => { host.dispatch(name, eventPayload) })
      },
    },
  ],
}

registerSkillRuntime({ id: CANMOU, interceptPlayAction: xinChangRuntime.interceptPlayAction, resume: xinChangRuntime.resume })
registerSkillRuntime({ id: CONGJIAN, resume: xinChangRuntime.resume, triggers: xinChangRuntime.triggers })

function fulueModes(state: SanguoshaState, ownerId: PlayerId): Array<'damage' | 'gain'> {
  const record = (state as PeiYuanShaoState).fulueModesThisTurn?.[ownerId]
  if (!record || record.turnNumber !== state.turnNumber) return []
  return record.modes
}

function fulueTargetCardChoices(state: SanguoshaState, targetId: PlayerId): { cardIds: CardId[]; hiddenCardSlots: string[] } {
  const target = playerOf(state, targetId)
  if (!target) return { cardIds: [], hiddenCardSlots: [] }
  return {
    cardIds: [...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea],
    hiddenCardSlots: target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index)),
  }
}

function gainFulueCard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, selected: string): void {
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  const hiddenMatch = /^hidden:[^:]+:(\d+)$/.exec(selected)
  const cardId = hiddenMatch ? target.zones.hand[Number(hiddenMatch[1])] : selected as CardId
  const from = cardId ? locateOwnedCard(host.state, targetId, cardId) : null
  if (!cardId || !from || !(target.zones.hand.includes(cardId) || from.kind === 'equipment' || from.kind === 'judgingArea')) return
  moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
  host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '复掠' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '复掠' }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
}

function fulueEligible(state: SanguoshaState, action: Extract<LegalAction, { kind: 'use-card' }>): boolean {
  if (action.kind !== 'use-card' || action.targetIds.length !== 1) return false
  if (action.asCardName === '杀') return true
  const card = state.cards[action.cardIds[0] ?? '']
  return card?.category === 'trick' && DAMAGE_TRICKS.has(action.asCardName)
}

function fulueSlashActions(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): Array<Extract<LegalAction, { kind: 'use-card' }>> {
  const source = playerOf(state, sourceId)
  if (!source?.alive) return []
  const uses = new Map<string, { cardId: CardId; sourceSkillId?: string }>()
  for (const cardId of source.zones.hand) {
    if (effectiveCardName(state, cardId) === '杀') uses.set(`${cardId}:physical`, { cardId })
  }
  for (const skill of skillsOf(state, sourceId, characterSkillIdsOf)) {
    for (const option of skill.viewAs?.(state, sourceId) ?? []) {
      if (option.asCardName === '杀' && !option.retainCard && source.zones.hand.includes(option.cardId)) {
        uses.set(`${option.cardId}:${skill.id}`, { cardId: option.cardId, sourceSkillId: skill.id })
      }
    }
  }
  return [...uses.values()].flatMap(({ cardId, sourceSkillId }) => declaredCardActions(
    state, sourceId, cardId, '杀', '使用【杀】', sourceSkillId ? { sourceSkillId } : {},
  ).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card'
    && action.targetIds.length === 1 && action.targetIds[0] === targetId))
}

function chooseFulueMode(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>): boolean {
  const targetId = action.targetIds[0]
  if (!targetId) return false
  const unused = fulueModes(host.state, ownerId)
  const choices: Array<{ id: string; label: string }> = []
  if (!unused.includes('damage')) choices.push({ id: 'damage', label: '此牌造成的伤害+1' })
  const targetCards = fulueTargetCardChoices(host.state, targetId)
  if (!unused.includes('gain') && (targetCards.cardIds.length + targetCards.hiddenCardSlots.length) > 0) {
    choices.push({ id: 'gain', label: '获得目标角色区域里的一张牌' })
  }
  if (!choices.length) return false
  host.askSkill({
    skillId: FULUE, ownerId, step: 'mode', data: { action, targetId },
    build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【复掠】：选择本回合尚未执行的一项；若此牌结算后未造成伤害，目标可对你使用【杀】并执行另一项。',
      timeoutMs: 25_000, optional: true,
      options: [{ id: 'decline', label: '不发动' }, ...choices],
    }),
  })
  return true
}

registerSkillRuntime({
  id: FULUE,
  interceptPlayAction(host, ownerId, action) {
    return action.playerId === ownerId && action.sourceSkillId !== FULUE && fulueEligible(host.state, action)
      && fulueModes(host.state, ownerId).length < 2 && chooseFulueMode(host, ownerId, action)
  },
  outgoingDamage(state, ownerId, context) {
    if (!context.cardId) return null
    const bonus = (state as PeiYuanShaoState).fulueDamageBonus?.[context.cardId]
    return bonus?.ownerId === ownerId && bonus.sourceId === ownerId && bonus.turnNumber === state.turnNumber ? { amount: context.amount + 1 } : null
  },
  globalOutgoingDamage(state, ownerId, sourceId, context) {
    if (!context.cardId) return null
    const bonus = (state as PeiYuanShaoState).fulueDamageBonus?.[context.cardId]
    return bonus?.ownerId === ownerId && bonus.sourceId === sourceId && bonus.turnNumber === state.turnNumber
      ? { amount: context.amount + 1 } : null
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mode') {
      const { action, targetId } = resolution.data as { action: Extract<LegalAction, { kind: 'use-card' }>; targetId: PlayerId }
      const mode = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || !fulueEligible(host.state, action) || mode === 'decline') {
        executeUseCardAction(host as never, ownerId, action)
        return
      }
      const used = fulueModes(host.state, ownerId)
      if (used.length >= 2 || used.includes(mode as 'damage' | 'gain')) {
        executeUseCardAction(host as never, ownerId, action)
        return
      }
      const modes = (host.state as PeiYuanShaoState).fulueModesThisTurn ??= {}
      const record = modes[ownerId]?.turnNumber === host.state.turnNumber
        ? modes[ownerId]!
        : (modes[ownerId] = { turnNumber: host.state.turnNumber, modes: [] })
      record.modes.push(mode as 'damage' | 'gain')
      const cardId = action.cardIds[0]
      if (cardId) {
        const state = host.state as PeiYuanShaoState
        ;(state.fuluePendingCard ??= {})[cardId] = { ownerId, targetId, mode: mode as 'damage' | 'gain', turnNumber: host.state.turnNumber }
        if (mode === 'damage') (state.fulueDamageBonus ??= {})[cardId] = { ownerId, sourceId: ownerId, turnNumber: host.state.turnNumber }
      }
      if (mode === 'gain') {
        const choices = fulueTargetCardChoices(host.state, targetId)
        if (!choices.cardIds.length && !choices.hiddenCardSlots.length) {
          executeUseCardAction(host as never, ownerId, action)
          return
        }
        host.askSkill({
          skillId: FULUE, ownerId, step: 'gain-card', data: { action, targetId },
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
            prompt: '【复掠】：选择获得目标角色区域里的一张牌', timeoutMs: 25_000,
            optional: false, purpose: 'skill', ...choices, min: 1, max: 1 }),
        })
        return
      }
      executeUseCardAction(host as never, ownerId, action)
      return
    }
    if (resolution.step === 'fulue-counter-invoke') {
      const data = resolution.data as { targetId: PlayerId; mode: 'damage' | 'gain'; turnNumber: number }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const actions = fulueSlashActions(host.state, data.targetId, ownerId)
      if (!actions.length) return
      host.askSkill({ skillId: FULUE, ownerId, step: 'fulue-counter-card', data: { ...data, actions }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: data.targetId, prompt: '【复掠】：选择一张合法的【杀】对裴元绍使用', timeoutMs: 25_000,
        optional: false, options: actions.map((candidate) => ({ id: candidate.id, label: candidate.label })),
      }) })
      return
    }
    if (resolution.step === 'fulue-counter-card') {
      const data = resolution.data as { targetId: PlayerId; mode: 'damage' | 'gain'; turnNumber: number; actions: Array<Extract<LegalAction, { kind: 'use-card' }>> }
      const actionId = (response.payload as { optionId?: string }).optionId
      const action = data.actions.find((candidate) => candidate.id === actionId)
      if (!action || !playerOf(host.state, ownerId)?.alive || !playerOf(host.state, data.targetId)?.alive) return
      const state = host.state as PeiYuanShaoState
      const modes = state.fulueModesThisTurn ??= {}
      const record = modes[ownerId]?.turnNumber === data.turnNumber ? modes[ownerId]! : (modes[ownerId] = { turnNumber: data.turnNumber, modes: [] })
      if (record.modes.includes(data.mode)) return
      record.modes.push(data.mode)
      const counterCardId = action.cardIds[0]
      if (data.mode === 'damage') {
        ;(state.fulueDamageBonus ??= {})[counterCardId] = { ownerId, sourceId: data.targetId, turnNumber: host.state.turnNumber }
      } else {
        ;(state.fulueCounterGain ??= {})[counterCardId] = { ownerId, targetId: data.targetId }
      }
      executeUseCardAction(host as never, data.targetId, { ...action, sourceSkillId: FULUE })
      return
    }
    if (resolution.step === 'fulue-counter-gain') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const selected = (response.payload as { cardIds: string[] }).cardIds[0]
      if (selected) gainFulueCard(host, ownerId, targetId, selected)
      return
    }
    if (resolution.step !== 'gain-card') return
    const { action, targetId } = resolution.data as { action: Extract<LegalAction, { kind: 'use-card' }>; targetId: PlayerId }
    const selected = (response.payload as { cardIds: string[] }).cardIds[0]
    if (selected) gainFulueCard(host, ownerId, targetId, selected)
    executeUseCardAction(host as never, ownerId, action)
  },
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (!payload.cardId) return
      // Consume the per-card bonus whether the card hit, missed, was nullified,
      // or had all damage prevented.
      const state = host.state as PeiYuanShaoState
      const counterGain = state.fulueCounterGain?.[payload.cardId]
      if (counterGain?.ownerId === ownerId) {
        delete state.fulueCounterGain?.[payload.cardId]
        const choices = fulueTargetCardChoices(host.state, counterGain.targetId)
        if (choices.cardIds.length || choices.hiddenCardSlots.length) host.askSkill({ skillId: FULUE, ownerId: counterGain.ownerId, step: 'fulue-counter-gain', data: { targetId: counterGain.targetId }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: counterGain.ownerId, prompt: '【复掠】：选择获得其区域里的一张牌', timeoutMs: 25_000,
          optional: false, purpose: 'skill', ...choices, min: 1, max: 1,
        }) })
      }
      const pending = state.fuluePendingCard?.[payload.cardId]
      delete state.fuluePendingCard?.[payload.cardId]
      delete state.fulueDamageBonus?.[payload.cardId]
      if (!pending || pending.ownerId !== ownerId || pending.turnNumber !== host.state.turnNumber || cardDamageDealt(host.state, payload.cardId) > 0
        || !playerOf(host.state, pending.ownerId)?.alive || !playerOf(host.state, pending.targetId)?.alive) return
      const otherMode = pending.mode === 'damage' ? 'gain' : 'damage'
      if (fulueModes(host.state, pending.ownerId).includes(otherMode)) return
      host.askSkill({ skillId: FULUE, ownerId: pending.ownerId, step: 'fulue-counter-invoke', data: { targetId: pending.targetId, mode: otherMode, turnNumber: pending.turnNumber },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: pending.targetId,
          prompt: '【复掠】：此牌未造成伤害，你可以对裴元绍使用一张【杀】并执行另一项', timeoutMs: 25_000, optional: true,
          options: [{ id: 'yes', label: '使用【杀】并执行另一项' }, { id: 'no', label: '不使用' }],
        }) })
    },
  }],
})

registerSkillRuntime({
  id: TAOHUAI,
  interceptPlayAction(host, ownerId, action) {
    if (action.kind !== 'use-card' || action.playerId !== ownerId || action.cardIds.length !== 1) return false
    const cardId = action.cardIds[0]!
    const owner = playerOf(host.state, ownerId)
    const card = host.state.cards[cardId]
    if (!owner?.zones.hand.includes(cardId) || !card || !Number.isFinite(card.rank)) return false
    const mode = conversionStateOf(host.state, ownerId, TAOHUAI)
    const ranks = owner.zones.hand.map((id) => host.state.cards[id]?.rank ?? 0)
    const edge = mode === 'yang' ? Math.max(...ranks) : Math.min(...ranks)
    ;((host.state as DuanWeiState).taohuaiPending ??= {})[cardId] = { ownerId, mode, qualifies: card.rank === edge }
    return false
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const cardId = (resolution.data as { cardId: CardId }).cardId
    const selected = (response.payload as { cardIds: CardId[] }).cardIds[0]
    if (!selected) return
    const from = locateOwnedCard(host.state, ownerId, selected)
    if (!from || from.kind === 'characterPile' || isCardProtectedFromDiscard(host.state, ownerId, selected, ownerId)) return
    moveCard(host.state, selected, from, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [selected], reason: '讨怀' }, { sourceId: ownerId, cardIds: [selected] })
    toggleConversionState(host.state, ownerId, TAOHUAI)
    delete (host.state as DuanWeiState).taohuaiPending?.[cardId]
  },
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      const state = host.state as DuanWeiState
      const pending = state.taohuaiPending?.[cardId]
      if (!pending || pending.ownerId !== ownerId) return
      delete state.taohuaiPending?.[cardId]
      if (pending.qualifies) {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
        toggleConversionState(host.state, ownerId, TAOHUAI)
        return
      }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)), ...owner.zones.judgingArea]
        .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      if (!cardIds.length) return
      host.askSkill({ skillId: TAOHUAI, ownerId, step: 'discard', data: { cardId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【讨怀】（${pending.mode === 'yang' ? '阳' : '阴'}）：此牌点数${pending.mode === 'yang' ? '不是手牌最大' : '不是手牌最小'}，是否弃置一张牌？`,
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
      }) })
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const endingPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (endingPlayerId !== ownerId) return
      const pending = (host.state as DuanWeiState).taohuaiPending
      if (!pending) return
      for (const [cardId, entry] of Object.entries(pending)) {
        if (entry.ownerId === ownerId) delete pending[cardId as CardId]
      }
    },
  }],
})

registerSkillRuntime({
  id: MEIYAN,
  activeActions(state, ownerId) {
    return state.status === 'playing' && state.phase === 'play' && state.currentPlayerId === ownerId
      && !usedThisPhase(state, ownerId, MEIYAN)
      ? [{ id: MEIYAN, label: '媒言：与符合条件的角色议事' }]
      : []
  },
  invokeActive(host, ownerId) {
    markUsedThisPhase(host.state, ownerId, MEIYAN)
    beginQiaoDebate(host, {
      ownerId,
      kind: 'meiyan',
      participantIds: qiaoParticipants(host.state, ownerId, 'atLeast'),
    })
  },
})

registerSkillRuntime({
  id: ZHUOYU,
  interceptBystanderTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId === ownerId || context.targetId === ownerId) return false
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, context.targetId)
    const state = host.state as QiaoGuoLaoState
    if (!owner?.alive || !target?.alive
      || getDistance(host.state, ownerId, target.id) > getAttackRange(host.state, ownerId)
      || state.qiaoZhuoyuTurn?.[ownerId] === host.state.turnNumber) return false
    const participants = qiaoParticipants(host.state, ownerId, 'atMost')
    const hasRedirect = host.state.players.some((candidate) => candidate.alive
      && !participants.includes(candidate.id)
      && candidate.id !== context.sourceId
      && candidate.id !== context.targetId
      && canTarget(host.state, context.sourceId, candidate.id, Number.POSITIVE_INFINITY, context.cardId))
    if (!hasRedirect) return false
    host.askSkill({
      skillId: ZHUOYU,
      ownerId,
      step: 'zhuoyu-invoke',
      data: { sourceId: context.sourceId, originalTargetId: context.targetId, slashCardId: context.cardId, participantIds: participants },
      build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【妁语】：是否与所有体力值小于等于你的角色议事？',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动【妁语】' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'zhuoyu-invoke') {
      const data = resolution.data as Omit<QiaoDebateData, 'opinions' | 'kind'>
        & { kind?: 'zhuoyu'; sourceId: PlayerId; originalTargetId: PlayerId; slashCardId: CardId }
      const slash = host.state.cardResolution
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        host.resumeCardTarget()
        return
      }
      if (slash?.kind !== 'slash' || slash.cardId !== data.slashCardId || slash.sourceId !== data.sourceId || slash.targetId !== data.originalTargetId) {
        host.resumeCardTarget()
        return
      }
      const state = host.state as QiaoGuoLaoState
      state.qiaoZhuoyuTurn ??= {}
      state.qiaoZhuoyuTurn[ownerId] = host.state.turnNumber
      beginQiaoDebate(host, {
        ownerId, kind: 'zhuoyu', sourceId: data.sourceId, originalTargetId: data.originalTargetId,
        slashCardId: data.slashCardId, participantIds: data.participantIds,
      })
      return
    }
    if (resolution.step === 'redirect') {
      const data = resolution.data as unknown as QiaoDebateData
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const slash = host.state.cardResolution
      const legal = targetId && data.participantIds.every((id) => id !== targetId)
        && targetId !== data.sourceId && targetId !== data.originalTargetId
        && playerOf(host.state, targetId)?.alive
        && canTarget(host.state, data.sourceId!, targetId, Number.POSITIVE_INFINITY, data.slashCardId)
      if (!legal || slash?.kind !== 'slash' || slash.cardId !== data.slashCardId || slash.targetId !== data.originalTargetId) {
        host.resumeCardTarget()
        return
      }
      transferSlashTarget(host as never, targetId, '乔国老【妁语】')
    }
  },
})

registerSkillRuntime({
  id: ZUOBAO,
  limited: true,
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'zuobao') return
    const data = resolution.data as unknown as QiaoDebateData
    const use = (response.payload as { optionId?: string }).optionId === 'use'
    if (use) {
      const owner = playerOf(host.state, ownerId)
      if (!owner || owner.usedLimitedSkills.includes(ZUOBAO)) {
        finishQiaoDebate(host, data, false)
        return
      }
      owner.usedLimitedSkills.push(ZUOBAO)
    }
    finishQiaoDebate(host, data, use)
  },
})

registerSkillRuntime({
  id: SAYING,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const candidates = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
        && (pickableCardsOf(host.state, candidate.id, { includeJudgingArea: true }).cardIds.length
          + pickableCardsOf(host.state, candidate.id, { includeJudgingArea: true }).hiddenCardSlots.length > 0))
      if (!candidates.length) return
      host.askSkill({
        skillId: SAYING, ownerId, step: 'target',
        build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【飒影】：选择一名其他角色，获得其区域内一张牌',
          timeoutMs: 25_000, optional: true, candidateIds: candidates.map(({ id: playerId }) => playerId), min: 0, max: 1,
        }),
      })
    },
  }, {
    event: 'RoundEnd',
    handle(host, ownerId, context) {
      const roundNumber = (context.event.payload as { roundNumber?: number }).roundNumber
      const state = host.state as SunYuanState
      state.sunYuanRangePairs = (state.sunYuanRangePairs ?? []).filter((pair) => pair.ownerId !== ownerId || pair.roundNumber !== roundNumber)
    },
  }],
  globalSlashIgnoresDistanceTo(state, ownerId, attackerId, targetId) {
    const sun = state as SunYuanState
    return (sun.sunYuanRangePairs ?? []).some((pair) => pair.ownerId === ownerId && pair.roundNumber === state.roundNumber
      && ((pair.ownerId === attackerId && pair.otherId === targetId) || (pair.ownerId === targetId && pair.otherId === attackerId)))
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { targetId?: PlayerId; actions?: LegalAction[] }
    if (resolution.step === 'slash') {
      const selected = (response.payload as { optionId?: string }).optionId
      const offered = data.actions?.find((action) => action.kind === 'use-card' && action.id === selected)
      if (!offered || !data.targetId || !playerOf(host.state, data.targetId)?.alive || !playerOf(host.state, ownerId)?.alive) return
      const current = sunYuanSlashActions(host.state, data.targetId, ownerId).find((action) => action.id === offered.id)
      if (current) executeUseCardAction(host as never, data.targetId, { ...current, sourceSkillId: SAYING }, { countSlashUsage: false })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const pickable = pickableCardsOf(host.state, targetId, { includeJudgingArea: true })
      host.askSkill({
        skillId: SAYING, ownerId, step: 'card', data: { targetId },
        build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【飒影】：选择获得其区域内的一张牌',
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: pickable.cardIds,
          hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'card' || !data.targetId) return
    const target = playerOf(host.state, data.targetId)
    const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = picked && target?.alive ? resolvePickedCard(host.state, data.targetId, picked) : null
    if (!target?.alive || !cardId || !movePickedCard(host as never, data.targetId, cardId, { kind: 'hand', playerId: ownerId })) return
    host.dispatch('LoseCard', { playerId: data.targetId, cardIds: [cardId], reason: '飒影' }, { sourceId: ownerId, targetId: data.targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '飒影' }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    if (getDistance(host.state, data.targetId, ownerId) <= getAttackRange(host.state, data.targetId)) {
      const actions = sunYuanSlashActions(host.state, data.targetId, ownerId)
      if (!actions.length) return
      host.askSkill({
        skillId: SAYING, ownerId, step: 'slash', data: { targetId: data.targetId, actions },
        build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: data.targetId!, prompt: '【飒影】：是否对孙鸢使用一张【杀】？',
          timeoutMs: 25_000, optional: true,
          options: [...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'decline', label: '不使用' }],
        }),
      })
      return
    }
    const state = host.state as SunYuanState
    const pairs = state.sunYuanRangePairs ??= []
    const currentRound = host.state.roundNumber
    if (!pairs.some((pair) => pair.ownerId === ownerId && pair.otherId === data.targetId && pair.roundNumber === currentRound)) {
      pairs.push({ ownerId, otherId: data.targetId, roundNumber: currentRound })
    }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const data = prompt.data as { sourceId: PlayerId; injuredId: PlayerId; direction: 'deal' | 'take'; key: string; turnNumber: number }
    const injured = playerOf(host.state, data.injuredId)
    const source = playerOf(host.state, data.sourceId)
    const choices = sunYuanDiscardOptions(host.state, data.injuredId, ownerId)
    const available = choices.cardIds.length + choices.hiddenCardSlots.length
    if (!injured?.alive || !source?.alive || !available) {
      const state = host.state as SunYuanState
      state.sunYuanTongxinQueued = (state.sunYuanTongxinQueued ?? []).filter((key) => key !== data.key)
      return
    }
    host.askSkill({
      skillId: TONGXIN, ownerId, step: 'invoke', data,
      build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【恫心】：是否弃置${Math.min(injured.maxHp - injured.hp + 1, available)}张牌，对伤害来源造成1点伤害？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动【恫心】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
})

registerSkillRuntime({
  id: TONGXIN,
  unlimitedSlashFor(state, ownerId, cardId) {
    return Boolean(cardId && (state as SunYuanState).sunYuanTongxinSlashes?.[ownerId]?.includes(cardId))
  },
  triggers: [{
    event: 'DamageSettled',
    handle(host, ownerId, context) {
      const finalAmount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      if (finalAmount <= 0 || !sourceId || !targetId) return
      const direction = sourceId === ownerId ? 'deal' : targetId === ownerId ? 'take' : null
      if (!direction) return
      const state = host.state as SunYuanState
      const skillKey = `${TONGXIN}:${direction}`
      const key = `${ownerId}:${direction}:${host.state.turnNumber}`
      state.sunYuanTongxinQueued ??= []
      if (usedThisTurn(host.state, ownerId, skillKey) || state.sunYuanTongxinQueued.includes(key)) return
      const source = playerOf(host.state, sourceId)
      const injured = playerOf(host.state, direction === 'deal' ? targetId : ownerId)
      if (!source?.alive || !injured?.alive) return
      state.sunYuanTongxinQueued.push(key)
      host.queueSkill({ skillId: TONGXIN, ownerId, step: 'invoke', data: {
        sourceId, injuredId: injured.id, direction, key, turnNumber: host.state.turnNumber,
      } })
    },
  }, {
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const ids = (host.state as SunYuanState).sunYuanTongxinSlashes?.[ownerId]
      if (!payload.cardId || payload.cardName !== '杀' || !ids?.includes(payload.cardId)) return
      ;(host.state as SunYuanState).sunYuanTongxinSlashes![ownerId] = ids.filter((id) => id !== payload.cardId)
    },
  }],
  startQueued(host, ownerId, prompt) {
    const runtime = getSkillRuntime(SAYING)
    runtime?.startQueued?.(host, ownerId, prompt)
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { sourceId: PlayerId; injuredId: PlayerId; direction: 'deal' | 'take'; key: string; turnNumber: number; required?: number }
    const state = host.state as SunYuanState
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        state.sunYuanTongxinQueued = (state.sunYuanTongxinQueued ?? []).filter((key) => key !== data.key)
        return
      }
      const injured = playerOf(host.state, data.injuredId)
      const source = playerOf(host.state, data.sourceId)
      const choices = sunYuanDiscardOptions(host.state, data.injuredId, ownerId)
      const available = choices.cardIds.length + choices.hiddenCardSlots.length
      if (!injured?.alive || !source?.alive || !available) {
        state.sunYuanTongxinQueued = (state.sunYuanTongxinQueued ?? []).filter((key) => key !== data.key)
        return
      }
      const required = Math.min(Math.max(1, injured.maxHp - injured.hp + 1), available)
      host.askSkill({
        skillId: TONGXIN, ownerId, step: 'discard', data: { ...data, required },
        build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: `【恫心】：选择弃置${required}张牌`,
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: choices.cardIds,
          hiddenCardSlots: choices.hiddenCardSlots, min: required, max: required,
        }),
      })
      return
    }
    if (resolution.step !== 'discard') return
    const injured = playerOf(host.state, data.injuredId)
    const source = playerOf(host.state, data.sourceId)
    const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
    if (!injured?.alive || !source?.alive || selected.length !== data.required) return
    const discarded: CardId[] = []
    for (const picked of selected) {
      const cardId = resolvePickedCard(host.state, data.injuredId, picked)
      if (!cardId || isCardProtectedFromDiscard(host.state, data.injuredId, cardId, ownerId)
        || !movePickedCard(host as never, data.injuredId, cardId, { kind: 'discardPile' })) continue
      discarded.push(cardId)
      host.dispatch('LoseCard', { playerId: data.injuredId, cardIds: [cardId], reason: '恫心' }, { sourceId: ownerId, targetId: data.injuredId, cardIds: [cardId] })
    }
    state.sunYuanTongxinQueued = (state.sunYuanTongxinQueued ?? []).filter((key) => key !== data.key)
    if (!discarded.length) return
    markUsedThisTurn(host.state, ownerId, `${TONGXIN}:${data.direction}`)
    resolveDamage(host as never, { sourceId: ownerId, targetId: data.sourceId, amount: 1, nature: 'normal', cardName: null })
    const slashes = discarded.filter((cardId) => host.state.zones.discardPile.includes(cardId) && effectiveCardName(host.state, cardId) === '杀')
    if (playerOf(host.state, ownerId)?.alive) {
      const grants = state.sunYuanTongxinSlashes ??= {}
      grants[ownerId] = [...new Set([...(grants[ownerId] ?? []), ...slashes])]
      for (const cardId of slashes) {
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '恫心' }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      }
    }
  },
})

function askRuanYuExchange(host: SkillHost, ownerId: PlayerId): void {
  const state = host.state as RuanYuState
  const entry = state.ruanyuExchangeCount?.[ownerId]
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || !entry || entry.turnNumber !== host.state.turnNumber || entry.count <= 0) return
  const targets = host.state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length > 0)
  if (!targets.length) {
    delete state.ruanyuExchangeCount?.[ownerId]
    return
  }
  host.askSkill({
    skillId: XINGZUO, ownerId, step: 'exchange-target', data: { turnNumber: entry.turnNumber },
    build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【兴作】：选择一名有手牌的角色，以其所有手牌替换牌堆底三张牌',
      timeoutMs: 25_000, optional: true, candidateIds: targets.map(({ id: playerId }) => playerId), min: 0, max: 1,
    }),
  })
}

function ruanyuReplaceBottom(host: SkillHost, ownerId: PlayerId, bottomIds: CardId[], handIds: CardId[]): boolean {
  const owner = playerOf(host.state, ownerId)
  const drawPile = host.state.zones.drawPile
  const replaceCount = bottomIds.length
  if (!owner?.alive || replaceCount === 0 || handIds.length !== replaceCount
    || new Set(handIds).size !== handIds.length
    || handIds.some((id) => !owner.zones.hand.includes(id))
    || bottomIds.some((id) => !drawPile.includes(id))) return false
  const snapshot = [...drawPile]
  const positions = bottomIds.map((id) => snapshot.indexOf(id))
  if (positions.some((index) => index < 0)) return false
  const replacementAt = new Map<number, CardId>()
  positions.forEach((index, slot) => replacementAt.set(index, handIds[slot]!))
  for (const cardId of bottomIds) {
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '兴作' }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  }
  for (const cardId of handIds) {
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '兴作' }, { sourceId: ownerId, cardIds: [cardId] })
  }
  host.state.zones.drawPile = snapshot.map((id, index) => replacementAt.get(index) ?? id)
  const state = host.state as RuanYuState
  state.ruanyuExchangeCount ??= {}
  const previous = state.ruanyuExchangeCount[ownerId]
  state.ruanyuExchangeCount[ownerId] = {
    turnNumber: host.state.turnNumber,
    count: (previous?.turnNumber === host.state.turnNumber ? previous.count : 0) + 1,
  }
  return true
}

registerSkillRuntime({
  id: XINGZUO,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId) return
      const state = host.state as RuanYuState
      if (payload.phase === 'play') {
        const owner = playerOf(host.state, ownerId)
        const bottomIds = host.state.zones.drawPile.slice(-3)
        if (!owner?.alive || owner.zones.hand.length === 0 || bottomIds.length === 0) return
        const max = Math.min(bottomIds.length, owner.zones.hand.length)
        host.askSkill({
          skillId: XINGZUO, ownerId, step: 'replace-bottom', data: { bottomIds },
          build: (id): ChooseCardsRequest => ({
            id, kind: 'choose-cards', playerId: ownerId,
            prompt: '【兴作】：观看并选择牌堆底任意张牌，再用等量手牌替换；选择0张不触发结束阶段交换',
            timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: bottomIds, hiddenCardSlots: [], min: 0, max,
          }),
        })
        return
      }
      if (payload.phase === 'finish' && state.ruanyuExchangeCount?.[ownerId]?.turnNumber === host.state.turnNumber) {
        askRuanYuExchange(host, ownerId)
      }
    },
  }],
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { bottomIds?: CardId[]; turnNumber?: number }
    if (resolution.step === 'replace-bottom') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const bottomIds = data.bottomIds ?? []
      if (!selected.length || selected.length > bottomIds.length || selected.some((id) => !bottomIds.includes(id))) return
      const owner = playerOf(host.state, ownerId)
      if (!owner || owner.zones.hand.length < selected.length) return
      host.askSkill({
        skillId: XINGZUO, ownerId, step: 'replace-hand', data: { bottomIds: selected },
        build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: `【兴作】：选择${selected.length}张手牌放到对应牌堆底位置`,
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: selected.length, max: selected.length,
        }),
      })
      return
    }
    if (resolution.step === 'replace-hand') {
      const bottomIds = (resolution.data as { bottomIds?: CardId[] }).bottomIds ?? []
      const handIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      ruanyuReplaceBottom(host, ownerId, bottomIds, handIds)
      return
    }
    if (resolution.step !== 'exchange-target') return
    const state = host.state as RuanYuState
    const entry = state.ruanyuExchangeCount?.[ownerId]
    if (!entry || entry.turnNumber !== data.turnNumber || entry.turnNumber !== host.state.turnNumber) return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    entry.count -= 1
    if (targetId) {
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      const bottomIds = [...host.state.zones.drawPile.slice(-3)]
      const originalHand = [...(target?.zones.hand ?? [])]
      if (owner?.alive && target?.alive && originalHand.length > 0 && bottomIds.length > 0) {
        for (const cardId of bottomIds) {
          moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
          host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: '兴作' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        }
        for (const cardId of originalHand) {
          moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'drawPile' })
          host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '兴作' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        }
        if (originalHand.length > 3) loseHp(host as never, ownerId, 1, '兴作')
      }
    }
    if (entry.count > 0 && playerOf(host.state, ownerId)?.alive) askRuanYuExchange(host, ownerId)
    else delete state.ruanyuExchangeCount?.[ownerId]
  },
})

function uniqueRuanYuColorCard(state: SanguoshaState, ownerId: PlayerId, color: 'red' | 'black'): CardId | null {
  const hand = playerOf(state, ownerId)?.zones.hand ?? []
  const matches = hand.filter((cardId) => effectiveCardColor(state, ownerId, cardId) === color)
  return matches.length === 1 ? matches[0]! : null
}

registerSkillRuntime({
  id: MIAOXIAN,
  viewAs(state, ownerId) {
    const cardId = uniqueRuanYuColorCard(state, ownerId, 'black')
    if (!cardId || usedThisTurn(state, ownerId, MIAOXIAN)) return []
    return [...INSTANT_TRICKS].filter((cardName) => !DELAYED_TRICKS.has(cardName)).map((cardName) => ({
      asCardName: cardName, cardId, label: `【妙弦】：将黑色手牌当【${cardName}】使用`,
    }))
  },
  interceptPlayAction(host, ownerId, action) {
    if (action.kind !== 'use-card' || action.playerId !== ownerId || action.cardIds.length !== 1) return false
    const cardId = action.cardIds[0]!
    const owner = playerOf(host.state, ownerId)
    if (!owner?.zones.hand.includes(cardId) || effectiveCardColor(host.state, ownerId, cardId) !== 'red') return false
    const soleRed = uniqueRuanYuColorCard(host.state, ownerId, 'red')
    if (soleRed !== cardId) return false
    const state = host.state as RuanYuState
    state.ruanyuRedUsePending ??= {}
    state.ruanyuRedUsePending[cardId] = {
      ownerId, turnNumber: host.state.turnNumber, remainingHandIds: owner.zones.hand.filter((id) => id !== cardId),
    }
    return false
  },
  triggers: [{
    event: 'CardUsed',
    priority: 100,
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId }
      if (!payload.cardId) return
      const state = host.state as RuanYuState
      if (context.event.sourceSkillId === MIAOXIAN) markUsedThisTurn(host.state, ownerId, MIAOXIAN)
      const pendingRed = state.ruanyuRedUsePending?.[payload.cardId]
      if (!pendingRed || pendingRed.ownerId !== ownerId || pendingRed.turnNumber !== host.state.turnNumber) return
      delete state.ruanyuRedUsePending?.[payload.cardId]
      const owner = playerOf(host.state, ownerId)
      const remaining = new Set(pendingRed.remainingHandIds)
      if (!owner?.alive || owner.zones.hand.length !== remaining.size || owner.zones.hand.some((id) => !remaining.has(id))) return
      if (owner.zones.hand.some((id) => effectiveCardColor(host.state, ownerId, id) === 'red')) return
      drawCards(host.state, host.rng, ownerId, 1, (name, eventPayload) => { host.dispatch(name, eventPayload) })
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId) {
      const pending = (host.state as RuanYuState).ruanyuRedUsePending
      if (!pending) return
      for (const [cardId, entry] of Object.entries(pending)) if (entry.ownerId === ownerId) delete pending[cardId as CardId]
    },
  }],
})

function tangTangEligibleTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const entry = (state as TangTangState).tangTangTargetsThisTurn?.[ownerId]
  const used = entry?.turnNumber === state.turnNumber ? entry.targetIds : []
  return state.players.filter((p) => p.alive && p.id !== ownerId && !used.includes(p.id)).map((p) => p.id)
}

function askTangTangTarget(host: SkillHost, ownerId: PlayerId, shownCardId: CardId): void {
  const candidateIds = tangTangEligibleTargets(host.state, ownerId)
  if (!candidateIds.length) return
  host.askSkill({ skillId: ZEXING, ownerId, step: 'choose-target', data: { shownCardId }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【择行】：选择一名本回合尚未选择过的其他角色',
    timeoutMs: 25_000, optional: true, candidateIds, min: 0, max: 1,
  }) })
}

registerSkillRuntime({
  id: ZEXING,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.status === 'playing' && state.phase === 'play' && state.currentPlayerId === ownerId
      && !usedThisPhase(state, ownerId, ZEXING) && Boolean(owner?.alive && owner.zones.hand.length)
      && tangTangEligibleTargets(state, ownerId).length > 0
      ? [{ id: ZEXING, label: '择行：展示一张牌并选择角色' }] : []
  },
  invokeActive(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.zones.hand.length || !tangTangEligibleTargets(host.state, ownerId).length) return
    host.askSkill({ skillId: ZEXING, ownerId, step: 'show-card', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【择行】：选择一张手牌展示', timeoutMs: 25_000,
      optional: true, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { shownCardId?: CardId; targetId?: PlayerId; optionId?: string }
    if (resolution.step === 'show-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = playerOf(host.state, ownerId)
      if (!cardId || !owner?.zones.hand.includes(cardId)) return
      markUsedThisPhase(host.state, ownerId, ZEXING)
      host.dispatch('CardMove', { playerId: ownerId, cardIds: [cardId], reason: ZEXING, revealed: true, keepOwner: true }, { sourceId: ownerId, cardIds: [cardId] })
      askTangTangTarget(host, ownerId, cardId)
      return
    }
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const shownCardId = data.shownCardId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!shownCardId || !playerOf(host.state, ownerId)?.zones.hand.includes(shownCardId) || !target?.alive
        || !tangTangEligibleTargets(host.state, ownerId).includes(targetId!)) return
      const state = host.state as TangTangState
      const entry = state.tangTangTargetsThisTurn?.[ownerId]
      state.tangTangTargetsThisTurn ??= {}
      state.tangTangTargetsThisTurn[ownerId] = {
        turnNumber: host.state.turnNumber,
        targetIds: [...(entry?.turnNumber === host.state.turnNumber ? entry.targetIds : []), targetId!],
      }
      state.tangTangShownCard ??= {}
      state.tangTangShownCard[ownerId] = shownCardId
      const shownSuit = effectiveCardSuit(host.state, ownerId, shownCardId)
      const eligible = target.zones.hand.filter((id) => effectiveCardSuit(host.state, targetId!, id) !== shownSuit)
      host.askSkill({ skillId: ZEXING, ownerId, step: 'target-choice', data: { shownCardId, targetId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: targetId!, prompt: '【择行】：选择一项', timeoutMs: 25_000, optional: false,
        options: [
          ...(eligible.length >= 2 ? [{ id: 'take', label: '令其观看并获得你两张与展示牌花色不同的手牌，然后你获得展示牌' }] : []),
          { id: 'lose-hp', label: '失去1点体力；然后其可继续选择一名未选择过的角色' },
        ],
      }) })
      return
    }
    if (resolution.step === 'target-choice') {
      const targetId = data.targetId
      const shownCardId = data.shownCardId
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!targetId || !shownCardId || !playerOf(host.state, targetId)?.alive) return
      if (optionId === 'take') {
        const target = playerOf(host.state, targetId)!
        const suit = effectiveCardSuit(host.state, ownerId, shownCardId)
        const eligible = target.zones.hand.filter((id) => effectiveCardSuit(host.state, targetId, id) !== suit)
        if (eligible.length < 2) return
        host.askSkill({ skillId: ZEXING, ownerId, step: 'take-cards', data: { shownCardId, targetId }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: `【择行】：观看并选择${target.nickname}两张与展示牌花色不同的手牌`,
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: eligible, hiddenCardSlots: [], min: 2, max: 2,
        }) })
        return
      }
      if (optionId !== 'lose-hp') return
      loseHp(host as never, targetId, 1, '择行')
      if (playerOf(host.state, ownerId)?.alive && tangTangEligibleTargets(host.state, ownerId).length) askTangTangTarget(host, ownerId, shownCardId)
      return
    }
    if (resolution.step !== 'take-cards') return
    const targetId = data.targetId
    const shownCardId = data.shownCardId
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const owner = playerOf(host.state, ownerId)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!target?.alive || !owner?.alive || !shownCardId || !owner.zones.hand.includes(shownCardId) || selected.length !== 2
      || new Set(selected).size !== 2 || selected.some((id) => !target.zones.hand.includes(id))) return
    const suit = effectiveCardSuit(host.state, ownerId, shownCardId)
    if (selected.some((id) => effectiveCardSuit(host.state, targetId!, id) === suit)) return
    giveCards(host as never, targetId!, ownerId, selected, '择行')
    giveCards(host as never, ownerId, targetId!, [shownCardId], '择行')
  },
})

registerSkillRuntime({
  id: ZHIYI,
  triggers: [
  { event: 'GainCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    const gainedByOwner = payload.playerId === ownerId
    if (!gainedByOwner || usedThisTurn(host.state, ownerId, ZHIYI)) return
    const moved = new Set(payload.cardIds ?? [])
    const colors = [...new Set((payload.cardIds ?? []).map((id) => effectiveCardColor(host.state, ownerId, id)).filter((c): c is 'red' | 'black' => c !== null))]
    const hand = playerOf(host.state, ownerId)?.zones.hand ?? []
    const color = colors.find((candidate) => hand.some((id) => !moved.has(id) && effectiveCardColor(host.state, ownerId, id) === candidate))
    if (!color) return
    host.askSkill({ skillId: ZHIYI, ownerId, step: 'draw-target', data: { color }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【知意】：是否令一名角色摸一张牌？', timeoutMs: 25_000,
      optional: true, candidateIds: host.state.players.filter((p) => p.alive).map((p) => p.id), min: 0, max: 1,
    }) })
  } },
  { event: 'HandCardLeft', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; destination?: { kind?: string; playerId?: PlayerId } | null }
    if (payload.playerId !== ownerId || payload.destination?.kind !== 'hand' || payload.destination.playerId === ownerId
      || usedThisTurn(host.state, ownerId, ZHIYI)) return
    const cardId = payload.cardId
    const moved = new Set(cardId ? [cardId] : [])
    const color = cardId ? effectiveCardColor(host.state, ownerId, cardId) : null
    if (!color || !playerOf(host.state, ownerId)?.zones.hand.some((id) => !moved.has(id) && effectiveCardColor(host.state, ownerId, id) === color)) return
    host.askSkill({ skillId: ZHIYI, ownerId, step: 'draw-target', data: { color }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【知意】：是否令一名角色摸一张牌？', timeoutMs: 25_000,
      optional: true, candidateIds: host.state.players.filter((p) => p.alive).map((p) => p.id), min: 0, max: 1,
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'draw-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    markUsedThisTurn(host.state, ownerId, ZHIYI)
    drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: HEXU,
  maxCardsBonus(state, ownerId) {
    const categories = new Set<string>()
    for (const cardId of playerOf(state, ownerId)?.zones.hand ?? []) {
      const card = state.cards[cardId]
      if (!card) continue
      if (card.category === 'trick' && DAMAGE_TRICKS.has(effectiveCardName(state, cardId))) continue
      categories.add(card.category)
    }
    return categories.size
  },
})

registerSkillRuntime({
  id: ZEGUANG,
  interceptTarget(host, ownerId, context) {
    if (context.targetId !== ownerId || usedThisTurn(host.state, ownerId, ZEGUANG)) return false
    if (context.cardName !== '杀' && !DAMAGE_TRICKS.has(context.cardName)) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return false
    host.askSkill({ skillId: ZEGUANG, ownerId, step: 'invoke', data: { cardId: context.cardId, sourceId: context.sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【泽光】：是否重铸三张牌（不足则全部重铸）？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '重铸手牌' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { cardId?: CardId; sourceId?: PlayerId; recastIds?: CardId[]; count?: number }
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !owner.zones.hand.length || !data.cardId) { host.resumeCardTarget(); return }
      const count = Math.min(3, owner.zones.hand.length)
      host.askSkill({ skillId: ZEGUANG, ownerId, step: 'recast', data: { ...data, count }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【泽光】：选择${count}张手牌重铸`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (resolution.step === 'recast') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      const expected = data.count ?? 0
      if (!owner?.alive || cardIds.length !== expected || new Set(cardIds).size !== cardIds.length
        || cardIds.some((id) => !owner.zones.hand.includes(id))) { host.resumeCardTarget(); return }
      markUsedThisTurn(host.state, ownerId, ZEGUANG)
      const state = host.state as DongYuanState
      state.dongYuanRecast ??= {}
      state.dongYuanRecast[data.cardId!] = { ownerId, targetId: ownerId, cardIds: [...cardIds] }
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: 'recast' }, { sourceId: ownerId, cardIds })
      drawCards(host.state, host.rng, ownerId, cardIds.length, (name, payload) => { host.dispatch(name, payload) })
      host.resumeCardTarget()
      return
    }
    if (resolution.step !== 'gain-target' || !data.cardId) return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const entry = (host.state as DongYuanState).dongYuanRecast?.[data.cardId]
    if (!entry || entry.ownerId !== ownerId) return
    if (!targetId || !playerOf(host.state, targetId)?.alive) { delete (host.state as DongYuanState).dongYuanRecast?.[data.cardId]; return }
    const available = entry.cardIds.filter((cardId) => host.state.zones.discardPile.includes(cardId))
    for (const cardId of available) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
    if (available.length) host.dispatch('GainCard', { playerId: targetId, cardIds: available, reason: '泽光' }, { sourceId: ownerId, targetId, cardIds: available })
    delete (host.state as DongYuanState).dongYuanRecast?.[data.cardId]
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!cardId) return
    const entry = (host.state as DongYuanState).dongYuanRecast?.[cardId]
    if (!entry || entry.ownerId !== ownerId) return
    if (cardDamageDealt(host.state, cardId) <= 0) { delete (host.state as DongYuanState).dongYuanRecast?.[cardId]; return }
    const candidateIds = host.state.players.filter((p) => p.alive).map((p) => p.id)
    host.askSkill({ skillId: ZEGUANG, ownerId, step: 'gain-target', data: { cardId }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【泽光】：选择一名角色获得此次重铸且仍在弃牌堆中的牌',
      timeoutMs: 25_000, optional: true, candidateIds, min: 0, max: 1,
    }) })
  } }],
})

registerPindianContinuation(CHENGEN, (pindianHost, result: PindianResult) => {
  const host = pindianHost as SkillHost
  const ownerId = result.initiatorId
  const opponentId = result.opponentId
  if (result.outcome === 'initiator-win') {
    const cardId = result.initiatorCardId
    if (!host.state.zones.processingArea.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    finishPindianSettlement(host as never)
    const state = host.state as DongYuanState
    state.dongYuanFreeDistanceCards ??= {}
    state.dongYuanFreeDistanceCards[ownerId] = cardId
    const actions = declaredCardActions(host.state, ownerId, cardId, effectiveCardName(host.state, cardId), '【承恩】：无距离限制使用拼点牌', { sourceSkillId: CHENGEN })
      .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
    if (!actions.length) {
      delete state.dongYuanFreeDistanceCards[ownerId]
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      return
    }
    host.askSkill({ skillId: CHENGEN, ownerId, step: 'use-card', data: { cardId, actionIds: actions.map((action) => action.id) }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【承恩】：是否无距离限制使用此次拼点牌？', timeoutMs: 25_000,
      optional: true, options: [...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'decline', label: '不使用' }],
    }) })
    return
  }
  const opponent = playerOf(host.state, opponentId)
  if (!opponent?.alive || !playerOf(host.state, ownerId)?.alive) return
  const actions: Array<Extract<LegalAction, { kind: 'use-card' }>> = []
  for (const cardId of opponent.zones.hand) {
    const variants = [
      ...(effectiveCardName(host.state, cardId) === '杀' ? [{ label: '使用手牌【杀】', sourceSkillId: undefined as string | undefined }] : []),
      ...skillsOf(host.state, opponentId, characterSkillIdsOf).flatMap((runtime) => (runtime.viewAs?.(host.state, opponentId) ?? [])
        .filter((option) => option.cardId === cardId && option.asCardName === '杀')
        .map((option) => ({ label: option.label, sourceSkillId: runtime.id }))),
    ]
    for (const variant of variants) actions.push(...declaredCardActions(host.state, opponentId, cardId, '杀', variant.label, { sourceSkillId: variant.sourceSkillId })
      .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card'
        && action.targetIds.length === 1 && action.targetIds[0] === ownerId))
  }
  const unique = [...new Map(actions.map((action) => [action.id, action])).values()]
  if (!unique.length) return
  host.askSkill({ skillId: CHENGEN, ownerId, step: 'counter-slash', data: { opponentId, actionIds: unique.map((action) => action.id) }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: opponentId, prompt: '【承恩】：可对董予安使用一张【杀】', timeoutMs: 25_000,
    optional: true, options: [...unique.map((action) => ({ id: action.id, label: action.label })), { id: 'decline', label: '不使用' }],
  }) })
})

registerSkillRuntime({
  id: CHENGEN,
  slashIgnoresDistance(state, ownerId, cardId) {
    return Boolean(cardId && (state as DongYuanState).dongYuanFreeDistanceCards?.[ownerId] === cardId)
  },
  ignoresTrickDistance(state, ownerId) {
    return Boolean((state as DongYuanState).dongYuanFreeDistanceCards?.[ownerId])
  },
  triggers: [
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const state = host.state as DongYuanState
    if (cardId && state.dongYuanFreeDistanceCards?.[ownerId] === cardId) delete state.dongYuanFreeDistanceCards[ownerId]
  } },
  { event: 'TurnEnd', handle(host, ownerId, context) {
    if (host.state.pindian || host.state.pindianSettlement) return
    const currentId = (context.event.payload as { playerId?: PlayerId }).playerId
    const current = currentId ? playerOf(host.state, currentId) : undefined
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !current?.alive || current.zones.hand.length > owner.zones.hand.length) return
    const candidateIds = host.state.players.filter((p) => p.alive && p.id !== ownerId && p.zones.hand.length > 0).map((p) => p.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: CHENGEN, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【承恩】：选择一名有手牌的其他角色拼点', timeoutMs: 25_000,
      optional: true, candidateIds, min: 0, max: 1,
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { targetIds?: PlayerId[]; optionId?: string }
    if (resolution.step === 'target') {
      const opponentId = payload.targetIds?.[0]
      if (opponentId && canPindian(host.state, ownerId) && canPindian(host.state, opponentId))
        startPindian(host as never, { id: `chengen:${ownerId}:${opponentId}:${host.state.turnNumber}`, initiatorId: ownerId, opponentId, reason: CHENGEN, continuationTag: CHENGEN, data: {} })
      return
    }
    const data = resolution.data as { cardId?: CardId; opponentId?: PlayerId; actionIds?: string[] }
    if (resolution.step === 'use-card') {
      const state = host.state as DongYuanState
      if (!data.cardId) return
      if (!payload.optionId || payload.optionId === 'decline') {
        delete state.dongYuanFreeDistanceCards?.[ownerId]
        if (playerOf(host.state, ownerId)?.zones.hand.includes(data.cardId)) {
          moveCard(host.state, data.cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: ownerId, cardIds: [data.cardId], reason: 'pindian' }, { sourceId: ownerId, cardIds: [data.cardId] })
        }
        return
      }
      const actions = declaredCardActions(host.state, ownerId, data.cardId, effectiveCardName(host.state, data.cardId), '【承恩】：无距离限制使用拼点牌', { sourceSkillId: CHENGEN })
      const action = actions.find((candidate) => candidate.kind === 'use-card' && candidate.id === payload.optionId && data.actionIds?.includes(candidate.id))
      if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
      else {
        delete state.dongYuanFreeDistanceCards?.[ownerId]
        if (playerOf(host.state, ownerId)?.zones.hand.includes(data.cardId)) {
          moveCard(host.state, data.cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: ownerId, cardIds: [data.cardId], reason: 'pindian' }, { sourceId: ownerId, cardIds: [data.cardId] })
        }
      }
      return
    }
    if (resolution.step === 'counter-slash') {
      const opponentId = data.opponentId
      const actionId = payload.optionId
      if (!opponentId || !actionId || actionId === 'decline' || !data.actionIds?.includes(actionId)) return
      const opponent = playerOf(host.state, opponentId)
      if (!opponent?.alive || !playerOf(host.state, ownerId)?.alive) return
      for (const cardId of opponent.zones.hand) {
        const variants = [
          ...(effectiveCardName(host.state, cardId) === '杀' ? [{ label: '使用手牌【杀】', sourceSkillId: undefined as string | undefined }] : []),
          ...skillsOf(host.state, opponentId, characterSkillIdsOf).flatMap((runtime) => (runtime.viewAs?.(host.state, opponentId) ?? [])
            .filter((option) => option.cardId === cardId && option.asCardName === '杀').map((option) => ({ label: option.label, sourceSkillId: runtime.id }))),
        ]
        for (const variant of variants) {
          const action = declaredCardActions(host.state, opponentId, cardId, '杀', variant.label, { sourceSkillId: variant.sourceSkillId })
            .find((candidate) => candidate.kind === 'use-card' && candidate.id === actionId && candidate.targetIds.length === 1 && candidate.targetIds[0] === ownerId)
          if (action?.kind === 'use-card') { executeUseCardAction(host as never, opponentId, action); return }
        }
      }
    }
  },
})


registerSkillRuntime({
  id: BAZHAN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const yin = conversionStateOf(state, ownerId, BAZHAN) === 'yin'
    return state.status === 'playing' && state.phase === 'play' && state.currentPlayerId === ownerId
      && !usedThisPhase(state, ownerId, BAZHAN) && Boolean(owner?.alive)
      && state.players.some((p) => p.alive && p.id !== ownerId && (yin ? p.zones.hand.length > 0 : owner!.zones.hand.length > 0))
      ? [{ id: BAZHAN, label: `把盏（${yin ? '阴：获得手牌' : '阳：交给手牌'}）` }] : []
  },
  invokeActive(host, ownerId) {
    const yin = conversionStateOf(host.state, ownerId, BAZHAN) === 'yin'
    const owner = playerOf(host.state, ownerId)
    const candidateIds = host.state.players.filter((p) => p.alive && p.id !== ownerId && (!yin || p.zones.hand.length > 0)).map((p) => p.id)
    if (!owner?.alive || !candidateIds.length) return
    host.askSkill({ skillId: BAZHAN, ownerId, step: 'select-target', data: { mode: yin ? 'yin' : 'yang' }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: `【把盏】（${yin ? '阴' : '阳'}）：选择一名其他角色`,
      timeoutMs: 25_000, optional: true, candidateIds, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { mode?: 'yang' | 'yin'; targetId?: PlayerId; cardIds?: CardId[]; recipientId?: PlayerId }
    if (resolution.step === 'benefit') {
      const option = (response.payload as { optionId?: string }).optionId
      if (!data.recipientId || !playerOf(host.state, data.recipientId)?.alive) return
      if (option === 'recover') recover(host as never, data.recipientId, 1, ownerId)
      else if (option === 'restore') restoreCharacter(host as never, data.recipientId, BAZHAN)
      return
    }
    if (resolution.step === 'select-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      const mode = data.mode
      if (!target?.alive || !owner?.alive || !mode || targetId === ownerId) return
      const cardIds = mode === 'yang' ? owner.zones.hand : target.zones.hand
      const max = Math.min(2, cardIds.length)
      if (!max) return
      host.askSkill({ skillId: BAZHAN, ownerId, step: 'select-cards', data: { mode, targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【把盏】（${mode === 'yang' ? '阳：交给' : '阴：获得'}${target.nickname}）：选择至多两张手牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...cardIds], hiddenCardSlots: [], min: 0, max,
      }) })
      return
    }
    if (resolution.step !== 'select-cards') return
    const { mode, targetId } = data
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const giverId = mode === 'yang' ? ownerId : targetId
    const recipientId = mode === 'yang' ? targetId : ownerId
    const giver = giverId ? playerOf(host.state, giverId) : undefined
    if (!owner?.alive || !target?.alive || !giver || !recipientId || !selected.length || selected.length > 2
      || new Set(selected).size !== selected.length || selected.some((cardId) => !giver.zones.hand.includes(cardId))) return
    if (selected.length === 0) {
      markUsedThisPhase(host.state, ownerId, BAZHAN)
      toggleConversionState(host.state, ownerId, BAZHAN)
      return
    }
    const received = giveCards(host as never, giverId!, recipientId, selected, BAZHAN)
    if (!received.length) return
    markUsedThisPhase(host.state, ownerId, BAZHAN)
    toggleConversionState(host.state, ownerId, BAZHAN)
      const eligible = received.some((cardId) => effectiveCardName(host.state, cardId) === '酒' || effectiveCardSuit(host.state, recipientId, cardId) === 'heart')
    if (!eligible) return
    host.askSkill({ skillId: BAZHAN, ownerId, step: 'benefit', data: { recipientId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【把盏】：令获得牌的角色回复1点体力或复原武将牌', timeoutMs: 25_000,
      optional: true, options: [{ id: 'recover', label: '回复1点体力' }, { id: 'restore', label: '复原武将牌' }, { id: 'decline', label: '不发动' }],
    }) })
  },
})

registerSkillRuntime({
  id: JIAOYING,
  triggers: [
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const movement = context.event.payload as { playerId?: PlayerId; cardId?: CardId; destination?: { kind?: string; playerId?: PlayerId } | null }
      if (movement.playerId !== ownerId || movement.destination?.kind !== 'hand' || movement.destination.playerId === ownerId || !movement.cardId) return
      const targetId = movement.destination.playerId
      if (!targetId) return
      const color = host.state.cards[movement.cardId]?.color
      if (color) lockCardColor(host.state, { targetId, color, sourceId: ownerId, skillId: `${JIAOYING}:${color}` })
      const state = host.state as FanYuFengState
      state.fanYuFengQuietTurns ??= {}
      state.fanYuFengQuietTurns[targetId] = { turnNumber: host.state.turnNumber, usedCardAfterGain: false }
    } },
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const sourceId = context.event.sourceId
      if (!sourceId) return
      const entry = (host.state as FanYuFengState).fanYuFengQuietTurns?.[sourceId]
      if (entry?.turnNumber === host.state.turnNumber) entry.usedCardAfterGain = true
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId) return
      const state = host.state as FanYuFengState
      const entry = state.fanYuFengQuietTurns?.[targetId]
      if (!entry || entry.turnNumber !== host.state.turnNumber) return
      delete state.fanYuFengQuietTurns?.[targetId]
      if (entry.usedCardAfterGain || !playerOf(host.state, ownerId)?.alive) return
      host.askSkill({ skillId: JIAOYING, ownerId, step: 'draw-target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【醮影】：选择一名角色，将其手牌摸至五张',
        timeoutMs: 25_000, optional: true, candidateIds: host.state.players.filter((p) => p.alive).map((p) => p.id), min: 0, max: 1,
      }) })
    } },
  ],
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'draw-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (target?.alive && target.zones.hand.length < 5) drawCards(host.state, host.rng, target.id, 5 - target.zones.hand.length, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: XIJUE,
  onGameStart(_host, ownerId) {
    const owner = _host.state.players.find((player) => player.id === ownerId)
    if (owner) owner.marks[JUE_MARK] = 4
  },
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const state = host.state as XijueState
        (state.xijueTurnDamage ??= {})[ownerId] = { turnNumber: state.turnNumber, amount: 0 }
      },
    },
    {
      event: 'DamageSettled',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const finalAmount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
        if (finalAmount <= 0) return
        const state = host.state as XijueState
        const ledger = state.xijueTurnDamage ??= {}
        const current = ledger[ownerId]
        if (!current || current.turnNumber !== state.turnNumber) {
          ledger[ownerId] = { turnNumber: state.turnNumber, amount: Math.trunc(finalAmount) }
          return
        }
        current.amount += Math.trunc(finalAmount)
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return

        if (payload.phase === 'finish' && payload.playerId === ownerId) {
          const state = host.state as XijueState
          const damage = state.xijueTurnDamage?.[ownerId]
          const earned = damage?.turnNumber === state.turnNumber ? damage.amount : 0
          delete state.xijueTurnDamage?.[ownerId]
          if (earned > 0) owner.marks[JUE_MARK] = markCount(host.state, ownerId) + earned
          return
        }

        if (payload.phase !== 'finish' || !payload.playerId || payload.playerId === ownerId
          || !playerOf(host.state, payload.playerId)?.alive || markCount(host.state, ownerId) < 1
          || basicHandIds(host.state, ownerId).length === 0 || host.state.skillResolution) return
        host.queueSkill({ skillId: XIJUE, ownerId, step: 'xiaoguo-invoke', data: { targetId: payload.playerId } })
      },
    },
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        if (markCount(host.state, ownerId) < 1) return
        const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId && target.zones.hand.length > 0)
        if (!candidates.length || !takeOverDrawPhase(host, ownerId, context)) return
        askOption(host, ownerId, 'tuxi-invoke', '【袭爵】：是否移除一枚“爵”发动【突袭】？选择后放弃摸牌并获得至多两名其他角色的各一张手牌。', {}, [
          { id: 'yes', label: '移除一枚“爵”发动【突袭】' },
          { id: 'no', label: '不发动，正常摸牌' },
        ])
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'xiaoguo-invoke') return
    const targetId = (prompt.data as { targetId: PlayerId }).targetId
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive
      || markCount(host.state, ownerId) < 1 || basicHandIds(host.state, ownerId).length === 0) return
    askOption(host, ownerId, 'xiaoguo-invoke', '【袭爵】：是否移除一枚“爵”并发动【骁果】？', { targetId }, [
      { id: 'yes', label: '移除一枚“爵”并发动' },
      { id: 'no', label: '不发动' },
    ])
  },
  resume(host, ownerId, resolution, response) {
    const selected = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'tuxi-invoke') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (selected !== 'yes') {
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId && target.zones.hand.length > 0)
      if (markCount(host.state, ownerId) < 1 || !candidates.length) {
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      owner.marks[JUE_MARK] = markCount(host.state, ownerId) - 1
      if (owner.marks[JUE_MARK] <= 0) delete owner.marks[JUE_MARK]
      host.askSkill({
        skillId: XIJUE, ownerId, step: 'tuxi-targets',
        build: (id) => ({
          id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【突袭】：选择至多两名有手牌的其他角色各获得其一张手牌', timeoutMs: 25_000,
          optional: false, candidateIds: candidates.map(({ id: targetId }) => targetId), min: 1, max: Math.min(2, candidates.length),
        }),
      })
      return
    }

    if (resolution.step === 'tuxi-targets') {
      const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const taken: CardId[] = []
      for (const targetId of targetIds) {
        const target = playerOf(host.state, targetId)
        if (!target?.alive || target.zones.hand.length === 0) continue
        const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '突袭' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        taken.push(cardId)
      }
      if (taken.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: taken, reason: '突袭' }, { targetId: ownerId, cardIds: taken })
      return
    }

    if (resolution.step === 'xiaoguo-invoke') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const owner = playerOf(host.state, ownerId)
      if (selected !== 'yes' || !owner?.alive || !playerOf(host.state, targetId)?.alive
        || markCount(host.state, ownerId) < 1 || basicHandIds(host.state, ownerId).length === 0) return
      owner.marks[JUE_MARK] = markCount(host.state, ownerId) - 1
      if (owner.marks[JUE_MARK] <= 0) delete owner.marks[JUE_MARK]
      askBasicCost(host, ownerId, targetId)
      return
    }

    if (resolution.step === 'xiaoguo-cost') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const cardId = (response.payload as { cardIds: CardId[] }).cardIds[0]
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || !basicHandIds(host.state, ownerId).includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '骁果' }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: XIJUE, skillName: '袭爵', playerId: ownerId, targetId }, { sourceId: ownerId, targetId })
      const equipment = Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
      if (!equipment.length) {
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
        return
      }
      host.askSkill({
        skillId: XIJUE, ownerId, step: 'xiaoguo-choice', data: { targetId, equipment },
        build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: targetId, prompt: '【骁果】：选择弃置一张装备牌并令张虎乐綝摸一张牌，或受到其造成的1点伤害',
          timeoutMs: 25_000, optional: false, options: [
            { id: 'discard', label: '弃置一张装备牌，张虎乐綝摸一张牌' },
            { id: 'damage', label: '受到张虎乐綝造成的1点伤害' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'xiaoguo-choice') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      if (!target?.alive || !owner?.alive) return
      if (selected === 'discard') {
        askEquipCost(host, ownerId, targetId)
        return
      }
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
      return
    }

    if (resolution.step === 'xiaoguo-equipment') {
      const { targetId, equipment } = resolution.data as { targetId: PlayerId; equipment: Array<{ id: CardId; slot: EquipmentSlot }> }
      const selectedId = (response.payload as { cardIds: CardId[] }).cardIds[0]
      const target = playerOf(host.state, targetId)
      const choice = equipment.find(({ id }) => id === selectedId)
      if (!target?.alive || !choice || target.zones.equipment[choice.slot] !== selectedId) return
      moveCard(host.state, selectedId, { kind: 'equipment', playerId: targetId, slot: choice.slot }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [selectedId], reason: '骁果' }, { sourceId: ownerId, targetId, cardIds: [selectedId] })
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      return
    }
  },
})

export const ZHANG_HU_LECHEN_B63: CharacterDefinition = {
  id: 'zhanghulecheng-b63', name: '张虎乐綝', kingdom: 'jin', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [{
    id: XIJUE, name: '袭爵',
    description: '游戏开始时，你获得4枚“爵”标记；结束阶段，你获得X枚“爵”（X为你本回合造成的伤害数）。摸牌阶段开始时，你可以移除1枚“爵”发动“突袭”；其他角色的结束阶段，你可以移除1枚“爵”发动“骁果”。',
  }],
}

export const XIN_CHANG_B63: CharacterDefinition = {
  id: 'xinchang-b63', name: '辛敞', kingdom: 'jin', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: CANMOU, name: '参谋', description: '当手牌数全场唯一最多的角色使用普通锦囊牌指定目标时，你可以为此锦囊牌多指定一个目标。' },
    { id: CONGJIAN, name: '从鉴', description: '当体力值全场唯一最大的其他角色成为普通锦囊牌的唯一目标时，你可以也成为此牌目标，此牌结算后，若此牌对你造成伤害，你摸两张牌。' },
  ],
}

export const PEI_YUAN_SHAO_B63: CharacterDefinition = {
  id: 'peiyuanshao-b63', name: '裴元绍', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [{ id: FULUE, name: '复掠', description: '你使用【杀】或伤害锦囊牌仅指定唯一目标后，你可选择本回合未执行过的一项：此牌造成伤害+1；获得目标角色一张牌。然后若此牌结算完成后，未造成伤害，其可对你使用一张【杀】，并执行“复掠”的另一项。' }],
}

export const DUAN_WEI_B63: CharacterDefinition = {
  id: 'duanwei-b63', name: '段煨', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [{ id: TAOHUAI, name: '讨怀', description: '转换技，你使用手牌中点数最大的牌（阳）或点数最小的牌（阴）时，摸一张牌；否则你可弃置一张牌。' }],
}

export const QIAO_GUO_LAO_B63: CharacterDefinition = {
  id: 'qiaoguolao-b63', name: '乔国老', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: MEIYAN, name: '媒言', description: '出牌阶段限一次，你可以与所有体力值大于等于你的角色议事，若议事结果为红色，你获得所有红色意见牌；若议事结果为黑色，你与意见为红色的角色各摸一张牌。' },
    { id: ZHUOYU, name: '妁语', description: '每回合限一次，你攻击范围内的角色成为【杀】的目标时，你可以与所有体力值小于等于你的角色议事，若议事结果为红色，弃置所有意见牌，将此【杀】转移给一名未参与议事的角色。' },
    { id: ZUOBAO, name: '作保', description: '限定技，你参与的议事展示意见时，你可以令此次议事中，所有黑桃意见牌视为红桃。' },
  ],
}

export const SUN_YUAN_B63: CharacterDefinition = {
  id: 'sunyuan-b63', name: '孙鸢', kingdom: 'wu', gender: 'female', maxHp: 4, pack: 'sp',
  skills: [
    { id: SAYING, name: '飒影', description: '出牌阶段开始时，你可获得一名其他角色区域内一张牌，然后若你在其攻击范围内，其可对你使用一张【杀】；若你不在其攻击范围内，本轮你与其均视为在对方的攻击范围内。' },
    { id: TONGXIN, name: '恫心', description: '每回合各限一次，当你造成或受到伤害后，你可弃置受伤角色X+1张牌对伤害来源造成一点伤害（X为受伤角色已损失体力值且不足则全弃）。然后你获得其中的【杀】且你使用这些【杀】无次数限制。' },
  ],
}

export const RUAN_YU_B63: CharacterDefinition = {
  id: 'ruanyu-b63', name: '阮瑀', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: XINGZUO, name: '兴作', description: '出牌阶段开始时，你可观看牌堆底的三张牌并用任意张手牌替换其中等量的牌。若如此做，结束阶段，你可令一名有手牌的角色用所有手牌替换牌堆底的三张牌。若其换入牌堆底的牌数大于三张，你失去1点体力。' },
    { id: MIAOXIAN, name: '妙弦', description: '若你手牌中仅有一张黑色牌，你可将此牌当作任意一张普通锦囊牌使用（每回合限一次）；若你的手牌中仅有一张红色牌，你使用此牌时摸一张牌。' },
  ],
}

export const TANG_TANG_B63: CharacterDefinition = {
  id: 'tangtang-b63', name: '唐棠', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: ZEXING, name: '择行', description: '出牌阶段限一次，你可展示一张牌并选择一名其他角色，令其选择一项：你观看其手牌并获得两张与展示牌花色不同的牌，然后其获得展示牌；其失去1点体力，然后你可重新选择一名其他角色并重复此流程（本回合每名角色限一次）。' },
    { id: ZHIYI, name: '知意', description: '每回合限一次，当你获得牌后或其他角色获得你的牌后，若你手牌中有其他此颜色的牌，你可令一名角色摸一张牌。' },
  ],
}

export const DONG_YU_AN_B63: CharacterDefinition = {
  id: 'dongyuan-b63', name: '董予安', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: HEXU, name: '和煦', description: '锁定技，你每有一个类别的非伤害牌，你的手牌上限便+1。' },
    { id: ZEGUANG, name: '泽光', description: '每回合限一次，当你成为伤害牌的目标后，可重铸三张牌（不足则全部重铸）。然后若此牌造成伤害，你可令一名角色获得重铸牌。' },
    { id: CHENGEN, name: '承恩', description: '每回合结束时，若当前回合角色手牌数小于等于你，你可与一名角色拼点。若你赢，可使用拼点牌（无距离限制）；若你没赢，拼点目标可对你使用一张【杀】。' },
  ],
}

export const FAN_YU_FENG_B63: CharacterDefinition = {
  id: 'fanyufeng-b63', name: '樊玉凤', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: BAZHAN, name: '把盏', description: '转换技，出牌阶段限一次，阳：你可以交给一名其他角色至多两张手牌；阴：你可以获得一名其他角色至多两张手牌。然后若这些牌里包括【酒】或红桃你可令获得此牌的角色回复1点体力或复原武将牌。' },
    { id: JIAOYING, name: '醮影', description: '锁定技，其他角色获得你的手牌后，该角色本回合不能使用或打出与此牌颜色相同的牌。然后此回合结束时，若其本回合没有再使用牌，你令一名角色将手牌摸至五张。' },
  ],
}

export const HISTORICAL_BATCH63_CHARACTERS: readonly CharacterDefinition[] = [
  ZHANG_HU_LECHEN_B63, XIN_CHANG_B63, PEI_YUAN_SHAO_B63, QIAO_GUO_LAO_B63, SUN_YUAN_B63,
  RUAN_YU_B63, TANG_TANG_B63, DONG_YU_AN_B63, DUAN_WEI_B63, FAN_YU_FENG_B63,
]
