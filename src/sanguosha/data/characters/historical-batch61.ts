import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseSuitRequest, ChooseTargetsRequest, DistributeCardsRequest, RespondCardRequest } from '../../engine/requests'
import { registerGroupCardDecision, startGroupCardDecision } from '../../engine/group-card-decision'
import { drawCards } from '../../engine/draw'
import { getAttackRange } from '../../engine/distance'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { moveCard } from '../../engine/zones'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { hiddenHandSlot } from '../../engine/cards/host'
import { effectiveCardColor, effectiveCardSuit, isCardProtectedFromDiscard, isCardResponseProhibited, isResponseCardProhibited, isCardUseProhibited, registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { gainMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { getDistance } from '../../engine/distance'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { cardUseTargetsOf } from '../../engine/card-use-targets'
import { cancelCardTargetForOwner } from '../../engine/target-cancellation'
import { giveCards } from '../../engine/hand-transfer'
import { resolveDamage } from '../../engine/damage'
import { markUsedThisPhase as markPhaseUsage, usedThisPhase as phaseUsageUsed } from '../../engine/phase-usage'
import { markUsedThisTurn as markTurnUsage, usedThisTurn as turnUsageUsed } from '../../engine/turn-usage'
import { suppressSkill } from '../../engine/skill-suppression'
import { swapHands } from '../../engine/hand-transfer'
import { declaredCardActions } from '../../engine/cards/basic'
import { completeVirtualBasicResponse, resumeCardResponseAsPass } from '../../engine/cards/basic'
import { completeVirtualTrickBasicResponse } from '../../engine/cards/tricks'
import type { CharacterDefinition } from './types'

const b61 = (id: string) => `${id}:b61`
const RUIJIE_QIAOLI = b61('qiaoli-ruijie')
const RUIJIE_QINGLIANG = b61('qingliang-ruijie')
const MENGHUO_MANWANG = b61('manwang-sp-menghuo')
const MENGHUO_PANQIN = b61('panqin-sp-menghuo')
const GUOHUAI_ZHEFU = b61('zhefu-guohuai')
const GUOHUAI_YIDU = b61('yidu-guohuai')
const DENGZHONG_KANPO = b61('kanpo-dengzhong')
const DENGZHONG_GENGZHAN = b61('gengzhan-dengzhong')
const SUNHONG_XIANBI = b61('xianbi-sunhong')
const WANGGUAN_MIAOYAN = b61('miaoyan-wangguan')
const WANGGUAN_SHILU = b61('shilu-wangguan')
const ZHANGZHI_BIXIN = b61('bixin-zhangzhi')
const ZHANGZHI_XIMO = b61('ximo-zhangzhi')
const ZHANGZHI_FEIBAI = b61('feibai-zhangzhi')
const AHUINAN_JUEMAN = b61('jueman-ahuinan')
const QUHUANG_QIEJIAN = b61('qiejian-quhuang')
const QUHUANG_NISHOU = b61('nishou-quhuang')
const SUNHONG_ZANRUN = b61('zanrun-sunhong')
const HAOPU_ZHENYING = b61('zhenying-haopu')
const HAOPU_GROUP_TAG = `${HAOPU_ZHENYING}:simultaneous`

type Batch61State = SanguoshaState & {
  b61RuijieDuel?: Record<CardId, { mode: 'weapon' | 'other-equipment'; sourceId: PlayerId; targetIds: PlayerId[] }>
  b61MenghuoSteps?: Record<PlayerId, number>
  b61MenghuoDiscarded?: Record<PlayerId, Array<{ cardId: CardId; turnNumber: number; phase: string; seq: number }>>
  b61DengzhongSlashBonus?: Record<PlayerId, number>
  b61GuohuaiDamagedTargets?: Record<CardId, PlayerId[]>
  b61WangguanShown?: Array<{ turnNumber: number; phase: string; cardId: CardId; ownerId: PlayerId }>
  b61WangguanUses?: Record<CardId, { side: 'yang' | 'yin'; roundNumber: number }>
  b61WangguanDisabledRound?: Record<PlayerId, number>
  b61ZhangzhiBixinActivations?: Record<PlayerId, number>
  b61ZhangzhiBixinDescription?: Record<PlayerId, string>
  b61ZhangzhiBixinUsed?: Record<PlayerId, { roundNumber: number; types: string[]; basicNames: string[] }>
  b61ZhangzhiBixinCards?: Record<CardId, string>
  b61ZhangzhiBixinTypeUses?: Record<PlayerId, { roundNumber: number; counts: Record<string, number> }>
  b61AhuinanTurn?: Record<PlayerId, number>
  b61QuhuangEmpty?: Record<PlayerId, boolean>
  b61QuhuangDisabled?: Record<PlayerId, Record<PlayerId, number>>
  b61QuhuangPendingSwap?: Record<PlayerId, Array<{ turnNumber: number; phase: string }>>
  b61SunhongForbiddenTargets?: Record<PlayerId, PlayerId[]>
}

registerGroupCardDecision(HAOPU_GROUP_TAG, (rawHost, decision) => {
  const host = rawHost as SkillHost
  const data = decision.data as { ownerId: PlayerId; targetId: PlayerId }
  const participants = [data.ownerId, data.targetId]
  for (const playerId of participants) {
    const player = playerOf(host.state, playerId)
    if (!player) continue
    const selected = decision.responses[playerId] ?? []
    const discarded = [...new Set(selected)].filter((cardId) => player.zones.hand.includes(cardId))
    for (const cardId of discarded) moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
    if (discarded.length) host.dispatch('LoseCard', { playerId, cardIds: discarded, reason: HAOPU_ZHENYING }, { sourceId: playerId, targetId: playerId, cardIds: discarded })
  }
  const left = playerOf(host.state, data.ownerId)
  const right = playerOf(host.state, data.targetId)
  if (!left?.alive || !right?.alive) return
  // 技能仅授权“手牌数较少者”使用；相同数量时没有满足条件的角色，不额外询问指定使用者。
  if (left.zones.hand.length === right.zones.hand.length) return
  const sourceId = left.zones.hand.length < right.zones.hand.length ? left.id : right.id
  const targetId = sourceId === left.id ? right.id : left.id
  host.beginVirtualTrick({ sourceId, targetId, cardName: '决斗', sourceSkillId: HAOPU_ZHENYING })
})

function handCountFor(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.zones.hand.length ?? 0
}

const BIXIN_BASIC_NAMES = ['杀', '闪', '桃', '酒'] as const
const ZHANGZHI_BIXIN_INITIAL_DESCRIPTION = '每名角色的准备阶段和结束阶段，你可以声明一种牌的类型并摸3张牌（每种类型限1次），将所有此类型手牌当你本轮未使用过的基本牌使用。'

function zhangzhiUseState(state: SanguoshaState, ownerId: PlayerId) {
  const all = (state as Batch61State).b61ZhangzhiBixinUsed ??= {}
  const existing = all[ownerId]
  if (!existing || existing.roundNumber !== state.roundNumber) {
    all[ownerId] = { roundNumber: state.roundNumber, types: [], basicNames: [] }
  }
  return all[ownerId]!
}

function zhangzhiTypeUses(state: SanguoshaState, ownerId: PlayerId) {
  const all = (state as Batch61State).b61ZhangzhiBixinTypeUses ??= {}
  const existing = all[ownerId]
  if (!existing || existing.roundNumber !== state.roundNumber) {
    all[ownerId] = { roundNumber: state.roundNumber, counts: {} }
  }
  return all[ownerId]!
}

function askBixinCard(host: SkillHost, ownerId: PlayerId, cardType: string): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const used = zhangzhiUseState(host.state, ownerId)
  const cardIds = owner.zones.hand.filter((id) => host.state.cards[id]?.category === cardType
    && BIXIN_BASIC_NAMES.some((name) => !used.basicNames.includes(name) && bixinActions(host, ownerId, id, name).length > 0))
  if (!cardIds.length) return
  host.askSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'card', data: { cardType }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【笔心】：选择一张可使用的${cardType === 'basic' ? '基本' : cardType === 'trick' ? '锦囊' : '装备'}手牌，将其视为本轮未使用的基本牌使用`,
    timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
  }) })
  if (host.state.skillResolution?.skillId === ZHANGZHI_BIXIN) host.state.skillResolution.announced = true
}

function bixinActions(host: SkillHost, ownerId: PlayerId, cardId: CardId, name: string) {
  return declaredCardActions(host.state, ownerId, cardId, name, `【笔心】将牌当【${name}】使用`, {
    sourceSkillId: ZHANGZHI_BIXIN, ignoreSlashQuota: true,
  }).filter((action) => action.kind === 'use-card')
}

registerSkillRuntime({ id: ZHANGZHI_BIXIN,
  descriptionForView(state, ownerId) {
    return (state as Batch61State).b61ZhangzhiBixinDescription?.[ownerId]
  },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const activations = (state as Batch61State).b61ZhangzhiBixinActivations?.[ownerId] ?? 0
    const used = zhangzhiUseState(state, ownerId)
    const typeUses = zhangzhiTypeUses(state, ownerId)
    if (!owner?.alive || activations < 3 || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || !BIXIN_BASIC_NAMES.some((name) => name !== '闪' && !used.basicNames.includes(name)
        && !isCardUseProhibited(state, ownerId, name, { dyingPlayerId: null }))) return []
    const candidateTypes = ['basic', 'trick', 'equipment'].filter((type) => (typeUses.counts[type] ?? 0) < 3)
    return candidateTypes.length ? [{ id: `${ZHANGZHI_BIXIN}:need-basic`, label: '笔心：需要使用基本牌时，声明类别并摸一张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${ZHANGZHI_BIXIN}:need-basic`) return
    const owner = playerOf(host.state, ownerId)
    const typeUses = zhangzhiTypeUses(host.state, ownerId)
    const options = ['basic', 'trick', 'equipment'].filter((type) => (typeUses.counts[type] ?? 0) < 3)
    if (!owner?.alive || ownerId !== host.state.currentPlayerId || host.state.phase !== 'play' || !options.length) return
    host.askSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'need-play-type', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【笔心】：声明一种牌的类型并摸1张牌',
      timeoutMs: 25_000, optional: false,
      options: options.map((type) => ({ id: type, label: `${type === 'basic' ? '基本牌' : type === 'trick' ? '锦囊牌' : '装备牌'}类型` })),
    }) })
  },
  rescueActions(state, ownerId, dyingPlayerId) {
    const owner = playerOf(state, ownerId)
    const activations = (state as Batch61State).b61ZhangzhiBixinActivations?.[ownerId] ?? 0
    const used = zhangzhiUseState(state, ownerId)
    const typeUses = zhangzhiTypeUses(state, ownerId)
    if (!owner?.alive || state.dying?.playerId !== dyingPlayerId || activations < 3 || used.basicNames.includes('桃')
      || isCardResponseProhibited(state, ownerId, '桃')
      || !['basic', 'trick', 'equipment'].some((type) => (typeUses.counts[type] ?? 0) < 3)) return []
    return [{ id: `rescue:${ZHANGZHI_BIXIN}:桃`, label: '笔心：声明类别并摸一张牌，尝试视为使用【桃】' }]
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== `rescue:${ZHANGZHI_BIXIN}:桃` || host.state.dying?.playerId !== dyingPlayerId
      || isCardResponseProhibited(host.state, ownerId, '桃')) return false
    const owner = playerOf(host.state, ownerId)
    const typeUses = zhangzhiTypeUses(host.state, ownerId)
    const options = ['basic', 'trick', 'equipment'].filter((type) => (typeUses.counts[type] ?? 0) < 3)
    if (!owner?.alive || !options.length || zhangzhiUseState(host.state, ownerId).basicNames.includes('桃')) return false
    host.askSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'rescue-type', data: { dyingPlayerId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【笔心】：声明一种牌的类型并摸1张牌，尝试视为使用【桃】',
      timeoutMs: 25_000, optional: false,
      options: options.map((type) => ({ id: type, label: `${type === 'basic' ? '基本牌' : type === 'trick' ? '锦囊牌' : '装备牌'}类型` })),
    }) })
    return 'deferred'
  },
  virtualBasicResponse(state, ownerId, requiredCardName) {
    const used = zhangzhiUseState(state, ownerId)
    const activations = (state as Batch61State).b61ZhangzhiBixinActivations?.[ownerId] ?? 0
    const typeUses = zhangzhiTypeUses(state, ownerId)
    return activations >= 3 && BIXIN_BASIC_NAMES.includes(requiredCardName as typeof BIXIN_BASIC_NAMES[number])
      && !used.basicNames.includes(requiredCardName)
      && ['basic', 'trick', 'equipment'].some((type) => (typeUses.counts[type] ?? 0) < 3)
  },
  beginVirtualBasicResponse(host, ownerId, requiredCardName, rawRequest) {
    if (!rawRequest || rawRequest.kind !== 'respond-card' || !BIXIN_BASIC_NAMES.includes(requiredCardName as typeof BIXIN_BASIC_NAMES[number])) return false
    const activations = (host.state as Batch61State).b61ZhangzhiBixinActivations?.[ownerId] ?? 0
    const used = zhangzhiUseState(host.state, ownerId)
    const typeUses = zhangzhiTypeUses(host.state, ownerId)
    const options = ['basic', 'trick', 'equipment'].filter((type) => (typeUses.counts[type] ?? 0) < 3)
    if (activations < 3 || used.basicNames.includes(requiredCardName) || !options.length) return false
    const request = rawRequest as RespondCardRequest
    host.askSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'need-basic-type', data: { requiredCardName, request }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【笔心】：声明一种牌的类型并摸1张牌，尝试使用【${requiredCardName}】`,
      timeoutMs: 25_000, optional: false,
      options: options.map((type) => ({ id: type, label: `${type === 'basic' ? '基本牌' : type === 'trick' ? '锦囊牌' : '装备牌'}类型` })),
    }) })
    return true
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    const activations = (host.state as Batch61State).b61ZhangzhiBixinActivations?.[ownerId] ?? 0
    const eligibleOwner = activations === 0 ? Boolean(event.playerId) : event.playerId === ownerId
    const eligiblePhase = activations < 2
      ? event.phase === 'prepare' || event.phase === 'finish'
      : activations === 2 && event.phase === 'finish'
    if (!eligibleOwner || !eligiblePhase || !playerOf(host.state, ownerId)?.alive) return
    const used = zhangzhiUseState(host.state, ownerId)
    const typeUses = zhangzhiTypeUses(host.state, ownerId)
    const limit = activations >= 3 ? 3 : 1
    const unusedTypes = ['basic', 'trick', 'equipment'].filter((type) =>
      (typeUses.counts[type] ?? 0) < limit && !used.types.includes(type))
    if (!unusedTypes.length) return
    host.askSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'type', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【笔心】：声明一种牌的类型并摸三张牌',
      timeoutMs: 25_000, optional: true, options: unusedTypes.map((type) => ({ id: type, label: `${type === 'basic' ? '基本牌' : type === 'trick' ? '锦囊牌' : '装备牌'}类型` })),
    }) })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const cardType = cardId ? (host.state as Batch61State).b61ZhangzhiBixinCards?.[cardId] : undefined
      if (!cardId || !cardType) return
      delete (host.state as Batch61State).b61ZhangzhiBixinCards?.[cardId]
      host.queueSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'card', data: { cardType } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'card') askBixinCard(host, ownerId, (prompt.data as { cardType: string }).cardType)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'need-play-type') {
      const type = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || ownerId !== host.state.currentPlayerId || host.state.phase !== 'play'
        || !type || !['basic', 'trick', 'equipment'].includes(type)) return
      const typeUses = zhangzhiTypeUses(host.state, ownerId)
      if ((typeUses.counts[type] ?? 0) >= 3) return
      typeUses.counts[type] = (typeUses.counts[type] ?? 0) + 1
      zhangzhiUseState(host.state, ownerId).types.push(type)
      host.dispatch('SkillActivated', { skillId: ZHANGZHI_BIXIN, skillName: '笔心' }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      askBixinCard(host, ownerId, type)
      return
    }
    if (resolution.step === 'rescue-type') {
      const dyingPlayerId = (resolution.data as { dyingPlayerId: PlayerId }).dyingPlayerId
      const type = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      const dying = playerOf(host.state, dyingPlayerId)
      if (!owner?.alive || !dying?.alive || host.state.dying?.playerId !== dyingPlayerId || !type
        || !['basic', 'trick', 'equipment'].includes(type)) {
        host.resumeAfterDying()
        return
      }
      const typeUses = zhangzhiTypeUses(host.state, ownerId)
      if ((typeUses.counts[type] ?? 0) >= 3) { host.resumeAfterDying(); return }
      typeUses.counts[type] = (typeUses.counts[type] ?? 0) + 1
      host.dispatch('SkillActivated', { skillId: ZHANGZHI_BIXIN, skillName: '笔心' }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      const candidates = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === type
        && !isResponseCardProhibited(host.state, ownerId, cardId, '桃'))
      if (!candidates.length) { host.resumeAfterDying(); return }
      host.askSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'rescue-card', data: { dyingPlayerId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【笔心】：选择一张${type === 'basic' ? '基本' : type === 'trick' ? '锦囊' : '装备'}手牌当【桃】使用`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'rescue-card') {
      const dyingPlayerId = (resolution.data as { dyingPlayerId: PlayerId }).dyingPlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = playerOf(host.state, ownerId)
      if (!cardId || !owner?.zones.hand.includes(cardId) || isResponseCardProhibited(host.state, ownerId, cardId, '桃')) {
        host.resumeAfterDying()
        return
      }
      const used = zhangzhiUseState(host.state, ownerId)
      if (used.basicNames.includes('桃') || !host.useVirtualPeachDuringDying(ownerId, dyingPlayerId, ZHANGZHI_BIXIN, [cardId])) {
        host.resumeAfterDying()
        return
      }
      used.basicNames.push('桃')
      return
    }
    if (resolution.step === 'need-basic-type') {
      const data = resolution.data as { requiredCardName: string; request: RespondCardRequest }
      const type = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !type || !['basic', 'trick', 'equipment'].includes(type)) {
        resumeCardResponseAsPass(host as never, data.request)
        return
      }
      const typeUses = zhangzhiTypeUses(host.state, ownerId)
      if ((typeUses.counts[type] ?? 0) >= 3) {
        resumeCardResponseAsPass(host as never, data.request)
        return
      }
      typeUses.counts[type] = (typeUses.counts[type] ?? 0) + 1
      host.dispatch('SkillActivated', { skillId: ZHANGZHI_BIXIN, skillName: '笔心' }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      const candidates = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === type
        && !isResponseCardProhibited(host.state, ownerId, cardId, data.requiredCardName))
      if (!candidates.length) {
        resumeCardResponseAsPass(host as never, data.request)
        return
      }
      host.askSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'need-basic-card', data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【笔心】：选择一张${type === 'basic' ? '基本' : type === 'trick' ? '锦囊' : '装备'}手牌当【${data.requiredCardName}】响应`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'need-basic-card') {
      const data = resolution.data as { requiredCardName: string; request: RespondCardRequest }
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const card = cardId ? host.state.cards[cardId] : undefined
      const owner = playerOf(host.state, ownerId)
      if (!cardId || !owner?.zones.hand.includes(cardId) || !card || !BIXIN_BASIC_NAMES.includes(data.requiredCardName as typeof BIXIN_BASIC_NAMES[number])
        || isResponseCardProhibited(host.state, ownerId, cardId, data.requiredCardName)) {
        resumeCardResponseAsPass(host as never, data.request)
        return
      }
      const used = zhangzhiUseState(host.state, ownerId)
      if (used.basicNames.includes(data.requiredCardName)) {
        resumeCardResponseAsPass(host as never, data.request)
        return
      }
      used.basicNames.push(data.requiredCardName)
      const completed = host.state.cardResolution?.kind === 'trick'
        ? completeVirtualTrickBasicResponse(host as never, ownerId, data.requiredCardName, ZHANGZHI_BIXIN, [cardId])
        : completeVirtualBasicResponse(host as never, ownerId, data.requiredCardName, ZHANGZHI_BIXIN, [cardId])
      if (!completed) resumeCardResponseAsPass(host as never, data.request)
      return
    }
    if (resolution.step === 'type') {
      const type = (response.payload as { optionId?: string }).optionId
      if (!type || !['basic', 'trick', 'equipment'].includes(type)) return
      const used = zhangzhiUseState(host.state, ownerId)
      const activations = (host.state as Batch61State).b61ZhangzhiBixinActivations?.[ownerId] ?? 0
      const typeUses = zhangzhiTypeUses(host.state, ownerId)
      const limit = activations >= 3 ? 3 : 1
      if ((typeUses.counts[type] ?? 0) >= limit || (limit === 1 && used.types.includes(type))) return
      typeUses.counts[type] = (typeUses.counts[type] ?? 0) + 1
      used.types.push(type)
      host.dispatch('SkillActivated', { skillId: ZHANGZHI_BIXIN, skillName: '笔心' }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, activations >= 3 ? 1 : 3, (name, data) => host.dispatch(name, data))
      askBixinCard(host, ownerId, type)
      return
    }
    if (resolution.step === 'card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const type = (resolution.data as { cardType: string }).cardType
      const owner = playerOf(host.state, ownerId)
      if (!cardId || !owner?.zones.hand.includes(cardId) || host.state.cards[cardId]?.category !== type) return
      const used = zhangzhiUseState(host.state, ownerId)
      const choices = BIXIN_BASIC_NAMES.flatMap((name) => used.basicNames.includes(name) || !bixinActions(host, ownerId, cardId, name).length
        ? [] : [{ id: name, label: `当【${name}】使用` }])
      if (!choices.length) return
      host.askSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'name', data: { cardId, cardType: type }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【笔心】：选择一种本轮未使用的基本牌',
        timeoutMs: 25_000, optional: false, options: choices,
      }) })
      if (host.state.skillResolution?.skillId === ZHANGZHI_BIXIN) host.state.skillResolution.announced = true
      return
    }
    if (resolution.step === 'name') {
      const data = resolution.data as { cardId: CardId; cardType: string }
      const name = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      if (!name || !BIXIN_BASIC_NAMES.includes(name as typeof BIXIN_BASIC_NAMES[number]) || !owner?.zones.hand.includes(data.cardId)) return
      const used = zhangzhiUseState(host.state, ownerId)
      const actions = bixinActions(host, ownerId, data.cardId, name)
      if (!actions.length || used.basicNames.includes(name)) return
      host.askSkill({ skillId: ZHANGZHI_BIXIN, ownerId, step: 'action', data: { cardId: data.cardId, cardType: data.cardType, name, actions: actions.map((action) => ({ id: action.id, targetIds: action.targetIds, label: action.label })) }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【笔心】：选择【${name}】的合法目标`,
        timeoutMs: 25_000, optional: false, options: actions.map((action) => ({ id: action.id, label: action.label })),
      }) })
      if (host.state.skillResolution?.skillId === ZHANGZHI_BIXIN) host.state.skillResolution.announced = true
      return
    }
    if (resolution.step !== 'action') return
    const data = resolution.data as { cardId: CardId; cardType: string; name: string; actions: Array<{ id: string; targetIds: PlayerId[]; label: string }> }
    const actionId = (response.payload as { optionId?: string }).optionId
    const action = data.actions.find((candidate) => candidate.id === actionId)
    const owner = playerOf(host.state, ownerId)
    if (!action || !owner?.zones.hand.includes(data.cardId)) return
    ;((host.state as Batch61State).b61ZhangzhiBixinCards ??= {})[data.cardId] = data.cardType
    if (!host.beginSkillBasicUse({ sourceId: ownerId, cardId: data.cardId, cardName: data.name, targetIds: action.targetIds, sourceSkillId: ZHANGZHI_BIXIN })) {
      delete (host.state as Batch61State).b61ZhangzhiBixinCards?.[data.cardId]
      return
    }
    const used = zhangzhiUseState(host.state, ownerId)
    if (!used.basicNames.includes(data.name)) used.basicNames.push(data.name)
  },
})

