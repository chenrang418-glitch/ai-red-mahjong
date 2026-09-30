import { drawCards } from '../../engine/draw'
import { takeOverDrawPhase } from '../../engine/draw-phase-takeover'
import { livingKingdomCount } from '../../engine/living-kingdoms'
import { continueDyingRescue } from '../../engine/damage'
import { recover } from '../../engine/recover'
import { flipCharacter } from '../../engine/character-state'
import { skipPhase } from '../../engine/turn'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { effectiveCardName, locateOwnedCard, moveCard } from '../../engine/zones'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { loseHp } from '../../engine/hp'
import { isTargetProhibited } from '../../engine/skills/runtime'
import { skillIdsOf } from './standard'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

const B = '-b46'
const DANGXIAN = `dangxian${B}`, FULI = `fuli${B}`, ANXU = `anxu${B}`, ZHUIYI = `zhuiyi${B}`
const ZISHOU = `zishou${B}`, ZONGSHI = `zongshi${B}`, ZHENGXUAN = `zhengxuan${B}`
const WEIFENG = `weifeng${B}`, JINFAN = `jinfan${B}`, SHEQUE = `sheque${B}`
const ZHIYAN = `zhiyan${B}`, ZHILUE = `zhilue${B}`, YICONG_SP = `yicong-sp${B}`, YICONG_JIE = `yicong-jie${B}`, QIAOMENG = `qiaomeng${B}`
const XUAN = 'jing-b46'

function player(state: SanguoshaState, id: PlayerId) { return state.players.find((entry) => entry.id === id) }
function otherPlayers(state: SanguoshaState, id: PlayerId) { return state.players.filter((entry) => entry.alive && entry.id !== id) }

// 界廖化【当先】在每个正常回合开始增加额外出牌阶段；从弃牌堆获得杀在该阶段开始时完成。
registerSkillRuntime({
  id: DANGXIAN,
  extraPhaseAtTurnStart(state, ownerId) { return player(state, ownerId)?.alive ? 'play' : null },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const extra = host.state.extraPhase
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (extra?.skillId !== DANGXIAN || extra.playerId !== ownerId || payload.playerId !== ownerId || payload.phase !== 'play') return
    const slashes = host.state.zones.discardPile.filter((cardId) => host.state.cards[cardId]?.name === '杀')
    if (!slashes.length) return
    host.askSkill({ skillId: DANGXIAN, ownerId, step: 'gain-slash', build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【当先】：获得弃牌堆里的一张【杀】',
      timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: slashes, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'gain-slash') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !host.state.zones.discardPile.includes(cardId) || host.state.cards[cardId]?.name !== '杀') return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: DANGXIAN }, { targetId: ownerId, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: FULI, limited: true,
  dyingIntercept(host, ownerId) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(FULI)) return false
    host.askSkill({ skillId: FULI, ownerId, step: 'dying', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【伏枥】：是否将体力回复至当前势力数？', timeoutMs: 20_000,
      optional: true, options: [{ id: 'use', label: `回复至${livingKingdomCount(host.state)}点体力` }, { id: 'cancel', label: '不发动' }],
    }) })
    return 'pending'
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'dying' || host.state.dying?.playerId !== ownerId) return
    const owner = player(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'use' || owner.usedLimitedSkills.includes(FULI)) {
      continueDyingRescue(host as never); if (!host.state.dying) host.resumeAfterDying(); return
    }
    owner.usedLimitedSkills.push(FULI)
    const targetHp = Math.min(owner.maxHp, livingKingdomCount(host.state))
    const healed = Math.max(0, targetHp - owner.hp)
    owner.hp = targetHp
    if (healed) host.dispatch('Recover', { playerId: ownerId, amount: healed, reason: FULI }, { targetId: ownerId })
    const uniqueHighest = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId && entry.hp >= owner.hp).length === 0
    if (uniqueHighest) flipCharacter(host as never, ownerId, FULI, !owner.faceDown)
    host.dispatch('QuitDying', { playerId: ownerId, hp: owner.hp, reason: FULI }, { targetId: ownerId })
    host.state.dying = null; host.resumeAfterDying()
  },
})

