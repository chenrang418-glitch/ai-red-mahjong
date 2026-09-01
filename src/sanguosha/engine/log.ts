import type { GameEvent } from './events'
import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 战报。
 *
 * 数据只来自引擎事件，界面不自己猜发生了什么——
 * 猜出来的日志迟早会和真实结算对不上。
 *
 * **按观看者过滤**：只描述公开信息。别人摸到什么牌、暗杠的是什么牌、
 * 判定前的牌堆顺序，这些都不能写进任何人的战报，除非本来就该公开。
 */

export interface LogEntry {
  seq: number
  text: string
}

function nameOf(state: SanguoshaState, playerId: PlayerId | undefined): string {
  if (!playerId) return '某人'
  return state.players.find((player) => player.id === playerId)?.nickname ?? playerId
}

function cardName(state: SanguoshaState, cardId: string | undefined): string {
  if (!cardId) return ''
  return state.cards[cardId]?.name ?? ''
}

const REASON_TEXT: Record<string, string> = { draw: '摸牌', steal: '顺手牵羊', harvest: '五谷丰登' }
const NATURE_TEXT: Record<string, string> = { fire: '火焰', thunder: '雷电', normal: '' }

/**
 * 把一条引擎事件翻译成给 `viewerId` 看的一行战报。
 * 返回 null 表示这条事件对这个观看者不该显示（要么是暗信息，要么没有展示价值）。
 */
export function describeEvent(state: SanguoshaState, event: GameEvent, viewerId: PlayerId): string | null {
  const payload = event.payload as Record<string, unknown>
  const source = nameOf(state, event.sourceId)
  const target = nameOf(state, event.targetId)

  switch (event.name) {
    case 'TurnStart':
      return `—— ${nameOf(state, payload.playerId as PlayerId)} 的回合 ——`

    case 'CardUsed': {
      const name = (payload.cardName as string) || cardName(state, payload.cardId as string)
      if (!name) return null
      const targets = (payload.targetIds as PlayerId[] | undefined) ?? []
      const targetText = targets.filter((id) => id !== event.sourceId).map((id) => nameOf(state, id)).join('、')
      return targetText ? `${source} 对 ${targetText} 使用【${name}】` : `${source} 使用【${name}】`
    }

    case 'CardResponded': {
      const name = (payload.cardName as string) || cardName(state, payload.cardId as string)
      return name ? `${nameOf(state, payload.playerId as PlayerId)} 打出【${name}】` : null
    }

    case 'Damaged': {
      const amount = Number(payload.amount ?? 1)
      const nature = NATURE_TEXT[String(event.damageNature ?? 'normal')] ?? ''
      const from = event.sourceId ? `${source} 对 ` : ''
      return `${from}${target} 造成 ${amount} 点${nature}伤害`
    }

    case 'Recover':
      return `${nameOf(state, (payload.playerId as PlayerId) ?? event.targetId)} 回复 ${Number(payload.amount ?? 1)} 点体力`

    case 'LoseHp':
      return `${nameOf(state, payload.playerId as PlayerId)} 失去 ${Number(payload.amount ?? 1)} 点体力`

    case 'EnterDying':
      return `${nameOf(state, payload.playerId as PlayerId)} 濒死`

    case 'Death': {
      const dead = nameOf(state, payload.playerId as PlayerId)
      // 死亡时身份公开，这时候写出来是合规的
      const identity = payload.identity as string | undefined
      const IDENTITY: Record<string, string> = { lord: '主公', loyalist: '忠臣', rebel: '反贼', renegade: '内奸' }
      return identity ? `${dead} 阵亡（${IDENTITY[identity] ?? identity}）` : `${dead} 阵亡`
    }

    case 'JudgeResult': {
      // 判定牌是翻开的公开信息
      const judged = cardName(state, payload.judgeCardId as string)
      const owner = nameOf(state, (payload.playerId as PlayerId) ?? event.targetId)
      const reason = (payload.reason as string) || cardName(state, payload.delayedCardId as string)
      return judged ? `${owner} 判定${reason ? `【${reason}】` : ''}翻出【${judged}】` : null
    }

    case 'GainCard': {
      // 摸到什么牌只有自己能看见；别人只知道「摸了几张」
      const gainer = (payload.playerId as PlayerId) ?? event.targetId
      const ids = (payload.cardIds as CardId[] | undefined) ?? (payload.cardId ? [payload.cardId as CardId] : [])
      if (ids.length === 0) return null
      const reason = REASON_TEXT[String(payload.reason ?? '')] ?? ''
      const suffix = reason ? `（${reason}）` : ''
      if (gainer !== viewerId) return `${nameOf(state, gainer)} 获得 ${ids.length} 张牌${suffix}`
      const names = ids.map((id) => cardName(state, id)).filter(Boolean)
      return names.length ? `你获得【${names.join('】【')}】${suffix}` : null
    }

    default:
      return null
  }
}
