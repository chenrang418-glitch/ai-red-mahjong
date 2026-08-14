import { describe, expect, it } from 'vitest'
import { GameEngine } from '@/game/engine'
import { faceKey } from '@/game/tiles'
import type { GameState, MatchConfig, Tile } from '@/game/types'

function config(points = 20, mode: MatchConfig['mode'] = 'finite'): MatchConfig {
  return {
    mode,
    claimWindowMs: 3000,
    seed: 20260814,
    players: [
      { name: '玩家', isHuman: true, initialPoints: points, ai: null },
      { name: '快攻AI', isHuman: false, initialPoints: points, ai: { personality: 'fast', difficulty: 'beginner', speed: 'fast' } },
      { name: '平衡AI', isHuman: false, initialPoints: points, ai: { personality: 'balanced', difficulty: 'standard', speed: 'normal' } },
      { name: '七对AI', isHuman: false, initialPoints: points, ai: { personality: 'closed', difficulty: 'expert', speed: 'slow' } },
    ],
  }
}

function resetTable(engine: GameEngine) {
  const state = engine.state
  const pool = collectAll(state)
  for (const player of state.players) {
    player.hand = []
    player.discards = []
    player.melds = []
  }
  state.maReserve = pool.splice(-6)
  state.wall = pool
  state.phase = 'playing'
  state.turnStage = 'after-draw'
  state.currentPlayer = 0
  state.lastDiscard = null
  state.claimOptions = []
  state.result = null
  return pool
}

function fillOtherHands(engine: GameEngine, pool: Tile[], excludedPlayerIds: number[]) {
  for (const player of engine.state.players) {
    if (!excludedPlayerIds.includes(player.id)) player.hand = pool.splice(0, 13)
  }
  engine.state.wall = pool
  engine.assertTileInvariant()
}

function collectAll(state: GameState): Tile[] {
  return [
    ...state.wall,
    ...state.maReserve,
    ...state.players.flatMap((player) => [
      ...player.hand,
      ...player.discards,
      ...player.melds.flatMap((meld) => meld.tiles),
    ]),
  ]
}

function take(pool: Tile[], face: string, count: number): Tile[] {
  const result: Tile[] = []
  for (let index = pool.length - 1; index >= 0 && result.length < count; index -= 1) {
    if (faceKey(pool[index]) === face) result.push(...pool.splice(index, 1))
  }
  if (result.length !== count) throw new Error(`测试牌池缺少${face}`)
  return result
}

function arrangeWinningScenario(engine: GameEngine, points = 20) {
  const state = engine.state
  const pool = collectAll(state)
  for (const player of state.players) {
    player.hand = []
    player.discards = []
    player.melds = []
    player.points = points
  }
  state.maReserve = [
    ...take(pool, 'wan-5', 2),
    ...take(pool, 'dot-1', 2),
    ...take(pool, 'bamboo-2', 2),
  ]
  state.players[0].hand = [
    ...take(pool, 'wan-1', 2),
    ...take(pool, 'wan-2', 1), ...take(pool, 'wan-3', 1), ...take(pool, 'wan-4', 1),
    ...take(pool, 'dot-2', 1), ...take(pool, 'dot-3', 1), ...take(pool, 'dot-4', 1),
    ...take(pool, 'dot-5', 3),
    ...take(pool, 'bamboo-7', 1), ...take(pool, 'bamboo-8', 1), ...take(pool, 'zhong', 1),
  ]
  for (const playerId of [1, 2, 3]) state.players[playerId].hand = pool.splice(0, 13)
  state.wall = pool
  state.currentPlayer = 0
  state.phase = 'playing'
  state.turnStage = 'after-draw'
  state.lastDiscard = null
  state.claimOptions = []
  engine.assertTileInvariant()
}

