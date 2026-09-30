import type { CharacterDefinition } from './types'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, isCardUseProhibited, characterSkillIdsOf, ownedSkillIds, effectiveCardColor, grantSkill, getSkillRuntime, type SkillHost, type ViewAsOption } from '../../engine/skills/runtime'
import { moveCard, effectiveCardName } from '../../engine/zones'
import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { revealedGeneralFactionOf } from '../../engine/general-slots'
import { drawCards } from '../../engine/draw'
import { recoverTo } from '../../engine/recover'
import { gainMaxHp } from '../../engine/hp'
import { loseHp } from '../../engine/hp'
import { DAMAGE_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { beginSkillCardUseFromProcessing, skillProcessingCardUseActions } from '../../engine/cards/basic'
import { usedThisTurn, markUsedThisTurn } from '../../engine/turn-usage'
import { usedThisPhase, markUsedThisPhase } from '../../engine/phase-usage'
import { cardCategoryOfName } from '../../engine/damage-provenance'
import { ownedCardsOf, releaseDeathCards } from '../../engine/death-claim'
import { recover } from '../../engine/recover'
import { resolveDamage, continueDyingRescue } from '../../engine/damage'
import { reshuffleDrawPile } from '../../engine/deck'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { replaceTemporarySkills } from '../../engine/skills/runtime'
import { conversionStateOf, setConversionState, toggleConversionState } from '../../engine/conversion'

export const WENYUAN_KENGQIANG = 'kang-qiang-wenyuan-b90'
export const WENYUAN_KUICHI = 'kui-chi-wenyuan-b90'
export const WENYUAN_SHANGJUE = 'shang-jue-wenyuan-b90'
export const WENYUAN_KUNLI = 'kun-li-wenyuan-b90'
export const ZHUGEJING_YANZUO = 'yan-zuo-zhugejing-b90'
export const ZHUGEJING_ZUYIN = 'zu-yin-zhugejing-b90'
export const ZHUGEJING_BIJIAN = 'bi-jian-zhugejing-b90'
export const MOU_GUOJIA_XIANMOU = 'xian-mou-mouguojia-b90'
export const MOU_GUOJIA_LUNSHI = 'lun-shi-mouguojia-b90'
export const XING_XUNYU_ANSHU = 'an-shu-xingxunyu-b90'
export const XING_XUNYU_KUANGZUO = 'kuang-zuo-xingxunyu-b90'
export const XING_XUNYU_CHENGFENG = 'cheng-feng-xingxunyu-b90'
export const XING_XUNYU_TONGYIN = 'tong-yin-xingxunyu-b90'
export const QIQIAO_MAJUN_YULIAO = 'yu-liao-qiqiao-majun-b90'
export const QIQIAO_MAJUN_QIQIAO = 'qi-qiao-qiqiao-majun-b90'
export const QIQIAO_MAJUN_YANXIE = 'yan-xie-qiqiao-majun-b90'
export const CHUANXIE_MAJUN_CHUANXIE = 'chuan-xie-majun-b90'
export const CHUANXIE_MAJUN_QIAOSI = 'qiao-si-majun-b90'
export const LE_DIAOCHAN_TANBAN = 'tan-ban-lediaochan-b90'
export const LE_DIAOCHAN_DIYOU = 'di-you-lediaochan-b90'
export const YUANYIN_MOSHOU = 'mo-shou-yuanyin-b90'
export const YUANYIN_YUNJIU = 'yun-jiu-yuanyin-b90'
export const WU_HUANGFUSONG_CHAOZHEN = 'chao-zhen-wuhuangfusong-b90'
export const WU_HUANGFUSONG_LIANJIE = 'lian-jie-wuhuangfusong-b90'
export const WU_HUANGFUSONG_JIANGXIAN = 'jiang-xian-wuhuangfusong-b90'
export const PANGFENGYI_YITONG = 'yi-tong-pangfengyi-b90'
export const PANGFENGYI_PEINIANG = 'pei-niang-pangfengyi-b90'

type Batch90State = {
  previewingYanzuo?: boolean
  wenyuan?: Record<PlayerId, { turn: number; choices: string[]; option?: 'draw' | 'damage'; cardId?: CardId; dealt?: boolean; gainedCardIds?: CardId[]; drawn?: number; damage?: number; awakened?: boolean; kunliAwakened?: boolean }>
  zhugejing?: Record<PlayerId, { pile: CardId[]; playUses: number; lastUseTurn: number; maxUses: number }>
  qiqiaoYuliao?: Record<PlayerId, { pendingCardIds: CardId[]; queued: boolean }>
  guojia?: Record<PlayerId, { turn: number; lost: CardId[]; yiji?: boolean }>
  xunyu?: Record<PlayerId, { round: number; distributed: CardId[]; watched: PlayerId[] }>
  majunMaterials?: Record<PlayerId, CardId[]>
  majunDevice?: Record<CardId, { ownerId: PlayerId; kinds: CardCategory[] }>
  chuanshe?: Record<PlayerId, { suit: string; turnUsed?: number }>
  diaochan?: Record<PlayerId, { marked: CardId[]; seenNames: string[]; seenTurn?: number; lastTransferTurn?: number }>
  yuanyin?: Record<PlayerId, { nextDraw: number }>
  huangfusong?: Record<PlayerId, { turn: number; usedTargets: PlayerId[]; empoweredIds: CardId[]; extraDamage: number; limited?: boolean }>
  huangfusongChaozhenDisabled?: Record<PlayerId, number>
  huangfusongLianjiePoints?: Record<PlayerId, { turn: number; points: number[] }>
  pangfengyi?: Record<PlayerId, { suit?: string; turn: number; used?: boolean }>
  pangfengyiUsedCards?: Record<PlayerId, CardId[]>
  xunyuAnshu?: Record<PlayerId, { cardIds: CardId[]; expiresAfterRound: number; lossesByTurn: Record<number, PlayerId[]> }>
  xunyuKuangzuo?: Record<PlayerId, { targetId?: PlayerId; donorId?: PlayerId; selected: CardId[] }>
}
const dataOf = (state: SanguoshaState): Batch90State => {
  const mutable = state as SanguoshaState & { paperSanguoshaB90?: Batch90State }
  return mutable.paperSanguoshaB90 ??= {}
}
const playerOf = (state: SanguoshaState, id: PlayerId) => state.players.find((player) => player.id === id)
const alivePlayers = (state: SanguoshaState) => state.players.filter((player) => player.alive)
const turnState = (state: SanguoshaState, playerId: PlayerId) => {
  const table = dataOf(state).wenyuan ??= {}
  return table[playerId] ??= { turn: state.turnNumber, choices: [] }
}
const cardIsDamage = (name: string) => name === '杀' || name.endsWith('杀') || name === '火攻' || name === '决斗'
  || DAMAGE_TRICKS.has(name)
const suitCycle = ['spade', 'heart', 'club', 'diamond'] as const
const categories: readonly CardCategory[] = ['basic', 'trick', 'equipment']
const actorCandidates = (state: SanguoshaState, ownerId: PlayerId) => state.players.filter((player) => player.alive && player.id !== ownerId)
const isZhugeJingUseCard = (state: SanguoshaState, cardId: CardId) => {
  const card = state.cards[cardId]
  return card?.category === 'basic' || (card?.category === 'trick' && INSTANT_TRICKS.has(effectiveCardName(state, cardId)))
}
const zhugeJingUseActions = (state: SanguoshaState, ownerId: PlayerId, cardId: CardId) => {
  const simulated = structuredClone(state)
  dataOf(simulated).previewingYanzuo = true
  const owner = playerOf(simulated, ownerId)
  if (owner?.zones.hand.includes(cardId)) moveCard(simulated, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
  else if (owner?.characterPiles.yanzuo?.includes(cardId)) moveCard(simulated, cardId,
    { kind: 'characterPile', playerId: ownerId, pile: 'yanzuo' }, { kind: 'processingArea' })
  else return []
  return skillProcessingCardUseActions(simulated, ownerId, cardId)
}
const skillRequest = (host: SkillHost, ownerId: PlayerId, skillId: string, step: string, data: Record<string, unknown>, build: (id: string) => ChooseCardsRequest | ChooseOptionRequest | ChooseTargetsRequest) =>
  host.askSkill({ skillId, ownerId, step, data, build })
const diaochanUseActions = (state: SanguoshaState, ownerId: PlayerId, cardId: CardId) => {
  const simulated = structuredClone(state)
  const owner = playerOf(simulated, ownerId)
  if (!owner?.zones.hand.includes(cardId)) return []
  moveCard(simulated, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
  return skillProcessingCardUseActions(simulated, ownerId, cardId)
}

export const WENYUAN_B90: CharacterDefinition = {
  id: 'wenyuan-b90', name: '文鸳', kingdom: 'shu', gender: 'female', maxHp: 4, pack: 'sp', skills: [
    { id: WENYUAN_KENGQIANG, name: '铿锵', description: '每回合限一次，当你使用伤害牌时，你可以选择一项：1.摸X张牌（X为你的体力上限）；2.此牌伤害+1，且你获得造成伤害的牌。' },
    { id: WENYUAN_KUICHI, name: '匮饬', description: '锁定技，回合结束时，若你本回合摸牌数和造成的伤害值均大于等于你的体力上限，你失去1点体力。' },
    { id: WENYUAN_SHANGJUE, name: '殇决', description: '觉醒技，你进入濒死状态时，将体力值回复至1点，加1点体力上限并获得“困励”，然后将“铿锵”改为每回合每项限一次。' },
    { id: WENYUAN_KUNLI, name: '困励', description: '觉醒技，你进入濒死状态时，将体力回复至2点，加1点体力上限并失去“匮饬”。', granted: true },
  ],
}

registerSkillRuntime({
  id: WENYUAN_KENGQIANG,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (!payload.cardId || !payload.cardName || !cardIsDamage(payload.cardName)) return
      const state = turnState(host.state, ownerId)
      if (state.turn !== host.state.turnNumber) Object.assign(state, { turn: host.state.turnNumber, choices: [], option: undefined, cardId: undefined, dealt: false })
      const available = state.awakened
        ? ['draw', 'damage'].filter((option) => !state.choices.includes(option))
        : state.choices.length ? [] : ['draw', 'damage']
      if (!available.length) return
      state.cardId = payload.cardId
      host.queueSkill({ skillId: WENYUAN_KENGQIANG, ownerId, step: 'choice', data: { cardId: payload.cardId, options: available } })
    } },
    { event: 'DamageCaused', handle(host, ownerId, context) {
      const state = dataOf(host.state).wenyuan?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId; amount?: number }
      if (context.event.sourceId !== ownerId || state?.option !== 'damage' || state.cardId !== payload.cardId) return
      payload.amount = Math.max(0, Number(payload.amount ?? 0)) + 1
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const state = dataOf(host.state).wenyuan?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId | null; finalAmount?: number }
      if (context.event.sourceId === ownerId && state?.option === 'damage' && state.cardId === payload.cardId && (payload.finalAmount ?? 0) > 0)
        state.dealt = true
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const state = dataOf(host.state).wenyuan?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId }
      const cardId = payload.cardId
      if (context.event.sourceId !== ownerId || !cardId || state?.option !== 'damage' || state.cardId !== cardId || !state.dealt) return
      const destination = host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const }
        : host.state.zones.processingArea.includes(cardId) ? { kind: 'processingArea' as const } : null
      if (destination) moveCard(host.state, cardId, destination, { kind: 'hand', playerId: ownerId })
      state.gainedCardIds ??= []
      if (!state.gainedCardIds.includes(cardId)) state.gainedCardIds.push(cardId)
      state.option = undefined
      state.dealt = false
    } },
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; isDraw?: boolean }
      if (payload.playerId !== ownerId || !payload.isDraw) return
      const state = turnState(host.state, ownerId)
      if (state.turn !== host.state.turnNumber) Object.assign(state, { turn: host.state.turnNumber, choices: [], drawn: 0, damage: 0 })
      state.drawn = (state.drawn ?? 0) + (payload.cardIds?.length ?? 0)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || (context.event.payload as { finalAmount?: number }).finalAmount === undefined) return
      const state = turnState(host.state, ownerId)
      if (state.turn !== host.state.turnNumber) Object.assign(state, { turn: host.state.turnNumber, choices: [], drawn: 0, damage: 0 })
      state.damage = (state.damage ?? 0) + Math.max(0, Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0))
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const state = dataOf(host.state).wenyuan?.[ownerId]
      const owner = playerOf(host.state, ownerId)
      if (owner?.alive && ownedSkillIds(host.state, ownerId, characterSkillIdsOf).includes(WENYUAN_KUICHI)
        && state && state.turn === host.state.turnNumber
        && (state.drawn ?? 0) >= owner.maxHp && (state.damage ?? 0) >= owner.maxHp) loseHp(host as never, ownerId, 1, WENYUAN_KUICHI)
      if (state) Object.assign(state, { turn: host.state.turnNumber + 1, choices: [], option: undefined, cardId: undefined, dealt: false, drawn: 0, damage: 0 })
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      const state = turnState(host.state, ownerId)
      if (!owner?.alive) return
      if (!state.awakened) {
        state.awakened = true
        owner.awakenedSkills ??= []
        if (!owner.awakenedSkills.includes(WENYUAN_SHANGJUE)) owner.awakenedSkills.push(WENYUAN_SHANGJUE)
        gainMaxHp(host as never, ownerId, 1, WENYUAN_SHANGJUE)
        owner.grantedSkills ??= []
        if (!owner.grantedSkills.includes(WENYUAN_KUNLI)) owner.grantedSkills.push(WENYUAN_KUNLI)
        recoverTo(host as never, ownerId, 1, WENYUAN_SHANGJUE)
        return
      }
      if (!state.kunliAwakened && owner.grantedSkills?.includes(WENYUAN_KUNLI)) {
        state.kunliAwakened = true
        owner.awakenedSkills ??= []
        if (!owner.awakenedSkills.includes(WENYUAN_KUNLI)) owner.awakenedSkills.push(WENYUAN_KUNLI)
        gainMaxHp(host as never, ownerId, 1, WENYUAN_KUNLI)
        owner.permanentlyLostSkills ??= []
        if (!owner.permanentlyLostSkills.includes(WENYUAN_KUICHI)) owner.permanentlyLostSkills.push(WENYUAN_KUICHI)
        recoverTo(host as never, ownerId, 2, WENYUAN_KUNLI)
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choice') return
    const options = (prompt.data.options as string[]).map((id) => ({ id, label: id === 'draw' ? `摸${playerOf(host.state, ownerId)?.maxHp ?? 0}张牌` : '此牌伤害+1，造成伤害后获得此牌' }))
    host.askSkill({ skillId: WENYUAN_KENGQIANG, ownerId, step: 'choice', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【铿锵】：选择一项', timeoutMs: 25_000, optional: true, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice') return
    const choice = (response.payload as { optionId?: string }).optionId
    const allowed = resolution.data.options as string[]
    const state = turnState(host.state, ownerId)
    if (!choice || !allowed.includes(choice)) return
    const useId = state.awakened ? `${WENYUAN_KENGQIANG}:${choice}` : WENYUAN_KENGQIANG
    if (usedThisTurn(host.state, ownerId, useId)) return
    markUsedThisTurn(host.state, ownerId, useId)
    if (state.awakened) state.choices.push(choice)
    else state.choices = [choice]
    state.option = choice as 'draw' | 'damage'
    if (choice === 'draw') {
      drawCards(host.state, host.rng, ownerId, playerOf(host.state, ownerId)?.maxHp ?? 0, (name, payload) => host.dispatch(name, payload))
      state.option = undefined
    }
  },
})

