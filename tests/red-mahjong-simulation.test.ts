import { describe, expect, it } from 'vitest'
import { decideClaim, decideTurn } from '@/game/ai'
import { GameEngine } from '@/game/engine'
import type { AIProfile, MatchConfig } from '@/game/types'

const profiles: AIProfile[] = [
  { difficulty: 'beginner' },
  { difficulty: 'beginner' },
  { difficulty: 'expert' },
  { difficulty: 'standard' },
]

function simulationConfig(seed: number): MatchConfig {
  return {
    mode: 'unlimited',
    seed,
    claimWindowMs: 3000,
    players: profiles.map((ai, index) => ({
      name: `模拟玩家${index + 1}`,
      isHuman: false,
      initialPoints: 1,
      ai,
    })),
  }
}

function playOneRound(seed: number) {
  const engine = new GameEngine(simulationConfig(seed))
  let steps = 0
  while (engine.state.phase === 'playing' || engine.state.phase === 'claiming') {
    steps += 1
    if (steps > 300) throw new Error(`种子${seed}超过最大步骤，可能存在状态死循环`)

    if (engine.state.phase === 'claiming') {
      const plans = engine.state.claimOptions
        .map((option) => {
          const player = engine.state.players[option.playerId]
          const plan = decideClaim(engine.createObservation(player.id, option.actions), player.ai!, steps + player.id)
          return { playerId: player.id, ...plan }
        })
        .filter((plan) => plan.action !== 'pass')
        .sort((a, b) => a.delayMs - b.delayMs)
      if (plans.length === 0) engine.resolveNoClaim()
      else engine.claim(plans[0].playerId, plans[0].action as 'peng' | 'ming-gang')
    } else {
      const player = engine.state.players[engine.state.currentPlayer]
      const decision = decideTurn(engine.createObservation(player.id), player.ai!)
      if (decision.action === 'win') engine.declareWin(player.id)
      else if (decision.action === 'an-gang' || decision.action === 'bu-gang') {
        engine.declareGang(player.id, decision.action, decision.face)
      } else engine.discard(player.id, decision.tileId)
    }
    engine.assertTileInvariant()
  }
  return engine
}

describe('短程离线AI整局冒烟验证', () => {
  it('三个固定种子都能完成一局且不破坏牌张守恒', () => {
    for (let seed = 1; seed <= 3; seed += 1) {
      const engine = playOneRound(seed)
      expect(engine.state.phase).toBe('settlement')
      expect(['win', 'draw']).toContain(engine.state.result?.type)
      expect(engine.assertTileInvariant()).toBe(true)
    }
  }, 15_000)
})
