import { Tile, TileSuit, Meld } from '@/types'

export interface Deduction {
  ruleId: string
  description: string
  confidence: number // 0-1
  safeTiles: Tile[] // 推测出的安全牌
}

export interface DiscardReadingResult {
  missingSuits: TileSuit[]
  hoardedSuits: TileSuit[]
  advice: string
  deductions: Deduction[]
}

/**
 * 读牌算法：基于经线逻辑（对手的弃牌顺序）推测安全牌和对手意图
 * @param discards 对手打出的牌（按顺序排列，来自 river）
 * @param melds 对手的副露
 * @param round 当前巡数
 */
export function analyzeOpponentHand(
  discards: Tile[],
  _melds: Meld[],
  _round: number
): DiscardReadingResult {
  const result: DiscardReadingResult = {
    missingSuits: [],
    hoardedSuits: [],
    advice: '',
    deductions: []
  }

  if (discards.length === 0) {
    result.advice = '暂无出牌记录'
    return result
  }

  const suits = [TileSuit.DOT, TileSuit.BAMBOO, TileSuit.CHARACTER]
  const discardCounts: Record<string, number> = { 
    [TileSuit.DOT]: 0, 
    [TileSuit.BAMBOO]: 0, 
    [TileSuit.CHARACTER]: 0,
    [TileSuit.RED_ZHONG]: 0
  }
  
  for (const t of discards) {
    if (t.suit !== TileSuit.RED_ZHONG) discardCounts[t.suit as string]++
  }

  // E1. 缺一门与清一色(囤积)判定
  for (const suit of suits) {
    // 超过5张牌未出过该花色，极大概率在做该花色清一色（囤积）
    if (discards.length >= 5 && discardCounts[suit] === 0) {
      result.hoardedSuits.push(suit)
      result.deductions.push({
        ruleId: 'E1',
        description: `多轮未出${suitToName(suit)}，极大概率在做该花色清一色`,
        confidence: 0.6 + Math.min((discards.length - 5) * 0.05, 0.3),
        safeTiles: [] 
      })
    } else if (discardCounts[suit] >= 4 || (discards.length >= 5 && discardCounts[suit] / discards.length >= 0.5)) {
      // 如果某花色丢得特别多，说明是缺门（不要这门）
      result.missingSuits.push(suit)
    }
  }

  // 分析出牌序列
  for (const suit of suits) {
    const suitDiscards = discards.map((t, index) => ({ t, index })).filter(x => x.t.suit === suit)
    if (suitDiscards.length < 2) {
      // 检查早出规则
      if (suitDiscards.length === 1 && suitDiscards[0].index < 3 && suitDiscards[0].t.number === 5) {
        // B4: 第1~2轮出5
        result.deductions.push({
          ruleId: 'B4',
          description: `早期弃 5${suitToName(suit)}，该花色大概率只有孤张`,
          confidence: 0.8,
          safeTiles: []
        })
      }
      continue
    }

    // 两两比较寻找经线逻辑
    for (let i = 0; i < suitDiscards.length - 1; i++) {
      for (let j = i + 1; j < suitDiscards.length; j++) {
        const n1 = suitDiscards[i].t.number
        const n2 = suitDiscards[j].t.number
        const idx2 = suitDiscards[j].index
        if (!n1 || !n2) continue

        // 时间衰减 (如果在前4轮内发生，置信度高)
        let decay = 1.0
        if (idx2 >= 4) decay = 0.8
        if (idx2 >= 8) decay = 0.6

        // A1. 先弃1、再弃2 -> 3安全
        if (n1 === 1 && n2 === 2) {
          result.deductions.push({
            ruleId: 'A1',
            description: `先弃1后弃2，推测 3 相对安全`,
            confidence: 0.75 * decay,
            safeTiles: [createTile(suit, 3)]
          })
        }
        // A2. 先弃9、再弃8 -> 7安全
        if (n1 === 9 && n2 === 8) {
          result.deductions.push({
            ruleId: 'A2',
            description: `先弃9后弃8，推测 7 相对安全`,
            confidence: 0.75 * decay,
            safeTiles: [createTile(suit, 7)]
          })
        }
        // A5. 先弃4、后弃7 -> 1,4,7线安全
        if (n1 === 4 && n2 === 7) {
          result.deductions.push({
            ruleId: 'A5',
            description: `先弃4后弃7，1-4-7线被放弃`,
            confidence: 0.6 * decay,
            safeTiles: [createTile(suit, 1), createTile(suit, 4), createTile(suit, 7)]
          })
        }
        // A6. 先弃6、后弃3 -> 3-6-9线安全
        if (n1 === 6 && n2 === 3) {
          result.deductions.push({
            ruleId: 'A6',
            description: `先弃6后弃3，3-6-9线被放弃`,
            confidence: 0.6 * decay,
            safeTiles: [createTile(suit, 3), createTile(suit, 6), createTile(suit, 9)]
          })
        }
        // C2. 拆坎张 (2-4, 3-5, 4-6, 5-7, 6-8) -> 中间牌安全
        if (Math.abs(n1 - n2) === 2) {
          const mid = Math.min(n1, n2) + 1
          result.deductions.push({
            ruleId: 'C2',
            description: `拆 ${Math.min(n1, n2)}-${Math.max(n1, n2)} 坎张，推测 ${mid} 安全`,
            confidence: 0.65 * decay,
            safeTiles: [createTile(suit, mid)]
          })
        }
        // C3. 拆两面搭 (3-4, 4-5, etc.) -> 可能已听牌
        if (Math.abs(n1 - n2) === 1 && Math.min(n1, n2) >= 2 && Math.max(n1, n2) <= 8) {
          // 拆中张的两面搭是非常强的听牌信号
          result.deductions.push({
            ruleId: 'C3',
            description: `拆两面搭 ${Math.min(n1, n2)}-${Math.max(n1, n2)}，出现更好听牌选择，极度危险！`,
            confidence: 0.8 * decay,
            safeTiles: []
          })
        }
      }
    }
  }

  // 置信度去重合并 (如果多条规则推导出同一张牌安全，合并显示并取最高置信度)
  // ... 暂时简化为仅按置信度排序
  result.deductions.sort((a, b) => b.confidence - a.confidence)

  // 基础 Advice 兜底
  if (result.missingSuits.length > 0) {
    const missingNames = result.missingSuits.map(suitToName).join('、')
    result.advice = `对手大概率不需要 ${missingNames}，相关牌可能较安全。`
  } else if (result.deductions.length === 0) {
    result.advice = '出牌较为均衡，无明显逻辑倾向。'
  }

  return result
}

function suitToName(suit: TileSuit): string {
  switch (suit) {
    case TileSuit.DOT: return '筒'
    case TileSuit.BAMBOO: return '条'
    case TileSuit.CHARACTER: return '万'
    default: return '未知'
  }
}

function createTile(suit: TileSuit, number: number): Tile {
  return { id: `sim_${suit}_${number}`, suit, number }
}