describe('光山红中四人引擎', () => {
  it('开局固定保留六码且实体牌守恒', () => {
    const engine = new GameEngine(config())
    expect(engine.state.maReserve).toHaveLength(6)
    expect(engine.state.wall).toHaveLength(53)
    expect(engine.state.players.map((player) => player.hand.length).sort()).toEqual([13, 13, 13, 14])
    expect(engine.assertTileInvariant()).toBe(true)
  })

  it('红中弃牌不会产生碰或杠选项', () => {
    const engine = new GameEngine(config())
    const dealer = engine.state.dealer
    const all = collectAll(engine.state)
    const red = all.find((tile) => tile.suit === 'zhong')!
    const owner = engine.state.players.find((player) => player.hand.some((tile) => tile.id === red.id))
    if (!owner || owner.id !== dealer) {
      const dealerTile = engine.state.players[dealer].hand[0]
      if (owner) {
        const redIndex = owner.hand.findIndex((tile) => tile.id === red.id)
        owner.hand[redIndex] = dealerTile
      } else {
        const wallIndex = engine.state.wall.findIndex((tile) => tile.id === red.id)
        if (wallIndex >= 0) engine.state.wall[wallIndex] = dealerTile
        else {
          const maIndex = engine.state.maReserve.findIndex((tile) => tile.id === red.id)
          engine.state.maReserve[maIndex] = dealerTile
        }
      }
      engine.state.players[dealer].hand[0] = red
    }
    engine.discard(dealer, red.id)
    expect(engine.state.phase).toBe('playing')
    expect(engine.state.currentPlayer).toBe((dealer + 1) % 4)
    expect(engine.assertTileInvariant()).toBe(true)
  })

  it('有红中自摸抓四张码并向三家收取基础分和码分', () => {
    const engine = new GameEngine(config())
    arrangeWinningScenario(engine)
    expect(engine.winResult(0)).toEqual({ won: true, kind: 'normal' })
    engine.declareWin(0)
    expect(engine.state.result?.maTiles).toHaveLength(4)
    expect(engine.state.result?.maCount).toBe(2)
    expect(engine.state.players[0].points).toBe(29)
    expect(engine.state.players.slice(1).map((player) => player.points)).toEqual([17, 17, 17])
    expect(engine.state.dealer).toBe(0)
    expect(engine.assertTileInvariant()).toBe(true)
  })

  it('支付不能低于零，结算后有人归零则整场结束', () => {
    const engine = new GameEngine(config(2))
    arrangeWinningScenario(engine, 2)
    engine.declareWin(0)
    expect(engine.state.players.slice(1).map((player) => player.points)).toEqual([0, 0, 0])
    expect(engine.state.players[0].points).toBe(8)
    expect(engine.state.phase).toBe('match-over')
  })

  it('暗杠和补杠都由另外三家各付一分并从牌尾补摸', () => {
    const anGang = new GameEngine(config())
    let pool = resetTable(anGang)
    anGang.state.players[0].hand = [...take(pool, 'wan-3', 4), ...pool.splice(0, 10)]
    fillOtherHands(anGang, pool, [0])
    const wallBefore = anGang.state.wall.length
    anGang.declareGang(0, 'an-gang', 'wan-3')
    expect(anGang.state.players.map((player) => player.points)).toEqual([23, 19, 19, 19])
    expect(anGang.state.players[0].melds[0].type).toBe('an-gang')
    expect(anGang.state.wall).toHaveLength(wallBefore - 1)

    const buGang = new GameEngine(config())
    pool = resetTable(buGang)
    const pengTiles = take(pool, 'dot-6', 3)
    buGang.state.players[0].melds = [{ id: 'test-peng', type: 'peng', tiles: pengTiles, fromPlayer: 1 }]
    buGang.state.players[0].hand = [...take(pool, 'dot-6', 1), ...pool.splice(0, 10)]
    fillOtherHands(buGang, pool, [0])
    buGang.declareGang(0, 'bu-gang', 'dot-6')
    expect(buGang.state.players.map((player) => player.points)).toEqual([23, 19, 19, 19])
    expect(buGang.state.players[0].melds[0].type).toBe('bu-gang')
    expect(buGang.state.players[0].melds[0].tiles).toHaveLength(4)
  })

  it('明杠只由出牌者付一分，先声明者直接锁定弃牌', () => {
    const engine = new GameEngine(config())
    const pool = resetTable(engine)
    const discard = take(pool, 'bamboo-4', 1)[0]
    const claimTiles = take(pool, 'bamboo-4', 3)
    engine.state.players[0].hand = [discard, ...pool.splice(0, 13)]
    engine.state.players[1].hand = [...claimTiles, ...pool.splice(0, 10)]
    engine.state.players[2].hand = pool.splice(0, 13)
    engine.state.players[3].hand = pool.splice(0, 13)
    engine.state.wall = pool
    engine.state.turnStage = 'must-discard'
    engine.assertTileInvariant()
    engine.discard(0, discard.id)
    expect(engine.state.claimOptions.find((option) => option.playerId === 1)?.actions).toContain('ming-gang')
    engine.claim(1, 'ming-gang')
    expect(engine.state.players.map((player) => player.points)).toEqual([19, 21, 20, 20])
    expect(engine.state.players[1].melds[0].type).toBe('ming-gang')
    expect(() => engine.claim(2, 'peng')).toThrow()
  })

  it('碰牌后不能把现成牌型误判成自摸，暗杠补杠也仅限摸牌后', () => {
    const engine = new GameEngine(config())
    arrangeWinningScenario(engine)
    engine.state.turnStage = 'must-discard'
    expect(engine.winResult(0).won).toBe(true)
    expect(() => engine.declareWin(0)).toThrow('只能摸牌后自摸胡')
    expect(engine.createObservation(0).canWin).toBe(false)
    expect(() => engine.declareGang(0, 'an-gang', 'wan-1')).toThrow('只有摸牌后')
  })

  it('无限模式不设余额上限，只持续记录净分', () => {
    const engine = new GameEngine(config(1, 'unlimited'))
    arrangeWinningScenario(engine)
    for (const player of engine.state.players) player.points = null
    engine.declareWin(0)
    expect(engine.state.players.map((player) => player.points)).toEqual([null, null, null, null])
    expect(engine.state.players[0].stats.netPoints).toBe(9)
    expect(engine.state.players.slice(1).map((player) => player.stats.netPoints)).toEqual([-3, -3, -3])
    expect(engine.state.phase).toBe('settlement')
  })

  it('流局留庄，赢家在下一局坐庄', () => {
    const drawEngine = new GameEngine(config())
    const dealer = drawEngine.state.dealer
    const pool = resetTable(drawEngine)
    const red = take(pool, 'zhong', 1)[0]
    for (const player of drawEngine.state.players) {
      const size = player.id === dealer ? 14 : 13
      player.hand = player.id === dealer ? [red, ...pool.splice(0, size - 1)] : pool.splice(0, size)
    }
    drawEngine.state.players[0].discards = pool.splice(0)
    drawEngine.state.wall = []
    drawEngine.state.currentPlayer = dealer
    drawEngine.state.turnStage = 'must-discard'
    drawEngine.assertTileInvariant()
    drawEngine.discard(dealer, red.id)
    expect(drawEngine.state.phase).toBe('settlement')
    expect(drawEngine.state.dealer).toBe(dealer)
    drawEngine.continueAfterSettlement()
    expect(drawEngine.state.dealer).toBe(dealer)

    const winEngine = new GameEngine(config())
    arrangeWinningScenario(winEngine)
    winEngine.declareWin(0)
    winEngine.continueAfterSettlement()
    expect(winEngine.state.dealer).toBe(0)
    expect(winEngine.state.currentPlayer).toBe(0)
  })

  it('AI观察只包含其他玩家手牌数量，不泄露暗牌内容', () => {
    const engine = new GameEngine(config())
    const observation = engine.createObservation(1)
    expect(observation.players).toHaveLength(4)
    expect(observation.players[0]).toHaveProperty('handCount')
    expect(observation.players[0]).not.toHaveProperty('hand')
  })
})
