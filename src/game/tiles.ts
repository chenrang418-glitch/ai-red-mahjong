import type { Suit, Tile } from './types'

export const SUITS: Suit[] = ['wan', 'dot', 'bamboo']

export function createDeck(): Tile[] {
  const tiles: Tile[] = []
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 9; rank += 1) {
      for (let copy = 0; copy < 4; copy += 1) {
        tiles.push({ id: `${suit}-${rank}-${copy}`, suit, rank })
      }
    }
  }
  for (let copy = 0; copy < 4; copy += 1) {
    tiles.push({ id: `zhong-${copy}`, suit: 'zhong', rank: null })
  }
  return tiles
}

export function faceKey(tile: Pick<Tile, 'suit' | 'rank'>): string {
  return tile.suit === 'zhong' ? 'zhong' : `${tile.suit}-${tile.rank}`
}

export function tileFromFace(face: string, copy = 0): Tile {
  if (face === 'zhong') return { id: `virtual-zhong-${copy}`, suit: 'zhong', rank: null }
  const [suit, rank] = face.split('-') as [Suit, string]
  return { id: `virtual-${face}-${copy}`, suit, rank: Number(rank) }
}

export function sameFace(a: Pick<Tile, 'suit' | 'rank'>, b: Pick<Tile, 'suit' | 'rank'>): boolean {
  return a.suit === b.suit && a.rank === b.rank
}

export function sortTiles(tiles: Tile[]): Tile[] {
  const suitOrder: Record<Suit, number> = { wan: 0, dot: 1, bamboo: 2, zhong: 3 }
  return [...tiles].sort((a, b) => {
    const suitDiff = suitOrder[a.suit] - suitOrder[b.suit]
    if (suitDiff !== 0) return suitDiff
    return (a.rank ?? 10) - (b.rank ?? 10) || a.id.localeCompare(b.id)
  })
}

export function tileLabel(tile: Pick<Tile, 'suit' | 'rank'>): string {
  if (tile.suit === 'zhong') return '红中'
  const suffix: Record<Exclude<Suit, 'zhong'>, string> = { wan: '万', dot: '筒', bamboo: '条' }
  return `${tile.rank}${suffix[tile.suit]}`
}

export function isMa(tile: Tile): boolean {
  return tile.suit === 'zhong' || tile.rank === 1 || tile.rank === 5 || tile.rank === 9
}

export function countFaces(tiles: Tile[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const tile of tiles) result.set(faceKey(tile), (result.get(faceKey(tile)) ?? 0) + 1)
  return result
}

export function xorshift32(state: number): number {
  let value = state | 0
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  return value >>> 0
}

export function nextRandom(state: number): { value: number; state: number } {
  const next = xorshift32(state || 0x6d2b79f5)
  return { value: next / 0x100000000, state: next }
}

export function shuffleWithState<T>(items: T[], initialState: number): { items: T[]; state: number } {
  const shuffled = [...items]
  let state = initialState
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const random = nextRandom(state)
    state = random.state
    const target = Math.floor(random.value * (index + 1))
    ;[shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]]
  }
  return { items: shuffled, state }
}
