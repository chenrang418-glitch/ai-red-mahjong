// 武将册第41批，序号526–535。仅在十将技能及专属交互均完成后接入角色池。
import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { SkillHost } from '../../engine/skills/runtime'
import { effectiveCardColor, grantSkill, registerSkillRuntime } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { gainMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { locateOwnedCard } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import { hiddenHandSlot } from '../../engine/cards/host'
import { resolvePickedCard } from '../../engine/card-pick'
import { closePrivateZone, moveIntoPrivateZone, openPrivateZone, privateZoneCards } from '../../engine/private-zone'
import { pickableCardsOf, movePickedCard } from '../../engine/card-pick'
import { registerGroupDecision, startGroupDecision } from '../../engine/group-decision'
import { canTarget } from '../../engine/distance'
import { resolveDamage } from '../../engine/damage'
import { cardCategoryOfName } from '../../engine/damage-provenance'
import type { TargetedCardContext, ViewAsOption } from '../../engine/skills/runtime'

type B41State = SanguoshaState & {
  b41LuoshenExempt?: Record<PlayerId, { turnNumber: number; cardIds: CardId[] }>
  b41?: Record<string, any>
}
const playerOf = (state: SanguoshaState, id: PlayerId) => state.players.find(player => player.id === id)
const living = (state: SanguoshaState) => state.players.filter(player => player.alive)
const others = (state: SanguoshaState, id: PlayerId) => living(state).filter(player => player.id !== id)

function draw(host: SkillHost, id: PlayerId, amount: number, reason: string): CardId[] {
  return drawCards(host.state, host.rng, id, amount, (name, payload) => host.dispatch(name, { ...payload, reason, isDraw: true }))
}
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional, options }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, candidates: PlayerId[], prompt: string, data: Record<string, unknown> = {}, min = 1, max = 1, optional = false) {
  host.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000, optional, candidateIds: candidates, min, max }) })
}

// 界甄姬【洛神】：判黑获得的牌在本回合弃牌阶段不计入手牌上限。
const JIE_LUOSHEN = 'jie-luoshen-b41'
const JIE_LUOSHEN_JUDGE = 'jie-luoshen-judge-b41'
registerSkillRuntime({
  id: JIE_LUOSHEN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (p.phase !== 'prepare' || p.playerId !== ownerId || host.state.skillResolution) return
      askOption(host, JIE_LUOSHEN, ownerId, 'invoke', '【洛神】：是否进行判定？若为黑色则获得并可重复', [{ id: 'yes', label: '进行判定' }, { id: 'no', label: '不发动' }])
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (p.playerId === ownerId && p.cardIds?.length) removeLuoshenExempt(host.state, ownerId, p.cardIds)
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      if (context.event.sourceId === ownerId) removeLuoshenExempt(host.state, ownerId, p.cardIds ?? (p.cardId ? [p.cardId] : []))
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
      if (p.playerId === ownerId && p.cardId) removeLuoshenExempt(host.state, ownerId, [p.cardId])
    } },
    { event: 'HandSwap', handle(host, ownerId, context) {
      const p = context.event.payload as { leftId?: PlayerId; rightId?: PlayerId }
      if (p.leftId === ownerId || p.rightId === ownerId) removeLuoshenExempt(host.state, ownerId)
    } },
  ],
  handLimitExempt(state, ownerId, cardId) {
    const record = (state as B41State).b41LuoshenExempt?.[ownerId]
    return record?.turnNumber === state.turnNumber && record.cardIds.includes(cardId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId === 'yes' && playerOf(host.state, ownerId)?.alive) {
        performJudgment(host, ownerId, '洛神', { tag: JIE_LUOSHEN_JUDGE, data: { ownerId } })
      }
      return
    }
    if (resolution.step === 'repeat' && (response.payload as { optionId?: string }).optionId === 'yes' && playerOf(host.state, ownerId)?.alive) {
      performJudgment(host, ownerId, '洛神', { tag: JIE_LUOSHEN_JUDGE, data: { ownerId } })
    }
  },
})
function removeLuoshenExempt(state: SanguoshaState, ownerId: PlayerId, cardIds?: CardId[]): void {
  const records = (state as B41State).b41LuoshenExempt, row = records?.[ownerId]
  if (!row) return
  if (!cardIds) { row.cardIds = []; return }
  row.cardIds = row.cardIds.filter(id => !cardIds.includes(id))
}
registerJudgmentContinuation(JIE_LUOSHEN_JUDGE, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || judged.color !== 'black') return
  if (host.state.zones.discardPile.includes(judged.id)) {
    moveCard(host.state, judged.id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [judged.id], reason: '洛神' }, { targetId: ownerId, cardIds: [judged.id] })
    const state = host.state as B41State
    state.b41LuoshenExempt ??= {}
    const previous = state.b41LuoshenExempt[ownerId]
    state.b41LuoshenExempt[ownerId] = {
      turnNumber: host.state.turnNumber,
      cardIds: [...new Set([...(previous?.turnNumber === host.state.turnNumber ? previous.cardIds : []), judged.id])],
    }
  }
  askOption(host, JIE_LUOSHEN, ownerId, 'repeat', '【洛神】：是否继续判定？', [{ id: 'yes', label: '继续判定' }, { id: 'no', label: '停止' }])
})

// 界貂蝉【闭月】：无手牌时摸两张。
const JIE_BIYUE = 'jie-biyue-b41'
registerSkillRuntime({ id: JIE_BIYUE,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const p = context.event.payload as { phase?: string; playerId?: PlayerId }
    if (p.phase === 'finish' && p.playerId === ownerId && playerOf(host.state, ownerId)?.alive) {
      askOption(host, JIE_BIYUE, ownerId, 'invoke', '【闭月】：是否摸牌？若你没有手牌则改为摸两张', [{ id: 'yes', label: '摸牌' }, { id: 'no', label: '不发动' }])
    }
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (owner?.alive) draw(host, ownerId, owner.zones.hand.length === 0 ? 2 : 1, '闭月')
  },
})

