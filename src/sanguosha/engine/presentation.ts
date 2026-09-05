import type { GameEvent } from './events'
import { delayedTrickHits } from './delayed-trick-rules'
import type { DamageNature, PlayerId, SanguoshaState, Suit } from './types'
import { displayCharacterName, ALL_CHARACTERS } from '../data/characters/standard'

export type PresentationEventKind =
  | 'game-start'
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
  /**
   * 判定是为哪张延时锦囊做的（乐不思蜀 / 兵粮寸断 / 闪电）。
   * 普通技能判定没有这个字段。
   */
  judgeReason?: string
  /**
   * 这张延时锦囊有没有真的生效。
   *
   * 牌**放进判定区**时不该播它的效果音——那时候还什么都没发生；
   * 只有判定真正命中（乐不思蜀跳过出牌、兵粮寸断跳过摸牌、闪电劈中）
   * 才播。所以表现层需要这一位，不能只看「有一次判定」。
   */
  judgeHit?: boolean
  text: string
}

const SUIT_SYMBOL: Record<Suit, string> = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' }
/** A / J / Q / K 在牌面上不是数字，判定条件又常常按点数区间写（闪电 2~9）。 */
const RANK_LABEL: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }

function judgeFace(suit: Suit | undefined, rank: number | undefined): string {
  if (!suit) return ''
  return `${SUIT_SYMBOL[suit] ?? ''}${rank ? RANK_LABEL[rank] ?? String(rank) : ''}`
}

/**
 * 装备的主动效果不在武将技能表里，查不到名字就会把 `equip:zhangba`
 * 这样的内部 id 直接甩到界面上，所以单独登记一份。
 */
const EQUIPMENT_SKILL_NAMES: Record<string, string> = {
  'equip:zhangba': '丈八蛇矛',
  'equip:fangtian': '方天画戟',
  'equip:cixiongjian': '雌雄双股剑',
  'equip:guanshifu': '贯石斧',
  'equip:hanbingjian': '寒冰剑',
  'equip:qilingong': '麒麟弓',
  'equip:qinglongdao': '青龙偃月刀',
}

/**
 * 技能的展示名。引擎内部只有 skillId，战报和舞台要的是中文名。
 * 放在这里而不是 game.ts，是因为出牌流程（cards/basic.ts）也要用同一份翻译。
 */
export function skillDisplayName(skillId: string): string {
  return EQUIPMENT_SKILL_NAMES[skillId]
    ?? ALL_CHARACTERS.flatMap((character) => character.skills)
      .find((skill) => skill.id === skillId)?.name
    ?? skillId
}

function playerName(state: SanguoshaState, playerId?: PlayerId): string {
  if (!playerId) return '某角色'
  return displayCharacterName(state.players, playerId)
}

function cardName(state: SanguoshaState, cardId?: string): string {
  return cardId ? state.cards[cardId]?.name ?? '' : ''
}

/**
 * 将引擎公开事件翻译为单机、联机共用的结构化表现事件。
 *
 * 这里只读公开字段（谁对谁、牌名、技能名、数值），不看观察者：
 * 摸牌只给张数不给牌名，身份和他人手牌一概不进来。
 * 所以结果对所有人相同，联机侧存一份即可，不必按人复制。
 */
export function buildPresentationEvent(
  state: SanguoshaState,
  event: GameEvent,
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
      // 技能可以自带一句战报文本。默认那句「A对B发动【X】」在认亲、
      // 收手、爆仓这类场合读起来不对，但也不值得给每个武将在这里写一个分支
      const custom = typeof payload.logText === 'string' && payload.logText ? payload.logText : null
      const text = custom ?? (targets ? `${source}对${targets}发动【${skillName}】` : `${source}发动【${skillName}】`)
      return { id: event.id, seq: event.seq, kind: 'skill', sourceId, targetIds, skillName, text }
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
    case 'CardMove': {
      // 同上：只表现公开展示
      if (payload.revealed !== true) return null
      const ids = (payload.cardIds as string[] | undefined) ?? []
      if (ids.length === 0) return null
      const actorId = (payload.playerId as PlayerId) ?? event.targetId
      const shown = cardName(state, ids[0])
      return {
        id: event.id, seq: event.seq, kind: 'status',
        targetIds: actorId ? [actorId] : [], cardName: shown,
        text: `${actorId ? playerName(state, actorId) : ''}展示【${shown}】`,
      }
    }

    case 'CharacterFlip': {
      const actorId = (payload.playerId as PlayerId) ?? event.targetId
      if (!actorId) return null
      const faceDown = payload.faceDown === true
      return {
        id: event.id, seq: event.seq, kind: 'status', targetIds: [actorId],
        text: `${playerName(state, actorId)}武将牌翻至${faceDown ? '背面' : '正面'}`,
      }
    }
    case 'CharacterChained': {
      const actorId = (payload.playerId as PlayerId) ?? event.targetId
      if (!actorId) return null
      return {
        id: event.id, seq: event.seq, kind: 'status', targetIds: [actorId],
        text: `${playerName(state, actorId)}${payload.chained === true ? '进入横置状态' : '解除横置'}`,
      }
    }

    /*
     * 开局音靠这条事件触发，而不是靠「表格挂载时还没有历史事件」去猜。
     * 那个猜法是错的：牌局开起来时引擎已经产生了若干条事件，
     * 表格挂载时 `presentationEvents` 根本不是空的，开局音永远不会响。
     *
     * 也不能用 `GameStart`——它在构造函数里发，外部监听器还没挂上。
     * 重连回到打了一半的牌局时，这条事件早已滚出保留窗口，不会重放。
     */
    case 'PlayBegin':
      return { id: event.id, seq: event.seq, kind: 'game-start', text: '牌局开始' }

    case 'JudgeResult': {
      const actorId = (payload.playerId as PlayerId) ?? event.targetId
      const judged = cardName(state, payload.judgeCardId as string)
      const reason = String(payload.reason ?? cardName(state, payload.delayedCardId as string))
      // 判定看的是花色和点数，不是牌名——只报「判定【桃】」等于没报。
      // 花色由事件携带（技能可能改判、也可能改花色），这里不回头读印刷花色。
      const face = judgeFace(payload.suit as Suit | undefined, payload.rank as number | undefined)
      const result = judged ? `【${judged}】${face}` : '完成'
      const suit = payload.suit as Suit | undefined
      const rank = payload.rank as number | undefined
      const judgeHit = suit !== undefined && rank !== undefined ? delayedTrickHits(reason, suit, rank) : undefined
      return {
        id: event.id, seq: event.seq, kind: 'judge', targetIds: actorId ? [actorId] : [], cardName: judged,
        judgeReason: reason || undefined, judgeHit,
        text: `${playerName(state, actorId)}判定${reason ? `【${reason}】` : ''}：${result}`,
      }
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
