import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMahjongGame } from '@/composables/useMahjongGame'
import { GameEngine } from '@/game/engine'
import { faceKey } from '@/game/tiles'
import type { GameState, MatchConfig, Tile } from '@/game/types'

const ACTIVE_GAME_KEY = 'red-mahjong-active-v1'

function config(seed: number): MatchConfig {
  return {
    mode: 'unlimited',
    seed,
    claimWindowMs: 4000,
    players: [
      { name: '玩家', isHuman: true, initialPoints: 30, ai: null },
      { name: 'AI1', isHuman: false, initialPoints: 30, ai: { difficulty: 'beginner' } },
      { name: 'AI2', isHuman: false, initialPoints: 30, ai: { difficulty: 'standard' } },
      { name: 'AI3', isHuman: false, initialPoints: 30, ai: { difficulty: 'expert' } },
    ],
  }
}

function findHumanDealerWithRed(): { config: MatchConfig; redTileId: string } {
  for (let seed = 1; seed <= 5000; seed += 1) {
    const matchConfig = config(seed)
    const engine = new GameEngine(matchConfig)
    const red = engine.state.players[0].hand.find((tile) => tile.suit === 'zhong')
    if (engine.state.dealer === 0 && red) return { config: matchConfig, redTileId: red.id }
  }
  throw new Error('没有找到真人坐庄且持有红中的固定种子')
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
  return result
}

function savedHumanClaimState(): GameState {
  const engine = new GameEngine(config(20260815))
  const pool = collectAll(engine.state)
  for (const player of engine.state.players) {
    player.hand = []
    player.discards = []
    player.melds = []
  }
  engine.state.maReserve = pool.splice(-6)
  const discarded = take(pool, 'wan-3', 1)[0]
  engine.state.players[0].hand = [...take(pool, 'wan-3', 2), ...pool.splice(0, 11)]
  engine.state.players[1].hand = [discarded, ...pool.splice(0, 13)]
  engine.state.players[2].hand = pool.splice(0, 13)
  engine.state.players[3].hand = pool.splice(0, 13)
  engine.state.wall = pool
  engine.state.currentPlayer = 1
  engine.state.phase = 'playing'
  engine.state.turnStage = 'must-discard'
  engine.state.lastDiscard = null
  engine.state.claimOptions = []
  engine.assertTileInvariant()
  engine.discard(1, discarded.id)
  return engine.snapshot()
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('抢牌响应流程', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00Z'))
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('document', { hidden: false, addEventListener: () => {}, removeEventListener: () => {} })
    vi.stubGlobal('window', {
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('无人可碰杠时至少等待1.2秒再让下家摸牌', () => {
    const scenario = findHumanDealerWithRed()
    const game = useMahjongGame()
    game.startMatch(scenario.config)

    game.humanDiscard(scenario.redTileId)
    expect(game.state.value?.phase).toBe('claiming')
    expect(game.state.value?.claimOptions).toHaveLength(0)
    expect(game.notice.value).toBe('等其他三家决定要不要这张…')

    vi.advanceTimersByTime(1199)
    expect(game.state.value?.phase).toBe('claiming')

    vi.advanceTimersByTime(1)
    expect(game.state.value?.phase).toBe('playing')
    expect(game.state.value?.currentPlayer).toBe(1)
    game.abandonMatch()
  })

  it('所有候选人提前选择过也要满足最低伪装停顿', async () => {
    localStorage.setItem(ACTIVE_GAME_KEY, JSON.stringify(savedHumanClaimState()))
    const game = useMahjongGame()
    await game.resumeMatch()

    expect(game.humanClaimOption.value?.actions).toContain('peng')
    game.humanPassClaim()
    expect(game.humanPassed.value).toBe(true)

    vi.advanceTimersByTime(1199)
    expect(game.state.value?.phase).toBe('claiming')

    vi.advanceTimersByTime(1)
    expect(game.state.value?.phase).toBe('playing')
    expect(game.state.value?.currentPlayer).toBe(2)
    game.abandonMatch()
  })
})