// 界卧龙【藏拙】：弃牌阶段开始时，本回合未使用过锦囊则锦囊牌不计入手牌上限。
const CANGZHUO = 'cangzhuo-b41'
registerSkillRuntime({ id: CANGZHUO,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const name = (context.event.payload as { cardName?: string }).cardName
    if (name && cardCategoryOfName(name) === 'trick') {
      const state = host.state as B41State
      state.b41 ??= {}
      state.b41[`cangzhuo-used:${ownerId}`] = host.state.turnNumber
    }
  } }],
  handLimitExempt(state, ownerId, cardId) {
    const row = (state as B41State).b41?.[`cangzhuo-used:${ownerId}`]
    return state.phase === 'discard' && row !== state.turnNumber && state.cards[cardId]?.category === 'trick'
  },
})

// SP庞统【过论】：暗选对方手牌展示，再与自己的一张手牌/装备牌交换；以交换前点数较小者摸牌。
const GUOLUN = 'guolun-sp-b41'
registerSkillRuntime({ id: GUOLUN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId
      && !usedThisPhase(state, ownerId, GUOLUN) && (owner.zones.hand.length + Object.values(owner.zones.equipment).filter(Boolean).length) > 0
      && others(state, ownerId).some(target => target.zones.hand.length)
      ? [{ id: `skill:${GUOLUN}`, label: '过论：展示一名其他角色的一张手牌并交换' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${GUOLUN}`) throw new Error('过论动作无效')
    askTargets(host, GUOLUN, ownerId, 'target', others(host.state, ownerId).filter(p => p.zones.hand.length).map(p => p.id), '【过论】：选择一名有手牌的其他角色')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || !target.zones.hand.length) return
      host.askSkill({ skillId: GUOLUN, ownerId, step: 'reveal', data: { targetId }, build: id => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【过论】：选择${target.nickname}的一张手牌展示`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots: target.zones.hand.map((_, index) => hiddenHandSlot(target.id, index)), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'reveal') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const slot = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const revealedId = slot && target?.alive ? resolvePickedCard(host.state, targetId, slot) : null
      if (!target?.alive || !revealedId || !target.zones.hand.includes(revealedId)) return
      const card = host.state.cards[revealedId]
      host.dispatch('CardMove', { playerId: targetId, cardIds: [revealedId], reason: GUOLUN, revealed: true, revealedCardName: card?.name }, { sourceId: ownerId, targetId, cardIds: [revealedId] })
      const owner = playerOf(host.state, ownerId)
      const ownerCards = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (!ownerCards.length) return
      host.askSkill({ skillId: GUOLUN, ownerId, step: 'exchange', data: { targetId, revealedId }, build: id => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【过论】：选择你的一张牌与展示牌交换', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: ownerCards, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'exchange') return
    const targetId = resolution.data.targetId as PlayerId
    const revealedId = resolution.data.revealedId as CardId
    const target = playerOf(host.state, targetId), owner = playerOf(host.state, ownerId)
    const ownId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const targetFrom = target && locateOwnedCard(host.state, targetId, revealedId)
    const ownFrom = ownId && locateOwnedCard(host.state, ownerId, ownId)
    if (!target?.alive || !owner?.alive || !targetFrom || targetFrom.kind !== 'hand' || !ownId || !ownFrom) return
    const ownRank = host.state.cards[ownId]?.rank ?? 0
    const targetRank = host.state.cards[revealedId]?.rank ?? 0
    moveCard(host.state, revealedId, targetFrom, { kind: 'hand', playerId: ownerId })
    moveCard(host.state, ownId, ownFrom, { kind: 'hand', playerId: targetId })
    if (ownFrom.kind === 'equipment') handleEquipmentLost(host as never, ownerId, ownId)
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [revealedId], reason: GUOLUN }, { sourceId: ownerId, targetId, cardIds: [revealedId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [revealedId], reason: GUOLUN }, { sourceId: ownerId, targetId: ownerId, cardIds: [revealedId] })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [ownId], reason: GUOLUN }, { sourceId: ownerId, targetId: ownerId, cardIds: [ownId] })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [ownId], reason: GUOLUN }, { sourceId: ownerId, targetId, cardIds: [ownId] })
    markUsedThisPhase(host.state, ownerId, GUOLUN)
    host.dispatch('SkillActivated', { skillId: GUOLUN, skillName: '过论', playerId: ownerId, targetId, cardIds: [ownId, revealedId] }, { sourceId: ownerId, targetId, cardIds: [ownId, revealedId] })
    if (ownRank < targetRank) draw(host, ownerId, 1, '过论')
    else if (targetRank < ownRank) draw(host, targetId, 1, '过论')
  },
})

