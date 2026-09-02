import type { LegalAction } from '../actions'
import type { EventContext, GameEvent, GameEventName } from '../events'
import type { GameRng } from '../rng'
import type { CardId, PlayerId, PlayerState, SanguoshaState } from '../types'
import type { SkillHost } from '../skills/runtime'
import { moveCard } from '../zones'

/**
 * 卡牌实现能接触到的最小宿主接口。
 * 抽出来是为了让 basic.ts 和 tricks.ts 共用同一套底座，而不是互相 import 造成环。
 */
export interface CardEngineHost extends SkillHost {
  state: SanguoshaState
  rng: GameRng
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

export function playerOf(state: SanguoshaState, playerId: PlayerId): PlayerState {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

export function useAction(cardId: CardId, playerId: PlayerId, name: string, targetIds: PlayerId[], label: string, targetMode?: 'fixed'): LegalAction {
  return {
    id: `play:${cardId}:${targetIds.join(',') || 'self'}`,
    kind: 'use-card',
    playerId,
    label,
    cardIds: [cardId],
    targetIds,
    targetMin: targetIds.length,
    targetMax: targetIds.length,
    asCardName: name,
    targetMode,
  }
}

/**
 * 别人手牌的占位槽标识。
 *
 * 拆桥/顺手牵羊要让使用者从目标手牌里挑一张，但手牌是暗的。
 * 客户端只拿到「第几张」这种不含牌面信息的槽位，真实 cardId 只在服务端解析——
 * 槽位里绝不能带上牌名、花色或点数，否则就等于把手牌发出去了。
 */
export function hiddenHandSlot(playerId: PlayerId, index: number): string {
  return `hidden:${playerId}:${index}`
}

/** 把牌推进处理区并派发使用时机；BeforeCardUse 被取消时返回 false。 */
export function beginPhysicalCard(host: CardEngineHost, sourceId: PlayerId, cardId: CardId, targetIds: PlayerId[]): boolean {
  moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'processingArea' })
  const card = host.state.cards[cardId]
  const metadata = { sourceId, targetId: targetIds[0], cardIds: [cardId] }
  const before = host.dispatch('BeforeCardUse', { cardId, cardName: card.name, targetIds }, metadata)
  if (before.cancelled) {
    finishPhysicalCard(host, sourceId, cardId, targetIds, true)
    return false
  }
  host.dispatch('CardUsed', { cardId, cardName: card.name, targetIds }, metadata)
  host.dispatch('TargetSpecified', { cardId, cardName: card.name, targetIds }, metadata)
  for (const targetId of targetIds) {
    host.dispatch('TargetConfirmed', { cardId, cardName: card.name, targetId }, { sourceId, targetId, cardIds: [cardId] })
  }
  return true
}

/** 结算收束：牌还在处理区就送进弃牌堆，然后派发结束时机。 */
export function finishPhysicalCard(host: CardEngineHost, sourceId: PlayerId, cardId: CardId, targetIds: PlayerId[], cancelled = false): void {
  const card = host.state.cards[cardId]
  if (card?.virtual) {
    host.state.zones.processingArea = host.state.zones.processingArea.filter((id) => id !== cardId)
    delete host.state.cards[cardId]
  } else if (host.state.zones.processingArea.includes(cardId)) {
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }
  const metadata = { sourceId, targetId: targetIds[0], cardIds: [cardId] }
  const payload = { cardId, cardName: card.name, targetIds, cancelled, virtual: Boolean(card.virtual), sourceSkillId: card.sourceSkillId }
  host.dispatch('CardResolved', payload, metadata)
  host.dispatch('AfterCardUse', payload, metadata)
}
