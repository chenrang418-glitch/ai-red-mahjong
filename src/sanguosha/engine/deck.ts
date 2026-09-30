import type { GameEventName } from './events'
import type { GameRng } from './rng'
import type { CardId, SanguoshaState } from './types'

/**
 * 牌堆的公共操作：重洗、按点数搜索、按点数和搜索。
 *
 * 三件事以前散在各处，各写各的：
 *
 * 1. **重洗**在摸牌、亮牌、判定、周泰【不屈】、几个娱乐将里各内联了一份。
 *    六份代码做同一件事，谁都不留痕迹——于是「这个回合牌堆洗过牌吗」
 *    只能靠猜（比如看牌堆还剩几张），而那是猜不准的。
 * 2. **按点数找牌**此前没有公共入口。
 * 3. **按点数和凑一组牌**同上。
 *
 * 这里把它们收成一处。重洗会留下可序列化的痕迹，谁都能问「这个回合洗过没有」。
 */

/** 一次重洗留下的痕迹。 */
export interface DeckReshuffleState {
  /** 本局一共洗过几次。 */
  count: number
  /**
   * 最后一次洗牌发生在哪个回合（`state.turnNumber`，即 TurnInstance 序号）。
   *
   * 记回合序号而不是布尔：额外回合也各有自己的序号，
   * 「这个回合洗过牌吗」在插队的额外回合里同样问得准。
   */
  lastTurnNumber: number | null
}

export function deckReshuffleState(state: SanguoshaState): DeckReshuffleState {
  state.deckReshuffle ??= { count: 0, lastTurnNumber: null }
  return state.deckReshuffle
}

/**
 * 这个回合（当前 TurnInstance）牌堆洗过牌吗。
 *
 * **一个回合里洗了几次不影响这个答案**：它是个布尔性质的事实，
 * 洗两次也不会让依赖它的技能多得到一次机会。
 */
export function deckReshuffledThisTurn(state: SanguoshaState): boolean {
  return deckReshuffleState(state).lastTurnNumber === state.turnNumber
}

/**
 * 把弃牌堆洗回牌堆，**这是唯一入口**。
 *
 * 返回洗回去多少张；弃牌堆是空的就返回 0 并且什么都不做——
 * 那不算一次洗牌，也不该留下痕迹。
 */
export function reshuffleDrawPile(
  state: SanguoshaState,
  rng: GameRng,
  emit?: (name: GameEventName, payload: Record<string, unknown>) => void,
): number {
  if (state.zones.discardPile.length === 0) return 0
  const count = state.zones.discardPile.length
  state.zones.drawPile.push(...rng.shuffle(state.zones.discardPile))
  state.zones.discardPile.length = 0
  const record = deckReshuffleState(state)
  record.count += 1
  record.lastTurnNumber = state.turnNumber
  emit?.('DeckReshuffled', { count, turnNumber: state.turnNumber, total: record.count })
  return count
}

/** 将牌堆与弃牌堆合并后整体洗匀；供明确要求“洗牌”的技能使用。 */
export function shuffleDrawAndDiscardPiles(
  state: SanguoshaState,
  rng: GameRng,
  emit?: (name: GameEventName, payload: Record<string, unknown>) => void,
): number {
  const count = state.zones.drawPile.length + state.zones.discardPile.length
  if (count === 0) return 0
  state.zones.drawPile = rng.shuffle([...state.zones.drawPile, ...state.zones.discardPile])
  state.zones.discardPile = []
  const record = deckReshuffleState(state)
  record.count += 1
  record.lastTurnNumber = state.turnNumber
  emit?.('DeckReshuffled', { count, turnNumber: state.turnNumber, total: record.count, reason: 'full-shuffle' })
  return count
}

/**
 * 一张牌在规则里的点数。
 *
 * 统一从这里取，技能不要自己读 `card.rank`：
 *
 * - **虚拟牌没有点数**（技能凭空生成的【杀】、【闪】），返回 null；
 * - **转化牌看的是实体牌的点数**：关羽把一张♥K 当【杀】用，那张【杀】的点数就是 K，
 *   因为桌上真正在动的是那张♥K；
 * - **多张实体牌合成的转化牌没有单一点数**，返回 null——
 *   随手取第一张子牌的点数是错的，那个「第一张」只是数组顺序。
 */
export function ruleCardNumber(state: SanguoshaState, cardId: CardId): number | null {
  const card = state.cards[cardId]
  if (!card) return null
  if (card.virtual) return null
  return card.rank
}

/** 牌堆里点数为 `rank` 的牌，按牌堆自上而下的顺序。 */
export function drawPileCardsWithRank(state: SanguoshaState, rank: number): CardId[] {
  return state.zones.drawPile.filter((cardId) => state.cards[cardId]?.rank === rank)
}

/**
 * 从牌堆里凑一组点数之和**恰好**等于 `target` 的牌。
 *
 * 凑不出来就返回 null——**不返回「最接近的一组」**：调用方要的是恰好，
 * 差一点的那组在规则上根本不成立。
 *
 * 算法是按点数分桶的有界背包，不是 2^N 枚举：牌堆常有一百多张，
 * 枚举会直接把 Worker 卡死。点数只有 1~13 十三种，桶数固定；
 * `dp[sum]` 记录凑出这个和时最后用掉的是哪一档点数、用了几张，
 * 复杂度是 O(13 × target × 每档张数)，和牌堆大小成线性。
 *
 * 选到具体是哪几张实体牌时用牌局自己的随机源，同一个种子必然选出同一组。
 */
export function findCardsSummingTo(
  state: SanguoshaState,
  rng: GameRng,
  target: number,
): CardId[] | null {
  if (!Number.isInteger(target) || target <= 0) return null
  /** 每一档点数在牌堆里有哪些牌。 */
  const buckets = new Map<number, CardId[]>()
  for (const cardId of state.zones.drawPile) {
    const rank = state.cards[cardId]?.rank
    if (typeof rank !== 'number' || rank <= 0) continue
    buckets.set(rank, [...(buckets.get(rank) ?? []), cardId])
  }
  const ranks = [...buckets.keys()].sort((left, right) => left - right)
  if (ranks.length === 0) return null

  /*
   * `plan[sum]` = 凑出 `sum` 的一种方案：每一档点数各用几张。
   * 只保留每个 sum 的第一种方案就够了——要的是「存在一组」，不是「所有组」。
   */
  const plan = new Array<Map<number, number> | null>(target + 1).fill(null)
  plan[0] = new Map()
  for (const rank of ranks) {
    const available = buckets.get(rank)!.length
    for (let sum = target; sum >= 1; sum -= 1) {
      if (plan[sum]) continue
      // 这一档最多用 available 张，且不能超过 sum
      const maxUse = Math.min(available, Math.floor(sum / rank))
      for (let use = 1; use <= maxUse; use += 1) {
        const rest = plan[sum - rank * use]
        if (!rest || (rest.get(rank) ?? 0) > 0) continue
        const next = new Map(rest)
        next.set(rank, use)
        plan[sum] = next
        break
      }
    }
  }
  const chosen = plan[target]
  if (!chosen) return null

  const picked: CardId[] = []
  for (const [rank, use] of [...chosen].sort((left, right) => left[0] - right[0])) {
    // 同一档里挑哪几张用牌局的随机源定，可复现
    const pool = rng.shuffle([...buckets.get(rank)!])
    picked.push(...pool.slice(0, use))
  }
  return picked
}