// SP庞统【送丧】觉醒后获得【展骥】；只有出牌阶段因摸牌得到牌才触发展骥。
const SONGSANG = 'songsang-sp-b41'
const ZHANJI = 'zhanji-sp-b41'
registerSkillRuntime({ id: SONGSANG, limited: true,
  triggers: [{ event: 'Death', handle(host, ownerId, context) {
    const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
    const owner = playerOf(host.state, ownerId)
    if (!deadId || deadId === ownerId || !owner?.alive || owner.usedLimitedSkills.includes(SONGSANG)) return
    askOption(host, SONGSANG, ownerId, 'invoke', '【送丧】：是否发动限定技？受伤时回复1点体力，否则增加1点体力上限，并获得【展骥】', [{ id: 'yes', label: '发动【送丧】' }, { id: 'no', label: '不发动' }], { deadId })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(SONGSANG)) return
    owner.usedLimitedSkills.push(SONGSANG)
    if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ownerId)
    else gainMaxHp(host as never, ownerId, 1, SONGSANG)
    grantSkill(host.state, ownerId, ZHANJI)
    host.dispatch('SkillActivated', { skillId: SONGSANG, skillName: '送丧', playerId: ownerId, result: ZHANJI }, { sourceId: ownerId })
  },
})
registerSkillRuntime({ id: ZHANJI, triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
  const payload = context.event.payload as { playerId?: PlayerId; reason?: string; isDraw?: boolean }
  if (payload.playerId !== ownerId || (!payload.isDraw && payload.reason !== 'draw') || payload.reason === ZHANJI || host.state.phase !== 'play'
    || host.state.currentPlayerId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
  draw(host, ownerId, 1, ZHANJI)
} }] })

const JIE_JIEMING = 'jie-jieming-b41'

// SP太史慈【击虚】：猜测同时秘密提交；公布后按实际是否持有【杀】处理。
const JIXU = 'jixu-sp-b41'
const JIXU_GUESS = 'jixu-guess-b41'
registerSkillRuntime({ id: JIXU,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, JIXU)
      && others(state, ownerId).some(p => p.hp === owner.hp)
      ? [{ id: `skill:${JIXU}`, label: '击虚：令体力值相同的角色同时猜测你是否有【杀】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIXU}`) throw new Error('击虚动作无效')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const participants = others(host.state, ownerId).filter(p => p.hp === owner.hp).map(p => p.id)
    if (!participants.length) return
    askTargets(host, JIXU, ownerId, 'select', participants, '【击虚】：选择至少一名体力值相同的其他角色猜测', {}, 1, participants.length)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'select') {
      const participants = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
        .filter(targetId => others(host.state, ownerId).some(p => p.id === targetId && p.hp === playerOf(host.state, ownerId)?.hp))
      if (!participants.length) return
      markUsedThisPhase(host.state, ownerId, JIXU)
      startGroupDecision(host, {
        id: `${JIXU}:${host.state.seq}`, tag: JIXU_GUESS, skillId: JIXU, playerIds: participants,
        prompt: '【击虚】：猜测太史慈手牌区里是否有【杀】',
        options: [{ id: 'yes', label: '有【杀】' }, { id: 'no', label: '没有【杀】' }],
        defaultOptionId: 'no', timeoutMs: 25_000, data: { ownerId, participants },
      })
      return
    }
    if (resolution.step !== 'discard') return
    const record = (host.state as B41State).b41?.[`jixu:${ownerId}`]
    const targetId = resolution.data.targetId as PlayerId
    const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
    if (record && cardId) {
      const moved = movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
      if (moved) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JIXU }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        record.discarded += 1
      }
    }
    resolveJixuDiscard(host, ownerId)
  },
  modifySlashTargets(host, ownerId, targets, candidates) {
    const row = (host.state as B41State).b41?.[`jixu:${ownerId}`]
    if (row?.turnNumber !== host.state.turnNumber || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return targets
    return [...targets, ...row.addTargets.filter((id: PlayerId) => candidates.includes(id))]
  },
})
registerGroupDecision(JIXU_GUESS, (host, decision) => {
  const skillHost = host as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  const participants = decision.data.participants as PlayerId[]
  const hasSlash = handSlash(skillHost.state, ownerId)
  const correct: PlayerId[] = [], wrong: PlayerId[] = [], addTargets: PlayerId[] = [], discardTargets: PlayerId[] = []
  for (const targetId of participants) {
    const guessedYes = decision.responses[targetId] === 'yes'
    if (guessedYes === hasSlash) correct.push(targetId)
    else wrong.push(targetId)
    if (hasSlash && !guessedYes) addTargets.push(targetId)
    if (!hasSlash && guessedYes) discardTargets.push(targetId)
  }
  const state = skillHost.state as B41State
  state.b41 ??= {}
  state.b41[`jixu:${ownerId}`] = { turnNumber: state.turnNumber, addTargets, discardTargets, wrong: wrong.length, discarded: 0, index: 0 }
  skillHost.dispatch('SkillActivated', {
    skillId: JIXU, skillName: '击虚', playerId: ownerId, correctGuessIds: correct, wrongGuessIds: wrong,
    hasSlash, logText: `【击虚】同时猜测结果公开：${hasSlash ? '手牌中有【杀】' : '手牌中没有【杀】'}`,
  }, { sourceId: ownerId })
  if (hasSlash || discardTargets.length === 0) {
    if (wrong.length) draw(skillHost, ownerId, wrong.length, JIXU)
    if (wrong.length === 0) skillHost.advancePhase()
    return
  }
  askJixuDiscard(skillHost, ownerId)
})