registerSkillRuntime({ id: HAOPU_ZHENYING,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play') return []
    const slots = [0, 1].filter((index) => !usedThisPhase(state, ownerId, `${HAOPU_ZHENYING}:${index}`))
    if (!slots.length || !state.players.some((target) => target.alive && target.id !== ownerId && handCountFor(state, target.id) <= owner.zones.hand.length)) return []
    return slots.map((index) => ({ id: `${HAOPU_ZHENYING}:${index}`, label: '镇荧：与一名手牌数不大于你的角色同时调整手牌' }))
  },
  invokeActive(host, ownerId, actionId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidateIds = host.state.players.filter((target) => target.alive && target.id !== ownerId
      && target.zones.hand.length <= owner.zones.hand.length).map((target) => target.id)
    if (!candidateIds.length) return
    const useIndex = Number(actionId?.split(':').at(-1) ?? 0)
    host.askSkill({ skillId: HAOPU_ZHENYING, ownerId, step: 'target', data: { useIndex }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【镇荧】：选择一名手牌数不大于你的其他角色',
      timeoutMs: 25_000, optional: true, candidateIds, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.id === ownerId || target.zones.hand.length > owner.zones.hand.length
        || host.state.groupCardDecision) return
      const useIndex = (resolution.data as { useIndex?: number }).useIndex ?? 0
      const usageId = `${HAOPU_ZHENYING}:${useIndex}`
      if (usedThisPhase(host.state, ownerId, usageId)) return
      markUsedThisPhase(host.state, ownerId, usageId)
      startGroupCardDecision(host, {
        id: `${HAOPU_ZHENYING}:${host.state.turnNumber}:${host.state.seq}`,
        tag: HAOPU_GROUP_TAG, skillId: HAOPU_ZHENYING, playerIds: [ownerId, target.id],
        prompt: '【镇荧】：同时选择要弃置的手牌，使手牌数至多为两张',
        cardIdsFor: (playerId) => [...(playerOf(host.state, playerId)?.zones.hand ?? [])],
        minFor: (_playerId, cards) => Math.max(0, cards.length - 2), max: 99,
        timeoutMs: 25_000, data: { ownerId, targetId: target.id },
      })
      return
    }
  },
})

