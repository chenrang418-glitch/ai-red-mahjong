// ============================================================
// 有效进张分析：找出所有能降低向听数的牌
// Phase 1: 纯摸牌视角（摸到哪张牌能降低向听数）
// Phase 2: 打-摸联动（打出哪张 → 摸到哪张最优）
// ============================================================

import {
  Tile, TileSuit, Meld, DeckState,
  EffectiveDraw, EffectiveDrawResult,
  FormedCombination,
  DiscardAnalysis, DiscardRecommendation,
  OpponentContext
} from '@/types'
import { calculateShantenFast } from './shanten'

// ===================== Phase 1: 纯摸牌有效进张 =====================

/**
 * 分析当前手牌的有效进张
 * @param hand 手牌（不含副露中的牌）
 * @param melds 已完成的副露
 * @param deck 当前牌堆状态（用于计算剩余张数）
 * @param playerHand 完整手牌（含手牌中的重复，用于排除已持有的牌）
 */
export function analyzeEffectiveDraws(
  hand: Tile[],
  melds: Meld[] = [],
  deck?: DeckState,
  oppContext: OpponentContext[] = []
): EffectiveDrawResult {
  // 当前向听数
  const currentShanten = calculateShantenFast(hand, melds)

  // 如果已胡牌，没有有效进张
  if (currentShanten <= -1) {
    return {
      currentShanten,
      effectiveDraws: [],
      totalEffectiveCount: 0,
      acceptanceRate: 0,
    }
  }

  const effectiveDraws: EffectiveDraw[] = []

  // 遍历所有可能的牌种类（27种普通牌 + 红中）
  const allTileTypes = getAllTileTypes()

  for (const candidateTile of allTileTypes) {
    // 计算这张牌在牌堆中还剩几张
    const remaining = deck
      ? countInDeck(deck, candidateTile)
      : estimateRemaining(hand, melds, candidateTile)

    if (remaining <= 0) continue

    // 模拟摸到这张牌后的手牌
    const newHand = [...hand, candidateTile]
    const shantenAfter = calculateShantenFast(newHand, melds)
    const reduction = currentShanten - shantenAfter

    // 有效进张 = 摸到后向听数降低
    if (reduction > 0) {
      // 计算权重（经线逻辑）
      let weight = 1.0
      for (const opp of oppContext) {
        if (opp.safeTiles.some(t => t.suit === candidateTile.suit && t.number === candidateTile.number)) {
          weight += 0.5
        }
        if (opp.missingSuits.includes(candidateTile.suit)) {
          weight += 0.3
        }
        if (opp.hoardedSuits.includes(candidateTile.suit)) {
          weight -= 0.8
        }
      }
      weight = Math.max(0.1, weight) // 权重不能为负
      const adjustedCount = remaining * weight
      const isGolden = weight >= 1.2

      // 分析形成的组合（用于UI展示）
      const formedCombinations = analyzeFormedCombinations(hand, candidateTile, melds)

      effectiveDraws.push({
        tile: candidateTile,
        remainingCount: remaining,
        shantenAfter,
        shantenReduction: reduction,
        formedCombinations,
        weight,
        adjustedCount,
        isGolden,
      })
    }
  }

  // 按优先级排序：向听数降低最多 → 加权张数最多 → 真实剩余张数最多
  effectiveDraws.sort((a, b) => {
    if (a.shantenReduction !== b.shantenReduction) return b.shantenReduction - a.shantenReduction
    if (a.adjustedCount !== b.adjustedCount) return (b.adjustedCount || 0) - (a.adjustedCount || 0)
    return b.remainingCount - a.remainingCount
  })

  // 这里的总数可以是加权后的，也可以是原本的，这里我们使用加权数（展示给策略参考）
  const totalEffectiveCount = effectiveDraws.reduce((sum, d) => sum + (d.adjustedCount || d.remainingCount), 0)
  const deckRemaining = deck ? deck.remainingCount : 112 - hand.length - melds.length * 3

  return {
    currentShanten,
    effectiveDraws,
    totalEffectiveCount,
    acceptanceRate: deckRemaining > 0 ? totalEffectiveCount / deckRemaining : 0,
  }
}

