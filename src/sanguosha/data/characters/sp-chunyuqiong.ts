import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 淳于琼（三国杀经典身份 SP）。
 *
 * 【仓储】：锁定技，游戏开始获得3枚【粮】，每有1枚手牌上限+1；自己回合外
 *          获得牌后获得1枚粮（每个 TurnInstance 限一次，总数不超过存活
 *          角色数）。
 * 【粮营】：弃牌阶段开始时，可以选择 N（1<=N<=粮数且有足够角色可分配），
 *          摸N张牌，然后选N名角色各交给1张。
 * 【失守】：锁定技，淳于琼使用一张【酒】后或受到一次火焰伤害后，失去
 *          1枚粮；准备阶段若没有粮，失去1点体力。
 */

const CANGCHU = 'cangchu'
const LIANGYING = 'liangying'
const SHISHOU = 'shishou'
const LIANG_MARK = 'liang'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function liangOf(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.marks[LIANG_MARK] ?? 0
}

registerSkillRuntime({
  id: CANGCHU,
  triggers: [
    {
      event: 'GameStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks[LIANG_MARK] = 3
      },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        if (host.state.currentPlayerId === ownerId) return
        if (host.state.cangchuGainTurn === host.state.turnNumber) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const cap = host.state.players.filter((candidate) => candidate.alive).length
        if (liangOf(host.state, ownerId) >= cap) return
        host.state.cangchuGainTurn = host.state.turnNumber
        owner.marks[LIANG_MARK] = liangOf(host.state, ownerId) + 1
      },
    },
  ],
  maxCardsBonus(state, ownerId) {
    return liangOf(state, ownerId)
  },
})

registerSkillRuntime({
  id: LIANGYING,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'discard' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || liangOf(host.state, ownerId) <= 0) return
      const otherCount = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).length
      if (otherCount === 0) return
      host.queueSkill({ skillId: LIANGYING, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || liangOf(host.state, ownerId) <= 0) return
    const otherCount = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).length
    const maxN = Math.min(liangOf(host.state, ownerId), otherCount)
    if (maxN <= 0) return
    const options = [{ id: '0', label: '不发动' }, ...Array.from({ length: maxN }, (_, index) => ({ id: String(index + 1), label: `N = ${index + 1}` }))]
    host.askSkill({
      skillId: LIANGYING, ownerId, step: 'count',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【粮营】：选择 N', timeoutMs: 20_000, optional: true, options,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'count') {
      const n = Number((response.payload as { optionId?: string }).optionId ?? '0')
      if (!n || n <= 0) return
      owner.marks[LIANG_MARK] = liangOf(host.state, ownerId) - n
      host.dispatch('SkillActivated', { skillId: LIANGYING, skillName: '粮营', playerId: ownerId, logText: `${owner.nickname}发动【粮营】，N=${n}` }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, n, (name, payload) => { host.dispatch(name, payload) })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      host.askSkill({
        skillId: LIANGYING, ownerId, step: 'targets', data: { remaining: n },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【粮营】：选择${n}名角色，各交给1张牌`, timeoutMs: 20_000, optional: false, candidateIds, min: n, max: n,
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const validIds = targetIds.filter((id) => playerOf(host.state, id)?.alive)
      if (validIds.length === 0) return
      host.askSkill({
        skillId: LIANGYING, ownerId, step: 'give', data: { queue: validIds },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【粮营】：交给${playerOf(host.state, validIds[0])?.nickname ?? ''}1张牌`, timeoutMs: 20_000, optional: owner.zones.hand.length === 0,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: owner.zones.hand.length === 0 ? 0 : 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const { queue } = resolution.data as { queue: PlayerId[] }
      const [recipientId, ...rest] = queue
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const recipient = playerOf(host.state, recipientId)
      if (cardId && recipient?.alive && owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: recipientId })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: LIANGYING }, { sourceId: ownerId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: recipientId, cardIds: [cardId], reason: LIANGYING }, { targetId: recipientId, cardIds: [cardId] })
      }
      if (rest.length === 0) return
      host.askSkill({
        skillId: LIANGYING, ownerId, step: 'give', data: { queue: rest },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【粮营】：交给${playerOf(host.state, rest[0])?.nickname ?? ''}1张牌`, timeoutMs: 20_000, optional: owner.zones.hand.length === 0,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: owner.zones.hand.length === 0 ? 0 : 1, max: 1,
        }),
      })
    }
  },
})

registerSkillRuntime({
  id: SHISHOU,
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string; cancelled?: boolean }
        if (context.event.sourceId !== ownerId || payload.cancelled || payload.cardName !== '酒') return
        applyShishou(host, ownerId)
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId || context.event.damageNature !== 'fire') return
        applyShishou(host, ownerId)
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || liangOf(host.state, ownerId) > 0) return
        // 阶段开始这个时机不安全，可能级联出濒死求救之类的挂起流程——排到队列里再结算
        host.queueSkill({ skillId: SHISHOU, ownerId, step: 'lose-hp', data: {} })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'lose-hp') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || liangOf(host.state, ownerId) > 0) return
    loseHp(host as never, ownerId, 1, SHISHOU)
  },
})

function applyShishou(host: { state: SanguoshaState; dispatch: (name: 'SkillActivated', payload?: Record<string, unknown>, meta?: Record<string, unknown>) => unknown }, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || liangOf(host.state, ownerId) <= 0) return
  owner.marks[LIANG_MARK] = liangOf(host.state, ownerId) - 1
  host.dispatch('SkillActivated', { skillId: SHISHOU, skillName: '失守', playerId: ownerId, logText: `${owner.nickname}发动【失守】，失去1枚粮` }, { sourceId: ownerId })
}

export const CHUNYUQIONG: CharacterDefinition = {
  id: 'chunyuqiong',
  name: '淳于琼',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 5,
  pack: 'sp',
  skills: [
    { id: CANGCHU, name: '仓储', description: '锁定技，游戏开始获得3枚【粮】，每有1枚手牌上限+1；自己回合外获得牌后获得1枚粮（每次获得牌只算一次，总数不超过存活角色数）。' },
    { id: LIANGYING, name: '粮营', description: '弃牌阶段开始时，可以选择 N（1到当前粮数，且不超过其他存活角色数），摸N张牌，然后选N名角色，各交给其1张牌。' },
    { id: SHISHOU, name: '失守', description: '锁定技，淳于琼使用一张【酒】后或受到一次火焰伤害后，失去1枚粮；准备阶段，若没有粮，失去1点体力。' },
  ],
}