registerSkillRuntime({ id: WENYUAN_KUICHI })
registerSkillRuntime({ id: WENYUAN_SHANGJUE, limited: false })
registerSkillRuntime({ id: WENYUAN_KUNLI, limited: false })

export const ZHUGEJING_B90: CharacterDefinition = {
  id: 'zhugejing-b90', name: '诸葛京', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZHUGEJING_YANZUO, name: '研作', description: '出牌阶段限一次，将1张牌置于你武将牌上，然后视为使用1张你武将牌上已有的基本或普通锦囊牌。' },
    { id: ZHUGEJING_ZUYIN, name: '祖荫', description: '锁定技，你成为其他角色使用的【杀】或普通锦囊牌的目标后，若你武将牌上：没有同名牌，令“研作”的发动次数+1（至多为3），然后从牌堆或弃牌堆中将1张同名牌置于你武将牌上；有同名牌，令此牌无效并弃置你武将牌上的全部同名牌。' },
    { id: ZHUGEJING_BIJIAN, name: '辟剑', description: '锁定技，结束阶段，若你武将牌上的牌数大于等于存活角色数，弃置这些牌，然后对一名角色造成2点伤害。' },
  ],
}

registerSkillRuntime({
  id: ZHUGEJING_YANZUO,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || dataOf(state).previewingYanzuo || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const progress = dataOf(state).zhugejing?.[ownerId]
    const uses = progress?.lastUseTurn === state.turnNumber ? progress.playUses : 0
    const maxUses = progress?.maxUses ?? 1
    if (uses >= maxUses) return []
    const possible = [...owner.zones.hand, ...(owner.characterPiles.yanzuo ?? [])]
    if (!possible.some((cardId) => isZhugeJingUseCard(state, cardId) && zhugeJingUseActions(state, ownerId, cardId).length > 0)) return []
    return [{ id: `skill:${ZHUGEJING_YANZUO}`, label: '发动【研作】：置一张牌于武将牌上并使用其中一张牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${ZHUGEJING_YANZUO}`) throw new Error('诸葛京【研作】动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
    const progress = (dataOf(host.state).zhugejing ??= {})[ownerId] ??= { pile: [], playUses: 0, lastUseTurn: host.state.turnNumber, maxUses: 1 }
    if (progress.lastUseTurn !== host.state.turnNumber) {
      progress.playUses = 0
      progress.lastUseTurn = host.state.turnNumber
    }
    if (progress.playUses >= progress.maxUses) return
    progress.playUses += 1
    const hand = owner.zones.hand
    if (!hand.length) return
    host.askSkill({ skillId: ZHUGEJING_YANZUO, ownerId, step: 'place-card', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【研作】：选择一张手牌置于武将牌上', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: hand, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const progress = (dataOf(host.state).zhugejing ??= {})[ownerId]
      if (progress) {
        progress.playUses = 0
        progress.lastUseTurn = host.state.turnNumber
      }
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
      if (context.event.sourceId !== ownerId || payload.sourceSkillId !== ZHUGEJING_YANZUO || !payload.cardId) return
      const progress = dataOf(host.state).zhugejing?.[ownerId]
      if (progress) progress.pile = progress.pile.filter((cardId) => cardId !== payload.cardId)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-pile-card') return
    const pile = playerOf(host.state, ownerId)?.characterPiles.yanzuo ?? []
    const candidates = pile.filter((cardId) => isZhugeJingUseCard(host.state, cardId)
      && zhugeJingUseActions(host.state, ownerId, cardId).length > 0)
    if (!candidates.length) return
    host.askSkill({ skillId: ZHUGEJING_YANZUO, ownerId, step: 'choose-pile-card', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【研作】：选择武将牌上的一张基本牌或普通锦囊牌使用',
      timeoutMs: 25_000, optional: false, options: candidates.map((cardId) => ({
        id: cardId, label: `使用【${effectiveCardName(host.state, cardId)}】`,
      })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'place-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = playerOf(host.state, ownerId)
      if (!cardId || !owner?.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: 'yanzuo' })
      const progress = (dataOf(host.state).zhugejing ??= {})[ownerId] ??= { pile: [], playUses: 0, lastUseTurn: host.state.turnNumber, maxUses: 1 }
      progress.pile.push(cardId)
      host.queueSkill({ skillId: ZHUGEJING_YANZUO, ownerId, step: 'choose-pile-card', data: {} })
      return
    }
    if (resolution.step === 'choose-pile-card') {
      const cardId = (response.payload as { optionId?: string }).optionId as CardId | undefined
      if (!cardId || !playerOf(host.state, ownerId)?.characterPiles.yanzuo?.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'yanzuo' }, { kind: 'processingArea' })
      const actions = skillProcessingCardUseActions(host.state, ownerId, cardId)
      if (!actions.length) {
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'characterPile', playerId: ownerId, pile: 'yanzuo' })
        return
      }
      if (actions.length === 1) {
        const begun = beginSkillCardUseFromProcessing(host as never, ownerId, cardId, ZHUGEJING_YANZUO, actions[0]!.id)
        if (!begun && host.state.zones.processingArea.includes(cardId))
          moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'characterPile', playerId: ownerId, pile: 'yanzuo' })
        return
      }
      host.askSkill({ skillId: ZHUGEJING_YANZUO, ownerId, step: 'choose-use-action', data: { cardId, actions }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【研作】：选择使用【${effectiveCardName(host.state, cardId)}】的合法目标`,
        timeoutMs: 25_000, optional: false, options: actions.map((action) => ({ id: action.id, label: action.label })),
      }) })
      return
    }
    if (resolution.step === 'choose-use-action') {
      const cardId = resolution.data.cardId as CardId
      const actionId = (response.payload as { optionId?: string }).optionId
      const actionIds = (resolution.data.actions as Array<{ id: string }>).map((action) => action.id)
      if (actionId && actionIds.includes(actionId) && host.state.zones.processingArea.includes(cardId)) {
        const begun = beginSkillCardUseFromProcessing(host as never, ownerId, cardId, ZHUGEJING_YANZUO, actionId)
        if (!begun && host.state.zones.processingArea.includes(cardId))
          moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'characterPile', playerId: ownerId, pile: 'yanzuo' })
      }
    }
  },
})

const resolveZhugeJingZuYinTarget = (host: SkillHost, ownerId: PlayerId, context: {
  sourceId: PlayerId; cardId: CardId; cardName: string; category: CardCategory
}): boolean => {
    if (context.sourceId === ownerId || (context.category !== 'basic' && context.category !== 'trick')) return false
    if (context.category === 'trick' && !INSTANT_TRICKS.has(context.cardName)) return false
    if (context.category === 'basic' && context.cardName !== '杀' && !context.cardName.endsWith('杀')) return false
    const pile = playerOf(host.state, ownerId)?.characterPiles.yanzuo ?? []
    const matching = pile.filter((cardId) => effectiveCardName(host.state, cardId) === context.cardName)
    if (matching.length) {
      for (const cardId of matching)
        moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'yanzuo' }, { kind: 'discardPile' }, { discardReason: 'discard' })
      return true
    }
    const progress = (dataOf(host.state).zhugejing ??= {})[ownerId] ??= { pile: [], playUses: 0, lastUseTurn: host.state.turnNumber, maxUses: 1 }
    progress.maxUses = Math.min(3, progress.maxUses + 1)
    const candidate = host.state.zones.discardPile.find((cardId) => effectiveCardName(host.state, cardId) === context.cardName)
      ?? host.state.zones.drawPile.find((cardId) => effectiveCardName(host.state, cardId) === context.cardName)
    if (candidate) {
      const from = host.state.zones.discardPile.includes(candidate) ? { kind: 'discardPile' as const } : { kind: 'drawPile' as const }
      moveCard(host.state, candidate, from, { kind: 'characterPile', playerId: ownerId, pile: 'yanzuo' })
      progress.pile.push(candidate)
    }
    return false
}

registerSkillRuntime({
  id: ZHUGEJING_ZUYIN,
  cancelsBecomingTarget(host, ownerId, context) {
    return resolveZhugeJingZuYinTarget(host, ownerId, context)
  },
  interceptTarget(host, ownerId, context) {
    if (context.category !== 'basic' || (context.cardName !== '杀' && !context.cardName.endsWith('杀'))) return false
    if (resolveZhugeJingZuYinTarget(host, ownerId, context) && host.state.cardResolution?.kind === 'slash')
      host.state.cardResolution.targetCancelled = true
    return false
  },
})

registerSkillRuntime({
  id: ZHUGEJING_BIJIAN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    const pile = owner?.characterPiles.yanzuo ?? []
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || !owner?.alive
      || pile.length < alivePlayers(host.state).length) return
    host.queueSkill({ skillId: ZHUGEJING_BIJIAN, ownerId, step: 'target', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    const candidates = alivePlayers(host.state)
    if (!owner?.alive || (owner.characterPiles.yanzuo?.length ?? 0) < candidates.length || !candidates.length) return
    host.askSkill({ skillId: ZHUGEJING_BIJIAN, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【辟剑】：弃置“研作”牌后，对一名角色造成2点伤害',
      timeoutMs: 25_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const pile = owner?.characterPiles.yanzuo ?? []
    if (!targetId || !owner?.alive || !target?.alive || pile.length < alivePlayers(host.state).length) return
    for (const cardId of [...pile])
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'yanzuo' }, { kind: 'discardPile' }, { discardReason: 'discard' })
    const liveTarget = playerOf(host.state, targetId)
    if (liveTarget?.alive) resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 2, sourceSkillId: ZHUGEJING_BIJIAN })
  },
})

export const MOU_GUOJIA_B90: CharacterDefinition = {
  id: 'mou-guojia-b90', name: '谋·郭嘉', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: MOU_GUOJIA_XIANMOU, name: '先谋', description: '转换技，游戏开始时可自选阴阳状态。每个回合结束时，若你本回合失去过牌，你可以：阳：观看牌堆顶五张牌并获得至多X张牌，未达到X获得“遗计”直到再发动此项；阴：观看一名角色手牌并弃置其中至多X张牌，达到X你判定一次【闪电】。（X为本回合你失去牌数）' },
    { id: MOU_GUOJIA_LUNSHI, name: '论势', description: '其他角色对其以外的角色使用普通锦囊牌时，若你两种颜色手牌数相同，你可将一张手牌当不可被响应的【无懈可击】使用。' },
  ],
}

const XIANMOU_LIGHTNING_JUDGE = `${MOU_GUOJIA_XIANMOU}:lightning`
registerJudgmentContinuation(XIANMOU_LIGHTNING_JUDGE, (host, result, data) => {
  const ownerId = data.ownerId as PlayerId
  const targetId = data.targetId as PlayerId
  if (result.suit === 'spade' && result.rank >= 2 && result.rank <= 9 && playerOf(host.state, targetId)?.alive)
    resolveDamage(host, { targetId, amount: 3, nature: 'thunder', cardName: '闪电' })
  const next = toggleConversionState(host.state, ownerId, MOU_GUOJIA_XIANMOU)
  host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: MOU_GUOJIA_XIANMOU, state: next }, {
    sourceId: ownerId, sourceSkillId: MOU_GUOJIA_XIANMOU,
  })
})

registerSkillRuntime({
  id: MOU_GUOJIA_XIANMOU,
  onGameStart(host, ownerId) {
    if (!playerOf(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: MOU_GUOJIA_XIANMOU, ownerId, step: 'initial-mode', data: {} })
  },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    const loss = host.state.handCardLossThisTurn
    const count = loss?.turnNumber === host.state.turnNumber ? loss.counts[ownerId] ?? 0 : 0
    if (!owner?.alive || count <= 0) return
    host.queueSkill({ skillId: MOU_GUOJIA_XIANMOU, ownerId, step: 'invoke', data: {
      count, mode: conversionStateOf(host.state, ownerId, MOU_GUOJIA_XIANMOU),
    } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (!playerOf(host.state, ownerId)?.alive) return
    if (prompt.step === 'initial-mode') {
      host.askSkill({ skillId: MOU_GUOJIA_XIANMOU, ownerId, step: 'initial-mode', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【先谋】：选择转换技的初始状态', timeoutMs: 25_000, optional: false,
        options: [{ id: 'yang', label: '阳：观看并获得牌' }, { id: 'yin', label: '阴：观看并弃置手牌' }],
      }) })
      return
    }
    if (prompt.step === 'invoke') {
      const { count, mode } = prompt.data as { count: number; mode: 'yin' | 'yang' }
      host.askSkill({ skillId: MOU_GUOJIA_XIANMOU, ownerId, step: 'invoke', data: { count, mode }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【先谋】：本回合你失去${count}张手牌，是否发动？（${mode === 'yang' ? '阳' : '阴'}）`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step === 'yang-select') {
      const cardIds = prompt.data.cardIds as CardId[]
      const count = prompt.data.count as number
      const available = cardIds.filter((cardId) => host.state.zones.drawPile.includes(cardId))
      host.askSkill({ skillId: MOU_GUOJIA_XIANMOU, ownerId, step: 'yang-select', data: { count, cardIds: available }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【先谋·阳】：获得至多${Math.min(count, available.length)}张牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: available, hiddenCardSlots: [], min: 0, max: Math.min(count, available.length),
      }) })
      return
    }
    if (prompt.step === 'yin-target') {
      const candidates = alivePlayers(host.state).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_GUOJIA_XIANMOU, ownerId, step: 'yin-target', data: prompt.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【先谋·阴】：选择一名角色观看其手牌并弃置其中至多X张',
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'initial-mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode === 'yin' || mode === 'yang') setConversionState(host.state, ownerId, MOU_GUOJIA_XIANMOU, mode)
      return
    }
    if (resolution.step === 'invoke') {
      const result = response.payload as { optionId?: string }
      if (result.optionId !== 'yes' || !playerOf(host.state, ownerId)?.alive) return
      const count = Math.max(0, Math.trunc(Number(resolution.data.count) || 0))
      const mode = conversionStateOf(host.state, ownerId, MOU_GUOJIA_XIANMOU)
      replaceTemporarySkills(host.state, ownerId, `${MOU_GUOJIA_XIANMOU}:yiji`, [])
      if (mode === 'yang') {
        while (host.state.zones.drawPile.length < 5 && host.state.zones.discardPile.length)
          reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
        const cardIds = host.state.zones.drawPile.slice(0, 5)
        if (!cardIds.length) {
          replaceTemporarySkills(host.state, ownerId, `${MOU_GUOJIA_XIANMOU}:yiji`, ['yiji'])
          const next = toggleConversionState(host.state, ownerId, MOU_GUOJIA_XIANMOU)
          host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: MOU_GUOJIA_XIANMOU, state: next }, {
            sourceId: ownerId, sourceSkillId: MOU_GUOJIA_XIANMOU,
          })
          return
        }
        host.askSkill({ skillId: MOU_GUOJIA_XIANMOU, ownerId, step: 'yang-select', data: { count, cardIds }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: `【先谋·阳】：观看牌堆顶${cardIds.length}张牌，获得至多${Math.min(count, cardIds.length)}张`,
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: Math.min(count, cardIds.length),
        }) })
      } else {
        host.queueSkill({ skillId: MOU_GUOJIA_XIANMOU, ownerId, step: 'yin-target', data: { count } })
      }
      return
    }
    if (resolution.step === 'yang-select') {
      const count = Math.max(0, Math.trunc(Number(resolution.data.count) || 0))
      const candidates = new Set(resolution.data.cardIds as CardId[])
      const selected = ((response.payload as { cardIds?: CardId[] }).cardIds ?? [])
        .filter((cardId) => candidates.has(cardId) && host.state.zones.drawPile.includes(cardId))
      for (const cardId of selected) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      if (selected.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: selected, reason: MOU_GUOJIA_XIANMOU }, {
        sourceId: ownerId, targetId: ownerId, cardIds: selected,
      })
      if (selected.length < count) replaceTemporarySkills(host.state, ownerId, `${MOU_GUOJIA_XIANMOU}:yiji`, ['yiji'])
      const next = toggleConversionState(host.state, ownerId, MOU_GUOJIA_XIANMOU)
      host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: MOU_GUOJIA_XIANMOU, state: next }, {
        sourceId: ownerId, sourceSkillId: MOU_GUOJIA_XIANMOU,
      })
      host.dispatch('SkillActivated', { skillId: MOU_GUOJIA_XIANMOU, skillName: '先谋', playerId: ownerId,
        mode: 'yang', lostCards: count, gainedCardIds: selected }, { sourceId: ownerId, targetId: ownerId, cardIds: selected })
      return
    }
    if (resolution.step === 'yin-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const count = Math.max(0, Math.trunc(Number(resolution.data.count) || 0))
      if (!target?.alive) return
      host.askSkill({ skillId: MOU_GUOJIA_XIANMOU, ownerId, step: 'yin-discard', data: { targetId, count }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【先谋·阴】：观看${target.nickname}的手牌，弃置其中至多${count}张`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0,
        max: Math.min(count, target.zones.hand.length),
      }) })
      return
    }
    if (resolution.step === 'yin-discard') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const count = Math.max(0, Math.trunc(Number(resolution.data.count) || 0))
      const selected = ((response.payload as { cardIds?: CardId[] }).cardIds ?? [])
        .filter((cardId) => target?.zones.hand.includes(cardId))
      for (const cardId of selected)
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' }, { discardReason: 'discard' })
      if (selected.length) host.dispatch('LoseCard', { playerId: targetId, cardIds: selected, reason: 'discard' }, {
        sourceId: ownerId, targetId, cardIds: selected,
      })
      host.dispatch('SkillActivated', { skillId: MOU_GUOJIA_XIANMOU, skillName: '先谋', playerId: ownerId,
        targetId, mode: 'yin', lostCards: count, discardedCardIds: selected }, { sourceId: ownerId, targetId, cardIds: selected })
      if (selected.length === count && count > 0 && playerOf(host.state, ownerId)?.alive)
        performJudgment(host as never, ownerId, '闪电', { tag: XIANMOU_LIGHTNING_JUDGE, data: { ownerId, targetId: ownerId } })
      else {
        const next = toggleConversionState(host.state, ownerId, MOU_GUOJIA_XIANMOU)
        host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: MOU_GUOJIA_XIANMOU, state: next }, {
          sourceId: ownerId, sourceSkillId: MOU_GUOJIA_XIANMOU,
        })
      }
    }
  },
})

registerSkillRuntime({
  id: MOU_GUOJIA_LUNSHI,
  globalResponseViewAs(state, ownerId, responderId, requiredCardName): ViewAsOption[] {
    if (responderId !== ownerId || requiredCardName !== '无懈可击') return []
    const resolution = state.cardResolution
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || !resolution || resolution.kind !== 'trick'
      || !INSTANT_TRICKS.has(resolution.cardName)
      || resolution.sourceId === ownerId
      || resolution.targetIds.includes(ownerId)) return []
    const targetId = resolution.targetIds[resolution.targetIndex]
    if (!targetId || targetId === resolution.sourceId) return []
    const hand = owner.zones.hand.filter((cardId) => Boolean(state.cards[cardId]))
    const red = hand.filter((cardId) => effectiveCardColor(state, ownerId, cardId) === 'red').length
    const black = hand.filter((cardId) => effectiveCardColor(state, ownerId, cardId) === 'black').length
    if (red !== black) return []
    return hand.map((cardId) => ({ asCardName: '无懈可击', cardId, label: '论势：不可被响应的【无懈可击】' }))
  },
  globalUnanswerableResponses: ['无懈可击'],
})

export const XING_XUNYU_B90: CharacterDefinition = {
  id: 'xing-xunyu-b90', name: '星·荀彧', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: XING_XUNYU_ANSHU, name: '安庶', description: '每轮结束时，你可以将弃牌堆中牌名不同的基本牌各一张置于牌堆顶，然后视为使用一张【五谷丰登】，你选择从自己或一名受伤角色开始结算。下轮结束前，若有角色失去了以此法选择的牌，此回合结束时你可令其将手牌摸至体力上限（最多摸到5张）。' },
    { id: XING_XUNYU_KUANGZUO, name: '匡祚', description: '限定技，出牌阶段，你可以令一名角色获得“承奉”（若其为主公且没有主公技，则额外获得“统荫”），然后令另一名角色将每种花色各一张牌置于获得技能角色的武将牌上，称为“匡祚”。' },
    { id: XING_XUNYU_CHENGFENG, name: '承奉', description: '每回合限一次，当一张牌即将对你生效时，你可以将一张红色/黑色“匡祚”当【闪】/【无懈可击】使用；结算后，若“匡祚”不足两种颜色，你可以将牌堆顶的一张牌置为“匡祚”。', granted: true },
    { id: XING_XUNYU_TONGYIN, name: '统荫', description: '主公技。当你受到其他角色使用牌造成的伤害后，若其与你势力相同/不同，你可以将对你造成伤害的牌/该角色的一张牌置入“匡祚”。', granted: true },
  ],
}

registerSkillRuntime({
  id: XING_XUNYU_ANSHU,
  triggers: [
    { event: 'RoundEnd', handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      const state = dataOf(host.state).xunyuAnshu ??= {}
      const entry = state[ownerId]
      if (entry && host.state.roundNumber >= entry.expiresAfterRound)
        delete state[ownerId]
      if (!owner?.alive) return
      const uniqueNames = new Set(host.state.zones.discardPile
        .filter((cardId) => host.state.cards[cardId]?.category === 'basic')
        .map((cardId) => effectiveCardName(host.state, cardId)))
      if (uniqueNames.size) host.queueSkill({ skillId: XING_XUNYU_ANSHU, ownerId, step: 'choose-cards', data: {} })
    } },
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; playerId?: PlayerId }
      if (!payload.cardId || !payload.playerId) return
      const entry = dataOf(host.state).xunyuAnshu?.[ownerId]
      if (!entry?.cardIds.includes(payload.cardId)) return
      const players = entry.lossesByTurn[host.state.turnNumber] ??= []
      if (!players.includes(payload.playerId)) players.push(payload.playerId)
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      const entry = dataOf(host.state).xunyuAnshu?.[ownerId]
      const affected = entry?.lossesByTurn[host.state.turnNumber] ?? []
      if (!playerOf(host.state, ownerId)?.alive || !affected.length) return
      delete entry!.lossesByTurn[host.state.turnNumber]
      for (const targetId of affected)
        host.queueSkill({ skillId: XING_XUNYU_ANSHU, ownerId, step: 'draw-after-loss', data: { targetId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (!playerOf(host.state, ownerId)?.alive) return
    if (prompt.step === 'choose-cards') {
      const basicCards = host.state.zones.discardPile.filter((cardId) => host.state.cards[cardId]?.category === 'basic')
      const names = new Set(basicCards.map((cardId) => effectiveCardName(host.state, cardId)))
      if (!names.size) return
      host.askSkill({ skillId: XING_XUNYU_ANSHU, ownerId, step: 'choose-cards', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【安庶】：选择牌名各不相同的基本牌置于牌堆顶并使用【五谷丰登】',
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: basicCards, hiddenCardSlots: [], min: 0, max: names.size,
      }) })
      return
    }
    if (prompt.step === 'choose-start') {
      const candidates = host.state.players.filter((player) => player.alive
        && (player.id === ownerId || player.hp < player.maxHp)).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: XING_XUNYU_ANSHU, ownerId, step: 'choose-start', data: prompt.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【安庶】：选择自己或一名受伤角色作为【五谷丰登】的首个结算目标',
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'draw-after-loss') {
      const targetId = prompt.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      host.askSkill({ skillId: XING_XUNYU_ANSHU, ownerId, step: 'draw-after-loss', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【安庶】：是否令${target.nickname}将手牌摸至体力上限（最多5张）？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '令其摸牌' }, { id: 'no', label: '不发动' }],
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (!playerOf(host.state, ownerId)?.alive) return
    if (resolution.step === 'choose-cards') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const names = selected.map((cardId) => effectiveCardName(host.state, cardId))
      if (selected.length === 0 || new Set(selected).size !== selected.length || new Set(names).size !== names.length
        || selected.some((cardId) => !host.state.zones.discardPile.includes(cardId) || host.state.cards[cardId]?.category !== 'basic')) return
      const pile = dataOf(host.state).xunyuAnshu ??= {}
      pile[ownerId] = { cardIds: [...selected], expiresAfterRound: host.state.roundNumber + 1, lossesByTurn: {} }
      for (const cardId of [...selected].reverse())
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'drawPile' }, { toTop: true })
      host.queueSkill({ skillId: XING_XUNYU_ANSHU, ownerId, step: 'choose-start', data: { selected } })
      return
    }
    if (resolution.step === 'choose-start') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || (target.id !== ownerId && target.hp >= target.maxHp)) return
      const alive = alivePlayers(host.state).sort((left, right) => left.seat - right.seat)
      const start = alive.findIndex((player) => player.id === target.id)
      if (start < 0) return
      const targetIds = [...alive.slice(start), ...alive.slice(0, start)].map((player) => player.id)
      const selected = resolution.data.selected as CardId[]
      if (!host.beginVirtualTrick({ sourceId: ownerId, targetIds, cardName: '五谷丰登', sourceSkillId: XING_XUNYU_ANSHU })) {
        delete dataOf(host.state).xunyuAnshu?.[ownerId]
        for (const cardId of selected)
          if (host.state.zones.drawPile.includes(cardId))
            moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' }, { discardReason: 'other' })
        return
      }
      host.dispatch('SkillActivated', { skillId: XING_XUNYU_ANSHU, skillName: '安庶', playerId: ownerId,
        targetId, cardIds: selected }, { sourceId: ownerId, targetId, cardIds: selected })
      return
    }
    if (resolution.step === 'draw-after-loss'
      && (response.payload as { optionId?: string }).optionId === 'yes') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const targetCount = Math.min(5, target.maxHp)
      const missing = Math.max(0, targetCount - target.zones.hand.length)
      if (missing) drawCards(host.state, host.rng, targetId, missing, (name, payload) => host.dispatch(name, payload))
      host.dispatch('SkillActivated', { skillId: XING_XUNYU_ANSHU, skillName: '安庶', playerId: ownerId,
        targetId, drawn: missing }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: XING_XUNYU_KUANGZUO,
  limited: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || owner.usedLimitedSkills.includes(XING_XUNYU_KUANGZUO)) return []
    const eligible = state.players.filter((player) => player.alive)
    const donorAvailable = eligible.some((donor) => suitCycle.every((suit) => donor.zones.hand.some((cardId) => state.cards[cardId]?.suit === suit)))
    return eligible.length >= 2 && donorAvailable ? [{ id: `skill:${XING_XUNYU_KUANGZUO}`, label: '匡祚：授予承奉并置入四种花色的牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${XING_XUNYU_KUANGZUO}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || owner.usedLimitedSkills.includes(XING_XUNYU_KUANGZUO)
      || alivePlayers(host.state).length < 2) return
    host.askSkill({ skillId: XING_XUNYU_KUANGZUO, ownerId, step: 'beneficiary', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【匡祚】：选择获得“承奉”的角色', timeoutMs: 25_000,
      optional: true, candidateIds: alivePlayers(host.state).map((player) => player.id), min: 1, max: 1,
    }) })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'donor-card') return
    const donorId = prompt.data.donorId as PlayerId
    const suit = suitCycle[Number(prompt.data.index)]
    const donor = playerOf(host.state, donorId)
    const candidates = donor?.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === suit
      && !(prompt.data.selected as CardId[]).includes(cardId)) ?? []
    if (!donor?.alive || !candidates.length || !suit) return
    host.askSkill({ skillId: XING_XUNYU_KUANGZUO, ownerId, step: 'donor-card', data: prompt.data, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: donorId, prompt: `【匡祚】：请交出一张${({ spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方片' } as const)[suit]}手牌`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'beneficiary') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const candidates = alivePlayers(host.state).filter((player) => player.id !== targetId && suitCycle.every((suit) =>
        player.zones.hand.some((cardId) => host.state.cards[cardId]?.suit === suit)))
      if (!candidates.length) return
      host.askSkill({ skillId: XING_XUNYU_KUANGZUO, ownerId, step: 'donor', data: { targetId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【匡祚】：选择一名其他角色交出四种花色各一张手牌',
        timeoutMs: 25_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'donor') {
      const targetId = resolution.data.targetId as PlayerId
      const donorId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const donor = donorId ? playerOf(host.state, donorId) : undefined
      if (!donor?.alive || donor.id === targetId || !suitCycle.every((suit) => donor.zones.hand.some((cardId) => host.state.cards[cardId]?.suit === suit))) return
      host.queueSkill({ skillId: XING_XUNYU_KUANGZUO, ownerId, step: 'donor-card', data: { targetId, donorId, index: 0, selected: [] } })
      return
    }
    if (resolution.step !== 'donor-card') return
    const targetId = resolution.data.targetId as PlayerId
    const donorId = resolution.data.donorId as PlayerId
    const suitIndex = Number(resolution.data.index)
    const suit = suitCycle[suitIndex]
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const donor = playerOf(host.state, donorId)
    const selected = (resolution.data.selected as CardId[]) ?? []
    if (!owner?.alive || !target?.alive || !donor?.alive || donor.id === target.id || !suit || !cardId
      || owner.usedLimitedSkills.includes(XING_XUNYU_KUANGZUO) || selected.includes(cardId)
      || !donor.zones.hand.includes(cardId) || host.state.cards[cardId]?.suit !== suit) return
    selected.push(cardId)
    if (selected.length < suitCycle.length) {
      host.queueSkill({ skillId: XING_XUNYU_KUANGZUO, ownerId, step: 'donor-card', data: {
        targetId, donorId, index: suitIndex + 1, selected,
      } })
      return
    }
    for (const selectedCardId of selected)
      moveCard(host.state, selectedCardId, { kind: 'hand', playerId: donor.id }, { kind: 'characterPile', playerId: target.id, pile: 'kuangzuo' })
    grantSkill(host.state, target.id, XING_XUNYU_CHENGFENG)
    if (target.identity === 'lord' && !ownedSkillIds(host.state, target.id, characterSkillIdsOf).some((skillId) => getSkillRuntime(skillId)?.lord))
      grantSkill(host.state, target.id, XING_XUNYU_TONGYIN)
    owner.usedLimitedSkills.push(XING_XUNYU_KUANGZUO)
    host.dispatch('SkillActivated', { skillId: XING_XUNYU_KUANGZUO, skillName: '匡祚', playerId: ownerId,
      targetId, donorId: donor.id, cardIds: selected }, { sourceId: ownerId, targetId, cardIds: selected })
  },
})

registerSkillRuntime({
  id: XING_XUNYU_CHENGFENG,
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, XING_XUNYU_CHENGFENG)) return []
    return (owner.characterPiles.kuangzuo ?? []).flatMap((cardId) => {
      const color = effectiveCardColor(state, ownerId, cardId)
      return color === 'red' ? [{ asCardName: '闪', cardId, label: '承奉：红色“匡祚”当【闪】' }]
        : color === 'black' ? [{ asCardName: '无懈可击', cardId, label: '承奉：黑色“匡祚”当【无懈可击】' }] : []
    })
  },
  triggers: [{ event: 'CardResponded', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; cardName?: string }
    if (context.event.sourceSkillId !== XING_XUNYU_CHENGFENG || payload.playerId !== ownerId || !payload.cardId
      || !['闪', '无懈可击'].includes(payload.cardName ?? '')) return
    markUsedThisTurn(host.state, ownerId, XING_XUNYU_CHENGFENG)
    const pile = playerOf(host.state, ownerId)?.characterPiles.kuangzuo ?? []
    if (new Set(pile.map((cardId) => effectiveCardColor(host.state, ownerId, cardId))).size >= 2) return
    host.queueSkill({ skillId: XING_XUNYU_CHENGFENG, ownerId, step: 'replenish', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'replenish') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !host.state.zones.drawPile.length) return
    host.askSkill({ skillId: XING_XUNYU_CHENGFENG, ownerId, step: 'replenish', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【承奉】：是否将牌堆顶的一张牌置为“匡祚”？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '置为“匡祚”' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'replenish' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    const cardId = host.state.zones.drawPile[0]
    if (!owner?.alive || !cardId || (owner.characterPiles.kuangzuo ?? []).length >= 4) return
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: 'kuangzuo' })
  },
})

