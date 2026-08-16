import { countFaces } from './tiles'
import type { Meld, Tile } from './types'

// 向听数：距离听牌还差几步。0 表示已经听牌，-1 表示已经可以胡。
// 红中是万能牌，可以顶任何一张，所以拆解时要允许用红中补面子、补搭子、补将。
//
// 之前的 AI 只有「能不能胡」和一套手写的牌型加分，看不出「差两步」和「差三步」的区别，
// 于是会为了眼前的加分拆掉更快的牌型。向听数补上的就是这个尺度。

const SUIT_COUNT = 3
const RANKS = 9
const FACE_SLOTS = SUIT_COUNT * RANKS

function toCounts(tiles: Tile[]): { counts: number[]; red: number } {
  const counts = new Array<number>(FACE_SLOTS).fill(0)
  let red = 0
  for (const tile of tiles) {
    if (tile.suit === 'zhong') {
      red += 1
      continue
    }
    const suitIndex = tile.suit === 'wan' ? 0 : tile.suit === 'dot' ? 1 : 2
    counts[suitIndex * RANKS + (tile.rank ?? 1) - 1] += 1
  }
  return { counts, red }
}

interface SearchState {
  counts: number[]
  red: number
  melds: number
  partials: number
  pairs: number
  best: number
}

function evaluate(state: SearchState, fixedMelds: number): number {
  let melds = Math.min(4, state.melds + fixedMelds)
  let partials = state.partials
  let pairs = state.pairs
  let red = state.red
  // 没被用来补牌的红中可以自己凑：三张一个面子，两张一个对子。
  while (red >= 3 && melds < 4) {
    melds += 1
    red -= 3
  }
  if (red >= 2 && melds + partials < 5) {
    partials += 1
    pairs += 1
    red -= 2
  }
  // 一副牌最多四个面子加一个将，多出来的搭子没有位置放。
  partials = Math.max(0, Math.min(partials, 5 - melds))
  let value = 8 - 2 * melds - partials
  // 凑满五个块却一个对子都没有，说明缺将，还要多一步。
  if (melds + partials === 5 && pairs === 0) value += 1
  return value
}

function search(state: SearchState, index: number, fixedMelds: number): void {
  if (state.melds + fixedMelds + state.partials >= 5 || index >= FACE_SLOTS) {
    state.best = Math.min(state.best, evaluate(state, fixedMelds))
    return
  }
  if (state.counts[index] === 0) {
    search(state, index + 1, fixedMelds)
    return
  }

  // 不用这张牌（当孤张丢掉），保证搜索能覆盖「拆开重组」的可能。
  const skipped = state.counts[index]
  state.counts[index] = 0
  search(state, index + 1, fixedMelds)
  state.counts[index] = skipped

  const rank = index % RANKS
  const canSequence = rank <= RANKS - 3

  // 刻子：自身张数不足时用红中补齐。
  for (let used = Math.min(3, state.counts[index]); used >= 1; used -= 1) {
    const need = 3 - used
    if (need > state.red) continue
    state.counts[index] -= used
    state.red -= need
    state.melds += 1
    search(state, index, fixedMelds)
    state.melds -= 1
    state.red += need
    state.counts[index] += used
  }

  // 顺子：缺哪一张就用红中顶哪一张。
  if (canSequence) {
    const slots = [index, index + 1, index + 2]
    const available = slots.map((slot) => state.counts[slot])
    const missing = available.filter((count) => count === 0).length
    if (available[0] > 0 && missing <= state.red) {
      for (const slot of slots) if (state.counts[slot] > 0) state.counts[slot] -= 1
      state.red -= missing
      state.melds += 1
      search(state, index, fixedMelds)
      state.melds -= 1
      state.red += missing
      for (const slot of slots) if (available[slots.indexOf(slot)] > 0) state.counts[slot] += 1
    }
  }

  // 对子（同时也是将的候选）。
  if (state.counts[index] >= 2) {
    state.counts[index] -= 2
    state.partials += 1
    state.pairs += 1
    search(state, index, fixedMelds)
    state.pairs -= 1
    state.partials -= 1
    state.counts[index] += 2
  } else if (state.red >= 1) {
    state.counts[index] -= 1
    state.red -= 1
    state.partials += 1
    state.pairs += 1
    search(state, index, fixedMelds)
    state.pairs -= 1
    state.partials -= 1
    state.red += 1
    state.counts[index] += 1
  }

  // 两面／坎张搭子。
  for (const offset of [1, 2]) {
    const target = index + offset
    if (rank + offset >= RANKS || state.counts[target] === 0) continue
    state.counts[index] -= 1
    state.counts[target] -= 1
    state.partials += 1
    search(state, index, fixedMelds)
    state.partials -= 1
    state.counts[target] += 1
    state.counts[index] += 1
  }
}

function normalShanten(counts: number[], red: number, fixedMelds: number): number {
  const state: SearchState = { counts: [...counts], red, melds: 0, partials: 0, pairs: 0, best: 8 }
  search(state, 0, fixedMelds)
  return state.best
}

function sevenPairsShanten(tiles: Tile[]): number {
  const faces = countFaces(tiles.filter((tile) => tile.suit !== 'zhong'))
  const red = tiles.filter((tile) => tile.suit === 'zhong').length
  let pairs = 0
  let singles = 0
  for (const count of faces.values()) {
    pairs += Math.floor(count / 2)
    singles += count % 2
  }
  // 红中先去给单张配对，配不完的红中两两成对，和引擎判胡的口径保持一致。
  const pairedByRed = Math.min(red, singles)
  const redPairs = Math.floor((red - pairedByRed) / 2)
  return Math.max(-1, 6 - (pairs + pairedByRed + redPairs))
}

export function normalHandShanten(hand: Tile[], melds: Meld[]): number {
  const { counts, red } = toCounts(hand)
  return normalShanten(counts, red, melds.length)
}

export function sevenPairsHandShanten(hand: Tile[]): number {
  return sevenPairsShanten(hand)
}

export function handShanten(hand: Tile[], melds: Meld[]): number {
  const { counts, red } = toCounts(hand)
  const normal = normalShanten(counts, red, melds.length)
  // 七对只能是门清十四张，副露之后就不用比了。
  if (melds.length > 0) return normal
  return Math.min(normal, sevenPairsShanten(hand))
}
