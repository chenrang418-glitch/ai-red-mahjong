import type { LegalAction } from '../actions'
import type { EventContext, GameEvent, GameEventName } from '../events'
import type { GameRng } from '../rng'
import type { CardId, PlayerId, PlayerState, SanguoshaState } from '../types'
import { resolvedCardRecipientOf, type SkillHost } from '../skills/runtime'
import { locateOwnedCard, moveCard, type ZoneRef } from '../zones'
import { skillDisplayName } from '../../data/characters/standard'

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
export function beginPhysicalCard(
  host: CardEngineHost,
  sourceId: PlayerId,
  cardId: CardId,
  targetIds: PlayerId[],
  effectiveName?: string,
  from?: ZoneRef,
): boolean {
  const sourceZone = from ?? locateOwnedCard(host.state, sourceId, cardId)
  if (!sourceZone || sourceZone.kind === 'judgingArea') throw new Error('卡牌不属于出牌玩家的手牌区或装备区')
  moveCard(host.state, cardId, sourceZone, { kind: 'processingArea' })
  const card = host.state.cards[cardId]
  const cardName = effectiveName ?? card.name
  const metadata = { sourceId, targetId: targetIds[0], cardIds: [cardId] }
  const before = host.dispatch('BeforeCardUse', { cardId, cardName, targetIds }, metadata)
  if (before.cancelled) {
    finishPhysicalCard(host, sourceId, cardId, targetIds, true, cardName)
    return false
  }
  host.dispatch('CardUsed', { cardId, cardName, targetIds }, metadata)
  /*
   * 使用时机里的技能可能把牌局直接打完。
   *
   * 神吕布【无谋】就能做到：使用非延时锦囊要付代价，没有暴怒时强制失去 1 点体力，
   * 1 血的主公用一张【决斗】就把自己送走了。引擎在牌局结束时会清空待回应请求，
   * 但那之后这张牌的结算还在继续，又发出一个新的求【杀】请求——
   * 牌局已经 game-over 却仍挂着 Request（压测 seed=soak-5-82 抓到）。
   *
   * 这不是某个技能的问题：任何能在使用时机里造成死亡的效果都会踩。
   * 所以在公共入口这里收口：牌局结束就不再往下结算，牌照常收进弃牌堆。
   */
  if (host.state.status !== 'playing') {
    finishPhysicalCard(host, sourceId, cardId, targetIds, true, cardName)
    return false
  }
  host.dispatch('TargetSpecified', { cardId, cardName, targetIds }, metadata)
  for (const targetId of targetIds) {
    host.dispatch('TargetConfirmed', { cardId, cardName, targetId }, { sourceId, targetId, cardIds: [cardId] })
  }
  return true
}

/** 结算收束：牌还在处理区就送进弃牌堆，然后派发结束时机。 */
export function finishPhysicalCard(host: CardEngineHost, sourceId: PlayerId, cardId: CardId, targetIds: PlayerId[], cancelled = false, effectiveName?: string): void {
  const card = host.state.cards[cardId]
  if (!card) return
  const cardName = effectiveName ?? card.name
  const virtual = Boolean(card.virtual)
  const sourceSkillId = card.sourceSkillId
  if (card?.virtual) {
    host.state.zones.processingArea = host.state.zones.processingArea.filter((id) => id !== cardId)
    delete host.state.cards[cardId]
  } else if (host.state.zones.processingArea.includes(cardId)) {
    const recipient = resolvedCardRecipientOf(host.state, { sourceId, cardId, cardName, targetIds, cancelled })
    if (recipient) {
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: recipient.playerId })
      const skillName = skillDisplayName(host.state, recipient.playerId, recipient.skillId)
      host.dispatch('SkillActivated', {
        playerId: recipient.playerId, skillId: recipient.skillId, skillName, result: 'gain-resolved-card', cardName,
        logText: `${playerOf(host.state, recipient.playerId).nickname}发动【${skillName}】，获得【${cardName}】`,
      }, { sourceId: recipient.playerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: recipient.playerId, cardIds: [cardId], reason: recipient.skillId }, { targetId: recipient.playerId, cardIds: [cardId] })
    } else {
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    }
  }
  const metadata = { sourceId, targetId: targetIds[0], cardIds: [cardId] }
  const payload = { cardId, cardName, targetIds, cancelled, virtual, sourceSkillId }
  host.dispatch('CardResolved', payload, metadata)
  host.dispatch('AfterCardUse', payload, metadata)
}
