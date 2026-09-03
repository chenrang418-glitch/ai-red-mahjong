import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { recover } from '../../engine/recover'
import type { ChooseCardsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

const ZUINAO = 'zuinao'
const HUDU = 'hudu'
const DRUNK = 'zuinao:drunk'
const DRUNK_SLASH = 'zuinao:slash-active'
const HUDU_ROUND = 'hudu:round'
const HUDU_USED_ROUND = 'hudu:used-round'
const damagedKey = (targetId: PlayerId) => `hudu:damaged:${targetId}`

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) throw new Error(`玩家不存在：${playerId}`)
  return player
}

function isRoundStart(state: SanguoshaState, playerId: PlayerId): boolean {
  return state.players.reduce((seat, player) => Math.min(seat, player.seat), Number.MAX_SAFE_INTEGER)
    === playerOf(state, playerId).seat
}

function discardableIds(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  return [
    ...player.zones.hand,
    ...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id)),
  ]
}

function discardCost(host: SkillHost, playerId: PlayerId, cardId: CardId): boolean {
  const from = locateOwnedCard(host.state, playerId, cardId)
  if (!from || from.kind === 'judgingArea') return false
  moveCard(host.state, cardId, from, { kind: 'discardPile' })
  if (from.kind === 'equipment') handleEquipmentLost(host, playerId, cardId)
  host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: HUDU }, { sourceId: playerId, cardIds: [cardId] })
  return true
}

registerSkillRuntime({
  id: ZUINAO,
  announcesSelf: true,
  slashIgnoresDistance(state, ownerId) {
    return playerOf(state, ownerId).marks[DRUNK] === 1
  },
  modifySlashTargets(host, ownerId, targetIds, candidateIds) {
    const owner = playerOf(host.state, ownerId)
    if (owner.marks[DRUNK] !== 1) return targetIds
    owner.marks[DRUNK_SLASH] = 1
    host.dispatch('SkillActivated', {
      playerId: ownerId, skillId: ZUINAO, result: 'drunk-slash',
      logText: `${owner.nickname}发动【醉闹】`,
    }, { sourceId: ownerId, targetId: targetIds[0] })
    if (candidateIds.length === 0) return targetIds
    const extra = host.rng.pick(candidateIds)
    host.dispatch('SkillActivated', {
      playerId: ownerId, skillId: ZUINAO, result: 'extra-target', targetIds: [extra],
      logText: '醉意之下，另一名角色也成为【杀】的目标',
    }, { sourceId: ownerId, targetId: extra })
    return [...targetIds, extra]
  },
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardName?: unknown; cancelled?: unknown }
        const cardName = String(payload.cardName ?? '')
        const owner = playerOf(host.state, ownerId)
        if (cardName === '酒' && payload.cancelled !== true) {
          owner.marks[DRUNK] = 1
          host.dispatch('SkillActivated', {
            playerId: ownerId, skillId: ZUINAO, result: 'drunk', logText: `${owner.nickname}喝醉了`,
          }, { sourceId: ownerId })
          return
        }
        if (cardName === '杀' && owner.marks[DRUNK_SLASH]) {
          delete owner.marks[DRUNK]
          delete owner.marks[DRUNK_SLASH]
          host.dispatch('SkillActivated', { playerId: ownerId, skillId: ZUINAO, result: 'drunk-cleared' }, { sourceId: ownerId })
        }
      },
    },
    {
      event: 'DamageCaused', priority: 30,
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        const target = host.state.players.find((candidate) => candidate.id === context.event.targetId)
        const payload = context.event.payload as { cardName?: unknown; amount?: number }
        if (context.event.sourceId !== ownerId || owner.marks[DRUNK_SLASH] !== 1
          || payload.cardName !== '杀' || target?.characterId !== 'pingtoufangkuai') return
        payload.amount = Math.max(0, Math.trunc(Number(payload.amount ?? 0))) + 1
        host.dispatch('SkillActivated', {
          playerId: ownerId, skillId: ZUINAO, result: 'pingtou-bonus', targetIds: [target.id],
          logText: `${owner.nickname}对平头方块造成的伤害+1`,
        }, { sourceId: ownerId, targetId: target.id })
      },
    },
  ],
})

