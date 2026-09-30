import { describe, expect, it } from 'vitest'
import { aiProfileForDifficulty, decidePlayAction, decideResponse, type AIContext, type AIDifficulty } from '@/sanguosha/ai/index'
import { emptySuspicion } from '@/sanguosha/ai/belief'
import { runSoakGame } from '@/sanguosha/ai/soak'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { GameRng } from '@/sanguosha/engine/rng'
import type { LegalAction } from '@/sanguosha/engine/actions'
import type { GameRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

function gameForDifficulty(seed = 'ai-difficulty'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = identities[index] === 'lord'
    player.characterId = 'machao'
  })
  game.start()
  return game
}

function context(
  game: SanguoshaGame,
  playerId: string,
  difficulty: AIDifficulty,
  suspicion = emptySuspicion(game.viewFor(playerId)),
  seed = difficulty,
): AIContext {
  return { view: game.viewFor(playerId), difficulty, rng: new GameRng(`difficulty:${seed}`), suspicion }
}

describe('AI 难度分层', () => {
  it('三档映射为不同策略，而不是只换一档随机数', () => {
    expect(aiProfileForDifficulty('easy')).toMatchObject({ useSuspicion: false, directOnly: true, lookahead: false })
    expect(aiProfileForDifficulty('normal')).toMatchObject({ useSuspicion: true, directOnly: false, lookahead: false })
    expect(aiProfileForDifficulty('hard')).toMatchObject({ useSuspicion: true, directOnly: false, lookahead: true })
    expect(new Set(['easy', 'normal', 'hard'].map((level) => JSON.stringify(aiProfileForDifficulty(level as AIDifficulty)))).size).toBe(3)
  })

  it('简单档不使用行为推断，普通和困难档会使用', () => {
    const game = gameForDifficulty('difficulty-suspicion')
    const suspicion = emptySuspicion(game.viewFor('p2'))
    suspicion.p1 = -8
    const request = {
      id: 'rescue-test', kind: 'rescue', playerId: 'p2', prompt: '是否救援', timeoutMs: 20_000,
      dyingPlayerId: 'p1', requiredRecover: 1, actionIds: ['rescue:peach', 'rescue-pass'],
    } as GameRequest

    expect((decideResponse(context(game, 'p2', 'easy', suspicion), request).payload as { actionId: string }).actionId).toBe('rescue-pass')
    expect((decideResponse(context(game, 'p2', 'normal', suspicion), request).payload as { actionId: string }).actionId).toBe('rescue:peach')
    expect((decideResponse(context(game, 'p2', 'hard', suspicion), request).payload as { actionId: string }).actionId).toBe('rescue:peach')
  })

  it('马钧【巧思】AI 不重复点亮阀门，并优先把等量牌交给友方', () => {
    const game = gameForDifficulty('ai-qiaosi')
    const makeRequest = (active: number[], progress: number[]) => ({
      id: 'qiaosi-waterwheel', kind: 'choose-option' as const, playerId: 'p2', prompt: '操作水转百戏图',
      timeoutMs: 10_000, optional: true, skillId: 'qiaosi-b35', skillStep: 'waterwheel',
      options: Array.from({ length: 6 }, (_, index) => ({ id: `valve:${index}`, label: `阀门${index}` })),
      interaction: { kind: 'waterwheel' as const, active, progress },
    })
    const ai = context(game, 'p2', 'normal')
    expect((decideResponse(ai, makeRequest([], [0, 0, 0, 0, 0, 0])).payload as any).optionId).toBe('valve:0')
    expect((decideResponse(ai, makeRequest([0], [3, 0, 0, 0, 0, 0])).payload as any).optionId).toBe('valve:5')
    expect((decideResponse(ai, makeRequest([0, 5], [3, 0, 0, 0, 0, 3])).payload as any).optionId).toBe('valve:2')

    const payment = {
      id: 'qiaosi-payment', kind: 'choose-option' as const, playerId: 'p2', prompt: '选择一项', timeoutMs: 10_000,
      optional: false, skillId: 'qiaosi-b35', skillStep: 'payment-mode',
      options: [{ id: 'discard', label: '弃牌' }, { id: 'give', label: '交给角色' }],
    }
    expect((decideResponse(ai, payment).payload as any).optionId).toBe('give')
    const target = {
      id: 'qiaosi-target', kind: 'choose-targets' as const, playerId: 'p2', prompt: '选择目标', timeoutMs: 10_000,
      optional: false, skillId: 'qiaosi-b35', skillStep: 'payment-target', candidateIds: ['p0', 'p1'], min: 1, max: 1,
    }
    expect((decideResponse(ai, target).payload as any).targetIds).toEqual(['p0'])
  })

  it('庞德公【评才】AI 选择当前缺血时的玄剑并完成擦拭步骤', () => {
    const game = gameForDifficulty('ai-pingcai')
    const pang = game.state.players.find(player => player.id === 'p2')!
    pang.hp = 2
    const ai = context(game, 'p2', 'normal')
    const select = {
      id: 'pingcai-select', kind: 'choose-option' as const, playerId: 'p2', prompt: '选择宝物', timeoutMs: 20_000,
      optional: false, skillId: 'pingcai-b35', skillStep: 'select-treasure',
      options: ['wolong', 'fengchu', 'shuijing', 'xuanjian'].map(id => ({ id, label: id })),
    }
    expect((decideResponse(ai, select).payload as any).optionId).toBe('xuanjian')
    const scratch = {
      ...select, id: 'pingcai-scratch', skillStep: 'scratch',
      options: [{ id: 'scratch-complete', label: '完成' }, { id: 'scratch-stop', label: '停止' }],
      interaction: { kind: 'pingcai-scratch' as const, treasure: 'xuanjian' as const, cellCount: 16 },
    }
    expect(decideResponse(ai, scratch).payload).toEqual({ optionId: 'scratch-complete', scratchedCells: Array.from({ length: 16 }, (_, index) => index) })
  })

  it('困难档会把可确认的击杀排在纯摸牌收益前面', () => {
    const game = gameForDifficulty('difficulty-lethal')
    const target = game.state.players.find((player) => player.id === 'p1')!
    target.hp = 1
    game.state.players.find((player) => player.id === 'p2')!.hp = 3
    const actions: LegalAction[] = [
      { id: 'recover', kind: 'use-card', playerId: 'p2', label: '使用桃', cardIds: ['peach-card'], targetIds: [], targetMin: 0, targetMax: 0, asCardName: '桃' },
      { id: 'lethal', kind: 'use-card', playerId: 'p2', label: '使用杀', cardIds: ['slash-card'], targetIds: ['p1'], targetMin: 1, targetMax: 1, asCardName: '杀' },
    ]

    expect(decidePlayAction(context(game, 'p2', 'normal'), actions)?.id).toBe('recover')
    expect(decidePlayAction(context(game, 'p2', 'hard'), actions)?.id).toBe('lethal')
  })

  it('同一批种子下三档的回合与技能行为计数不同', () => {
    const signature = (difficulty: AIDifficulty) => {
      let turns = 0
      let skills = 0
      for (let index = 0; index < 30; index += 1) {
        const result = runSoakGame({ seed: `difficulty-behaviour-${index}`, playerCount: 5, difficulty })
        turns += result.turns
        skills += Object.entries(result.counters)
          .filter(([key]) => key.startsWith('skill:'))
          .reduce((sum, [, count]) => sum + count, 0)
      }
      return `${turns}:${skills}`
    }

    expect(new Set(['easy', 'normal', 'hard'].map((level) => signature(level as AIDifficulty))).size).toBe(3)
  }, 120_000)

  it('同一批 100 个对抗样本中，困难档击杀决策至少胜过简单档 60 次', () => {
    const game = gameForDifficulty('difficulty-match')
    for (const playerId of ['p1', 'p3', 'p4']) {
      const player = game.state.players.find((candidate) => candidate.id === playerId)!
      player.hp = 1
      while (player.zones.hand.length > 2) player.zones.hand.pop()
    }
    const suspicion = emptySuspicion(game.viewFor('p2'))
    suspicion.p1 = 8
    suspicion.p3 = -8
    suspicion.p4 = -8
    const actions: LegalAction[] = ['p1', 'p3', 'p4'].map((targetId) => ({
      id: `slash-${targetId}`, kind: 'use-card', playerId: 'p2', label: `对${targetId}使用杀`,
      cardIds: ['slash-card'], targetIds: [targetId], targetMin: 1, targetMax: 1, asCardName: '杀',
    }))

    let hardWins = 0
    for (let index = 0; index < 100; index += 1) {
      const easy = decidePlayAction(context(game, 'p2', 'easy', suspicion, `match-${index}`), actions)
      const hard = decidePlayAction(context(game, 'p2', 'hard', suspicion, `match-${index}`), actions)
      expect(hard?.id).toBe('slash-p1')
      if (easy?.id !== hard?.id) hardWins += 1
    }
    expect(hardWins).toBeGreaterThanOrEqual(60)
  })
})