const BASIC_CARD_NAMES = new Set(['杀', '闪', '桃', '酒'])

registerSkillRuntime({ id: AHUINAN_JUEMAN,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const turnNumber = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
    const data = host.state as Batch61State
    const marks = data.b61AhuinanTurn ??= {}
    if (marks[ownerId] === turnNumber) return
    marks[ownerId] = turnNumber
    const used = (host.state.cardUseHistory ?? []).filter((entry) => entry.turnNumber === turnNumber && BASIC_CARD_NAMES.has(entry.cardName))
    if (used.length < 3) return
    if (used[0]!.sourceId === ownerId || used[1]!.sourceId === ownerId) {
      if (Number(used[0]!.sourceId === ownerId) + Number(used[1]!.sourceId === ownerId) === 1)
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      return
    }
    const third = used[2]!
    if (!playerOf(host.state, ownerId)?.alive || !['杀', '桃', '酒'].includes(third.cardName)) return
    const cardId = `virtual:${AHUINAN_JUEMAN}:${turnNumber}:${ownerId}`
    if (host.state.cards[cardId]) return
    host.state.cards[cardId] = { id: cardId, ruleset: host.state.rulesetVersion, expansion: 'standard', name: third.cardName,
      suit: 'spade', rank: 1, color: 'black', category: 'basic', virtual: true, sourceSkillId: AHUINAN_JUEMAN }
    playerOf(host.state, ownerId)!.zones.hand.push(cardId)
    const actions = declaredCardActions(host.state, ownerId, cardId, third.cardName, `【蟨蛮】视为使用本回合第三张【${third.cardName}】`, { sourceSkillId: AHUINAN_JUEMAN, ignoreSlashQuota: true })
      .filter((action) => action.kind === 'use-card')
    if (!actions.length) {
      playerOf(host.state, ownerId)!.zones.hand = playerOf(host.state, ownerId)!.zones.hand.filter((id) => id !== cardId)
      delete host.state.cards[cardId]
      return
    }
    host.queueSkill({ skillId: AHUINAN_JUEMAN, ownerId, step: 'third-basic', data: { cardId, cardName: third.cardName, actions: actions.map((action) => ({ id: action.id, targetIds: action.targetIds, label: action.label })) } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'third-basic') return
    const data = prompt.data as { cardId: CardId; cardName: string; actions: Array<{ id: string; targetIds: PlayerId[]; label: string }> }
    if (!playerOf(host.state, ownerId)?.zones.hand.includes(data.cardId)) return
    host.askSkill({ skillId: AHUINAN_JUEMAN, ownerId, step: 'third-basic', data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【蟨蛮】：视为使用【${data.cardName}】`, timeoutMs: 25_000,
      optional: false, options: data.actions.map((action) => ({ id: action.id, label: action.label })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'third-basic') return
    const data = resolution.data as { cardId: CardId; cardName: string; actions: Array<{ id: string; targetIds: PlayerId[] }> }
    const selected = (response.payload as { optionId?: string }).optionId
    const action = data.actions.find((entry) => entry.id === selected)
    if (!action || !host.beginSkillBasicUse({ sourceId: ownerId, cardId: data.cardId, cardName: data.cardName, targetIds: action.targetIds, sourceSkillId: AHUINAN_JUEMAN })) {
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.zones.hand = owner.zones.hand.filter((id) => id !== data.cardId)
      delete host.state.cards[data.cardId]
    }
  },
})

registerSkillRuntime({ id: QUHUANG_QIEJIAN,
  triggers: [{ event: 'HandCardLeft', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId }
    const targetId = payload.playerId
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target) return
    const state = host.state as Batch61State
    const empty = state.b61QuhuangEmpty ??= {}
    if (target.zones.hand.length > 0) { empty[target.id] = false; return }
    if (empty[target.id]) return
    empty[target.id] = true
    if (!playerOf(host.state, ownerId)?.alive || state.b61QuhuangDisabled?.[ownerId]?.[target.id] === host.state.roundNumber) return
    host.queueSkill({ skillId: QUHUANG_QIEJIAN, ownerId, step: 'invoke', data: { targetId } })
  } }, { event: 'GainCard', handle(host, _ownerId, context) {
    const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (targetId && playerOf(host.state, targetId)?.zones.hand.length)
      ((host.state as Batch61State).b61QuhuangEmpty ??= {})[targetId] = false
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const targetId = (prompt.data as { targetId: PlayerId }).targetId
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
    host.askSkill({ skillId: QUHUANG_QIEJIAN, ownerId, step: 'invoke', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【切谏】：${playerOf(host.state, targetId)?.nickname ?? '该角色'}失去最后一张手牌，是否与其各摸一张牌？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '各摸一张牌' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const data = resolution.data as { pickable: Array<{ cardId: CardId; playerId: PlayerId }> }
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const source = data.pickable.find((entry) => entry.cardId === cardId)
      if (source && movePickedCard(host as never, source.playerId, source.cardId, { kind: 'discardPile' }))
        host.dispatch('LoseCard', { playerId: source.playerId, cardIds: [source.cardId], reason: QUHUANG_QIEJIAN }, { sourceId: ownerId, targetId: source.playerId, cardIds: [source.cardId] })
      return
    }
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      drawCards(host.state, host.rng, targetId, 1, (name, data) => host.dispatch(name, data))
      const pickable = [ownerId, targetId].flatMap((playerId) => {
        const found = pickableCardsOf(host.state, playerId, { includeJudgingArea: true, discarderId: ownerId })
        return found.cardIds.map((cardId) => ({ cardId, playerId }))
      }).filter((entry, index, all) => all.findIndex((candidate) => candidate.cardId === entry.cardId) === index)
      host.askSkill({ skillId: QUHUANG_QIEJIAN, ownerId, step: 'effect', data: { targetId, pickable }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【切谏】：选择弃置一张场上牌，或本轮不能再对其发动【切谏】',
        timeoutMs: 25_000, optional: false, options: [
          ...(pickable.length ? [{ id: 'discard', label: '弃置你或其场上的一张牌' }] : []),
          { id: 'disable', label: '本轮不能再对其发动【切谏】' },
        ],
      }) })
      return
    }
    if (resolution.step !== 'effect') return
    const data = resolution.data as { targetId: PlayerId; pickable: Array<{ cardId: CardId; playerId: PlayerId }> }
    const choice = (response.payload as { optionId?: string }).optionId
    if (choice === 'disable') {
      const disabled = (host.state as Batch61State).b61QuhuangDisabled ??= {}
      ;(disabled[ownerId] ??= {})[data.targetId] = host.state.roundNumber
      return
    }
    if (choice !== 'discard') return
    const currentIds = data.pickable.filter(({ cardId, playerId }) => {
      const player = playerOf(host.state, playerId)
      return Boolean(player && (player.zones.judgingArea.includes(cardId) || Object.values(player.zones.equipment).includes(cardId))
        && !isCardProtectedFromDiscard(host.state, playerId, cardId, ownerId))
    }).map(({ cardId }) => cardId)
    if (!currentIds.length) return
    host.askSkill({ skillId: QUHUANG_QIEJIAN, ownerId, step: 'discard', data, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【切谏】：选择一张你或其场上的牌弃置',
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: currentIds, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
})

registerSkillRuntime({ id: QUHUANG_NISHOU,
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; fromKind?: string; fromPlayerId?: PlayerId }
      if (payload.fromKind !== 'equipment' || payload.fromPlayerId !== ownerId || !payload.cardId
        || !host.state.zones.discardPile.includes(payload.cardId) || host.state.cards[payload.cardId]?.category !== 'equipment') return
      host.queueSkill({ skillId: QUHUANG_NISHOU, ownerId, step: 'choose-branch', data: { cardId: payload.cardId, turnNumber: host.state.turnNumber, phase: host.state.phase } })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId) return
      const state = host.state as Batch61State
      const pending = state.b61QuhuangPendingSwap?.[ownerId] ?? []
      const matching = pending.filter((entry) => entry.turnNumber === host.state.turnNumber && entry.phase === payload.phase)
      if (!matching.length) return
      state.b61QuhuangPendingSwap![ownerId] = pending.filter((entry) => !matching.includes(entry))
      host.queueSkill({ skillId: QUHUANG_NISHOU, ownerId, step: 'swap-target', data: { remaining: matching.length } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'swap-target') {
      const remaining = (prompt.data as { remaining: number }).remaining
      const living = host.state.players.filter((player) => player.alive)
      const minimum = Math.min(...living.map((player) => player.zones.hand.length))
      const candidateIds = living.filter((player) => player.id !== ownerId && player.zones.hand.length === minimum).map((player) => player.id)
      if (!candidateIds.length) return
      host.askSkill({ skillId: QUHUANG_NISHOU, ownerId, step: 'swap-target', data: { remaining }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【泥首】：与一名手牌数最少的其他角色交换手牌',
        timeoutMs: 25_000, optional: false, candidateIds, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step !== 'choose-branch') return
    const data = prompt.data as { cardId: CardId; turnNumber: number; phase: string }
      const owner = playerOf(host.state, ownerId)
      const canLightning = host.state.zones.discardPile.includes(data.cardId)
        && !owner?.zones.judgingArea.some((id) => host.state.cards[id]?.name === '闪电')
    host.askSkill({ skillId: QUHUANG_NISHOU, ownerId, step: 'choose-branch', data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【泥首】：将此装备牌当【闪电】使用，或于此阶段结束时交换手牌',
      timeoutMs: 25_000, optional: false, options: [
        ...(canLightning ? [{ id: 'lightning', label: '当【闪电】使用' }] : []),
        { id: 'swap', label: '阶段结束时与手牌数最少的角色交换手牌' },
      ],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-branch') {
      const data = resolution.data as { cardId: CardId; turnNumber: number; phase: string }
      if ((response.payload as { optionId?: string }).optionId === 'lightning') {
        host.beginSkillLightningFromDiscard(ownerId, data.cardId, QUHUANG_NISHOU)
        return
      }
      if ((response.payload as { optionId?: string }).optionId === 'swap') {
        const pending = (host.state as Batch61State).b61QuhuangPendingSwap ??= {}
        ;(pending[ownerId] ??= []).push({ turnNumber: data.turnNumber, phase: data.phase })
      }
      return
    }
    if (resolution.step !== 'swap-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const remaining = (resolution.data as { remaining: number }).remaining
    if (!target?.alive || target.id === ownerId) return
    const minimum = Math.min(...host.state.players.filter((player) => player.alive).map((player) => player.zones.hand.length))
    if (target.zones.hand.length !== minimum) return
    swapHands(host as never, ownerId, target.id, QUHUANG_NISHOU)
    if (remaining > 1) host.queueSkill({ skillId: QUHUANG_NISHOU, ownerId, step: 'swap-target', data: { remaining: remaining - 1 } })
  },
})

registerSkillRuntime({ id: SUNHONG_ZANRUN,
  triggers: [{ event: 'DrawAttempt', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; count?: number; attemptIndex?: number }
    const attemptIndex = payload.attemptIndex
    const replay = host.state.drawOperationReplay
    if (context.cancelled || payload.playerId !== ownerId || !replay || !Number.isInteger(attemptIndex) || (attemptIndex ?? -1) < 0
      || usedThisPhase(host.state, ownerId, SUNHONG_ZANRUN)) return
    const count = Math.max(0, Math.trunc(payload.count ?? 0))
    if (count <= 0) return
    const attempt = replay.choices[String(attemptIndex)] ??= {}
    const choice = attempt[SUNHONG_ZANRUN] ??= {}
    const forbidden = (host.state as Batch61State).b61SunhongForbiddenTargets?.[ownerId] ?? []
    const targetCandidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
      && !forbidden.includes(target.id)
      && (() => {
        const pickable = pickableCardsOf(host.state, target.id)
        return pickable.cardIds.length + pickable.hiddenCardSlots.length >= count
      })())
    if (!targetCandidates.length) return

    const ask = (step: string, data: Record<string, unknown>, build: (id: string) => ChooseOptionRequest | ChooseTargetsRequest | ChooseCardsRequest) => {
      host.askSkill({ skillId: SUNHONG_ZANRUN, ownerId, step, data: { ...data, attemptIndex }, build })
      context.cancel()
    }
    if (!choice.invoke) {
      ask('invoke', { count }, (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【谮润】：是否放弃摸${count}张牌，改为获得一名其他角色等量张牌？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动谮润' }, { id: 'no', label: '照常摸牌' }],
      }))
      return
    }
    if ((choice.invoke as { optionId?: string }).optionId !== 'yes') return

    const targetId = (choice.target as { targetIds?: PlayerId[] } | undefined)?.targetIds?.[0]
    if (!targetId) {
      ask('target', { count }, (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【谮润】：选择一名有足够可获得牌的其他角色',
        timeoutMs: 25_000, optional: false, candidateIds: targetCandidates.map((target) => target.id), min: 1, max: 1,
      }))
      return
    }
    const target = playerOf(host.state, targetId)
    if (!target?.alive || target.id === ownerId || !targetCandidates.some((candidate) => candidate.id === target.id))
      throw new Error('谮润重放时所选目标已不合法')

    const selected = (choice.take as { cardIds?: string[] } | undefined)?.cardIds
    if (!selected) {
      const pickable = pickableCardsOf(host.state, target.id)
      ask('take', { count, targetId }, (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【谮润】：获得其${count}张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: count, max: count,
      }))
      return
    }

    const cardIds = [...new Set(selected)].map((picked) => resolvePickedCard(host.state, target.id, picked))
      .filter((cardId): cardId is CardId => Boolean(cardId && (target.zones.hand.includes(cardId)
        || Object.values(target.zones.equipment).includes(cardId)))).slice(0, count)
    if (cardIds.length !== count) throw new Error('谮润重放时所选牌已不合法')
    const reward = choice.reward as { optionId?: string } | undefined
    const received: CardId[] = []
    markUsedThisPhase(host.state, ownerId, SUNHONG_ZANRUN)
    host.dispatch('SkillActivated', {
      skillId: SUNHONG_ZANRUN, skillName: '谮润', playerId: ownerId, result: 'replace-draw',
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【谮润】，改为获得${count}张牌`,
    }, { sourceId: ownerId })
    for (const cardId of cardIds) {
      if (movePickedCard(host as never, target.id, cardId, { kind: 'hand', playerId: ownerId })) received.push(cardId)
    }
    if (received.length !== count) throw new Error('谮润取得牌张数与选牌数量不符')
    host.dispatch('LoseCard', { playerId: target.id, cardIds: received, reason: SUNHONG_ZANRUN }, { sourceId: target.id, targetId: ownerId, cardIds: received })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: received, reason: SUNHONG_ZANRUN }, { sourceId: ownerId, targetId: ownerId, cardIds: received })
    if (!reward) {
      ask('reward', { targetId, count }, (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: target.id, prompt: `【谮润】：选择摸${count}张牌，或令孙弘不能再对你发动武将牌上的技能`,
        timeoutMs: 25_000, optional: false, options: [
          { id: 'draw', label: `摸${count}张牌` },
          { id: 'forbid', label: '孙弘不能再对你发动武将牌上的技能' },
        ],
      }))
      return
    }
    if (reward.optionId === 'draw') drawCards(host.state, host.rng, target.id, count, (name, data) => host.dispatch(name, data))
    else if (reward.optionId === 'forbid') {
      const targets = (host.state as Batch61State).b61SunhongForbiddenTargets ??= {}
      targets[ownerId] = [...new Set([...(targets[ownerId] ?? []), target.id])]
    } else throw new Error('谮润目标回报选择无效')
    context.event.payload.replacementCardIds = received
    context.cancel()
  } }],
  resume(host, _ownerId, resolution, response) {
    const attemptIndex = (resolution.data as { attemptIndex?: number }).attemptIndex
    if (Number.isInteger(attemptIndex) && attemptIndex !== undefined) {
      if (!host.resumeDrawOperation) throw new Error('当前游戏宿主不支持摸牌时机续接')
      const requestKind = resolution.step === 'target' ? 'choose-targets'
        : resolution.step === 'take' ? 'choose-cards' : 'choose-option'
      host.resumeDrawOperation({
        skillId: SUNHONG_ZANRUN, attemptIndex, step: resolution.step, playerId: response.playerId,
        requestId: resolution.requestId, requestKind, payload: response.payload,
      })
      return
    }
  },
})

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function ruijieModeForCard(state: SanguoshaState, cardId: CardId): 'weapon' | 'other-equipment' | null {
  const card = state.cards[cardId]
  if (card?.category !== 'equipment' || !card.equipmentSlot) return null
  return card.equipmentSlot === 'weapon' ? 'weapon' : 'other-equipment'
}