function anxuGiveTargets(state: SanguoshaState, ownerId: PlayerId, receiverId?: PlayerId) {
  return otherPlayers(state, ownerId).filter((target) => target.id !== receiverId && hasPickableCards(state, target.id)).map((target) => target.id)
}
registerSkillRuntime({
  id: ANXU,
  activeActions(state, ownerId) { return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, ANXU)
    && otherPlayers(state, ownerId).some((target) => hasPickableCards(state, target.id)) ? [{ id: ANXU, label: '安恤：令一名角色获得另一名角色一张牌' }] : [] },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ANXU || usedThisPhase(host.state, ownerId, ANXU)) return
    const targets = otherPlayers(host.state, ownerId).filter((target) => hasPickableCards(host.state, target.id)).map((target) => target.id)
    if (!targets.length) return
    host.askSkill({ skillId: ANXU, ownerId, step: 'receiver', build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
      prompt: '【安恤】：选择获得牌的角色', timeoutMs: 20_000, optional: false, candidateIds: targets, min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'receiver') {
      const receiverId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const sources = receiverId ? anxuGiveTargets(host.state, ownerId, receiverId) : []
      if (!receiverId || !sources.length) return
      host.askSkill({ skillId: ANXU, ownerId, step: 'source', data: { receiverId }, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【安恤】：选择给牌的另一名角色', timeoutMs: 20_000, optional: false, candidateIds: sources, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'source') {
      const receiverId = resolution.data.receiverId as PlayerId
      const sourceId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!sourceId || !anxuGiveTargets(host.state, ownerId, receiverId).includes(sourceId)) return
      const pickable = pickableCardsOf(host.state, sourceId)
      host.askSkill({ skillId: ANXU, ownerId, step: 'card', data: { receiverId, sourceId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【安恤】：选择要获得的牌', timeoutMs: 20_000, optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'lesser') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidates = (resolution.data.candidates as PlayerId[]).filter((id) => player(host.state, id)?.alive)
      if (candidates.length === 1) {
        drawCards(host.state, host.rng, candidates[0], 1, (name, payload) => host.dispatch(name, payload))
      } else if (candidates.length > 1) {
        host.askSkill({ skillId: ANXU, ownerId, step: 'lesser-target', build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【安恤】：手牌数相同，选择其中一名角色摸一张牌',
          timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'lesser-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && (resolution.data.candidates as PlayerId[]).includes(targetId) && player(host.state, targetId)?.alive)
        drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
      return
    }
    if (resolution.step !== 'card') return
    const { receiverId, sourceId } = resolution.data as { receiverId: PlayerId; sourceId: PlayerId }
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected ? resolvePickedCard(host.state, sourceId, selected) : null
    const originalZone = cardId ? locateOwnedCard(host.state, sourceId, cardId, { includeCharacterPiles: true }) : null
    if (!cardId || !movePickedCard(host as never, sourceId, cardId, { kind: 'hand', playerId: receiverId })) return
    markUsedThisPhase(host.state, ownerId, ANXU)
    host.dispatch('GainCard', { playerId: receiverId, cardIds: [cardId], reason: ANXU }, { sourceId: sourceId, targetId: receiverId, cardIds: [cardId] })
    if (originalZone?.kind !== 'equipment') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    const r = player(host.state, receiverId), s = player(host.state, sourceId)
    if (!r?.alive || !s?.alive) return
    const min = Math.min(r.zones.hand.length, s.zones.hand.length)
    const candidates = [r, s].filter((entry) => entry.zones.hand.length === min).map((entry) => entry.id)
    host.askSkill({ skillId: ANXU, ownerId, step: 'lesser', data: { candidates }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【安恤】：是否令其中手牌较少的角色摸一张牌？', timeoutMs: 20_000,
      optional: true, options: [{ id: 'yes', label: '令手牌较少者摸一张' }, { id: 'no', label: '不发动' }],
    }) })
    return
  },
})
registerSkillRuntime({
  id: ZHUIYI, allowsDeadResponder: true,
  triggers: [{ event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; sourceId?: PlayerId | null }
    if (payload.playerId === ownerId) host.queueSkill({ skillId: ZHUIYI, ownerId, step: 'death-target', data: { killerId: payload.sourceId ?? undefined }, allowDeadOwner: true })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'death-target') return
    const killerId = prompt.data.killerId as PlayerId | undefined
    const targets = otherPlayers(host.state, ownerId).filter((entry) => entry.id !== killerId).map((entry) => entry.id)
    if (!targets.length) return
    host.askSkill({ skillId: ZHUIYI, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【追忆】：令一名非杀死你的角色摸三张牌并回复1点体力',
      timeoutMs: 20_000, optional: true, candidateIds: targets, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host.state, targetId) : undefined
    if (!target?.alive || target.id === ownerId) return
    drawCards(host.state, host.rng, target.id, 3, (name, payload) => host.dispatch(name, payload))
    recover(host as never, target.id, 1, ownerId)
  },
})

const LIAOHUA: CharacterDefinition = { id: 'jie-liaohua-b46', name: '界·廖化', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'wind', skills: [
  { id: DANGXIAN, name: '当先', description: '锁定技，回合开始时，你从弃牌堆获得一张【杀】并执行一个额外的出牌阶段。', locked: true },
  { id: FULI, name: '伏枥', description: '限定技，当你处于濒死状态时，你可以将体力回复至X点（X为全场势力数）。然后若你的体力值为全场唯一最高，你翻面。' },
] }
const BULIANSHI: CharacterDefinition = { id: 'jie-bulianshi-b46', name: '界·步练师', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'wind', skills: [
  { id: ANXU, name: '安恤', description: '出牌阶段限一次，你可以选择一名其他角色，令其获得另一名其他角色的一张牌。若其获得的牌不是来自装备区的牌，你摸一张牌。其获得牌后你可以令二者手牌较少的角色摸一张牌。' },
  { id: ZHUIYI, name: '追忆', description: '当你死亡时，你可以令一名其他角色（杀死你的角色除外）摸三张牌，然后回复1点体力。' },
] }

function stateMarks(state: SanguoshaState) { return state as SanguoshaState & { liubiaoSelfTurn?: Record<PlayerId, number>; liubiaoSlashTurn?: Record<PlayerId, number> } }
registerSkillRuntime({
  id: ZISHOU,
  triggers: [{ event: 'DrawPhase', handle(host, ownerId, context) {
    if (!takeOverDrawPhase(host, ownerId, context)) return
    const base = Math.max(0, Math.trunc(Number((context.event.payload as { count?: unknown }).count ?? 2)))
    host.askSkill({ skillId: ZISHOU, ownerId, step: 'choice', data: { base }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【自守】：是否额外摸${livingKingdomCount(host.state)}张牌并本回合不能对其他角色使用牌？`, timeoutMs: 20_000,
      optional: false, options: [{ id: 'yes', label: '发动：额外摸牌，不能对其他角色使用牌' }, { id: 'no', label: `不发动，正常摸${base}张` }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice') return
    if ((response.payload as { optionId?: string }).optionId === 'yes') {
      stateMarks(host.state).liubiaoSelfTurn ??= {}; stateMarks(host.state).liubiaoSelfTurn![ownerId] = host.state.turnNumber
      const base = Math.max(0, Math.trunc(Number(resolution.data.base ?? 2)))
      drawCards(host.state, host.rng, ownerId, base + livingKingdomCount(host.state), (name, payload) => host.dispatch(name, payload))
    } else {
      const base = Math.max(0, Math.trunc(Number(resolution.data.base ?? 2)))
      drawCards(host.state, host.rng, ownerId, base, (name, payload) => host.dispatch(name, payload))
    }
  },
  prohibitsSourceTarget(state, ownerId, targetId) { return stateMarks(state).liubiaoSelfTurn?.[ownerId] === state.turnNumber && targetId !== ownerId },
})
registerSkillRuntime({
  id: ZONGSHI,
  maxCardsBonus(state) { return livingKingdomCount(state) },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = player(host.state, ownerId)
    if (payload.playerId === ownerId && payload.phase === 'prepare' && owner?.alive && owner.zones.hand.length > owner.hp) {
      stateMarks(host.state).liubiaoSlashTurn ??= {}; stateMarks(host.state).liubiaoSlashTurn![ownerId] = host.state.turnNumber
    }
  } }],
  unlimitedSlashFor(state, ownerId) { return stateMarks(state).liubiaoSlashTurn?.[ownerId] === state.turnNumber },
})
const LIUBIAO: CharacterDefinition = { id: 'jie-liubiao-b46', name: '界·刘表', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'wind', skills: [
  { id: ZISHOU, name: '自守', description: '摸牌阶段，你可以多摸X张牌（X为全场势力数）。若如此做，本回合你使用牌不能选择其他角色为目标。' },
  { id: ZONGSHI, name: '宗室', description: '锁定技，你的手牌上限+X（X为全场势力数）。准备阶段，若你的手牌数大于你的体力值，则你本回合使用【杀】无次数限制。', locked: true },
] }

// 【整经】通过专属“划牌”交互完成整理，再按官方技能文本处理经与余牌。
registerSkillRuntime({
  id: ZHENGXUAN,
  activeActions(state, ownerId) { return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, ZHENGXUAN)
    && state.zones.drawPile.length > 0 && otherPlayers(state, ownerId).length > 0 ? [{ id: ZHENGXUAN, label: '整经：整理牌堆顶牌并分置“经”' }] : [] },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHENGXUAN) return
    const cards = host.state.zones.drawPile.slice(0, Math.min(5, host.state.zones.drawPile.length))
    if (!cards.length) return
    host.askSkill({ skillId: ZHENGXUAN, ownerId, step: 'select', data: { cards }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【整经】：从展示牌中选择任意张作为“经”，其余牌你获得',
      timeoutMs: 25_000, optional: true, purpose: 'skill', interaction: { kind: 'zhengxuan-slice' }, cardIds: cards, hiddenCardSlots: [], min: 0, max: cards.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'select') {
      const cards = resolution.data.cards as CardId[]
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => cards.includes(id) && host.state.zones.drawPile.includes(id))
      markUsedThisPhase(host.state, ownerId, ZHENGXUAN)
      for (const id of cards) if (host.state.zones.drawPile.includes(id)) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'processingArea' })
      const remaining = cards.filter((id) => !selected.includes(id))
      for (const id of remaining) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      if (remaining.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: remaining, reason: ZHENGXUAN }, { targetId: ownerId, cardIds: remaining })
      if (!selected.length) return
      const targets = host.state.players.filter((entry) => entry.alive).map((entry) => entry.id)
      host.askSkill({ skillId: ZHENGXUAN, ownerId, step: 'target', data: { selected }, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【整经】：选择放置“经”的角色', timeoutMs: 20_000, optional: false, candidateIds: targets, min: 1, max: 1 }) })
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const selected = resolution.data.selected as CardId[]
    if (!targetId || !player(host.state, targetId)?.alive) {
      for (const id of selected) if (host.state.zones.processingArea.includes(id)) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      return
    }
    const recipient = player(host.state, targetId)!
    recipient.characterPiles[XUAN] ??= []
    for (const id of selected) if (host.state.zones.processingArea.includes(id)) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'characterPile', playerId: targetId, pile: XUAN })
    host.dispatch('CardMove', { playerId: targetId, cardIds: selected, reason: ZHENGXUAN }, { sourceId: ownerId, targetId, cardIds: selected })
  },
  triggers: [
    { event: 'PhaseStart', handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'prepare' || !payload.playerId) return
      const target = player(host.state, payload.playerId), pile = target?.characterPiles[XUAN] ?? []
      if (!target?.alive || !pile.length) return
      const skipped = host.state as SanguoshaState & { zhengxuanSkip?: Record<PlayerId, number> }
      skipped.zhengxuanSkip ??= {}; skipped.zhengxuanSkip[payload.playerId] = host.state.turnNumber
      for (const id of [...pile]) moveCard(host.state, id, { kind: 'characterPile', playerId: payload.playerId, pile: XUAN }, { kind: 'hand', playerId: payload.playerId })
      host.dispatch('GainCard', { playerId: payload.playerId, cardIds: [...pile], reason: ZHENGXUAN }, { targetId: payload.playerId, cardIds: [...pile] })
      skipPhase(host.state, 'judge'); skipPhase(host.state, 'draw')
    } },
  ],
})
const ZHENGXUAN_CHAR: CharacterDefinition = { id: 'zhengxuan-b46', name: '郑玄', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'standard', skills: [
  { id: ZHENGXUAN, name: '整经', description: '出牌阶段限一次，你可以整理一次经典，并将你整理出的任意牌置于一名角色的武将牌上，称为“经”，然后你获得剩余的牌。武将牌上有“经”的角色的准备阶段，其获得所有“经”，然后跳过本回合的判定阶段和摸牌阶段。' },
] }

function batch46State(state: SanguoshaState) {
  return state as SanguoshaState & {
    weifengMarks?: Record<PlayerId, Record<PlayerId, string>>
    jinfanSuitByCard?: Record<CardId, string>
    shequeCardIds?: Record<PlayerId, CardId[]>
    zhilueTurn?: Record<PlayerId, number>
    qiaomengPending?: Record<PlayerId, { cardId: CardId; targetId: PlayerId }>
    xingxuHandoff?: Record<PlayerId, { mode: 'draw' | 'give'; count: number }>
    wanglingBackups?: Record<PlayerId, Array<{ name: string; category: string }>>
    wanglingEmptyPlayTurn?: Record<PlayerId, number>
    wanglingMissionDone?: PlayerId[]
    wanglingMouliGranted?: PlayerId[]
    xingzhangheBonusTurn?: Record<PlayerId, number>
  }
}

const WEIFENG_NAMES = ['杀', '火攻', '南蛮入侵', '万箭齐发', '决斗']
function weifengMarks(state: SanguoshaState, ownerId: PlayerId) {
  const data = batch46State(state)
  const records = data.weifengMarks ?? (data.weifengMarks = {})
  return records[ownerId] ?? (records[ownerId] = {})
}
function clearWeifengMarks(state: SanguoshaState, ownerId: PlayerId): void {
  const targets = batch46State(state).weifengMarks?.[ownerId]
  for (const targetId of Object.keys(targets ?? {})) {
    const marks = player(state, targetId)?.marks
    if (marks) delete marks[`fear:${ownerId}`]
  }
  delete batch46State(state).weifengMarks?.[ownerId]
}
function askWeifengTarget(host: SkillHost, ownerId: PlayerId, promptData: Record<string, unknown>): void {
  const candidateIds = (promptData.candidateIds as PlayerId[]).filter((id) => player(host.state, id)?.alive && !weifengMarks(host.state, ownerId)[id])
  if (!candidateIds.length) return
  host.askSkill({ skillId: WEIFENG, ownerId, step: 'target', data: { cardName: promptData.cardName }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: `【威风】：选择一名目标角色，将“${String(promptData.cardName)}”标记为其“惧”`,
    timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
  }) })
}
registerSkillRuntime({
  id: WEIFENG,
  triggers: [
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || host.state.phase !== 'play' || usedThisPhase(host.state, ownerId, WEIFENG)
        || !payload.cardName || !WEIFENG_NAMES.includes(payload.cardName)) return
      markUsedThisPhase(host.state, ownerId, WEIFENG)
      const candidateIds = (payload.targetIds ?? []).filter((id) => id !== ownerId && player(host.state, id)?.alive && !weifengMarks(host.state, ownerId)[id])
      if (!candidateIds.length) return
      host.queueSkill({ skillId: WEIFENG, ownerId, step: 'choose-mark', data: { cardName: payload.cardName, candidateIds } })
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'prepare') clearWeifengMarks(host.state, ownerId)
    } },
    { event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) clearWeifengMarks(host.state, ownerId)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId || !weifengMarks(host.state, ownerId)[targetId]) return
      const payload = context.event.payload as { finalAmount?: number; cardName?: string | null; cardId?: CardId | null }
      if (Number(payload.finalAmount ?? 0) <= 0) return
      const declared = weifengMarks(host.state, ownerId)[targetId]
      delete batch46State(host.state).weifengMarks?.[ownerId]?.[targetId]
      const target = player(host.state, targetId)
      if (target?.marks) delete target.marks[`fear:${ownerId}`]
      if (!target || !target.alive || (payload.cardName ?? null) === declared) return
      host.queueSkill({ skillId: WEIFENG, ownerId, step: 'take', data: { targetId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-mark') { askWeifengTarget(host, ownerId, prompt.data); return }
    if (prompt.step !== 'take') return
    const targetId = prompt.data.targetId as PlayerId
    const target = player(host.state, targetId)
    if (!target?.alive || !hasPickableCards(host.state, targetId)) return
    const pickable = pickableCardsOf(host.state, targetId)
    host.askSkill({ skillId: WEIFENG, ownerId, step: 'take-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【威风】：获得${target.nickname}区域里的一张牌`,
      timeoutMs: 20_000, optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
    }) })
  },
  globalOutgoingDamage(state, _ownerId, _sourceId, context) {
    if (!context.cardId) return null
    const marks = batch46State(state).weifengMarks
    const matches = Object.values(marks ?? {}).some((targets) => targets[context.targetId] === context.cardName)
    return matches ? { amount: context.amount + 1 } : null
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardName = resolution.data.cardName as string
      if (!targetId || targetId === ownerId || !player(host.state, targetId)?.alive || !WEIFENG_NAMES.includes(cardName) || weifengMarks(host.state, ownerId)[targetId]) return
      weifengMarks(host.state, ownerId)[targetId] = cardName
      player(host.state, targetId)!.marks[`fear:${ownerId}`] = WEIFENG_NAMES.indexOf(cardName) + 1
      return
    }
    if (resolution.step !== 'take-card') return
    const targetId = resolution.data.targetId as PlayerId
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
    if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId }))
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WEIFENG }, { targetId: ownerId, cardIds: [cardId] })
  },
})
const XING_ZHANGLIAO: CharacterDefinition = { id: 'star-zhangliao-b46', name: '星·张辽', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard', skills: [
  { id: WEIFENG, name: '威风', locked: true, description: '锁定技，当你于出牌阶段第一次使用【杀】【火攻】【南蛮入侵】【万箭齐发】【决斗】中的一种牌结算结束后，你选择此牌其中一个没有“惧”的其他角色并指定此牌牌名为“惧”标记。有“惧”的角色受到伤害时，移除“惧”并执行以下效果：若造成伤害的牌牌名与“惧”相同，此伤害+1；若不同，你获得其一张牌。准备阶段或你死亡时，移除所有“惧”。' },
] }

