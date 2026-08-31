import { countFaces, faceKey, sameFace, tileFromFace } from './tiles'
import { handShanten, normalHandShanten, sevenPairsHandShanten } from './shanten'
import type { AIObservation, AIProfile, ClaimAction, Difficulty, Meld, Tile } from './types'

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

// —— 思考时间 ——
// 没有「速度」这个档位了。想多久由这手牌好不好打决定：
// 一眼就该扔的孤张秒出，听牌、能胡、能杠这些要算账的地方才慢下来。
const THINK_BASE_MS: Record<Difficulty, number> = { beginner: 600, standard: 900, expert: 1200 }
export const THINK_MIN_MS = 420
export const THINK_MAX_MS = 4200

// AI 自己挑路线，不再由玩家指定性格。三条路线对应三种打法。
type Route = 'meld' | 'concealed' | 'ma'

const VIRTUAL_MELD: Meld = { id: 'virtual-meld', type: 'peng', tiles: [] }

// 一次决策里，同一手牌的向听数会被反复求：进张要对三十四种牌各试一遍，
// 候选弃牌之间也大量重合。不缓存的话单步能跑到几百毫秒，联机端直接超预算。
let shantenCache = new Map<string, number>()

function handKey(hand: Tile[], melds: number, route: Route): string {
  const counts = countFaces(hand)
  const parts: string[] = []
  for (const [face, count] of counts) parts.push(`${face}${count}`)
  parts.sort()
  return `${route}|${melds}|${parts.join(',')}`
}