registerSkillRuntime({
  id: HUDU,
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const playerId = String((context.event.payload as { playerId?: unknown }).playerId ?? '')
        if (!isRoundStart(host.state, playerId)) return
        const owner = playerOf(host.state, ownerId)
        owner.marks[HUDU_ROUND] = (owner.marks[HUDU_ROUND] ?? 0) + 1
        for (const key of Object.keys(owner.marks)) {
          if (key.startsWith('hudu:damaged:')) delete owner.marks[key]
        }
      },
    },
    {
      event: 'AfterDamage', priority: -50,
      handle(host, ownerId, context) {
        const targetId = context.event.targetId
        if (!targetId || targetId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        const target = host.state.players.find((candidate) => candidate.id === targetId)
        const round = owner.marks[HUDU_ROUND] ?? 1
        if (context.event.sourceId === ownerId) owner.marks[damagedKey(targetId)] = round
        if (!owner.alive || !target?.alive || target.hp >= target.maxHp || target.hp > owner.hp) return
        if (owner.marks[HUDU_USED_ROUND] === round || discardableIds(host.state, ownerId).length === 0) return
        host.queueSkill({ skillId: HUDU, ownerId, step: 'heal', data: { targetId, round } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'heal') return
    const owner = playerOf(host.state, ownerId)
    const targetId = String(prompt.data.targetId ?? '')
    const target = host.state.players.find((candidate) => candidate.id === targetId)
    const round = Number(prompt.data.round ?? 0)
    const cardIds = discardableIds(host.state, ownerId)
    if (!target?.alive || targetId === ownerId || target.hp >= target.maxHp || target.hp > owner.hp
      || owner.marks[HUDU_USED_ROUND] === round || round !== (owner.marks[HUDU_ROUND] ?? 1) || cardIds.length === 0) return
    host.askSkill({
      skillId: HUDU, ownerId, step: 'heal', data: { targetId, round },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `是否发动【护犊】令${target.nickname}回复1点体力？选择一张牌弃置，或取消`,
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'heal') return
    const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
    if (!cardId) return
    const owner = playerOf(host.state, ownerId)
    const targetId = String(resolution.data.targetId ?? '')
    const target = host.state.players.find((candidate) => candidate.id === targetId)
    const round = Number(resolution.data.round ?? 0)
    if (!target?.alive || targetId === ownerId || target.hp >= target.maxHp || target.hp > owner.hp
      || owner.marks[HUDU_USED_ROUND] === round || round !== (owner.marks[HUDU_ROUND] ?? 1)) return
    if (!discardCost(host, ownerId, cardId)) return
    owner.marks[HUDU_USED_ROUND] = round
    recover(host, targetId, 1, ownerId)
    host.dispatch('SkillActivated', {
      playerId: ownerId, skillId: HUDU, result: 'heal', targetIds: [targetId],
      logText: `${owner.nickname}发动【护犊】`,
    }, { sourceId: ownerId, targetId })
    if (owner.marks[damagedKey(targetId)] === round) {
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, { ...payload, reason: HUDU }))
    }
  },
})

export const SHANSHUI: CharacterDefinition = {
  id: 'shanshui', name: '善水', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'entertainment',
  skills: [
    {
      id: ZUINAO, name: '醉闹',
      description: '当你使用【酒】后，你获得“醉”。你下一张【杀】无距离限制，并随机增加一名其他合法角色为目标；若此【杀】的目标包含平头方块，你对平头方块造成的伤害+1。此【杀】结算后移去“醉”。',
    },
    {
      id: HUDU, name: '护犊',
      description: '每轮限一次，当其他角色受到伤害后，若其体力值不高于你，你可以弃置1张牌令其回复1点体力；若其本轮曾受到你造成的伤害，你再摸1张牌。',
    },
  ],
}
