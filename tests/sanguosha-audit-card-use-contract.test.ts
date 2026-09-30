import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { isCardUseLocked } from '@/sanguosha/engine/card-play-lock'
import { isCardUseProhibited, isResponseCardProhibited, registerSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'

const CONTEXT_SKILL = 'audit:context-use-contract'
const PHYSICAL_SKILL = 'audit:physical-use-contract'

registerSkillRuntime({
  id: CONTEXT_SKILL,
  prohibitsCardUse(state, ownerId, context) {
    expect(typeof context).toBe('object')
    const owner = state.players.find((player) => player.id === ownerId)!
    return owner.marks.auditContextBlocked === 1 && context.userId === ownerId
      && (context.cardIds ?? []).includes(owner.zones.hand[0])
  },
})

registerSkillRuntime({
  id: PHYSICAL_SKILL,
  prohibitsCardIdUse(state, ownerId, cardId) {
    expect(typeof cardId).toBe('string')
    const owner = state.players.find((player) => player.id === ownerId)!
    return owner.marks.auditPhysicalBlocked === 1 && cardId === owner.zones.hand[0]
  },
})

function fixture() {
  const game = new SanguoshaGame({ seed: 'audit-card-use-contract', setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.players.forEach((player) => { player.characterId = 'zhangfei' })
  const owner = game.state.players[0]
  owner.grantedSkills.push(CONTEXT_SKILL, PHYSICAL_SKILL)
  for (const cardId of game.state.zones.drawPile.slice(0, 2)) {
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
  }
  return { game, owner, blockedId: owner.zones.hand[0], otherId: owner.zones.hand[1] }
}

describe('审计回归：实体牌与上下文用牌限制契约', () => {
  it('实体入口不向上下文处理器传字符串，上下文入口保留实体子牌信息', () => {
    const { game, owner, blockedId } = fixture()
    owner.marks.auditContextBlocked = 1
    expect(isCardUseLocked(game.state, owner.id, blockedId)).toBe(false)
    expect(isCardUseProhibited(game.state, owner.id, '杀', { dyingPlayerId: null, cardIds: [blockedId] })).toBe(true)
  })

  it('实体限制只拦截对应牌与拥有者，解除条件后恢复', () => {
    const { game, owner, blockedId, otherId } = fixture()
    owner.marks.auditPhysicalBlocked = 1
    expect(isCardUseLocked(game.state, owner.id, blockedId)).toBe(true)
    expect(isCardUseLocked(game.state, owner.id, otherId)).toBe(false)
    expect(isCardUseLocked(game.state, 'p1', blockedId)).toBe(false)
    owner.marks.auditPhysicalBlocked = 0
    expect(isCardUseLocked(game.state, owner.id, blockedId)).toBe(false)
  })

  it('实体主动使用限制不错误禁止打出或响应', () => {
    const { game, owner, blockedId } = fixture()
    owner.marks.auditPhysicalBlocked = 1
    expect(isCardUseLocked(game.state, owner.id, blockedId)).toBe(true)
    expect(isResponseCardProhibited(game.state, owner.id, blockedId, '杀')).toBe(false)
  })

  it('无实体牌及不相关实体牌仍以对象契约查询，不虚构子牌', () => {
    const { game, owner, otherId } = fixture()
    owner.marks.auditContextBlocked = 1
    expect(isCardUseProhibited(game.state, owner.id, '杀', { dyingPlayerId: null })).toBe(false)
    expect(isCardUseProhibited(game.state, owner.id, '杀', { dyingPlayerId: null, cardIds: [] })).toBe(false)
    expect(isCardUseProhibited(game.state, owner.id, '杀', { dyingPlayerId: null, cardIds: [otherId] })).toBe(false)
    expect(isCardUseProhibited(game.state, 'p1', '杀', { dyingPlayerId: null, cardIds: [otherId] })).toBe(false)
  })
})
