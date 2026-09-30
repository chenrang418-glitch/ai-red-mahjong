import type { CharacterDefinition } from './types'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import { effectiveCardColor, grantSkill, isCardProtectedFromDiscard, isTargetProhibited, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { moveCard, locateOwnedCard, setCardAlias } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { replaceTemporarySkill } from '../../engine/skills/runtime'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import { getDistance } from '../../engine/distance'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { hiddenHandSlot } from '../../engine/cards/host'
import { getAttackRange } from '../../engine/distance'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { discardCardsByIds } from '../../engine/discard-all'
import { resolveDamage, resumeTargetDamagePrevention } from '../../engine/damage'
import { revealTopCards } from '../../engine/draw'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { registerGroupCardDecision, startGroupCardDecision } from '../../engine/group-card-decision'
import { executeUseCardAction, legalPlayActions } from '../../engine/cards/basic'
import { beginVirtualSlash as beginVirtualSlashWithRules } from '../../engine/cards/basic'
import type { LegalAction } from '../../engine/actions'
import type { VirtualSlashUseContext } from '../../engine/skills/runtime'
import { isSoleTargetOf } from '../../engine/card-use-targets'
import { giveCards } from '../../engine/hand-transfer'
import { handleEquipmentLost } from '../../engine/equipment'
import { skillIdsOf } from './standard'

const B56 = ':b56'
const sid = (id: string) => `${id}${B56}`
const LB_WUSHUANG = sid('wushuang-mou-lvbu')
const LB_LIYU = sid('liyu-mou-lvbu')
const WY_ZHUANGSHI = sid('zhuangshi-shi-weiyan')
const WY_YINZHAN = sid('yinzhan-shi-weiyan')
const WY_ZHONGAO = sid('zhongao-shi-weiyan')
const WY_KUANGGU = sid('kuanggu-shi-weiyan')
const WY_KUNFEN = sid('kunfen-shi-weiyan')
const SS_GANJUE = sid('ganjue-sunshao')
const SS_ZHUJI = sid('zhuji-sunshao')
const CD_WANGLIE = sid('wanglie-shi-chendao')
const CD_HONGYI = sid('hongyi-shi-chendao')
const LY_RUNWEI = sid('runwei-shi-luyusheng')
const LY_SHUANGHUAI = sid('shuanghuai-shi-luyusheng')
const ZY_FEIJING = sid('feijing-shi-zhangyan')
const ZY_XIAOGE = sid('xiaoge-shi-zhangyan')
const TF_GANGGENG = sid('ganggeng-shi-tianfeng')
const TF_SIJIAN = sid('sijian-shi-tianfeng')
const LJ_CUIJIN = sid('cuijin-lejiu')
const GY_QINGDAO = sid('qingdao-shi-guoyuan')
const GY_XIUGENG = sid('xiugeng-shi-guoyuan')
const GY_CHENSHE = sid('chenshe-shi-guoyuan')
const CC_LINGFA = sid('lingfa-sp-caocao')
const CC_ZHIAN = sid('zhian-sp-caocao')
const CC_JIANXIONG = sid('jianxiong-sp-caocao')

const CD_YI_MARK = 'b56-chendao-yi'

type B56State = SanguoshaState & {
  b56LiyuDamage?: Record<CardId, { ownerId: PlayerId; targets: Record<PlayerId, number> }>
  b56LiyuTemp?: Record<PlayerId, { ownerId: PlayerId; source: string; started: boolean }>
  b56LubuResponses?: Record<CardId, Record<PlayerId, true>>
  b56Weiyan?: Record<PlayerId, { discarded: number; hpLost: number; usedCards: number; stage: number; failed: boolean; awakened: boolean; phaseId?: number; backwaterUses?: number; activeFlags?: { ignoreDistance: boolean; unresponsive: boolean; ignoreSlashCount: boolean }; armedCards?: Record<CardId, { ignoreDistance: boolean; unresponsive: boolean; ignoreSlashCount: boolean }> }>
  b56WeiyanDamage?: Record<CardId, Record<PlayerId, { hpCondition: boolean; handCondition: boolean }>>
  b56Chendao?: Record<PlayerId, { yi: number; prepareChoice?: 'draw' | 'clear'; finishChoice?: 'draw' | 'clear'; armedCard?: CardId; locked?: boolean }>
  b56LuRunwei?: Record<PlayerId, { phaseId: number; useCount: number; repeatRequired: number; lostSinceFirst: number; repeatUnlocked: boolean; gainedHands: CardId[] }>
  b56LuGainedThisTurn?: Record<PlayerId, PlayerId[]>
  b56LuShuanghuaiLast?: Record<PlayerId, PlayerId | null>
  b56Zhangyan?: Record<CardId, { ownerId: PlayerId; extras: Record<PlayerId, CardId>; preventedTargets?: Record<PlayerId, true>; initialTargetId?: PlayerId }>
  b56ZhangyanUseCount?: Record<PlayerId, { turnNumber: number; count: number }>
  b56Tianfeng?: Record<PlayerId, { givenTo?: PlayerId; eventUses: number; backfireCount: number; pendingCardUser?: PlayerId; turnNumber?: number }>
  b56TianfengGiven?: Record<PlayerId, { targetId: PlayerId; turnNumber: number }>
  b56SijianTargets?: Record<PlayerId, Array<{ targetId: PlayerId; ownerId: PlayerId }>>
  b56Caocao?: { roundEffect?: 'slash' | 'peach'; roundEffectRound?: number; turns: Record<PlayerId, number>; zhiAnTurn?: number }
  b56CaocaoPendingSlash?:
    | { kind: 'play'; actorId: PlayerId; action: Extract<LegalAction, { kind: 'use-card' }> }
    | { kind: 'virtual'; actorId: PlayerId; context: VirtualSlashUseContext }
  b56CaocaoVirtualBypass?: VirtualSlashUseContext
  b56Ganjue?: Record<PlayerId, { cardId: CardId }>
  b56LejiuPending?: Record<CardId, Record<PlayerId, PlayerId>>
  b56LejiuSeen?: Record<CardId, PlayerId[]>
  b56Guoyuan?: Record<PlayerId, { ownerId: PlayerId; snapshot: number; source: string; limitTurn?: number }>
  b56GuoyuanDamageCards?: Record<CardId, { ownerId: PlayerId; sourceId: PlayerId; damaged: boolean }>
  b56GuoyuanNoDistance?: Record<PlayerId, { cardId: CardId; turnNumber: number }>
}

const character = (id: string, name: string, kingdom: CharacterDefinition['kingdom'], gender: CharacterDefinition['gender'], maxHp: number, skills: CharacterDefinition['skills']): CharacterDefinition => ({ id, name, kingdom, gender, maxHp, pack: 'sp', skills })

function ccGiveableHand(host: SkillHost, playerId: PlayerId): CardId[] {
  const player = host.state.players.find((item) => item.id === playerId && item.alive)
  return player ? [...player.zones.hand] : []
}

function ccSlashModeActive(state: SanguoshaState): boolean {
  const data = (state as B56State).b56Caocao
  return data?.roundEffect === 'slash' && data.roundEffectRound === state.roundNumber
}

function ccPeachModeActive(state: SanguoshaState): boolean {
  const data = (state as B56State).b56Caocao
  return data?.roundEffect === 'peach' && data.roundEffectRound === state.roundNumber
}

function ccContinuePendingSlash(host: SkillHost): void {
  const state = host.state as B56State
  const pending = state.b56CaocaoPendingSlash
  if (!pending || host.state.dying || host.state.pendingSourceDamage || host.state.pendingTargetDamage || host.state.pendingDamageModifier) return
  delete state.b56CaocaoPendingSlash
  const actor = host.state.players.find((item) => item.id === pending.actorId && item.alive)
  if (!actor) return
  if (pending.kind === 'play') {
    executeUseCardAction(host as never, pending.actorId, pending.action, { skipPlayInterceptors: true })
    return
  }
  state.b56CaocaoVirtualBypass = pending.context
  beginVirtualSlashWithRules(host as never, pending.context)
}

type CCFieldCard = { playerId: PlayerId; kind: 'equipment'; slot: EquipmentSlot }
  | { playerId: PlayerId; kind: 'judgingArea' }

function ccLocateFieldCard(state: SanguoshaState, cardId: CardId): CCFieldCard | null {
  for (const player of state.players) {
    const equipment = Object.entries(player.zones.equipment).find(([, equippedId]) => equippedId === cardId)
    if (equipment) return { playerId: player.id, kind: 'equipment', slot: equipment[0] as EquipmentSlot }
    if (player.zones.judgingArea.includes(cardId)) return { playerId: player.id, kind: 'judgingArea' }
  }
  return null
}

function ccMoveFieldCard(host: SkillHost, ownerId: PlayerId, cardId: CardId, destination: 'discard' | 'gain'): boolean {
  const field = ccLocateFieldCard(host.state, cardId)
  if (!field) return false
  if (destination === 'discard' && isCardProtectedFromDiscard(host.state, field.playerId, cardId, ownerId)) return false
  if (field.kind === 'equipment') {
    moveCard(host.state, cardId, { kind: 'equipment', playerId: field.playerId, slot: field.slot },
      destination === 'discard' ? { kind: 'discardPile' } : { kind: 'hand', playerId: ownerId })
    handleEquipmentLost(host as never, field.playerId, cardId)
  } else {
    moveCard(host.state, cardId, { kind: 'judgingArea', playerId: field.playerId },
      destination === 'discard' ? { kind: 'discardPile' } : { kind: 'hand', playerId: ownerId })
  }
  host.dispatch('LoseCard', { playerId: field.playerId, cardIds: [cardId], reason: CC_ZHIAN },
    { sourceId: ownerId, targetId: field.playerId, cardIds: [cardId] })
  if (destination === 'gain') host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CC_ZHIAN },
    { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  return true
}

function ccDamageForRefusal(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, pending?: NonNullable<B56State['b56CaocaoPendingSlash']>): void {
  const state = host.state as B56State
  if (pending) state.b56CaocaoPendingSlash = pending
  const target = host.state.players.find((item) => item.id === targetId && item.alive)
  if (target) resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '令法' })
  if (!pending) return
  if (host.state.dying || host.state.pendingSourceDamage || host.state.pendingTargetDamage || host.state.pendingDamageModifier) return
  ccContinuePendingSlash(host)
}

function ccSlashContinuationMatches(left: VirtualSlashUseContext, right: VirtualSlashUseContext): boolean {
  const sameIds = (a?: string[], b?: string[]) => (a ?? []).length === (b ?? []).length
    && (a ?? []).every((id, index) => id === (b ?? [])[index])
  return left.sourceId === right.sourceId && left.sourceSkillId === right.sourceSkillId && left.cardId === right.cardId
    && left.nature === right.nature && left.countUsage === right.countUsage && left.maxTargets === right.maxTargets
    && left.damageBonus === right.damageBonus && sameIds(left.targetIds, right.targetIds)
    && sameIds(left.noDodgeTargetIds, right.noDodgeTargetIds)
    && sameIds(left.responseDiscardCostTargetIds, right.responseDiscardCostTargetIds)
}

function askCCSlashPayment(host: SkillHost, ownerId: PlayerId, continuation: NonNullable<B56State['b56CaocaoPendingSlash']>): void {
  const actorId = continuation.actorId
  const actor = host.state.players.find((item) => item.id === actorId && item.alive)
  if (!actor) return
  const excluded = continuation.kind === 'play' ? continuation.action.cardIds : continuation.context.cardId ? [continuation.context.cardId] : []
  const cards = [...new Set([...actor.zones.hand, ...Object.values(actor.zones.equipment).filter((id): id is CardId => Boolean(id))])]
    .filter((cardId) => !excluded.includes(cardId) && !isCardProtectedFromDiscard(host.state, actorId, cardId, ownerId))
  if (!cards.length) {
    host.askSkill({ skillId: CC_LINGFA, ownerId, step: 'slash-refusal', data: { continuation }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: actorId, prompt: '【令法】：你没有可弃置的牌，受到SP·曹操造成的1点伤害后继续使用【杀】',
      timeoutMs: 25_000, optional: false, options: [{ id: 'continue', label: '受到伤害并继续' }],
    }) })
    return
  }
  host.askSkill({ skillId: CC_LINGFA, ownerId, step: 'slash-choice', data: { continuation }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: actorId, prompt: '【令法】：弃置一张牌后使用【杀】，或不执行并受到SP·曹操造成的1点伤害',
    timeoutMs: 25_000, optional: false,
    options: [{ id: 'pay', label: '弃置一张牌并使用【杀】' }, { id: 'refuse', label: '不执行，受到1点伤害' }],
  }) })
}

function ccUseVirtualSlash(host: SkillHost, state: B56State, continuation: Extract<NonNullable<B56State['b56CaocaoPendingSlash']>, { kind: 'virtual' }>): boolean {
  state.b56CaocaoVirtualBypass = continuation.context
  const started = beginVirtualSlashWithRules(host as never, continuation.context)
  if (!started) delete state.b56CaocaoVirtualBypass
  return started
}

function askCCPeachPayment(host: SkillHost, ownerId: PlayerId, userId: PlayerId): void {
  const user = host.state.players.find((item) => item.id === userId && item.alive)
  if (!user || !ccPeachModeActive(host.state)) return
  if (!user.zones.hand.length) { resolveDamage(host as never, { sourceId: ownerId, targetId: userId, amount: 1, nature: 'normal', cardName: '令法' }); return }
  host.askSkill({ skillId: CC_LINGFA, ownerId, step: 'peach-payment', data: { userId }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: userId, prompt: '【令法】：交给SP·曹操一张手牌，或受到其造成的1点伤害',
    timeoutMs: 25_000, optional: false,
    options: [{ id: 'give', label: '交给其一张手牌' }, { id: 'refuse', label: '不执行，受到1点伤害' }],
  }) })
}

