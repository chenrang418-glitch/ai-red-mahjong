import { describe, expect, it } from 'vitest'
import { GameEngine } from '@/game/engine'
import { isSeedBearingMatchId, secureRandomInt, secureShuffle } from '@/game/rng'
import type { MatchConfig } from '@/game/types'

function config(seed?: number): MatchConfig {
  return {
    mode: 'unlimited',
    claimWindowMs: 4000,
    ...(seed === undefined ? {} : { seed }),
    players: [
      { name: '玩家', isHuman: true, initialPoints: 30, ai: null },
      { name: 'AI1', isHuman: false, initialPoints: 30, ai: { difficulty: 'beginner' } },
      { name: 'AI2', isHuman: false, initialPoints: 30, ai: { difficulty: 'standard' } },
      { name: 'AI3', isHuman: false, initialPoints: 30, ai: { difficulty: 'expert' } },
    ],
  }
}

function wallSignature(engine: GameEngine): string {
  return [...engine.state.wall, ...engine.state.maReserve].map((tile) => tile.id).join(',')
}

describe('随机源不得泄露牌序', () => {
  // A：不带 seed 的正式牌局
  it('A：matchId 是不透明随机 id，不再是 match-时间戳-种子', () => {
    const first = new GameEngine(config())
    const second = new GameEngine(config())

    for (const engine of [first, second]) {
      expect(isSeedBearingMatchId(engine.state.matchId)).toBe(false)
      expect(engine.state.matchId).toMatch(/^match-[0-9a-f-]{32,}$/)
    }
    expect(first.state.matchId).not.toBe(second.state.matchId)
  })

  it('A：不带 seed 时 GameState 里不留可复现的随机状态', () => {
    const engine = new GameEngine(config())
    expect(engine.state.seed).toBe(0)
    expect(engine.state.rngState).toBe(0)
    expect(engine.state.config.seed).toBeUndefined()
  })

  // B：显式 seed 仍然完全可复现
  it('B：同一个 seed 每次都得到同一副牌', () => {
    const first = new GameEngine(config(20260901))
    const second = new GameEngine(config(20260901))
    expect(wallSignature(first)).toBe(wallSignature(second))
    expect(first.state.players.map((p) => p.hand.map((t) => t.id).join())).toEqual(
      second.state.players.map((p) => p.hand.map((t) => t.id).join()),
    )
  })

  it('B：seed 不同则牌序不同', () => {
    expect(wallSignature(new GameEngine(config(1)))).not.toBe(wallSignature(new GameEngine(config(2))))
  })

  // C：安全模式不依赖 rngState
  it('C：不带 seed 时把 rngState 改成什么都不影响后续牌序', () => {
    const engine = new GameEngine(config())
    // 客户端就算拿到 rngState 也没有意义：安全模式根本不读它
    engine.state.rngState = 123456789
    const before = engine.state.rngState
    engine.startRound()
    expect(engine.state.rngState).toBe(before)
    expect(engine.assertTileInvariant()).toBe(true)
  })

  it('C：两局不带 seed 的牌墙不会重复', () => {
    const signatures = new Set<string>()
    for (let round = 0; round < 5; round += 1) signatures.add(wallSignature(new GameEngine(config())))
    expect(signatures.size).toBe(5)
  })

  // E：restore 之后仍然走安全随机，不退回公开状态
  it('E：restore 出来的安全牌局，下一局仍然不使用 rngState', () => {
    const engine = new GameEngine(config())
    const restored = GameEngine.restore(structuredClone(engine.state))
    restored.state.rngState = 999
    restored.startRound()
    expect(restored.state.rngState).toBe(999)
    expect(restored.assertTileInvariant()).toBe(true)
  })

  it('E：restore 出来的可复现牌局仍然可复现', () => {
    const engine = new GameEngine(config(4242))
    const snapshot = structuredClone(engine.state)
    const left = GameEngine.restore(structuredClone(snapshot))
    const right = GameEngine.restore(structuredClone(snapshot))
    left.startRound()
    right.startRound()
    expect(wallSignature(left)).toBe(wallSignature(right))
  })
})

describe('secureRandomInt 分布', () => {
  it('落在区间内且不越界', () => {
    for (let i = 0; i < 500; i += 1) {
      const value = secureRandomInt(7)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(7)
    }
  })

  it('上界为 1 时只会返回 0', () => {
    expect(secureRandomInt(1)).toBe(0)
  })

  it('非法上界直接抛错，不静默返回 0', () => {
    expect(() => secureRandomInt(0)).toThrow()
    expect(() => secureRandomInt(-3)).toThrow()
    expect(() => secureRandomInt(2.5)).toThrow()
  })

  it('没有明显的取模偏差', () => {
    // 3 不能整除 2^32，是最容易暴露取模偏差的那类上界
    const counts = [0, 0, 0]
    const samples = 30_000
    for (let i = 0; i < samples; i += 1) counts[secureRandomInt(3)] += 1
    for (const count of counts) {
      // 均匀分布下每档期望三分之一，给足够宽的容差只为抓住系统性偏差
      expect(count).toBeGreaterThan(samples / 3 * 0.9)
      expect(count).toBeLessThan(samples / 3 * 1.1)
    }
  })

  it('secureShuffle 不增删元素', () => {
    const source = Array.from({ length: 60 }, (_, index) => index)
    const shuffled = secureShuffle(source)
    expect(shuffled).toHaveLength(source.length)
    expect([...shuffled].sort((a, b) => a - b)).toEqual(source)
    expect(source[0]).toBe(0)
  })
})