function equipmentCardIdsInDrawPile(state: SanguoshaState): CardId[] {
  return state.zones.drawPile.filter((cardId) => state.cards[cardId]?.category === 'equipment')
}

function equipmentCount(state: SanguoshaState, playerId: PlayerId): number {
  const owner = playerOf(state, playerId)
  return owner ? Object.values(owner.zones.equipment).filter(Boolean).length : 0
}

function askRuijieDistribute(host: SkillHost, ownerId: PlayerId, cardIds: CardId[]): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner || !cardIds.length) return
  const recipients = host.state.players.filter((player) => player.alive).map((player) => player.id)
  if (!recipients.length) return
  host.askSkill({ skillId: RUIJIE_QIAOLI, ownerId, step: 'distribute-draw', data: { cardIds }, build: (id): DistributeCardsRequest => ({
    id, kind: 'distribute-cards', playerId: ownerId, prompt: '【巧力】：可将摸到的牌分配给任意角色',
    timeoutMs: 25_000, optional: true, cardIds, recipientIds: recipients, min: 0, max: cardIds.length,
  }) })
}

registerSkillRuntime({ id: RUIJIE_QIAOLI,
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play') return []
    const options = owner.zones.hand.flatMap((cardId) => {
      const mode = ruijieModeForCard(state, cardId)
      if (!mode || usedThisPhase(state, ownerId, `${RUIJIE_QIAOLI}:${mode}`)) return []
      return [{ asCardName: '决斗', cardId, label: mode === 'weapon' ? '巧力：武器牌当【决斗】' : '巧力：非武器装备牌当不可响应的【决斗】' }]
    })
    return options
  },
  trickUnresponsive(state, ownerId, targetId, cardName, cardId) {
    if (cardName !== '决斗' || !cardId) return false
    const duel = (state as Batch61State).b61RuijieDuel?.[cardId]
    return duel?.sourceId === ownerId && duel.mode === 'other-equipment' && duel.targetIds.includes(targetId)
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== RUIJIE_QIAOLI) return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[]; cardName?: string }
      const cardId = payload.cardId
      const mode = cardId ? ruijieModeForCard(host.state, cardId) : null
      if (!cardId || payload.cardName !== '决斗' || !mode) return
      markUsedThisPhase(host.state, ownerId, `${RUIJIE_QIAOLI}:${mode}`)
      ;((host.state as Batch61State).b61RuijieDuel ??= {})[cardId] = {
        mode, sourceId: ownerId, targetIds: [...(payload.targetIds ?? [])],
      }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId | null; finalAmount?: number }
      const duel = payload.cardId ? (host.state as Batch61State).b61RuijieDuel?.[payload.cardId] : undefined
      const targetId = context.event.targetId
      if (!duel || duel.mode !== 'weapon' || duel.sourceId !== ownerId || !targetId
        || !duel.targetIds.includes(targetId) || (payload.finalAmount ?? 0) <= 0) return
      const count = getAttackRange(host.state, targetId)
      const drawn = drawCards(host.state, host.rng, ownerId, count, (name, drawPayload) => host.dispatch(name, drawPayload))
      askRuijieDistribute(host, ownerId, drawn)
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'finish') return
      const usedOtherEquipment = usedThisPhase(host.state, ownerId, `${RUIJIE_QIAOLI}:other-equipment`)
      if (!usedOtherEquipment) return
      const pool = equipmentCardIdsInDrawPile(host.state)
      const chosen = pool.length ? host.rng.pick(pool) : undefined
      if (!chosen || !host.state.zones.drawPile.includes(chosen)) return
      moveCard(host.state, chosen, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [chosen], reason: RUIJIE_QIAOLI }, { sourceId: ownerId, targetId: ownerId, cardIds: [chosen] })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'distribute-draw') return
    const data = resolution.data as { cardIds: CardId[] }
    const assignments = (response.payload as { assignments?: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments ?? []
    const assigned = new Map<PlayerId, CardId[]>()
    for (const item of assignments) {
      const recipient = playerOf(host.state, item.recipientId)
      if (!data.cardIds.includes(item.cardId) || !recipient?.alive || item.cardId === '') continue
      assigned.set(recipient.id, [...(assigned.get(recipient.id) ?? []), item.cardId])
    }
    for (const [recipientId, cardIds] of assigned) giveCards(host as never, ownerId, recipientId, cardIds, RUIJIE_QIAOLI)
  },
})