function askCCZhiAn(host: SkillHost, ownerId: PlayerId, cardId: CardId, userId: PlayerId): void {
  const state = host.state as B56State
  const field = ccLocateFieldCard(host.state, cardId)
  const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
  if (!owner || !field || state.b56Caocao?.zhiAnTurn === host.state.turnNumber) return
  const options: ChooseOptionRequest['options'] = []
  if (!isCardProtectedFromDiscard(host.state, field.playerId, cardId, ownerId)) options.push({ id: 'discard', label: '弃置此牌' })
  if (owner.zones.hand.some((handCardId) => !isCardProtectedFromDiscard(host.state, ownerId, handCardId, ownerId)))
    options.push({ id: 'gain', label: '弃置一张手牌并获得此牌' })
  options.push({ id: 'damage', label: '对使用者造成1点伤害' })
  host.askSkill({ skillId: CC_ZHIAN, ownerId, step: 'choice', data: { cardId, userId, fieldPlayerId: field.playerId }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【治暗】：处理${host.state.cards[cardId]?.name ?? '此牌'}`,
    timeoutMs: 25_000, optional: true, options: [...options, { id: 'decline', label: '不发动' }],
  }) })
}

registerSkillRuntime({ id: CC_LINGFA,
  interceptPlayAction(host, ownerId, action) {
    if (action.asCardName !== '杀' || action.playerId === ownerId || !ccSlashModeActive(host.state)) return false
    const state = host.state as B56State
    if (state.b56CaocaoPendingSlash) return false
    askCCSlashPayment(host, ownerId, { kind: 'play', actorId: action.playerId, action })
    return true
  },
  interceptVirtualSlash(host, ownerId, context) {
    const state = host.state as B56State
    if (context.sourceId === ownerId || !ccSlashModeActive(host.state)) return false
    if (state.b56CaocaoVirtualBypass && ccSlashContinuationMatches(state.b56CaocaoVirtualBypass, context)) {
      delete state.b56CaocaoVirtualBypass
      return false
    }
    if (state.b56CaocaoPendingSlash) return false
    askCCSlashPayment(host, ownerId, { kind: 'virtual', actorId: context.sourceId, context })
    return true
  },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId, context) {
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'sp-caocao-b56')
      const round = Number((context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber)
      if (!owner || (host.state as B56State).b56Caocao?.roundEffectRound === round
        || owner.permanentlyLostSkills?.includes(CC_LINGFA)) return
      const state = host.state as B56State
      state.b56Caocao ??= { turns: {} }
      if (round > 2) {
        owner.permanentlyLostSkills ??= []
        if (!owner.permanentlyLostSkills.includes(CC_LINGFA)) owner.permanentlyLostSkills.push(CC_LINGFA)
        grantSkill(host.state, ownerId, CC_ZHIAN)
        grantSkill(host.state, ownerId, CC_JIANXIONG)
        state.b56Caocao.roundEffect = undefined
        state.b56Caocao.roundEffectRound = round
        host.dispatch('SkillActivated', { skillId: CC_LINGFA, skillName: '令法', playerId: ownerId,
          result: 'transformed', logText: '【令法】失效，获得【治暗】和【奸雄】' }, { sourceId: ownerId })
        return
      }
      host.askSkill({ skillId: CC_LINGFA, ownerId, step: 'round-choice', data: { round }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【令法】：令所有其他角色本轮使用【杀】时弃置一张牌，或使用【桃】后交给你一张牌（第${round}轮）`,
        timeoutMs: 25_000, optional: true,
        options: [{ id: 'slash', label: '使用【杀】时弃置一张牌' }, { id: 'peach', label: '使用【桃】后交给你一张牌' }],
      }) })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (!ccPeachModeActive(host.state)) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; cancelled?: boolean }
      const userId = context.event.sourceId
      if (payload.cardName !== '桃' || !payload.cardId || !userId || userId === ownerId || payload.cancelled) return
      host.queueSkill({ skillId: CC_LINGFA, ownerId, step: 'peach-payment', data: { userId, cardId: payload.cardId } })
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      if (!ccPeachModeActive(host.state)) return
      const payload = context.event.payload as { cardId?: CardId | null; cardName?: string }
      const userId = context.event.sourceId
      if (payload.cardName !== '桃' || !userId || userId === ownerId) return
      host.queueSkill({ skillId: CC_LINGFA, ownerId, step: 'peach-payment', data: { userId, cardId: payload.cardId ?? null } })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const state = host.state as B56State
      if (context.event.sourceId !== ownerId || (context.event.payload as { cardName?: string }).cardName !== '令法'
        || !state.b56CaocaoPendingSlash || context.event.targetId !== state.b56CaocaoPendingSlash.actorId) return
      if (host.state.dying) return
      host.queueSkill({ skillId: CC_LINGFA, ownerId, step: 'continue-slash', data: {} })
    } },
    { event: 'QuitDying', handle(host, ownerId, context) {
      const state = host.state as B56State
      if (state.b56CaocaoPendingSlash?.actorId !== context.event.targetId) return
      host.queueSkill({ skillId: CC_LINGFA, ownerId, step: 'continue-slash', data: {} })
    } },
    { event: 'Death', handle(host, _ownerId, context) {
      const state = host.state as B56State
      if (state.b56CaocaoPendingSlash?.actorId === context.event.targetId) delete state.b56CaocaoPendingSlash
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'continue-slash') { ccContinuePendingSlash(host); return }
    if (prompt.step === 'peach-payment') {
      askCCPeachPayment(host, ownerId, prompt.data.userId as PlayerId)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'round-choice') {
      const choice = (response.payload as { optionId?: string }).optionId
      const round = resolution.data.round as number
      if ((choice !== 'slash' && choice !== 'peach') || round !== host.state.roundNumber) return
      const state = host.state as B56State
      state.b56Caocao ??= { turns: {} }
      state.b56Caocao.roundEffect = choice
      state.b56Caocao.roundEffectRound = round
      return
    }
    if (resolution.step === 'slash-choice' || resolution.step === 'slash-refusal') {
      const continuation = resolution.data.continuation as NonNullable<B56State['b56CaocaoPendingSlash']>
      const userId = continuation.actorId
      if (resolution.step === 'slash-choice' && (response.payload as { optionId?: string }).optionId === 'pay') {
        const player = host.state.players.find((item) => item.id === userId && item.alive)
        const excluded = continuation.kind === 'play' ? continuation.action.cardIds : continuation.context.cardId ? [continuation.context.cardId] : []
        const cardIds = [...new Set([...(player?.zones.hand ?? []), ...Object.values(player?.zones.equipment ?? {}).filter((id): id is CardId => Boolean(id))])]
          .filter((cardId) => !excluded.includes(cardId) && !isCardProtectedFromDiscard(host.state, userId, cardId, ownerId))
        if (player && cardIds.length) {
          host.askSkill({ skillId: CC_LINGFA, ownerId, step: 'slash-card', data: { continuation, cardIds }, build: (id): ChooseCardsRequest => ({
            id, kind: 'choose-cards', playerId: userId, prompt: '【令法】：选择一张牌弃置', timeoutMs: 25_000,
            optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
          }) })
          return
        }
      }
      ccDamageForRefusal(host, ownerId, userId, continuation)
      return
    }
    if (resolution.step === 'slash-card') {
      const continuation = resolution.data.continuation as NonNullable<B56State['b56CaocaoPendingSlash']>
      const userId = continuation.actorId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const allowed = (resolution.data.cardIds as CardId[]).includes(cardId as CardId)
        && locateOwnedCard(host.state, userId, cardId as CardId)
        && !isCardProtectedFromDiscard(host.state, userId, cardId as CardId, ownerId)
      const discarded = allowed ? discardCardsByIds(host as never, userId, [cardId as CardId], CC_LINGFA) : []
      if (!discarded.length) { ccDamageForRefusal(host, ownerId, userId, continuation); return }
      if (continuation.kind === 'play') executeUseCardAction(host as never, userId, continuation.action, { skipPlayInterceptors: true })
      else ccUseVirtualSlash(host, host.state as B56State, continuation)
      return
    }
    if (resolution.step === 'peach-payment') {
      const userId = resolution.data.userId as PlayerId
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'give') {
        const cards = ccGiveableHand(host, userId)
        if (cards.length) {
          host.askSkill({ skillId: CC_LINGFA, ownerId, step: 'peach-card', data: { userId }, build: (id): ChooseCardsRequest => ({
            id, kind: 'choose-cards', playerId: userId, prompt: '【令法】：选择一张手牌交给SP·曹操',
            timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
          }) })
          return
        }
      }
      if (host.state.players.some((item) => item.id === userId && item.alive))
        resolveDamage(host as never, { sourceId: ownerId, targetId: userId, amount: 1, nature: 'normal', cardName: '令法' })
      return
    }
    if (resolution.step === 'peach-card') {
      const userId = resolution.data.userId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const given = cardId && ccGiveableHand(host, userId).includes(cardId) ? giveCards(host as never, userId, ownerId, [cardId], CC_LINGFA) : []
      if (!given.length && host.state.players.some((item) => item.id === userId && item.alive))
        resolveDamage(host as never, { sourceId: ownerId, targetId: userId, amount: 1, nature: 'normal', cardName: '令法' })
    }
  },
})

