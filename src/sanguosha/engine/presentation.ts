import type { GameEvent } from './events'
import type { DamageNature, PlayerId, SanguoshaState } from './types'

export type PresentationEventKind =
  | 'turn-start' | 'card-use' | 'card-response' | 'skill' | 'damage' | 'recover'
  | 'lose-hp' | 'dying' | 'death' | 'judge' | 'draw' | 'discard' | 'equipment' | 'status'

/**
 * 客户端表现所消费的公开事件。它不参与结算，也不包含暗置身份、他人手牌或牌堆顺序。
 */
export interface PresentationEvent {
  id: string
  seq: number
  kind: PresentationEventKind
  sourceId?: PlayerId
  targetIds?: PlayerId[]
  cardName?: string
  skillName?: string
  amount?: number
  nature?: DamageNature
  text: string
}

function playerName(state: SanguoshaState, playerId?: PlayerId): string {
  if (!playerId) return '某角色'
  return state.players.find((player) => player.id === playerId)?.nickname ?? playerId
}

function cardName(state: SanguoshaState, cardId?: string): string {
  return cardId ? state.cards[cardId]?.name ?? '' : ''
}

/** 将引擎公开事件翻译为单机、联机共用的结构化表现事件。 */
export function buildPresentationEvent(
  state: SanguoshaState,
  event: GameEvent,
  _viewerId: PlayerId,
): PresentationEvent | null {
  const payload = event.payload as Record<string, unknown>
  const sourceId = event.sourceId ?? payload.sourceId as PlayerId | undefined
  const targetId = event.targetId ?? payload.playerId as PlayerId | undefined
  const source = playerName(state, sourceId)
  const target = playerName(state, targetId)

  switch (event.name) {
    case 'TurnStart': {
      const actorId = payload.playerId as PlayerId
      return { id: event.id, seq: event.seq, kind: 'turn-start', sourceId: actorId, text: `${playerName(state, actorId)}的回合` }
    }
    case 'CardUsed': {
      const name = String(payload.cardName ?? cardName(state, payload.cardId as string))
      const targetIds = (payload.targetIds as PlayerId[] | undefined) ?? (event.targetId ? [event.targetId] : [])
      const targets = targetIds.filter((id) => id !== sourceId).map((id) => playerName(state, id)).join('、')
      return {
        id: event.id, seq: event.seq, kind: 'card-use', sourceId, targetIds, cardName: name,
        text: targets ? `${source}对${targets}使用【${name}】` : `${source}使用【${name}】`,
      }
    }
    case 'CardResponded': {
      const actorId = payload.playerId as PlayerId
      const name = String(payload.cardName ?? cardName(state, payload.cardId as string))
      if (!name) return null
      return { id: event.id, seq: event.seq, kind: 'card-response', sourceId: actorId, cardName: name, text: `${playerName(state, actorId)}打出【${name}】` }
    }
    case 'SkillActivated': {
      const skillName = String(payload.skillName ?? payload.skillId ?? '')
      const targetIds = (payload.targetIds as PlayerId[] | undefined) ?? []
      const targets = targetIds.map((id) => playerName(state, id)).join('、')
      return { id: event.id, seq: event.seq, kind: 'skill', sourceId, targetIds, skillName, text: targets ? `${source}对${targets}发动【${skillName}】` : `${source}发动【${skillName}】` }
    }
    case 'Damaged': {
      const amount = Number(payload.amount ?? 1)
      const nature = event.damageNature ?? 'normal'
      const natureText = nature === 'fire' ? '火焰' : nature === 'thunder' ? '雷电' : ''
      return { id: event.id, seq: event.seq, kind: 'damage', sourceId, targetIds: targetId ? [targetId] : [], amount, nature, text: `${target}受到${amount}点${natureText}伤害` }
    }
    case 'Recover': {
      const actorId = (payload.playerId as PlayerId) ?? event.targetId
      const amount = Number(payload.amount ?? 1)
      return { id: event.id, seq: event.seq, kind: 'recover', sourceId, targetIds: actorId ? [actorId] : [], amount, text: `${playerName(state, actorId)}回复${amount}点体力` }
    }
    case 'LoseHp': {
      const actorId = payload.playerId as PlayerId
      const amount = Number(payload.amount ?? 1)
      return { id: event.id, seq: event.seq, kind: 'lose-hp', targetIds: [actorId], amount, text: `${playerName(state, actorId)}失去${amount}点体力` }
    }
    case 'EnterDying': {
      const actorId = payload.playerId as PlayerId
      return { id: event.id, seq: event.seq, kind: 'dying', targetIds: [actorId], text: `${playerName(state, actorId)}进入濒死` }
    }
    case 'Death': {
      const actorId = payload.playerId as PlayerId
      return { id: event.id, seq: event.seq, kind: 'death', targetIds: [actorId], text: `${playerName(state, actorId)}阵亡` }
    }
    case 'JudgeResult': {
      const actorId = (payload.playerId as PlayerId) ?? event.targetId
      const judged = cardName(state, payload.judgeCardId as string)
      const reason = String(payload.reason ?? cardName(state, payload.delayedCardId as string))
      return { id: event.id, seq: event.seq, kind: 'judge', targetIds: actorId ? [actorId] : [], cardName: judged, text: `${playerName(state, actorId)}判定${reason ? `【${reason}】` : ''}：${judged ? `【${judged}】` : '完成'}` }
    }
    case 'GainCard': {
      const actorId = (payload.playerId as PlayerId) ?? event.targetId
      const count = (payload.cardIds as string[] | undefined)?.length ?? (payload.cardId ? 1 : 0)
      if (!actorId || !count) return null
      return { id: event.id, seq: event.seq, kind: 'draw', targetIds: [actorId], amount: count, text: `${playerName(state, actorId)}获得${count}张牌` }
    }
    case 'LoseEquipment': {
      const name = cardName(state, payload.cardId as string)
      return { id: event.id, seq: event.seq, kind: 'equipment', sourceId, targetIds: targetId ? [targetId] : [], cardName: name, text: `${target}失去装备${name ? `【${name}】` : ''}` }
    }
    default:
      return null
  }
}
