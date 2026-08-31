import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRulesetV1Deck } from '@/sanguosha/data/ruleset-v1/deck'
import { canTarget, getAttackRange, getDistance, getSeatDistance } from '@/sanguosha/engine/distance'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup } from '@/sanguosha/engine/types'

function setup(count = 5): GameSetup {
  return {
    mode: 'identity', generalChoices: 3,
    players: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

describe('纯 TypeScript Engine 基础', () => {
  it('相同 ruleset、seed、setup 得到完全相同的身份、手牌与牌堆', () => {
    const left = new SanguoshaGame({ seed: 'deterministic-001', setup: setup(8) })
    const right = new SanguoshaGame({ seed: 'deterministic-001', setup: setup(8) })
    left.start()
    right.start()
    expect(left.state.players.map((player) => player.identity)).toEqual(right.state.players.map((player) => player.identity))
    expect(left.state.players.map((player) => player.zones.hand)).toEqual(right.state.players.map((player) => player.zones.hand))
    expect(left.state.zones.drawPile).toEqual(right.state.zones.drawPile)
    expect(left.replayRecord()).toEqual(right.replayRecord())
  })

  it('发完 5 人起始手牌后牌张守恒', () => {
    const game = new SanguoshaGame({ seed: 'conservation', setup: setup(5) })
    game.start()
    const handCount = game.state.players.reduce((sum, player) => sum + player.zones.hand.length, 0)
    expect(handCount).toBe(20)
    expect(game.state.zones.drawPile).toHaveLength(140)
    expect(Object.keys(game.state.cards)).toHaveLength(160)
  })

  it('玩家视图不泄露别人的手牌、牌堆顺序和未公开身份', () => {
    const game = new SanguoshaGame({ seed: 'private-view', setup: setup(5) })
    game.start()
    const view = game.viewFor('p0')
    expect(view.players.find((player) => player.id === 'p0')!.hand).toHaveLength(4)
    for (const opponent of view.players.filter((player) => player.id !== 'p0')) {
      expect(opponent.hand).toBeNull()
      expect(opponent.handCount).toBe(4)
      if (opponent.identity !== 'lord') expect(opponent.identityHidden).toBe(true)
    }
    expect(view).not.toHaveProperty('drawPile')
    const serialized = JSON.stringify(view)
    for (const id of game.state.zones.drawPile.slice(0, 10)) expect(serialized).not.toContain(id)
  })

  it('玩家视图只包含发给自己的 Request，并保留公开濒死进度供重连', () => {
    const game = new SanguoshaGame({ seed: 'private-request-view', setup: setup(5) })
    game.start()
    game.state.players[1].hp = 1
    game.damage({ targetId: 'p1' })
    const request = game.state.pendingRequests[0]
    const ownerView = game.viewFor(request.playerId)
    const otherId = game.state.players.find((player) => player.id !== request.playerId)!.id
    const otherView = game.viewFor(otherId)
    expect(ownerView.pendingRequest?.id).toBe(request.id)
    expect(otherView.pendingRequest).toBeNull()
    expect(ownerView.dying).toEqual({ playerId: 'p1', requiredRecover: 1 })
    expect(otherView.dying).toEqual(ownerView.dying)
    expect(JSON.stringify(otherView)).not.toContain(request.id)
  })

  it('统一距离计算考虑死亡玩家和坐骑', () => {
    const game = new SanguoshaGame({ seed: 'distance', setup: setup(5) })
    expect(getSeatDistance(game.state, 'p0', 'p2')).toBe(2)
    game.state.players[1].alive = false
    expect(getSeatDistance(game.state, 'p0', 'p2')).toBe(1)
    const deck = createRulesetV1Deck()
    const offensive = deck.find((card) => card.name === '赤兔')!
    const defensive = deck.find((card) => card.name === '骅骝')!
    game.state.cards[offensive.id] = offensive
    game.state.cards[defensive.id] = defensive
    game.state.players[0].zones.equipment.offensiveHorse = offensive.id
    game.state.players[2].zones.equipment.defensiveHorse = defensive.id
    expect(getDistance(game.state, 'p0', 'p2')).toBe(1)
    expect(getDistance(game.state, 'p2', 'p0')).toBe(1)
  })

  it('武器攻击范围由统一入口读取', () => {
    const game = new SanguoshaGame({ seed: 'weapon', setup: setup(5) })
    const weapon = Object.values(game.state.cards).find((card) => card.name === '麒麟弓')!
    game.state.players[0].zones.equipment.weapon = weapon.id
    expect(getAttackRange(game.state, 'p0')).toBe(5)
    expect(canTarget(game.state, 'p0', 'p2')).toBe(true)
  })

  it('engine 源码没有 Vue、DOM、网络、存储与 Math.random 依赖', () => {
    const files = ['types.ts', 'rng.ts', 'events.ts', 'requests.ts', 'distance.ts', 'view.ts', 'game.ts', 'index.ts']
    const source = files.map((file) => readFileSync(resolve('src/sanguosha/engine', file), 'utf8')).join('\n')
    for (const forbidden of ['from \'vue\'', 'window.', 'document.', 'localStorage', 'fetch(', 'WebSocket', 'Math.random']) {
      expect(source, `不应出现 ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('统一 invariant 检查能捕获悬空体力和错误装备槽', () => {
    const game = new SanguoshaGame({ seed: 'invariants', setup: setup(5) })
    game.start()
    expect(() => assertGameInvariants(game.state)).not.toThrow()
    game.state.players[0].hp = 0
    expect(() => assertGameInvariants(game.state)).toThrow('非正体力')
    game.state.players[0].hp = 4
    const armor = Object.values(game.state.cards).find((card) => card.equipmentSlot === 'armor')!
    game.state.players[0].zones.equipment.weapon = armor.id
    const sourceIndex = game.state.zones.drawPile.indexOf(armor.id)
    if (sourceIndex >= 0) game.state.zones.drawPile.splice(sourceIndex, 1)
    else {
      const owner = game.state.players.find((player) => player.zones.hand.includes(armor.id))!
      owner.zones.hand.splice(owner.zones.hand.indexOf(armor.id), 1)
    }
    expect(() => assertGameInvariants(game.state)).toThrow('装备槽类型不匹配')
  })
})