registerSkillRuntime({ id: CC_ZHIAN,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const state = host.state as B56State
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; cancelled?: boolean }
    const userId = context.event.sourceId
    if (!payload.cardId || !userId || userId === ownerId || payload.cancelled || state.b56Caocao?.zhiAnTurn === host.state.turnNumber) return
    const card = host.state.cards[payload.cardId]
    if (card?.category !== 'equipment' && card?.category !== 'trick') return
    if (!ccLocateFieldCard(host.state, payload.cardId)) return
    state.b56Caocao ??= { turns: {} }
    state.b56Caocao.zhiAnTurn = host.state.turnNumber
    host.queueSkill({ skillId: CC_ZHIAN, ownerId, step: 'choice', data: { cardId: payload.cardId, userId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choice') askCCZhiAn(host, ownerId, prompt.data.cardId as CardId, prompt.data.userId as PlayerId)
  },
  resume(host, ownerId, resolution, response) {
    const cardId = resolution.data.cardId as CardId
    const userId = resolution.data.userId as PlayerId
    const choice = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'choice') {
      if (choice === 'decline') return
      if (choice === 'discard') { ccMoveFieldCard(host, ownerId, cardId, 'discard'); return }
      if (choice === 'damage') {
        if (host.state.players.some((item) => item.id === userId && item.alive))
          resolveDamage(host as never, { sourceId: ownerId, targetId: userId, amount: 1, nature: 'normal', cardName: '治暗' })
        return
      }
      if (choice === 'gain') {
        const cards = ccGiveableHand(host, ownerId).filter((candidate) => !isCardProtectedFromDiscard(host.state, ownerId, candidate, ownerId))
        if (!cards.length) return
        host.askSkill({ skillId: CC_ZHIAN, ownerId, step: 'cost', data: { cardId, userId }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【治暗】：弃置一张手牌并获得此牌',
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step !== 'cost') return
    const costId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const cost = costId && ccGiveableHand(host, ownerId).includes(costId)
      && !isCardProtectedFromDiscard(host.state, ownerId, costId, ownerId) ? discardCardsByIds(host as never, ownerId, [costId], CC_ZHIAN) : []
    if (cost.length) ccMoveFieldCard(host, ownerId, cardId, 'gain')
  },
})

registerSkillRuntime({ id: CC_JIANXIONG,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    host.queueSkill({ skillId: CC_JIANXIONG, ownerId, step: 'ask', data: { cardId: (context.event.payload as { cardId?: CardId | null }).cardId ?? null } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const cardId = prompt.data.cardId as CardId | null
    if (!cardId || !host.state.zones.discardPile.includes(cardId)) return
    host.askSkill({ skillId: CC_JIANXIONG, ownerId, step: 'ask', data: { cardId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【奸雄】：是否获得造成此次伤害的【${host.state.cards[cardId]?.name ?? '牌'}】？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'gain', label: '获得此牌' }, { id: 'decline', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask' || (response.payload as { optionId?: string }).optionId !== 'gain') return
    const cardId = resolution.data.cardId as CardId
    if (!host.state.zones.discardPile.includes(cardId) || !host.state.players.some((item) => item.id === ownerId && item.alive)) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CC_JIANXIONG }, { targetId: ownerId, cardIds: [cardId] })
  },
})

const askWeiyanDiscard = (host: SkillHost, ownerId: PlayerId, targetId: PlayerId, hpCondition: boolean): void => {
  const target = host.state.players.find((item) => item.id === targetId && item.alive)
  if (!target) return
  const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
  pickable.hiddenCardSlots = target.zones.hand.flatMap((cardId, index) =>
    isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId) ? [] : [hiddenHandSlot(targetId, index)])
  if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
  host.askSkill({ skillId: WY_YINZHAN, ownerId, step: 'discard', data: { targetId, hpCondition }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【饮战】：弃置其一张牌', timeoutMs: 25_000,
    optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
  }) })
}

const askLiyuTake = (host: SkillHost, ownerId: PlayerId, targetId: PlayerId, amount: number): void => {
  const target = host.state.players.find((item) => item.id === targetId && item.alive)
  if (!target || !Number.isInteger(amount) || amount <= 0) return
  const pickable = pickableCardsOf(host.state, targetId, { includeJudgingArea: true })
  const max = Math.min(amount, pickable.cardIds.length + pickable.hiddenCardSlots.length)
  if (max <= 0) return
  host.askSkill({ skillId: LB_LIYU, ownerId, step: 'take', data: { targetId, amount }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【利驭】：获得${target.nickname}区域里至多${max}张牌，然后其摸等量牌`,
    timeoutMs: 25_000, optional: false, purpose: 'skill', ...pickable, min: 0, max,
  }) })
}

const queueZhujiReward = (host: SkillHost, ownerId: PlayerId, discardedCount: number): void => {
  const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
  const equippedCount = owner ? Object.values(owner.zones.equipment).filter(Boolean).length : 0
  if (owner && discardedCount >= equippedCount) host.queueSkill({ skillId: SS_ZHUJI, ownerId, step: 'reward', data: {} })
}

function failWeiyan(host: SkillHost, ownerId: PlayerId): void {
  const owner = host.state.players.find((item) => item.id === ownerId)
  if (!owner) return
  const status = ((host.state as B56State).b56Weiyan ??= {})[ownerId] ??= {
    discarded: 0, hpLost: 0, usedCards: 0, stage: 1, failed: false, awakened: false,
  }
  if (status.failed || status.awakened) return
  status.failed = true
  owner.permanentlyLostSkills ??= []
  if (!owner.permanentlyLostSkills.includes(WY_ZHUANGSHI)) owner.permanentlyLostSkills.push(WY_ZHUANGSHI)
  grantSkill(host.state, ownerId, WY_KUNFEN)
}

export const HISTORICAL_BATCH56_CHARACTERS: readonly CharacterDefinition[] = [
  character('mou-lvbu-b56', '谋·吕布', 'qun', 'male', 4, [
    { id: LB_WUSHUANG, name: '无双', description: '锁定技，你使用的【杀】需两张【闪】才能抵消；与你进行【决斗】的角色每次需打出两张【杀】。每回合限一次，若对方没有使用或打出【杀】或【闪】，则此【杀】或【决斗】对其造成的伤害+1。' },
    { id: LB_LIYU, name: '利驭', description: '当你使用【杀】对一名其他角色造成伤害后，你可以获得其区域里的至多等同于伤害数张牌，然后其摸等量张牌。若你与其因此获得了全部类别的牌，其选择一项：令你视为对由其指定的另一名其他角色使用一张【决斗】；其获得技能“无双”直至其下个回合结束。' },
  ]),
  character('shi-weiyan-b56', '势·魏延', 'shu', 'male', 4, [
    { id: WY_ZHUANGSHI, name: '壮誓', description: '出牌阶段开始时，你可以执行其中的任意项：1.弃置任意张手牌，然后你此阶段使用的前等量张牌无距离限制且不可被响应；2.失去任意点体力，然后你此阶段使用的前等量张牌不计入次数。' },
    { id: WY_YINZHAN, name: '饮战', description: '锁定技，当你使用【杀】对一名角色造成伤害时，若你的体力值小于等于其，此【杀】对其造成的伤害+1；若你的手牌数小于等于其，你于此【杀】结算结束后弃置其一张牌。乘势：你回复1点体力并获得其弃置的牌。' },
    { id: WY_ZHONGAO, name: '忠傲', description: '使命技，游戏开始时，你获得技能“狂骨※”。成功：当你杀死一名角色后，你升级技能“狂骨※”，然后若你于此阶段内使用的牌数小于因“壮誓※”弃置的牌数，你摸一张牌；使用的牌数小于因“壮誓※”失去的体力数，你回复1点体力（未受伤则改为摸一张牌）。失败：当你进入濒死状态时，或你选择不执行技能“壮誓※”，你失去技能“壮誓※”并获得技能“困奋※”。' },
    { id: WY_KUANGGU, name: '狂骨', granted: true, description: '一级：当你对距离1以内的一名角色造成伤害后，你可以选择一项：回复1点体力；摸一张牌。二级：当你对距离1以内的一名角色造成伤害后，你可以选择一项：回复1点体力；摸一张牌。背水：弃置一张牌，然后你此阶段使用【杀】的次数+1。' },
    { id: WY_KUNFEN, name: '困奋', granted: true, description: '锁定技，结束阶段，你失去1点体力，然后摸两张牌。' },
  ]),
  character('sunshao-b56', '孙韶', 'wu', 'male', 4, [
    { id: SS_GANJUE, name: '敢决', description: '出牌阶段限一次，你可以将一张装备区里的牌当不计入次数且无距离与次数限制的普通【杀】使用，若目标角色没有与此【杀】花色相同的手牌，其不可响应此【杀】。' },
    { id: SS_ZHUJI, name: '筑墼', description: '出牌阶段结束时，你可以选择一张手牌，弃置与之花色相同的所有手牌，然后获得并使用牌堆中的一张同花色装备牌。若你弃置的牌数大于等于你装备区里的牌数，你选择一项：摸两张牌；回复1点体力；获得1点护甲。' },
  ]),
  character('shi-chendao-b56', '势·陈到', 'shu', 'male', 4, [
    { id: CD_WANGLIE, name: '往烈', description: '出牌阶段开始时，你可以选择一张手牌，你于此阶段内：使用此牌无距离限制且不可被响应；使用此牌结算结束后不能再对其他角色使用牌。' },
    { id: CD_HONGYI, name: '弘毅', description: '锁定技，游戏开始时，你获得2个“毅”标记；当你造成或受到伤害后，你获得1个“毅”标记；你至多拥有4个“毅”标记；准备阶段（X为你此时拥有的“毅”标记数），你选择执行一项，并于结束阶段执行另一项：1.摸X张牌；2.清空“毅”标记。' },
  ]),
  character('shi-luyusheng-b56', '势·陆郁生', 'wu', 'female', 3, [
    { id: LY_RUNWEI, name: '润微', description: '出牌阶段限一次，你可以展示牌堆顶至多五张牌，令一名角色获得其中一种颜色的所有牌。若如此做：每阶段限一次，你失去X张牌后（X为其因此获得的牌数），该技能可以再次发动且不能指定本回合获得过牌的角色为目标；本阶段结束时，你弃置以此法获得的手牌。' },
    { id: LY_SHUANGHUAI, name: '霜怀', description: '每回合限一次，当与你距离1以内的其他角色受到伤害时，你可以选择一项：防止此伤害；令其从弃牌堆中获得一张【桃】。若该角色与你上一次发动时相同，你与其各摸一张牌；不同，你失去1点体力。' },
  ]),
  character('shi-zhangyan-b56', '势·张燕', 'qun', 'male', 4, [
    { id: ZY_FEIJING, name: '飞径', description: '你的伤害类锦囊可以当【杀】使用或打出。每回合限两次，你使用【杀】指定唯一目标时，可以选择你与其之间的一条路径，此路径上的所有角色须同时展示并依次弃置一张手牌。然后你可以选择一种颜色，弃置此颜色牌的角色成为此【杀】的额外目标。路径：使用者与目标之间的单向遍历路线，不包括首尾角色。' },
    { id: ZY_XIAOGE, name: '骁戈', description: '锁定技，你使用的【杀】：对因“飞径”成为额外目标的角色造成伤害时，防止之，然后你回复1点体力并获得其弃置的牌；若仅指定了一名角色为目标，结算结束后，你视为对其使用一张【决斗】。' },
  ]),
  character('shi-tianfeng-b56', '势·田丰', 'qun', 'male', 3, [
    { id: TF_GANGGENG, name: '刚鲠', description: '出牌阶段限一次，你可以将至少两张手牌交给一名其他角色。回合结束时，若其手牌数为全场最多，你摸一张牌；不为全场最多，你弃置其区域里的一张牌。' },
    { id: TF_SIJIAN, name: '死谏', description: '每回合限两次，当你失去最后一张手牌后，或当你进入濒死状态时，你可以选择一项：1.选择一名其他角色，其使用下一张牌后需弃置一张牌；2.令当前回合角色摸两张牌。若此时没有角色处于濒死状态，你可以背水：失去X点体力（X为此技能发动过背水的次数）。' },
  ]),
  character('lejiu-b56', '乐就', 'qun', 'male', 4, [
    { id: LJ_CUIJIN, name: '催进', description: '你或你攻击范围内的角色使用【杀】时，你可以弃置一张牌令此牌造成的伤害值+1。若此牌未造成伤害，你摸一张牌并对使用者造成1点伤害。' },
  ]),
  character('shi-guoyuan-b56', '势·国渊', 'wei', 'male', 3, [
    { id: GY_QINGDAO, name: '清蹈', description: '当其他角色对你使用的伤害类卡牌结算结束后，若你因此牌受到伤害，你可以从牌堆或弃牌堆中获得一张【闪】，或弃置一名角色区域里的一张牌；否则你可以从牌堆或弃牌堆中获得一张【杀】，或使用一张手牌（无距离限制）。' },
    { id: GY_XIUGENG, name: '修耕', description: '回合开始时，你可以记录至多两名角色的手牌数。若如此做，这些角色的摸牌阶段开始时，若其手牌数小于等于记录值，其摸两张牌；大于等于记录值，其手牌上限+1。' },
    { id: GY_CHENSHE, name: '陈赦', description: '当一名其他角色进入濒死状态时，你可以依次弃置你、其、伤害来源的各一张牌；若这些角色均被因此弃置了牌且花色均相同，则其回复体力至上限，然后你失去此技能。' },
  ]),
  character('sp-caocao-b56', 'SP·曹操', 'qun', 'male', 4, [
    { id: CC_LINGFA, name: '令法', description: '每轮开始时，你可以令第X项效果对所有其他角色生效直至本轮结束（X为当前轮数）：1.使用【杀】时，其需弃置一张牌；2.使用【桃】后，其需交给你一张牌。不执行效果的其他角色受到你对其造成的1点伤害。若当前轮数大于2，改为你失去此技能并获得技能“治暗※”和“奸雄※”。' },
    { id: CC_ZHIAN, name: '治暗', granted: true, description: '每回合限一次，一名其他角色使用装备牌或延时锦囊牌后，你可以选择一项：1.弃置之；2.弃置一张手牌并获得之；3.对使用者造成1点伤害。' },
    { id: CC_JIANXIONG, name: '奸雄', description: '当你受到伤害后，你可以获得造成此伤害的牌。', granted: true },
  ]),
]

// Runtime registrations are added below; the batch is deliberately not imported by standard.ts until every rule path is complete.

// 谋·吕布【无双】：沿用引擎统一的双闪与决斗双杀入口。
registerSkillRuntime({ id: LB_WUSHUANG, slashDodgeResponses: 2, duelSlashResponses: 2,
  outgoingDamage(state, ownerId, context) {
    if (context.chainTransfer || (context.cardName !== '杀' && context.cardName !== '决斗') || !context.cardId
      || usedThisTurn(state, ownerId, LB_WUSHUANG)
      || (state as B56State).b56LubuResponses?.[context.cardId]?.[context.targetId]) return null
    const owner = state.players.find((item) => item.id === ownerId && item.alive)
    if (!owner) return null
    markUsedThisTurn(state, ownerId, LB_WUSHUANG)
    return { amount: context.amount + 1 }
  },
  triggers: [
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; slashCardId?: CardId }
      if (payload.cardName !== '杀' && payload.cardName !== '闪') return
      const slashId = payload.slashCardId
      const resolution = host.state.cardResolution
      const duelId = resolution?.kind === 'trick' && resolution.cardName === '决斗' && resolution.sourceId === ownerId
        ? resolution.cardId : undefined
      const cardId = slashId ?? duelId
      const responderId = context.event.sourceId
      if (!cardId || !responderId) return
      ;((host.state as B56State).b56LubuResponses ??= {})[cardId] ??= {}
      ;(host.state as B56State).b56LubuResponses![cardId][responderId] = true
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      if (context.event.sourceId === ownerId && cardId) delete (host.state as B56State).b56LubuResponses?.[cardId]
    } },
    { event: 'TurnStart', handle(host, holderId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      const timer = (host.state as B56State).b56LiyuTemp?.[holderId]
      if (payload.playerId === holderId && timer) timer.started = true
    } },
    { event: 'TurnEnd', handle(host, holderId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      const state = host.state as B56State
      const timer = state.b56LiyuTemp?.[holderId]
      if (payload.playerId !== holderId || !timer?.started) return
      replaceTemporarySkill(host.state, holderId, timer.source, null)
      delete state.b56LiyuTemp?.[holderId]
    } },
  ],
})

registerSkillRuntime({ id: LB_LIYU,
  triggers: [
    { event: 'AfterDamage', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || (context.event.payload as { cardName?: string }).cardName !== '杀') return
      const targetId = context.event.targetId
      const amount = (context.event.payload as { amount?: number }).amount ?? 0
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!targetId || targetId === ownerId || amount <= 0 || !cardId) return
      const entry = ((host.state as B56State).b56LiyuDamage ??= {})[cardId] ??= { ownerId, targets: {} }
      if (entry.ownerId === ownerId) entry.targets[targetId] = (entry.targets[targetId] ?? 0) + amount
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      if (!cardId) return
      const state = host.state as B56State
      const record = state.b56LiyuDamage?.[cardId]
      if (!record || record.ownerId !== ownerId) return
      delete state.b56LiyuDamage?.[cardId]
      for (const [targetId, amount] of Object.entries(record.targets)) {
        host.queueSkill({ skillId: LB_LIYU, ownerId, step: 'invoke', data: { targetId, amount } })
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const targetId = prompt.data.targetId as PlayerId
    if (prompt.step === 'invoke') {
      const target = host.state.players.find((item) => item.id === targetId && item.alive)
      const available = target ? pickableCardsOf(host.state, targetId, { includeJudgingArea: true }) : null
      if (!target || !available || available.cardIds.length + available.hiddenCardSlots.length === 0) return
      host.askSkill({ skillId: LB_LIYU, ownerId, step: 'invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【利驭】：是否获得${target.nickname}区域里的牌？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动利驭' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step === 'take') askLiyuTake(host, ownerId, targetId, Number(prompt.data.amount) || 0)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      askLiyuTake(host, ownerId, resolution.data.targetId as PlayerId, Number(resolution.data.amount) || 0)
      return
    }
    if (resolution.step === 'take') {
      const targetId = resolution.data.targetId as PlayerId
      const target = host.state.players.find((item) => item.id === targetId && item.alive)
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      if (!target || !owner) return
      const selections = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const gainedIds = [...new Set(selections.map((selection) => resolvePickedCard(host.state, targetId, selection)).filter((id): id is CardId => Boolean(id)))]
        .slice(0, Number(resolution.data.amount) || 0)
      const moved: CardId[] = []
      for (const cardId of gainedIds) {
        if (movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) moved.push(cardId)
      }
      if (moved.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: moved, reason: LB_LIYU }, { sourceId: ownerId, targetId: ownerId, cardIds: moved })
      const drawn = target.alive ? drawCards(host.state, host.rng, targetId, moved.length, (name, data) => host.dispatch(name, data)) as CardId[] : []
      const categories = new Set([...moved, ...drawn].map((cardId) => host.state.cards[cardId]?.category).filter(Boolean))
      if (categories.has('basic') && categories.has('trick') && categories.has('equipment') && target.alive) {
      const duelTargets = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.id !== targetId
          && !isTargetProhibited(host.state, ownerId, candidate.id, '决斗', skillIdsOf))
        const options = [
          ...(duelTargets.length ? [{ id: 'duel', label: '令谋·吕布视为对你指定的另一名其他角色使用【决斗】' }] : []),
          { id: 'wushuang', label: '获得“无双”直到你的下个回合结束' },
        ]
        host.askSkill({ skillId: LB_LIYU, ownerId, step: 'all-categories', data: { targetId, duelTargetIds: duelTargets.map((item) => item.id) }, build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: targetId, prompt: '【利驭】：你与其因此获得了全部类别的牌，选择一项',
          timeoutMs: 25_000, optional: false, options,
        }) })
      }
      return
    }
    if (resolution.step === 'all-categories') {
      const targetId = resolution.data.targetId as PlayerId
      const option = (response.payload as { optionId?: string }).optionId
      const target = host.state.players.find((item) => item.id === targetId && item.alive)
      if (!target) return
      if (option === 'wushuang') {
        const source = `${LB_LIYU}:${ownerId}`
        replaceTemporarySkill(host.state, targetId, source, LB_WUSHUANG)
        ;((host.state as B56State).b56LiyuTemp ??= {})[targetId] = { ownerId, source, started: false }
      } else if (option === 'duel') {
        const candidateIds = (resolution.data.duelTargetIds as PlayerId[]).filter((id) => host.state.players.some((item) => item.id === id && item.alive)
          && !isTargetProhibited(host.state, ownerId, id, '决斗', skillIdsOf))
        if (!candidateIds.length) return
        host.askSkill({ skillId: LB_LIYU, ownerId, step: 'duel-target', data: { targetId }, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: targetId, prompt: '【利驭】：选择谋·吕布【决斗】的目标', timeoutMs: 25_000,
          optional: false, candidateIds, min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'duel-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && host.state.players.some((item) => item.id === ownerId && item.alive)) {
        host.beginVirtualTrick({ sourceId: ownerId, targetId, cardName: '决斗', sourceSkillId: LB_LIYU })
      }
    }
  },
})

// 孙韶【敢决】：装备作为实体载体进正常杀流程，仍保留原花色/牌的移动结算。
registerSkillRuntime({ id: SS_GANJUE,
  activeActions(state, ownerId) {
    const owner = state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'sunshao-b56')
    const equipped = owner ? Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)) : []
    return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, SS_GANJUE)
      && equipped.length ? [{ id: SS_GANJUE, label: '敢决：将装备牌当无次数、无距离限制的杀使用' }] : []
  },
  invokeActive(host, ownerId) {
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'sunshao-b56')
    const cardIds = owner ? Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)) : []
    if (!cardIds.length || usedThisPhase(host.state, ownerId, SS_GANJUE)) return
    markUsedThisPhase(host.state, ownerId, SS_GANJUE)
    host.askSkill({ skillId: SS_GANJUE, ownerId, step: 'equipment', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【敢决】：选择一张装备区里的牌当【杀】使用',
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  slashIgnoresDistance(state, ownerId, cardId) {
    return Boolean(cardId && (state as B56State).b56Ganjue?.[ownerId]?.cardId === cardId)
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const pending = (host.state as B56State).b56Ganjue?.[ownerId]
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (context.event.sourceId === ownerId && pending?.cardId === cardId) delete (host.state as B56State).b56Ganjue![ownerId]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'equipment') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      if (!cardId || !owner || !Object.values(owner.zones.equipment).includes(cardId)) return
      const targets = host.state.players.filter((target) => target.alive && target.id !== ownerId
        && !isTargetProhibited(host.state, ownerId, target.id, '杀', skillIdsOf)).map(({ id }) => id)
      host.askSkill({ skillId: SS_GANJUE, ownerId, step: 'target', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【敢决】：选择【杀】的目标',
        timeoutMs: 25_000, optional: false, candidateIds: targets, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'target') return
    const cardId = resolution.data.cardId as CardId
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    const target = host.state.players.find((item) => item.id === targetId && item.alive)
    const zone = locateOwnedCard(host.state, ownerId, cardId)
    if (!targetId || !owner || !target || !zone || zone.kind !== 'equipment' || isTargetProhibited(host.state, ownerId, targetId, '杀', skillIdsOf)) return
    const suit = host.state.cards[cardId]?.suit
    const cannotRespond = Boolean(suit) && !target.zones.hand.some((id) => host.state.cards[id]?.suit === suit)
    setCardAlias(host.state, cardId, '杀')
    ;((host.state as B56State).b56Ganjue ??= {})[ownerId] = { cardId }
    if (!host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: SS_GANJUE,
       cardId, countUsage: false, ...(cannotRespond ? { noDodgeTargetIds: [targetId] } : {}) })) {
      delete (host.state as B56State).b56Ganjue?.[ownerId]
    }
  },
})

// 孙韶【筑墼】：阶段结束时按选定花色弃置手牌，再从牌堆取同花色装备并正常使用。
registerSkillRuntime({ id: SS_ZHUJI,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'sunshao-b56')
    if (payload.playerId !== ownerId || payload.phase !== 'play' || !owner?.zones.hand.length) return
    host.queueSkill({ skillId: SS_ZHUJI, ownerId, step: 'choose-suit', data: { candidates: [...owner.zones.hand] } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'reward') {
      host.askSkill({ skillId: SS_ZHUJI, ownerId, step: 'reward', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【筑墼】：选择一项', timeoutMs: 25_000, optional: false,
        options: [{ id: 'draw', label: '摸两张牌' }, { id: 'recover', label: '回复1点体力' }, { id: 'armor', label: '获得1点护甲' }],
      }) })
      return
    }
    if (prompt.step !== 'choose-suit') return
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    const candidates = (prompt.data.candidates as CardId[]).filter((id) => owner?.zones.hand.includes(id))
    if (!candidates.length) return
    host.askSkill({ skillId: SS_ZHUJI, ownerId, step: 'choose-suit', data: { candidates }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【筑墼】：选择一张手牌，弃置所有同花色手牌',
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-suit') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      const eligible = (resolution.data.candidates as CardId[]).filter((id) => owner?.zones.hand.includes(id))
      if (!selected || !eligible.includes(selected) || !owner) return
      const suit = host.state.cards[selected]?.suit
      if (!suit) return
      const discarded = owner.zones.hand.filter((id) => host.state.cards[id]?.suit === suit)
      for (const id of discarded) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      if (discarded.length) host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: SS_ZHUJI }, { sourceId: ownerId, cardIds: discarded })
      const equipment = host.state.zones.drawPile.filter((id) => {
        const card = host.state.cards[id]
        return card?.category === 'equipment' && card.suit === suit
      })
      if (equipment.length) {
        host.askSkill({ skillId: SS_ZHUJI, ownerId, step: 'equipment', data: { suit, discardedCount: discarded.length, equipment }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: `【筑墼】：选择一张${suit}花色的装备牌获得并使用`,
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: equipment, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      } else {
        queueZhujiReward(host, ownerId, discarded.length)
      }
      return
    }
    if (resolution.step === 'equipment') {
      const equipmentId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      const suit = resolution.data.suit
      const equipment = resolution.data.equipment as CardId[]
      if (!owner || !equipmentId || !equipment.includes(equipmentId) || !host.state.zones.drawPile.includes(equipmentId)
        || host.state.cards[equipmentId]?.category !== 'equipment' || host.state.cards[equipmentId]?.suit !== suit) return
      moveCard(host.state, equipmentId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [equipmentId], reason: SS_ZHUJI }, { sourceId: ownerId, targetId: ownerId, cardIds: [equipmentId] })
      const action = legalPlayActions(host.state, ownerId).find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(equipmentId))
      if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
      queueZhujiReward(host, ownerId, Number(resolution.data.discardedCount) || 0)
      return
    }
    if (resolution.step !== 'reward') return
    const option = (response.payload as { optionId?: string }).optionId
    if (option === 'draw') drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
    else if (option === 'recover') recover(host as never, ownerId, 1, ownerId)
    else if (option === 'armor') {
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      if (owner) { owner.armorPoints = (owner.armorPoints ?? 0) + 1; host.dispatch('ArmorChanged', { playerId: ownerId, delta: 1, reason: SS_ZHUJI }, { sourceId: ownerId, targetId: ownerId }) }
    }
  },
})

// 势·陈到【往烈】：指定实体牌在本阶段内无距离限制且不可响应；该牌
// 完整结算后，若曾指定其他角色，则封锁本阶段后续对其他角色的用牌。
registerSkillRuntime({ id: CD_WANGLIE,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'shi-chendao-b56')
      if (payload.playerId !== ownerId || payload.phase !== 'play' || !owner?.zones.hand.length) return
      host.askSkill({ skillId: CD_WANGLIE, ownerId, step: 'choose-card', data: { cardIds: [...owner.zones.hand] }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【往烈】：选择一张手牌，本阶段使用此牌无距离限制且不可响应',
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const status = (host.state as B56State).b56Chendao?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      if (!status?.armedCard || payload.cardId !== status.armedCard || context.event.sourceId !== ownerId) return
      status.armedCard = undefined
      if ((payload.targetIds ?? []).some((targetId) => targetId !== ownerId)) status.locked = true
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play') {
        const status = (host.state as B56State).b56Chendao?.[ownerId]
        if (status) { status.armedCard = undefined; status.locked = false }
      }
    } },
  ],
  ignoresDistanceTo(state, ownerId, _targetId, cardId) {
    return Boolean(cardId && (state as B56State).b56Chendao?.[ownerId]?.armedCard === cardId)
  },
  slashUndodgeable(state, ownerId, _targetId, cardId) {
    return Boolean(cardId && (state as B56State).b56Chendao?.[ownerId]?.armedCard === cardId)
  },
  trickUnresponsive(state, ownerId, _targetId, _cardName, cardId) {
    return Boolean(cardId && (state as B56State).b56Chendao?.[ownerId]?.armedCard === cardId)
  },
  prohibitsSourceTarget(state, ownerId, targetId) {
    return Boolean(targetId !== ownerId && (state as B56State).b56Chendao?.[ownerId]?.locked)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-card') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    if (!owner || !cardId || !owner.zones.hand.includes(cardId)) return
    const state = host.state as B56State
    state.b56Chendao ??= {}
    state.b56Chendao[ownerId] = { ...state.b56Chendao[ownerId], yi: state.b56Chendao[ownerId]?.yi ?? 2, armedCard: cardId, locked: false }
  },
})

// 势·陈到【弘毅】：准备阶段选择先摸牌或先清标记，另一项在结束阶段执行；
// X 固定为准备阶段选择时的毅数，避免清标记后失去本回合应摸的数量。
registerSkillRuntime({ id: CD_HONGYI,
  onGameStart(host, ownerId) {
    const owner = host.state.players.find((item) => item.id === ownerId && item.characterId === 'shi-chendao-b56')
    if (owner) owner.marks[CD_YI_MARK] = 2
  },
  triggers: [
    { event: 'AfterDamage', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId && context.event.targetId !== ownerId) return
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      if (owner) owner.marks[CD_YI_MARK] = Math.min(4, (owner.marks[CD_YI_MARK] ?? 0) + 1)
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId) return
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      if (!owner) return
      const status = ((host.state as B56State).b56Chendao ??= {})[ownerId] ??= { yi: owner.marks[CD_YI_MARK] ?? 2 }
      if (payload.phase === 'prepare') {
        status.yi = Math.min(4, owner.marks[CD_YI_MARK] ?? 0)
        status.prepareChoice = undefined
        host.askSkill({ skillId: CD_HONGYI, ownerId, step: 'prepare-choice', data: { yi: status.yi }, build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: ownerId, prompt: `【弘毅】：选择一项（当前有${status.yi}个“毅”）`,
          timeoutMs: 25_000, optional: false,
          options: [{ id: 'draw', label: `摸${status.yi}张牌，然后结束阶段清空“毅”` }, { id: 'clear', label: '清空“毅”，然后结束阶段摸牌' }],
        }) })
      } else if (payload.phase === 'finish' && status.prepareChoice) {
        if (status.finishChoice === 'draw') drawCards(host.state, host.rng, ownerId, status.yi, (name, data) => host.dispatch(name, data))
        else owner.marks[CD_YI_MARK] = 0
        status.prepareChoice = undefined
        status.finishChoice = undefined
      }
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'prepare-choice') return
    const option = (response.payload as { optionId?: string }).optionId
    const status = (host.state as B56State).b56Chendao?.[ownerId]
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    if (!status || !owner || (option !== 'draw' && option !== 'clear')) return
    status.yi = Math.min(4, Number(resolution.data.yi) || 0)
    status.prepareChoice = option
    status.finishChoice = option === 'draw' ? 'clear' : 'draw'
    if (option === 'draw') drawCards(host.state, host.rng, ownerId, status.yi, (name, data) => host.dispatch(name, data))
    else owner.marks[CD_YI_MARK] = 0
  },
})

// 势·魏延【壮誓】：阶段开始时分别选择弃牌数与失去体力数。每次实际用牌在
// CardUsed 时固定记录其适用额度，直至 AfterCardUse 才消耗“前N张”的序号。
registerSkillRuntime({ id: WY_ZHUANGSHI,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'shi-weiyan-b56')
      if (payload.playerId !== ownerId || payload.phase !== 'play' || !owner) return
      const status = ((host.state as B56State).b56Weiyan ??= {})[ownerId] ??= {
        discarded: 0, hpLost: 0, usedCards: 0, stage: 1, failed: false, awakened: false,
      }
      status.discarded = 0; status.hpLost = 0; status.usedCards = 0; status.backwaterUses = 0; status.armedCards = {}
      host.askSkill({ skillId: WY_ZHUANGSHI, ownerId, step: 'invoke', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【壮誓】：是否发动？', timeoutMs: 25_000, optional: true,
        options: [{ id: 'invoke', label: '发动壮誓' }, { id: 'decline', label: '不发动（使命失败）' }],
      }) })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const status = (host.state as B56State).b56Weiyan?.[ownerId]
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      if (!status || status.failed || context.event.sourceId !== ownerId) return
      const flags = {
        ignoreDistance: status.usedCards < status.discarded,
        unresponsive: status.usedCards < status.discarded,
        ignoreSlashCount: status.usedCards < status.hpLost,
      }
      if (cardId) {
        status.armedCards ??= {}
        status.armedCards[cardId] = flags
      }
      status.activeFlags = flags
      status.usedCards += 1
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const status = (host.state as B56State).b56Weiyan?.[ownerId]
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      if (!status || context.event.sourceId !== ownerId) return
      if (cardId) delete status.armedCards?.[cardId]
      status.activeFlags = undefined
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const status = (host.state as B56State).b56Weiyan?.[ownerId]
      if (payload.playerId === ownerId && payload.phase === 'play' && status?.backwaterUses) {
        grantTurnSlashBonus(host.state, ownerId, { extraUses: -status.backwaterUses })
        status.backwaterUses = 0
      }
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId) failWeiyan(host, ownerId)
    } },
  ],
  ignoresDistanceTo(state, ownerId, _targetId, cardId) {
    const status = (state as B56State).b56Weiyan?.[ownerId]
    return Boolean(status && (cardId ? status.armedCards?.[cardId]?.ignoreDistance ?? status.activeFlags?.ignoreDistance ?? status.usedCards < status.discarded : status.activeFlags?.ignoreDistance ?? status.usedCards < status.discarded))
  },
  slashUndodgeable(state, ownerId, _targetId, cardId) {
    const status = (state as B56State).b56Weiyan?.[ownerId]
    return Boolean(status && (cardId ? status.armedCards?.[cardId]?.unresponsive ?? status.activeFlags?.unresponsive ?? status.usedCards < status.discarded : status.activeFlags?.unresponsive ?? status.usedCards < status.discarded))
  },
  trickUnresponsive(state, ownerId, _targetId, _cardName, cardId) {
    const status = (state as B56State).b56Weiyan?.[ownerId]
    return Boolean(status && (cardId ? status.armedCards?.[cardId]?.unresponsive ?? status.activeFlags?.unresponsive ?? status.usedCards < status.discarded : status.activeFlags?.unresponsive ?? status.usedCards < status.discarded))
  },
  slashUseQuotaBypass(state, ownerId, cardId) {
    const status = (state as B56State).b56Weiyan?.[ownerId]
    return Boolean(status && (cardId ? status.armedCards?.[cardId]?.ignoreSlashCount ?? status.activeFlags?.ignoreSlashCount ?? status.usedCards < status.hpLost : status.activeFlags?.ignoreSlashCount ?? status.usedCards < status.hpLost))
  },
  resume(host, ownerId, resolution, response) {
    const status = (host.state as B56State).b56Weiyan?.[ownerId]
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    if (!status || !owner) return
    if (resolution.step === 'invoke') {
      const option = (response.payload as { optionId?: string }).optionId
      if (option !== 'invoke') { failWeiyan(host, ownerId); return }
      host.askSkill({ skillId: WY_ZHUANGSHI, ownerId, step: 'discard-cost', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【壮誓】：弃置任意张手牌（可以不弃）', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: owner.zones.hand.length,
      }) })
      return
    }
    if (resolution.step === 'discard-cost') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardIds.some((cardId) => !owner.zones.hand.includes(cardId))) return
      const uniqueIds = [...new Set(cardIds)]
      status.discarded = uniqueIds.length
      for (const cardId of uniqueIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      if (uniqueIds.length) host.dispatch('LoseCard', { playerId: ownerId, cardIds: uniqueIds, reason: WY_ZHUANGSHI }, { sourceId: ownerId, cardIds: uniqueIds })
      const hpOptions = Array.from({ length: Math.max(0, owner.hp) + 1 }, (_, n) => ({ id: String(n), label: `失去${n}点体力` }))
      host.askSkill({ skillId: WY_ZHUANGSHI, ownerId, step: 'hp-cost', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【壮誓】：失去任意点体力（可以不失去）', timeoutMs: 25_000,
        optional: false, options: hpOptions,
      }) })
      return
    }
    if (resolution.step !== 'hp-cost') return
    const raw = (response.payload as { optionId?: string }).optionId
    const cost = Number(raw)
    if (!Number.isInteger(cost) || cost < 0 || cost > owner.hp) return
    status.hpLost = cost
    if (cost > 0) loseHp(host, ownerId, cost, WY_ZHUANGSHI)
  },
})

// 【饮战】的伤害加成在统一伤害修正层处理；牌结算结束后才发弃牌请求，避免
// 把技能选择插进多目标【杀】尚未走完的逐目标结算。乘势只在两项条件同时成立时执行。
registerSkillRuntime({ id: WY_YINZHAN,
  outgoingDamage(state, ownerId, context) {
    if (context.cardName !== '杀' || context.chainTransfer) return null
    const owner = state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'shi-weiyan-b56')
    const target = state.players.find((item) => item.id === context.targetId && item.alive)
    if (!owner || !target) return null
    const hpCondition = owner.hp <= target.hp
    if (context.cardId) {
      const ledger = ((state as B56State).b56WeiyanDamage ??= {})[context.cardId] ??= {}
      ledger[context.targetId] = { hpCondition, handCondition: false }
    }
    return hpCondition ? { amount: context.amount + 1 } : null
  },
  triggers: [
    { event: 'AfterDamage', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || (context.event.payload as { cardName?: string }).cardName !== '杀') return
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      const targetId = context.event.targetId
      const target = host.state.players.find((item) => item.id === targetId && item.alive)
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!owner || !target || !cardId || !targetId || owner.zones.hand.length > target.zones.hand.length) return
      const hit = (host.state as B56State).b56WeiyanDamage?.[cardId]?.[targetId]
      if (hit) hit.handCondition = true
      else (((host.state as B56State).b56WeiyanDamage ??= {})[cardId] ??= {})[targetId] = { hpCondition: false, handCondition: true }
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      if (!cardId) return
      const hits = (host.state as B56State).b56WeiyanDamage?.[cardId]
      delete (host.state as B56State).b56WeiyanDamage?.[cardId]
      for (const [targetId, hit] of Object.entries(hits ?? {})) {
        if (hit.handCondition) host.queueSkill({ skillId: WY_YINZHAN, ownerId, step: 'discard', data: { targetId, hpCondition: hit.hpCondition } })
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    askWeiyanDiscard(host, ownerId, prompt.data.targetId as PlayerId, Boolean(prompt.data.hpCondition))
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const targetId = resolution.data.targetId as PlayerId
    const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    if (!picked) return
    const cardId = resolvePickedCard(host.state, targetId, picked)
    if (!cardId || isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId)) {
      askWeiyanDiscard(host, ownerId, targetId, Boolean(resolution.data.hpCondition))
      return
    }
    if (!movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) return
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: WY_YINZHAN }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    if (!resolution.data.hpCondition) return
    recover(host as never, ownerId, 1, ownerId)
    if (host.state.zones.discardPile.includes(cardId)) {
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WY_YINZHAN }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    }
  },
})

// 【忠傲】承担使命结果和魏延的狂骨等级。开局先给一级狂骨，成功击杀后升级；
// 进入濒死或拒绝壮誓会永久失去壮誓并获得困奋。
registerSkillRuntime({ id: WY_ZHONGAO,
  onGameStart(host, ownerId) {
    const status = ((host.state as B56State).b56Weiyan ??= {})[ownerId] ??= {
      discarded: 0, hpLost: 0, usedCards: 0, stage: 1, failed: false, awakened: false,
    }
    status.stage = 1
    grantSkill(host.state, ownerId, WY_KUANGGU)
  },
  triggers: [{ event: 'Death', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || context.event.targetId === ownerId) return
    const status = (host.state as B56State).b56Weiyan?.[ownerId]
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    if (!status || !owner || status.failed || status.awakened) return
    status.awakened = true; status.stage = 2
    owner.marks['shi-weiyan-zhongao'] = 2
    if (status.usedCards < status.discarded) drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    if (status.usedCards < status.hpLost) {
      if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ownerId)
      else drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    }
  } }],
})

// 二级【狂骨】：对距离1内造成伤害后，先选回复/摸牌，再可背水弃牌换本阶段+1杀。
registerSkillRuntime({ id: WY_KUANGGU,
  triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
    const targetId = context.event.targetId
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    const target = host.state.players.find((item) => item.id === targetId && item.alive)
    if (context.event.sourceId !== ownerId || !owner || !target || getDistance(host.state, ownerId, target.id) > 1) return
    host.queueSkill({ skillId: WY_KUANGGU, ownerId, step: 'benefit', data: { targetId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'benefit') return
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    if (!owner) return
    host.askSkill({ skillId: WY_KUANGGU, ownerId, step: 'benefit', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【狂骨】：选择一项', timeoutMs: 25_000, optional: true,
      options: [{ id: 'recover', label: '回复1点体力' }, { id: 'draw', label: '摸一张牌' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'benefit') {
      const option = (response.payload as { optionId?: string }).optionId
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      if (!owner) return
      if (option === 'recover') recover(host as never, ownerId, 1, ownerId)
      else if (option === 'draw') drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      const status = (host.state as B56State).b56Weiyan?.[ownerId]
      const cards = owner.zones.hand
      if (status?.awakened && cards.length) {
        host.askSkill({ skillId: WY_KUANGGU, ownerId, step: 'backwater', data: {}, build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: ownerId, prompt: '【狂骨】背水：是否弃置一张手牌令本阶段【杀】次数+1？',
          timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '背水：弃置一张手牌' }, { id: 'no', label: '不背水' }],
        }) })
      }
      return
    }
    if (resolution.step === 'backwater' && (response.payload as { optionId?: string }).optionId === 'yes') {
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      if (!owner?.zones.hand.length) return
      host.askSkill({ skillId: WY_KUANGGU, ownerId, step: 'backwater-cost', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【狂骨】背水：弃置一张手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'backwater-cost') return
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!owner || !cardId || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: WY_KUANGGU }, { sourceId: ownerId, cardIds: [cardId] })
    grantTurnSlashBonus(host.state, ownerId, { extraUses: 1 })
    const status = (host.state as B56State).b56Weiyan?.[ownerId]
    if (status) status.backwaterUses = (status.backwaterUses ?? 0) + 1
  },
})

// 失败使命后的【困奋】为锁定技：结束阶段先失去体力，再摸两张。
registerSkillRuntime({ id: WY_KUNFEN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || !owner) return
    loseHp(host, ownerId, 1, WY_KUNFEN)
    if (owner.alive) drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
  } }],
})

function beginCuijin(host: SkillHost, ownerId: PlayerId, context: { sourceId: PlayerId; cardId: CardId; cardName: string }): boolean {
  const owner = host.state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'lejiu-b56')
  const source = host.state.players.find((item) => item.id === context.sourceId && item.alive)
  const usable = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    .filter((cardId) => !isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId)) : []
  if (!owner || !source || context.cardName !== '杀' || !usable.length) return false
  if (ownerId !== source.id && getDistance(host.state, ownerId, source.id) > getAttackRange(host.state, ownerId)) return false
  const state = host.state as B56State
  if (state.b56LejiuSeen?.[context.cardId]?.includes(ownerId)) return false
  ;((state.b56LejiuSeen ??= {})[context.cardId] ??= []).push(ownerId)
  host.askSkill({ skillId: LJ_CUIJIN, ownerId, step: 'discard', data: { cardId: context.cardId, sourceId: source.id }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【催进】：是否弃置一张牌令${source.nickname}使用的【杀】伤害+1？`,
    timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: usable, hiddenCardSlots: [], min: 1, max: 1,
  }) })
  return true
}

