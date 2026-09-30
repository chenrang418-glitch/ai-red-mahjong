// 武将册第42批（序号536–545）。此文件只承载技能运行时和定义；未提供立绘/语音资产时沿用空接入点。
import { continueDyingRescue } from '../../engine/damage'
import { drawCards, revealTopCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { claimDeathCards, heldDeathCards, releaseDeathCards } from '../../engine/death-claim'
import { flipCharacter, restoreCharacter } from '../../engine/character-state'
import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { effectiveCardColor, effectiveCardSuit, grantSkill, registerSkillRuntime, replaceTemporarySkills, type SkillHost, type ViewAsOption } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { effectiveGenderOf, effectiveKingdomOf } from '../../engine/huashen'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { executeUseCardAction } from '../../engine/cards/basic'
import { DAMAGE_TRICKS, instantTrickActions } from '../../engine/cards/tricks'
import { startPindian, registerPindianContinuation, finishPindianSettlement } from '../../engine/pindian'
import { JUXIANG } from './forest-zhurong'
import { YINGHUN } from './forest-sunjian'
import { HUOSHOU } from './forest-menghuo'
import { XINGSHANG, SONGWEI } from './forest-caopi'
import { BAZHEN, HUOJI, KANPO } from './fire-wolongzhuge'
import type { CharacterDefinition } from './types'

const JIE_LIANHUAN = 'jie-lianhuan-b42'
const JIE_NIEPAN = 'jie-niepan-b42'
const JIE_SHUANGXIONG = 'jie-shuangxiong-b42'
const JIE_LUANJI = 'jie-luanji-b42'
const JIE_XUEYI = 'jie-xueyi-b42'
const JIE_DUANLIANG = 'jie-duanliang-b42'
const JIE_JIZI = 'jie-jiezi-b42'
const JIE_ZAIQI = 'jie-zaiqi-b42'
const JIE_LIEREN = 'jie-lieren-b42'
const JIE_FANGZHU = 'jie-fangzhu-b42'
const JIE_XINGSHANG = 'jie-xingshang-b42'
const POLU = 'polu-b42'
const JIE_JIUCHI = 'jie-jiuchi-b42'
const JIE_ROULIN = 'jie-roulin-b42'
const JIE_BENGHUAI = 'jie-benghuai-b42'
const JIE_BAONUE = 'jie-baonue-b42'
const CAOYING_LINGREN = 'lingren-b42'
const CAOYING_FUJIAN = 'fujian-b42'
const B42_BAONUE_TAG = 'jie-baonue-b42'

type B42State = SanguoshaState & {
  b42Shuangxiong?: Record<PlayerId, { turnNumber: number; color: 'red' | 'black' }>
  b42DuelSlashes?: Record<CardId, CardId[]>
  b42ShuangxiongReplaceDraw?: Record<PlayerId, number>
  b42LuanjiSuits?: Record<PlayerId, { turnNumber: number; suits: string[] }>
  b42JieZaiqiPending?: Record<PlayerId, { targets: PlayerId[]; index: number; turnNumber: number }>
  b42Polu?: { count: number }
  b42CaoYing?: Record<PlayerId, { turnNumber: number; phaseInstanceId: string; used: boolean }>
  b42PlayPhase?: Record<PlayerId, string>
  b42LingrenBonus?: Record<string, number>
  b42BenghuaiDisabled?: Record<PlayerId, number>
}

registerSkillRuntime({
  id: JIE_JIUCHI,
  unlimitedWine: true,
  viewAs(state, ownerId) { return viewAs(state, ownerId, 'spade', '酒', '酒池') },
  triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
    const cardId = context.event.cardIds?.[0]
    if (context.event.sourceId !== ownerId || !cardId || !host.state.wineBoostedSlashCardIds?.includes(cardId)) return
    const state = host.state as B42State
    state.b42BenghuaiDisabled ??= {}
    state.b42BenghuaiDisabled[ownerId] = host.state.turnNumber
  } }],
})
registerSkillRuntime({
  id: JIE_ROULIN,
  dodgeResponsesFor(state, ownerId, sourceId, targetId) {
    const female = (id: PlayerId) => effectiveGenderOf(state, id) === 'female'
    return (ownerId === sourceId && targetId !== ownerId && female(targetId))
      || (ownerId === targetId && sourceId !== ownerId && female(sourceId)) ? 2 : 1
  },
})

