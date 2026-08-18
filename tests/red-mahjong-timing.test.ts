import { describe, expect, it } from 'vitest'
import { CLAIM_MASK_DELAY_RANGE, claimMaskDelay } from '@/game/timing'
import { THINK_MAX_MS, THINK_MIN_MS, decideClaim, estimateThinkMs } from '@/game/ai'
import { GameEngine } from '@/game/engine'
import type { AIObservation, Difficulty, MatchConfig } from '@/game/types'

function config(): MatchConfig {
  return {
    mode: 'unlimited',
    seed: 20260818,
    claimWindowMs: 4000,
    players: [0, 1, 2, 3].map((id) => ({
      name: `P${id}`, isHuman: false, initialPoints: 30, ai: { difficulty: 'standard' as Difficulty },
    })),
  }
}

function observationOf(engine: GameEngine, playerId: number): AIObservation {
  return engine.createObservation(playerId)
}

describe('抢牌与思考节奏', () => {
  it('无人可碰杠时的遮蔽停顿始终落在固定区间内', () => {
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = claimMaskDelay(value)
      expect(delay).toBeGreaterThanOrEqual(CLAIM_MASK_DELAY_RANGE[0])
      expect(delay).toBeLessThanOrEqual(CLAIM_MASK_DELAY_RANGE[1])
    }
  })

  it('抢牌反应一定赶在窗口关闭前给出', () => {
    const engine = new GameEngine(config())
    const observation = { ...observationOf(engine, 1), legalClaims: ['peng'] as const }
    for (const difficulty of ['beginner', 'standard', 'expert'] as Difficulty[]) {
      for (const salt of [1, 7, 23, 61]) {
        const decision = decideClaim({ ...observation, legalClaims: ['peng'] }, { difficulty }, salt, 2000)
        expect(decision.delayMs).toBeGreaterThanOrEqual(0)
        expect(decision.delayMs).toBeLessThanOrEqual(1700)
      }
    }
  })

  it('思考时间始终落在上下限之间', () => {
    const engine = new GameEngine(config())
    for (const difficulty of ['beginner', 'standard', 'expert'] as Difficulty[]) {
      for (let salt = 0; salt < 12; salt += 1) {
        const think = estimateThinkMs(observationOf(engine, salt % 4), { difficulty }, salt)
        expect(think).toBeGreaterThanOrEqual(THINK_MIN_MS)
        expect(think).toBeLessThanOrEqual(THINK_MAX_MS)
      }
    }
  })

  it('听牌时想得比刚起手时久——这是拟人感的来源', () => {
    const engine = new GameEngine(config())
    const raw = observationOf(engine, engine.state.currentPlayer)
    const fresh = { ...raw, canWin: false, anGangFaces: [], buGangFaces: [] }
    // 构造一手听牌：一二三万、四五六筒、七八九条、五万刻子，单钓九筒
    const tenpai: AIObservation = {
      ...fresh,
      hand: ['wan-1', 'wan-2', 'wan-3', 'dot-4', 'dot-5', 'dot-6', 'bamboo-7', 'bamboo-8', 'bamboo-9', 'wan-5', 'wan-5', 'wan-5', 'dot-9']
        .map((face, index) => {
          const [suit, rank] = face.split('-')
          return { id: `t-${index}`, suit: suit as 'wan' | 'dot' | 'bamboo', rank: Number(rank) }
        }),
      melds: [],
    }
    const thinkFresh = estimateThinkMs(fresh, { difficulty: 'standard' }, 5)
    const thinkTenpai = estimateThinkMs(tenpai, { difficulty: 'standard' }, 5)
    expect(thinkTenpai).toBeGreaterThan(thinkFresh)
  })
})