function queueSijianChoice(host: SkillHost, ownerId: PlayerId, cause: 'last-hand' | 'dying'): void {
  const state = host.state as B56State
  const record = state.b56Tianfeng ??= {}
  const usage = record[ownerId] ??= { eventUses: 0, backfireCount: 0 }
  if (usage.turnNumber !== host.state.turnNumber) {
    usage.turnNumber = host.state.turnNumber
    usage.eventUses = 0
  }
  if (usage.eventUses >= 2) return
  usage.eventUses += 1
  host.queueSkill({ skillId: TF_SIJIAN, ownerId, step: 'choose', data: { cause, turnNumber: host.state.turnNumber } })
}

function askSijianBackwater(host: SkillHost, ownerId: PlayerId, cause: string): void {
  if (host.state.dying) return
  host.askSkill({ skillId: TF_SIJIAN, ownerId, step: 'backwater', data: { cause }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【死谏】：当前无人濒死，是否背水并失去体力？',
    timeoutMs: 25_000, optional: true,
    options: [{ id: 'yes', label: '背水' }, { id: 'no', label: '不背水' }],
  }) })
}

function askSijianPenaltyDiscard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, count: number): void {
  const target = host.state.players.find((item) => item.id === targetId && item.alive)
  if (!target) return
  const owned = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))]
    .filter((cardId) => !isCardProtectedFromDiscard(host.state, targetId, cardId, targetId))
  const amount = Math.min(count, owned.length)
  if (!amount) return
  host.askSkill({ skillId: TF_SIJIAN, ownerId, step: 'penalty-discard', data: { targetId, count: amount }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: targetId,
    prompt: `【死谏】：你使用牌后需弃置${amount}张牌`, timeoutMs: 25_000,
    optional: false, purpose: 'skill', cardIds: owned, hiddenCardSlots: [], min: amount, max: amount,
  }) })
}

