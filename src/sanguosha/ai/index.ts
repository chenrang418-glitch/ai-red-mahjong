import type { LegalAction } from '../engine/actions'
import type { GameRequest, GameResponse } from '../engine/requests'
import { assertNever } from '../engine/requests'
import type { GameRng } from '../engine/rng'
import type { PlayerId } from '../engine/types'
import type { PlayerView } from '../engine/view'
import { isLikelyEnemy, type SuspicionMap } from './belief'

/**
 * 单机 AI。
 *
 * 铁律：**只读 PlayerView 和 LegalAction，不碰 SanguoshaState。**
 * 未公开身份和别人的手牌在 PlayerView 里本来就是 null / 占位牌，
 * 所以「困难 AI 偷看身份」这种作弊在类型层面就做不到。
 *
 * 另一条硬要求：`respond` 必须对每一种 Request 都给出合法响应。
 * 漏掉任何一种，无头压测就会死锁在那个请求上——
 * 这正是压测要抓的问题，所以这里用 assertNever 强制穷尽。
 */

export type AIDifficulty = 'easy' | 'normal' | 'hard'

export interface AIContext {
  view: PlayerView
  difficulty: AIDifficulty
  rng: GameRng
  suspicion: SuspicionMap
}

/** 牌的粗略价值：越高越舍不得弃。 */
export function cardValue(name: string): number {
  switch (name) {
    case '桃': return 10
    case '无懈可击': return 8
    case '闪': return 7
    case '酒': return 5
    case '杀': return 4
    default: return 3
  }
}

/** 目标价值：血少、手牌少的更好打。 */
function targetScore(context: AIContext, targetId: PlayerId): number {
  const target = context.view.players.find((player) => player.id === targetId)
  if (!target?.alive) return -Infinity
  let score = 10 - target.hp * 2 - Math.min(target.handCount, 6)
  if (isLikelyEnemy(context.view, context.suspicion, targetId)) score += 12
  // 简单档带一点随机，别每局都一模一样
  if (context.difficulty === 'easy') score += context.rng.nextInt(7)
  else if (context.difficulty === 'normal') score += context.rng.nextInt(4)
  return score
}

function myself(view: PlayerView) {
  return view.players.find((player) => player.id === view.viewerId)!
}

/**
 * 出牌阶段选一个动作。返回 null 表示结束出牌。
 */
export function decidePlayAction(context: AIContext, actions: readonly LegalAction[]): LegalAction | null {
  const useActions = actions.filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
  if (useActions.length === 0) return null

  const me = myself(context.view)
  let best: { action: LegalAction; score: number } | null = null

  for (const action of useActions) {
    let score = 0
    switch (action.asCardName) {
      case '杀':
        // 没有目标价值就别硬打
        score = 6 + Math.max(...action.targetIds.map((targetId) => targetScore(context, targetId)), -Infinity)
        break
      case '桃':
        score = me.hp < me.maxHp ? 30 : -100
        break
      case '无中生有':
        score = 25
        break
      case '桃园结义':
        score = me.hp < me.maxHp ? 22 : 8
        break
      case '顺手牵羊':
      case '过河拆桥':
        score = 18 + Math.max(...action.targetIds.map((targetId) => targetScore(context, targetId)), 0)
        break
      case '南蛮入侵':
      case '万箭齐发': {
        // 群体伤害：自己血少时别乱放，敌人多才划算
        const enemies = action.targetIds.filter((targetId) => isLikelyEnemy(context.view, context.suspicion, targetId)).length
        score = enemies * 6 - (action.targetIds.length - enemies) * 2
        break
      }
      case '决斗':
        score = 10 + Math.max(...action.targetIds.map((targetId) => targetScore(context, targetId)), 0)
        break
      case '酒':
        // 手上没杀就别喝
        score = -50
        break
      default:
        // 装备一律先穿上；其余锦囊给个中性分
        score = action.label.startsWith('装备') ? 20 : 8
    }
    if (context.difficulty !== 'hard') score += context.rng.nextInt(5)
    if (!best || score > best.score) best = { action, score }
  }

  if (!best || best.score <= 0) return null
  return best.action
}

/** 从若干 actionId 里挑一个「打出牌」的，没有就放弃。 */
function preferPlay(actionIds: readonly string[], prefix: string): string | null {
  const playable = actionIds.filter((id) => id.startsWith(prefix))
  return playable.length > 0 ? playable[0] : null
}

/**
 * 对任意 Request 给出合法响应。
 *
 * 每一个分支都必须真的返回一个合法 payload——
 * 返回 null 或漏掉分支会让牌局停在这里，压测就是用来抓这个的。
 */
