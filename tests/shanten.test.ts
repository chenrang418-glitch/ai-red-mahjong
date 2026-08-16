import { describe, expect, it } from 'vitest'
import { handShanten } from '@/game/shanten'
import { checkWin } from '@/game/win'
import { createDeck, shuffleWithState, tileFromFace } from '@/game/tiles'
import type { Meld, Tile } from '@/game/types'

function hand(faces: string[]): Tile[] {
  return faces.map((face, index) => tileFromFace(face, index))
}

const noMelds: Meld[] = []

describe('向听数', () => {
  it('已经胡的牌算 -1', () => {
    const winning = hand([
      'wan-1', 'wan-2', 'wan-3',
      'dot-4', 'dot-5', 'dot-6',
      'bamboo-7', 'bamboo-8', 'bamboo-9',
      'wan-5', 'wan-5', 'wan-5',
      'dot-9', 'dot-9',
    ])
    expect(checkWin(winning, noMelds).won).toBe(true)
    expect(handShanten(winning, noMelds)).toBe(-1)
  })

  it('听牌算 0，摸到需要的牌就能胡', () => {
    const waiting = hand([
      'wan-1', 'wan-2', 'wan-3',
      'dot-4', 'dot-5', 'dot-6',
      'bamboo-7', 'bamboo-8', 'bamboo-9',
      'wan-5', 'wan-5', 'wan-5',
      'dot-9',
    ])
    expect(handShanten(waiting, noMelds)).toBe(0)
    expect(checkWin([...waiting, tileFromFace('dot-9', 99)], noMelds).won).toBe(true)
  })

  it('红中当万能牌用，能把差一步的牌变成听牌', () => {
    const withoutRed = hand([
      'wan-1', 'wan-2', 'wan-3',
      'dot-4', 'dot-5', 'dot-6',
      'bamboo-7', 'bamboo-8',
      'wan-5', 'wan-5', 'wan-5',
      'dot-9',
    ])
    const withRed = [...withoutRed, tileFromFace('zhong', 50)]
    expect(handShanten(withoutRed, noMelds)).toBe(1)
    expect(handShanten(withRed, noMelds)).toBe(0)
  })

  it('七对进度也算进向听数', () => {
    const pairs = hand([
      'wan-1', 'wan-1', 'wan-4', 'wan-4',
      'dot-2', 'dot-2', 'dot-6', 'dot-6',
      'bamboo-3', 'bamboo-3', 'bamboo-8', 'bamboo-8',
      'wan-9',
    ])
    expect(handShanten(pairs, noMelds)).toBe(0)
  })

  it('副露之后按剩余面子数计算', () => {
    const melds: Meld[] = [
      { id: 'm1', type: 'peng', tiles: hand(['wan-2', 'wan-2', 'wan-2']) },
      { id: 'm2', type: 'peng', tiles: hand(['dot-3', 'dot-3', 'dot-3']) },
    ]
    const rest = hand(['bamboo-4', 'bamboo-5', 'bamboo-6', 'wan-7', 'wan-8', 'wan-9', 'dot-5'])
    expect(handShanten(rest, melds)).toBe(0)
    expect(checkWin([...rest, tileFromFace('dot-5', 98)], melds).won).toBe(true)
  })

  it('随机牌局中，向听数为 -1 与引擎判胡完全一致', () => {
    let state = 20260816
    for (let round = 0; round < 400; round += 1) {
      const shuffled = shuffleWithState(createDeck(), state)
      state = shuffled.state
      const tiles = shuffled.items.slice(0, 14)
      const won = checkWin(tiles, noMelds).won
      const value = handShanten(tiles, noMelds)
      expect(value === -1).toBe(won)
      expect(value).toBeGreaterThanOrEqual(-1)
    }
  })

  it('随机牌局中，向听数为 0 时一定存在能胡的进张', () => {
    let state = 987654
    let checked = 0
    for (let round = 0; round < 600 && checked < 60; round += 1) {
      const shuffled = shuffleWithState(createDeck(), state)
      state = shuffled.state
      const tiles = shuffled.items.slice(0, 13)
      if (handShanten(tiles, noMelds) !== 0) continue
      checked += 1
      const faces = [
        ...['wan', 'dot', 'bamboo'].flatMap((suit) => Array.from({ length: 9 }, (_, index) => `${suit}-${index + 1}`)),
        'zhong',
      ]
      const winnable = faces.some((face) => checkWin([...tiles, tileFromFace(face, 77)], noMelds).won)
      expect(winnable).toBe(true)
    }
    expect(checked).toBeGreaterThan(0)
  })
})