registerSkillRuntime({ id: TF_SIJIAN,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId) {
      const record = ((host.state as B56State).b56Tianfeng ??= {})[ownerId] ??= { eventUses: 0, backfireCount: 0 }
      record.eventUses = 0
      record.turnNumber = host.state.turnNumber
    } },
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      if (payload.playerId === ownerId && owner?.zones.hand.length === 0) queueSijianChoice(host, ownerId, 'last-hand')
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId && host.state.players.some((item) => item.id === ownerId && item.alive)) queueSijianChoice(host, ownerId, 'dying')
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const actorId = context.event.sourceId
      if (!actorId) return
      const state = host.state as B56State
      const pending = state.b56SijianTargets?.[ownerId]
      const matching = pending?.filter((item) => item.targetId === actorId) ?? []
      if (!matching.length) return
      state.b56SijianTargets![ownerId] = pending!.filter((item) => item.targetId !== actorId)
      host.queueSkill({ skillId: TF_SIJIAN, ownerId, step: 'penalty', data: { targetId: actorId, count: matching.length } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'penalty') {
      askSijianPenaltyDiscard(host, ownerId, prompt.data.targetId as PlayerId, prompt.data.count as number)
      return
    }
    if (prompt.step !== 'choose') return
    const usage = (host.state as B56State).b56Tianfeng?.[ownerId]
    if (!usage || usage.turnNumber !== host.state.turnNumber || usage.eventUses < 1
      || !host.state.players.some((item) => item.id === ownerId && item.alive)) return
    const options = [
      ...(host.state.players.some((item) => item.alive && item.id !== ownerId)
        ? [{ id: 'bind', label: '令一名其他角色使用下一张牌后弃置一张牌' }] : []),
      ...(host.state.currentPlayerId ? [{ id: 'draw', label: '令当前回合角色摸两张牌' }] : []),
      { id: 'decline', label: '不发动' },
    ]
    host.askSkill({ skillId: TF_SIJIAN, ownerId, step: 'choose', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【死谏】：选择一项', timeoutMs: 25_000, optional: true,
      options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'decline') {
        const usage = (host.state as B56State).b56Tianfeng?.[ownerId]
        if (usage?.turnNumber === host.state.turnNumber) usage.eventUses = Math.max(0, usage.eventUses - 1)
        return
      }
      if (optionId === 'draw') {
        const current = host.state.players.find((item) => item.id === host.state.currentPlayerId && item.alive)
        if (current) drawCards(host.state, host.rng, current.id, 2, (name, data) => host.dispatch(name, data))
        askSijianBackwater(host, ownerId, 'draw')
        return
      }
      if (optionId !== 'bind') return
      const candidateIds = host.state.players.filter((item) => item.alive && item.id !== ownerId).map((item) => item.id)
      if (!candidateIds.length) { askSijianBackwater(host, ownerId, 'bind'); return }
      host.askSkill({ skillId: TF_SIJIAN, ownerId, step: 'bind', build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【死谏】：选择一名其他角色',
        timeoutMs: 25_000, optional: false, candidateIds, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'bind') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && targetId !== ownerId && host.state.players.some((item) => item.id === targetId && item.alive)) {
        const targets = ((host.state as B56State).b56SijianTargets ??= {})[ownerId] ??= []
        targets.push({ ownerId, targetId })
      }
      askSijianBackwater(host, ownerId, 'bind')
      return
    }
    if (resolution.step === 'backwater') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || host.state.dying) return
      const usage = ((host.state as B56State).b56Tianfeng ??= {})[ownerId] ??= { eventUses: 0, backfireCount: 0 }
      usage.backfireCount += 1
      loseHp(host, ownerId, usage.backfireCount, TF_SIJIAN)
      return
    }
    if (resolution.step !== 'penalty-discard') return
    const targetId = resolution.data.targetId as PlayerId
    const target = host.state.players.find((item) => item.id === targetId && item.alive)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const cards = [...new Set(selected)].slice(0, resolution.data.count as number)
    if (!target || cards.length !== resolution.data.count || cards.some((cardId) => !locateOwnedCard(host.state, targetId, cardId)
      || isCardProtectedFromDiscard(host.state, targetId, cardId, targetId))) return
    discardCardsByIds(host as never, targetId, cards, TF_SIJIAN)
  },
})