function bells(state: SanguoshaState, ownerId: PlayerId): CardId[] { return player(state, ownerId)?.characterPiles[JINFAN] ?? [] }
function bellSuit(state: SanguoshaState, cardId: CardId): string { return state.cards[cardId]?.suit ?? 'none' }
function bellCandidates(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const usedSuits = new Set(bells(state, ownerId).map((id) => bellSuit(state, id)))
  return (player(state, ownerId)?.zones.hand ?? []).filter((id) => !usedSuits.has(bellSuit(state, id)))
}
function giveBellSuit(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  const suit = batch46State(host.state).jinfanSuitByCard?.[cardId]
  if (!suit) return
  const playerOfCard = player(host.state, ownerId)
  const inPile = playerOfCard?.characterPiles[JINFAN]?.includes(cardId)
  if (inPile) return
  delete batch46State(host.state).jinfanSuitByCard?.[cardId]
  const choices = host.state.zones.drawPile.filter((id) => bellSuit(host.state, id) === suit)
  if (!choices.length || !playerOfCard?.alive) return
  const gain = host.rng.pick(choices)
  moveCard(host.state, gain, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [gain], reason: JINFAN }, { targetId: ownerId, cardIds: [gain] })
}
registerSkillRuntime({
  id: JINFAN,
  viewAs(state, ownerId) { return bells(state, ownerId).map((cardId) => ({ cardId, asCardName: effectiveCardName(state, cardId), label: `锦帆“铃”：使用或打出【${effectiveCardName(state, cardId)}】` })) },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'discard' || !player(host.state, ownerId)?.alive) return
      if (bellCandidates(host.state, ownerId).length) host.queueSkill({ skillId: JINFAN, ownerId, step: 'store', data: {} })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (context.event.sourceId === ownerId && cardId) giveBellSuit(host, ownerId, cardId)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
      if (payload.playerId === ownerId && payload.cardId) giveBellSuit(host, ownerId, payload.cardId)
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId === ownerId) for (const cardId of payload.cardIds ?? []) giveBellSuit(host, ownerId, cardId)
    } },
    { event: 'CardMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardIds?: CardId[] }
      for (const cardId of payload.cardIds ?? []) giveBellSuit(host, ownerId, cardId)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'store') {
      const candidates = bellCandidates(host.state, ownerId)
      host.askSkill({ skillId: JINFAN, ownerId, step: 'choose-store', build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【锦帆】：将一张手牌置为“铃”，可继续选择不同花色或结束',
        timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: candidates.length ? 1 : 0,
      }) })
      return
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-store') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId) return
      const owner = player(host.state, ownerId)
      if (!owner?.zones.hand.includes(cardId) || !bellCandidates(host.state, ownerId).includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: JINFAN })
      batch46State(host.state).jinfanSuitByCard ??= {}; batch46State(host.state).jinfanSuitByCard![cardId] = bellSuit(host.state, cardId)
      host.dispatch('CardMove', { playerId: ownerId, cardIds: [cardId], reason: JINFAN }, { sourceId: ownerId, cardIds: [cardId] })
      if (bellCandidates(host.state, ownerId).length) host.queueSkill({ skillId: JINFAN, ownerId, step: 'store', data: {} })
      return
    }
  },
})