// ===================== Phase 2: 打-摸联动 =====================

/**
 * 打-摸联动分析：对14张手牌，分析打出每张牌后的有效进张
 * 适用于摸牌后需要出牌的阶段
 * @param hand 手牌（14张，刚摸完牌）
 * @param melds 已完成的副露
 * @param deck 当前牌堆状态
 */
export function analyzeDiscardOptions(
  hand: Tile[],
  melds: Meld[] = [],
  deck?: DeckState,
  oppContext: OpponentContext[] = []
): DiscardRecommendation {
  const currentShanten = calculateShantenFast(hand, melds)

  // 去重：相同花色+数字的牌只分析一次
  const seen = new Set<string>()
  const options: DiscardAnalysis[] = []

  for (let i = 0; i < hand.length; i++) {
    const discard = hand[i]
    // 不打红中（红中是万能牌，通常不打）
    // 但仍然允许，只是排序时会排后面
    const key = `${discard.suit}_${discard.number}`
    if (seen.has(key)) continue
    seen.add(key)

    // 打出后的手牌
    const handAfterDiscard = [...hand.slice(0, i), ...hand.slice(i + 1)]
    const shantenAfter = calculateShantenFast(handAfterDiscard, melds)

    // 只分析不升高向听数的打法（打出后向听数 <= 当前向听数）
    // 允许向听数不变的打法（横移）
    if (shantenAfter > currentShanten) continue

    // 分析打出后的有效进张
    const drawResult = analyzeEffectiveDraws(handAfterDiscard, melds, deck, oppContext)

    // 分析打牌安全性与“上碰加速”
    let safetyScore = 0
    let feedUpperScore = 0
    for (const opp of oppContext) {
      // 安全牌奖励
      if (opp.safeTiles.some(t => t.suit === discard.suit && t.number === discard.number)) {
        safetyScore += 2
      } else if (opp.missingSuits.includes(discard.suit)) {
        safetyScore += 1
      }
      
      // 囤积牌惩罚 / 喂上家奖励
      if (opp.hoardedSuits.includes(discard.suit)) {
        if (opp.seatRelation === 'upper') {
          feedUpperScore += 5 // 极度推荐喂给上家
        } else {
          safetyScore -= 3 // 不能打给对家和下家
        }
      }
    }

    // 只有在当前接近听牌(<=1) 或 牌极其烂(>=3)且早巡时（这里由于无法获取早巡信息，粗略只判断向听数），推荐上碰加速
    const isUpperFeed = feedUpperScore > 0 && (currentShanten <= 1 || currentShanten >= 3)

    options.push({
      discard,
      shantenAfter: drawResult.currentShanten,
      effectiveDraws: drawResult.effectiveDraws,
      effectiveCount: drawResult.totalEffectiveCount, // 这里用的是加权后的总数
      acceptanceRate: drawResult.acceptanceRate,
      safetyScore,
      feedUpperScore,
      isUpperFeed,
    })
  }

  // 排序：向听数最低 → 有效进张(加权)最多 → 上碰加速最高 → 安全分最高
  options.sort((a, b) => {
    if (a.shantenAfter !== b.shantenAfter) return a.shantenAfter - b.shantenAfter
    // 允许容忍进张数的微小劣势来换取上家碰牌机会（例如相差不到 1 张）
    const countDiff = b.effectiveCount - a.effectiveCount
    if (a.isUpperFeed && !b.isUpperFeed && countDiff <= 2.0) return -1
    if (!a.isUpperFeed && b.isUpperFeed && countDiff >= -2.0) return 1

    if (Math.abs(countDiff) > 0.01) return countDiff
    
    // 如果进张差不多，看安全性
    const safeDiff = (b.safetyScore || 0) - (a.safetyScore || 0)
    if (safeDiff !== 0) return safeDiff

    return b.acceptanceRate - a.acceptanceRate
  })

  return {
    options,
    bestDiscard: options[0] || {
      discard: hand[0],
      shantenAfter: currentShanten,
      effectiveDraws: [],
      effectiveCount: 0,
      acceptanceRate: 0,
    },
  }
}

// ===================== 辅助函数 =====================

