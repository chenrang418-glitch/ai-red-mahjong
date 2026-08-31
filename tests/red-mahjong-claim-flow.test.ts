import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMahjongGame } from '@/composables/useMahjongGame'
import { CLAIM_MASK_DELAY_RANGE } from '@/game/timing'
import { GameEngine } from '@/game/engine'
import type { MatchConfig } from '@/game/types'

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

describe('抢牌响应流程', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00Z'))
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

  // 下限直接引用常量：调过一次节奏后这个断言写死过一次数字，跟着漂了。
  it('无人可碰杠时也要等满掩护时间再让下家摸牌', () => {
    const scenario = findHumanDealerWithRed()
    const game = useMahjongGame()
    game.startMatch(scenario.config)

    game.humanDiscard(scenario.redTileId)
    expect(game.state.value?.phase).toBe('claiming')
    expect(game.state.value?.claimOptions).toHaveLength(0)
    expect(game.notice.value).toBe('')

    // Math.random 被固定成 0，掩护时长就是区间下限
    const maskDelay = CLAIM_MASK_DELAY_RANGE[0]
    vi.advanceTimersByTime(maskDelay - 1)
    expect(game.state.value?.phase).toBe('claiming')

    vi.advanceTimersByTime(1)
    expect(game.state.value?.phase).toBe('playing')
    expect(game.state.value?.currentPlayer).toBe(1)
    game.abandonMatch()
  })
})