function askSheque(host: SkillHost, ownerId: PlayerId, data: Record<string, unknown>): void {
  const targetId = data.targetId as PlayerId
  const target = player(host.state, targetId)
  const cards = [...(player(host.state, ownerId)?.zones.hand ?? []), ...bells(host.state, ownerId)]
    .filter((id) => effectiveCardName(host.state, id) === '杀')
  if (!target?.alive || !Object.values(target.zones.equipment).some(Boolean) || !cards.length) return
  host.askSkill({ skillId: SHEQUE, ownerId, step: 'sheque-use', data: { targetId }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【射却】：是否对${target.nickname}使用一张无距离限制且无视防具的【杀】？`,
    timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '使用【杀】' }, { id: 'no', label: '不使用' }],
  }) })
}

registerSkillRuntime({
  id: SHEQUE,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (!payload.playerId || payload.playerId === ownerId || payload.phase !== 'prepare') return
      const target = player(host.state, payload.playerId)
      const cards = [...(player(host.state, ownerId)?.zones.hand ?? []), ...bells(host.state, ownerId)]
        .filter((id) => effectiveCardName(host.state, id) === '杀')
      if (target?.alive && Object.values(target.zones.equipment).some(Boolean) && cards.length)
        host.queueSkill({ skillId: SHEQUE, ownerId, step: 'sheque', data: { targetId: target.id } })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      const list = batch46State(host.state).shequeCardIds?.[ownerId]
      if (list) batch46State(host.state).shequeCardIds![ownerId] = list.filter((id) => id !== cardId)
    } },
  ],
  startQueued(host, ownerId, prompt) { if (prompt.step === 'sheque') askSheque(host, ownerId, prompt.data) },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'sheque-use') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId
      const candidates = [...(player(host.state, ownerId)?.zones.hand ?? []), ...bells(host.state, ownerId)]
        .filter((id) => effectiveCardName(host.state, id) === '杀')
      if (!candidates.length || !player(host.state, targetId)?.alive) return
      host.askSkill({ skillId: SHEQUE, ownerId, step: 'sheque-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【射却】：选择使用的【杀】', timeoutMs: 20_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'sheque-card') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !player(host.state, targetId)?.alive || effectiveCardName(host.state, cardId) !== '杀') return
      const overrides = batch46State(host.state).shequeCardIds ?? (batch46State(host.state).shequeCardIds = {})
      overrides[ownerId] ??= []; overrides[ownerId]!.push(cardId)
      const began = host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: SHEQUE, cardId, countUsage: false })
      if (!began) batch46State(host.state).shequeCardIds![ownerId] = overrides[ownerId]!.filter((id) => id !== cardId)
    }
  },
  slashIgnoresDistance(state, ownerId, cardId) { return Boolean(cardId && batch46State(state).shequeCardIds?.[ownerId]?.includes(cardId)) },
  ignoresArmorFor(state, ownerId, targetId) {
    const resolution = state.cardResolution
    return resolution?.kind === 'slash' && resolution.sourceId === ownerId && resolution.targetId === targetId
      && Boolean(batch46State(state).shequeCardIds?.[ownerId]?.includes(resolution.cardId))
  },
})
const XING_GANNING: CharacterDefinition = { id: 'star-ganning-b46', name: '星·甘宁', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard', skills: [
  { id: JINFAN, name: '锦帆', description: '弃牌阶段开始时，你可以将任意张手牌置于武将牌上，称为“铃”（每种花色的“铃”至多各一张）。当你需要使用或打出手牌时，你可以将“铃”视为你的牌使用或打出；当你的“铃”离开武将牌上时，你从牌堆中获得一张同花色的牌。' },
  { id: SHEQUE, name: '射却', description: '一名其他角色的准备阶段，若其装备区内有牌，你可以对其使用一张无距离限制且无视防具的【杀】。' },
] }

const ZHIYAN_FIRST = `${ZHIYAN}:draw`, ZHIYAN_SECOND = `${ZHIYAN}:give`, ZHIYAN_LOCK = `${ZHIYAN}:lock`
function zhiYanAction(state: SanguoshaState, ownerId: PlayerId): Array<{ id: string; label: string }> {
  const owner = player(state, ownerId)
  if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
  return [
    ...(!usedThisPhase(state, ownerId, ZHIYAN_FIRST) && owner.zones.hand.length < owner.maxHp ? [{ id: ZHIYAN_FIRST, label: '治严：摸牌至体力上限，本阶段不能对其他角色使用牌' }] : []),
    ...(!usedThisPhase(state, ownerId, ZHIYAN_SECOND) && owner.zones.hand.length > owner.hp && otherPlayers(state, ownerId).length ? [{ id: ZHIYAN_SECOND, label: `治严：交给一名角色${owner.zones.hand.length - owner.hp}张手牌` }] : []),
  ]
}
registerSkillRuntime({
  id: ZHIYAN,
  activeActions: zhiYanAction,
  invokeActive(host, ownerId, actionId) {
    if (actionId === ZHIYAN_FIRST) {
      const owner = player(host.state, ownerId)
      if (!owner?.alive || usedThisPhase(host.state, ownerId, ZHIYAN_FIRST) || owner.zones.hand.length >= owner.maxHp) return
      markUsedThisPhase(host.state, ownerId, ZHIYAN_FIRST); markUsedThisPhase(host.state, ownerId, ZHIYAN_LOCK)
      drawCards(host.state, host.rng, ownerId, owner.maxHp - owner.zones.hand.length, (name, payload) => host.dispatch(name, payload))
      return
    }
    if (actionId !== ZHIYAN_SECOND || usedThisPhase(host.state, ownerId, ZHIYAN_SECOND)) return
    const count = (player(host.state, ownerId)?.zones.hand.length ?? 0) - (player(host.state, ownerId)?.hp ?? 0)
    const targets = otherPlayers(host.state, ownerId).map((target) => target.id)
    if (count <= 0 || !targets.length) return
    host.askSkill({ skillId: ZHIYAN, ownerId, step: 'give-target', data: { count }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【治严】：选择一名其他角色', timeoutMs: 20_000,
      optional: false, candidateIds: targets, min: 1, max: 1,
    }) })
  },
  prohibitsSourceTarget(state, ownerId, targetId) { return state.phase === 'play' && usedThisPhase(state, ownerId, ZHIYAN_LOCK) && targetId !== ownerId },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'give-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = player(host.state, ownerId), target = targetId ? player(host.state, targetId) : undefined
      const count = Math.max(0, owner ? owner.zones.hand.length - owner.hp : 0)
      if (!owner?.alive || !target?.alive || target.id === ownerId || count <= 0 || count !== Number(resolution.data.count)) return
      host.askSkill({ skillId: ZHIYAN, ownerId, step: 'give-cards', data: { targetId, count }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【治严】：交给${target.nickname}${count}张手牌`, timeoutMs: 20_000,
        optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (resolution.step !== 'give-cards') return
    const targetId = resolution.data.targetId as PlayerId, count = Number(resolution.data.count)
    const owner = player(host.state, ownerId), target = player(host.state, targetId)
    const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    if (!owner?.alive || !target?.alive || cardIds.length !== count || cardIds.some((id) => !owner.zones.hand.includes(id))) return
    markUsedThisPhase(host.state, ownerId, ZHIYAN_SECOND)
    for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: ZHIYAN }, { sourceId: ownerId, targetId, cardIds })
    host.dispatch('GainCard', { playerId: targetId, cardIds, reason: ZHIYAN }, { sourceId: ownerId, targetId, cardIds })
  },
})
const XING_XUHUANG: CharacterDefinition = { id: 'star-xuhuang-b46', name: '星·徐晃', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard', skills: [
  { id: ZHIYAN, name: '治严', description: '出牌阶段各限一次，你可以选择一项执行对应效果：1.将手牌数摸至体力上限，然后直至本阶段结束时不能对其他角色使用牌；2.将X张手牌交给一名其他角色（X为你的手牌数减去体力值）。' },
] }

