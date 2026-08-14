import { checkWin } from './win'
import { countFaces, faceKey, sameFace, tileFromFace } from './tiles'
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

type CoreStrategy = 'fast' | 'closed' | 'no-zhong'
type StrategyWeights = Record<CoreStrategy, number>
const CORE_STRATEGIES: CoreStrategy[] = ['fast', 'closed', 'no-zhong']

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

function handSignature(hand: Tile[]): string {
  return [...countFaces(hand).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([face, count]) => `${face}:${count}`)
    .join('|')
}

function waitingValue(hand: Tile[], melds: Meld[], visible: Map<string, number>, cache?: Map<string, number>): number {
  const signature = handSignature(hand)
  const cached = cache?.get(signature)
  if (cached !== undefined) return cached
  let value = 0
  for (const face of ALL_FACES) {
    const remaining = Math.max(0, 4 - (visible.get(face) ?? 0))
    if (remaining === 0) continue
    if (checkWin([...hand, tileFromFace(face)], melds).won) value += remaining
  }
  cache?.set(signature, value)
  return value
}

function strategyShapeValue(hand: Tile[], melds: Meld[], strategy: CoreStrategy): number {
  const counts = countFaces(hand)
  const red = counts.get('zhong') ?? 0
  const meldValue = strategy === 'fast' ? 22 : strategy === 'closed' ? 3 : 14
  const redValue = strategy === 'no-zhong' ? 5 : 14
  let value = melds.length * meldValue + red * redValue
  for (const [face, count] of counts) {
    if (face === 'zhong') continue
    if (count >= 3) value += strategy === 'fast' ? 22 : 18
    else if (count === 2) value += 9
  }
  for (const suit of ['wan', 'dot', 'bamboo']) {
    for (let rank = 1; rank <= 9; rank += 1) {
      const count = counts.get(`${suit}-${rank}`) ?? 0
      if (count === 0) continue
      if ((counts.get(`${suit}-${rank + 1}`) ?? 0) > 0) value += 4
      if ((counts.get(`${suit}-${rank + 2}`) ?? 0) > 0) value += 2
    }
  }
  if (melds.length === 0) {
    const naturalPairs = [...counts.entries()].filter(([face, count]) => face !== 'zhong' && count >= 2).length
    const singletons = [...counts.entries()].filter(([face, count]) => face !== 'zhong' && count % 2 === 1).length
    const sevenPairsProgress = naturalPairs * 8 + Math.min(red, singletons) * 6
    value += sevenPairsProgress * (strategy === 'closed' ? 1.55 : strategy === 'fast' ? 0.45 : 0.65)
  }
  return value
}