function discardableRuijieSuits(state: SanguoshaState, ownerId: PlayerId): Array<'spade' | 'heart' | 'club' | 'diamond'> {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return [...new Set(owner.zones.hand.filter((cardId) => !isCardProtectedFromDiscard(state, ownerId, cardId, ownerId))
    .map((cardId) => effectiveCardSuit(state, ownerId, cardId))
    .filter((suit): suit is 'spade' | 'heart' | 'club' | 'diamond' => Boolean(suit)))]
}

registerSkillRuntime({ id: RUIJIE_QINGLIANG,
  interceptTarget(host, ownerId, context) {
    const targets = cardUseTargetsOf(host.state, context.cardId)?.targetIds
    if (context.targetId !== ownerId || context.sourceId === ownerId || usedThisTurn(host.state, ownerId, RUIJIE_QINGLIANG)
      || (context.cardName !== '杀' && !DAMAGE_TRICKS.has(context.cardName)) || targets?.length !== 1) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner) return false
    host.askSkill({ skillId: RUIJIE_QINGLIANG, ownerId, step: 'invoke', data: { cardId: context.cardId, sourceId: context.sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【清靓】：是否展示所有手牌并发动？', timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '发动清靓' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const owner = playerOf(host.state, ownerId)
      if (!owner) { host.resumeCardTarget(); return }
      host.dispatch('CardMove', { playerId: ownerId, cardIds: [...owner.zones.hand], reason: RUIJIE_QINGLIANG, revealed: true }, { sourceId: ownerId, targetId: ownerId, cardIds: [...owner.zones.hand] })
      const suits = discardableRuijieSuits(host.state, ownerId)
      host.askSkill({ skillId: RUIJIE_QINGLIANG, ownerId, step: 'choice', data: { ...(resolution.data as object), suits }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【清靓】：选择一项', timeoutMs: 25_000, optional: false,
        options: [
          { id: 'draw', label: '你与使用者各摸一张牌' },
          ...(suits.length ? [{ id: 'discard', label: '弃置一种花色的所有手牌并取消此目标' }] : []),
        ],
      }) })
      return
    }
    if (resolution.step === 'choice') {
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'draw') {
        markUsedThisTurn(host.state, ownerId, RUIJIE_QINGLIANG)
        if (playerOf(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
        const sourceId = (resolution.data as { sourceId: PlayerId }).sourceId
        if (playerOf(host.state, sourceId)?.alive) drawCards(host.state, host.rng, sourceId, 1, (name, data) => host.dispatch(name, data))
        host.resumeCardTarget()
        return
      }
      const suits = (resolution.data as { suits: Array<'spade' | 'heart' | 'club' | 'diamond'> }).suits
      if (choice !== 'discard' || !suits.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: RUIJIE_QINGLIANG, ownerId, step: 'discard-suit', data: resolution.data, build: (id): ChooseSuitRequest => ({
        id, kind: 'choose-suit', playerId: ownerId, prompt: '【清靓】：选择要弃置的花色', timeoutMs: 25_000, optional: false, suits,
      }) })
      return
    }
    if (resolution.step !== 'discard-suit') return
    const suit = (response.payload as { suit?: 'spade' | 'heart' | 'club' | 'diamond' }).suit
    const owner = playerOf(host.state, ownerId)
    if (suit && owner && (resolution.data as { suits: string[] }).suits.includes(suit)) {
      const discarded: CardId[] = []
      for (const cardId of [...owner.zones.hand]) {
        if (effectiveCardSuit(host.state, ownerId, cardId) !== suit || isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId)) continue
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        discarded.push(cardId)
      }
      if (discarded.length) host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: RUIJIE_QINGLIANG }, { sourceId: ownerId, targetId: ownerId, cardIds: discarded })
      markUsedThisTurn(host.state, ownerId, RUIJIE_QINGLIANG)
      cancelCardTargetForOwner(host, ownerId)
    }
    host.resumeCardTarget()
  },
})

function menghuoSteps(state: SanguoshaState, ownerId: PlayerId): number {
  const data = state as Batch61State
  data.b61MenghuoSteps ??= {}
  return data.b61MenghuoSteps[ownerId] ??= 4
}