registerSkillRuntime({ id: LJ_CUIJIN,
  interceptTarget(host, ownerId, context) {
    return beginCuijin(host, ownerId, context)
  },
  interceptSourceTarget(host, ownerId, context) {
    return beginCuijin(host, ownerId, context)
  },
  interceptBystanderTarget(host, ownerId, context) {
    return beginCuijin(host, ownerId, context)
  },
  globalOutgoingDamage(state, ownerId, sourceId, context) {
    if (context.cardName !== '杀' || !context.cardId
      || (state as B56State).b56LejiuPending?.[context.cardId]?.[ownerId] !== sourceId) return null
    return { amount: context.amount + 1 }
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
    const sourceId = context.event.sourceId
    if (!cardId) return
    const state = host.state as B56State
    const seen = state.b56LejiuSeen?.[cardId]
    if (seen) state.b56LejiuSeen![cardId] = seen.filter((id) => id !== ownerId)
    const hadActivated = state.b56LejiuPending?.[cardId]?.[ownerId] === sourceId
    delete state.b56LejiuPending?.[cardId]?.[ownerId]
    if (!sourceId || !hadActivated) return
    if (cardDamageDealt(host.state, cardId) > 0) return
    drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    if (host.state.players.some((item) => item.id === sourceId && item.alive)) {
      resolveDamage(host as never, { sourceId: ownerId, targetId: sourceId, amount: 1, nature: 'normal', cardName: null })
    }
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const cardId = resolution.data.cardId as CardId
    const sourceId = resolution.data.sourceId as PlayerId
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (owner && selected) {
      const from = locateOwnedCard(host.state, ownerId, selected)
      const canDiscard = from && (from.kind === 'hand' || from.kind === 'equipment')
        && !isCardProtectedFromDiscard(host.state, ownerId, selected, ownerId)
      if (canDiscard) {
        const discarded = discardCardsByIds(host as never, ownerId, [selected], LJ_CUIJIN)
        if (discarded.length) (((host.state as B56State).b56LejiuPending ??= {})[cardId] ??= {})[ownerId] = sourceId
      }
    }
    host.resumeCardTarget()
  },
})

function askRunweiInvoke(host: SkillHost, ownerId: PlayerId, repeat: boolean): void {
  host.askSkill({ skillId: LY_RUNWEI, ownerId, step: 'invoke', data: { repeat }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId,
    prompt: repeat ? '【润微】：已失去足量牌，可以再次发动，是否发动？' : '【润微】：是否展示牌堆顶至多五张牌？',
    timeoutMs: 25_000, optional: true,
    options: [{ id: 'yes', label: '发动润微' }, { id: 'no', label: '不发动' }],
  }) })
}

function askRunweiTarget(host: SkillHost, ownerId: PlayerId, repeat: boolean): void {
  const state = host.state as B56State
  const alreadyGained = new Set(state.b56LuGainedThisTurn?.[ownerId] ?? [])
  const candidates = host.state.players
    .filter((item) => item.alive && (!repeat || !alreadyGained.has(item.id)))
    .map((item) => item.id)
  if (!candidates.length) return
  host.askSkill({ skillId: LY_RUNWEI, ownerId, step: 'target', data: { repeat }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【润微】：选择获得所选颜色牌的角色',
    timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 1, max: 1,
  }) })
}

function askRunweiColor(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, repeat: boolean, cards: CardId[]): void {
  const colors = [...new Set(cards.map((cardId) => effectiveCardColor(host.state, ownerId, cardId)).filter((color): color is 'red' | 'black' => color !== null))]
  if (!colors.length) {
    for (const cardId of cards) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    host.dispatch('CardMove', { cardIds: cards, reason: LY_RUNWEI, destinationZone: 'discardPile' }, { sourceId: ownerId, targetId, cardIds: cards })
    return
  }
  host.askSkill({ skillId: LY_RUNWEI, ownerId, step: 'color', data: { targetId, repeat, cards }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【润微】：选择一种颜色，目标角色获得此颜色的所有牌',
    timeoutMs: 25_000, optional: false,
    options: colors.map((color) => ({ id: color, label: color === 'red' ? '红色' : '黑色' })),
  }) })
}

function resolveRunwei(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, repeat: boolean, cardIds: CardId[], color: 'red' | 'black'): void {
  const state = host.state as B56State
  const target = host.state.players.find((item) => item.id === targetId && item.alive)
  const revealed = cardIds.filter((cardId) => host.state.zones.processingArea.includes(cardId))
  const gained = target ? revealed.filter((cardId) => effectiveCardColor(host.state, ownerId, cardId) === color) : []
  const discarded = revealed.filter((cardId) => !gained.includes(cardId))
  for (const cardId of gained) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
  if (gained.length) host.dispatch('GainCard', { playerId: targetId, cardIds: gained, reason: LY_RUNWEI, revealed: true }, { sourceId: ownerId, targetId, cardIds: gained })
  for (const cardId of discarded) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  if (discarded.length) host.dispatch('CardMove', { cardIds: discarded, reason: LY_RUNWEI, destinationZone: 'discardPile' }, { sourceId: ownerId, targetId, cardIds: discarded })
  if (!gained.length || !target) return

  const run = state.b56LuRunwei?.[ownerId]
  if (!run) return
  run.useCount += 1
  if (repeat) {
    run.repeatUnlocked = true
    run.lostSinceFirst = 0
  } else {
    run.repeatRequired = gained.length
    run.lostSinceFirst = 0
    run.repeatUnlocked = false
  }
  state.b56LuGainedThisTurn ??= {}
  const gainedThisTurn = state.b56LuGainedThisTurn[ownerId] ??= []
  if (!gainedThisTurn.includes(targetId)) gainedThisTurn.push(targetId)
  if (targetId === ownerId) run.gainedHands.push(...gained)
}

registerSkillRuntime({ id: LY_RUNWEI,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const state = host.state as B56State
      state.b56LuRunwei ??= {}
      state.b56LuRunwei[ownerId] = { phaseId: host.state.turnNumber, useCount: 0, repeatRequired: 0, lostSinceFirst: 0, repeatUnlocked: false, gainedHands: [] }
      state.b56LuGainedThisTurn ??= {}
      state.b56LuGainedThisTurn[ownerId] = []
      askRunweiInvoke(host, ownerId, false)
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId || !payload.cardIds?.length) return
      const run = (host.state as B56State).b56LuRunwei?.[ownerId]
      if (!run || run.phaseId !== host.state.turnNumber || run.useCount !== 1 || run.repeatUnlocked) return
      run.lostSinceFirst += payload.cardIds.length
      if (run.lostSinceFirst < run.repeatRequired || run.repeatRequired <= 0) return
      run.repeatUnlocked = true
      host.queueSkill({ skillId: LY_RUNWEI, ownerId, step: 'repeat', data: {} })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const state = host.state as B56State
      const run = state.b56LuRunwei?.[ownerId]
      // 出牌阶段结束时的清理弃牌不能再打开「本阶段再次发动」窗口。
      if (run) run.repeatUnlocked = true
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      const discard = run?.gainedHands.filter((cardId) => owner?.zones.hand.includes(cardId)
        && !isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId)) ?? []
      if (discard.length) {
        discardCardsByIds(host as never, ownerId, discard, LY_RUNWEI)
      }
      delete state.b56LuRunwei?.[ownerId]
      delete state.b56LuGainedThisTurn?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'repeat') return
    const run = (host.state as B56State).b56LuRunwei?.[ownerId]
    if (run?.phaseId === host.state.turnNumber && run.useCount === 1 && run.repeatUnlocked) askRunweiInvoke(host, ownerId, true)
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { repeat?: boolean; targetId?: PlayerId; cards?: CardId[] }
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      askRunweiTarget(host, ownerId, Boolean(data.repeat))
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const alreadyGained = new Set((host.state as B56State).b56LuGainedThisTurn?.[ownerId] ?? [])
      const candidates = host.state.players
        .filter((item) => item.alive && (!data.repeat || !alreadyGained.has(item.id)))
        .map((item) => item.id)
      if (!targetId || !candidates.includes(targetId)) return
      const repeat = Boolean(data.repeat)
      const cards = revealTopCards(host.state, host.rng, 5, LY_RUNWEI, (name, payload) => host.dispatch(name, payload)) as CardId[]
      if (cards.length) askRunweiColor(host, ownerId, targetId, repeat, cards)
      return
    }
    if (resolution.step !== 'color') return
    const color = (response.payload as { optionId?: string }).optionId
    if (color !== 'red' && color !== 'black') return
    resolveRunwei(host, ownerId, data.targetId!, Boolean(data.repeat), data.cards ?? [], color)
  },
})