registerSkillRuntime({
  id: XING_XUNYU_TONGYIN,
  lord: true,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId | null; finalAmount?: number }
    const sourceId = context.event.sourceId
    const target = playerOf(host.state, ownerId)
    const source = sourceId ? playerOf(host.state, sourceId) : undefined
    if (!target?.alive || !source?.alive || source.id === ownerId || (payload.finalAmount ?? 0) <= 0 || !payload.cardId) return
    const sourceFaction = source.nationalWarFaction ?? revealedGeneralFactionOf(source)
    const targetFaction = target.nationalWarFaction ?? revealedGeneralFactionOf(target)
    if (!sourceFaction || !targetFaction) return
    const sameKingdom = sourceFaction === targetFaction
    if (sameKingdom) {
      const cardId = payload.cardId
      const from = host.state.zones.processingArea.includes(cardId) ? { kind: 'processingArea' as const }
        : host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const } : null
      if (from) host.queueSkill({ skillId: XING_XUNYU_TONGYIN, ownerId, step: 'take-damage-card', data: { cardId } })
      return
    }
    if (hasPickableCards(host.state, source.id))
      host.queueSkill({ skillId: XING_XUNYU_TONGYIN, ownerId, step: 'choose-source-card', data: { sourceId: source.id } })
  } }],
  startQueued(host, ownerId, prompt) {
    const target = playerOf(host.state, ownerId)
    if (!target?.alive) return
    if (prompt.step === 'take-damage-card') {
      const cardId = prompt.data.cardId as CardId
      const from = host.state.zones.processingArea.includes(cardId) ? { kind: 'processingArea' as const }
        : host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const } : null
      if (!from) return
      host.askSkill({ skillId: XING_XUNYU_TONGYIN, ownerId, step: 'take-damage-card', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【统荫】：是否将造成此伤害的牌置为“匡祚”？', timeoutMs: 25_000,
        optional: true, options: [{ id: 'yes', label: '置为“匡祚”' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step === 'choose-source-card') {
      const sourceId = prompt.data.sourceId as PlayerId
      const source = playerOf(host.state, sourceId)
      const options = pickableCardsOf(host.state, sourceId)
      if (!source?.alive || options.cardIds.length + options.hiddenCardSlots.length === 0) return
      host.askSkill({ skillId: XING_XUNYU_TONGYIN, ownerId, step: 'choose-source-card', data: prompt.data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【统荫】：选择${source.nickname}的一张手牌或装备牌置为“匡祚”`,
        timeoutMs: 25_000, optional: true, purpose: 'skill', ...options, min: 0, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const target = playerOf(host.state, ownerId)
    if (!target?.alive) return
    if (resolution.step === 'take-damage-card') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const cardId = resolution.data.cardId as CardId
      const from = host.state.zones.processingArea.includes(cardId) ? { kind: 'processingArea' as const }
        : host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const } : null
      if (from) moveCard(host.state, cardId, from, { kind: 'characterPile', playerId: ownerId, pile: 'kuangzuo' })
      return
    }
    if (resolution.step !== 'choose-source-card') return
    const sourceId = resolution.data.sourceId as PlayerId
    const picked = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const cardId = picked ? resolvePickedCard(host.state, sourceId, picked) : null
    if (cardId) movePickedCard(host as never, sourceId, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'kuangzuo' })
  },
})

export const QIQIAO_MAJUN_B90: CharacterDefinition = {
  id: 'qiqiao-majun-b90', name: '奇巧马钧', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: QIQIAO_MAJUN_YULIAO, name: '余料', description: '每阶段限一次，当有牌因弃置进入弃牌堆时，你可以将其中一张牌置于你的武将牌上，称为“材”，你至多拥有8张“材”。当你进入濒死状态时，你可以重铸所有“材”。' },
    { id: QIQIAO_MAJUN_QIQIAO, name: '奇巧', description: '出牌阶段，你可以移去两张类型不同的“材”，然后选择一名角色装备区内的一张牌，令其在此区域内根据移去“材”的类型获得对应效果：基本牌，此角色出牌阶段使用【杀】次数+1；装备牌，此牌离开区域时其拥有者摸两张牌；锦囊牌，此牌无法被响应。' },
    { id: QIQIAO_MAJUN_YANXIE, name: '研械', description: '出牌阶段，你可以重铸两张类别相同的“材”，然后随机从牌堆或弃牌堆中获得一张装备牌。' },
  ],
}

registerSkillRuntime({
  id: QIQIAO_MAJUN_YULIAO,
  triggers: [{ event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; reason?: string }
    const owner = playerOf(host.state, ownerId)
    const pile = owner?.characterPiles.cai ?? []
    const cardId = payload.cardId
    if (!owner?.alive || !cardId || payload.reason !== 'discard' || !host.state.zones.discardPile.includes(cardId)
      || pile.length >= 8 || usedThisPhase(host.state, ownerId, QIQIAO_MAJUN_YULIAO)) return
    const pending = (dataOf(host.state).qiqiaoYuliao ??= {})[ownerId] ??= { pendingCardIds: [], queued: false }
    if (!pending.pendingCardIds.includes(cardId)) pending.pendingCardIds.push(cardId)
    if (pending.queued) return
    pending.queued = true
    host.queueSkill({ skillId: QIQIAO_MAJUN_YULIAO, ownerId, step: 'take-material', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'take-material') return
    const owner = playerOf(host.state, ownerId)
    const pending = dataOf(host.state).qiqiaoYuliao?.[ownerId]
    const pile = owner?.characterPiles.cai ?? []
    const candidates = (pending?.pendingCardIds ?? []).filter((cardId) => host.state.zones.discardPile.includes(cardId))
      .slice(0, Math.max(0, 8 - pile.length))
    if (!owner?.alive || !candidates.length || usedThisPhase(host.state, ownerId, QIQIAO_MAJUN_YULIAO)) {
      if (pending) { pending.pendingCardIds = []; pending.queued = false }
      return
    }
    host.askSkill({ skillId: QIQIAO_MAJUN_YULIAO, ownerId, step: 'take-material', data: { candidates }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【余料】：可将本次弃置进入弃牌堆的一张牌置为“材”',
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  dyingIntercept(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    const materials = owner?.characterPiles.cai ?? []
    if (!owner?.alive || !materials.length) return false
    host.askSkill({ skillId: QIQIAO_MAJUN_YULIAO, ownerId, step: 'recast', data: { cardIds: [...materials] }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【余料】：是否重铸全部${materials.length}张“材”？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: `重铸${materials.length}张“材”并摸${materials.length}张牌` }, { id: 'no', label: '不发动，继续求桃' }],
    }) })
    return 'pending'
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'take-material') {
      const pending = dataOf(host.state).qiqiaoYuliao?.[ownerId]
      const owner = playerOf(host.state, ownerId)
      const chosen = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const candidates = resolution.data.candidates as CardId[]
      if (chosen && candidates.includes(chosen) && owner?.alive && (owner.characterPiles.cai?.length ?? 0) < 8
        && host.state.zones.discardPile.includes(chosen) && !usedThisPhase(host.state, ownerId, QIQIAO_MAJUN_YULIAO)) {
        moveCard(host.state, chosen, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: 'cai' })
        markUsedThisPhase(host.state, ownerId, QIQIAO_MAJUN_YULIAO)
        host.dispatch('SkillActivated', { skillId: QIQIAO_MAJUN_YULIAO, skillName: '余料', playerId: ownerId, pile: '材', cardIds: [chosen] }, {
          sourceId: ownerId, targetId: ownerId, cardIds: [chosen],
        })
      }
      if (pending) { pending.pendingCardIds = []; pending.queued = false }
      return
    }
    if (resolution.step !== 'recast' || host.state.dying?.playerId !== ownerId) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const selected = (response.payload as { optionId?: string }).optionId === 'yes'
    const materials = selected ? (owner.characterPiles.cai ?? []).slice() : []
    if (materials.length) {
      for (const cardId of materials)
        moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'cai' }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: materials, reason: 'recast' }, { sourceId: ownerId, cardIds: materials })
      drawCards(host.state, host.rng, ownerId, materials.length, (name, payload) => host.dispatch(name, payload))
      host.dispatch('SkillActivated', { skillId: QIQIAO_MAJUN_YULIAO, skillName: '余料', playerId: ownerId, result: 'recast', cardIds: materials }, {
        sourceId: ownerId, targetId: ownerId, cardIds: materials,
      })
    }
    continueDyingRescue(host as never)
    if (!host.state.dying) host.resumeAfterDying()
  },
})

registerSkillRuntime({
  id: QIQIAO_MAJUN_YANXIE,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const materials = owner?.characterPiles.cai ?? []
    const canRecast = categories.some((category) => materials.filter((cardId) => state.cards[cardId]?.category === category).length >= 2)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive && canRecast
      ? [{ id: QIQIAO_MAJUN_YANXIE, label: '研械：重铸两张同类别“材”' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== QIQIAO_MAJUN_YANXIE || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
    const materials = playerOf(host.state, ownerId)?.characterPiles.cai ?? []
    const eligible = categories.filter((category) => materials.filter((cardId) => host.state.cards[cardId]?.category === category).length >= 2)
    if (!eligible.length) return
    host.askSkill({ skillId: QIQIAO_MAJUN_YANXIE, ownerId, step: 'category', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【研械】：选择重铸两张“材”的类别',
      timeoutMs: 25_000, optional: false, options: eligible.map((category) => ({
        id: category, label: ({ basic: '基本牌', trick: '锦囊牌', equipment: '装备牌' } as const)[category],
      })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'category') {
      const category = (response.payload as { optionId?: string }).optionId as CardCategory | undefined
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !categories.includes(category as CardCategory)) return
      const candidates = owner.characterPiles.cai.filter((cardId) => host.state.cards[cardId]?.category === category)
      if (candidates.length < 2) return
      host.askSkill({ skillId: QIQIAO_MAJUN_YANXIE, ownerId, step: 'recast', data: { category }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【研械】：选择两张${({ basic: '基本牌', trick: '锦囊牌', equipment: '装备牌' } as const)[category!] }类别的“材”重铸`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 2, max: 2,
      }) })
      return
    }
    if (resolution.step !== 'recast') return
    const owner = playerOf(host.state, ownerId)
    const category = resolution.data.category as CardCategory
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || selected.length !== 2 || new Set(selected).size !== 2
      || selected.some((cardId) => !owner.characterPiles.cai.includes(cardId) || host.state.cards[cardId]?.category !== category)) return
    for (const cardId of selected)
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'cai' }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: selected, reason: 'recast' }, { sourceId: ownerId, cardIds: selected })
    const equipmentIds = [...host.state.zones.drawPile, ...host.state.zones.discardPile]
      .filter((cardId) => host.state.cards[cardId]?.category === 'equipment')
    if (!equipmentIds.length) return
    const cardId = host.rng.pick(equipmentIds)
    const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
    moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: QIQIAO_MAJUN_YANXIE }, {
      sourceId: ownerId, targetId: ownerId, cardIds: [cardId],
    })
    host.dispatch('SkillActivated', { skillId: QIQIAO_MAJUN_YANXIE, skillName: '研械', playerId: ownerId, cardIds: selected, gainedCardId: cardId }, {
      sourceId: ownerId, targetId: ownerId, cardIds: [...selected, cardId],
    })
  },
})

