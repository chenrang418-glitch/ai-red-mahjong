import { checkWin } from './win'
import { countFaces, faceKey, sameFace, tileFromFace } from './tiles'
import { handShanten, normalHandShanten, sevenPairsHandShanten } from './shanten'
import { claimReactionDelay } from './timing'
import type { AIObservation, AIProfile, ClaimAction, Meld, ThinkingSpeed, Tile } from './types'

export type AITurnDecision =
  | { action: 'win' }
  | { action: 'an-gang' | 'bu-gang'; face: string }
  | { action: 'discard'; tileId: string }

export interface AIClaimDecision {
  action: ClaimAction | 'pass'
  delayMs: number
}

const ALL_FACES = [
  ...['wan', 'dot', 'bamboo'].flatMap((suit) => Array.from({ length: 9 }, (_, index) => `${suit}-${index + 1}`)),
  'zhong',
]

export const AI_SPEED_DELAY_RANGES: Record<ThinkingSpeed, readonly [number, number]> = {
  fast: [1000, 2000],
  normal: [3000, 4000],
  slow: [5000, 6000],
  dreamy: [6000, 7000],
}

// 猿神档的前瞻要有上限：联机时这段计算跑在 Worker 里，不能因为一手复杂牌把房间拖住。
const EXPERT_LOOKAHEAD_BUDGET_MS = 60

type CoreStrategy = 'fast' | 'closed' | 'no-zhong'
type StrategyWeights = Record<CoreStrategy, number>
const CORE_STRATEGIES: CoreStrategy[] = ['fast', 'closed', 'no-zhong']

const VIRTUAL_MELD: Meld = { id: 'virtual-meld', type: 'peng', tiles: [] }

function visibleCounts(observation: AIObservation): Map<string, number> {
  const tiles: Tile[] = [
    ...observation.hand,
    ...observation.players.flatMap((player) => [
      ...player.discards,
      ...player.melds.flatMap((meld) => meld.tiles),
    ]),
  ]
  return countFaces(tiles)
}

function remainingOf(visible: Map<string, number>, face: string): number {
  return Math.max(0, 4 - (visible.get(face) ?? 0))
}

function handSignature(hand: Tile[], melds: number): string {
  return `${melds}|${[...countFaces(hand).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([face, count]) => `${face}:${count}`)
    .join('|')}`
}