function dongzhuoLowest(state: SanguoshaState, ownerId: PlayerId): boolean {
  const living = alive(state)
  const hp = player(state, ownerId)?.hp ?? Number.MAX_SAFE_INTEGER
  return hp <= Math.min(...living.map((entry) => entry.hp))
}
registerSkillRuntime({
  id: JIE_BENGHUAI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const state = host.state as B42State
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || state.b42BenghuaiDisabled?.[ownerId] === state.turnNumber
      || host.state.skillResolution || !player(host.state, ownerId)?.alive || dongzhuoLowest(host.state, ownerId)) return
    host.askSkill({ skillId: JIE_BENGHUAI, ownerId, step: 'choice', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【崩坏】：选择失去1点体力或减1点体力上限', timeoutMs: 20_000, optional: false,
      options: [{ id: 'hp', label: '失去1点体力' }, { id: 'max-hp', label: '减1点体力上限' }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice') return
    if ((response.payload as { optionId?: string }).optionId === 'max-hp') loseMaxHp(host as never, ownerId, 1, '崩坏')
    else loseHp(host as never, ownerId, 1, '崩坏')
  },
})

registerJudgmentContinuation(B42_BAONUE_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  if (judged.suit === 'spade' && player(host.state, ownerId)?.alive) recover(host as never, ownerId, 1, data.sourceId as PlayerId)
})
registerSkillRuntime({
  id: JIE_BAONUE, lord: true,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (player(host.state, ownerId)?.identity !== 'lord' || !player(host.state, ownerId)?.alive) return
    const sourceId = context.event.sourceId
    if (!sourceId || sourceId === ownerId || effectiveKingdomOf(host.state, sourceId) !== 'qun') return
    host.queueSkill({ skillId: JIE_BAONUE, ownerId, step: 'ask', data: { sourceId } })
  } }],
  startQueued(host, ownerId, prompt) {
    const sourceId = prompt.data.sourceId as PlayerId
    if (!player(host.state, sourceId)?.alive || !player(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: JIE_BAONUE, ownerId, step: 'ask', data: { sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: sourceId, prompt: '是否发动【暴虐】进行判定？若为黑桃，董卓回复1点体力', timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const sourceId = resolution.data.sourceId as PlayerId
    performJudgment(host as never, sourceId, '暴虐', { tag: B42_BAONUE_TAG, data: { ownerId, sourceId } })
  },
})

const player = (state: SanguoshaState, id: PlayerId) => state.players.find((entry) => entry.id === id)
const alive = (state: SanguoshaState) => state.players.filter((entry) => entry.alive)
const hand = (state: SanguoshaState, id: PlayerId) => player(state, id)?.zones.hand ?? []
const draw = (host: SkillHost, id: PlayerId, n: number, reason: string) => {
  const ids = drawCards(host.state, host.rng, id, n, (name, payload) => host.dispatch(name, payload))
  if (ids.length) host.dispatch('GainCard', { playerId: id, cardIds: ids, reason }, { targetId: id, cardIds: ids })
  return ids
}
const livingOthers = (state: SanguoshaState, id: PlayerId) => alive(state).filter((entry) => entry.id !== id)

function viewAs(state: SanguoshaState, ownerId: PlayerId, suit: string, asCardName: string, label: string): ViewAsOption[] {
  const owner = player(state, ownerId)
  if (!owner?.alive) return []
  return owner.zones.hand.filter((id) => effectiveCardSuit(state, ownerId, id) === suit && state.cards[id]?.name !== asCardName)
    .map((cardId) => ({ asCardName, cardId, label: `发动【${label}】：将【${state.cards[cardId]?.name ?? '牌'}】当【${asCardName}】使用` }))
}

// 界庞统【连环】的额外目标只作用于铁索连环，不扩张为所有锦囊额外目标。
registerSkillRuntime({
  id: JIE_LIANHUAN,
  viewAs(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive) return []
    return owner.zones.hand.filter((id) => effectiveCardSuit(state, ownerId, id) === 'club' && state.cards[id]?.name !== '铁索连环')
      .map((cardId) => ({ asCardName: '铁索连环', cardId, label: `【连环】：将【${state.cards[cardId]?.name}】当【铁索连环】使用或重铸` }))
  },
  extraTargetsForTrick(_state, _ownerId, name) { return name === '铁索连环' ? 1 : 0 },
})

// 涅槃独立于标版：界版濒死救回后还必须选择并实际获得八阵、火计、看破之一。
registerSkillRuntime({
  id: JIE_NIEPAN, limited: true,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && !owner.usedLimitedSkills.includes(JIE_NIEPAN)
      ? [{ id: `skill:${JIE_NIEPAN}`, label: '发动【涅槃】' }]
      : []
  },
  invokeActive(host, ownerId) {
    host.askSkill({ skillId: JIE_NIEPAN, ownerId, step: 'play', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '是否发动【涅槃】？', timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '弃置所有区域牌、摸三张并回复至3点体力' }, { id: 'no', label: '不发动' }],
    }) })
  },
  dyingIntercept(host, ownerId) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(JIE_NIEPAN)) return false
    host.askSkill({ skillId: JIE_NIEPAN, ownerId, step: 'invoke', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '是否发动【涅槃】？', timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动涅槃：弃置所有区域牌、摸三张并回复至3点体力' }, { id: 'no', label: '不发动' }],
    }) })
    return 'pending'
  },
  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step === 'play') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = player(host.state, ownerId)
      if (!owner?.alive || owner.usedLimitedSkills.includes(JIE_NIEPAN)) return
      owner.usedLimitedSkills.push(JIE_NIEPAN)
      for (const cardId of [...owner.zones.hand]) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      for (const [slot, cardId] of Object.entries(owner.zones.equipment)) if (cardId) {
        moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot: slot as never }, { kind: 'discardPile' })
        handleEquipmentLost(host, ownerId, cardId)
      }
      for (const cardId of [...owner.zones.judgingArea]) moveCard(host.state, cardId, { kind: 'judgingArea', playerId: ownerId }, { kind: 'discardPile' })
      draw(host, ownerId, 3, JIE_NIEPAN)
      const amount = Math.max(0, Math.min(3, owner.maxHp) - owner.hp)
      if (amount) recover(host as never, ownerId, amount, ownerId)
      restoreCharacter(host as never, ownerId, '涅槃')
      askNiepanSkill(host, ownerId, false)
      return
    }
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { continueDyingRescue(host); if (!host.state.dying) host.resumeAfterDying(); return }
      const owner = player(host.state, ownerId)
      if (!owner?.alive || owner.usedLimitedSkills.includes(JIE_NIEPAN)) return
      owner.usedLimitedSkills.push(JIE_NIEPAN)
      for (const cardId of [...owner.zones.hand]) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      for (const [slot, cardId] of Object.entries(owner.zones.equipment)) if (cardId) {
        moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot: slot as never }, { kind: 'discardPile' })
        handleEquipmentLost(host, ownerId, cardId)
      }
      for (const cardId of [...owner.zones.judgingArea]) moveCard(host.state, cardId, { kind: 'judgingArea', playerId: ownerId }, { kind: 'discardPile' })
      draw(host, ownerId, 3, JIE_NIEPAN)
      const amount = Math.max(0, Math.min(3, owner.maxHp) - owner.hp)
      if (amount) recover(host as never, ownerId, amount, ownerId)
      restoreCharacter(host as never, ownerId, '涅槃')
      host.state.dying = null
      askNiepanSkill(host, ownerId, true)
      return
    }
    if (resolution.step === 'skill') {
      const id = (response.payload as { optionId?: string }).optionId
      if (id === BAZHEN || id === HUOJI || id === KANPO) grantSkill(host.state, ownerId, id)
      if (resolution.data.dying) host.resumeAfterDying()
    }
  },
})