function askManwangCards(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  const pickable = pickableCardsOf(host.state, ownerId, { discarderId: ownerId })
  const maximum = Math.min(menghuoSteps(host.state, ownerId), pickable.cardIds.length + pickable.hiddenCardSlots.length)
  if (!maximum) return
  host.askSkill({ skillId: MENGHUO_MANWANG, ownerId, step: 'discard', data: {}, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【蛮王】：弃置至多${maximum}张牌，依次执行相同数量的项目`,
    timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: pickable.cardIds,
    hiddenCardSlots: pickable.hiddenCardSlots, min: 0, max: maximum,
  }) })
}

registerSkillRuntime({ id: MENGHUO_MANWANG,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play' || menghuoSteps(state, ownerId) <= 0) return []
    const pickable = pickableCardsOf(state, ownerId, { discarderId: ownerId })
    return pickable.cardIds.length + pickable.hiddenCardSlots.length
      ? [{ id: MENGHUO_MANWANG, label: '蛮王：弃牌并执行对应项目' }] : []
  },
  invokeActive(host, ownerId) { askManwangCards(host, ownerId) },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const chosen = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const discarded: CardId[] = []
    for (const picked of [...new Set(chosen)].slice(0, menghuoSteps(host.state, ownerId))) {
      const cardId = resolvePickedCard(host.state, ownerId, picked)
      if (!cardId || isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId)) continue
      if (!owner.zones.hand.includes(cardId) && !Object.values(owner.zones.equipment).includes(cardId)) continue
      if (movePickedCard(host as never, ownerId, cardId, { kind: 'discardPile' })) discarded.push(cardId)
    }
    if (!discarded.length) return
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: MENGHUO_MANWANG }, { sourceId: ownerId, targetId: ownerId, cardIds: discarded })
    const steps = Math.min(discarded.length, menghuoSteps(host.state, ownerId))
    if (steps >= 1) replaceTemporarySkill(host.state, ownerId, MENGHUO_MANWANG, MENGHUO_PANQIN)
    if (steps >= 2) drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    if (steps >= 3) recover(host as never, ownerId, 1, ownerId)
    if (steps >= 4) {
      drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
      replaceTemporarySkill(host.state, ownerId, MENGHUO_MANWANG, null)
    }
  },
})

registerSkillRuntime({ id: MENGHUO_PANQIN,
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; reason?: string }
      if (context.event.sourceId !== ownerId || payload.reason !== 'discard' || !payload.cardId) return
      const data = host.state as Batch61State
      const entries = data.b61MenghuoDiscarded ??= {}
      const list = entries[ownerId] ??= []
      list.push({ cardId: payload.cardId, turnNumber: host.state.turnNumber, phase: host.state.phase, seq: context.event.seq })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (event.playerId !== ownerId || (event.phase !== 'play' && event.phase !== 'discard')) return
      const data = host.state as Batch61State
      const entries = data.b61MenghuoDiscarded?.[ownerId] ?? []
      const cardIds = entries.filter((entry) => entry.turnNumber === host.state.turnNumber && entry.phase === event.phase
        && host.state.zones.discardPile.includes(entry.cardId)).sort((a, b) => a.seq - b.seq).map((entry) => entry.cardId)
      data.b61MenghuoDiscarded![ownerId] = entries.filter((entry) => entry.turnNumber !== host.state.turnNumber || entry.phase !== event.phase)
      if (cardIds.length) host.queueSkill({ skillId: MENGHUO_PANQIN, ownerId, step: 'offer', data: { cardIds } })
    } },
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== MENGHUO_PANQIN) return
      const payload = context.event.payload as { targetIds?: PlayerId[]; cardIds?: CardId[] }
      const materialCount = Math.max(0, (payload.cardIds?.length ?? 1) - 1)
      if (!materialCount || (payload.targetIds?.length ?? 0) < materialCount) return
      const state = host.state as Batch61State
      state.b61MenghuoSteps ??= {}
      state.b61MenghuoSteps[ownerId] = Math.max(0, menghuoSteps(host.state, ownerId) - 1)
      gainMaxHp(host as never, ownerId, 1, MENGHUO_PANQIN)
      if (playerOf(host.state, ownerId)?.alive) recover(host as never, ownerId, 1, ownerId)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const cardIds = ((prompt.data as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => host.state.zones.discardPile.includes(id))
    const targetCount = host.state.players.filter((player) => player.alive && player.id !== ownerId).length
    if (!Math.min(cardIds.length, targetCount)) return
    host.askSkill({ skillId: MENGHUO_PANQIN, ownerId, step: 'invoke', data: { cardIds }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【叛侵】：是否将本阶段弃置的牌当【南蛮入侵】使用？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动叛侵' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const cardIds = (resolution.data as { cardIds: CardId[] }).cardIds.filter((id) => host.state.zones.discardPile.includes(id))
      const targetIds = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      const maximum = Math.min(cardIds.length, targetIds.length)
      if (!maximum) return
      host.askSkill({ skillId: MENGHUO_PANQIN, ownerId, step: 'materials', data: { cardIds, targetIds }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【叛侵】：选择转化为【南蛮入侵】的弃置牌',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: maximum,
      }) })
      return
    }
    if (resolution.step !== 'materials') return
    const data = resolution.data as { cardIds: CardId[]; targetIds: PlayerId[] }
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((id) => data.cardIds.includes(id) && host.state.zones.discardPile.includes(id))
    const targets = data.targetIds.filter((id) => id !== ownerId && playerOf(host.state, id)?.alive)
    if (!selected.length || selected.length > targets.length) return
    if (!host.beginVirtualTrick({ sourceId: ownerId, targetIds: targets, cardName: '南蛮入侵', sourceSkillId: MENGHUO_PANQIN, extraCardIds: selected })) return
  },
})

registerSkillRuntime({ id: GUOHUAI_ZHEFU,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string }
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId === ownerId || !payload.cardName) return
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0)
      if (!candidates.length) return
      host.queueSkill({ skillId: GUOHUAI_ZHEFU, ownerId, step: 'choose-target', data: { cardName: payload.cardName } })
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardName?: string }
      if (payload.playerId !== ownerId || host.state.currentPlayerId === ownerId || !payload.cardName) return
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0)
      if (!candidates.length) return
      host.queueSkill({ skillId: GUOHUAI_ZHEFU, ownerId, step: 'choose-target', data: { cardName: payload.cardName } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-target') return
    const cardName = (prompt.data as { cardName: string }).cardName
    const candidateIds = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0).map((player) => player.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: GUOHUAI_ZHEFU, ownerId, step: 'target', data: { cardName }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【哲妇】：选择一名有同名手牌的其他角色', timeoutMs: 25_000,
      optional: true, candidateIds, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardName = (resolution.data as { cardName: string }).cardName
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const matching = target.zones.hand.filter((id) => host.state.cards[id]?.name === cardName && !isCardProtectedFromDiscard(host.state, target.id, id, ownerId))
      if (!matching.length) {
        resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, cardName: GUOHUAI_ZHEFU })
        return
      }
      host.askSkill({ skillId: GUOHUAI_ZHEFU, ownerId, step: 'pay-or-damage', data: { targetId, cardName }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: target.id, prompt: '【哲妇】：弃置一张同名手牌，或受到1点伤害', timeoutMs: 25_000, optional: false,
        options: [{ id: 'discard', label: `弃置一张【${cardName}】` }, { id: 'damage', label: '受到1点伤害' }],
      }) })
      return
    }
    if (resolution.step === 'pay-or-damage') {
      const data = resolution.data as { targetId: PlayerId; cardName: string }
      const target = playerOf(host.state, data.targetId)
      if (!target?.alive) return
      if ((response.payload as { optionId?: string }).optionId === 'discard') {
        const candidates = target.zones.hand.filter((id) => host.state.cards[id]?.name === data.cardName && !isCardProtectedFromDiscard(host.state, target.id, id, ownerId))
        if (!candidates.length) { resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, cardName: GUOHUAI_ZHEFU }); return }
        host.askSkill({ skillId: GUOHUAI_ZHEFU, ownerId, step: 'discard-name', data, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: target.id, prompt: `【哲妇】：弃置一张【${data.cardName}】`, timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      } else resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, cardName: GUOHUAI_ZHEFU })
      return
    }
    if (resolution.step !== 'discard-name') return
    const data = resolution.data as { targetId: PlayerId; cardName: string }
    const target = playerOf(host.state, data.targetId)
    const chosen = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!target?.alive || !chosen || !target.zones.hand.includes(chosen) || host.state.cards[chosen]?.name !== data.cardName
      || isCardProtectedFromDiscard(host.state, target.id, chosen, ownerId)) {
      if (target?.alive) resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, cardName: GUOHUAI_ZHEFU })
      return
    }
    moveCard(host.state, chosen, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: target.id, cardIds: [chosen], reason: GUOHUAI_ZHEFU }, { sourceId: target.id, targetId: target.id, cardIds: [chosen] })
  },
})

registerSkillRuntime({ id: GUOHUAI_YIDU,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId | null; finalAmount?: number }
      const cardId = payload.cardId
      if (context.event.sourceId === ownerId && cardId && context.event.targetId && (payload.finalAmount ?? 0) > 0) {
        const targets = (host.state as Batch61State).b61GuohuaiDamagedTargets ??= {}
        targets[cardId] = [...new Set([...(targets[cardId] ?? []), context.event.targetId])]
      }
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    if (context.event.sourceId !== ownerId || !payload.cardId || !payload.cardName
      || (payload.cardName !== '杀' && !DAMAGE_TRICKS.has(payload.cardName))) return
    const damagedTargets = (host.state as Batch61State).b61GuohuaiDamagedTargets?.[payload.cardId] ?? []
    const candidates = (payload.targetIds ?? []).filter((targetId) => {
      const target = playerOf(host.state, targetId)
      return target?.alive && !damagedTargets.includes(targetId) && target.zones.hand.length > 0
    })
    delete (host.state as Batch61State).b61GuohuaiDamagedTargets?.[payload.cardId]
    if (!candidates.length) return
    host.queueSkill({ skillId: GUOHUAI_YIDU, ownerId, step: 'target', data: { cardId: payload.cardId, cardName: payload.cardName, candidates } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const data = prompt.data as { cardId: CardId; cardName: string; candidates: PlayerId[] }
    const actual = data.candidates.filter((id) => playerOf(host.state, id)?.alive && playerOf(host.state, id)!.zones.hand.length > 0)
    if (!actual.length) return
    host.askSkill({ skillId: GUOHUAI_YIDU, ownerId, step: 'target', data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【遗毒】：选择一名未受到此牌伤害且有手牌的目标', timeoutMs: 25_000,
      optional: true, candidateIds: actual, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || !target.zones.hand.length) return
      const slots = target.zones.hand.map((_, index) => hiddenHandSlot(target.id, index))
      host.askSkill({ skillId: GUOHUAI_YIDU, ownerId, step: 'show-cards', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【遗毒】：选择并展示其至多三张手牌', timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds: [], hiddenCardSlots: slots, min: 0, max: Math.min(3, slots.length),
      }) })
      return
    }
    if (resolution.step !== 'show-cards') return
    const targetId = (resolution.data as { targetId: PlayerId }).targetId
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const revealed = [...new Set(selected)].map((picked) => resolvePickedCard(host.state, target.id, picked))
      .filter((id): id is CardId => Boolean(id && target.zones.hand.includes(id)))
    if (!revealed.length) return
    host.dispatch('CardMove', { playerId: target.id, cardIds: revealed, reason: GUOHUAI_YIDU, revealed: true }, { sourceId: ownerId, targetId: target.id, cardIds: revealed })
    if (!revealed.every((id) => effectiveCardColor(host.state, target.id, id) === effectiveCardColor(host.state, target.id, revealed[0]!))) return
    const discarded: CardId[] = []
    for (const id of revealed) if (target.zones.hand.includes(id) && !isCardProtectedFromDiscard(host.state, target.id, id, ownerId)) {
      moveCard(host.state, id, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
      discarded.push(id)
    }
    if (discarded.length) host.dispatch('LoseCard', { playerId: target.id, cardIds: discarded, reason: GUOHUAI_YIDU }, { sourceId: ownerId, targetId: target.id, cardIds: discarded })
  },
})

registerSkillRuntime({ id: DENGZHONG_KANPO,
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || turnUsageUsed(state, ownerId, DENGZHONG_KANPO)) return []
    return owner.zones.hand.filter((id) => state.cards[id]?.name !== '杀').map((cardId) => ({ asCardName: '杀', cardId, label: `【勘破】：将【${state.cards[cardId]?.name}】当【杀】使用` }))
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardName?: string; sourceSkillId?: string }
      if (payload.cardName === '杀' && context.event.sourceSkillId === DENGZHONG_KANPO) markTurnUsage(host.state, ownerId, DENGZHONG_KANPO)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId | null; cardName?: string | null; finalAmount?: number }
      const cardId = payload.cardId
      const targetId = context.event.targetId
      const card = cardId ? host.state.cards[cardId] : undefined
      if (payload.cardName !== '杀' || (payload.finalAmount ?? 0) <= 0 || !cardId || !card || !targetId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const matching = target.zones.hand.filter((id) => effectiveCardSuit(host.state, targetId, id) === effectiveCardSuit(host.state, ownerId, cardId))
      if (!matching.length) return
      host.queueSkill({ skillId: DENGZHONG_KANPO, ownerId, step: 'gain-matching', data: { targetId, cardId, matching } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.skillId === DENGZHONG_KANPO && prompt.step === 'gain-matching') {
      const data = prompt.data as { targetId: PlayerId; cardId: CardId; matching: CardId[] }
      const target = playerOf(host.state, data.targetId)
      const ids = data.matching.filter((id) => target?.zones.hand.includes(id))
      if (!target?.alive || !ids.length) return
      host.dispatch('CardMove', { playerId: target.id, cardIds: [...target.zones.hand], reason: DENGZHONG_KANPO, revealed: true }, { sourceId: ownerId, targetId: target.id, cardIds: [...target.zones.hand] })
      host.askSkill({ skillId: DENGZHONG_KANPO, ownerId, step: 'gain-matching', data: { targetId: target.id, ids }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【勘破】：获得一张与此【杀】花色相同的手牌', timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: 0, max: 1,
      }) })
      return
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.skillId === DENGZHONG_KANPO && resolution.step === 'gain-matching') {
      const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const data = resolution.data as { targetId: PlayerId; ids: CardId[] }
      const target = playerOf(host.state, data.targetId)
      if (id && data.ids.includes(id) && target?.zones.hand.includes(id)) giveCards(host as never, target.id, ownerId, [id], DENGZHONG_KANPO)
      return
    }
  },
})

registerSkillRuntime({ id: DENGZHONG_GENGZHAN,
  globalSlashUses(state, ownerId, targetId) {
    return targetId === ownerId ? (state as Batch61State).b61DengzhongSlashBonus?.[ownerId] ?? 0 : 0
  },
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const bonus = (host.state as Batch61State).b61DengzhongSlashBonus
      if (bonus) bonus[ownerId] = 0
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const playerId = payload.playerId
      if (!playerId || playerId === ownerId || payload.phase !== 'finish') return
      const usedSlash = host.state.cardUseHistory?.some((entry) => entry.turnNumber === host.state.turnNumber && entry.sourceId === playerId && entry.cardName === '杀')
      if (!usedSlash) {
        const bonus = (host.state as Batch61State).b61DengzhongSlashBonus ??= {}
        bonus[ownerId] = (bonus[ownerId] ?? 0) + 1
      }
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; reason?: string }
      const phaseOwner = host.state.currentPlayerId
      if (host.state.phase !== 'play' || phaseOwner === ownerId || context.event.sourceId === ownerId
        || payload.reason !== 'discard' || !payload.cardId || host.state.cards[payload.cardId]?.name !== '杀'
        || phaseUsageUsed(host.state, ownerId, `${DENGZHONG_GENGZHAN}:${phaseOwner}`)) return
      host.queueSkill({ skillId: DENGZHONG_GENGZHAN, ownerId, step: 'take-slash', data: { cardId: payload.cardId, phaseOwner } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'take-slash') return
    const data = prompt.data as { cardId: CardId; phaseOwner: PlayerId }
    if (!host.state.zones.discardPile.includes(data.cardId)) return
    host.askSkill({ skillId: DENGZHONG_GENGZHAN, ownerId, step: 'take-slash', data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【更战】：获得刚被弃置的【杀】？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '获得【杀】' }, { id: 'no', label: '不获得' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'take-slash') return
    const data = resolution.data as { cardId: CardId; phaseOwner: PlayerId }
    if ((response.payload as { optionId?: string }).optionId === 'yes' && host.state.zones.discardPile.includes(data.cardId)) {
      moveCard(host.state, data.cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [data.cardId], reason: DENGZHONG_GENGZHAN }, { sourceId: ownerId, targetId: ownerId, cardIds: [data.cardId] })
      markPhaseUsage(host.state, ownerId, `${DENGZHONG_GENGZHAN}:${data.phaseOwner}`)
    }
  },
})

registerSkillRuntime({ id: SUNHONG_XIANBI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, SUNHONG_XIANBI)) return []
    const forbidden = (state as Batch61State).b61SunhongForbiddenTargets?.[ownerId] ?? []
    const availableDiscards = owner.zones.hand.filter((id) => !isCardProtectedFromDiscard(state, ownerId, id, ownerId)).length
    const candidates = state.players.filter((target) => target.alive && !forbidden.includes(target.id)
      && (target.zones.hand.length <= equipmentCount(state, target.id)
        || availableDiscards >= target.zones.hand.length - equipmentCount(state, target.id)))
    return candidates.length ? [{ id: SUNHONG_XIANBI, label: '【险诐】：将手牌数调整为一名角色的装备数' }] : []
  },
  invokeActive(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const candidateIds = host.state.players.filter((target) => target.alive
      && !(host.state as Batch61State).b61SunhongForbiddenTargets?.[ownerId]?.includes(target.id)
      && (target.zones.hand.length <= equipmentCount(host.state, target.id)
      || target.zones.hand.length > equipmentCount(host.state, target.id)
        && owner.zones.hand.filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId)).length >= target.zones.hand.length - equipmentCount(host.state, target.id))).map((target) => target.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: SUNHONG_XIANBI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【险诐】：选择一名角色，以其装备牌数调整你的手牌数', timeoutMs: 25_000,
      optional: true, candidateIds, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner || !target?.alive || (host.state as Batch61State).b61SunhongForbiddenTargets?.[ownerId]?.includes(target.id)) return
      const count = equipmentCount(host.state, target.id)
      const discardCount = Math.max(0, owner.zones.hand.length - count)
      const candidates = owner.zones.hand.filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      if (discardCount > candidates.length) return
      markUsedThisPhase(host.state, ownerId, SUNHONG_XIANBI)
      if (!discardCount) {
        drawCards(host.state, host.rng, ownerId, count - owner.zones.hand.length, (name, data) => host.dispatch(name, data))
        return
      }
      host.askSkill({ skillId: SUNHONG_XIANBI, ownerId, step: 'discard', data: { count, discardCount }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【险诐】：弃置${discardCount}张手牌，将手牌数调整至${count}`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: discardCount, max: discardCount,
      }) })
      return
    }
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const data = resolution.data as { discardCount: number }
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const discarded: CardId[] = []
    for (const cardId of [...new Set(selected)].slice(0, data.discardCount)) {
      if (!owner.zones.hand.includes(cardId) || isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId)) continue
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      discarded.push(cardId)
      const category = host.state.cards[cardId]?.category
      const replacements = host.state.zones.discardPile.filter((otherId) => otherId !== cardId && host.state.cards[otherId]?.category === category)
      const gained = replacements.length ? host.rng.pick(replacements) : undefined
      if (gained && host.state.zones.discardPile.includes(gained)) {
        moveCard(host.state, gained, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [gained], reason: SUNHONG_XIANBI }, { sourceId: ownerId, targetId: ownerId, cardIds: [gained] })
      }
    }
    if (discarded.length) host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: SUNHONG_XIANBI }, { sourceId: ownerId, targetId: ownerId, cardIds: discarded })
  },
})

