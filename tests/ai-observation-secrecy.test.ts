import { describe, expect, it } from 'vitest'
import { decideTurn } from '@/game/ai'
import { GameEngine } from '@/game/engine'
import { faceKey } from '@/game/tiles'
import type { MatchConfig, Meld, Tile } from '@/game/types'

function config(): MatchConfig {
  return {
    mode: 'unlimited',
    seed: 20260901,
    claimWindowMs: 4000,
    players: [
      { name: '玩家', isHuman: true, initialPoints: 30, ai: null },
      { name: 'AI1', isHuman: false, initialPoints: 30, ai: { difficulty: 'standard' } },
      { name: 'AI2', isHuman: false, initialPoints: 30, ai: { difficulty: 'standard' } },
      { name: 'AI3', isHuman: false, initialPoints: 30, ai: { difficulty: 'expert' } },
    ],
  }
}

/** 直接摆一副暗杠出来，不必真的打到能杠为止。 */
function giveAnGang(engine: GameEngine, playerId: number, face: string): Meld {
  const state = engine.state
  const tiles: Tile[] = []
  const takeFrom = (pool: Tile[]) => {
    for (let index = pool.length - 1; index >= 0 && tiles.length < 4; index -= 1) {
      if (faceKey(pool[index]) !== face) continue
      tiles.push(pool.splice(index, 1)[0])
    }
  }
  for (const player of state.players) takeFrom(player.hand)
  takeFrom(state.wall)
  takeFrom(state.maReserve)
  // id 按引擎里的真实格式来：生产的 meld id 是 meld-局-座位-序号，本身不含牌面
  const meld: Meld = { id: `meld-${state.round}-${playerId}-${state.players[playerId].melds.length + 1}`, type: 'an-gang', tiles, fromPlayer: playerId }
  state.players[playerId].melds.push(meld)
  return meld
}

describe('AI 看到的信息不得多于真人', () => {
  it('别人的暗杠只暴露存在，不暴露牌面', () => {
    const engine = new GameEngine(config())
    const meld = giveAnGang(engine, 1, 'wan-4')
    expect(meld.tiles.length).toBeGreaterThan(0)

    const observation = engine.createObservation(0)
    const opponent = observation.players.find((player) => player.id === 1)!
    const hidden = opponent.melds.find((candidate) => candidate.type === 'an-gang')!

    // 知道「他暗杠了一副」
    expect(hidden).toBeDefined()
    expect(opponent.melds).toHaveLength(1)
    // 但读不到是哪种牌
    expect(hidden.tiles).toEqual([])
    // 四张牌的真实 id 一个都不该出现在观察结果里
    const serialized = JSON.stringify(observation.players)
    for (const tile of meld.tiles) expect(serialized).not.toContain(tile.id)
  })

  it('自己的暗杠仍然看得到完整内容', () => {
    const engine = new GameEngine(config())
    giveAnGang(engine, 0, 'dot-7')
    const observation = engine.createObservation(0)

    const own = observation.melds.find((meld) => meld.type === 'an-gang')!
    expect(own.tiles).toHaveLength(4)
    expect(own.tiles.every((tile) => faceKey(tile) === 'dot-7')).toBe(true)

    const selfInList = observation.players.find((player) => player.id === 0)!
    expect(selfInList.melds[0].tiles).toHaveLength(4)
  })

  it('碰和明杠是明牌，仍然照常公开', () => {
    const engine = new GameEngine(config())
    const state = engine.state
    const tiles = state.players[2].hand.splice(0, 3)
    state.players[2].melds.push({ id: 'peng-2', type: 'peng', tiles, fromPlayer: 0 })

    const observation = engine.createObservation(0)
    const opponent = observation.players.find((player) => player.id === 2)!
    expect(opponent.melds[0].type).toBe('peng')
    expect(opponent.melds[0].tiles).toHaveLength(3)
  })

  it('暗杠 tiles 为空时 AI 决策不崩，仍然能选出要打的牌', () => {
    const engine = new GameEngine(config())
    giveAnGang(engine, 1, 'wan-4')
    giveAnGang(engine, 2, 'bamboo-6')
    // 让 0 号处于摸牌后可出牌的状态
    engine.state.currentPlayer = 0
    engine.state.turnStage = 'after-draw'
    if (engine.state.players[0].hand.length % 3 !== 2) {
      engine.state.players[0].hand.push(engine.state.wall.shift()!)
    }

    const observation = engine.createObservation(0)
    const decision = decideTurn(observation, { difficulty: 'standard' }, 12345)
    expect(decision).toBeTruthy()
    expect(observation.legalDiscards).toContain(decision.tileId)
  })
})
