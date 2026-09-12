import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { getDistance, canTarget, getAttackRange } from '../../engine/distance'
import { livingKingdomCount } from '../../engine/living-kingdoms'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 士燮（三国杀 OL 经典身份 SP）。
 *
 * 【避乱】：结束阶段，若存在其他角色与士燮的距离为1，可以弃置一张牌，
 *          令「其他角色→士燮」的距离永久 +X（X=当前存活势力数）。
 * 【礼下】：锁定技，其他角色 A 结束阶段开始时，若士燮不在 A 的攻击范围内，
 *          士燮必须从「自己摸1」「A摸2」「A回复1点体力」中选1~2项，每选
 *          一项令「其他角色→士燮」的距离永久 -1。
 *
 * 两个技能共用同一个「其他角色到士燮」方向的持久距离修正（一个数字 mark，
 * 可以互相抵消），走既有的 `distanceModifier.fromOthers` 钩子，不新建
 * 第二套距离系统。
 */

const BILUAN = 'biluan'
const LIXIA = 'lixia'
const DISTANCE_MARK = 'shixie-distance'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function adjustDistanceMark(state: SanguoshaState, ownerId: PlayerId, delta: number): void {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  const next = (owner.marks[DISTANCE_MARK] ?? 0) + delta
  if (next === 0) delete owner.marks[DISTANCE_MARK]
  else owner.marks[DISTANCE_MARK] = next
}

registerSkillRuntime({
  id: BILUAN,
  distanceModifier: {
    fromOthers(state, ownerId) {
      return playerOf(state, ownerId)?.marks[DISTANCE_MARK] ?? 0
    },
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      const nearby = host.state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && getDistance(host.state, candidate.id, ownerId) === 1)
      if (!nearby) return
      host.queueSkill({ skillId: BILUAN, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: BILUAN, ownerId, step: 'discard', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【避乱】：可以弃置一张牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!cardId || !owner?.alive || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: BILUAN }, { sourceId: ownerId, cardIds: [cardId] })
    const x = livingKingdomCount(host.state)
    adjustDistanceMark(host.state, ownerId, x)
    host.dispatch('SkillActivated', { skillId: BILUAN, skillName: '避乱', playerId: ownerId, logText: `${owner.nickname}发动【避乱】，距离+${x}` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: LIXIA,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const actorId = payload.playerId
      if (payload.phase !== 'finish' || !actorId || actorId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const actor = playerOf(host.state, actorId)
      if (!owner?.alive || !actor?.alive) return
      if (canTarget(host.state, actorId, ownerId, getAttackRange(host.state, actorId))) return
      host.queueSkill({ skillId: LIXIA, ownerId, step: 'choose', data: { actorId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    const { actorId } = prompt.data as { actorId: PlayerId }
    const actor = playerOf(host.state, actorId)
    if (!owner?.alive || !actor?.alive) return
    host.askSkill({
      skillId: LIXIA, ownerId, step: 'choose', data: { actorId },
      build: (requestId): ChooseOptionsRequest => ({
        id: requestId, kind: 'choose-options', playerId: ownerId,
        prompt: `【礼下】：${actor.nickname}不在你的攻击范围内，选择1~2项`, timeoutMs: 20_000, optional: false,
        options: [
          { id: 'self-draw', label: '士燮摸1张牌' },
          { id: 'target-draw', label: `${actor.nickname}摸2张牌` },
          { id: 'target-recover', label: `${actor.nickname}回复1点体力` },
        ],
        min: 1, max: 2,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const { actorId } = resolution.data as { actorId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const actor = playerOf(host.state, actorId)
    const optionIds = (response.payload as { optionIds?: string[] }).optionIds ?? []
    if (!owner?.alive || !actor?.alive || optionIds.length === 0) return
    for (const optionId of optionIds) {
      if (optionId === 'self-draw') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      else if (optionId === 'target-draw') drawCards(host.state, host.rng, actorId, 2, (name, payload) => { host.dispatch(name, payload) })
      else if (optionId === 'target-recover') recover(host as never, actorId, 1, ownerId)
    }
    adjustDistanceMark(host.state, ownerId, -optionIds.length)
    host.dispatch('SkillActivated', { skillId: LIXIA, skillName: '礼下', playerId: ownerId, targetId: actorId, logText: `${owner.nickname}发动【礼下】` }, { sourceId: ownerId, targetId: actorId })
  },
})

export const SHIXIE: CharacterDefinition = {
  id: 'shixie',
  name: '士燮',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: BILUAN, name: '避乱', description: '结束阶段，若存在其他角色与你的距离为1，可以弃置一张牌，令其他角色到你的距离永久+X（X为当前存活势力数）。' },
    { id: LIXIA, name: '礼下', description: '锁定技，其他角色结束阶段开始时，若你不在其攻击范围内，你须选择1~2项：自己摸1张牌/其摸2张牌/其回复1点体力，每选一项令其他角色到你的距离永久-1。' },
  ],
}