function deterministicUnit(key: string): number {
  let hash = 2166136261
  for (const char of key) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

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

// 菜鸡算不清还剩几张：它只当每种牌都还有满满四张，看不见牌河里已经躺了几张。
function remainingOf(visible: Map<string, number>, face: string, difficulty: Difficulty): number {
  if (difficulty === 'beginner') return 4
  return Math.max(0, 4 - (visible.get(face) ?? 0))
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

function countPairs(hand: Tile[]): number {
  return [...countFaces(hand).entries()].filter(([face, count]) => face !== 'zhong' && count >= 2).length
}

function redCount(hand: Tile[]): number {
  return hand.filter((tile) => tile.suit === 'zhong').length
}

// —— 路线选择 ——
// 一旦副露就回不了门清，这条「已投入成本」天然给路线提供惯性，
// 不用额外存状态，也不会出现这手做七对、下一手改门清的精神分裂。
function chooseRoute(observation: AIObservation, difficulty: Difficulty): Route {
  if (observation.melds.length > 0) return 'meld'
  const hand = observation.hand
  const pairs = countPairs(hand)
  const red = redCount(hand)
  const decisionKey = `${observation.playerId}-${observation.round}-${pairs}-${red}`

  if (difficulty === 'beginner') {
    // 菜鸡不会算向听，只会数对子，而且经常改主意
    const slip = deterministicUnit(`${decisionKey}-route`)
    if (slip < 0.35) return slip < 0.18 ? 'ma' : pairs >= 4 ? 'meld' : 'concealed'
    return pairs >= 4 ? 'concealed' : 'meld'
  }

  const normal = normalHandShanten(hand, [])
  const seven = sevenPairsHandShanten(hand)
  const scores: Record<Route, number> = {
    meld: -normal * 10,
    concealed: -Math.min(normal, seven) * 10 + pairs * 1.2,
    ma: -normal * 10 - red * 6,
  }
  if (difficulty === 'expert') {
    // 无红中胡能多抓两张码，按码牌占比折算约两分；只有手上红中不多、
    // 牌型又快成了的时候，这笔账才划算。
    if (red <= 1 && normal <= 1) scores.ma += 7
    // 门清留着做杠的可能，杠分即时结算且流局也保留，是不胡也能拿的分
    if (pairs >= 3) scores.concealed += 2
  }
  const ranked = (Object.keys(scores) as Route[]).sort((left, right) => scores[right] - scores[left])
  const mistakeRate = difficulty === 'standard' ? 0.1 : 0.02
  return deterministicUnit(`${decisionKey}-pick`) < mistakeRate ? ranked[1] : ranked[0]
}

// 不同路线用不同的尺子量进度：门清盯七对，其余按普通胡算。
function routeShanten(hand: Tile[], melds: Meld[], route: Route): number {
  const key = handKey(hand, melds.length, route)
  const cached = shantenCache.get(key)
  if (cached !== undefined) return cached
  const normal = normalHandShanten(hand, melds)
  const value = melds.length > 0 || route !== 'concealed'
    ? normal
    : Math.min(sevenPairsHandShanten(hand), normal + 1)
  shantenCache.set(key, value)
  return value
}

// 有效进张：还能摸到多少张让进度往前一步。菜鸡只看手牌附近，也不扣已见牌。
function ukeire(
  hand: Tile[],
  melds: Meld[],
  route: Route,
  visible: Map<string, number>,
  faces: string[],
  difficulty: Difficulty,
): number {
  const base = routeShanten(hand, melds, route)
  let total = 0
  for (const face of faces) {
    const remaining = remainingOf(visible, face, difficulty)
    if (remaining === 0) continue
    if (routeShanten([...hand, tileFromFace(face)], melds, route) < base) total += remaining
  }
  return total
}

// 猿神独有：听牌之后要比「这张听能胡几张」，听八张和听两张不是一回事。
function winningTiles(hand: Tile[], melds: Meld[], visible: Map<string, number>): number {
  let total = 0
  for (const face of ALL_FACES) {
    const remaining = Math.max(0, 4 - (visible.get(face) ?? 0))
    if (remaining === 0) continue
    if (routeShanten([...hand, tileFromFace(face)], melds, 'meld') < 0) total += remaining
  }
  return total
}

// 猿神独有的一步前瞻：一向听时不只看「能进多少张」，还要看进张之后能听多宽。
// 同样是一向听，进完能听八张和只能听两张，价值差很远——凡人看不到这一层。
function tenpaiOutlook(
  hand: Tile[],
  melds: Meld[],
  visible: Map<string, number>,
  faces: string[],
): number {
  const draws = faces
    .map((face) => ({ face, remaining: Math.max(0, 4 - (visible.get(face) ?? 0)) }))
    .filter((entry) => entry.remaining > 0)
    .sort((left, right) => right.remaining - left.remaining)
    .slice(0, 5)
  let weighted = 0
  let total = 0
  for (const { face, remaining } of draws) {
    const drawn = [...hand, tileFromFace(face)]
    if (routeShanten(drawn, melds, 'meld') > 0) continue
    let best = 0
    for (const tile of uniqueByFace(drawn).slice(0, 6)) {
      const next = removeOneFace(drawn, faceKey(tile))
      if (routeShanten(next, melds, 'meld') > 0) continue
      best = Math.max(best, winningTiles(next, melds, visible))
    }
    weighted += best * remaining
    total += remaining
  }
  return total > 0 ? weighted / total : 0
}

// 猿神独有：牌墙见底还差好几步时，抢胡的期望已经很低，守住杠分和流局更实在。
function endgamePressure(observation: AIObservation, shanten: number): number {
  const wall = observation.wallCount
  if (wall > 24) return 0
  const drawsLeft = Math.floor(wall / 4)
  if (shanten <= drawsLeft) return 0
  return Math.min(3, shanten - drawsLeft)
}

function keepValue(hand: Tile[], route: Route, difficulty: Difficulty): number {
  const counts = countFaces(hand)
  const red = counts.get('zhong') ?? 0
  let value = red * (route === 'ma' ? -5 : 12)
  for (const [face, count] of counts) {
    if (face === 'zhong') continue
    const rank = Number(face.split('-')[1])
    if (count >= 2) value += route === 'concealed' ? 6 : 3
    if (difficulty !== 'beginner' && rank >= 3 && rank <= 7) value += 1
  }
  return value
}

// 猿神独有：别人亮了两副以上还喂他能碰能杠的牌，等于帮他提速。
function claimRisk(face: string, observation: AIObservation, visible: Map<string, number>): number {
  if (face === 'zhong') return 0
  const unseen = Math.max(0, 4 - (visible.get(face) ?? 0))
  if (unseen < 2) return 0
  const suit = face.split('-')[0]
  let risk = 0
  for (const player of observation.players) {
    if (player.id === observation.playerId || player.melds.length < 2) continue
    risk += player.melds.filter((meld) => meld.tiles[0]?.suit === suit).length * 2
  }
  return risk * unseen
}

interface Candidate {
  tile: Tile
  hand: Tile[]
  shanten: number
  ukeire: number
  score: number
}

export function decideTurn(observation: AIObservation, profile: AIProfile): AITurnDecision {
  shantenCache = new Map()
  if (observation.canWin) return { action: 'win' }

  const difficulty = profile.difficulty
  const route = chooseRoute(observation, difficulty)
  const visible = visibleCounts(observation)
  const faces = difficulty === 'beginner' ? relevantFaces(observation.hand) : ALL_FACES

  const gang = chooseGang(observation, route, visible, faces, difficulty)
  if (gang) return gang

  const candidates: Candidate[] = []
  for (const tile of uniqueByFace(observation.hand)) {
    const hand = removeOneFace(observation.hand, faceKey(tile))
    candidates.push({ tile, hand, shanten: routeShanten(hand, observation.melds, route), ukeire: 0, score: 0 })
  }
  if (candidates.length === 0) return { action: 'discard', tileId: observation.hand[0].id }

  const bestShanten = Math.min(...candidates.map((candidate) => candidate.shanten))
  const contenders = candidates.filter((candidate) => candidate.shanten <= bestShanten + 1)
  for (const candidate of contenders) {
    candidate.ukeire = ukeire(candidate.hand, observation.melds, route, visible, faces, difficulty)
  }

  for (const candidate of candidates) {
    let score = -candidate.shanten * 1000 + candidate.ukeire * 12 + keepValue(candidate.hand, route, difficulty)
    if (difficulty === 'expert') {
      score -= Math.min(8, claimRisk(faceKey(candidate.tile), observation, visible) * 0.4)
      // 牌墙见底还差得远，就别再拆搭子硬冲
      score -= endgamePressure(observation, candidate.shanten) * 6
    }
    if (difficulty === 'beginner') {
      score += (deterministicUnit(`${candidate.tile.id}-${observation.round}-${observation.hand.length}`) - 0.5) * 90
    }
    candidate.score = score
  }

  // 一向听时往前多看一步：挑「进完能听得最宽」的走法
  if (difficulty === 'expert' && bestShanten === 1) {
    const near = candidates
      .filter((candidate) => candidate.shanten === 1)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
    for (const candidate of near) {
      candidate.score += tenpaiOutlook(candidate.hand, observation.melds, visible, relevantFaces(candidate.hand)) * 3
    }
  }

  // 猿神独有：听牌之后比的是「这张听能胡几张」，听八张和听两张不是一回事。
  // 只对已经听牌、且分数还在前几名的候选精算，避免每张牌都跑一遍全量。
  if (difficulty === 'expert' && bestShanten <= 0) {
    const tenpai = candidates
      .filter((candidate) => candidate.shanten <= 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 4)
    for (const candidate of tenpai) {
      candidate.score += winningTiles(candidate.hand, observation.melds, visible) * 14
      // 规则给的口子：无红中胡抓六张码、有红中只抓四张。已经听牌了还捏着红中，
      // 等于主动少抓两张——只要打掉它还听得住，这两张码就是白拿的。
      if (faceKey(candidate.tile) === 'zhong') candidate.score += 20
    }
  }

  const ranked = [...candidates].sort((left, right) => right.score - left.score)
  // 菜鸡就是会打错牌：明知道哪张更该走，还是顺手打了另一张。
  if (difficulty === 'beginner' && ranked.length > 1) {
    if (deterministicUnit(`${observation.playerId}-${observation.round}-${observation.hand.length}-slip`) < 0.45) {
      return { action: 'discard', tileId: ranked[1].tile.id }
    }
  }
  return { action: 'discard', tileId: ranked[0].tile.id }
}

// 杠不是白拿分：暗杠拆两个对子、补杠拆将牌。只有杠完进度不倒退才动手。
function chooseGang(
  observation: AIObservation,
  route: Route,
  visible: Map<string, number>,
  faces: string[],
  difficulty: Difficulty,
): AITurnDecision | null {
  if (observation.buGangFaces.length === 0 && observation.anGangFaces.length === 0) return null

  // 菜鸡不算账，有杠就杠
  if (difficulty === 'beginner') {
    if (observation.buGangFaces.length > 0) return { action: 'bu-gang', face: observation.buGangFaces[0] }
    return { action: 'an-gang', face: observation.anGangFaces[0] }
  }

  const baseline = bestProgress(observation.hand, observation.melds, route, visible, faces, difficulty)
  const options: Array<{ decision: AITurnDecision; progress: number }> = []
  for (const face of observation.buGangFaces) {
    const hand = removeOneFace(observation.hand, face)
    options.push({
      decision: { action: 'bu-gang', face },
      progress: progressOf(hand, observation.melds, route, visible, faces, difficulty),
    })
  }
  for (const face of observation.anGangFaces) {
    if (route === 'concealed' && observation.melds.length === 0) continue
    const hand = observation.hand.filter((tile) => faceKey(tile) !== face)
    options.push({
      decision: { action: 'an-gang', face },
      progress: progressOf(hand, [...observation.melds, VIRTUAL_MELD], route, visible, faces, difficulty),
    })
  }
  if (options.length === 0) return null

  const best = options.reduce((current, option) => option.progress > current.progress ? option : current)
  // 猿神把杠分算进账：三家各一分是确定收益，值得为它容忍一点点进度损失
  const tolerance = difficulty === 'expert' ? 4 : 0
  return best.progress + tolerance >= baseline ? best.decision : null
}

function progressOf(
  hand: Tile[],
  melds: Meld[],
  route: Route,
  visible: Map<string, number>,
  faces: string[],
  difficulty: Difficulty,
): number {
  return -routeShanten(hand, melds, route) * 100 + ukeire(hand, melds, route, visible, faces, difficulty) * 0.5
}

function bestProgress(
  hand: Tile[],
  melds: Meld[],
  route: Route,
  visible: Map<string, number>,
  faces: string[],
  difficulty: Difficulty,
): number {
  let best = -Infinity
  for (const tile of uniqueByFace(hand)) {
    best = Math.max(best, progressOf(removeOneFace(hand, faceKey(tile)), melds, route, visible, faces, difficulty))
  }
  return best
}

export function decideClaim(
  observation: AIObservation,
  profile: AIProfile,
  salt: number,
  claimWindowMs = 4000,
): AIClaimDecision {
  shantenCache = new Map()
  const difficulty = profile.difficulty
  const discarded = observation.lastDiscard?.tile
  if (!discarded || observation.legalClaims.length === 0) {
    return { action: 'pass', delayMs: claimDelay(difficulty, 1, salt, claimWindowMs) }
  }

  const route = chooseRoute(observation, difficulty)
  const face = faceKey(discarded)

  // 菜鸡不算进度，凑够三张就想碰
  if (difficulty === 'beginner') {
    const action: ClaimAction = observation.legalClaims.includes('ming-gang') ? 'ming-gang' : 'peng'
    const hesitate = deterministicUnit(`${salt}-${face}-beginner`) < 0.25
    return { action: hesitate ? 'pass' : action, delayMs: claimDelay(difficulty, 0.2, salt, claimWindowMs) }
  }

  // 门清路线上，碰和明杠都会让七对彻底没戏
  if (route === 'concealed' && observation.melds.length === 0) {
    return { action: 'pass', delayMs: claimDelay(difficulty, 0.9, salt, claimWindowMs) }
  }

  const visible = visibleCounts(observation)
  const faces = ALL_FACES
  const current = progressOf(observation.hand, observation.melds, route, visible, faces, difficulty)
  let best: { action: ClaimAction | 'pass'; progress: number } = { action: 'pass', progress: current }

  if (observation.legalClaims.includes('peng')) {
    const hand = removeOneFace(removeOneFace(observation.hand, face), face)
    const progress = bestProgress(hand, [...observation.melds, VIRTUAL_MELD], route, visible, faces, difficulty)
    if (progress > best.progress) best = { action: 'peng', progress }
  }
  if (observation.legalClaims.includes('ming-gang')) {
    const hand = observation.hand.filter((tile) => faceKey(tile) !== face)
    const progress = progressOf(hand, [...observation.melds, VIRTUAL_MELD], route, visible, faces, difficulty) + 20
    if (progress > best.progress) best = { action: 'ming-gang', progress }
  }

  const gain = best.progress - current
  const threshold = route === 'meld' ? -12 : 0
  const decided = best.action !== 'pass' && gain > threshold
  // 明显划算就秒喊，差不多的时候才犹豫一下——这个「清晰度」直接决定反应快慢
  const clarity = clamp(Math.abs(gain) / 60, 0, 1)
  return { action: decided ? best.action : 'pass', delayMs: claimDelay(difficulty, clarity, salt, claimWindowMs) }
}

// 抢牌反应：越拿不定主意越慢，但一定赶在窗口关闭前喊出来。
function claimDelay(difficulty: Difficulty, clarity: number, salt: number, claimWindowMs: number): number {
  const base = { beginner: 0.5, standard: 0.38, expert: 0.3 }[difficulty]
  const hesitation = (1 - clarity) * 0.25
  const jitter = Math.abs(Math.sin(salt * 12.9898)) * 0.12
  const ratio = clamp(base + hesitation + jitter, 0.18, 0.86)
  return Math.min(Math.round(claimWindowMs * ratio), Math.max(0, claimWindowMs - 300))
}

// 出牌前要想多久：一眼就该扔的孤张秒出，听牌和能杠的地方才慢下来。
export function estimateThinkMs(observation: AIObservation, profile: AIProfile, salt: number): number {
  let think = THINK_BASE_MS[profile.difficulty]
  const shanten = handShanten(observation.hand, observation.melds)

  if (shanten <= 0) think += 1500
  else if (shanten === 1) think += 600
  if (observation.canWin) think += 800
  if (observation.anGangFaces.length > 0 || observation.buGangFaces.length > 0) think += 800

  // 手上孤张越多越好打：随手扔一张就行，不用纠结
  const counts = countFaces(observation.hand)
  let isolated = 0
  for (const [face, count] of counts) {
    if (face === 'zhong' || count >= 2) continue
    const [suit, rankText] = face.split('-')
    const rank = Number(rankText)
    const hasNeighbour = [-2, -1, 1, 2].some((offset) => (counts.get(`${suit}-${rank + offset}`) ?? 0) > 0)
    if (!hasNeighbour) isolated += 1
  }
  if (isolated >= 3) think -= 500
  else if (isolated === 0) think += 400

  think += deterministicUnit(`${salt}-${observation.round}-${observation.hand.length}`) * 600
  return Math.round(clamp(think, THINK_MIN_MS, THINK_MAX_MS))
}

export function removeClaimTiles(hand: Tile[], claimed: Tile, count: number): Tile[] {
  const result = [...hand]
  for (let removed = 0; removed < count; removed += 1) {
    const index = result.findIndex((tile) => sameFace(tile, claimed))
    if (index >= 0) result.splice(index, 1)
  }
  return result
}