// 势·国渊【修耕】：每名角色回合开始时由国渊选至多两人记录手牌数；该角色
// 摸牌阶段按 <= / >= 独立判定（相等时两项均生效），手牌上限加成持续到该回合结束。
registerSkillRuntime({ id: LY_SHUANGHUAI,
  offersTargetDamagePreventionAsk(host, ownerId, context) {
    const targetId = context.targetId
    if (!targetId || targetId === ownerId || !host.state.players.some((item) => item.id === ownerId && item.alive)
      || !host.state.players.some((item) => item.id === targetId && item.alive)
      || getDistance(host.state, ownerId, targetId) > 1
      || usedThisTurn(host.state, ownerId, LY_SHUANGHUAI)) return false
    host.queueSkill({ skillId: LY_SHUANGHUAI, ownerId, step: 'invoke', data: { targetId } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'same-target' || prompt.step === 'different-target') {
      const targetId = prompt.data.targetId as PlayerId
      if (prompt.step === 'same-target') {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
        if (host.state.players.some((item) => item.id === targetId && item.alive)) drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
      } else if (host.state.players.some((item) => item.id === ownerId && item.alive)) {
        loseHp(host, ownerId, 1, LY_SHUANGHUAI)
      }
      return
    }
    if (prompt.step !== 'invoke') return
    const targetId = prompt.data.targetId as PlayerId
    const pendingTargetId = (host.state.pendingTargetDamage?.options as { targetId?: PlayerId } | undefined)?.targetId
    if (!host.state.pendingTargetDamage || pendingTargetId !== targetId
      || getDistance(host.state, ownerId, targetId) > 1
      || !host.state.players.some((item) => item.id === ownerId && item.alive)) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    const peachIds = host.state.zones.discardPile.filter((cardId) => host.state.cards[cardId]?.name === '桃')
    host.askSkill({ skillId: LY_SHUANGHUAI, ownerId, step: 'invoke', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【霜怀】：选择一项', timeoutMs: 25_000, optional: true,
      options: [
        { id: 'prevent', label: '防止此伤害' },
        ...(peachIds.length ? [{ id: 'peach', label: '令其从弃牌堆获得一张【桃】' }] : []),
        { id: 'decline', label: '不发动' },
      ],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    if (resolution.step === 'invoke') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'decline') { resumeTargetDamagePrevention(host as never, false); return }
      if (optionId !== 'prevent' && optionId !== 'peach') { resumeTargetDamagePrevention(host as never, false); return }
      const pendingTargetId = (host.state.pendingTargetDamage?.options as { targetId?: PlayerId } | undefined)?.targetId
      if (!host.state.pendingTargetDamage || pendingTargetId !== targetId
        || !host.state.players.some((item) => item.id === ownerId && item.alive)
        || !host.state.players.some((item) => item.id === targetId && item.alive)) {
        resumeTargetDamagePrevention(host as never, false)
        return
      }
      markUsedThisTurn(host.state, ownerId, LY_SHUANGHUAI)
      if (optionId === 'prevent') {
        const state = host.state as B56State
        const previous = state.b56LuShuanghuaiLast?.[ownerId] ?? null
        ;(state.b56LuShuanghuaiLast ??= {})[ownerId] = targetId
        host.queueSkill({ skillId: LY_SHUANGHUAI, ownerId, step: previous === targetId ? 'same-target' : 'different-target', data: { targetId } })
        resumeTargetDamagePrevention(host as never, true, LY_SHUANGHUAI)
        return
      }
      const peachIds = host.state.zones.discardPile.filter((cardId) => host.state.cards[cardId]?.name === '桃')
      if (!peachIds.length) { resumeTargetDamagePrevention(host as never, false); return }
      host.askSkill({ skillId: LY_SHUANGHUAI, ownerId, step: 'peach', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【霜怀】：选择一张【桃】令其获得',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: peachIds, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'peach') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const peach = cardId && host.state.zones.discardPile.includes(cardId) && host.state.cards[cardId]?.name === '桃'
    if (peach && host.state.players.some((item) => item.id === targetId && item.alive)) {
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: LY_SHUANGHUAI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      const state = host.state as B56State
      const previous = state.b56LuShuanghuaiLast?.[ownerId] ?? null
      ;(state.b56LuShuanghuaiLast ??= {})[ownerId] = targetId
      host.queueSkill({ skillId: LY_SHUANGHUAI, ownerId, step: previous === targetId ? 'same-target' : 'different-target', data: { targetId } })
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    resumeTargetDamagePrevention(host as never, false)
  },
})

function askGanggengTargetCard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const target = host.state.players.find((item) => item.id === targetId && item.alive)
  const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
  if (!target || !owner) return
  const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId, includeJudgingArea: true })
  pickable.hiddenCardSlots = target.zones.hand.flatMap((cardId, index) =>
    isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId) ? [] : [hiddenHandSlot(targetId, index)])
  if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
  host.askSkill({ skillId: TF_GANGGENG, ownerId, step: 'discard', data: { targetId }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【刚鲠】：弃置${target.nickname}区域里的一张牌`,
    timeoutMs: 25_000, optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
  }) })
}

const ZY_FEIJING_GROUP = 'b56-zhangyan-feijing-path'
registerGroupCardDecision(ZY_FEIJING_GROUP, (groupHost, decision) => {
  const host = groupHost as unknown as SkillHost
  const data = decision.data as { ownerId: PlayerId; cardId: CardId; targetId: PlayerId; route: PlayerId[] }
  const revealed: Array<{ playerId: PlayerId; cardId: CardId; color: 'red' | 'black' }> = []
  for (const playerId of data.route) {
    const cardId = (decision.responses[playerId] as CardId[] | undefined)?.[0]
    const player = host.state.players.find((item) => item.id === playerId && item.alive)
    if (!cardId || !player?.zones.hand.includes(cardId) || isCardProtectedFromDiscard(host.state, playerId, cardId, data.ownerId)) continue
    const color = effectiveCardColor(host.state, playerId, cardId)
    if (color) revealed.push({ playerId, cardId, color })
  }
  if (revealed.length) host.dispatch('CardMove', {
    cardIds: revealed.map((item) => item.cardId), sourcePlayerIds: revealed.map((item) => item.playerId),
    reason: ZY_FEIJING, revealed: true,
  }, { sourceId: data.ownerId, targetId: data.targetId, cardIds: revealed.map((item) => item.cardId) })
  const discarded: typeof revealed = []
  for (const entry of revealed) {
    const cardIds = discardCardsByIds(host as never, entry.playerId, [entry.cardId], ZY_FEIJING)
    if (cardIds.includes(entry.cardId)) discarded.push(entry)
  }
  if (!discarded.length) { host.resumeCardTarget(); return }
  host.askSkill({ skillId: ZY_FEIJING, ownerId: data.ownerId, step: 'color', data: { ...data, discarded }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: data.ownerId, prompt: '【飞径】：选择一种颜色，使弃置此颜色牌的角色成为额外目标',
    timeoutMs: 25_000, optional: false,
    options: [
      ...(discarded.some((item) => item.color === 'red') ? [{ id: 'red', label: '红色' }] : []),
      ...(discarded.some((item) => item.color === 'black') ? [{ id: 'black', label: '黑色' }] : []),
      { id: 'none', label: '不追加目标' },
    ],
  }) })
})

function feijingRoutes(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): { clockwise: PlayerId[]; counterclockwise: PlayerId[] } | null {
  const seats = host.state.players.filter((player) => player.alive).sort((left, right) => left.seat - right.seat)
  const start = seats.findIndex((item) => item.id === ownerId)
  const finish = seats.findIndex((item) => item.id === targetId)
  if (start < 0 || finish < 0 || start === finish) return null
  const walk = (step: 1 | -1): PlayerId[] => {
    const result: PlayerId[] = []
    let index = (start + step + seats.length) % seats.length
    while (index !== finish && result.length < seats.length - 1) {
      result.push(seats[index].id)
      index = (index + step + seats.length) % seats.length
    }
    return result
  }
  return { clockwise: walk(1), counterclockwise: walk(-1) }
}

registerSkillRuntime({ id: ZY_FEIJING,
  viewAs(state, ownerId) {
    const owner = state.players.find((item) => item.id === ownerId && item.alive)
    if (!owner) return []
    return owner.zones.hand.filter((cardId => state.cards[cardId]?.category === 'trick' && DAMAGE_TRICKS.has(state.cards[cardId].name)))
      .map((cardId) => ({ asCardName: '杀', cardId, label: `【飞径】：将【${state.cards[cardId].name}】当【杀】使用或打出` }))
  },
  interceptSourceTarget(host, ownerId, context) {
    const resolution = host.state.cardResolution
    if (context.sourceId !== ownerId || context.cardName !== '杀' || resolution?.kind !== 'slash'
      || resolution.sourceId !== ownerId || !isSoleTargetOf(host.state, context.cardId, context.targetId)) return false
    const routes = feijingRoutes(host, ownerId, context.targetId)
    if (!routes || (!routes.clockwise.length && !routes.counterclockwise.length)) return false
    const state = host.state as B56State
    const usage = state.b56ZhangyanUseCount?.[ownerId]
    const count = usage?.turnNumber === host.state.turnNumber ? usage.count : 0
    if (count >= 2) return false
    const routeLabel = (route: PlayerId[]) => route.length
      ? route.map((id) => host.state.players.find((item) => item.id === id)?.nickname ?? '角色').join('→')
      : '无中间角色'
    host.askSkill({ skillId: ZY_FEIJING, ownerId, step: 'path', data: { cardId: context.cardId, targetId: context.targetId, routes }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【飞径】：选择一条经过目标前的路径，或不发动',
      timeoutMs: 25_000, optional: false,
      options: [
        { id: 'clockwise', label: `顺时针：${routeLabel(routes.clockwise)}` },
        { id: 'counterclockwise', label: `逆时针：${routeLabel(routes.counterclockwise)}` },
        { id: 'skip', label: '不发动飞径' },
      ],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'path') {
      const data = resolution.data as { cardId: CardId; targetId: PlayerId; routes: { clockwise: PlayerId[]; counterclockwise: PlayerId[] } }
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'skip') { host.resumeCardTarget(); return }
      if (choice !== 'clockwise' && choice !== 'counterclockwise') { host.resumeCardTarget(); return }
      const route = data.routes[choice]
      const state = host.state as B56State
      const previous = state.b56ZhangyanUseCount?.[ownerId]
      state.b56ZhangyanUseCount ??= {}
      state.b56ZhangyanUseCount[ownerId] = { turnNumber: host.state.turnNumber, count: (previous?.turnNumber === host.state.turnNumber ? previous.count : 0) + 1 }
      startGroupCardDecision(host as never, {
        id: `${ZY_FEIJING}:${host.state.seq}:${data.cardId}`,
        tag: ZY_FEIJING_GROUP,
        skillId: ZY_FEIJING,
        playerIds: route,
        prompt: '【飞径】：同时展示并选择一张手牌弃置',
        cardIdsFor: (playerId) => {
          const player = host.state.players.find((item) => item.id === playerId)
          return player?.zones.hand.filter((cardId) => !isCardProtectedFromDiscard(host.state, playerId, cardId, ownerId)) ?? []
        },
        minFor: (_playerId, cards) => cards.length ? 1 : 0,
        max: 1,
        timeoutMs: 25_000,
        data: { ownerId, cardId: data.cardId, targetId: data.targetId, route },
      })
      return
    }
    if (resolution.step !== 'color') return
    const data = resolution.data as { cardId: CardId; targetId: PlayerId; route: PlayerId[]; discarded: Array<{ playerId: PlayerId; cardId: CardId; color: 'red' | 'black' }> }
    const color = (response.payload as { optionId?: string }).optionId
    const current = host.state.cardResolution
    if (current?.kind === 'slash' && current.cardId === data.cardId) {
      const extras: Record<PlayerId, CardId> = {}
      if (color === 'red' || color === 'black') {
        for (const entry of data.discarded) {
          if (entry.color !== color || !host.state.players.some((item) => item.id === entry.playerId && item.alive)
            || isTargetProhibited(host.state, ownerId, entry.playerId, '杀', skillIdsOf, data.cardId)
            || entry.playerId === data.targetId || entry.playerId === ownerId
            || current.remainingTargetIds.includes(entry.playerId)) continue
          extras[entry.playerId] = entry.cardId
          current.remainingTargetIds.push(entry.playerId)
        }
      }
      if (Object.keys(extras).length) {
        ;((host.state as B56State).b56Zhangyan ??= {})[data.cardId] = { ownerId, extras, initialTargetId: data.targetId }
      }
    }
    host.resumeCardTarget()
  },
})

registerSkillRuntime({ id: ZY_XIAOGE,
  preventsDamage(state, ownerId, side, context) {
    if (side !== 'source' || context.sourceId !== ownerId || context.chainTransfer || !context.cardId) return false
    const record = (state as B56State).b56Zhangyan?.[context.cardId]
    if (!record?.extras[context.targetId]) return false
    record.preventedTargets ??= {}
    record.preventedTargets[context.targetId] = true
    return true
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; finalAmount?: number }
      const targetId = context.event.targetId
      const record = payload.cardId ? (host.state as B56State).b56Zhangyan?.[payload.cardId] : undefined
      const cardId = targetId && record?.preventedTargets?.[targetId] ? record.extras[targetId] : undefined
      if (!targetId || !payload.cardId || !cardId || Number(payload.finalAmount) > 0) return
      delete record!.preventedTargets![targetId]
      if (!host.state.players.some((item) => item.id === ownerId && item.alive)) return
      recover(host as never, ownerId, 1, ownerId)
      if (host.state.zones.discardPile.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZY_XIAOGE }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[]; cancelled?: boolean }
      const soleTarget = payload.cardId && isSoleTargetOf(host.state, payload.cardId, context.event.targetId ?? '')
      if (payload.cardName === '杀' && !payload.cancelled && soleTarget && context.event.targetId) {
        host.queueSkill({ skillId: ZY_XIAOGE, ownerId, step: 'duel', data: { targetId: context.event.targetId } })
      }
      if (payload.cardId) delete (host.state as B56State).b56Zhangyan?.[payload.cardId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'duel' || host.state.cardResolution) return
    const targetId = prompt.data.targetId as PlayerId
    if (!host.state.players.some((item) => item.id === ownerId && item.alive)
      || !host.state.players.some((item) => item.id === targetId && item.alive)) return
    host.beginVirtualTrick({ sourceId: ownerId, targetId, cardName: '决斗', sourceSkillId: ZY_XIAOGE })
  },
})

registerSkillRuntime({ id: TF_GANGGENG,
  activeActions(state, ownerId) {
    const owner = state.players.find((item) => item.id === ownerId && item.alive)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner && owner.zones.hand.length >= 2
      && state.players.some((item) => item.alive && item.id !== ownerId) && !usedThisPhase(state, ownerId, TF_GANGGENG)
      ? [{ id: TF_GANGGENG, label: '刚鲠：交至少两张手牌' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== TF_GANGGENG || usedThisPhase(host.state, ownerId, TF_GANGGENG)) return
    markUsedThisPhase(host.state, ownerId, TF_GANGGENG)
    const candidateIds = host.state.players.filter((item) => item.alive && item.id !== ownerId).map((item) => item.id)
    host.askSkill({ skillId: TF_GANGGENG, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【刚鲠】：选择获得至少两张手牌的角色',
      timeoutMs: 25_000, optional: false, candidateIds, min: 1, max: 1,
    }) })
  },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId }
    const record = (host.state as B56State).b56TianfengGiven?.[ownerId]
    if (payload.playerId !== ownerId || !record || record.turnNumber !== host.state.turnNumber) return
    delete (host.state as B56State).b56TianfengGiven?.[ownerId]
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    const target = host.state.players.find((item) => item.id === record.targetId && item.alive)
    if (!owner || !target) return
    const maximum = Math.max(...host.state.players.filter((item) => item.alive).map((item) => item.zones.hand.length))
    if (target.zones.hand.length === maximum) {
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      return
    }
    host.queueSkill({ skillId: TF_GANGGENG, ownerId, step: 'end-discard', data: { targetId: target.id } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'end-discard') askGanggengTargetCard(host, ownerId, prompt.data.targetId as PlayerId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = host.state.players.find((item) => item.id === targetId && item.alive && item.id !== ownerId)
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      if (!target || !owner) return
      host.askSkill({ skillId: TF_GANGGENG, ownerId, step: 'give', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【刚鲠】：选择至少两张手牌交给${target.nickname}`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [],
        min: 2, max: owner.zones.hand.length,
      }) })
      return
    }
    if (resolution.step === 'give') {
      const targetId = resolution.data.targetId as PlayerId
      const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
      const target = host.state.players.find((item) => item.id === targetId && item.alive && item.id !== ownerId)
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      if (!owner || !target || selected.length < 2 || selected.some((cardId) => !owner.zones.hand.includes(cardId))) return
      for (const cardId of selected) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: selected, reason: TF_GANGGENG }, { sourceId: ownerId, targetId, cardIds: selected })
      host.dispatch('GainCard', { playerId: targetId, cardIds: selected, reason: TF_GANGGENG }, { sourceId: ownerId, targetId, cardIds: selected })
      host.dispatch('CardGiven', { fromPlayerId: ownerId, toPlayerId: targetId, cardIds: selected, reason: TF_GANGGENG }, { sourceId: ownerId, targetId, cardIds: selected })
      ;((host.state as B56State).b56TianfengGiven ??= {})[ownerId] = { targetId, turnNumber: host.state.turnNumber }
      return
    }
    if (resolution.step !== 'discard') return
    const targetId = resolution.data.targetId as PlayerId
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
    if (!cardId || !locateOwnedCard(host.state, targetId, cardId) || isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId)) return
    if (!movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) return
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: TF_GANGGENG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
  },
})

function qingdaoCardsInPiles(host: SkillHost, cardName: '闪' | '杀') {
  const matches = (cardId: CardId) => host.state.cards[cardId]?.name === cardName
  return {
    draw: host.state.zones.drawPile.filter(matches),
    discard: host.state.zones.discardPile.filter(matches),
  }
}

