import { drawCards } from './draw'
import type { ChooseCardsRequest, GameResponse } from './requests'
import { validateResponse } from './requests'
import { advancePhase } from './turn'
import type { PlayerId, SanguoshaState } from './types'
import { moveCard } from './zones'
import { beginJudgmentPhase, type JudgmentEngineHost } from './judgment'
import { fixedMaxCardsOf } from './skills/runtime'

/**
 * 阶段引擎的宿主。
 *
 * 继承 JudgmentEngineHost 而不是自己列三个字段：判定阶段会调 beginJudgmentPhase，
 * 而判定现在可能挂起等改判、结束后还要继续发问，需要完整的 SkillHost 能力。
 */
export type PhaseEngineHost = JudgmentEngineHost

function maxCards(state: SanguoshaState, playerId: PlayerId): number {
  const target = state.players.find((player) => player.id === playerId)
  if (!target) throw new Error(`玩家不存在：${playerId}`)
  return fixedMaxCardsOf(state, playerId) ?? Math.max(0, target.hp)
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

export function advanceGamePhase(host: PhaseEngineHost): void {
  advancePhase(host.state, (name, payload) => { host.dispatch(name, payload) })
  enterCurrentPhase(host)
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
  host.dispatch('LoseCard', { playerId: owner.id, cardIds: selected, reason: 'discard-phase' }, { sourceId: owner.id, cardIds: selected, phase: 'discard' })
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })
}