function askNiepanSkill(host: SkillHost, ownerId: PlayerId, dying: boolean): void {
  host.askSkill({ skillId: JIE_NIEPAN, ownerId, step: 'skill', data: { dying }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【涅槃】：选择获得一项技能', timeoutMs: 20_000, optional: false,
    options: [{ id: BAZHEN, label: '获得【八阵】' }, { id: HUOJI, label: '获得【火计】' }, { id: KANPO, label: '获得【看破】' }],
  }) })
}

const SHUANGXIONG_DAMAGE = 'jie-shuangxiong-damage'
registerSkillRuntime({
  id: JIE_SHUANGXIONG,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'draw' || host.state.skillResolution || !player(host.state, ownerId)?.alive) return
      host.askSkill({ skillId: JIE_SHUANGXIONG, ownerId, step: 'replace-draw', build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '是否发动【双雄】，改为展示牌堆顶两张牌并获得其中一张？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动双雄' }, { id: 'no', label: '正常摸牌' }],
      }) })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (context.event.sourceId !== ownerId || payload.cardName !== '决斗' || !payload.cardId
        || host.state.cards[payload.cardId]?.sourceSkillId !== JIE_SHUANGXIONG) return
      ;(host.state as B42State).b42DuelSlashes ??= {}
      ;(host.state as B42State).b42DuelSlashes![payload.cardId] = []
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string }
      const resolution = host.state.cardResolution
      if (resolution?.kind !== 'trick' || resolution.cardName !== '决斗' || resolution.sourceId !== ownerId
        || !resolution.cardId || host.state.cards[resolution.cardId]?.sourceSkillId !== JIE_SHUANGXIONG || payload.cardName !== '杀') return
      const responseCardId = context.event.cardIds?.[0]
      if (!responseCardId) return
      ;(host.state as B42State).b42DuelSlashes ??= {}
      ;((host.state as B42State).b42DuelSlashes![resolution.cardId] ??= []).push(responseCardId)
    } },
    { event: 'DrawPhase', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId }
      const owner = player(host.state, ownerId)
      if (p.playerId !== ownerId || host.state.skillResolution || !owner?.alive
        || (host.state as B42State).b42ShuangxiongReplaceDraw?.[ownerId] !== host.state.turnNumber) return
      const revealed = revealTopCards(host.state, host.rng, 2, JIE_SHUANGXIONG, (name, payload) => host.dispatch(name, payload))
      if (!revealed.length) return
      context.cancel()
      host.askSkill({ skillId: JIE_SHUANGXIONG, ownerId, step: 'gain', data: { cardIds: revealed }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【双雄】：获得其中一张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: revealed, hiddenCardSlots: [], min: 1, max: 1,
      }) })
    } },
    { event: 'AfterDamage', handle(host, ownerId, context) {
      const cardId = context.event.cardIds?.[0]
      if (context.event.targetId !== ownerId || !cardId) return
      const slashes = (host.state as B42State).b42DuelSlashes?.[cardId]
      if (!slashes) return
      const available = slashes.filter((slashId) => host.state.zones.discardPile.includes(slashId))
      if (available.length) host.queueSkill({ skillId: JIE_SHUANGXIONG, ownerId, step: 'take-slashes', data: { cardIds: available } })
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      const state = host.state as B42State
      if (state.b42Shuangxiong?.[ownerId]?.turnNumber === host.state.turnNumber) delete state.b42Shuangxiong[ownerId]
      state.b42DuelSlashes = {}
    } },
  ],
  viewAs(state, ownerId) {
    const entry = (state as B42State).b42Shuangxiong?.[ownerId]
    if (!entry || entry.turnNumber !== state.turnNumber) return []
    return hand(state, ownerId).filter((id) => effectiveCardColor(state, ownerId, id) !== entry.color)
      .map((cardId) => ({ asCardName: '决斗', cardId, label: `发动【双雄】：将异色【${state.cards[cardId]?.name}】当【决斗】使用` }))
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'take-slashes') return
    const cardIds = (prompt.data.cardIds as CardId[]).filter((id) => host.state.zones.discardPile.includes(id))
    if (!cardIds.length) return
    host.askSkill({ skillId: JIE_SHUANGXIONG, ownerId, step: 'take-slashes', data: { cardIds }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【双雄】：是否获得此次【决斗】中其他角色打出的${cardIds.length}张【杀】？`, timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '获得这些【杀】' }, { id: 'no', label: '不获得' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'replace-draw') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') {
        ;(host.state as B42State).b42ShuangxiongReplaceDraw ??= {}
        ;(host.state as B42State).b42ShuangxiongReplaceDraw![ownerId] = host.state.turnNumber
      }
      return
    }
    if (resolution.step === 'take-slashes') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const cardIds = (resolution.data.cardIds as CardId[]).filter((id) => host.state.zones.discardPile.includes(id))
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      if (cardIds.length) host.dispatch('GainCard', { playerId: ownerId, cardIds, reason: SHUANGXIONG_DAMAGE }, { sourceId: ownerId, targetId: ownerId, cardIds })
      return
    }
    if (resolution.step !== 'gain') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !(resolution.data.cardIds as CardId[]).includes(cardId) || !host.state.zones.processingArea.includes(cardId)) return
    const color = effectiveCardColor(host.state, ownerId, cardId)
    if (color !== 'red' && color !== 'black') return
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    const leftover = (resolution.data.cardIds as CardId[]).filter((id) => id !== cardId && host.state.zones.processingArea.includes(id))
    for (const id of leftover) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_SHUANGXIONG }, { targetId: ownerId, cardIds: [cardId] })
    const state = host.state as B42State
    state.b42Shuangxiong ??= {}
    state.b42Shuangxiong[ownerId] = { turnNumber: host.state.turnNumber, color }
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_SHUANGXIONG }, { sourceId: ownerId, cardIds: [cardId] })
  },
})

// 乱击的花色限制跨本回合发动记录，万箭的响应与伤害收益按同一张实体使用牌结算。
registerSkillRuntime({
  id: JIE_LUANJI,
  announcesSelf: true,
  activeActionUsesCard: true,
  activeActions(state, ownerId) {
    const cards = hand(state, ownerId)
    const spent = (state as B42State).b42LuanjiSuits?.[ownerId]
    for (let i = 0; i < cards.length; i += 1) for (let j = i + 1; j < cards.length; j += 1) {
      const firstSuit = effectiveCardSuit(state, ownerId, cards[i])
      const secondSuit = effectiveCardSuit(state, ownerId, cards[j])
      if (firstSuit && secondSuit && !(spent?.turnNumber === state.turnNumber && (spent.suits.includes(firstSuit) || spent.suits.includes(secondSuit)))) return [{ id: `skill:${JIE_LUANJI}`, label: '发动【乱击】：将两张手牌当【万箭齐发】使用' }]
    }
    return []
  },
  invokeActive(host, ownerId) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({ skillId: JIE_LUANJI, ownerId, step: 'cards', build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【乱击】：选择两张手牌（不能使用本回合发动过此技能的花色）', timeoutMs: 25_000,
      optional: true, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 2,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'cards') return
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!ids.length) return
    if (ids.length !== 2 || ids[0] === ids[1]) return
    const suit1 = effectiveCardSuit(host.state, ownerId, ids[0])
    const suit2 = effectiveCardSuit(host.state, ownerId, ids[1])
    const spent = (host.state as B42State).b42LuanjiSuits?.[ownerId]
    if (ids.some((id) => !hand(host.state, ownerId).includes(id))
      || !suit1 || !suit2 || (spent?.turnNumber === host.state.turnNumber && (spent.suits.includes(suit1) || spent.suits.includes(suit2)))) return
    const [action] = instantTrickActions(host.state, ownerId, ids[0], '万箭齐发')
    if (action?.kind === 'use-card') {
      const state = host.state as B42State
      state.b42LuanjiSuits ??= {}
      const record = state.b42LuanjiSuits[ownerId]?.turnNumber === host.state.turnNumber ? state.b42LuanjiSuits[ownerId] : { turnNumber: host.state.turnNumber, suits: [] }
      record.suits.push(suit1, suit2)
      state.b42LuanjiSuits[ownerId] = record
      executeUseCardAction(host as never, ownerId, { ...action, cardIds: ids })
    }
  },
  triggers: [
    { event: 'CardResponded', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; cardName?: string }
      const resolution = host.state.cardResolution
      if (resolution?.kind !== 'trick' || resolution.sourceId !== ownerId || resolution.cardName !== '万箭齐发') return
      if (p.playerId === ownerId || p.cardName !== '闪') return
      draw(host, ownerId, 1, JIE_LUANJI)
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const p = context.event.payload as { cardName?: string; cardId?: CardId; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || p.cardName !== '万箭齐发' || !p.cardId) return
      const dealt = host.state.cardDamageLedger?.[p.cardId] ?? 0
      if (dealt === 0) draw(host, ownerId, (p.targetIds ?? []).length, JIE_LUANJI)
    } },
    { event: 'TurnEnd', handle(host, ownerId) { delete (host.state as B42State).b42LuanjiSuits?.[ownerId] } },
  ],
})

registerSkillRuntime({
  id: JIE_XUEYI, lord: true,
  maxCardsBonus(state, ownerId) {
    const owner = player(state, ownerId)
    if (owner?.identity !== 'lord') return 0
    return state.players.filter((entry) => entry.alive && entry.id !== ownerId && effectiveKingdomOf(state, entry.id) === 'qun').length * 2
  },
})

registerSkillRuntime({
  id: JIE_DUANLIANG,
  viewAs(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive) return []
    const sources = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    return sources.filter((id) => {
      const card = state.cards[id]
      return Boolean(card && (card.category === 'basic' || card.category === 'equipment') && effectiveCardColor(state, ownerId, id) === 'black')
    }).map((cardId) => ({ asCardName: '兵粮寸断', cardId, label: `将【${state.cards[cardId]?.name}】当【兵粮寸断】使用` }))
  },
  trickDistanceBonus(state, ownerId, targetId, cardName) {
    if (cardName !== '兵粮寸断') return 0
    const ownerCount = hand(state, ownerId).length
    return hand(state, targetId).length >= ownerCount ? Number.MAX_SAFE_INTEGER : 0
  },
})

registerSkillRuntime({
  id: JIE_JIZI,
  triggers: [{ event: 'PhaseSkipped', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.phase === 'draw' && payload.playerId !== ownerId && player(host.state, ownerId)?.alive) draw(host, ownerId, 1, JIE_JIZI)
  } }],
})

const ZAIQI_NEXT = 'next'
function askZaiqiChoice(host: SkillHost, ownerId: PlayerId): void {
  const pending = (host.state as B42State).b42JieZaiqiPending?.[ownerId]
  if (!pending || pending.turnNumber !== host.state.turnNumber) return
  while (pending.index < pending.targets.length && !player(host.state, pending.targets[pending.index])?.alive) pending.index += 1
  const targetId = pending.targets[pending.index]
  if (!targetId) { delete (host.state as B42State).b42JieZaiqiPending?.[ownerId]; return }
  host.askSkill({ skillId: JIE_ZAIQI, ownerId, step: ZAIQI_NEXT, data: { targetId }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: targetId, prompt: '【再起】：选择一项', timeoutMs: 20_000, optional: false,
    options: [{ id: 'draw', label: '摸一张牌' }, { id: 'recover', label: '令界孟获回复1点体力' }],
  }) })
}
registerSkillRuntime({
  id: JIE_ZAIQI,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId; phase?: string }
    const state = host.state as B42State
    const count = state.turnRedDiscardCount?.turnNumber === host.state.turnNumber ? state.turnRedDiscardCount.count : 0
    if (p.playerId !== ownerId || p.phase !== 'discard' || count <= 0 || host.state.skillResolution) return
    const candidates = alive(host.state).map((entry) => entry.id)
    host.askSkill({ skillId: JIE_ZAIQI, ownerId, step: 'targets', data: { count, turnNumber: host.state.turnNumber }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: `【再起】：选择至多${Math.min(count, candidates.length)}名角色，依次选择摸牌或令你回复`,
      timeoutMs: 20_000, optional: true, candidateIds: candidates, min: 0, max: Math.min(count, candidates.length),
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const targets = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targets.length) return
      ;(host.state as B42State).b42JieZaiqiPending ??= {}
      ;(host.state as B42State).b42JieZaiqiPending![ownerId] = { targets, index: 0, turnNumber: host.state.turnNumber }
      askZaiqiChoice(host, ownerId)
      return
    }
    const pending = (host.state as B42State).b42JieZaiqiPending?.[ownerId]
    if (!pending || pending.turnNumber !== host.state.turnNumber) return
    if (resolution.step === ZAIQI_NEXT) {
      const targetId = resolution.data.targetId as PlayerId
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'draw') draw(host, targetId, 1, JIE_ZAIQI)
      else if (option === 'recover' && player(host.state, ownerId)?.alive) recover(host as never, ownerId, 1, ownerId)
      pending.index += 1
      askZaiqiChoice(host, ownerId)
    }
  },
})

registerSkillRuntime({
  id: JIE_LIEREN,
  triggers: [{ event: 'TargetSpecified', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const p = context.event.payload as { cardName?: string }
    if (p.cardName !== '杀' || !context.event.targetId || context.event.targetId === ownerId) return
    host.queueSkill({ skillId: JIE_LIEREN, ownerId, step: 'ask', data: { targetId: context.event.targetId } })
  } }],
  startQueued(host, ownerId, prompt) {
    const targetId = prompt.data.targetId as PlayerId
    const target = player(host.state, targetId)
    if (!target?.alive || !hand(host.state, ownerId).length || !hand(host.state, targetId).length) return
    host.askSkill({ skillId: JIE_LIEREN, ownerId, step: 'ask', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【烈刃】：是否与${target.nickname}拼点？`, timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '拼点' }, { id: 'no', label: '放弃' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'gain') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const realId = selected && resolvePickedCard(host.state, targetId, selected)
      if (!realId) return
      movePickedCard(host as never, targetId, realId, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [realId], reason: JIE_LIEREN }, { sourceId: ownerId, targetId: ownerId, cardIds: [realId] })
      return
    }
    if (resolution.step !== 'ask' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    if (!player(host.state, targetId)?.alive || !hand(host.state, ownerId).length || !hand(host.state, targetId).length) return
    startPindian(host as never, { id: `jie-lieren-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId, reason: JIE_LIEREN, continuationTag: `${JIE_LIEREN}-result` })
  },
})
registerPindianContinuation(`${JIE_LIEREN}-result`, (host, result) => {
  const skillHost = host as unknown as SkillHost
  if (result.outcome === 'initiator-win') {
    finishPindianSettlement(host)
    if (!player(host.state, result.initiatorId)?.alive || !player(host.state, result.opponentId)?.alive
      || !hasPickableCards(host.state, result.opponentId)) return
    const pickable = pickableCardsOf(host.state, result.opponentId)
    skillHost.askSkill({ skillId: JIE_LIEREN, ownerId: result.initiatorId, step: 'gain', data: { targetId: result.opponentId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: result.initiatorId, prompt: `【烈刃】：获得${player(host.state, result.opponentId)?.nickname ?? '目标'}的一张牌`,
      timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
    }) })
    return
  }
  const state = host.state
  const initiator = player(state, result.initiatorId)
  const opponent = player(state, result.opponentId)
  if (!initiator?.alive || !opponent?.alive) { finishPindianSettlement(host); return }
  const exchanged: Array<{ playerId: PlayerId; cardId: CardId }> = []
  if (state.zones.processingArea.includes(result.opponentCardId)) {
    moveCard(state, result.opponentCardId, { kind: 'processingArea' }, { kind: 'hand', playerId: result.initiatorId })
    exchanged.push({ playerId: result.initiatorId, cardId: result.opponentCardId })
  }
  if (state.zones.processingArea.includes(result.initiatorCardId)) {
    moveCard(state, result.initiatorCardId, { kind: 'processingArea' }, { kind: 'hand', playerId: result.opponentId })
    exchanged.push({ playerId: result.opponentId, cardId: result.initiatorCardId })
  }
  for (const entry of exchanged) skillHost.dispatch('GainCard', { playerId: entry.playerId, cardIds: [entry.cardId], reason: JIE_LIEREN }, { sourceId: entry.playerId, targetId: entry.playerId, cardIds: [entry.cardId] })
  finishPindianSettlement(host)
})

// 界版行殇改变了基础版的二选一，因此使用独立认领运行时，避免复用只会拿牌的基础效果。
registerSkillRuntime({
  id: JIE_XINGSHANG,
  claimsDeathCards(state, ownerId, deadId) { return ownerId !== deadId && Boolean(player(state, ownerId)?.alive) },
  triggers: [{ event: 'Death', handle(host, ownerId) {
    const claim = host.state.deathClaim
    if (claim?.claimantId === ownerId && claim.skillId === JIE_XINGSHANG) host.queueSkill({ skillId: JIE_XINGSHANG, ownerId, step: 'choose', data: { deadId: claim.deadId } })
  } }],
  startQueued(host, ownerId) {
    const claim = host.state.deathClaim
    if (claim?.claimantId !== ownerId || claim.skillId !== JIE_XINGSHANG || !player(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: JIE_XINGSHANG, ownerId, step: 'choose', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【行殇】：选择一项', timeoutMs: 20_000, optional: true,
      options: [{ id: 'take', label: `获得死者全部牌（${heldDeathCards(host.state).length}张）` }, { id: 'recover', label: '回复1点体力' }, { id: 'cancel', label: '放弃' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const choice = (response.payload as { optionId?: string }).optionId
    if (choice === 'take') claimDeathCards(host, ownerId, '行殇')
    else {
      releaseDeathCards(host)
      if (choice === 'recover' && player(host.state, ownerId)?.alive) recover(host as never, ownerId, 1, ownerId)
    }
  },
})

// 界放逐由目标选择收益分支；弃牌支路会实际弃置其区域牌并失去体力。
const FANGZHU_TARGET = 'target-choice'
const FANGZHU_DISCARD = 'discard'
registerSkillRuntime({
  id: JIE_FANGZHU,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId === ownerId) host.queueSkill({ skillId: JIE_FANGZHU, ownerId, step: 'invoke', data: {} })
  } }],
  startQueued(host, ownerId) {
    const owner = player(host.state, ownerId)
    const targets = livingOthers(host.state, ownerId)
    if (!owner?.alive || owner.maxHp - owner.hp <= 0 || !targets.length) return
    host.askSkill({ skillId: JIE_FANGZHU, ownerId, step: 'invoke', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【放逐】：是否令一名角色选择摸${owner.maxHp - owner.hp}张牌并翻面，或弃牌并失去1点体力？`, timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidates = livingOthers(host.state, ownerId).map((entry) => entry.id)
      if (!candidates.length) return
      host.askSkill({ skillId: JIE_FANGZHU, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【放逐】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!targetId || !target?.alive) return
      const x = Math.max(0, (player(host.state, ownerId)?.maxHp ?? 0) - (player(host.state, ownerId)?.hp ?? 0))
      const targetCards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
      const options = [{ id: 'draw-flip', label: `摸${x}张牌并翻面` }]
      if (targetCards.length >= x) options.push({ id: FANGZHU_DISCARD, label: `弃置${x}张牌并失去1点体力` })
      host.askSkill({ skillId: JIE_FANGZHU, ownerId, step: FANGZHU_TARGET, data: { targetId, x }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: targetId, prompt: `【放逐】：选择摸${x}张牌并翻面，或弃置${x}张牌并失去1点体力`, timeoutMs: 20_000, optional: false,
        options,
      }) })
      return
    }
    if (resolution.step === FANGZHU_TARGET) {
      const targetId = resolution.data.targetId as PlayerId
      const target = player(host.state, targetId)
      const x = Number(resolution.data.x ?? 0)
      if (!target?.alive) return
      if ((response.payload as { optionId?: string }).optionId === 'draw-flip') {
        draw(host, targetId, x, JIE_FANGZHU)
        flipCharacter(host as never, targetId, '放逐')
        return
      }
      const candidates = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
      if (candidates.length < x) return
      const count = x
      if (count === 0) { loseHp(host as never, targetId, 1, '放逐'); return }
      host.askSkill({ skillId: JIE_FANGZHU, ownerId, step: FANGZHU_DISCARD, data: { targetId, count }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: `【放逐】：选择弃置${count}张牌`, timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (resolution.step === FANGZHU_DISCARD) {
      const targetId = resolution.data.targetId as PlayerId
      const target = player(host.state, targetId)
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive) return
      for (const cardId of ids) {
        const from = locateOwnedCard(host.state, targetId, cardId)
        if (from?.kind === 'hand' || from?.kind === 'equipment') {
          moveCard(host.state, cardId, from, { kind: 'discardPile' })
          if (from.kind === 'equipment') handleEquipmentLost(host, targetId, cardId)
        }
      }
      const discarded = ids.filter((cardId) => host.state.zones.discardPile.includes(cardId))
      if (discarded.length) host.dispatch('LoseCard', { playerId: targetId, cardIds: discarded, reason: JIE_FANGZHU }, { sourceId: ownerId, targetId, cardIds: discarded })
      loseHp(host as never, targetId, 1, '放逐')
    }
  },
})

