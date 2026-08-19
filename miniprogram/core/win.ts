import { countFaces } from './tiles'
import type { Meld, Tile, WinResult } from './types'

const FACE_INDEX = new Map<string, number>()
for (const [suitIndex, suit] of ['wan', 'dot', 'bamboo'].entries()) {
  for (let rank = 1; rank <= 9; rank += 1) {
    FACE_INDEX.set(`${suit}-${rank}`, suitIndex * 9 + rank - 1)
  }
}

function normalCounts(tiles: Tile[]): { counts: number[]; red: number } {
  const counts = new Array<number>(27).fill(0)
  let red = 0
  for (const tile of tiles) {
    if (tile.suit === 'zhong') red += 1
    else counts[FACE_INDEX.get(`${tile.suit}-${tile.rank}`)!] += 1
  }
  return { counts, red }
}

function canFormMeldsSafe(counts: number[], red: number, meldsLeft: number, memo: Map<string, boolean>): boolean {
  const remaining = counts.reduce((sum, count) => sum + count, 0) + red
  if (remaining !== meldsLeft * 3) return false
  if (meldsLeft === 0) return remaining === 0
  const key = `${counts.join(',')}|${red}|${meldsLeft}`
  if (memo.has(key)) return memo.get(key)!
  const first = counts.findIndex((count) => count > 0)
  if (first < 0) return red === meldsLeft * 3

  const tripletCounts = [...counts]
  const natural = Math.min(3, tripletCounts[first])
  const tripletRed = 3 - natural
  if (tripletRed <= red) {
    tripletCounts[first] -= natural
    if (canFormMeldsSafe(tripletCounts, red - tripletRed, meldsLeft - 1, memo)) {
      memo.set(key, true)
      return true
    }
  }

  const suitBase = Math.floor(first / 9) * 9
  const rank = first % 9
  for (let start = Math.max(0, rank - 2); start <= Math.min(rank, 6); start += 1) {
    const sequenceCounts = [...counts]
    let sequenceRed = 0
    for (const offset of [0, 1, 2]) {
      const target = suitBase + start + offset
      if (sequenceCounts[target] > 0) sequenceCounts[target] -= 1
      else sequenceRed += 1
    }
    if (sequenceRed <= red && canFormMeldsSafe(sequenceCounts, red - sequenceRed, meldsLeft - 1, memo)) {
      memo.set(key, true)
      return true
    }
  }

  memo.set(key, false)
  return false
}

export function isSevenPairs(tiles: Tile[], melds: Meld[]): boolean {
  if (melds.length > 0 || tiles.length !== 14) return false
  const faces = countFaces(tiles.filter((tile) => tile.suit !== 'zhong'))
  const red = tiles.filter((tile) => tile.suit === 'zhong').length
  let pairs = 0
  let singletons = 0
  for (const count of faces.values()) {
    pairs += Math.floor(count / 2)
    singletons += count % 2
  }
  if (singletons > red) return false
  const remainingRed = red - singletons
  return pairs + singletons + Math.floor(remainingRed / 2) === 7
}

export function isNormalWin(tiles: Tile[], melds: Meld[]): boolean {
  const neededMelds = 4 - melds.length
  if (neededMelds < 0 || tiles.length !== neededMelds * 3 + 2) return false
  const { counts, red } = normalCounts(tiles)
  const candidates: Array<{ counts: number[]; red: number }> = []

  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] >= 2) {
      const next = [...counts]
      next[index] -= 2
      candidates.push({ counts: next, red })
    }
    if (counts[index] >= 1 && red >= 1) {
      const next = [...counts]
      next[index] -= 1
      candidates.push({ counts: next, red: red - 1 })
    }
  }
  if (red >= 2) candidates.push({ counts: [...counts], red: red - 2 })

  return candidates.some((candidate) => canFormMeldsSafe(candidate.counts, candidate.red, neededMelds, new Map()))
}

export function checkWin(tiles: Tile[], melds: Meld[]): WinResult {
  if (isSevenPairs(tiles, melds)) return { won: true, kind: 'seven-pairs' }
  if (isNormalWin(tiles, melds)) return { won: true, kind: 'normal' }
  return { won: false, kind: null }
}