function handSlash(state: SanguoshaState, ownerId: PlayerId): boolean {
  return playerOf(state, ownerId)?.zones.hand.some(id => state.cards[id]?.name === '杀') ?? false
}
function askJixuDiscard(host: SkillHost, ownerId: PlayerId): void {
  const record = (host.state as B41State).b41?.[`jixu:${ownerId}`]
  if (!record) return
  while (record.index < record.discardTargets.length) {
    const targetId = record.discardTargets[record.index++] as PlayerId
    const target = playerOf(host.state, targetId)
    const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
    if (!target?.alive || (!pickable.cardIds.length && !pickable.hiddenCardSlots.length)) continue
    host.askSkill({ skillId: JIXU, ownerId, step: 'discard', data: { targetId }, build: id => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【击虚】：弃置${target.nickname}一张牌`, timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
    }) })
    return
  }
  resolveJixuDiscard(host, ownerId)
}
function resolveJixuDiscard(host: SkillHost, ownerId: PlayerId): void {
  const record = (host.state as B41State).b41?.[`jixu:${ownerId}`]
  if (!record) return
  if (record.index < record.discardTargets.length) { askJixuDiscard(host, ownerId); return }
  if (record.wrong) draw(host, ownerId, record.wrong, JIXU)
  if (!record.wrong && host.state.phase === 'play' && host.state.currentPlayerId === ownerId) host.advancePhase()
}

// 界伊籍【机捷】与【急援】：底牌在私有区供伊籍观看；【急援】也监听公共的交牌事件。
const JIJIE = 'jijie-yiji-b41'
const QIUYUAN = 'qiuyuan-yiji-b41'
const JIJI_ZONE = 'jijie-yiji-b41-private'
const JIJI_REASON = '机捷'
registerSkillRuntime({ id: JIJIE,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId
      && !usedThisPhase(state, ownerId, JIJIE) && state.zones.drawPile.length > 0
      ? [{ id: `skill:${JIJIE}`, label: '机捷：观看牌堆底牌并交给任意角色' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIJIE}`) throw new Error('机捷动作无效')
    const cardId = host.state.zones.drawPile.at(-1)
    if (!cardId) return
    markUsedThisPhase(host.state, ownerId, JIJIE)
    openPrivateZone(host.state, JIJI_ZONE, ownerId, JIJI_REASON)
    moveIntoPrivateZone(host.state, cardId, { kind: 'drawPile' }, JIJI_ZONE)
    host.askSkill({ skillId: JIJIE, ownerId, step: 'view', data: { cardId }, build: id => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【机捷】：观看牌堆底牌（确认后选择获得者）', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [], viewOnlyCardIds: [cardId], hiddenCardSlots: [], min: 0, max: 0,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'view') {
      const cardId = privateZoneCards(host.state, JIJI_ZONE)[0]
      if (!cardId) { closePrivateZone(host.state, JIJI_ZONE); return }
      askTargets(host, JIJIE, ownerId, 'recipient', living(host.state).map(p => p.id), '【机捷】：选择获得牌的角色', { cardId })
      return
    }
    if (resolution.step !== 'recipient') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const cardId = resolution.data.cardId as CardId
    const valid = targetId && playerOf(host.state, targetId)?.alive && privateZoneCards(host.state, JIJI_ZONE).includes(cardId)
    if (valid) {
      moveCard(host.state, cardId, { kind: 'privateZone', zoneId: JIJI_ZONE }, { kind: 'hand', playerId: targetId! })
      host.dispatch('GainCard', { playerId: targetId!, cardIds: [cardId], reason: JIJI_REASON }, { sourceId: ownerId, targetId: targetId!, cardIds: [cardId] })
      if (targetId !== ownerId) host.dispatch('CardGiven', { fromId: ownerId, toId: targetId, cardIds: [cardId], reason: JIJI_REASON }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    }
    closePrivateZone(host.state, JIJI_ZONE)
  },
})
registerSkillRuntime({ id: QIUYUAN,
  triggers: [
    { event: 'EnterDying', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (targetId && playerOf(host.state, ownerId)?.alive && playerOf(host.state, targetId)?.alive) {
        host.queueSkill({ skillId: QIUYUAN, ownerId, step: 'dying-offer', data: { targetId } })
      }
    } },
    { event: 'CardGiven', handle(host, ownerId, context) {
      const e = context.event.payload as { fromId?: PlayerId; toId?: PlayerId }
      if (e.fromId === ownerId && e.toId !== ownerId && e.toId && playerOf(host.state, ownerId)?.alive && playerOf(host.state, e.toId)?.alive) {
        host.queueSkill({ skillId: QIUYUAN, ownerId, step: 'give-offer', data: { targetId: e.toId } })
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'dying-offer' && prompt.step !== 'give-offer') return
    const targetId = prompt.data.targetId as PlayerId
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
    askOption(host, QIUYUAN, ownerId, 'offer', `【急援】：是否令${playerOf(host.state, targetId)!.nickname}摸一张牌？`, [{ id: 'yes', label: '令其摸一张牌' }, { id: 'no', label: '不发动' }], { targetId })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'offer' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    if (playerOf(host.state, ownerId)?.alive && playerOf(host.state, targetId)?.alive) draw(host, targetId, 1, '急援')
  },
})

// 界典韦【强袭】：每名角色每回合限一次；弃武器后重新按当前攻击范围选目标。
const JIE_QIANGXI = 'jie-qiangxi-b41'
function qiangxiCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const row = (state as B41State).b41?.[`qiangxi:${ownerId}`]
  return others(state, ownerId).filter(target => !(row?.turnNumber === state.turnNumber && row.targets.includes(target.id))
    && canTarget(state, ownerId, target.id)).map(target => target.id)
}
function b41PlayPhaseKey(state: SanguoshaState): string {
  return `${state.turnNumber}:${state.extraPhase?.instanceId ?? 'normal'}:${state.phase}`
}
registerSkillRuntime({ id: JIE_QIANGXI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const row = (state as B41State).b41?.[`qiangxi:${ownerId}`]
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId
      && (row?.phaseKey !== b41PlayPhaseKey(state) || row.count < 2)
      && qiangxiCandidates(state, ownerId).length > 0
      && (owner.hp > 0 || Boolean(owner.zones.equipment.weapon))
      ? [{ id: `skill:${JIE_QIANGXI}`, label: '强袭：失去1点体力或弃置武器，对攻击范围内一名角色造成1点伤害' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIE_QIANGXI}`) throw new Error('界强袭动作无效')
    const owner = playerOf(host.state, ownerId)
    const hasWeapon = Boolean(owner?.zones.equipment.weapon)
    if (!owner?.alive) return
    if (hasWeapon && owner.hp > 0) askOption(host, JIE_QIANGXI, ownerId, 'cost', '【强袭】：选择代价', [
      { id: 'hp', label: '失去1点体力' }, { id: 'weapon', label: '弃置武器牌' },
    ])
    else payQiangxi(host, ownerId, hasWeapon)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') payQiangxi(host, ownerId, (response.payload as { optionId?: string }).optionId === 'weapon')
    else if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !qiangxiCandidates(host.state, ownerId).includes(targetId)) return
      const state = host.state as B41State
      state.b41 ??= {}
      const key = `qiangxi:${ownerId}`
      const old = state.b41[key]
      const phaseKey = b41PlayPhaseKey(state)
      const row = old?.turnNumber === state.turnNumber
        ? { ...old, phaseKey, count: old.phaseKey === phaseKey ? old.count : 0 }
        : { turnNumber: state.turnNumber, phaseKey, count: 0, targets: [] as PlayerId[] }
      if (row.count >= 2) return
      row.count += 1
      row.targets.push(targetId)
      state.b41[key] = row
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, cardName: '强袭' })
    }
  },
})
function payQiangxi(host: SkillHost, ownerId: PlayerId, useWeapon: boolean): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const weapon = owner.zones.equipment.weapon
  if (useWeapon) {
    if (!weapon) return
    moveCard(host.state, weapon, { kind: 'equipment', playerId: ownerId, slot: 'weapon' }, { kind: 'discardPile' })
    handleEquipmentLost(host as never, ownerId, weapon)
  } else {
    resolveDamage(host as never, { sourceId: ownerId, targetId: ownerId, amount: 1, cardName: '强袭' })
    if (!playerOf(host.state, ownerId)?.alive || host.state.dying) return
  }
  const candidates = qiangxiCandidates(host.state, ownerId)
  if (candidates.length) askTargets(host, JIE_QIANGXI, ownerId, 'target', candidates, '【强袭】：选择攻击范围内一名未被此技能指定过的角色')
}

// 界荀彧【节命】：受伤/死亡后，所选目标摸至X张并弃至X张。
const JIE_QUHU = 'quhu'
// 【驱虎】完全复用已经实现的拼点、失败反伤和获胜后选伤害目标规则。
// 修正前面的基础节命模板：死亡触发不属于界荀彧文本，且目标不弃牌。
// 保持 JIE_JIEMING 的专属 id，避免影响旧武将/化身状态。
registerSkillRuntime({ id: JIE_JIEMING,
  triggers: [
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
      const count = Math.max(1, Number((context.event.payload as { amount?: number }).amount ?? 1))
      for (let index = 0; index < count; index += 1) host.queueSkill({ skillId: JIE_JIEMING, ownerId, step: 'ask', data: {} })
    } },
    { event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
        host.queueSkill({ skillId: JIE_JIEMING, ownerId, step: 'ask', data: {}, allowDeadOwner: true })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask') {
      const ids = living(host.state).map(p => p.id)
      if (ids.length) askTargets(host, JIE_JIEMING, ownerId, 'target', ids, '【节命】：令一名角色摸两张牌；若其手牌数小于其体力上限，你摸一张牌', {}, 1, 1, true)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const required = Math.min(5, target.maxHp)
      draw(host, target.id, required, JIE_JIEMING)
      const excess = Math.max(0, target.zones.hand.length - required)
      if (excess > 0) host.askSkill({ skillId: JIE_JIEMING, ownerId, step: 'discard', data: { targetId, excess }, build: id => ({
        id, kind: 'choose-cards', playerId: target.id, prompt: `【节命】：弃置${excess}张手牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: excess, max: excess,
      }) })
      return
    }
    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const required = resolution.data.excess as number
      const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter(id => target.zones.hand.includes(id)).slice(0, required)
      for (const id of ids) moveCard(host.state, id, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      if (ids.length) host.dispatch('LoseCard', { playerId: targetId, cardIds: ids, reason: JIE_JIEMING }, { sourceId: ownerId, targetId, cardIds: ids })
    }
  },
})