registerSkillRuntime({
  id: POLU,
  triggers: [
    { event: 'Death', handle(host, ownerId, context) {
      const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
      const didKill = context.event.sourceId === ownerId && deadId !== ownerId
      const ownerDied = deadId === ownerId
      if (!didKill && !ownerDied) return
      const state = host.state as B42State
      state.b42Polu ??= { count: 0 }
      state.b42Polu.count += 1
      host.queueSkill({ skillId: POLU, ownerId, step: 'targets', data: { count: state.b42Polu.count, died: ownerDied } })
    }, allowDeadOwner: true },
  ],
  startQueued(host, ownerId, prompt) {
    const candidates = alive(host.state).map((entry) => entry.id)
    if (!candidates.length) return
    host.askSkill({ skillId: POLU, ownerId, step: 'targets', data: prompt.data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: `【破虏】：可令任意名角色各摸${Number(prompt.data.count)}张牌`, timeoutMs: 20_000, optional: true,
      candidateIds: candidates, min: 0, max: candidates.length,
    }) })
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'targets') return
    const targets = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const count = Math.max(0, Number(resolution.data.count ?? 0))
    for (const targetId of targets) if (player(host.state, targetId)?.alive) draw(host, targetId, count, POLU)
  },
})

const LINGREN_GUESS = 'guess'
const LINGREN_TARGET = 'target'
const LINGREN_INVOKE = 'invoke'
function askLingrenGuess(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, cardId: CardId, index: number, guesses: boolean[]): void {
  const labels = ['基本牌', '锦囊牌', '装备牌']
  const owner = player(host.state, ownerId)
  const target = player(host.state, targetId)
  if (!owner?.alive || !target?.alive) return
  if (index >= labels.length) {
    const actual = ['basic', 'trick', 'equipment'].map((category) => target.zones.hand.some((id) => host.state.cards[id]?.category === category))
    const correct = guesses.reduce((total, guessed, i) => total + Number(guessed === actual[i]), 0)
    if (correct >= 1) {
      const key = `${host.state.turnNumber}:${cardId}:${targetId}`
      ;(host.state as B42State).b42LingrenBonus ??= {}
      ;(host.state as B42State).b42LingrenBonus![key] = 1
    }
    if (correct >= 2) draw(host, ownerId, 2, CAOYING_LINGREN)
    if (correct === 3) {
      replaceTemporarySkills(host.state, ownerId, CAOYING_LINGREN, [XINGSHANG, 'jianxiong'])
    }
    return
  }
  host.askSkill({ skillId: CAOYING_LINGREN, ownerId, step: LINGREN_GUESS, data: { targetId, cardId, index, guesses }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【凌人】：猜测${target.nickname}的手牌中是否有${labels[index]}`, timeoutMs: 20_000, optional: false,
    options: [{ id: 'yes', label: '有' }, { id: 'no', label: '没有' }],
  }) })
}
registerSkillRuntime({
  id: CAOYING_LINGREN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const state = host.state as B42State
      state.b42PlayPhase ??= {}
      state.b42PlayPhase[ownerId] = String(context.event.seq)
    } },
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; cardId?: CardId; targetIds?: PlayerId[]; targetId?: PlayerId }
      const targets = payload.targetIds ?? (context.event.targetId ? [context.event.targetId] : payload.targetId ? [payload.targetId] : [])
      const cardId = payload.cardId ?? context.event.cardIds?.[0]
      const cardName = payload.cardName
      const damaging = cardName === '杀' || (cardName !== undefined && DAMAGE_TRICKS.has(cardName))
      const owner = player(host.state, ownerId)
      const candidates = targets.filter((id) => id !== ownerId && player(host.state, id)?.alive)
      if (!damaging || context.event.sourceId !== ownerId || !candidates.length || !cardId || !owner?.alive
        || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
      const state = host.state as B42State
      const phaseInstanceId = state.b42PlayPhase?.[ownerId]
      const prior = state.b42CaoYing?.[ownerId]
      if (!phaseInstanceId || prior?.phaseInstanceId === phaseInstanceId && prior.used) return
      host.queueSkill({ skillId: CAOYING_LINGREN, ownerId, step: 'start', data: { targets: candidates, cardId, phaseInstanceId } })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId && (context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      replaceTemporarySkills(host.state, ownerId, CAOYING_LINGREN, [])
    } },
    { event: 'TurnEnd', handle(host, _ownerId) {
      const state = host.state as B42State
      for (const key of Object.keys(state.b42LingrenBonus ?? {})) if (key.startsWith(`${host.state.turnNumber}:`)) delete state.b42LingrenBonus?.[key]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'start') return
    const { targets, cardId, phaseInstanceId } = prompt.data as { targets: PlayerId[]; cardId: CardId; phaseInstanceId: string }
    const candidates = targets.filter((id) => player(host.state, id)?.alive)
    if (!candidates.length) return
    host.askSkill({ skillId: CAOYING_LINGREN, ownerId, step: LINGREN_INVOKE, data: { candidates, cardId, phaseInstanceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '是否发动【凌人】并猜测一名目标的手牌类别？', timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === LINGREN_INVOKE) {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const { candidates, cardId, phaseInstanceId } = resolution.data as { candidates: PlayerId[]; cardId: CardId; phaseInstanceId: string }
      const state = host.state as B42State
      if (state.b42PlayPhase?.[ownerId] !== phaseInstanceId) return
      state.b42CaoYing ??= {}
      state.b42CaoYing[ownerId] = { turnNumber: host.state.turnNumber, phaseInstanceId, used: true }
      const eligible = candidates.filter((id) => player(host.state, id)?.alive)
      if (eligible.length === 1) askLingrenGuess(host, ownerId, eligible[0], cardId, 0, [])
      else if (eligible.length > 1) host.askSkill({ skillId: CAOYING_LINGREN, ownerId, step: LINGREN_TARGET, data: { candidates: eligible, cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【凌人】：选择本牌的一名目标进行猜测', timeoutMs: 20_000, optional: false,
        candidateIds: eligible, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === LINGREN_TARGET) {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const { candidates, cardId } = resolution.data as { candidates: PlayerId[]; cardId: CardId }
      if (targetId && candidates.includes(targetId)) askLingrenGuess(host, ownerId, targetId, cardId, 0, [])
      return
    }
    if (resolution.step !== LINGREN_GUESS) return
    const { targetId, cardId, index, guesses } = resolution.data as { targetId: PlayerId; cardId: CardId; index: number; guesses: boolean[] }
    guesses.push((response.payload as { optionId?: string }).optionId === 'yes')
    askLingrenGuess(host, ownerId, targetId, cardId, index + 1, guesses)
  },
  outgoingDamage(state, _ownerId, context) {
    if (!context.cardId) return null
    const key = `${state.turnNumber}:${context.cardId}:${context.targetId}`
    return (state as B42State).b42LingrenBonus?.[key] ? { amount: context.amount + 1 } : null
  },
})

registerSkillRuntime({
  id: CAOYING_FUJIAN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || host.state.skillResolution) return
    const living = alive(host.state)
    if (living.some((entry) => entry.zones.hand.length === 0)) return
    const others = living.filter((entry) => entry.id !== ownerId)
    if (!others.length) return
    const x = Math.min(...living.map((entry) => entry.zones.hand.length))
    const target = host.rng.pick(others)
    const cards = host.rng.shuffle(target.zones.hand).slice(0, x)
    host.askSkill({ skillId: CAOYING_FUJIAN, ownerId, step: 'view', data: { targetId: target.id, cardIds: cards }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【伏间】：秘密观看${target.nickname}的${x}张手牌`, timeoutMs: 30_000, optional: false,
      purpose: 'skill', cardIds: [], viewOnlyCardIds: cards, hiddenCardSlots: [], min: 0, max: 0,
    }) })
  } }],
})