registerSkillRuntime({
  id: QIQIAO_MAJUN_QIQIAO,
  globalSlashUses(state, ownerId) {
    const cards = dataOf(state).majunDevice ?? {}
    return Object.entries(cards).reduce((uses, [cardId, effect]) => effect.ownerId === ownerId
      && Object.values(playerOf(state, ownerId)?.zones.equipment ?? {}).includes(cardId)
      ? uses + effect.kinds.filter((kind) => kind === 'basic').length : uses, 0)
  },
  trickUnresponsive(state, ownerId, _targetId, cardName) {
    if (cardCategoryOfName(cardName) !== 'trick') return false
    return Object.entries(dataOf(state).majunDevice ?? {}).some(([cardId, effect]) => effect.ownerId === ownerId
      && effect.kinds.includes('trick') && Object.values(playerOf(state, ownerId)?.zones.equipment ?? {}).includes(cardId))
  },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const materials = owner?.characterPiles.cai ?? []
    const hasDifferentCategories = categories.some((category, index) => categories.slice(index + 1).some((other) =>
      materials.some((id) => state.cards[id]?.category === category) && materials.some((id) => state.cards[id]?.category === other)))
    const hasEquipment = state.players.some((target) => target.alive && Object.values(target.zones.equipment).some(Boolean))
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive && hasDifferentCategories && hasEquipment
      ? [{ id: QIQIAO_MAJUN_QIQIAO, label: '奇巧：移去两张不同类别“材”强化一张装备' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== QIQIAO_MAJUN_QIQIAO || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
    const materials = playerOf(host.state, ownerId)?.characterPiles.cai ?? []
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: QIQIAO_MAJUN_QIQIAO, ownerId, step: 'first-material', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【奇巧】：选择第一张“材”', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [...materials], hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'first-material') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !owner.characterPiles.cai.includes(cardId)) return
      const category = host.state.cards[cardId]?.category
      if (!category || !categories.includes(category)) return
      const candidates = owner.characterPiles.cai.filter((id) => id !== cardId && host.state.cards[id]?.category !== category)
      if (!candidates.length) return
      host.askSkill({ skillId: QIQIAO_MAJUN_QIQIAO, ownerId, step: 'second-material', data: { firstId: cardId, category }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【奇巧】：选择类别不同的第二张“材”', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'second-material') {
      const firstId = resolution.data.firstId as CardId
      const secondId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const firstCategory = resolution.data.category as CardCategory
      if (!secondId || secondId === firstId || !owner.characterPiles.cai.includes(firstId)
        || !owner.characterPiles.cai.includes(secondId) || host.state.cards[firstId]?.category !== firstCategory
        || !host.state.cards[secondId]?.category || host.state.cards[secondId]?.category === firstCategory) return
      const equipmentIds = host.state.players.filter((target) => target.alive)
        .flatMap((target) => Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)))
      if (!equipmentIds.length) return
      host.askSkill({ skillId: QIQIAO_MAJUN_QIQIAO, ownerId, step: 'equipment', data: { firstId, secondId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【奇巧】：选择一张角色装备区里的牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: equipmentIds, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'equipment') return
    const firstId = resolution.data.firstId as CardId
    const secondId = resolution.data.secondId as CardId
    const equipmentId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const materials = owner.characterPiles.cai
    const firstCategory = host.state.cards[firstId]?.category
    const secondCategory = host.state.cards[secondId]?.category
    if (!equipmentId) return
    const beneficiary = host.state.players.find((target) => target.alive
      && Object.values(target.zones.equipment).includes(equipmentId))
    if (!equipmentId || !beneficiary || !materials.includes(firstId) || !materials.includes(secondId)
      || !firstCategory || !secondCategory || firstCategory === secondCategory) return
    const existing = dataOf(host.state).majunDevice?.[equipmentId]
    if (existing && existing.ownerId !== beneficiary.id) return
    for (const cardId of [firstId, secondId])
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'cai' }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [firstId, secondId], reason: QIQIAO_MAJUN_QIQIAO }, {
      sourceId: ownerId, cardIds: [firstId, secondId],
    })
    const devices = dataOf(host.state).majunDevice ??= {}
    const attached = devices[equipmentId] ??= { ownerId: beneficiary.id, kinds: [] }
    if (attached.ownerId !== beneficiary.id) return
    attached.kinds.push(firstCategory, secondCategory)
    if (!beneficiary.grantedSkills.includes(QIQIAO_MAJUN_QIQIAO)) beneficiary.grantedSkills.push(QIQIAO_MAJUN_QIQIAO)
    host.dispatch('SkillActivated', { skillId: QIQIAO_MAJUN_QIQIAO, skillName: '奇巧', playerId: ownerId,
      targetId: beneficiary.id, cardIds: [firstId, secondId], equipmentId, gainedEffects: [firstCategory, secondCategory],
    }, { sourceId: ownerId, targetId: beneficiary.id, cardIds: [firstId, secondId, equipmentId] })
  },
  triggers: [{ event: 'CardZoneMoved', handle(host, _ownerId, context) {
    const movement = context.event.payload as { fromKind?: string; fromPlayerId?: PlayerId | null; toKind?: string; toPlayerId?: PlayerId | null }
    const equipmentId = (context.event.payload as { cardId?: CardId }).cardId
    if (!equipmentId || movement.fromKind !== 'equipment') return
    const devices = dataOf(host.state).majunDevice
    const effect = devices?.[equipmentId]
    if (!effect || movement.fromPlayerId !== effect.ownerId
      || (movement.toKind === 'equipment' && movement.toPlayerId === effect.ownerId)) return
    const beneficiary = playerOf(host.state, effect.ownerId)
    if (beneficiary?.alive && effect.kinds.includes('equipment'))
      drawCards(host.state, host.rng, beneficiary.id, effect.kinds.filter((kind) => kind === 'equipment').length * 2,
        (name, payload) => host.dispatch(name, payload))
    delete devices![equipmentId]
    const stillEnhanced = Object.values(devices ?? {}).some((candidate) => candidate.ownerId === effect.ownerId)
    if (!stillEnhanced && beneficiary && !characterSkillIdsOf(beneficiary.characterId ?? '').includes(QIQIAO_MAJUN_QIQIAO))
      beneficiary.grantedSkills = beneficiary.grantedSkills.filter((id) => id !== QIQIAO_MAJUN_QIQIAO)
  } }],
})

