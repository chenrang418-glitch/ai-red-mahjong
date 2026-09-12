import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 黄祖（三国杀 OL 经典身份 SP）。
 *
 * 【挽弓】：锁定技，黄祖使用【杀】时，若他此前使用的上一张牌是基本牌，
 *          这张【杀】无距离限制、无使用次数限制、造成的伤害+1——【杀】
 *          本身也是基本牌，所以一旦第一张强化杀打出，下一张杀的“上一张
 *          牌”仍是基本牌，能继续衔接。
 */

const WANGONG = 'wangong'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function lastWasBasic(state: SanguoshaState, ownerId: PlayerId): boolean {
  return state.huangzuLastBasic?.[ownerId] ?? false
}

registerSkillRuntime({
  id: WANGONG,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      if (payload.cancelled || !payload.cardId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const card = host.state.cards[payload.cardId]
      host.state.huangzuLastBasic ??= {}
      host.state.huangzuLastBasic[ownerId] = card?.category === 'basic'
    },
  }],

  slashIgnoresDistance(state, ownerId) {
    return lastWasBasic(state, ownerId)
  },

  ignoresSlashUsesTo(state, ownerId) {
    return lastWasBasic(state, ownerId)
  },

  outgoingDamage(state, ownerId, context) {
    if (context.cardName !== '杀' || !lastWasBasic(state, ownerId)) return null
    return { amount: context.amount + 1 }
  },
})

export const HUANGZU: CharacterDefinition = {
  id: 'huangzu',
  name: '黄祖',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: WANGONG, name: '挽弓', description: '锁定技，黄祖使用【杀】时，若他此前使用的上一张牌是基本牌，这张【杀】无距离限制、无使用次数限制，且造成的伤害+1。' },
  ],
}
