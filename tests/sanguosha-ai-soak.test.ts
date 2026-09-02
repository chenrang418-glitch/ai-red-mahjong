import { describe, expect, it } from 'vitest'
import { runSoakBatch, runSoakGame } from '@/sanguosha/ai/soak'
import { decideResponse, type AIContext } from '@/sanguosha/ai'
import { emptySuspicion } from '@/sanguosha/ai/belief'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { GameRng } from '@/sanguosha/engine/rng'
import type { GameSetup } from '@/sanguosha/engine/types'

function setupFor(count: number): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, nickname: `AI${index}`, isHuman: false })),
  }
}

describe('AI 只能看见该看见的', () => {
  it('PlayerView 不包含别人的手牌和未公开身份', () => {
    const game = new SanguoshaGame({ seed: 'ai-privacy', setup: setupFor(5) })
    game.dealGenerals()
    while (game.state.pendingRequests.length > 0) {
      const request = game.state.pendingRequests[0]
      if (request.kind !== 'choose-general') break
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { characterId: request.candidates[0] } })
    }
    game.start()

    const view = game.viewFor('p0')
    for (const player of view.players) {
      if (player.id === 'p0') continue
      // 别人的手牌只有张数，没有内容
      expect(player.hand).toBeNull()
      expect(player.handCount).toBeGreaterThan(0)
      // 未公开身份就是 null，AI 想作弊也读不到
      if (player.identityHidden) expect(player.identity).toBeNull()
    }
    // 真实手牌 id 一个都不该出现在视图里。
    // 注意要连引号一起比：卡牌 id 形如 ruleset-v1:maneuvering:4，
    // 裸子串会和 ...:47 这种合法可见的牌撞上，测出假阳性。
    const serialized = JSON.stringify(view)
    for (const cardId of game.state.players[1].zones.hand) expect(serialized).not.toContain(`"${cardId}"`)
  })
})

describe('AI 对每一种 Request 都能给出合法响应', () => {
  // 漏掉任何一种，牌局就会停在那里。这里逐个构造，不依赖随机对局碰运气。
  const game = new SanguoshaGame({ seed: 'ai-requests', setup: setupFor(5) })
  const context: AIContext = {
    view: game.viewFor('p0'),
    difficulty: 'normal',
    rng: new GameRng('ai-requests'),
    suspicion: emptySuspicion(game.viewFor('p0')),
  }
  const base = { id: 'r1', playerId: 'p0', prompt: '', timeoutMs: 1000, optional: false } as const

  const cases = [
    { kind: 'choose-general', candidates: ['guanyu', 'zhangfei'], min: 1, max: 1 },
    { kind: 'choose-cards', cardIds: ['c1', 'c2'], hiddenCardSlots: [], min: 1, max: 1 },
    { kind: 'choose-cards', cardIds: [], hiddenCardSlots: ['hidden:p1:0'], min: 1, max: 1 },
    { kind: 'choose-targets', candidateIds: ['p1', 'p2'], min: 1, max: 1 },
    { kind: 'choose-option', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    { kind: 'choose-suit', suits: ['heart', 'spade'] },
    { kind: 'choose-number', min: 1, max: 3 },
    { kind: 'use-card', actionIds: ['play:x', 'respond-pass'] },
    { kind: 'respond-card', actionIds: ['respond-dodge:c1', 'respond-pass'], requiredCardName: '闪' },
    { kind: 'invoke-skill', skillId: 'kurou', actionIds: ['skill:kurou'] },
    { kind: 'arrange-cards', cardIds: ['c1', 'c2', 'c3'], minTop: 1, maxTop: 2, allowBottom: true },
    { kind: 'distribute-cards', cardIds: ['c1', 'c2'], recipientIds: ['p1', 'p2'], min: 1, max: 2 },
    { kind: 'rescue', dyingPlayerId: 'p1', actionIds: ['rescue:c1', 'rescue-pass'], requiredRecover: 1 },
  ] as const

  for (const shape of cases) {
    it(`${shape.kind} 有响应`, () => {
      const request = { ...base, ...shape } as never
      const response = decideResponse(context, request)
      expect(response.requestId).toBe('r1')
      expect(response.playerId).toBe('p0')
      expect(response.payload).toBeTypeOf('object')
      expect(response.payload).not.toBeNull()
    })
  }
})

describe('AI 技能目标', () => {
  it('回复体力类技能优先选择友方，不会给敌人续命', () => {
    const game = new SanguoshaGame({ seed: 'ai-heal-target', setup: setupFor(5) })
    game.state.players[0].identity = 'loyalist'
    game.state.players[1].identity = 'lord'
    game.state.players[1].identityRevealed = true
    game.state.players[1].hp = 2
    game.state.players[2].identity = 'rebel'
    game.state.players[2].identityRevealed = true
    game.state.players[2].hp = 1
    const view = game.viewFor('p0')
    const context: AIContext = {
      view,
      difficulty: 'normal',
      rng: new GameRng('ai-heal-target'),
      suspicion: emptySuspicion(view),
    }
    const response = decideResponse(context, {
      id: 'heal-target', kind: 'choose-targets', playerId: 'p0', prompt: '选择回复体力的角色',
      timeoutMs: 1000, optional: false, candidateIds: ['p1', 'p2'], min: 1, max: 1,
    })
    expect(response.payload).toEqual({ targetIds: ['p1'] })
  })
})

describe('无头压测', () => {
  it('五人局固定 seed 可复现', () => {
    const first = runSoakGame({ seed: 'repeat-me', playerCount: 5 })
    const second = runSoakGame({ seed: 'repeat-me', playerCount: 5 })
    expect(second).toEqual(first)
  })

  for (const count of [5, 6, 7, 8]) {
    it(`${count} 人局 40 局全部正常结束`, () => {
      const results = runSoakBatch(40, count, 'ci')
      // 不死循环、不抛异常、不出现非法状态（牌张守恒和 invariant 在每一步都查过）
      expect(results.every((result) => result.finished)).toBe(true)
      expect(results.every((result) => result.survivors >= 1)).toBe(true)
      expect(results.every((result) => result.winningCamp !== null)).toBe(true)
      // 回合数应当在合理区间，异常短或异常长都说明规则出了问题
      const turns = results.map((result) => result.turns)
      expect(Math.min(...turns)).toBeGreaterThan(1)
      expect(Math.max(...turns)).toBeLessThan(300)
    }, 60_000)
  }
})
