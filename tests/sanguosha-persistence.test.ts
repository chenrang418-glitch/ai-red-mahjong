import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { decideResponse, type AIContext } from '@/sanguosha/ai'
import { emptySuspicion } from '@/sanguosha/ai/belief'
import { GameRng } from '@/sanguosha/engine/rng'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup } from '@/sanguosha/engine/types'

/**
 * 持久化与恢复。
 *
 * Durable Object 随时可能休眠，所以「存下来再读回去」必须和从没休眠过完全一致。
 * 这里用同一串 AI 决策跑两遍：一遍不中断，一遍每步都存盘重建。
 */

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 3,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
}

function play(seed: string, roundTrip: boolean): { seq: number; hands: number[]; winner: string | null } {
  let game = new SanguoshaGame({ seed, setup: setup() })
  const aiRng = new GameRng(`ai:${seed}`)
  const suspicion = emptySuspicion(game.viewFor('p0'))
  const contextFor = (playerId: string): AIContext => ({
    view: game.viewFor(playerId), difficulty: 'normal', rng: aiRng, suspicion,
  })

  game.dealGenerals()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond(decideResponse(contextFor(request.playerId), request))
  }
  game.start()

  for (let step = 0; step < 400 && game.state.status === 'playing'; step += 1) {
    if (roundTrip) {
      // 每一步都过一遍持久化，模拟 DO 反复休眠
      const stored = JSON.parse(JSON.stringify(game.serialize()))
      game = SanguoshaGame.restore(stored)
    }
    const request = game.state.pendingRequests[0]
    if (request) {
      game.respond(decideResponse(contextFor(request.playerId), request))
      continue
    }
    if (game.state.phase === 'play') {
      const actions = game.legalActions(game.state.currentPlayerId)
      const chosen = actions.find((action) => action.kind === 'use-card')
      if (chosen) { game.act(game.state.currentPlayerId, chosen.id); continue }
    }
    game.advancePhase()
  }

  assertGameInvariants(game.state)
  return {
    seq: game.state.seq,
    hands: game.state.players.map((player) => player.zones.hand.length),
    winner: game.state.result?.camp ?? null,
  }
}

describe('持久化', () => {
  it('每步存盘重建之后，牌局走向完全一致', () => {
    for (const seed of ['persist-1', 'persist-2', 'persist-3']) {
      expect(play(seed, true), `seed=${seed}`).toEqual(play(seed, false))
    }
  })

  it('serialize 带上随机源快照，restore 接得回去', () => {
    const game = new SanguoshaGame({ seed: 'rng-snapshot', setup: setup() })
    game.dealGenerals()
    const stored = game.serialize()
    expect(stored.rngState).toBeGreaterThan(0)

    const restored = SanguoshaGame.restore(stored)
    // 恢复之后取的下一个随机数必须和没中断时一样
    expect(restored.rng.nextUint32()).toBe(game.rng.nextUint32())
  })

  it('恢复后技能触发器重新挂上了——它们序列化不了', () => {
    const game = new SanguoshaGame({ seed: 'restore-skills', setup: setup() })
    game.state.players.forEach((player, index) => {
      player.identity = index === 0 ? 'lord' : 'rebel'
      player.characterId = index === 1 ? 'guojia' : 'machao'
    })
    game.start()

    const restored = SanguoshaGame.restore(game.serialize())
    // 郭嘉受到伤害后应当排进遗计；触发器没挂上的话队列会是空的
    restored.damage({ sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'normal', cardName: '杀' })
    expect(restored.state.skillQueue.map((prompt) => prompt.skillId)).toContain('yiji')
  })

  it('整个状态能过 JSON，没有函数或循环引用', () => {
    const game = new SanguoshaGame({ seed: 'json-safe', setup: setup() })
    game.dealGenerals()
    const text = JSON.stringify(game.serialize())
    expect(JSON.parse(text)).toEqual(game.serialize())
  })
})