/** 生成所有牌种类（27种普通牌 + 红中） */
function getAllTileTypes(): Tile[] {
  const types: Tile[] = []
  for (const suit of [TileSuit.DOT, TileSuit.BAMBOO, TileSuit.CHARACTER]) {
    for (let n = 1; n <= 9; n++) {
      types.push({ suit, number: n, id: `eff_${suit}_${n}` })
    }
  }
  types.push({ suit: TileSuit.RED_ZHONG, number: null, id: 'eff_rz' })
  return types
}

/** 计算某张牌在牌堆中的实际剩余数 */
function countInDeck(deck: DeckState, tile: Tile): number {
  return deck.tiles.filter(t => t.suit === tile.suit && t.number === tile.number).length
}

/** 估算某张牌在牌堆中的剩余数（无牌堆信息时用） */
function estimateRemaining(hand: Tile[], melds: Meld[], tile: Tile): number {
  const total = 4 // 每种牌4张
  // 手牌中已有的数量
  const inHand = hand.filter(t => t.suit === tile.suit && t.number === tile.number).length
  // 副露中已有的数量（考虑红中杠只算1张）
  let inMelds = 0
  for (const m of melds) {
    if (m.tile.suit === tile.suit && m.tile.number === tile.number) {
      if (m.type === 'red_zhong_gang') {
        inMelds += 1
      } else if (m.type === 'pong') {
        inMelds += 3
      } else if (m.type === 'exposed_gang' || m.type === 'concealed_gang') {
        inMelds += 4
      }
    }
  }
  return Math.max(0, total - inHand - inMelds)
}

/**
 * 分析摸到某张牌后形成的组合（用于UI展示进张效果）
 * 找出摸到的牌与手牌中哪些牌形成了新的面子/搭子
 */
function analyzeFormedCombinations(
  hand: Tile[],
  drawn: Tile,
  _melds: Meld[],
): FormedCombination[] {
  const combinations: FormedCombination[] = []

  // 红中是万能牌，标记特殊
  if (drawn.suit === TileSuit.RED_ZHONG) {
    combinations.push({
      type: 'pair',
      tiles: [drawn],
      drawnTileId: drawn.id,
    })
    return combinations
  }

  const suit = drawn.suit
  const num = drawn.number!

  // 检查是否能形成刻子（手牌中已有2张相同）
  const sameCount = hand.filter(t => t.suit === suit && t.number === num).length
  if (sameCount >= 2) {
    const sameTiles = hand.filter(t => t.suit === suit && t.number === num).slice(0, 2)
    combinations.push({
      type: 'triplet',
      tiles: [...sameTiles, drawn],
      drawnTileId: drawn.id,
    })
  }

  // 检查是否能形成对子（手牌中已有1张相同）
  if (sameCount >= 1) {
    const sameTile = hand.find(t => t.suit === suit && t.number === num)!
    combinations.push({
      type: 'pair',
      tiles: [sameTile, drawn],
      drawnTileId: drawn.id,
    })
  }

  // 检查是否能形成顺子
  {
    // num-2, num-1, num
    if (num >= 3) {
      const t1 = hand.find(t => t.suit === suit && t.number === num - 2)
      const t2 = hand.find(t => t.suit === suit && t.number === num - 1)
      if (t1 && t2) {
        combinations.push({
          type: 'sequence',
          tiles: [t1, t2, drawn],
          drawnTileId: drawn.id,
        })
      }
    }
    // num-1, num, num+1
    if (num >= 2 && num <= 8) {
      const t1 = hand.find(t => t.suit === suit && t.number === num - 1)
      const t2 = hand.find(t => t.suit === suit && t.number === num + 1)
      if (t1 && t2) {
        combinations.push({
          type: 'sequence',
          tiles: [t1, drawn, t2],
          drawnTileId: drawn.id,
        })
      }
    }
    // num, num+1, num+2
    if (num <= 7) {
      const t1 = hand.find(t => t.suit === suit && t.number === num + 1)
      const t2 = hand.find(t => t.suit === suit && t.number === num + 2)
      if (t1 && t2) {
        combinations.push({
          type: 'sequence',
          tiles: [drawn, t1, t2],
          drawnTileId: drawn.id,
        })
      }
    }
  }

  return combinations
}
