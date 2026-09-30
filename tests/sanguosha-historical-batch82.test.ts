import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { instantTrickActions } from '@/sanguosha/engine/cards/tricks'
import { createVirtualTrick } from '@/sanguosha/engine/virtual-trick'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH82_CHARACTERS } from '@/sanguosha/data/characters/historical-batch82'
import type { PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 6 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((entry) => { entry.characterId = null })
  return game
}

function batchState(state: SanguoshaState): Record<string, any> {
  const extended = state as SanguoshaState & { b82?: Record<string, any> }
  extended.b82 ??= {}
  return extended.b82
}

describe('武将册第82批运行时', () => {
  it('十名武将都在总注册表中，且每个技能均有运行时', () => {
    expect(HISTORICAL_BATCH82_CHARACTERS).toHaveLength(10)
    expect(new Set(HISTORICAL_BATCH82_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    for (const character of HISTORICAL_BATCH82_CHARACTERS) {
      expect(ALL_CHARACTERS.some(({ id }) => id === character.id), character.name).toBe(true)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}/${skill.name}`).toBeDefined()
    }
  })

  it('【斗围】的实体锦囊目标生成允许选择多个、且只从“攻击范围包含你”的名单中选', () => {
    const game = gameFor('b82-douwei-targets')
    const [owner, first, second, third, excluded] = game.state.players
    owner!.characterId = 'mou-dongcheng-b82'
    const cardId = createVirtualTrick(game.state, owner!.id, '决斗', 'test-douwei')
    batchState(game.state).douweiPending = { [owner!.id]: { cardId, cardName: '决斗', targetIds: [first!.id, second!.id, third!.id] } }
    const actions = instantTrickActions(game.state, owner!.id, cardId, '决斗')
      .filter((action) => action.kind === 'use-card')
    expect(actions.some((action) => action.kind === 'use-card' && action.targetIds.length === 3)).toBe(true)
    const multiTargetActions = actions.filter((action) => action.kind === 'use-card' && action.targetIds.length > 1)
    expect(multiTargetActions.every((action) => action.kind !== 'use-card'
      || action.targetIds.every((id) => [first!.id, second!.id, third!.id].includes(id)))).toBe(true)
    expect(multiTargetActions.every((action) => action.kind !== 'use-card' || !action.targetIds.includes(excluded!.id))).toBe(true)
  })

  it('【势谋】额外目标与弃牌分支重复结算都绑定到该次虚拟锦囊牌ID', () => {
    const game = gameFor('b82-shimou-target-bonus')
    const [owner, actor, first, second, third] = game.state.players
    owner!.characterId = 'mou-xunyu-b82'
    const cardId = createVirtualTrick(game.state, actor!.id, '决斗', 'test-shimou')
    batchState(game.state).shimouTargetBonus = { [owner!.id]: { actorId: actor!.id, cardId, drawn: true } }
    batchState(game.state).shimouRepeat = { [owner!.id]: { cardId, repeat: true } }
    const actions = instantTrickActions(game.state, actor!.id, cardId, '决斗')
      .filter((action) => action.kind === 'use-card')
    expect(actions.some((action) => action.kind === 'use-card' && action.targetIds.length === 2)).toBe(true)
    const runtime = getSkillRuntime('shimou-mou-xunyu-b82')!
    expect(runtime.globalRepeatTargetEffectCount?.(game.state, owner!.id, actor!.id as PlayerId, first!.id, cardId)).toBe(1)
    expect(runtime.globalRepeatTargetEffectCount?.(game.state, owner!.id, actor!.id as PlayerId, second!.id, `other:${cardId}` as never)).toBe(0)
    expect(third!.alive).toBe(true)
  })
})
