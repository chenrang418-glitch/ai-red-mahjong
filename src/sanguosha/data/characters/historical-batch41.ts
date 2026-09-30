// 武将册第43批（序号546–555）。技能版本按本地武将册锁定，素材接口沿用现有资产字段。
import { getDistance } from '../../engine/distance'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { flipCharacter } from '../../engine/character-state'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import { queueExtraTurn, schedulePhaseSkipForPlayer, skipPhase } from '../../engine/turn'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { TUNTIAN, ZAOXIAN, JIXI } from './mountain-dengai'
import { TIAOXIN, ZHIJI } from './mountain-jiangwei'
import { DUANCHANG } from './mountain-caiwenji'
import { HUASHEN, XINSHENG } from './mountain-zuoci'
import { JIANG, ZHIBA } from './mountain-sunce'
import { YINGHUN } from './forest-sunjian'
import { GUZHENG, ZHIJIAN } from './mountain-zhangzhaozhanghong'
import { RUOYU, XIANGLE } from './mountain-liushan'
import type { CharacterDefinition } from './types'

const JIE_TUNTIAN = 'jie-tuntian-b43'
const JIE_BEIGE = 'jie-beige-b43'
const JIE_HUNZI = 'jie-hunzi-b43'
const JIE_FANGQUAN = 'jie-fangquan-b43'
const NIUJIN_CUORUI = 'cuorui-b43'
const NIUJIN_LIEWEI = 'liewei-b43'
const JIE_LIEGONG = 'jie-liegong-b43'
const JIE_KUANGGU = 'jie-kuanggu-b43'
const JIE_QIMOU = 'qimou-b43'
const TUNTIAN_PILE = TUNTIAN
const TUNTIAN_TAG_B43 = JIE_TUNTIAN
const BEIGE_TAG_B43 = JIE_BEIGE
const FANGQUAN_MARK_B43 = 'jie-fangquan-pending-b43'
const QIMOU_DISTANCE_MARK = 'qimou-distance-b43'

function player(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((entry) => entry.id === playerId)
}

function fieldCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return player(state, ownerId)?.characterPiles[TUNTIAN_PILE] ?? []
}

function discardableCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = player(state, ownerId)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
}

registerJudgmentContinuation(TUNTIAN_TAG_B43, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const owner = player(host.state, ownerId)
  if (!owner?.alive) return
  if (judged.suit === 'heart') {
    moveCard(host.state, judged.id, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [judged.id], reason: JIE_TUNTIAN }, { sourceId: ownerId, targetId: ownerId, cardIds: [judged.id] })
    return
  }
  moveCard(host.state, judged.id, { kind: 'processingArea' }, { kind: 'characterPile', playerId: ownerId, pile: TUNTIAN_PILE })
  host.dispatch('SkillActivated', { playerId: ownerId, skillId: JIE_TUNTIAN, fieldCardId: judged.id }, { targetId: ownerId, cardIds: [judged.id] })
})