export const CHUANXIE_MAJUN_B90: CharacterDefinition = {
  id: 'chuanxie-majun-b90', name: '传械马钧', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: CHUANXIE_MAJUN_CHUANXIE, name: '传械', description: '锁定技，游戏开始你记录一种花色。当一名角色使用此花色的牌时，你将记录的花色改为再下一个花色，然后从牌堆中获得一张下一个花色的牌。（花色顺序为黑桃-红桃-梅花-方片-黑桃循环）' },
    { id: CHUANXIE_MAJUN_QIAOSI, name: '巧思', description: '每回合限一次，当你造成和受到伤害后，你可以将“传械”记录的花色改为上一个花色或下一个花色。' },
  ],
}

export const LE_DIAOCHAN_B90: CharacterDefinition = {
  id: 'le-diaochan-b90', name: '乐貂蝉', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: LE_DIAOCHAN_TANBAN, name: '檀板', description: '游戏开始时，你的初始手牌增加“檀板”标记且不计入手牌上限。摸牌阶段结束时，你可以交换手中檀板牌与非檀板牌的标记。' },
    { id: LE_DIAOCHAN_DIYOU, name: '低讴', description: '你使用檀板牌结算后，可以展示1张非檀板牌，然后视为使用之。若此牌为本回合首次展示或与你使用的牌牌名相同，你摸2张牌。' },
  ],
}