export function decideResponse(context: AIContext, request: GameRequest): GameResponse {
  const base = { requestId: request.id, playerId: request.playerId }

  switch (request.kind) {
    case 'choose-general':
      return { ...base, payload: { characterId: context.rng.pick(request.candidates) } }

    case 'choose-cards': {
      const pool = [...request.cardIds, ...request.hiddenCardSlots]
      if (request.min === 0 && pool.length === 0) return { ...base, payload: { cardIds: [] } }
      // 弃牌阶段挑价值最低的丢；其余场合挑第一张够用
      const sorted = request.purpose === 'discard-phase'
        ? [...request.cardIds].sort((left, right) => cardValue(cardName(context, left)) - cardValue(cardName(context, right)))
        : pool
      const count = Math.min(Math.max(request.min, 1), request.max, sorted.length)
      return { ...base, payload: { cardIds: sorted.slice(0, count) } }
    }

    case 'choose-targets': {
      const ranked = [...request.candidateIds].sort((left, right) => targetScore(context, right) - targetScore(context, left))
      const count = Math.min(Math.max(request.min, 1), request.max, ranked.length)
      return { ...base, payload: { targetIds: ranked.slice(0, count) } }
    }

    case 'choose-option':
      return { ...base, payload: { optionId: context.rng.pick(request.options).id } }

    case 'choose-suit':
      return { ...base, payload: { suit: context.rng.pick(request.suits) } }

    case 'choose-number':
      return { ...base, payload: { number: request.min } }

    case 'respond-card': {
      // 该出闪就出闪、该出无懈看价值。出不起就放弃。
      const played = preferPlay(request.actionIds, 'respond-dodge:')
        ?? preferPlay(request.actionIds, 'respond-trick:')
        ?? (request.requiredCardName === '无懈可击' ? nullificationChoice(context, request.actionIds) : null)
        ?? (request.actionIds.includes('invoke-bagua') ? 'invoke-bagua' : null)
      return { ...base, payload: { actionId: played ?? 'respond-pass' } }
    }

    case 'use-card':
    case 'invoke-skill': {
      const playable = request.actionIds.filter((id) => id !== 'respond-pass')
      return { ...base, payload: { actionId: playable[0] ?? 'respond-pass' } }
    }

    case 'rescue': {
      // 濒死救援：自己一定救自己，别人看阵营
      const playable = request.actionIds.filter((id) => id !== 'rescue-pass')
      if (playable.length === 0) return { ...base, payload: { actionId: 'rescue-pass' } }
      const savingSelf = request.dyingPlayerId === request.playerId
      const worthSaving = savingSelf || !isLikelyEnemy(context.view, context.suspicion, request.dyingPlayerId)
      return { ...base, payload: { actionId: worthSaving ? playable[0] : 'rescue-pass' } }
    }

    case 'arrange-cards': {
      // 观星类：价值高的留牌堆顶给自己，其余压底
      const ranked = [...request.cardIds].sort((left, right) => cardValue(cardName(context, right)) - cardValue(cardName(context, left)))
      const topCount = Math.min(Math.max(request.minTop, 0), request.maxTop, ranked.length)
      return { ...base, payload: { top: ranked.slice(0, topCount), bottom: request.allowBottom ? ranked.slice(topCount) : [] } }
    }

    case 'distribute-cards': {
      const count = Math.min(Math.max(request.min, 0), request.max, request.cardIds.length)
      const assignments = request.cardIds.slice(0, count).map((cardId, index) => ({
        cardId,
        recipientId: request.recipientIds[index % request.recipientIds.length],
      }))
      return { ...base, payload: { assignments } }
    }

    default:
      return assertNever(request)
  }
}

/** 无懈可击值不值得出：救自己人、拦敌人的锦囊才出。 */
function nullificationChoice(context: AIContext, actionIds: readonly string[]): string | null {
  const playable = actionIds.filter((id) => id.startsWith('respond-nullification:'))
  if (playable.length === 0) return null
  const resolution = context.view.cardResolution
  if (!resolution) return null
  const targetId = resolution.targetIds[0]
  const sourceIsEnemy = isLikelyEnemy(context.view, context.suspicion, resolution.sourceId)
  const targetIsFriend = targetId === context.view.viewerId
    || !isLikelyEnemy(context.view, context.suspicion, targetId)
  // 简单档不做这层判断，随手用
  if (context.difficulty === 'easy') return context.rng.nextInt(2) === 0 ? playable[0] : null
  return sourceIsEnemy && targetIsFriend ? playable[0] : null
}

function cardName(context: AIContext, cardId: string): string {
  const me = myself(context.view)
  const found = me.hand?.find((card) => card.id === cardId)
  return found?.name ?? ''
}