registerSkillRuntime({
  id: JIE_TUNTIAN,
  distanceModifier: { toOthers: (state, ownerId) => -fieldCards(state, ownerId).length },
  triggers: [{ event: 'LoseCard', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (data.playerId !== ownerId || !data.cardIds?.length || !player(host.state, ownerId)?.alive || host.state.currentPlayerId === ownerId) return
    host.queueSkill({ skillId: JIE_TUNTIAN, ownerId, step: 'ask', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask' || !player(host.state, ownerId)?.alive || host.state.currentPlayerId === ownerId) return
    host.askSkill({ skillId: JIE_TUNTIAN, ownerId, step: 'ask', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【屯田】：是否进行判定？若非红桃，将生效后的判定牌置为“田”',
      timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '发动屯田' }, { id: 'no', label: '放弃' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask' && (response.payload as { optionId?: string }).optionId === 'yes' && player(host.state, ownerId)?.alive) {
      performJudgment(host, ownerId, '屯田', { tag: TUNTIAN_TAG_B43, data: { ownerId } })
    }
  },
})

registerJudgmentContinuation(BEIGE_TAG_B43, (host, judged, data) => {
  const targetId = data.targetId as PlayerId
  const sourceId = data.sourceId as PlayerId | null
  if (judged.suit === 'heart') {
    if (player(host.state, targetId)?.alive) recover(host as never, targetId, Number(data.amount), data.ownerId as PlayerId)
  } else if (judged.suit === 'diamond') {
    if (player(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, 3, (name, payload) => { host.dispatch(name, payload) })
  } else if (sourceId && player(host.state, sourceId)?.alive) {
    if (judged.suit === 'spade') flipCharacter(host as never, sourceId, JIE_BEIGE)
    else if (judged.suit === 'club') {
      const cards = discardableCards(host.state, sourceId)
      if (cards.length) (host as SkillHost).askSkill({ skillId: JIE_BEIGE, ownerId: data.ownerId as PlayerId, step: 'source-discard', data: { sourceId, count: Math.min(2, cards.length) }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: sourceId, prompt: '【悲歌】：弃置两张牌', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: Math.min(2, cards.length), max: Math.min(2, cards.length),
      }) })
    }
  }
})

registerSkillRuntime({
  id: JIE_BEIGE,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    const data = context.event.payload as { cardName?: string; amount?: number }
    const targetId = context.event.targetId
    const costs = discardableCards(host.state, ownerId)
    if (data.cardName !== '杀' || !targetId || !player(host.state, targetId)?.alive || !costs.length) return
    host.queueSkill({ skillId: JIE_BEIGE, ownerId, step: 'cost', data: { targetId, sourceId: context.event.sourceId ?? null, amount: Number(data.amount ?? 1) } })
  } }],
  startQueued(host, ownerId, prompt) {
    const targetId = prompt.data.targetId as PlayerId
    const costs = discardableCards(host.state, ownerId)
    if (prompt.step !== 'cost' || !player(host.state, ownerId)?.alive || !player(host.state, targetId)?.alive || !costs.length) return
    host.askSkill({ skillId: JIE_BEIGE, ownerId, step: 'cost', data: prompt.data, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【悲歌】：是否弃置一张牌令${player(host.state, targetId)?.nickname ?? '受伤角色'}判定`,
      timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: costs, hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const from = cardId ? locateOwnedCard(host.state, ownerId, cardId) : null
      if (!cardId || !from || (from.kind !== 'hand' && from.kind !== 'equipment')) return
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') handleEquipmentLost(host, ownerId, cardId)
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_BEIGE }, { sourceId: ownerId, cardIds: [cardId] })
      const data = resolution.data as { targetId: PlayerId; sourceId: PlayerId | null; amount: number }
      performJudgment(host, data.targetId, '悲歌', { tag: BEIGE_TAG_B43, data: { ...data, ownerId } })
      return
    }
    if (resolution.step !== 'source-discard') return
    const sourceId = resolution.data.sourceId as PlayerId
    const count = Number(resolution.data.count ?? 0)
    const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    for (const cardId of cards.slice(0, count)) {
      const from = locateOwnedCard(host.state, sourceId, cardId)
      if (from?.kind !== 'hand' && from?.kind !== 'equipment') continue
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') handleEquipmentLost(host, sourceId, cardId)
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: JIE_BEIGE }, { sourceId, cardIds: [cardId] })
    }
  },
})

registerSkillRuntime({
  id: JIE_HUNZI,
  awakening: {
    phase: 'prepare',
    ready: (state, ownerId) => (player(state, ownerId)?.hp ?? Number.MAX_SAFE_INTEGER) <= 2,
    invoke(host, ownerId) {
      if (!player(host.state, ownerId)?.alive) return
      loseMaxHp(host as never, ownerId, 1, '魂姿')
      grantSkill(host.state, ownerId, 'yingzi')
      grantSkill(host.state, ownerId, YINGHUN)
      host.dispatch('SkillActivated', { playerId: ownerId, skillId: JIE_HUNZI, grantedSkills: ['yingzi', YINGHUN] }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: JIE_FANGQUAN,
  offerPhaseSkip(host, ownerId, phase) {
    const owner = player(host.state, ownerId)
    if (phase !== 'play' || !owner?.alive || owner.marks[FANGQUAN_MARK_B43] === host.state.turnNumber) return false
    host.askSkill({ skillId: JIE_FANGQUAN, ownerId, step: 'skip', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【放权】：是否跳过出牌阶段并于本回合结束时令他人获得额外回合？',
      timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '跳过出牌阶段' }, { id: 'no', label: '正常出牌' }],
    }) })
    return true
  },
  fixedMaxCards(state, ownerId) {
    const owner = player(state, ownerId)
    return owner?.marks[FANGQUAN_MARK_B43] === state.turnNumber ? owner.maxHp : null
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = player(host.state, ownerId)
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || !owner?.alive || owner.marks[FANGQUAN_MARK_B43] !== host.state.turnNumber) return
    if (!owner.zones.hand.length || !host.state.players.some((entry) => entry.alive && entry.id !== ownerId)) return
    host.askSkill({ skillId: JIE_FANGQUAN, ownerId, step: 'cost', build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【放权】：是否弃置一张手牌，令一名其他角色进行额外回合？',
      timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
    }) })
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId && (context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const owner = player(host.state, ownerId)
    if (owner) delete owner.marks[FANGQUAN_MARK_B43]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'skip') {
      const owner = player(host.state, ownerId)
      if ((response.payload as { optionId?: string }).optionId === 'yes' && owner?.alive) {
        skipPhase(host.state, 'play')
        owner.marks[FANGQUAN_MARK_B43] = host.state.turnNumber
        host.dispatch('SkillActivated', { playerId: ownerId, skillId: JIE_FANGQUAN, logText: `${owner.nickname}发动【放权】，跳过出牌阶段` }, { sourceId: ownerId })
      }
      host.resumePhaseEntry()
      return
    }
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId)
      if (!cardId || !owner?.alive || !owner.zones.hand.includes(cardId)) return
      const candidates = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId).map((entry) => entry.id)
      if (!candidates.length) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_FANGQUAN }, { sourceId: ownerId, cardIds: [cardId] })
      host.askSkill({ skillId: JIE_FANGQUAN, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【放权】：选择一名其他角色进行额外回合',
        timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !player(host.state, targetId)?.alive) return
      queueExtraTurn(host.state, targetId, { skillId: JIE_FANGQUAN, playerId: ownerId })
      host.dispatch('SkillActivated', { playerId: ownerId, skillId: JIE_FANGQUAN, targetId }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: NIUJIN_CUORUI,
  initialHandCount(state, ownerId) { return (player(state, ownerId)?.reserveCharacterIds?.length ?? 0) + 2 },
  onGameStart(host, ownerId) { schedulePhaseSkipForPlayer(host.state, ownerId, 'judge') },
})

registerSkillRuntime({
  id: NIUJIN_LIEWEI,
  triggers: [{ event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
    const victimId = (context.event.payload as { playerId?: PlayerId }).playerId
    const owner = player(host.state, ownerId)
    const victim = victimId ? player(host.state, victimId) : undefined
    if (!owner?.alive || context.event.sourceId !== ownerId || !victim || victimId === ownerId) return
    const friendly = (identity: string) => owner.identity === identity
      || owner.identity === 'lord' && identity === 'loyalist' || owner.identity === 'loyalist' && identity === 'lord'
    if (friendly(victim.identity)) return
    host.queueSkill({ skillId: NIUJIN_LIEWEI, ownerId, step: 'draw', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw' || !player(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: NIUJIN_LIEWEI, ownerId, step: 'draw', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【裂围】：是否摸三张牌？', timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '摸三张牌' }, { id: 'no', label: '放弃' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw' && (response.payload as { optionId?: string }).optionId === 'yes' && player(host.state, ownerId)?.alive) {
      drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

registerSkillRuntime({
  id: JIE_LIEGONG,
  attackRangeForCard(state, _ownerId, cardId) {
    return state.cards[cardId]?.rank ?? null
  },
  triggers: [{ event: 'TargetSpecified', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardName?: string; cardId?: CardId; targetIds?: PlayerId[] }
    const cardId = payload.cardId ?? context.event.cardIds?.[0]
    const targets = payload.targetIds ?? (context.event.targetId ? [context.event.targetId] : [])
    if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || !cardId) return
    const owner = player(host.state, ownerId)
    if (!owner) return
    const state = host.state as SanguoshaState & { b43LiegongNoDodge?: Record<CardId, PlayerId[]> }
    state.b43LiegongNoDodge ??= {}
    const damageBonus = state as SanguoshaState & { b43LiegongDamageBonus?: Record<string, number> }
    damageBonus.b43LiegongDamageBonus ??= {}
    state.b43LiegongNoDodge[cardId] = targets.filter((targetId) => {
      const target = player(host.state, targetId)
      if (target?.alive && owner.hp <= target.hp) damageBonus.b43LiegongDamageBonus![`${cardId}:${targetId}`] = 1
      return target?.alive && owner.zones.hand.length >= target.zones.hand.length
    })
  } }, { event: 'CardResolved', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || context.event.payload.cardName !== '杀') return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (cardId) {
      const state = host.state as SanguoshaState & { b43LiegongNoDodge?: Record<CardId, PlayerId[]>; b43LiegongDamageBonus?: Record<string, number> }
      delete state.b43LiegongNoDodge?.[cardId]
      for (const key of Object.keys(state.b43LiegongDamageBonus ?? {})) if (key.startsWith(`${cardId}:`)) delete state.b43LiegongDamageBonus?.[key]
    }
  } }],
  slashUndodgeable(state, _ownerId, targetId, cardId) {
    return Boolean(cardId && (state as SanguoshaState & { b43LiegongNoDodge?: Record<CardId, PlayerId[]> }).b43LiegongNoDodge?.[cardId]?.includes(targetId))
  },
  outgoingDamage(state, _ownerId, context) {
    const key = context.cardId ? `${context.cardId}:${context.targetId}` : ''
    const bonus = (state as SanguoshaState & { b43LiegongDamageBonus?: Record<string, number> }).b43LiegongDamageBonus?.[key] ?? 0
    return context.cardName === '杀' && bonus > 0 ? { amount: context.amount + bonus } : null
  },
})

registerSkillRuntime({
  id: JIE_KUANGGU,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || !context.event.targetId || getDistance(host.state, ownerId, context.event.targetId) > 1) return
    const amount = Math.max(0, Math.trunc(Number((context.event.payload as { amount?: number }).amount ?? 0)))
    for (let index = 0; index < amount; index += 1) host.queueSkill({ skillId: JIE_KUANGGU, ownerId, step: 'choice', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choice' || !player(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: JIE_KUANGGU, ownerId, step: 'choice', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【狂骨】：选择回复1点体力或摸一张牌', timeoutMs: 20_000, optional: true,
      options: [{ id: 'recover', label: '回复1点体力' }, { id: 'draw', label: '摸一张牌' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice' || !player(host.state, ownerId)?.alive) return
    if ((response.payload as { optionId?: string }).optionId === 'recover') recover(host as never, ownerId, 1, ownerId)
    else if ((response.payload as { optionId?: string }).optionId === 'draw') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: JIE_QIMOU,
  limited: true,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && owner.hp > 0 && !owner.usedLimitedSkills.includes(JIE_QIMOU)
      ? [{ id: JIE_QIMOU, label: '奇谋：失去任意点体力，增加距离与出杀次数' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIE_QIMOU) return
    const owner = player(host.state, ownerId)
    if (!owner?.alive || owner.hp <= 0 || owner.usedLimitedSkills.includes(JIE_QIMOU)) return
    host.askSkill({ skillId: JIE_QIMOU, ownerId, step: 'amount', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【奇谋】：选择失去的体力值', timeoutMs: 20_000, optional: true,
      options: Array.from({ length: owner.hp }, (_, index) => ({ id: String(index + 1), label: `失去${index + 1}点体力` })),
    }) })
  },
  distanceModifier: { toOthers(state, ownerId) {
    const owner = player(state, ownerId)
    return owner?.marks[QIMOU_DISTANCE_MARK] && owner.marks[`${QIMOU_DISTANCE_MARK}:turn`] === state.turnNumber ? -owner.marks[QIMOU_DISTANCE_MARK] : 0
  } },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId && (context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const owner = player(host.state, ownerId)
    if (owner) { delete owner.marks[QIMOU_DISTANCE_MARK]; delete owner.marks[`${QIMOU_DISTANCE_MARK}:turn`] }
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'amount') return
    const amount = Number((response.payload as { optionId?: string }).optionId)
    const owner = player(host.state, ownerId)
    if (!owner?.alive || !Number.isInteger(amount) || amount < 1 || amount > owner.hp || owner.usedLimitedSkills.includes(JIE_QIMOU)) return
    owner.usedLimitedSkills.push(JIE_QIMOU)
    owner.marks[QIMOU_DISTANCE_MARK] = amount
    owner.marks[`${QIMOU_DISTANCE_MARK}:turn`] = host.state.turnNumber
    grantTurnSlashBonus(host.state, ownerId, { extraUses: amount })
    for (let index = 0; index < amount && player(host.state, ownerId)?.alive; index += 1) loseHp(host as never, ownerId, 1, '奇谋')
  },
})

export const HISTORICAL_BATCH41_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'jie-dengai-b43', name: '界·邓艾', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'mountain', skills: [
    { id: JIE_TUNTIAN, name: '屯田', description: '当你于回合外失去牌后，你可以进行判定：若为红桃，你获得此判定牌；否则你将生效后的判定牌置于你的武将牌上，称为“田”；你计算与其他角色的距离-X（X为“田”的数量）。' },
    { id: ZAOXIAN, name: '凿险', description: '觉醒技，准备阶段，若“田”的数量不小于3，你减1点体力上限，然后获得【急袭】。' },
    { id: JIXI, name: '急袭', description: '你可以将一张“田”当【顺手牵羊】使用。', granted: true },
  ] },
  { id: 'jie-jiangwei-b43', name: '界·姜维', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'mountain', skills: [
    { id: TIAOXIN, name: '挑衅', description: '出牌阶段限一次，你可以选择一名其他角色，然后除非该角色对你使用一张【杀】，否则你弃置其一张牌。' },
    { id: ZHIJI, name: '志继', description: '觉醒技，准备阶段，若你没有手牌，你回复1点体力或摸两张牌，然后减1点体力上限，获得【观星】。' },
  ] },
  { id: 'jie-caiwenji-b43', name: '界·蔡文姬', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'mountain', skills: [
    { id: JIE_BEIGE, name: '悲歌', description: '当一名角色受到【杀】造成的伤害后，你可以弃置一张牌，然后令其判定：红桃，其回复X点体力（X为此伤害值）；方块，其摸三张牌；梅花，伤害来源弃置两张牌；黑桃，伤害来源翻面。' },
    { id: DUANCHANG, name: '断肠', description: '锁定技，当你死亡时，杀死你的角色失去所有武将技能。' },
  ] },
  { id: 'jie-zuoci-b43', name: '界·左慈', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'mountain', huashenInitialCount: 3, huashenRerollUnusedCount: 2, skills: [
    { id: HUASHEN, name: '化身', description: '游戏开始时，你随机获得三张武将牌作为“化身”牌，亮出其中一张并获得其一项技能，且性别与势力视为与该化身牌相同。回合开始时或结束后，你可以更换亮出的化身牌，或弃置至多两张未亮出的化身牌并获得等量新化身牌。' },
    { id: XINSHENG, name: '新生', description: '当你受到1点伤害后，你可以获得一张新的化身牌。' },
  ] },
  { id: 'jie-sunce-b43', name: '界·孙策', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'mountain', skills: [
    { id: JIANG, name: '激昂', description: '当你使用【决斗】或红色【杀】指定目标后，或成为【决斗】或红色【杀】的目标后，你可以摸一张牌。' },
    { id: JIE_HUNZI, name: '魂姿', description: '觉醒技，准备阶段，若你的体力值不大于2，你减1点体力上限，然后获得【英姿】和【英魂】。' },
    { id: ZHIBA, name: '制霸', description: '主公技，其他吴势力角色的出牌阶段限一次，其可以与你拼点（若你已觉醒，你可以拒绝此拼点）；若其没赢，你可以获得双方拼点的牌。' },
  ] },
  { id: 'jie-zhangzhaozhanghong-b43', name: '界·张昭张纮', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'mountain', skills: [
    { id: ZHIJIAN, name: '直谏', description: '出牌阶段，你可以将一张手牌中的装备牌置入一名其他角色的装备区里，然后摸一张牌；当你于出牌阶段使用装备牌时，你摸一张牌。' },
    { id: GUZHENG, name: '固政', description: '其他角色的弃牌阶段结束时，你可以将该角色此阶段弃置的一张手牌交还给其，然后你可以获得其余此阶段弃置的牌。' },
  ] },
  { id: 'jie-liushan-b43', name: '界·刘禅', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'mountain', skills: [
    { id: XIANGLE, name: '享乐', description: '锁定技，当你成为一名角色使用【杀】的目标后，除非该角色弃置一张基本牌，否则此【杀】对你无效。' },
    { id: JIE_FANGQUAN, name: '放权', description: '你可以跳过出牌阶段，若如此做，本回合你的手牌上限等于体力上限；本回合结束时，你可以弃置一张手牌并令一名其他角色进行一个额外的回合。' },
    { id: RUOYU, name: '若愚', description: '主公技，觉醒技，准备阶段，若你是体力值最少的角色，你增加1点体力上限并回复1点体力，然后获得【激将】。' },
  ] },
  { id: 'niujin-b43', name: '牛金', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'yjcm2013', skills: [
    { id: NIUJIN_CUORUI, name: '挫锐', description: '锁定技，你的起始手牌数改为X+2（X为你备选区内武将牌的数量）；你跳过登场后的第一个判定阶段。' },
    { id: NIUJIN_LIEWEI, name: '裂围', description: '当你杀死一名对手后，你可以摸三张牌。' },
  ] },
  { id: 'jie-huangzhong-b43', name: '界·黄忠', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'mountain', skills: [
    { id: JIE_LIEGONG, name: '烈弓', description: '你使用【杀】可选择此【杀】点数距离内的角色为目标。当你使用【杀】指定目标后，若你的手牌数不小于其手牌数，该角色不能使用【闪】；若你的体力值不大于其体力值，此【杀】伤害+1。' },
  ] },
  { id: 'jie-weiyan-b43', name: '界·魏延', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'mountain', skills: [
    { id: JIE_KUANGGU, name: '狂骨', description: '当你对距离1以内的一名角色造成伤害后，你可以选择回复1点体力或摸一张牌。' },
    { id: JIE_QIMOU, name: '奇谋', description: '限定技，出牌阶段，你可以失去任意点体力，然后直到回合结束，你计算与其他角色的距离-X，且可以多使用X张【杀】（X为你失去的体力值）。' },
  ] },
]