export const YUANYIN_B90: CharacterDefinition = {
  id: 'yuanyin-b90', name: '袁胤', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: YUANYIN_MOSHOU, name: '墨守', description: '你成为黑色牌的目标后，可以摸体力上限张牌，然后下次以此法摸牌数-1。若你以此法摸牌数为1，则重置为体力上限。' },
    { id: YUANYIN_YUNJIU, name: '运柩', description: '有角色死亡时，你可以交给一名其他角色一张该角色的牌。若如此做，你加1点体力上限并回复1点体力。' },
  ],
}

export const WU_HUANGFUSONG_B90: CharacterDefinition = {
  id: 'wu-huangfusong-b90', name: '武皇甫嵩', kingdom: 'qun', gender: 'male', maxHp: 4, initialHp: 1, pack: 'sp', skills: [
    { id: WU_HUANGFUSONG_CHAOZHEN, name: '朝镇', description: '准备阶段或当你进入濒死状态时，你可以选择场上或牌堆，然后随机获得所选区域中点数最小的一张牌。若获得的是A，你回复1点体力且此技能本回合失效。' },
    { id: WU_HUANGFUSONG_LIANJIE, name: '连捷', description: '你使用手牌指定目标后，若你没有点数小于此牌的手牌，且本回合未因该点数发动过此技能，你可以选择一名角色（每回合每名角色限一次），将其手牌中点数最小的一张牌置于牌堆底，然后将手牌摸至体力上限；以此法摸的牌本回合使用时无距离和次数限制。' },
    { id: WU_HUANGFUSONG_JIANGXIAN, name: '将贤', description: '限定技，出牌阶段，你可以令本回合使用因“连捷”摸的牌造成伤害时，此伤害+X（X为你本回合造成伤害的次数且至多为5）。若如此做，回合结束后失去“连捷”或“朝镇”。' },
  ],
}

export const PANGFENGYI_B90: CharacterDefinition = {
  id: 'pang-fengyi-b90', name: '庞凤衣', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: PANGFENGYI_YITONG, name: '异瞳', description: '锁定技，游戏开始时，你选择一种花色。每回合该花色牌首次因使用进入弃牌堆后，你随机获得与该花色不同花色的牌各一张。' },
    { id: PANGFENGYI_PEINIANG, name: '醅酿', description: '你可以将“异瞳”所选花色的牌当【酒】使用（不计次数）。有角色进入濒死状态时，你可以对其使用【酒】。' },
  ],
}

registerSkillRuntime({
  id: LE_DIAOCHAN_TANBAN,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const table = dataOf(host.state).diaochan ??= {}
    table[ownerId] = { marked: [...owner.zones.hand], seenNames: [], seenTurn: host.state.turnNumber }
  },
  handLimitExempt(state, ownerId, cardId) {
    return dataOf(state).diaochan?.[ownerId]?.marked.includes(cardId) ?? false
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId) {
      const record = dataOf(host.state).diaochan?.[ownerId]
      if (!record || record.seenTurn === host.state.turnNumber) return
      record.seenTurn = host.state.turnNumber
      record.seenNames = []
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'draw') return
      const owner = playerOf(host.state, ownerId)
      const record = dataOf(host.state).diaochan?.[ownerId]
      const markedInHand = owner?.zones.hand.filter((id) => record?.marked.includes(id)) ?? []
      const unmarkedInHand = owner?.zones.hand.filter((id) => !record?.marked.includes(id)) ?? []
      if (!owner?.alive || !markedInHand.length || !unmarkedInHand.length) return
      host.queueSkill({ skillId: LE_DIAOCHAN_TANBAN, ownerId, step: 'exchange-marked', data: { markedInHand } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    const record = dataOf(host.state).diaochan?.[ownerId]
    if (!owner?.alive || !record) return
    if (prompt.step === 'exchange-marked') {
      const candidates = owner.zones.hand.filter((id) => record.marked.includes(id))
      if (!candidates.length) return
      host.askSkill({ skillId: LE_DIAOCHAN_TANBAN, ownerId, step: 'exchange-marked', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【檀板】：选择一张檀板牌交换标记', timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
      }) })
      return
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    const record = dataOf(host.state).diaochan?.[ownerId]
    if (!owner?.alive || !record) return
    if (resolution.step === 'exchange-marked') {
      const markedId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!markedId || !owner.zones.hand.includes(markedId) || !record.marked.includes(markedId)) return
      skillRequest(host, ownerId, LE_DIAOCHAN_TANBAN, 'exchange-unmarked', { markedId }, (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【檀板】：选择一张非檀板手牌，与其交换标记', timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds: owner.zones.hand.filter((cardId) => !record.marked.includes(cardId)),
        hiddenCardSlots: [], min: 0, max: 1,
      }))
      return
    }
    if (resolution.step === 'exchange-unmarked') {
      const markedId = resolution.data.markedId as CardId
      const unmarkedId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!unmarkedId || !owner.zones.hand.includes(markedId) || !owner.zones.hand.includes(unmarkedId)
        || !record.marked.includes(markedId) || record.marked.includes(unmarkedId)) return
      record.marked = record.marked.filter((id) => id !== markedId)
      record.marked.push(unmarkedId)
      host.dispatch('SkillActivated', { skillId: LE_DIAOCHAN_TANBAN, skillName: '檀板', playerId: ownerId,
        exchangedCardIds: [markedId, unmarkedId],
      }, { sourceId: ownerId, cardIds: [markedId, unmarkedId] })
      return
    }
  },
})