function hpOf(state: SanguoshaState, id: PlayerId): number { return player(state, id)?.hp ?? 0 }

// SP公孙瓒【义从】：按体力动态切换进攻距离与防御距离。
registerSkillRuntime({
  id: YICONG_SP,
  distanceModifier: {
    toOthers: (state, ownerId) => hpOf(state, ownerId) > 2 ? -1 : 0,
    fromOthers: (state, ownerId) => hpOf(state, ownerId) <= 2 ? 1 : 0,
  },
})
const SP_GONGSUNZAN: CharacterDefinition = { id: 'sp-gongsunzan-b46', name: 'SP·公孙瓒', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: YICONG_SP, name: '义从', description: '锁定技，若你的体力值大于2，你计算与其他角色的距离-1；若你的体力值不大于2，其他角色计算与你的距离+1。', locked: true },
] }

// 星张郃【知略】：失去体力后可移动场上牌，或摸牌并无距离、次数限制地使用普通杀。
function zhilueSlashTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return otherPlayers(state, ownerId).filter((target) => !isTargetProhibited(state, ownerId, target.id, '杀', skillIdsOf)).map((target) => target.id)
}
registerSkillRuntime({
  id: ZHILUE,
  maxCardsBonus(state, ownerId) { return batch46State(state).zhilueTurn?.[ownerId] === state.turnNumber ? 1 : 0 },
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, ZHILUE) || !player(state, ownerId)?.alive) return []
    const canMove = fieldCards(state).some(({ cardId }) => fieldMoveDestinations(state, cardId).length > 0)
    const canSlash = zhilueSlashTargets(state, ownerId).length > 0
    return canMove || canSlash ? [{ id: ZHILUE, label: '知略：失去1点体力并选择移动场上牌，或摸牌后使用无距离限制的【杀】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHILUE || usedThisPhase(host.state, ownerId, ZHILUE)) return
    const canMove = fieldCards(host.state).some(({ cardId }) => fieldMoveDestinations(host.state, cardId).length > 0)
    const canSlash = zhilueSlashTargets(host.state, ownerId).length > 0
    if (!canMove && !canSlash) return
    markUsedThisPhase(host.state, ownerId, ZHILUE)
    batch46State(host.state).zhilueTurn ??= {}; batch46State(host.state).zhilueTurn![ownerId] = host.state.turnNumber
    loseHp(host as never, ownerId, 1, ZHILUE)
    if (!player(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: ZHILUE, ownerId, step: 'mode', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【知略】：选择一项', timeoutMs: 20_000, optional: false,
      options: [
        ...(fieldCards(host.state).some(({ cardId }) => fieldMoveDestinations(host.state, cardId).length > 0) ? [{ id: 'move', label: '移动场上一张牌' }] : []),
        ...(zhilueSlashTargets(host.state, ownerId).length ? [{ id: 'slash', label: '摸一张牌并使用一张无距离限制的普通【杀】' }] : []),
      ],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mode') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'move') {
        const cards = fieldCards(host.state).filter(({ cardId }) => fieldMoveDestinations(host.state, cardId).length > 0)
        if (!cards.length) return
        host.askSkill({ skillId: ZHILUE, ownerId, step: 'field-card', build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【知略】：选择要移动的场上牌', timeoutMs: 20_000,
          optional: false, purpose: 'skill', cardIds: cards.map(({ cardId }) => cardId), hiddenCardSlots: [], min: 1, max: 1,
        }) })
      } else if (optionId === 'slash' && player(host.state, ownerId)?.alive) {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
        const candidates = zhilueSlashTargets(host.state, ownerId)
        if (candidates.length) host.askSkill({ skillId: ZHILUE, ownerId, step: 'slash-target', build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【知略】：选择【杀】的目标', timeoutMs: 20_000,
          optional: false, candidateIds: candidates, min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'field-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const destinations = cardId ? fieldMoveDestinations(host.state, cardId) : []
      if (!cardId || !destinations.length) return
      host.askSkill({ skillId: ZHILUE, ownerId, step: 'destination', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【知略】：选择移动目标', timeoutMs: 20_000,
        optional: false, candidateIds: destinations, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'destination') {
      const cardId = resolution.data.cardId as CardId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && fieldMoveDestinations(host.state, cardId).includes(targetId)) moveFieldCard(host as never, cardId, targetId)
      return
    }
    if (resolution.step === 'slash-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && zhilueSlashTargets(host.state, ownerId).includes(targetId)) host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: ZHILUE, nature: 'normal', countUsage: false })
    }
  },
})
const XING_ZHANGHE: CharacterDefinition = { id: 'star-zhanghe-b46', name: '星·张郃', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard', skills: [
  { id: ZHILUE, name: '知略', description: '出牌阶段限一次，你可以失去1点体力令你本回合手牌上限+1，并选择一项：1.移动场上一张牌；2.摸一张牌并视为使用一张无距离限制的普通【杀】（不计入限制的次数）。' },
] }