registerSkillRuntime({ id: WANGGUAN_MIAOYAN,
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || (state as Batch61State).b61WangguanDisabledRound?.[ownerId] === state.roundNumber) return []
    return owner.zones.hand.filter((id) => state.cards[id]?.color === 'black')
      .map((cardId) => ({ asCardName: '火攻', cardId, label: `【谬焰】：将【${state.cards[cardId]?.name}】当【火攻】使用` }))
  },
  triggers: [
    { event: 'CardMove', handle(host, _ownerId, context) {
      const payload = context.event.payload as { revealed?: boolean; playerId?: PlayerId; cardIds?: CardId[] }
      if (!payload.revealed || !payload.playerId || !Array.isArray(payload.cardIds)) return
      const data = host.state as Batch61State
      data.b61WangguanShown = (data.b61WangguanShown ?? []).filter((entry) => entry.turnNumber === host.state.turnNumber && entry.phase === host.state.phase)
      for (const cardId of payload.cardIds) {
        if (!playerOf(host.state, payload.playerId)?.zones.hand.includes(cardId)) continue
        data.b61WangguanShown.push({ turnNumber: host.state.turnNumber, phase: host.state.phase, cardId, ownerId: payload.playerId })
      }
      data.b61WangguanShown = data.b61WangguanShown.filter((entry, index, all) => all.findIndex((candidate) => candidate.turnNumber === entry.turnNumber
        && candidate.phase === entry.phase && candidate.cardId === entry.cardId && candidate.ownerId === entry.ownerId) === index)
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== WANGGUAN_MIAOYAN || payload.cardName !== '火攻' || !payload.cardId) return
      if ((host.state as Batch61State).b61WangguanDisabledRound?.[ownerId] === host.state.roundNumber) return
      const state = host.state as Batch61State
      state.b61WangguanUses ??= {}
      state.b61WangguanUses[payload.cardId] = { side: conversionStateOf(host.state, ownerId, WANGGUAN_MIAOYAN), roundNumber: host.state.roundNumber }
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const cardId = payload.cardId
      if (context.event.sourceId !== ownerId || payload.cardName !== '火攻' || !cardId) return
      const state = host.state as Batch61State
      const used = state.b61WangguanUses?.[cardId]
      if (!used) return
      delete state.b61WangguanUses?.[cardId]
      if (used.side === 'yang' && cardDamageDealt(host.state, cardId) > 0) {
        const shown = (state.b61WangguanShown ?? []).filter((entry) => entry.turnNumber === host.state.turnNumber && entry.phase === host.state.phase)
        const cardsByPlayer = new Map<PlayerId, CardId[]>()
        for (const entry of shown) {
          if (!playerOf(host.state, entry.ownerId)?.zones.hand.includes(entry.cardId)) continue
          cardsByPlayer.set(entry.ownerId, [...(cardsByPlayer.get(entry.ownerId) ?? []), entry.cardId])
        }
        for (const [fromId, cardIds] of cardsByPlayer) if (fromId !== ownerId && playerOf(host.state, fromId)?.alive)
          giveCards(host as never, fromId, ownerId, cardIds, WANGGUAN_MIAOYAN)
      }
      if (used.side === 'yin' && cardDamageDealt(host.state, cardId) === 0) {
        const disabled = state.b61WangguanDisabledRound ??= {}
        disabled[ownerId] = used.roundNumber
      }
      toggleConversionState(host.state, ownerId, WANGGUAN_MIAOYAN)
    } },
  ],
})

registerSkillRuntime({ id: ZHANGZHI_XIMO,
  triggers: [{ event: 'SkillActivated', handle(host, ownerId, context) {
    const payload = context.event.payload as { skillId?: string }
    if (context.event.sourceId !== ownerId || payload.skillId !== ZHANGZHI_BIXIN) return
    const activations = ((host.state as Batch61State).b61ZhangzhiBixinActivations ??= {})
    activations[ownerId] = (activations[ownerId] ?? 0) + 1
    const state = host.state as Batch61State
    const previous = state.b61ZhangzhiBixinDescription?.[ownerId] ?? ZHANGZHI_BIXIN_INITIAL_DESCRIPTION
    let description = Array.from(previous).slice(5).join('')
    if (activations[ownerId] === 3) {
      description = description.replace('摸3张牌（每种类型限1次）', '摸1张牌（每种类型限3次）')
    }
    ;(state.b61ZhangzhiBixinDescription ??= {})[ownerId] = description
    if (activations[ownerId] !== 3) return
    replaceTemporarySkill(host.state, ownerId, ZHANGZHI_XIMO, ZHANGZHI_FEIBAI)
    suppressSkill(host.state, {
      targetId: ownerId, skillId: ZHANGZHI_XIMO, sourceId: ownerId, sourceSkillId: ZHANGZHI_XIMO,
      armedAtTurn: Number.MAX_SAFE_INTEGER,
    })
  } }],
})