registerSkillRuntime({
  id: LE_DIAOCHAN_DIYOU,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    if (context.event.sourceId !== ownerId || !payload.cardId
      || !dataOf(host.state).diaochan?.[ownerId]?.marked.includes(payload.cardId)
      || !playerOf(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: LE_DIAOCHAN_DIYOU, ownerId, step: 'show', data: {
      sourceCardId: payload.cardId, sourceCardName: payload.cardName ?? effectiveCardName(host.state, payload.cardId),
    } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'show') return
    const owner = playerOf(host.state, ownerId)
    const record = dataOf(host.state).diaochan?.[ownerId]
    if (!owner?.alive || !record) return
    const candidates = owner.zones.hand.filter((id) => !record.marked.includes(id)
      && diaochanUseActions(host.state, ownerId, id).length > 0)
    if (!candidates.length) return
    host.askSkill({ skillId: LE_DIAOCHAN_DIYOU, ownerId, step: 'show', data: prompt.data, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【低讴】：可展示一张非檀板手牌并视为使用之', timeoutMs: 25_000,
      optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    const record = dataOf(host.state).diaochan?.[ownerId]
    if (!owner?.alive || !record) return
    if (resolution.step === 'show') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !owner.zones.hand.includes(cardId) || record.marked.includes(cardId)) return
      const actions = diaochanUseActions(host.state, ownerId, cardId)
      if (!actions.length) return
      const name = effectiveCardName(host.state, cardId)
      const firstShownThisTurn = record.seenTurn !== host.state.turnNumber || record.seenNames.length === 0
      record.seenTurn = host.state.turnNumber
      record.seenNames.push(name)
      const sourceCardName = resolution.data.sourceCardName as string
      if (firstShownThisTurn || name === sourceCardName)
        drawCards(host.state, host.rng, ownerId, 2, (eventName, payload) => host.dispatch(eventName, payload))
      host.dispatch('SkillActivated', { skillId: LE_DIAOCHAN_DIYOU, skillName: '低讴', playerId: ownerId,
        sourceCardId: resolution.data.sourceCardId, shownCardId: cardId, cardName: name,
      }, { sourceId: ownerId, cardIds: [cardId] })
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
      if (actions.length === 1) {
        if (!host.beginSkillCardUseFromProcessing(ownerId, cardId, LE_DIAOCHAN_DIYOU, actions[0]!.id)
          && host.state.zones.processingArea.includes(cardId))
          moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        return
      }
      host.askSkill({ skillId: LE_DIAOCHAN_DIYOU, ownerId, step: 'use-action', data: { cardId, actions }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【低讴】：选择如何使用展示的【${name}】`, timeoutMs: 25_000,
        optional: false, options: actions.map((action) => ({ id: action.id, label: action.label })),
      }) })
      return
    }
    if (resolution.step !== 'use-action') return
    const cardId = resolution.data.cardId as CardId
    const chosenActionId = (response.payload as { optionId?: string }).optionId
    if ((!owner.zones.hand.includes(cardId) && !host.state.zones.processingArea.includes(cardId)) || !chosenActionId) return
    if (owner.zones.hand.includes(cardId))
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
    if (!host.beginSkillCardUseFromProcessing(ownerId, cardId, LE_DIAOCHAN_DIYOU, chosenActionId)
      && host.state.zones.processingArea.includes(cardId))
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
  },
})

registerSkillRuntime({
  id: YUANYIN_MOSHOU,
  triggers: [{ event: 'TargetConfirmed', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const card = cardId && host.state.cards[cardId]
    if (!card || card.color !== 'black' || !playerOf(host.state, ownerId)?.alive) return
    const state = dataOf(host.state).yuanyin ??= {}
    const nextDraw = state[ownerId]?.nextDraw ?? playerOf(host.state, ownerId)!.maxHp
    host.queueSkill({ skillId: YUANYIN_MOSHOU, ownerId, step: 'invoke', data: { count: nextDraw } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    host.askSkill({ skillId: YUANYIN_MOSHOU, ownerId, step: 'invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【墨守】：是否摸${Number(prompt.data.count)}张牌？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '摸牌' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const state = dataOf(host.state).yuanyin ??= {}
    const count = Math.max(1, Math.min(owner.maxHp, Number(resolution.data.count) || owner.maxHp))
    state[ownerId] = { nextDraw: count === 1 ? owner.maxHp : count - 1 }
    drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
  },
})

registerSkillRuntime({
  id: YUANYIN_YUNJIU,
  claimsDeathCards(state, ownerId, deadId) {
    const dead = playerOf(state, deadId)
    return ownerId !== deadId && !!playerOf(state, ownerId)?.alive && !!dead && ownedCardsOf(dead).length > 0
  },
  triggers: [{ event: 'Death', handle(host, ownerId, context) {
    const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (!deadId || host.state.deathClaim?.claimantId !== ownerId || host.state.deathClaim.skillId !== YUANYIN_YUNJIU) return
    host.queueSkill({ skillId: YUANYIN_YUNJIU, ownerId, step: 'target', data: { deadId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    if (!playerOf(host.state, ownerId)?.alive) { releaseDeathCards(host as never); return }
    const targets = actorCandidates(host.state, ownerId)
    if (!targets.length) { releaseDeathCards(host as never); return }
    host.askSkill({ skillId: YUANYIN_YUNJIU, ownerId, step: 'target', data: prompt.data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【运柩】：选择一名其他角色获得死者的一张牌',
      timeoutMs: 25_000, optional: true, candidateIds: targets.map((target) => target.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cards = host.state.deathClaim?.claimantId === ownerId && host.state.deathClaim.skillId === YUANYIN_YUNJIU
        ? host.state.deathClaim.cardIds.filter((cardId) => host.state.zones.processingArea.includes(cardId)) : []
      if (!targetId || !playerOf(host.state, targetId)?.alive || !cards.length) { releaseDeathCards(host as never); return }
      skillRequest(host, ownerId, YUANYIN_YUNJIU, 'card', { targetId }, (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【运柩】：选择交给其的一张死者的牌',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
      }))
      return
    }
    if (resolution.step !== 'card') return
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const death = host.state.deathClaim
    if (!cardId || !death || death.claimantId !== ownerId || death.skillId !== YUANYIN_YUNJIU
      || !death.cardIds.includes(cardId) || !host.state.zones.processingArea.includes(cardId) || !playerOf(host.state, targetId)?.alive) {
      releaseDeathCards(host as never)
      return
    }
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: YUANYIN_YUNJIU }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    releaseDeathCards(host as never)
    const owner = playerOf(host.state, ownerId)
    if (owner?.alive) {
      gainMaxHp(host as never, ownerId, 1, YUANYIN_YUNJIU)
      recover(host as never, ownerId, 1, ownerId)
    }
  },
})

registerSkillRuntime({
  id: PANGFENGYI_YITONG,
  triggers: [
    { event: 'GameStart', handle(host, ownerId) {
      if (!playerOf(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: PANGFENGYI_YITONG, ownerId, step: 'choose-suit', data: {} })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const card = payload.cardId && host.state.cards[payload.cardId]
      const data = dataOf(host.state).pangfengyi?.[ownerId]
      if (!data?.suit || !card || card.suit !== data.suit) return
      const state = dataOf(host.state)
      const current = state.pangfengyi![ownerId]!
      if (current.turn !== host.state.turnNumber) Object.assign(current, { turn: host.state.turnNumber, used: false })
      const used = state.pangfengyiUsedCards ??= {}
      used[ownerId] ??= []
      used[ownerId].push(payload.cardId!)
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; fromKind?: string }
      const cardId = payload.cardId
      const data = dataOf(host.state).pangfengyi?.[ownerId]
      const used = (dataOf(host.state) as Batch90State & { pangfengyiUsedCards?: Record<PlayerId, CardId[]> }).pangfengyiUsedCards?.[ownerId] ?? []
      const owner = playerOf(host.state, ownerId)
      if (!cardId || payload.fromKind !== 'processingArea' || !data?.suit || data.used || !used.includes(cardId) || !owner?.alive
        || host.state.zones.discardPile.includes(cardId) === false || (host.state.cards[cardId]?.suit !== data.suit)) return
      data.used = true
      const acquiredSuits: string[] = []
      for (const suit of suitCycle) {
        if (suit === data.suit) continue
        const candidates = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.suit === suit)
        if (!candidates.length) continue
        const gained = host.rng.pick(candidates)
        moveCard(host.state, gained, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [gained], reason: PANGFENGYI_YITONG }, { sourceId: ownerId, cardIds: [gained] })
        acquiredSuits.push(suit)
      }
      const remain = used.filter((id) => id !== cardId)
      dataOf(host.state).pangfengyiUsedCards![ownerId] = remain
    } },
    { event: 'TurnStart', handle(host, ownerId) {
      const state = dataOf(host.state)
      const data = state.pangfengyi?.[ownerId]
      if (!data || data.turn === host.state.turnNumber) return
      Object.assign(data, { turn: host.state.turnNumber, used: false })
      ;(state.pangfengyiUsedCards ??= {})[ownerId] = []
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-suit') return
    const suit = (response.payload as { optionId?: string }).optionId
    if (!suitCycle.includes(suit as typeof suitCycle[number])) return
    const state = dataOf(host.state).pangfengyi ??= {}
    state[ownerId] = { suit, turn: host.state.turnNumber, used: false }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-suit') return
    host.askSkill({ skillId: PANGFENGYI_YITONG, ownerId, step: 'choose-suit', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【异瞳】：选择一种花色', timeoutMs: 25_000, optional: false,
      options: suitCycle.map((suit) => ({ id: suit, label: ({ spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方片' } as const)[suit] })),
    }) })
  },
})

registerSkillRuntime({
  id: PANGFENGYI_PEINIANG,
  unlimitedWine: true,
  viewAs(state, ownerId) {
    const suit = dataOf(state).pangfengyi?.[ownerId]?.suit
    const owner = playerOf(state, ownerId)
    if (!suit || !owner?.alive) return []
    return owner.zones.hand.filter((cardId) => state.cards[cardId]?.suit === suit)
      .map((cardId) => ({ asCardName: '酒', cardId, label: `【醅酿】：将${state.cards[cardId]?.name ?? '牌'}当【酒】使用` }))
  },
  rescueActions(state, ownerId, dyingPlayerId) {
    const owner = playerOf(state, ownerId)
    const suit = dataOf(state).pangfengyi?.[ownerId]?.suit
    if (!owner?.alive || !playerOf(state, dyingPlayerId)?.alive || !suit) return []
    return owner.zones.hand.filter((cardId) => state.cards[cardId]?.suit === suit)
      .map((cardId) => ({ id: `peiniang-rescue:${cardId}`, label: `【醅酿】：将此牌当【酒】对濒死角色使用` }))
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    const prefix = 'peiniang-rescue:'
    if (!actionId.startsWith(prefix)) return false
    const cardId = actionId.slice(prefix.length) as CardId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, dyingPlayerId)
    const suit = dataOf(host.state).pangfengyi?.[ownerId]?.suit
    if (!owner?.alive || !target?.alive || host.state.dying?.playerId !== dyingPlayerId
      || !suit || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.suit !== suit
      || isCardUseProhibited(host.state, ownerId, '酒', { dyingPlayerId, cardIds: [cardId] })) return false
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
    host.state.turnUsage.wineUses += 1
    host.dispatch('CardResponded', { playerId: ownerId, cardId, cardName: '酒', fromKind: 'hand' }, {
      sourceId: ownerId, targetId: dyingPlayerId, cardIds: [cardId],
    })
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    recover(host as never, dyingPlayerId, 1, ownerId, cardId)
    return true
  },
})

registerSkillRuntime({
  id: CHUANXIE_MAJUN_CHUANXIE,
  triggers: [
    { event: 'GameStart', handle(host, ownerId) {
      host.queueSkill({ skillId: CHUANXIE_MAJUN_CHUANXIE, ownerId, step: 'initial-suit', data: {} })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const current = dataOf(host.state).chuanshe?.[ownerId]
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const card = cardId && host.state.cards[cardId]
      if (!current?.suit || !card || card.suit !== current.suit) return
      const at = suitCycle.indexOf(current.suit as typeof suitCycle[number])
      const gainedSuit = suitCycle[(at + 1) % suitCycle.length]!
      current.suit = suitCycle[(at + 2) % suitCycle.length]!
      const candidates = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.suit === gainedSuit)
      if (!candidates.length || !playerOf(host.state, ownerId)?.alive) return
      const gained = host.rng.pick(candidates)
      moveCard(host.state, gained, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [gained], reason: CHUANXIE_MAJUN_CHUANXIE }, { sourceId: ownerId, cardIds: [gained] })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'initial-suit') return
    const suit = (response.payload as { optionId?: string }).optionId
    if (suitCycle.includes(suit as typeof suitCycle[number]))
      (dataOf(host.state).chuanshe ??= {})[ownerId] = { suit: suit! }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'initial-suit') return
    const options = suitCycle.map((suit) => ({ id: suit, label: ({ spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方片' } as const)[suit] }))
    host.askSkill({ skillId: CHUANXIE_MAJUN_CHUANXIE, ownerId, step: 'initial-suit', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【传械】：记录一种花色', timeoutMs: 25_000, optional: false, options,
    }) })
  },
})

registerSkillRuntime({
  id: CHUANXIE_MAJUN_QIAOSI,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    if ((context.event.sourceId !== ownerId && context.event.targetId !== ownerId)
      || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0
      || usedThisTurn(host.state, ownerId, CHUANXIE_MAJUN_QIAOSI)) return
    const data = dataOf(host.state).chuanshe?.[ownerId]
    if (!data?.suit) return
    host.queueSkill({ skillId: CHUANXIE_MAJUN_QIAOSI, ownerId, step: 'change', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'change') return
    host.askSkill({ skillId: CHUANXIE_MAJUN_QIAOSI, ownerId, step: 'change', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【巧思】：调整记录的花色', timeoutMs: 25_000, optional: true,
      options: [{ id: 'previous', label: '上一种花色' }, { id: 'next', label: '下一种花色' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'change') return
    const direction = (response.payload as { optionId?: string }).optionId
    if (direction !== 'previous' && direction !== 'next') return
    const data = dataOf(host.state).chuanshe?.[ownerId]
    if (!data?.suit || usedThisTurn(host.state, ownerId, CHUANXIE_MAJUN_QIAOSI)) return
    const index = suitCycle.indexOf(data.suit as typeof suitCycle[number])
    data.suit = suitCycle[(index + (direction === 'next' ? 1 : 3)) % 4]!
    markUsedThisTurn(host.state, ownerId, CHUANXIE_MAJUN_QIAOSI)
  },
})

const fieldCardIds = (state: SanguoshaState): CardId[] => state.players.flatMap((player) => [
  ...Object.values(player.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
  ...player.zones.judgingArea,
])
const cardRank = (state: SanguoshaState, cardId: CardId): number => Number(state.cards[cardId]?.rank ?? Number.MAX_SAFE_INTEGER)
const lowestRankIds = (state: SanguoshaState, cardIds: CardId[]): CardId[] => {
  if (!cardIds.length) return []
  const minimum = Math.min(...cardIds.map((cardId) => cardRank(state, cardId)))
  return cardIds.filter((cardId) => cardRank(state, cardId) === minimum)
}
const huangfuState = (state: SanguoshaState, ownerId: PlayerId) => {
  const table = dataOf(state).huangfusong ??= {}
  return table[ownerId] ??= { turn: state.turnNumber, usedTargets: [], empoweredIds: [], extraDamage: 0 }
}
const resetHuangfuTurn = (state: SanguoshaState, ownerId: PlayerId) => {
  const record = huangfuState(state, ownerId)
  if (record.turn !== state.turnNumber)
    Object.assign(record, { turn: state.turnNumber, usedTargets: [], empoweredIds: [], extraDamage: 0, limited: false })
  return record
}
const resolveChaozhenGain = (host: SkillHost, ownerId: PlayerId, source: 'field' | 'draw') => {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || dataOf(host.state).huangfusongChaozhenDisabled?.[ownerId] === host.state.turnNumber) return
  const candidates = source === 'field' ? fieldCardIds(host.state) : host.state.zones.drawPile
  const tiedLowest = lowestRankIds(host.state, candidates)
  const cardId = tiedLowest.length ? host.rng.pick(tiedLowest) : undefined
  if (!cardId) return
  if (source === 'draw') moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
  else {
    const cardOwner = host.state.players.find((player) => Object.values(player.zones.equipment).includes(cardId)
      || player.zones.judgingArea.includes(cardId))
    if (!cardOwner || !movePickedCard(host as never, cardOwner.id, cardId, { kind: 'hand', playerId: ownerId })) return
  }
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WU_HUANGFUSONG_CHAOZHEN }, { sourceId: ownerId, cardIds: [cardId] })
  if (cardRank(host.state, cardId) === 1) {
    ;(dataOf(host.state).huangfusongChaozhenDisabled ??= {})[ownerId] = host.state.turnNumber
    recover(host as never, ownerId, 1, ownerId)
  }
  host.dispatch('SkillActivated', { skillId: WU_HUANGFUSONG_CHAOZHEN, skillName: '朝镇', playerId: ownerId, cardIds: [cardId] },
    { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
}

registerSkillRuntime({
  id: WU_HUANGFUSONG_CHAOZHEN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'prepare') return
      host.queueSkill({ skillId: WU_HUANGFUSONG_CHAOZHEN, ownerId, step: 'invoke', data: {} })
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
        host.queueSkill({ skillId: WU_HUANGFUSONG_CHAOZHEN, ownerId, step: 'invoke', data: { dying: true } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || dataOf(host.state).huangfusongChaozhenDisabled?.[ownerId] === host.state.turnNumber) return
    if (prompt.step === 'invoke') {
      host.askSkill({ skillId: WU_HUANGFUSONG_CHAOZHEN, ownerId, step: 'invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【朝镇】：是否从场上或牌堆中获得点数最小的牌？',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step === 'source') {
      const options = prompt.data.options as string[]
      if (options.length === 1) {
        host.queueSkill({ skillId: WU_HUANGFUSONG_CHAOZHEN, ownerId, step: 'gain', data: { source: options[0] } })
        return
      }
      host.askSkill({ skillId: WU_HUANGFUSONG_CHAOZHEN, ownerId, step: 'source', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【朝镇】：选择获得牌的区域', timeoutMs: 25_000, optional: false,
        options: options.map((source) => ({ id: source, label: source === 'field' ? '场上' : '牌堆' })),
      }) })
      return
    }
    if (prompt.step === 'gain') {
      const source = prompt.data.source as 'field' | 'draw'
      const candidates = source === 'field' ? fieldCardIds(host.state) : host.state.zones.drawPile
      if (lowestRankIds(host.state, candidates).length) resolveChaozhenGain(host, ownerId, source)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !playerOf(host.state, ownerId)?.alive) return
      const options = [
        ...(lowestRankIds(host.state, fieldCardIds(host.state)).length ? ['field'] : []),
        ...(lowestRankIds(host.state, host.state.zones.drawPile).length ? ['draw'] : []),
      ]
      if (options.length) host.queueSkill({ skillId: WU_HUANGFUSONG_CHAOZHEN, ownerId, step: 'source', data: { options } })
      return
    }
    if (resolution.step === 'source') {
      const source = (response.payload as { optionId?: string }).optionId
      if (!(resolution.data.options as string[]).includes(source ?? '')) return
      host.queueSkill({ skillId: WU_HUANGFUSONG_CHAOZHEN, ownerId, step: 'gain', data: { source } })
      return
    }
    return
  },
})

registerSkillRuntime({
  id: WU_HUANGFUSONG_LIANJIE,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; fromKind?: string; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || payload.fromKind !== 'hand' || !payload.cardId || !payload.targetIds?.length) return
      const owner = playerOf(host.state, ownerId)
      const card = host.state.cards[payload.cardId]
      if (!owner?.alive || card?.rank === undefined || owner.zones.hand.some((id) => cardRank(host.state, id) < cardRank(host.state, payload.cardId!))) return
      const state = resetHuangfuTurn(host.state, ownerId)
      const points = dataOf(host.state).huangfusongLianjiePoints ??= {}
      const history = points[ownerId]
      if (!history || history.turn !== host.state.turnNumber) points[ownerId] = { turn: host.state.turnNumber, points: [] }
      if ((points[ownerId]?.points ?? []).includes(card.rank)) return
      const candidates = alivePlayers(host.state).filter((target) => target.zones.hand.length && !state.usedTargets.includes(target.id))
      if (!candidates.length) return
      host.queueSkill({ skillId: WU_HUANGFUSONG_LIANJIE, ownerId, step: 'target', data: { rank: card.rank } })
    } },
    { event: 'DamageCaused', handle(host, ownerId, context) {
      const state = dataOf(host.state).huangfusong?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId | null; amount?: number }
      if (context.event.sourceId !== ownerId || !state?.limited || state.turn !== host.state.turnNumber
        || !payload.cardId || !state.empoweredIds.includes(payload.cardId)) return
      payload.amount = Number(payload.amount ?? 0) + Math.min(5, state.extraDamage)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      const state = resetHuangfuTurn(host.state, ownerId)
      state.extraDamage += 1
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const state = huangfuState(host.state, ownerId)
      Object.assign(state, { turn: host.state.turnNumber, usedTargets: [], empoweredIds: [], extraDamage: 0, limited: false })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const state = dataOf(host.state).huangfusong?.[ownerId]
      if (state?.limited && state.turn === host.state.turnNumber && playerOf(host.state, ownerId)?.alive)
        host.queueSkill({ skillId: WU_HUANGFUSONG_JIANGXIAN, ownerId, step: 'lose-skill', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'target') {
      const state = huangfuState(host.state, ownerId)
      const candidates = alivePlayers(host.state).filter((target) => target.zones.hand.length && !state.usedTargets.includes(target.id))
      if (!candidates.length) return
      host.askSkill({ skillId: WU_HUANGFUSONG_LIANJIE, ownerId, step: 'target', data: prompt.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【连捷】：选择一名尚未被此技能放置过手牌的角色',
        timeoutMs: 25_000, optional: true, candidateIds: candidates.map((target) => target.id), min: 0, max: 1,
      }) })
      return
    }
    if (prompt.step === 'lowest-card') {
      const targetId = prompt.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const candidates = target ? lowestRankIds(host.state, target.zones.hand) : []
      if (!target?.alive || !candidates.length) return
      host.askSkill({ skillId: WU_HUANGFUSONG_LIANJIE, ownerId, step: 'lowest-card', data: prompt.data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【连捷】：选择该角色手牌中点数最小的一张置于牌堆底',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const state = huangfuState(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      const point = Number(resolution.data.rank)
      const points = dataOf(host.state).huangfusongLianjiePoints?.[ownerId]
      if (!target?.alive || !target.zones.hand.length || state.usedTargets.includes(targetId)
        || points?.turn === host.state.turnNumber && points.points.includes(point)) return
      host.queueSkill({ skillId: WU_HUANGFUSONG_LIANJIE, ownerId, step: 'lowest-card', data: { targetId, rank: point } })
      return
    }
    if (resolution.step !== 'lowest-card') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const lowest = target ? lowestRankIds(host.state, target.zones.hand) : []
    const point = Number(resolution.data.rank)
    const points = dataOf(host.state).huangfusongLianjiePoints ??= {}
    const pointHistory = points[ownerId]
    if (!owner?.alive || !target?.alive || !selected || !lowest.includes(selected)
      || huangfuState(host.state, ownerId).usedTargets.includes(targetId)
      || pointHistory?.turn === host.state.turnNumber && pointHistory.points.includes(point)) return
    moveCard(host.state, selected, { kind: 'hand', playerId: targetId }, { kind: 'drawPile' })
    const state = huangfuState(host.state, ownerId)
    state.usedTargets.push(targetId)
    if (!pointHistory || pointHistory.turn !== host.state.turnNumber) points[ownerId] = { turn: host.state.turnNumber, points: [point] }
    else pointHistory.points.push(point)
    const drawn = drawCards(host.state, host.rng, ownerId, Math.max(0, owner.maxHp - owner.zones.hand.length), (name, data) => host.dispatch(name, data))
    for (const cardId of drawn) if (!state.empoweredIds.includes(cardId)) state.empoweredIds.push(cardId)
    host.dispatch('SkillActivated', { skillId: WU_HUANGFUSONG_LIANJIE, skillName: '连捷', playerId: ownerId,
      targetId, placedCardId: selected, drawnCardIds: drawn }, { sourceId: ownerId, targetId, cardIds: [selected, ...drawn] })
  },
  globalUnlimitedCardUses(state, ownerId, actorId, cardId) {
    const record = dataOf(state).huangfusong?.[ownerId]
    return ownerId === actorId && record?.turn === state.turnNumber && Boolean(record.empoweredIds.includes(cardId))
  },
  globalIgnoresDistanceToCard(state, ownerId, actorId, _targetId, cardId) {
    const record = dataOf(state).huangfusong?.[ownerId]
    return ownerId === actorId && record?.turn === state.turnNumber && Boolean(record.empoweredIds.includes(cardId))
  },
})

registerSkillRuntime({
  id: WU_HUANGFUSONG_JIANGXIAN,
  limited: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && !owner.usedLimitedSkills.includes(WU_HUANGFUSONG_JIANGXIAN)
      ? [{ id: `skill:${WU_HUANGFUSONG_JIANGXIAN}`, label: '将贤：本回合连捷牌造成伤害时递增伤害' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${WU_HUANGFUSONG_JIANGXIAN}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || owner.usedLimitedSkills.includes(WU_HUANGFUSONG_JIANGXIAN)) return
    owner.usedLimitedSkills.push(WU_HUANGFUSONG_JIANGXIAN)
    const state = huangfuState(host.state, ownerId)
    Object.assign(state, { turn: host.state.turnNumber, limited: true, extraDamage: 0 })
    host.dispatch('SkillActivated', { skillId: WU_HUANGFUSONG_JIANGXIAN, skillName: '将贤', playerId: ownerId }, { sourceId: ownerId })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'lose-skill') return
    const candidates = ownedSkillIds(host.state, ownerId, characterSkillIdsOf).filter((skillId) =>
      skillId === WU_HUANGFUSONG_CHAOZHEN || skillId === WU_HUANGFUSONG_LIANJIE)
    if (!candidates.length) return
    host.askSkill({ skillId: WU_HUANGFUSONG_JIANGXIAN, ownerId, step: 'lose-skill', data: { candidates }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【将贤】：选择于回合结束时失去的技能', timeoutMs: 25_000,
      optional: false, options: candidates.map((skillId) => ({ id: skillId, label: skillId === WU_HUANGFUSONG_CHAOZHEN ? '失去【朝镇】' : '失去【连捷】' })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'lose-skill') return
    const selected = (response.payload as { optionId?: string }).optionId
    if (!(resolution.data.candidates as string[]).includes(selected ?? '')) return
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    owner.permanentlyLostSkills ??= []
    if (!owner.permanentlyLostSkills.includes(selected!)) owner.permanentlyLostSkills.push(selected!)
  },
})

export const HISTORICAL_BATCH90_CHARACTERS: readonly CharacterDefinition[] = [
  WENYUAN_B90, ZHUGEJING_B90, MOU_GUOJIA_B90, XING_XUNYU_B90, QIQIAO_MAJUN_B90,
  CHUANXIE_MAJUN_B90, LE_DIAOCHAN_B90, YUANYIN_B90, WU_HUANGFUSONG_B90, PANGFENGYI_B90,
]