// 界公孙瓒【义从】与【趫猛】。离开装备区统一经过装备失去入口；坐骑只有实际进入弃牌堆后才获得。
function qiaomengCanChoose(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): CardId[] {
  return pickableCardsOf(state, targetId, { discarderId: ownerId }).cardIds
}
registerSkillRuntime({
  id: QIAOMENG,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardName?: string | null; cardId?: CardId | null; finalAmount?: number }
    const targetId = context.event.targetId
    if (context.event.sourceId !== ownerId || !targetId || payload.cardName !== '杀' || !payload.cardId
      || Number(payload.finalAmount ?? 0) <= 0 || host.state.cards[payload.cardId]?.color !== 'black'
      || !qiaomengCanChoose(host.state, ownerId, targetId).length) return
    host.queueSkill({ skillId: QIAOMENG, ownerId, step: 'discard-equipment', data: { targetId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-equipment') return
    const targetId = prompt.data.targetId as PlayerId
    const target = player(host.state, targetId)
    const cardIds = qiaomengCanChoose(host.state, ownerId, targetId)
    if (!target?.alive || !cardIds.length) return
    host.askSkill({ skillId: QIAOMENG, ownerId, step: 'choose-equipment', data: { targetId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【趫猛】：是否弃置${target.nickname}装备区里的一张牌？`, timeoutMs: 20_000,
      optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-equipment') return
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !qiaomengCanChoose(host.state, ownerId, targetId).includes(cardId)) return
    const location = locateOwnedCard(host.state, targetId, cardId)
    if (location?.kind !== 'equipment' || !movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) return
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: QIAOMENG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    const wasHorse = location.slot === 'offensiveHorse' || location.slot === 'defensiveHorse'
    if (wasHorse && host.state.zones.discardPile.includes(cardId) && player(host.state, ownerId)?.alive) {
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: QIAOMENG }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
    }
  },
  distanceModifier: {
    toOthers: (state, ownerId) => Math.max(0, 1 - hpOf(state, ownerId)),
    fromOthers: (state, ownerId) => Math.max(0, (player(state, ownerId)?.maxHp ?? 0) - hpOf(state, ownerId) - 1),
  },
})
registerSkillRuntime({ id: YICONG_JIE, distanceModifier: {
  toOthers: (state, ownerId) => Math.min(0, 1 - hpOf(state, ownerId)),
  fromOthers: (state, ownerId) => Math.max(0, (player(state, ownerId)?.maxHp ?? 0) - hpOf(state, ownerId) - 1),
} })
const JIE_GONGSUNZAN: CharacterDefinition = { id: 'jie-gongsunzan-b46', name: '界·公孙瓒', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'wind', skills: [
  { id: YICONG_JIE, name: '义从', description: '锁定技，你计算与其他角色的距离-X（X为你的体力值-1）；其他角色计算与你的距离+Y（Y为你已损失的体力值-1）。', locked: true },
  { id: QIAOMENG, name: '趫猛', description: '当你使用的黑色【杀】对一名角色造成伤害后，你可以弃置其装备区里的一张牌。然后当此牌置入弃牌堆后，若此牌为坐骑牌，你获得之。' },
] }

export const HISTORICAL_BATCH46_PART1: readonly CharacterDefinition[] = [LIAOHUA, BULIANSHI, LIUBIAO, ZHENGXUAN_CHAR, XING_ZHANGLIAO, XING_GANNING, XING_XUHUANG]
export const HISTORICAL_BATCH46_PART2: readonly CharacterDefinition[] = [SP_GONGSUNZAN, XING_ZHANGHE, JIE_GONGSUNZAN]