function deterministicUnit(key: string): number {
  let hash = 2166136261
  for (const char of key) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

function deterministicNoise(key: string, scale: number): number {
  return (deterministicUnit(key) - 0.5) * scale
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

  const ranked = CORE_STRATEGIES
    .map((strategy) => ({ strategy, score: strategyShapeValue(observation.hand, observation.melds, strategy) }))
    .sort((left, right) => right.score - left.score)
  const mistakeRate = { beginner: 0.1, standard: 0.06, expert: 0.02 }[profile.difficulty]
  const decisionKey = `${observation.playerId}-${observation.round}-${handSignature(observation.hand)}`
  let selectedIndex = 0
  if (deterministicUnit(`${decisionKey}-mistake`) < mistakeRate) {
    selectedIndex = 1 + Math.floor(deterministicUnit(`${decisionKey}-wrong`) * (ranked.length - 1))
  }
  const selected = ranked[selectedIndex].strategy
  return {
    fast: selected === 'fast' ? 1 : 0,
    closed: selected === 'closed' ? 1 : 0,
    'no-zhong': selected === 'no-zhong' ? 1 : 0,
  }
}

function shapeValue(hand: Tile[], melds: Meld[], weights: StrategyWeights): number {
  return CORE_STRATEGIES.reduce(
    (total, strategy) => total + strategyShapeValue(hand, melds, strategy) * weights[strategy],
    0,
  )
}

function relevantDrawFaces(hand: Tile[]): string[] {
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

function expertFutureValue(
  hand: Tile[],
  melds: Meld[],
  visible: Map<string, number>,
  weights: StrategyWeights,
  waitingCache: Map<string, number>,
): number {
  let weighted = 0
  let total = 0
  for (const face of relevantDrawFaces(hand)) {
    const remaining = Math.max(0, 4 - (visible.get(face) ?? 0))
    if (remaining === 0) continue
    const drawn = [...hand, tileFromFace(face)]
    let best = -Infinity
    const candidates = new Map(drawn.map((tile) => [faceKey(tile), tile]))
    for (const tile of candidates.values()) {
      const index = drawn.findIndex((candidate) => candidate.id === tile.id)
      const afterDiscard = drawn.filter((_, candidateIndex) => candidateIndex !== index)
      const score = waitingValue(afterDiscard, melds, visible, waitingCache) * 32 + shapeValue(afterDiscard, melds, weights)
      if (score > best) best = score
    }
    weighted += best * remaining
    total += remaining
  }
  return total > 0 ? weighted / total : 0
}

export function decideTurn(observation: AIObservation, profile: AIProfile): AITurnDecision {
  if (observation.canWin) return { action: 'win' }

  const weights = strategyWeights(observation, profile)
  if (weights.closed < 0.75 && observation.buGangFaces.length > 0) return { action: 'bu-gang', face: observation.buGangFaces[0] }
  if (weights.closed < 0.75 && observation.anGangFaces.length > 0) return { action: 'an-gang', face: observation.anGangFaces[0] }

  const visible = visibleCounts(observation)
  const waitingCache = new Map<string, number>()
  const candidates: Array<{ tile: Tile; hand: Tile[]; waiting: number; score: number }> = []
  for (let index = 0; index < observation.hand.length; index += 1) {
    const tile = observation.hand[index]
    const hand = observation.hand.filter((_, candidateIndex) => candidateIndex !== index)
    let score = shapeValue(hand, observation.melds, weights)
    const waiting = waitingValue(hand, observation.melds, visible, waitingCache)
    score += waiting * (profile.difficulty === 'beginner' ? 18 : 42)
    if (tile.suit === 'zhong') {
      const discardRedValue = weights['no-zhong'] * 14 + (1 - weights['no-zhong']) * -22
      if (waiting > 0 || score > 50) score += discardRedValue
      else score += Math.min(-4, discardRedValue)
    }
    if (profile.personality === 'humanlike' || profile.difficulty === 'beginner') {
      const noiseScale = profile.personality === 'humanlike' ? 18 : 22
      score += deterministicNoise(`${tile.id}-${observation.round}`, noiseScale)
    }
    candidates.push({ tile, hand, waiting, score })
  }

  if (profile.difficulty === 'expert') {
    const futureByFace = new Map<string, number>()
    const promising = [...candidates]
      .filter((candidate) => candidate.waiting === 0)
      .sort((left, right) => right.score - left.score)
    for (const candidate of promising) {
      const face = faceKey(candidate.tile)
      if (futureByFace.has(face)) continue
      futureByFace.set(face, expertFutureValue(candidate.hand, observation.melds, visible, weights, waitingCache))
      if (futureByFace.size >= 5) break
    }
    for (const candidate of candidates) candidate.score += (futureByFace.get(faceKey(candidate.tile)) ?? 0) * 0.22
  }

  const best = candidates.reduce((current, candidate) => candidate.score > current.score ? candidate : current)
  return { action: 'discard', tileId: best.tile.id }
}

function claimDelay(profile: AIProfile, salt: number): number {
  const [min, max] = AI_SPEED_DELAY_RANGES[profile.speed]
  const ratio = Math.abs(Math.sin(salt * 12.9898))
  return Math.round(min + (max - min) * ratio)
}

export function decideClaim(
  observation: AIObservation,
  profile: AIProfile,
  salt: number,
): AIClaimDecision {
  const delayMs = claimDelay(profile, salt)
  const weights = strategyWeights(observation, profile)
  if (observation.legalClaims.includes('ming-gang')) {
    return { action: weights.closed >= 0.75 ? 'pass' : 'ming-gang', delayMs }
  }
  if (!observation.legalClaims.includes('peng') || !observation.lastDiscard) return { action: 'pass', delayMs }

  const counts = countFaces(observation.hand)
  const pairs = [...counts.entries()].filter(([face, count]) => face !== 'zhong' && count >= 2).length
  const sevenPairsLikely = observation.melds.length === 0 && pairs >= 4
  let threshold = weights.fast * 0.18 + weights.closed * 0.82 + weights['no-zhong'] * 0.58
  if (sevenPairsLikely) threshold += weights.closed * 0.3 + (1 - weights.closed) * 0.16
  if (profile.difficulty === 'expert' && observation.wallCount < 16) threshold += 0.12
  const face = faceKey(observation.lastDiscard.tile)
  const faceSeed = [...face].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const decisionValue = Math.abs(Math.sin((salt + faceSeed) * 0.017))
  return { action: decisionValue > threshold ? 'peng' : 'pass', delayMs }
}

export function removeClaimTiles(hand: Tile[], claimed: Tile, count: number): Tile[] {
  const result = [...hand]
  for (let removed = 0; removed < count; removed += 1) {
    const index = result.findIndex((tile) => sameFace(tile, claimed))
    if (index >= 0) result.splice(index, 1)
  }
  return result
}