// 本批角色仅在相应运行时全部登记后加入公共武将池。
export const HISTORICAL_BATCH40_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'jie-pangtong-b42', name: '界·庞统', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: JIE_LIANHUAN, name: '连环', description: '你可以将一张梅花手牌当【铁索连环】使用或重铸；你使用【铁索连环】可以额外指定一名角色为目标。' },
    { id: JIE_NIEPAN, name: '涅槃', description: '限定技，出牌阶段或濒死时，你可以弃置你所有区域里的牌，然后摸三张牌并将体力回复至3点，复原武将牌，然后选择获得八阵、火计或看破。' },
  ] },
  { id: 'jie-yanliangwenchou-b42', name: '界·颜良文丑', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: JIE_SHUANGXIONG, name: '双雄', description: '摸牌阶段，你可以改为展示牌堆顶两张牌并获得其中一张；本回合你可以将与此法获得牌颜色不同的手牌当【决斗】使用；本回合你因【决斗】受到伤害后，可以获得此次【决斗】中其他角色打出的【杀】。' },
  ] },
  { id: 'jie-yuanshao-b42', name: '界·袁绍', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: JIE_LUANJI, name: '乱击', description: '你可以将两张手牌当【万箭齐发】使用（本回合不能使用你发动此技能时使用过的花色）；其他角色使用【闪】响应你使用的【万箭齐发】后，你摸一张牌；若此【万箭齐发】未造成伤害，你摸等同于目标数的牌。' },
    { id: JIE_XUEYI, name: '血裔', description: '主公技，锁定技，你的手牌上限+X（X为其他群势力角色数的两倍）。' },
  ] },
  { id: 'jie-xuhuang-b42', name: '界·徐晃', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: JIE_DUANLIANG, name: '断粮', description: '你可以将一张黑色基本牌或装备牌当【兵粮寸断】使用；你对手牌数不少于你的角色使用【兵粮寸断】无距离限制。' },
    { id: JIE_JIZI, name: '截辎', description: '锁定技，其他角色跳过摸牌阶段后，你摸一张牌。' },
  ] },
  { id: 'jie-menghuo-b42', name: '界·孟获', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'forest', skills: [
    { id: HUOSHOU, name: '祸首', description: '锁定技，【南蛮入侵】对你无效；其他角色使用【南蛮入侵】造成的伤害均视为其对你造成。' },
    { id: JIE_ZAIQI, name: '再起', description: '弃牌阶段结束时，你可以选择至多X名角色（X为本回合进入弃牌堆的红色牌数），令这些角色依次选择摸一张牌或令你回复1点体力。' },
  ] },
  { id: 'jie-zhurong-b42', name: '界·祝融', kingdom: 'shu', gender: 'female', maxHp: 4, pack: 'forest', skills: [
    { id: JUXIANG, name: '巨象', description: '锁定技，【南蛮入侵】对你无效；其他角色使用【南蛮入侵】结算结束后，若此牌仍在处理区，你获得之。' },
    { id: JIE_LIEREN, name: '烈刃', description: '当你使用【杀】指定一名角色为目标后，你可以与其拼点：若你赢，你获得其一张牌；若你没赢，你与其交换拼点牌。' },
  ] },
  { id: 'jie-caopi-b42', name: '界·曹丕', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'forest', skills: [
    { id: JIE_XINGSHANG, name: '行殇', description: '其他角色死亡时，你可以获得其所有牌或回复1点体力。' },
    { id: JIE_FANGZHU, name: '放逐', description: '你受到伤害后，可以令一名其他角色选择：摸X张牌并翻面，或弃置X张牌并失去1点体力（X为你已损失的体力值）。' },
    { id: SONGWEI, name: '颂威', description: '主公技，其他魏势力角色的黑色判定牌生效后，其可以令你摸一张牌。' },
  ] },
  { id: 'jie-sunjian-b42', name: '界·孙坚', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'forest', skills: [
    { id: YINGHUN, name: '英魂', description: '准备阶段，若你已受伤，你可以选择一名其他角色并令其选择：摸X张牌并弃置一张牌，或摸一张牌并弃置X张牌（X为你已损失的体力值）。' },
    { id: POLU, name: '破虏', description: '当你杀死一名角色或你死亡时，你可以令任意名角色各摸X张牌（X为此技能发动次数，包含此次）。' },
  ] },
  { id: 'jie-dongzhuo-b42', name: '界·董卓', kingdom: 'qun', gender: 'male', maxHp: 8, pack: 'forest', skills: [
    { id: JIE_JIUCHI, name: '酒池', description: '你可以将一张黑桃手牌当【酒】使用；你以此法使用的【酒】影响的【杀】造成伤害后，本回合【崩坏】失效。' },
    { id: JIE_ROULIN, name: '肉林', description: '锁定技，你使用【杀】指定女性角色为目标后，或成为女性角色使用【杀】的目标后，该角色或你需连续使用两张【闪】才能抵消。' },
    { id: JIE_BENGHUAI, name: '崩坏', description: '锁定技，结束阶段，若你不是全场体力值最低的角色，你须选择失去1点体力或减1点体力上限。酒池造成伤害后本回合此技能失效。' },
    { id: JIE_BAONUE, name: '暴虐', description: '主公技，其他群势力角色造成伤害后，其可以判定，若结果为黑桃，你回复1点体力。' },
  ] },
  { id: 'caoying-b42', name: '曹婴', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: CAOYING_LINGREN, name: '凌人', description: '出牌阶段限一次，你使用【杀】或伤害类锦囊牌指定目标后，可以猜测其是否有基本牌、锦囊牌、装备牌：猜对至少一项，此牌对其伤害+1；猜对至少两项，你摸两张牌；全部猜对，你获得“奸雄”和“行殇”直到你的下回合开始。' },
    { id: CAOYING_FUJIAN, name: '伏间', description: '锁定技，结束阶段，若所有角色均有手牌，你随机观看一名其他角色的X张手牌（X为全场最少手牌数）。' },
  ] },
]