function deterministicUnit(key: string): number {
  let hash = 2166136261
  for (const char of key) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

function strategyWeights(observation: AIObservation, profile: AIProfile): StrategyWeights {
  if (profile.personality === 'balanced') return { fast: 1 / 3, closed: 1 / 3, 'no-zhong': 1 / 3 }
  if (profile.personality !== 'humanlike') {
    return {
      fast: profile.personality === 'fast' ? 1 : 0,
      closed: profile.personality === 'closed' ? 1 : 0,
      'no-zhong': profile.personality === 'no-zhong' ? 1 : 0,
    }
  }

  // 真人波动型：按当前牌型挑一条最顺的路线走，偶尔挑错。
  const ranked = CORE_STRATEGIES
    .map((strategy) => ({ strategy, score: routeScore(observation, strategy) }))
    .sort((left, right) => right.score - left.score)
  const mistakeRate = { beginner: 0.16, standard: 0.07, expert: 0.02 }[profile.difficulty]
  const decisionKey = `${observation.playerId}-${observation.round}-${handSignature(observation.hand, observation.melds.length)}`
  const selectedIndex = deterministicUnit(`${decisionKey}-mistake`) < mistakeRate
    ? 1 + Math.floor(deterministicUnit(`${decisionKey}-wrong`) * (ranked.length - 1))
    : 0
  const selected = ranked[selectedIndex].strategy
  return {
    fast: selected === 'fast' ? 1 : 0,
    closed: selected === 'closed' ? 1 : 0,
    'no-zhong': selected === 'no-zhong' ? 1 : 0,
  }
}

// 三条路线各自离胡还有多远，数字越小越顺。
function routeScore(observation: AIObservation, strategy: CoreStrategy): number {
  const hand = observation.hand
  const melds = observation.melds
  const red = hand.filter((tile) => tile.suit === 'zhong').length
  if (strategy === 'closed') return -sevenPairsHandShanten(hand) * 2 - (melds.length === 0 ? 1 : -4)
  if (strategy === 'no-zhong') return -normalHandShanten(hand, melds) * 2 - red
  return -normalHandShanten(hand, melds) * 2 + melds.length
}

// 策略决定用哪把尺子量进度：七对型盯着对子走，快攻型盯着普通胡走，平衡型取两者更快的一条。
function strategyShanten(hand: Tile[], melds: Meld[], weights: StrategyWeights): number {
  if (melds.length > 0) return normalHandShanten(hand, melds)
  const normal = normalHandShanten(hand, melds)
  const pairs = sevenPairsHandShanten(hand)
  if (weights.closed >= 0.75) return Math.min(pairs, normal + 1)
  if (weights.fast >= 0.75) return Math.min(normal, pairs + 1)
  return Math.min(normal, pairs)
}

// 有效进张：还能摸到多少张牌可以让进度往前一步。同样向听下这个数越大越安全。
function ukeire(
  hand: Tile[],
  melds: Meld[],
  weights: StrategyWeights,
  visible: Map<string, number>,
  faces: string[],
): number {
  const base = strategyShanten(hand, melds, weights)
  let total = 0
  for (const face of faces) {
    const remaining = remainingOf(visible, face)
    if (remaining === 0) continue
    if (strategyShanten([...hand, tileFromFace(face)], melds, weights) < base) total += remaining
  }
  return total
}

// 手上留着的牌本身也有价值差别：红中是万能牌，中张比幺九更容易长成搭子。
function tileKeepValue(hand: Tile[], weights: StrategyWeights): number {
  const counts = countFaces(hand)
  const red = counts.get('zhong') ?? 0
  let value = red * (weights['no-zhong'] >= 0.75 ? -6 : 12)
  for (const [face, count] of counts) {
    if (face === 'zhong') continue
    const rank = Number(face.split('-')[1])
    if (count >= 2) value += weights.closed >= 0.75 ? 6 : 3
    value += rank >= 3 && rank <= 7 ? 1 : 0
  }
  return value
}

// 只在猿神档使用：别人已经亮出两副以上时，再喂给他能碰能杠的牌就是在帮他提速。
// 本玩法不点炮，所以门槛设得高一点，避免为了躲一点风险就打出效率明显更差的牌。
function claimRisk(face: string, observation: AIObservation, visible: Map<string, number>): number {
  if (face === 'zhong') return 0
  const unseen = remainingOf(visible, face)
  if (unseen < 2) return 0
  const suit = face.split('-')[0]
  let risk = 0
  for (const player of observation.players) {
    if (player.id === observation.playerId || player.melds.length < 2) continue
    risk += player.melds.filter((meld) => meld.tiles[0]?.suit === suit).length * 2
  }
  return risk * unseen
}

interface DiscardCandidate {
  tile: Tile
  hand: Tile[]
  shanten: number
  ukeire: number
  score: number
}

function uniqueByFace(hand: Tile[]): Tile[] {
  const seen = new Map<string, Tile>()
  for (const tile of hand) if (!seen.has(faceKey(tile))) seen.set(faceKey(tile), tile)
  return [...seen.values()]
}

function removeOneFace(hand: Tile[], face: string): Tile[] {
  const index = hand.findIndex((tile) => faceKey(tile) === face)
  return index < 0 ? [...hand] : [...hand.slice(0, index), ...hand.slice(index + 1)]
}

// 摸一张之后还能走到多好：把有效进张按剩余张数加权平均，用于在同向听同进张时分高下。
function lookaheadValue(
  hand: Tile[],
  melds: Meld[],
  weights: StrategyWeights,
  visible: Map<string, number>,
  faces: string[],
  deadline: number,
): number {
  let weighted = 0
  let total = 0
  for (const face of faces) {
    if (Date.now() > deadline) break
    const remaining = remainingOf(visible, face)
    if (remaining === 0) continue
    const drawn = [...hand, tileFromFace(face)]
    let best = Infinity
    let bestUkeire = 0
    for (const candidate of uniqueByFace(drawn)) {
      const next = removeOneFace(drawn, faceKey(candidate))
      const value = strategyShanten(next, melds, weights)
      if (value > best) continue
      const nextUkeire = ukeire(next, melds, weights, visible, faces)
      // 同样的向听要挑进张最多的那手，否则前瞻会被第一个碰到的打法带偏。
      if (value < best) {
        best = value
        bestUkeire = nextUkeire
      } else bestUkeire = Math.max(bestUkeire, nextUkeire)
    }
    weighted += (-best * 100 + bestUkeire) * remaining
    total += remaining
  }
  return total > 0 ? weighted / total : 0
}

function relevantFaces(hand: Tile[]): string[] {
  const faces = new Set<string>(['zhong'])
  for (const tile of hand) {
    if (tile.suit === 'zhong' || tile.rank === null) continue
    for (let offset = -2; offset <= 2; offset += 1) {
      const rank = tile.rank + offset
      if (rank >= 1 && rank <= 9) faces.add(`${tile.suit}-${rank}`)
    }
  }
  return [...faces]
}

export function decideTurn(observation: AIObservation, profile: AIProfile): AITurnDecision {
  if (observation.canWin) return { action: 'win' }

  const weights = strategyWeights(observation, profile)
  const visible = visibleCounts(observation)
  const faces = profile.difficulty === 'beginner' ? relevantFaces(observation.hand) : ALL_FACES

  const gang = chooseGang(observation, weights, visible, faces)
  if (gang) return gang

  const candidates: DiscardCandidate[] = []
  for (const tile of uniqueByFace(observation.hand)) {
    const hand = removeOneFace(observation.hand, faceKey(tile))
    const shanten = strategyShanten(hand, observation.melds, weights)
    candidates.push({ tile, hand, shanten, ukeire: 0, score: 0 })
  }
  if (candidates.length === 0) return { action: 'discard', tileId: observation.hand[0].id }

  const bestShanten = Math.min(...candidates.map((candidate) => candidate.shanten))
  // 进张只对「进度最好的那几张」细算，避免每张牌都做一遍全量计算。
  const contenders = candidates.filter((candidate) => candidate.shanten <= bestShanten + 1)
  for (const candidate of contenders) {
    candidate.ukeire = ukeire(candidate.hand, observation.melds, weights, visible, faces)
  }

  for (const candidate of candidates) {
    let score = -candidate.shanten * 1000 + candidate.ukeire * 12 + tileKeepValue(candidate.hand, weights)
    if (profile.difficulty === 'expert') score -= Math.min(8, claimRisk(faceKey(candidate.tile), observation, visible) * 0.4)
    if (profile.difficulty === 'beginner' || profile.personality === 'humanlike') {
      const noise = profile.difficulty === 'beginner' ? 90 : 26
      score += (deterministicUnit(`${candidate.tile.id}-${observation.round}-${observation.hand.length}`) - 0.5) * noise
    }
    candidate.score = score
  }

  // 猿神档只在「向听和进张都打平」的候选之间才动用摸牌前瞻决胜。
  // 让前瞻去盖过进张这种主信号，实测反而打得更差。
  if (profile.difficulty === 'expert') {
    const leader = Math.max(...candidates.map((candidate) => candidate.score))
    const tied = candidates.filter((candidate) => leader - candidate.score < 6).slice(0, 3)
    if (tied.length > 1) {
      const deadline = Date.now() + EXPERT_LOOKAHEAD_BUDGET_MS
      const values = tied.map((candidate) => lookaheadValue(candidate.hand, observation.melds, weights, visible, relevantFaces(candidate.hand), deadline))
      const baseline = Math.max(...values)
      tied.forEach((candidate, index) => { candidate.score += (values[index] - baseline) * 0.05 })
    }
  }

  const ranked = [...candidates].sort((left, right) => right.score - left.score)
  // 菜鸡档要真的像新手：有时候明知道哪张更该打，还是会顺手打错一张。
  if (profile.difficulty === 'beginner' && ranked.length > 1) {
    const slip = deterministicUnit(`${observation.playerId}-${observation.round}-${observation.hand.length}-slip`)
    if (slip < 0.34) return { action: 'discard', tileId: ranked[1].tile.id }
  }
  return { action: 'discard', tileId: ranked[0].tile.id }
}

// 杠不是白拿分：暗杠会拆掉两个对子，补杠会拆掉将牌。
// 只有杠完进度不倒退时才杠，否则宁可不要这三分。
function chooseGang(
  observation: AIObservation,
  weights: StrategyWeights,
  visible: Map<string, number>,
  faces: string[],
): AITurnDecision | null {
  if (observation.buGangFaces.length === 0 && observation.anGangFaces.length === 0) return null
  const baseline = bestProgress(observation.hand, observation.melds, weights, visible, faces)

  const options: Array<{ decision: AITurnDecision; progress: number }> = []
  for (const face of observation.buGangFaces) {
    const hand = removeOneFace(observation.hand, face)
    options.push({
      decision: { action: 'bu-gang', face },
      progress: progressOf(hand, observation.melds, weights, visible, faces),
    })
  }
  for (const face of observation.anGangFaces) {
    if (weights.closed >= 0.75 && observation.melds.length === 0) continue
    const hand = observation.hand.filter((tile) => faceKey(tile) !== face)
    options.push({
      decision: { action: 'an-gang', face },
      progress: progressOf(hand, [...observation.melds, VIRTUAL_MELD], weights, visible, faces),
    })
  }
  if (options.length === 0) return null

  const best = options.reduce((current, option) => option.progress > current.progress ? option : current)
  return best.progress >= baseline ? best.decision : null
}

function progressOf(
  hand: Tile[],
  melds: Meld[],
  weights: StrategyWeights,
  visible: Map<string, number>,
  faces: string[],
): number {
  return -strategyShanten(hand, melds, weights) * 100 + ukeire(hand, melds, weights, visible, faces) * 0.5
}

// 当前这手牌打掉最没用的一张之后能达到的最好进度，作为「不动手」的参照。
function bestProgress(
  hand: Tile[],
  melds: Meld[],
  weights: StrategyWeights,
  visible: Map<string, number>,
  faces: string[],
): number {
  let best = -Infinity
  for (const tile of uniqueByFace(hand)) {
    const next = removeOneFace(hand, faceKey(tile))
    best = Math.max(best, progressOf(next, melds, weights, visible, faces))
  }
  return best
}

export function decideClaim(
  observation: AIObservation,
  profile: AIProfile,
  salt: number,
  claimWindowMs = 4000,
): AIClaimDecision {
  const delayMs = claimReactionDelay(profile.speed, salt, claimWindowMs)
  const discarded = observation.lastDiscard?.tile
  if (!discarded || observation.legalClaims.length === 0) return { action: 'pass', delayMs }

  const weights = strategyWeights(observation, profile)
  // 门清做七对的时候，碰和明杠都会让七对彻底没戏。
  if (weights.closed >= 0.75 && observation.melds.length === 0) return { action: 'pass', delayMs }

  const visible = visibleCounts(observation)
  const faces = profile.difficulty === 'beginner' ? relevantFaces(observation.hand) : ALL_FACES
  const face = faceKey(discarded)
  const current = progressOf(observation.hand, observation.melds, weights, visible, faces)

  let best: { action: ClaimAction | 'pass'; progress: number } = { action: 'pass', progress: current }

  if (observation.legalClaims.includes('peng')) {
    const hand = removeOneFace(removeOneFace(observation.hand, face), face)
    const melds = [...observation.melds, VIRTUAL_MELD]
    const progress = bestProgress(hand, melds, weights, visible, faces)
    if (progress > best.progress) best = { action: 'peng', progress }
  }
  if (observation.legalClaims.includes('ming-gang')) {
    const hand = observation.hand.filter((tile) => faceKey(tile) !== face)
    const melds = [...observation.melds, VIRTUAL_MELD]
    // 明杠之后从牌尾补一张再打，进度口径和碰一致。
    const progress = progressOf(hand, melds, weights, visible, faces) + 20
    if (progress > best.progress) best = { action: 'ming-gang', progress }
  }

  if (best.action === 'pass') return { action: 'pass', delayMs }
  // 快攻型愿意为了速度多付一点代价，其余性格要求副露确实能换来进度。
  const threshold = weights.fast >= 0.75 ? -12 : 0
  if (best.progress - current <= threshold) return { action: 'pass', delayMs }
  if (profile.difficulty === 'beginner' && deterministicUnit(`${salt}-${face}-beginner`) < 0.25) {
    return { action: 'pass', delayMs }
  }
  return { action: best.action, delayMs }
}

export function removeClaimTiles(hand: Tile[], claimed: Tile, count: number): Tile[] {
  const result = [...hand]
  for (let removed = 0; removed < count; removed += 1) {
    const index = result.findIndex((tile) => sameFace(tile, claimed))
    if (index >= 0) result.splice(index, 1)
  }
  return result
}

export function handIsWinning(hand: Tile[], melds: Meld[]): boolean {
  return checkWin(hand, melds).won
}

export function handProgress(hand: Tile[], melds: Meld[]): number {
  return handShanten(hand, melds)
}