registerSkillRuntime({ id: ZHANGZHI_FEIBAI,
  outgoingDamage(state, ownerId, context) {
    if (conversionStateOf(state, ownerId, ZHANGZHI_FEIBAI) !== 'yang' || !context.cardId
      || effectiveCardColor(state, ownerId, context.cardId) === 'black') return null
    return { amount: context.amount + 1 }
  },
  recoverAmountBonus(state, ownerId, sourceId, sourceCardId) {
    if (sourceId !== ownerId || conversionStateOf(state, ownerId, ZHANGZHI_FEIBAI) !== 'yin' || !sourceCardId
      || effectiveCardColor(state, ownerId, sourceCardId) === 'red') return 0
    return 1
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId | null; finalAmount?: number }
      if (context.event.sourceId !== ownerId || conversionStateOf(host.state, ownerId, ZHANGZHI_FEIBAI) !== 'yang'
        || !payload.cardId || (payload.finalAmount ?? 0) <= 0 || effectiveCardColor(host.state, ownerId, payload.cardId) === 'black') return
      toggleConversionState(host.state, ownerId, ZHANGZHI_FEIBAI)
    } },
    { event: 'Recover', handle(host, ownerId, context) {
      const payload = context.event.payload as { amount?: number }
      const cardId = context.event.cardIds?.[0]
      if (context.event.sourceId !== ownerId || conversionStateOf(host.state, ownerId, ZHANGZHI_FEIBAI) !== 'yin'
        || !cardId || (payload.amount ?? 0) <= 0 || effectiveCardColor(host.state, ownerId, cardId) === 'red') return
      toggleConversionState(host.state, ownerId, ZHANGZHI_FEIBAI)
    } },
  ],
})

registerSkillRuntime({ id: WANGGUAN_SHILU,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { finalAmount?: number }
    if (context.event.targetId !== ownerId || (payload.finalAmount ?? 0) <= 0 || !playerOf(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: WANGGUAN_SHILU, ownerId, step: 'draw-and-target', data: { amount: playerOf(host.state, ownerId)!.hp } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw-and-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const amount = (prompt.data as { amount?: number }).amount ?? owner.hp
    drawCards(host.state, host.rng, ownerId, amount, (name, data) => host.dispatch(name, data))
    const candidateIds = host.state.players.filter((target) => target.alive && target.id !== ownerId && target.zones.hand.length > 0
      && getDistance(host.state, ownerId, target.id) <= getAttackRange(host.state, ownerId)).map((target) => target.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: WANGGUAN_SHILU, ownerId, step: 'choose-target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【失路】：选择攻击范围内一名有手牌的其他角色', timeoutMs: 25_000,
      optional: false, candidateIds, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive || !target.zones.hand.length) return
    const slots = target.zones.hand.map((_, index) => hiddenHandSlot(target.id, index))
    host.askSkill({ skillId: WANGGUAN_SHILU, ownerId, step: 'choose-hand-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【失路】：选择并展示其一张手牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots: slots, min: 1, max: 1,
    }) })
    return
    }
    if (resolution.step !== 'choose-hand-card') return
    const targetId = (resolution.data as { targetId: PlayerId }).targetId
    const target = playerOf(host.state, targetId)
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected && target?.alive ? resolvePickedCard(host.state, target.id, selected) : null
    if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)
      || getDistance(host.state, ownerId, target.id) > getAttackRange(host.state, ownerId)) return
    host.dispatch('CardMove', { playerId: target.id, cardIds: [cardId], reason: WANGGUAN_SHILU, revealed: true }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
    host.beginSkillSlashFromOtherHand({ sourceId: ownerId, physicalOwnerId: target.id, cardId, targetId: target.id, sourceSkillId: WANGGUAN_SHILU })
  },
})

export const RUIJIE_B61: CharacterDefinition = {
  id: 'ruijie-b61', name: '芮姬', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: RUIJIE_QIAOLI, name: '巧力', description: '出牌阶段各限一次：你可以将一张武器牌当【决斗】使用，此牌对目标角色造成伤害后，你摸与其攻击范围等量的牌，然后可以分配其中任意张牌；或将一张非武器装备牌当不可被响应的【决斗】使用，然后于结束阶段随机获得一张装备牌。' },
    { id: RUIJIE_QINGLIANG, name: '清靓', description: '每回合限一次，当你成为其他角色使用的【杀】或伤害锦囊牌的唯一目标时，你可以展示所有手牌并选择一项：1.你与其各摸一张牌；2.弃置一种花色的所有手牌，取消此目标。' },
  ],
}

export const SP_MENGHUO_B61: CharacterDefinition = {
  id: 'sp-menghuo-b61', name: 'SP·孟获', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MENGHUO_MANWANG, name: '蛮王', description: '出牌阶段，你可以弃置任意张牌依次执行前等量项：1.获得“叛侵”；2.摸一张牌；3.回复1点体力；4.摸两张牌并失去“叛侵”。' },
    { id: MENGHUO_PANQIN, name: '叛侵', description: '出牌阶段结束时和弃牌阶段结束时，你可以将弃牌堆中你于此阶段弃置的牌当【南蛮入侵】使用；当此牌指定目标后，若目标数不小于转化牌数，你执行并移除“蛮王”的最后一项，然后加1点体力上限并回复1点体力。', granted: true },
  ],
}

export const GUO_HUAI_B61: CharacterDefinition = {
  id: 'guo-huai-b61', name: '郭槐', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: GUOHUAI_ZHEFU, name: '哲妇', description: '当你于回合外使用或打出牌后，你可以令一名有手牌的其他角色选择弃置一张同名牌或受到1点伤害。' },
    { id: GUOHUAI_YIDU, name: '遗毒', description: '当你使用【杀】或伤害锦囊牌后，你可以展示一名未受到此牌伤害的目标角色至多三张手牌，若颜色皆相同，你弃置这些牌。' },
  ],
}

export const DENG_ZHONG_B61: CharacterDefinition = {
  id: 'deng-zhong-b61', name: '邓忠', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: DENGZHONG_KANPO, name: '勘破', description: '当你使用【杀】对目标角色造成伤害后，你可以观看其手牌并获得其中一张与此【杀】花色相同的牌。每回合限一次，你可以将一张手牌当【杀】使用。' },
    { id: DENGZHONG_GENGZHAN, name: '更战', description: '其他角色出牌阶段限一次，当一张【杀】因弃置置入弃牌堆后，你可以获得之。其他角色的结束阶段，若其本回合未使用过【杀】，你下个出牌阶段使用【杀】的限制次数+1。' },
  ],
}

export const SUN_HONG_B61: CharacterDefinition = {
  id: 'sun-hong-b61', name: '孙弘', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: SUNHONG_XIANBI, name: '险诐', description: '出牌阶段限一次，你可以将手牌调整至与一名角色装备区里的牌数相同，每因此弃置一张牌，便随机获得弃牌堆中另一张类型相同的牌。' },
    { id: SUNHONG_ZANRUN, name: '谮润', description: '每阶段限一次，当你摸牌时，你可以改为获得一名其他角色等量张牌，然后其选择一项：1.摸等量张牌；2.你不能再对其发动武将牌上的技能。' },
  ],
}

export const WANG_GUAN_B61: CharacterDefinition = {
  id: 'wang-guan-b61', name: '王瓘', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: WANGGUAN_MIAOYAN, name: '谬焰', description: '转换技，阳：你可以将一张黑色牌当【火攻】使用，若此牌造成伤害，你获得本阶段展示过的所有手牌；阴：你可以将一张黑色牌当【火攻】使用，若此牌未造成伤害，本轮本技能失效。' },
    { id: WANGGUAN_SHILU, name: '失路', description: '锁定技，当你受到伤害后，你摸与你体力值等量张牌并展示攻击范围内一名其他角色一张手牌，令此牌视为【杀】。' },
  ],
}

export const ZHANG_ZHI_B61: CharacterDefinition = {
  id: 'zhang-zhi-b61', name: '张芝', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANGZHI_BIXIN, name: '笔心', description: '每名角色的准备阶段和结束阶段，你可以声明一种牌的类型并摸3张牌（每种类型限1次），将所有此类型手牌当你本轮未使用过的基本牌使用。' },
    { id: ZHANGZHI_XIMO, name: '洗墨', description: '锁定技，当你发动“笔心”后，移除其描述的前五个字符，若为第三次发动，交换其描述中的两个数字，你失去本技能并获得“飞白”。' },
    { id: ZHANGZHI_FEIBAI, name: '飞白', description: '转换技，锁定技，阳：当你的非黑色牌造成伤害时，此伤害值+1；阴：当你的非红色牌回复体力时，此回复值+1。', granted: true },
  ],
}

export const AHUI_NAN_B61: CharacterDefinition = {
  id: 'ahui-nan-b61', name: '阿会喃', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: AHUINAN_JUEMAN, name: '蟨蛮', description: '锁定技，每回合结束时，若本回合前两张基本牌的使用者均不为你，你视为使用本回合第三张使用的基本牌；若仅其中之一为你，你摸一张牌。' },
  ],
}

export const QU_HUANG_B61: CharacterDefinition = {
  id: 'qu-huang-b61', name: '屈晃', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: QUHUANG_QIEJIAN, name: '切谏', description: '当一名角色失去最后的手牌后，你可以与其各摸一张牌，然后选择一项：弃置你或其场上一张牌；或本轮不能再对其发动此技能。' },
    { id: QUHUANG_NISHOU, name: '泥首', description: '锁定技，当你装备区里的牌进入弃牌堆后，你将之当【闪电】使用，或于此阶段结束时与手牌数最少的角色交换手牌。' },
  ],
}

export const HAO_PU_B61: CharacterDefinition = {
  id: 'hao-pu-b61', name: '郝普', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: HAOPU_ZHENYING, name: '镇荧', description: '出牌阶段限两次，你可以与一名手牌数不大于你的其他角色同时将手牌数调整至至多两张，然后其中手牌数较少的角色视为对另一名角色使用一张【决斗】。' },
  ],
}

export const HISTORICAL_BATCH61_CHARACTERS: readonly CharacterDefinition[] = [
  RUIJIE_B61, SP_MENGHUO_B61, GUO_HUAI_B61, DENG_ZHONG_B61, ZHANG_ZHI_B61,
  AHUI_NAN_B61, QU_HUANG_B61, SUN_HONG_B61, WANG_GUAN_B61, HAO_PU_B61,
]
