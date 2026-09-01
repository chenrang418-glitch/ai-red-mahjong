import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { seatSlotsForPlayerCount } from '@/sanguosha/composables/useSgsSeatLayout'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { buildPresentationEvent } from '@/sanguosha/engine/presentation'
import { getAttackRange, getDistance } from '@/sanguosha/engine/distance'
import type { GameEvent } from '@/sanguosha/engine/events'
import type { GameSetup } from '@/sanguosha/engine/types'

function setup(count: number): GameSetup {
  return { mode: 'identity', generalChoices: 1, players: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, nickname: index ? `电脑${index}` : '你', isHuman: index === 0 })) }
}

describe('三国杀牌桌 V2 座位', () => {
  it.each([
    [5, ['self', 'right-bottom', 'right-top', 'top-left', 'left-bottom']],
    [6, ['self', 'right-bottom', 'right-top', 'top-center', 'left-top', 'left-bottom']],
    [7, ['self', 'right-bottom', 'right-top', 'top-right', 'top-left', 'left-top', 'left-bottom']],
    [8, ['self', 'right-bottom', 'right-top', 'top-right', 'top-center', 'top-left', 'left-top', 'left-bottom']],
  ])('%i 人局从下家到上家保持顺时针空间顺序', (count, expected) => {
    expect(seatSlotsForPlayerCount(count as number)).toEqual(expected)
  })

  it('PlayerView 距离和攻击范围完全采用 Engine 结果', () => {
    const game = new SanguoshaGame({ seed: 'ui-distance', setup: setup(5) })
    game.state.players.forEach((player) => { player.characterId = 'machao' })
    game.start()
    let view = game.viewFor('p0')
    expect(view.players.find((player) => player.id === 'p2')!.distanceFromViewer).toBe(getDistance(game.state, 'p0', 'p2'))
    expect(view.players.find((player) => player.id === 'p0')!.attackRange).toBe(getAttackRange(game.state, 'p0'))
    game.state.players[1].alive = false
    game.state.players[1].hp = 0
    view = game.viewFor('p0')
    expect(view.players.find((player) => player.id === 'p1')!.distanceFromViewer).toBeNull()
    expect(view.players.find((player) => player.id === 'p2')!.distanceFromViewer).toBe(getDistance(game.state, 'p0', 'p2'))
  })

  it('移动端不再隐藏装备或裁切技能区', () => {
    const source = readFileSync('src/sanguosha/components/SgsSeat.vue', 'utf8')
    const mobileFix = source.slice(source.lastIndexOf('@media (max-width: 820px)'))
    expect(mobileFix).toContain('display: grid')
    expect(mobileFix).toContain('max-height: none')
    expect(mobileFix).toContain('overflow: visible')
  })
})

describe('三国杀公开表现事件', () => {
  it('杀、闪、伤害与回复保留来源目标和结果', () => {
    const game = new SanguoshaGame({ seed: 'ui-events', setup: setup(5) })
    const events: GameEvent[] = [
      { id: 'e1', seq: 1, name: 'CardUsed', sourceId: 'p1', payload: { cardName: '杀', targetIds: ['p0'] } },
      { id: 'e2', seq: 2, name: 'CardResponded', payload: { playerId: 'p0', cardName: '闪' } },
      { id: 'e3', seq: 3, name: 'Damaged', sourceId: 'p1', targetId: 'p0', damageNature: 'fire', payload: { amount: 2 } },
      { id: 'e4', seq: 4, name: 'Recover', sourceId: 'p2', targetId: 'p0', payload: { playerId: 'p0', amount: 1 } },
    ]
    const output = events.map((event) => buildPresentationEvent(game.state, event, 'p0'))
    expect(output[0]).toMatchObject({ kind: 'card-use', sourceId: 'p1', targetIds: ['p0'], cardName: '杀' })
    expect(output[1]).toMatchObject({ kind: 'card-response', sourceId: 'p0', cardName: '闪' })
    expect(output[2]).toMatchObject({ kind: 'damage', targetIds: ['p0'], amount: 2, nature: 'fire' })
    expect(output[3]).toMatchObject({ kind: 'recover', sourceId: 'p2', targetIds: ['p0'], amount: 1 })
  })

  it('他人摸牌事件只含张数，不含牌名或 cardId', () => {
    const game = new SanguoshaGame({ seed: 'ui-secret-event', setup: setup(5) })
    const hiddenId = game.state.zones.drawPile[0]
    const event: GameEvent = { id: 'secret', seq: 1, name: 'GainCard', targetId: 'p1', cardIds: [hiddenId], payload: { playerId: 'p1', cardIds: [hiddenId] } }
    const output = buildPresentationEvent(game.state, event, 'p0')!
    expect(output).toMatchObject({ kind: 'draw', targetIds: ['p1'], amount: 1 })
    expect(JSON.stringify(output)).not.toContain(hiddenId)
    expect(JSON.stringify(output)).not.toContain(game.state.cards[hiddenId].name)
  })
})