// 界卧龙：八阵、火计、看破采用同一公共技能实现；火计可从手牌或装备区转化红牌。
const JIE_HUOJI = 'jie-huoji-b41'
const JIE_KANPO = 'jie-kanpo-b41'
const JIE_BAZHEN = 'bazhen'
registerSkillRuntime({ id: JIE_HUOJI,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const ids = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    return ids.filter(id => effectiveCardColor(state, ownerId, id) === 'red' && state.cards[id]?.name !== '火攻')
      .map(cardId => ({ asCardName: '火攻', cardId, label: `发动【火计】：将【${state.cards[cardId]?.name}】当【火攻】使用` }))
  },
})
registerSkillRuntime({ id: JIE_KANPO, unanswerableResponses: ['无懈可击'], viewAs(state, ownerId) {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
  return cards.filter(id => effectiveCardColor(state, ownerId, id) === 'black' && state.cards[id]?.name !== '无懈可击')
    .map(cardId => ({ asCardName: '无懈可击', cardId, label: `发动【看破】：将【${state.cards[cardId]?.name}】当【无懈可击】使用` }))
} })

// 蒯越蒯良【荐降】：目标结算前可令一名当前手牌最少者摸牌。
const JIANGXIANG = 'jiangxiang-b41'
registerSkillRuntime({ id: JIANGXIANG,
  interceptTarget(host, ownerId, context) {
    if (context.sourceId === ownerId || !playerOf(host.state, ownerId)?.alive) return false
    const min = Math.min(...living(host.state).map(p => p.zones.hand.length))
    const candidates = living(host.state).filter(p => p.zones.hand.length === min).map(p => p.id)
    if (!candidates.length) return false
    host.askSkill({ skillId: JIANGXIANG, ownerId, step: 'target', data: {}, build: id => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【荐降】：是否令一名手牌数最少的角色摸一张牌？', timeoutMs: 25_000,
      optional: true, candidateIds: candidates, min: 0, max: 1,
    }) })
    return true
  },
  resume(host, _ownerId, _resolution, response) {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const live = living(host.state)
    if (target?.alive && target.zones.hand.length === Math.min(...live.map(p => p.zones.hand.length))) draw(host, target.id, 1, JIANGXIANG)
    host.resumeCardTarget()
  },
})

