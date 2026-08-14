import { describe, expect, it } from 'vitest'
import { checkWin, isSevenPairs } from '@/game/win'
import { tileFromFace } from '@/game/tiles'
import type { Tile } from '@/game/types'

function hand(faces: string[]): Tile[] {
  return faces.map((face, index) => ({ ...tileFromFace(face, index), id: `test-${face}-${index}` }))
}

describe('光山红中胡牌规则', () => {
  it('支持普通胡且红中可补低位顺子', () => {
    const tiles = hand([
      'wan-1', 'wan-1',
      'wan-2', 'wan-3', 'wan-4',
      'dot-2', 'dot-3', 'dot-4',
      'dot-5', 'dot-5', 'dot-5',
      'bamboo-8', 'bamboo-9', 'zhong',
    ])
    expect(checkWin(tiles, [])).toEqual({ won: true, kind: 'normal' })
  })

  it('七对允许红中补单张、四张相同算两对', () => {
    const tiles = hand([
      'wan-1', 'wan-1', 'wan-2', 'wan-2',
      'dot-3', 'dot-3', 'dot-3', 'dot-3',
      'bamboo-4', 'bamboo-4', 'bamboo-5',
      'bamboo-6', 'zhong', 'zhong',
    ])
    expect(isSevenPairs(tiles, [])).toBe(true)
    expect(checkWin(tiles, [])).toEqual({ won: true, kind: 'seven-pairs' })
  })

  it('有任何副露时不能按七对胡', () => {
    const tiles = hand([
      'wan-1', 'wan-1', 'wan-2', 'wan-2', 'wan-3', 'wan-3', 'wan-4',
      'wan-4', 'dot-1', 'dot-1', 'dot-2', 'dot-2', 'dot-3', 'dot-3',
    ])
    const meldTiles = hand(['bamboo-1', 'bamboo-1', 'bamboo-1'])
    expect(isSevenPairs(tiles, [{ id: 'meld', type: 'peng', tiles: meldTiles }])).toBe(false)
  })
})