function askQingdaoPileChoice(host: SkillHost, ownerId: PlayerId, cardName: '闪' | '杀'): void {
  const piles = qingdaoCardsInPiles(host, cardName)
  if (!piles.draw.length && !piles.discard.length) return
  const takeFromDraw = () => {
    const cardId = host.rng.pick(piles.draw)
    if (!cardId || !host.state.zones.drawPile.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: GY_QINGDAO }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  }
  if (piles.draw.length && !piles.discard.length) { takeFromDraw(); return }
  if (!piles.draw.length && piles.discard.length === 1) {
    const cardId = piles.discard[0]
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: GY_QINGDAO }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    return
  }
  host.askSkill({ skillId: GY_QINGDAO, ownerId, step: 'pile', data: { cardName, drawCardIds: piles.draw, discardCardIds: piles.discard }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【清蹈】：从牌堆或弃牌堆获得一张【${cardName}】`,
    timeoutMs: 25_000, optional: false,
    options: [
      ...(piles.draw.length ? [{ id: 'draw', label: '从牌堆获得（随机）' }] : []),
      ...(piles.discard.length ? [{ id: 'discard', label: `从弃牌堆选择（${piles.discard.length}张）` }] : []),
    ],
  }) })
}

function askQingdaoDiscardTarget(host: SkillHost, ownerId: PlayerId): void {
  const candidateIds = host.state.players.filter((target) => target.alive && (() => {
    const cards = pickableCardsOf(host.state, target.id, { discarderId: ownerId, includeJudgingArea: true })
    return cards.cardIds.length + cards.hiddenCardSlots.length > 0
  })()).map((target) => target.id)
  if (!candidateIds.length) return
  host.askSkill({ skillId: GY_QINGDAO, ownerId, step: 'discard-target', build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【清蹈】：选择一名角色，弃置其区域里的一张牌',
    timeoutMs: 25_000, optional: false, candidateIds, min: 1, max: 1,
  }) })
}

function qingdaoLegalHandActions(state: SanguoshaState, ownerId: PlayerId): Extract<LegalAction, { kind: 'use-card' }>[] {
  const owner = state.players.find((item) => item.id === ownerId && item.alive)
  if (!owner) return []
  const actions: Extract<LegalAction, { kind: 'use-card' }>[] = []
  for (const cardId of owner.zones.hand) {
    const simulated = structuredClone(state) as B56State
    simulated.phase = 'play'
    simulated.currentPlayerId = ownerId
    simulated.pendingRequests = []
    simulated.cardResolution = null
    simulated.dying = null
    simulated.b56GuoyuanNoDistance ??= {}
    simulated.b56GuoyuanNoDistance[ownerId] = { cardId, turnNumber: simulated.turnNumber }
    actions.push(...legalPlayActions(simulated, ownerId).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> =>
      action.kind === 'use-card' && action.cardIds[0] === cardId))
  }
  return actions
}

function askQingdaoHandUse(host: SkillHost, ownerId: PlayerId): void {
  const actions = qingdaoLegalHandActions(host.state, ownerId)
  if (!actions.length) return
  const options = actions.map((action, index) => {
    const cardId = action.cardIds[0]
    const card = host.state.cards[cardId]
    const targets = action.targetIds.map((id) => host.state.players.find((item) => item.id === id)?.nickname ?? '角色')
    return { id: `${index}:${action.id}`, label: `${card?.name ?? '手牌'}当${action.asCardName}${targets.length ? ` → ${targets.join('、')}` : ''}` }
  })
  host.askSkill({ skillId: GY_QINGDAO, ownerId, step: 'use-action', data: { actionIds: actions.map((action) => action.id), cardIds: actions.map((action) => action.cardIds[0]) }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【清蹈】：选择一张合法手牌使用（无距离限制）',
    timeoutMs: 25_000, optional: true, options: [{ id: 'cancel', label: '不使用' }, ...options],
  }) })
}

registerSkillRuntime({ id: GY_QINGDAO,
  ignoresTrickDistance(state, ownerId) { return Boolean((state as B56State).b56GuoyuanNoDistance?.[ownerId]) },
  slashIgnoresDistance(state, ownerId, cardId) {
    const record = (state as B56State).b56GuoyuanNoDistance?.[ownerId]
    return Boolean(record && record.cardId === cardId)
  },
  slashUseQuotaBypass(state, ownerId, cardId) {
    const record = (state as B56State).b56GuoyuanNoDistance?.[ownerId]
    return Boolean(record && record.cardId === cardId)
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const sourceId = context.event.sourceId
      if (!payload.cardId || !sourceId || sourceId === ownerId || !payload.targetIds?.includes(ownerId)
        || (payload.cardName !== '杀' && !DAMAGE_TRICKS.has(payload.cardName ?? ''))) return
      ;((host.state as B56State).b56GuoyuanDamageCards ??= {})[payload.cardId] = { ownerId, sourceId, damaged: false }
    } },
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId }
      if (!payload.cardId) return
      const record = (host.state as B56State).b56GuoyuanDamageCards?.[payload.cardId]
      if (record?.ownerId === ownerId && record.sourceId === context.event.sourceId) record.damaged = true
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      const sourceId = context.event.sourceId
      if (!payload.cardId) return
      const state = host.state as B56State
      const record = state.b56GuoyuanDamageCards?.[payload.cardId]
      if (record?.ownerId === ownerId && record.sourceId === sourceId) {
        delete state.b56GuoyuanDamageCards?.[payload.cardId]
        host.queueSkill({ skillId: GY_QINGDAO, ownerId, step: 'choose', data: { damaged: record.damaged, cardId: payload.cardId, sourceId } })
      }
      if (state.b56GuoyuanNoDistance?.[ownerId]?.cardId === payload.cardId) delete state.b56GuoyuanNoDistance[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
    if (!owner) return
    const damaged = prompt.data.damaged === true
    const options: Array<{ id: string; label: string }> = []
    if (damaged) {
      if (qingdaoCardsInPiles(host, '闪').draw.length || qingdaoCardsInPiles(host, '闪').discard.length) options.push({ id: 'flash', label: '从牌堆或弃牌堆获得一张【闪】' })
      const canDiscard = host.state.players.some((target) => target.alive && (() => {
        const cards = pickableCardsOf(host.state, target.id, { discarderId: ownerId, includeJudgingArea: true })
        return cards.cardIds.length + cards.hiddenCardSlots.length > 0
      })())
      if (canDiscard) options.push({ id: 'discard', label: '弃置一名角色区域里的一张牌' })
    } else {
      if (qingdaoCardsInPiles(host, '杀').draw.length || qingdaoCardsInPiles(host, '杀').discard.length) options.push({ id: 'slash', label: '从牌堆或弃牌堆获得一张【杀】' })
      if (owner.zones.hand.length) options.push({ id: 'use', label: '使用一张手牌（无距离限制）' })
    }
    if (!options.length) return
    host.askSkill({ skillId: GY_QINGDAO, ownerId, step: 'choose', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: damaged ? '【清蹈】：你因此牌受到伤害，选择一项' : '【清蹈】：你未因此牌受到伤害，选择一项',
      timeoutMs: 25_000, optional: true, options: [...options, { id: 'decline', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose') {
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'flash' || choice === 'slash') { askQingdaoPileChoice(host, ownerId, choice === 'flash' ? '闪' : '杀'); return }
      if (choice === 'discard') { askQingdaoDiscardTarget(host, ownerId); return }
      if (choice === 'use') { askQingdaoHandUse(host, ownerId); return }
      return
    }
    if (resolution.step === 'pile') {
      const data = resolution.data as { cardName: '闪' | '杀'; drawCardIds: CardId[]; discardCardIds: CardId[] }
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'draw') {
        const cardId = host.rng.pick(data.drawCardIds.filter((id) => host.state.zones.drawPile.includes(id)))
        if (cardId) {
          moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: GY_QINGDAO }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
        }
      } else if (choice === 'discard') {
        const cardIds = data.discardCardIds.filter((id) => host.state.zones.discardPile.includes(id))
        if (!cardIds.length) return
        if (cardIds.length === 1) {
          const cardId = cardIds[0]
          moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: GY_QINGDAO }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
        } else host.askSkill({ skillId: GY_QINGDAO, ownerId, step: 'take-discard', data: { cardName: data.cardName, cardIds }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: `【清蹈】：选择一张【${data.cardName}】获得`,
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'take-discard') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !host.state.zones.discardPile.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: GY_QINGDAO }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      return
    }
    if (resolution.step === 'discard-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = host.state.players.find((item) => item.id === targetId && item.alive)
      if (!targetId || !target) return
      const pickable = targetId === ownerId
        ? { cardIds: [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea]
          .filter((id) => !isCardProtectedFromDiscard(host.state, targetId, id, ownerId)), hiddenCardSlots: [] as string[] }
        : pickableCardsOf(host.state, targetId, { discarderId: ownerId, includeJudgingArea: true })
      if (targetId !== ownerId) pickable.hiddenCardSlots = target.zones.hand.flatMap((cardId, index) =>
        isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId) ? [] : [hiddenHandSlot(targetId, index)])
      if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
      host.askSkill({ skillId: GY_QINGDAO, ownerId, step: 'discard-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【清蹈】：选择${target.nickname}区域里的一张牌弃置`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'discard-card') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? targetId === ownerId ? selected as CardId
        : host.state.players.find((item) => item.id === targetId)?.zones.judgingArea.includes(selected as CardId)
          ? selected as CardId : resolvePickedCard(host.state, targetId, selected) : null
      if (!cardId || isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId)) return
      const judgmentOwner = host.state.players.find((item) => item.id === targetId && item.zones.judgingArea.includes(cardId))
      const moved = judgmentOwner
        ? (moveCard(host.state, cardId, { kind: 'judgingArea', playerId: targetId }, { kind: 'discardPile' }), true)
        : movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
      if (!moved) return
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: GY_QINGDAO }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      return
    }
    if (resolution.step === 'use-action') {
      const selected = (response.payload as { optionId?: string }).optionId
      if (!selected || selected === 'cancel') return
      const match = selected.match(/^(\d+):/)
      const index = match ? Number(match[1]) : -1
      const action = qingdaoLegalHandActions(host.state, ownerId)[index]
      const expectedActionIds = (resolution.data as { actionIds?: string[] }).actionIds
      if (!action || action.id !== expectedActionIds?.[index]) return
      const cardId = action.cardIds[0]
      ;((host.state as B56State).b56GuoyuanNoDistance ??= {})[ownerId] = { cardId, turnNumber: host.state.turnNumber }
      executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: false })
      const state = host.state as B56State
      if (state.b56GuoyuanNoDistance?.[ownerId]?.cardId === cardId && host.state.cardResolution?.cardId !== cardId)
        delete state.b56GuoyuanNoDistance[ownerId]
    }
  },
})

registerSkillRuntime({ id: GY_XIUGENG,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const guoyuan = host.state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'shi-guoyuan-b56')
      const payload = context.event.payload as { playerId?: PlayerId }
      if (!guoyuan || !payload.playerId || !host.state.players.some((item) => item.id === payload.playerId && item.alive)) return
      const candidates = host.state.players.filter((item) => item.alive).map(({ id }) => id)
      host.askSkill({ skillId: GY_XIUGENG, ownerId, step: 'record', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【修耕】：记录至多两名角色的手牌数',
        timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 0, max: Math.min(2, candidates.length),
      }) })
    } },
    { event: 'PhaseStart', handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'draw' || !payload.playerId) return
      const state = host.state as B56State
      const record = state.b56Guoyuan?.[payload.playerId]
      const target = host.state.players.find((item) => item.id === payload.playerId && item.alive)
      if (!record || !target) return
      const hand = target.zones.hand.length
      if (hand <= record.snapshot) drawCards(host.state, host.rng, target.id, 2, (name, data) => host.dispatch(name, data))
      if (hand >= record.snapshot) record.limitTurn = host.state.turnNumber
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const state = host.state as B56State
      const record = state.b56Guoyuan?.[ownerId]
      if (!record) return
      replaceTemporarySkill(host.state, ownerId, record.source, null)
      delete state.b56Guoyuan?.[ownerId]
    } },
  ],
  maxCardsBonus(state, ownerId) {
    const record = (state as B56State).b56Guoyuan?.[ownerId]
    return record?.limitTurn === state.turnNumber ? 1 : 0
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'record') return
    const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])].slice(0, 2)
    for (const targetId of targetIds) {
      const target = host.state.players.find((item) => item.id === targetId && item.alive)
      if (!target) continue
      const source = `${GY_XIUGENG}:${ownerId}:${targetId}`
      ;((host.state as B56State).b56Guoyuan ??= {})[targetId] = { ownerId, snapshot: target.zones.hand.length, source }
      replaceTemporarySkill(host.state, targetId, source, GY_XIUGENG)
    }
  },
})

function askChensheDiscard(host: SkillHost, ownerId: PlayerId, data: { dyingId: PlayerId; actors: PlayerId[]; index: number; suits: string[] }): void {
  const actorId = data.actors[data.index]
  const owner = host.state.players.find((item) => item.id === ownerId && item.alive)
  const actor = host.state.players.find((item) => item.id === actorId && item.alive)
  if (!owner || !actor) return
  const pickable = actorId === ownerId
    ? { cardIds: [...actor.zones.hand, ...Object.values(actor.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((cardId) => !isCardProtectedFromDiscard(host.state, actorId, cardId, ownerId)), hiddenCardSlots: [] as string[] }
    : pickableCardsOf(host.state, actorId, { discarderId: ownerId })
  if (actorId !== ownerId) {
    pickable.hiddenCardSlots = actor.zones.hand.flatMap((cardId, index) =>
      isCardProtectedFromDiscard(host.state, actorId, cardId, ownerId) ? [] : [hiddenHandSlot(actorId, index)])
  }
  if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
  host.askSkill({ skillId: GY_CHENSHE, ownerId, step: 'discard', data, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId,
    prompt: `【陈赦】：选择${actor.nickname}区域里的一张牌弃置（${data.index + 1}/3）`,
    timeoutMs: 25_000, optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
  }) })
}

registerSkillRuntime({ id: GY_CHENSHE,
  triggers: [{ event: 'EnterDying', handle(host, ownerId, context) {
    const dyingId = context.event.targetId
    const sourceId = context.event.sourceId
    const owner = host.state.players.find((item) => item.id === ownerId && item.alive && item.characterId === 'shi-guoyuan-b56')
    const dying = host.state.players.find((item) => item.id === dyingId && item.alive)
    const source = sourceId && host.state.players.find((item) => item.id === sourceId && item.alive)
    if (!owner || !dying || dyingId === ownerId || !source || owner.marks['b56-chenshe-used']) return
    const actors = [ownerId, dyingId!, sourceId!]
    const requiredByActor = new Map<PlayerId, number>()
    for (const actorId of actors) requiredByActor.set(actorId, (requiredByActor.get(actorId) ?? 0) + 1)
    if ([...requiredByActor].some(([actorId, required]) => {
      const actor = host.state.players.find((item) => item.id === actorId && item.alive)
      if (!actor) return true
      const handCount = actor.zones.hand.filter((cardId) => !isCardProtectedFromDiscard(host.state, actorId, cardId, ownerId)).length
      const equipCount = Object.values(actor.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)
        && !isCardProtectedFromDiscard(host.state, actorId, cardId, ownerId)).length
      return handCount + equipCount < required
    })) return
    host.queueSkill({ skillId: GY_CHENSHE, ownerId, step: 'invoke', data: { dyingId, actors, index: 0, suits: [] } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const dyingId = prompt.data.dyingId as PlayerId
    if (host.state.dying?.playerId !== dyingId || !host.state.players.some((item) => item.id === dyingId && item.alive)) return
    host.askSkill({ skillId: GY_CHENSHE, ownerId, step: 'invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【陈赦】：是否依次弃置你、濒死角色和伤害来源各一张牌？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动陈赦' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const data = resolution.data as unknown as { dyingId: PlayerId; actors: PlayerId[]; index: number; suits: string[] }
      askChensheDiscard(host, ownerId, data)
      return
    }
    if (resolution.step !== 'discard') return
    const data = resolution.data as unknown as { dyingId: PlayerId; actors: PlayerId[]; index: number; suits: string[] }
    const actorId = data.actors[data.index]
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected ? (actorId === ownerId ? selected as CardId : resolvePickedCard(host.state, actorId, selected)) : null
    if (!cardId || !locateOwnedCard(host.state, actorId, cardId) || isCardProtectedFromDiscard(host.state, actorId, cardId, ownerId)) {
      askChensheDiscard(host, ownerId, data)
      return
    }
    const suit = host.state.cards[cardId]?.suit
    if (!suit || !movePickedCard(host as never, actorId, cardId, { kind: 'discardPile' })) {
      askChensheDiscard(host, ownerId, data)
      return
    }
    host.dispatch('LoseCard', { playerId: actorId, cardIds: [cardId], reason: GY_CHENSHE }, { sourceId: ownerId, targetId: actorId, cardIds: [cardId] })
    data.suits.push(suit)
    data.index += 1
    if (data.index < data.actors.length) {
      askChensheDiscard(host, ownerId, data)
      return
    }
    if (data.suits.length !== 3 || !data.suits.every((entry) => entry === data.suits[0])) return
    const target = host.state.players.find((item) => item.id === data.dyingId && item.alive)
    if (!target) return
    recover(host as never, target.id, target.maxHp - target.hp, ownerId)
    const owner = host.state.players.find((item) => item.id === ownerId)
    if (!owner) return
    owner.marks['b56-chenshe-used'] = 1
    owner.permanentlyLostSkills ??= []
    if (!owner.permanentlyLostSkills.includes(GY_CHENSHE)) owner.permanentlyLostSkills.push(GY_CHENSHE)
  },
})