// 蒯越蒯良【审时】：阳支交牌伤人；阴支受伤后观看其手牌并给牌，牌留在其手中至回合结束则补至4。
const SHENSHI = 'shenshi-b41'
type ShenshiRecord = { polarity: 'yang' | 'yin'; pendingEnd?: Array<{ targetId: PlayerId; turnPlayerId: PlayerId; cardId: CardId; turnNumber: number; lost: boolean }>; yangDeath?: PlayerId }
function shenshiOf(state: SanguoshaState, ownerId: PlayerId): ShenshiRecord {
  const root = state as B41State
  root.b41 ??= {}
  return root.b41[`shenshi:${ownerId}`] ??= { polarity: 'yang' }
}
registerSkillRuntime({ id: SHENSHI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId), row = shenshiOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || row.polarity !== 'yang'
      || usedThisPhase(state, ownerId, SHENSHI) || !owner.zones.hand.length) return []
    const max = Math.max(...others(state, ownerId).map(p => p.zones.hand.length), -1)
    return max >= 0 ? [{ id: `skill:${SHENSHI}`, label: '审时·阳：交给手牌最多的其他角色一张牌并对其造成1点伤害' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SHENSHI}`) throw new Error('审时动作无效')
    const owner = playerOf(host.state, ownerId), max = Math.max(...others(host.state, ownerId).map(p => p.zones.hand.length), -1)
    if (!owner?.zones.hand.length || max < 0) return
    host.askSkill({ skillId: SHENSHI, ownerId, step: 'yang-card', data: {}, build: id => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【审时·阳】：选择交出的一张手牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'Damaged', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId, owner = playerOf(host.state, ownerId)
      if (!sourceId || sourceId === ownerId || !owner?.alive || shenshiOf(host.state, ownerId).polarity !== 'yin'
        || !playerOf(host.state, sourceId)?.alive) return
      host.queueSkill({ skillId: SHENSHI, ownerId, step: 'yin-offer', data: { targetId: sourceId } })
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const rows = shenshiOf(host.state, ownerId).pendingEnd ?? [], p = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      for (const row of rows) if (row.targetId === p.playerId && p.cardIds?.includes(row.cardId)) row.lost = true
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const rows = shenshiOf(host.state, ownerId).pendingEnd ?? [], p = context.event.payload as { cardId?: CardId }
      for (const row of rows) if (context.event.sourceId === row.targetId && p.cardId === row.cardId) row.lost = true
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const rows = shenshiOf(host.state, ownerId).pendingEnd ?? [], p = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
      for (const row of rows) if (p.playerId === row.targetId && p.cardId === row.cardId) row.lost = true
    } },
    { event: 'HandSwap', handle(host, ownerId, context) {
      const rows = shenshiOf(host.state, ownerId).pendingEnd ?? [], p = context.event.payload as { leftId?: PlayerId; rightId?: PlayerId }
      for (const row of rows) if (p.leftId === row.targetId || p.rightId === row.targetId) row.lost = true
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { phase?: string; playerId?: PlayerId }
      const rows = shenshiOf(host.state, ownerId).pendingEnd ?? []
      if (p.phase !== 'finish') return
      const due = rows.filter(row => p.playerId === row.turnPlayerId && row.turnNumber === host.state.turnNumber)
      if (!due.length) return
      shenshiOf(host.state, ownerId).pendingEnd = rows.filter(row => !due.includes(row))
      const owner = playerOf(host.state, ownerId)
      const retained = due.some(row => !row.lost && playerOf(host.state, row.targetId)?.zones.hand.includes(row.cardId))
      if (retained && owner?.alive) draw(host, ownerId, Math.max(0, 4 - owner.zones.hand.length), SHENSHI)
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (deadId && context.event.sourceId === ownerId && shenshiOf(host.state, ownerId).yangDeath === deadId && playerOf(host.state, ownerId)?.alive) {
        host.queueSkill({ skillId: SHENSHI, ownerId, step: 'yang-death', data: { deadId } })
      }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const row = shenshiOf(host.state, ownerId), p = context.event.payload as { cardName?: string }
      const victim = row.yangDeath && playerOf(host.state, row.yangDeath)
      if (context.event.sourceId === ownerId && row.yangDeath && p.cardName === SHENSHI && victim && victim.hp > 0) row.yangDeath = undefined
    } },
    { event: 'QuitDying', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      const row = shenshiOf(host.state, ownerId)
      if (targetId && row.yangDeath === targetId && playerOf(host.state, targetId)?.alive) row.yangDeath = undefined
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const targetId = prompt.data.targetId as PlayerId | undefined
    if (prompt.step === 'yin-offer' && targetId && playerOf(host.state, ownerId)?.alive && playerOf(host.state, targetId)?.alive) {
      const target = playerOf(host.state, targetId)
      if (target) askOption(host, SHENSHI, ownerId, 'yin-choose', `【审时·阴】：是否观看${target.nickname}的手牌并交给其一张牌？`, [{ id: 'yes', label: '观看并交牌' }, { id: 'no', label: '取消' }], { targetId })
    } else if (prompt.step === 'yang-death') {
      askTargets(host, SHENSHI, ownerId, 'yang-refill', living(host.state).map(p => p.id), '【审时·阳】：令一名角色将手牌摸至四张', { deadId: prompt.data.deadId }, 1, 1, true)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'yang-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = playerOf(host.state, ownerId)
      if (!cardId || !owner?.zones.hand.includes(cardId)) return
      const max = Math.max(...others(host.state, ownerId).map(p => p.zones.hand.length), -1)
      const candidates = others(host.state, ownerId).filter(p => p.zones.hand.length === max).map(p => p.id)
      if (!candidates.length) return
      host.askSkill({ skillId: SHENSHI, ownerId, step: 'yang-target', data: { cardId }, build: id => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【审时·阳】：选择一名手牌数最多的其他角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
    } else if (resolution.step === 'yang-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0], cardId = resolution.data.cardId as CardId
      const target = targetId ? playerOf(host.state, targetId) : undefined, owner = playerOf(host.state, ownerId)
      if (!target?.alive || !owner?.zones.hand.includes(cardId)) return
      markUsedThisPhase(host.state, ownerId, SHENSHI)
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: target.id })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: SHENSHI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: target.id, cardIds: [cardId], reason: SHENSHI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('CardGiven', { fromId: ownerId, toId: target.id, cardIds: [cardId], reason: SHENSHI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      const row = shenshiOf(host.state, ownerId); row.polarity = 'yin'; row.yangDeath = target.id
      resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, cardName: SHENSHI })
      if (playerOf(host.state, target.id)?.alive) row.yangDeath = undefined
    } else if (resolution.step === 'yin-choose') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId, target = playerOf(host.state, targetId), owner = playerOf(host.state, ownerId)
      if (!target?.alive || !owner?.alive || !target.zones.hand.length || !owner.zones.hand.length) return
      host.askSkill({ skillId: SHENSHI, ownerId, step: 'yin-view', data: { targetId }, build: id => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【审时·阴】：观看${target.nickname}的手牌，确认后选择交给其的手牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [], viewOnlyCardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max: 0,
      }) })
    } else if (resolution.step === 'yin-view') {
      const targetId = resolution.data.targetId as PlayerId, target = playerOf(host.state, targetId), owner = playerOf(host.state, ownerId)
      if (!target?.alive || !owner?.zones.hand.length) return
      host.askSkill({ skillId: SHENSHI, ownerId, step: 'yin-give', data: { targetId }, build: id => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【审时·阴】：选择交给该角色的一张手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
    } else if (resolution.step === 'yin-give') {
      const targetId = resolution.data.targetId as PlayerId, target = playerOf(host.state, targetId), owner = playerOf(host.state, ownerId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!target?.alive || !owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: SHENSHI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: SHENSHI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('CardGiven', { fromId: ownerId, toId: targetId, cardIds: [cardId], reason: SHENSHI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      const row = shenshiOf(host.state, ownerId); row.polarity = 'yang'; row.pendingEnd ??= []; row.pendingEnd.push({ targetId, turnPlayerId: host.state.currentPlayerId, cardId, turnNumber: host.state.turnNumber, lost: false })
    } else if (resolution.step === 'yang-refill') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0], target = targetId ? playerOf(host.state, targetId) : undefined
      if (target?.alive) draw(host, targetId!, Math.max(0, 4 - target.zones.hand.length), SHENSHI)
      shenshiOf(host.state, ownerId).yangDeath = undefined
    }
  },
})

// 界庞德【鞬出】：成为目标后选择弃牌；装备牌分支令此杀不可闪，非装备牌分支杀转交目标。
const JIANCHU = 'jianchu-jie-b41'
registerSkillRuntime({ id: JIANCHU,
  interceptSourceTargetEach(host, ownerId, context: TargetedCardContext) {
    const source = playerOf(host.state, ownerId), target = playerOf(host.state, context.targetId)
    if (context.cardName !== '杀' || context.sourceId !== ownerId || !source?.alive || !target?.alive) return false
    const available = pickableCardsOf(host.state, target.id, { discarderId: ownerId })
    if (!available.cardIds.length && !available.hiddenCardSlots.length) return false
    host.askSkill({ skillId: JIANCHU, ownerId, step: 'discard', data: { targetId: target.id, cardId: context.cardId }, build: id => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【鞬出】：是否弃置${target.nickname}一张牌？`, timeoutMs: 25_000,
      optional: true, purpose: 'skill', cardIds: available.cardIds, hiddenCardSlots: available.hiddenCardSlots, min: 0, max: 1,
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId, slashId = resolution.data.cardId as CardId
    const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
    if (cardId) {
      const origin = locateOwnedCard(host.state, targetId, cardId)
      if (!origin) { host.resumeCardTarget(); return }
      const isEquipment = origin.kind === 'equipment'
      moveCard(host.state, cardId, origin, { kind: 'discardPile' })
      if (isEquipment) {
        if (origin.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JIANCHU }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        const state = host.state.cardResolution
        if (state?.kind === 'slash' && state.cardId === slashId) { state.noDodge = true; state.noDodgeTargetIds ??= []; if (!state.noDodgeTargetIds.includes(targetId)) state.noDodgeTargetIds.push(targetId) }
      } else {
        const state = host.state.cardResolution
        if (state?.kind === 'slash' && state.cardId === slashId && host.state.zones.processingArea.includes(slashId)) {
          moveCard(host.state, slashId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
          host.dispatch('GainCard', { playerId: targetId, cardIds: [slashId], reason: JIANCHU }, { sourceId: ownerId, targetId, cardIds: [slashId] })
          state.targetCancelled = true
        }
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JIANCHU }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
    }
    host.resumeCardTarget()
  },
})

