import { drawCards } from './draw'
import type { ChooseCardsRequest, GameResponse } from './requests'
import { validateResponse } from './requests'
import { advancePhase, resumeTurnTransition } from './turn'
import type { PlayerId, SanguoshaState } from './types'
import { moveCard } from './zones'
import { beginJudgmentPhase, type JudgmentEngineHost } from './judgment'
import { fixedMaxCardsOf, maxCardsBonusOf, skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'

/**
 * 阶段引擎的宿主。
 *
 * 继承 JudgmentEngineHost 而不是自己列三个字段：判定阶段会调 beginJudgmentPhase，
 * 而判定现在可能挂起等改判、结束后还要继续发问，需要完整的 SkillHost 能力。
 */
export type PhaseEngineHost = JudgmentEngineHost

/**
 * 把一次明确标记为 discard 的移动写入当前弃牌阶段账本。
 * 调用方必须提供原牌区；使用牌、判定、死亡清理等进入弃牌堆的移动不得伪装成 discard。
 */
export function recordDiscardPhaseMove(state: SanguoshaState, payload: Record<string, unknown>, enteredDiscardAt: number): void {
  const ledger = state.discardPhaseLedger
  if (!ledger || state.phase !== 'discard' || payload.reason !== 'discard') return
  if (payload.phaseInstanceId !== undefined && payload.phaseInstanceId !== ledger.phaseInstanceId) return
  const sourcePlayerId = typeof payload.sourcePlayerId === 'string' ? payload.sourcePlayerId : null
  const originalZone = payload.originalZone === 'hand' || payload.originalZone === 'equipment' ? payload.originalZone : null
  const cardIds = Array.isArray(payload.cardIds) ? payload.cardIds.filter((id): id is string => typeof id === 'string') : []
  if (!sourcePlayerId || !originalZone) return
  for (const cardId of cardIds) {
    if (!state.zones.discardPile.includes(cardId) || ledger.records.some((record) => record.cardId === cardId)) continue
    ledger.records.push({ cardId, sourcePlayerId, originalZone, moveReason: 'discard', enteredDiscardAt })
  }
}

/**
 * 手牌上限的统一计算口径。
 *
 * 基数是当前体力值；「固定为 N」（许老板【空手套白狼】）优先于基数，
 * 加成（袁绍【血裔】）在此之上叠加。两类修正互不覆盖，**都从这里走**，
 * 弃牌阶段和 AI 都读同一个数。
 */
export function maxCardsOf(state: SanguoshaState, playerId: PlayerId): number {
  const target = state.players.find((player) => player.id === playerId)
  if (!target) throw new Error(`玩家不存在：${playerId}`)
  const base = fixedMaxCardsOf(state, playerId) ?? Math.max(0, target.hp)
  return Math.max(0, base + maxCardsBonusOf(state, playerId))
}

function maxCards(state: SanguoshaState, playerId: PlayerId): number {
  return maxCardsOf(state, playerId)
}

function enterCurrentPhase(host: PhaseEngineHost): void {
  const playerId = host.state.currentPlayerId
  const current = host.state.players.find((player) => player.id === playerId)
  if (!current?.alive) throw new Error('当前回合角色不存在或已经死亡')
  switch (host.state.phase) {
    case 'prepare': return
    case 'judge':
      // 神速等技能可以接管整个判定阶段；取消后由技能在放弃发动时自行恢复判定。
      if (host.dispatch('JudgePhase', { playerId }, { sourceId: playerId, phase: 'judge' }).cancelled) return
      beginJudgmentPhase(host)
      return
    case 'draw': {
      // 技能可以取消这次事件来接管摸牌（裸衣少摸一张、突袭改为拿别人的牌）。
      // 取消之后由技能自己负责把牌补上，引擎不再默认摸两张。
      const context = host.dispatch('DrawPhase', { playerId, count: 2 }, { sourceId: playerId, phase: 'draw' })
      if (context.cancelled) return
      /*
       * 不取消、只改数量的技能（许老板【杠杆】还债）就改事件里的 count。
       * 引擎照最终值摸——写死 2 的话「以该摸牌阶段最终应摸数量为准」就无从谈起，
       * 而且逼着每个想少摸一张的技能都去接管整个阶段。
       */
      const count = Math.max(0, Math.trunc(Number((context.event.payload as { count?: unknown }).count ?? 2)))
      if (count <= 0) return
      drawCards(host.state, host.rng, playerId, count, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    case 'play':
      host.dispatch('PlayPhase', { playerId }, { sourceId: playerId, phase: 'play' })
      return
    case 'discard': {
      host.state.discardPhaseLedger = {
        phaseInstanceId: `discard-${host.state.turnNumber}-${host.state.seq}`,
        ownerPlayerId: playerId,
        records: [],
      }
      const context = host.dispatch('DiscardPhase', { playerId }, { sourceId: playerId, phase: 'discard' })
      // 克己等技能可以在阶段入口生成自己的 Request 并接管默认弃牌。
      if (context.cancelled || host.state.pendingRequests.length > 0) return
      const count = current.zones.hand.length - maxCards(host.state, playerId)
      if (count <= 0) return
      const request: ChooseCardsRequest = {
        id: `request-${host.state.seq}`,
        kind: 'choose-cards',
        playerId,
        prompt: `弃置 ${count} 张手牌`,
        timeoutMs: 30_000,
        optional: false,
        purpose: 'discard-phase',
        cardIds: [...current.zones.hand],
        hiddenCardSlots: [],
        min: count,
        max: count,
      }
      host.state.pendingRequests.push(request)
      return
    }
    case 'finish': return
  }
}

/**
 * 阶段开始前的公共「付代价跳过这个阶段」窗口。
 *
 * 这是张郃【巧变】、刘禅【放权】共用的**唯一**入口，也是以后同类技能该挂的地方。
 * 三条约束：
 *
 * 1. **窗口在 `PhaseStart` 之前。** 阶段还没开始，所以挂在阶段上的技能
 *    （英魂、崩坏、观星……）不会在一个最终被跳过的阶段里错误触发。
 * 2. **跳过是真跳过**，走 `skipPhase` 那条既有语义，不是「摸 0 张」
 *    「AI 直接 pass」这类假跳过——兵粮寸断、好施、放权读的都是同一份
 *    `skippedPhases`。
 * 3. **可挂起、可序列化。** 问到哪一步记在 `state.phaseEntry` 里，
 *    技能回答完调 `continuePhaseEntry` 接着问下一个技能。
 *    `askedSkillIds` 防止同一个技能在一个阶段里被反复问。
 *
 * 只问当前回合角色自己的技能：能跳过的只有自己的阶段，这是规则。
 */
export function beginPhaseEntry(host: PhaseEngineHost): void {
  host.state.phaseEntry = { phase: host.state.phase, askedSkillIds: [] }
  continuePhaseEntry(host)
}

export function continuePhaseEntry(host: PhaseEngineHost): void {
  const entry = host.state.phaseEntry
  if (!entry) return
  // 阶段状态机已经往前走了（技能自己调了 advancePhase），这份窗口作废
  if (entry.phase !== host.state.phase) {
    host.state.phaseEntry = null
    return
  }

  const playerId = host.state.currentPlayerId
  const current = host.state.players.find((player) => player.id === playerId)
  if (current?.alive) {
    for (const runtime of skillsOf(host.state, playerId, skillIdsOf)) {
      if (!runtime.offerPhaseSkip) continue
      if (entry.askedSkillIds.includes(runtime.id)) continue
      entry.askedSkillIds.push(runtime.id)
      // 技能发出了可序列化 Request，阶段暂不开始；玩家回答后由技能调回来
      if (runtime.offerPhaseSkip(host, playerId, entry.phase)) return
      // 技能在这一步里就把阶段跳掉了，不用再问剩下的
      if (host.state.skippedPhases.includes(entry.phase)) break
    }
  }

  host.state.phaseEntry = null
  if (host.state.skippedPhases.includes(entry.phase)) {
    // 被跳过的阶段不发 PhaseStart、不跑阶段内容，直接进入下一个阶段
    advanceGamePhase(host)
    return
  }
  // 这两句合起来就是重构前 advancePhase + enterCurrentPhase 的原样行为，
  // 顺序和无条件性都不能改：阶段技能靠 PhaseStart 触发，阶段内容靠
  // enterCurrentPhase 里各自的 JudgePhase / DrawPhase / PlayPhase / DiscardPhase 事件。
  host.dispatch('PhaseStart', { playerId, phase: entry.phase })
  enterCurrentPhase(host)
}

export function advanceGamePhase(host: PhaseEngineHost): void {
  const entered = advancePhase(host.state, (name, payload) => { host.dispatch(name, payload) })
  // 翻面跳过整个回合：停在 finish，不发 PhaseStart 也不跑阶段内容
  if (!entered) return
  beginPhaseEntry(host)
}

/** TurnEnd 技能结清后开始下一回合，并进入新的准备阶段公共窗口。 */
export function continueTurnTransition(host: PhaseEngineHost): void {
  const entered = resumeTurnTransition(host.state, (name, payload) => { host.dispatch(name, payload) })
  if (entered) beginPhaseEntry(host)
}

export function resolveDiscardPhaseResponse(host: PhaseEngineHost, request: ChooseCardsRequest, response: GameResponse): void {
  if (host.state.phase !== 'discard' || host.state.currentPlayerId !== request.playerId) throw new Error('弃牌阶段 Request 已经过期')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const selected = (response.payload as { cardIds: string[] }).cardIds
  const owner = host.state.players.find((player) => player.id === request.playerId)!
  if (selected.some((cardId) => !owner.zones.hand.includes(cardId))) throw new Error('弃置牌不属于当前玩家')
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  for (const cardId of selected) moveCard(host.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
  const ledger = host.state.discardPhaseLedger
  if (ledger?.ownerPlayerId === owner.id) {
    host.dispatch('CardMove', {
      cardIds: selected, sourcePlayerId: owner.id, originalZone: 'hand', destinationZone: 'discardPile',
      reason: 'discard', phaseInstanceId: ledger.phaseInstanceId,
    }, { sourceId: owner.id, cardIds: selected, phase: 'discard' })
  }
  host.dispatch('LoseCard', { playerId: owner.id, cardIds: selected, reason: 'discard-phase' }, { sourceId: owner.id, cardIds: selected, phase: 'discard' })
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })
}