export const HISTORICAL_BATCH39_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'jie-zhenji-b41', name: '界·甄姬', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: 'qingguo', name: '倾国', description: '你可以将一张黑色手牌当【闪】使用或打出。' },
    { id: JIE_LUOSHEN, name: '洛神', description: '准备阶段，你可以判定，若结果为黑色，你获得此牌，然后你可以重复此流程。以此法获得的牌本回合不计入手牌上限。' },
  ] },
  { id: 'jie-diaochan-b41', name: '界·貂蝉', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: 'lijian', name: '离间', description: '出牌阶段限一次，你可以弃置一张牌并选择两名其他男性角色，然后令其中一名男性角色视为对另一名男性角色使用一张【决斗】。' },
    { id: JIE_BIYUE, name: '闭月', description: '结束阶段，你可以摸一张牌。若你没有手牌，则改为摸两张牌。' },
  ] },
  { id: 'sp-pangtong-b41', name: 'SP·庞统', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: GUOLUN, name: '过论', description: '出牌阶段限一次，你可以展示一名其他角色一张手牌，然后你可以选择你的一张牌，你与其交换这两张牌，交换前的牌点数小的角色摸一张牌。' },
    { id: SONGSANG, name: '送丧', description: '限定技，当其他角色死亡时，若你已受伤，你可以回复1点体力；若你未受伤，你可以增加1点体力上限。若如此做，你获得“展骥”（锁定技，当你于出牌阶段内因摸牌且并非因发动此技能而得到牌时，你摸一张牌）。' },
  ] },
  { id: 'sp-taishici-b41', name: 'SP·太史慈', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: JIXU, name: '击虚', description: '出牌阶段限一次，你可令体力值相同的至少一名其他角色各猜测你的手牌区里是否有【杀】。系统公布这些角色各自的选择和猜测结果。若你的手牌区里有【杀】，当你于此阶段内使用【杀】选择目标后，你令所有选择“否”的角色也成为此【杀】的目标；若没有【杀】，你弃置所有选择“是”的角色的各一张牌。你摸X张牌（X为猜错的角色数）。若没有猜错的角色，你结束此阶段。' },
  ] },
  { id: 'yiji-jie-b41', name: '界·伊籍', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: JIJIE, name: '机捷', description: '出牌阶段限一次，你可以观看牌堆底的一张牌，然后交给任意角色。' },
    { id: QIUYUAN, name: '急援', description: '当一名角色进入濒死状态或你交给一名其他角色牌时，你可以令其摸一张牌。' },
  ] },
  { id: 'kuai-yue-liang-b41', name: '蒯越蒯良', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'wind', skills: [
    { id: JIANGXIANG, name: '荐降', description: '当你成为其他角色使用牌的目标后，你可以令手牌数最少的一名角色摸一张牌。' },
    { id: SHENSHI, name: '审时', description: '转换技，阳：出牌阶段限一次，你可以交给手牌数最多的一名其他角色一张牌，然后对其造成1点伤害；若其因此死亡，你可以令一名角色将手牌摸至四张。阴：其他角色对你造成伤害后，你可以观看其手牌并交给其一张牌；当前回合结束时，若其未失去此牌，你将手牌摸至四张。' },
  ] },
  { id: 'jie-wolongzhuge-b41', name: '界·卧龙诸葛亮', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'fire', skills: [
    { id: JIE_BAZHEN, name: '八阵', description: '锁定技，若你的装备区里没有防具牌，你视为装备着【八卦阵】。' },
    { id: JIE_HUOJI, name: '火计', description: '你可以将一张红色牌当【火攻】使用。你的【火攻】改为令目标展示随机手牌，你弃置与展示牌颜色相同的牌以造成伤害。' },
    { id: JIE_KANPO, name: '看破', description: '你可以将一张黑色牌当【无懈可击】使用。你的【无懈可击】不能被响应。' },
    { id: CANGZHUO, name: '藏拙', description: '锁定技，弃牌阶段开始时，若你本回合未使用过锦囊牌，你的锦囊牌不计入手牌上限。' },
  ] },
  { id: 'jie-dianwei-b41', name: '界·典韦', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'fire', skills: [
    { id: JIE_QIANGXI, name: '强袭', description: '出牌阶段限两次，你可以受到1点伤害或弃置一张武器牌，对一名本回合内未以此法指定过的其他角色造成1点伤害。' },
  ] },
  { id: 'jie-xunyu-b41', name: '界·荀彧', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'fire', skills: [
    { id: JIE_QUHU, name: '驱虎', description: '出牌阶段限一次，你可以与体力值大于你的一名角色拼点：若你赢，其对其攻击范围内一名由你选择的角色造成1点伤害；若你没赢，其对你造成1点伤害。' },
    { id: JIE_JIEMING, name: '节命', description: '当你受到1点伤害后或死亡时，你可以令一名角色摸X张牌，然后将手牌弃至X张（X为其体力上限且至多为5）。' },
  ] },
  { id: 'jie-pangde-b41', name: '界·庞德', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'fire', skills: [
    { id: 'mashu', name: '马术', description: '锁定技，你计算与其他角色的距离-1。' },
    { id: JIANCHU, name: '鞬出', description: '当你使用【杀】指定一个目标后，你可以弃置其一张牌，若弃置的牌是装备牌，该角色不能使用【闪】；若不是装备牌，该角色获得此【杀】。' },
  ] },
]
