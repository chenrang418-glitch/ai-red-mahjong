import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 韩馥（三国杀 OL 经典身份 SP，当前 OL 束辎/恇守版本）。
 *
 * 【束辎】：出牌阶段限一次，韩馥交给一名角色A 2张牌，然后A交给韩馥1张
 *          手牌；若A给的牌与韩馥刚才给的两张中至少一张同名，韩馥可以对A
 *          造成1点伤害，或将场上一张牌移动至A的合法区域（复用既有
 *          `fieldMoveDestinations`/`moveFieldCard`）。
 * 【恇守】：锁定技，韩馥受到伤害后，摸3张牌，然后弃置X张牌，X为当前
 *          TurnInstance 中受到过伤害的不同角色数量（含韩馥自己）。
 */

const SHUZI = 'shuzi'
const KUANGSHOU = 'kuangshou'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: SHUZI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SHUZI) || owner.zones.hand.length < 2) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: SHUZI, label: '束辎：交给一名角色2张牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== SHUZI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SHUZI) || owner.zones.hand.length < 2) return
    host.askSkill({
      skillId: SHUZI, ownerId, step: 'give',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【束辎】：选择2张牌交给一名角色', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'give') {
      if (owner.turnUsedSkills.includes(SHUZI)) return
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (valid.length !== 2) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: SHUZI, ownerId, step: 'target', data: { cardIds: valid },
        build: (requestId) => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【束辎】：选择一名角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const { cardIds } = resolution.data as { cardIds: CardId[] }
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || valid.length !== 2) return
      owner.turnUsedSkills.push(SHUZI)
      const givenNames = valid.map((id) => host.state.cards[id]?.name)
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: target.id })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: SHUZI }, { sourceId: ownerId, cardIds: valid })
      host.dispatch('GainCard', { playerId: target.id, cardIds: valid, reason: SHUZI }, { targetId: target.id, cardIds: valid })
      host.dispatch('SkillActivated', { skillId: SHUZI, skillName: '束辎', playerId: ownerId, targetId: target.id, logText: `${owner.nickname}发动【束辎】` }, { sourceId: ownerId, targetId: target.id })
      if (target.zones.hand.length === 0) return
      host.askSkill({
        skillId: SHUZI, ownerId, step: 'return', data: { targetId: target.id, givenNames },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: target.id,
          prompt: `【束辎】：交给${owner.nickname}1张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'return') {
      const { targetId, givenNames } = resolution.data as { targetId: PlayerId; givenNames: Array<string | undefined> }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      const returnedName = host.state.cards[cardId]?.name
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: SHUZI }, { sourceId: targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SHUZI }, { targetId: ownerId, cardIds: [cardId] })
      if (!givenNames.includes(returnedName)) return
      host.askSkill({
        skillId: SHUZI, ownerId, step: 'choose', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【束辎】：请选择', timeoutMs: 20_000, optional: false,
          options: [
            { id: 'damage', label: `对${target.nickname}造成1点伤害` },
            { id: 'move', label: '移动场上一张牌' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choose') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'damage') {
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
        return
      }
      if (optionId === 'move') {
        const movable = host.state.players.flatMap((candidate) => candidate.alive
          ? [...Object.values(candidate.zones.equipment).filter((id): id is CardId => !!id), ...candidate.zones.judgingArea]
          : [])
        const eligible = movable.filter((cardId) => fieldMoveDestinations(host.state, cardId).includes(targetId))
        if (eligible.length === 0) return
        host.askSkill({
          skillId: SHUZI, ownerId, step: 'move-pick', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: '【束辎】：选择场上一张牌移动', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: eligible, hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
      }
      return
    }

    if (resolution.step === 'move-pick') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !fieldMoveDestinations(host.state, cardId).includes(targetId)) return
      moveFieldCard(host as never, cardId, targetId)
      host.dispatch('SkillActivated', { skillId: SHUZI, skillName: '束辎', playerId: ownerId, targetId, logText: `${owner.nickname}发动【束辎】，移动场上一张牌` }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: KUANGSHOU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const damagedId = context.event.targetId
      if (!damagedId) return
      if (host.state.hanfuDamagedTurn?.turnNumber !== host.state.turnNumber) host.state.hanfuDamagedTurn = { turnNumber: host.state.turnNumber, players: [] }
      if (!host.state.hanfuDamagedTurn.players.includes(damagedId)) host.state.hanfuDamagedTurn.players.push(damagedId)
      if (damagedId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: KUANGSHOU, ownerId, step: 'resolve', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'resolve') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.dispatch('SkillActivated', { skillId: KUANGSHOU, skillName: '恇守', playerId: ownerId, logText: `${owner.nickname}发动【恇守】` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
    const current = playerOf(host.state, ownerId)
    if (!current?.alive || current.zones.hand.length === 0) return
    const x = Math.min(host.state.hanfuDamagedTurn?.turnNumber === host.state.turnNumber ? host.state.hanfuDamagedTurn.players.length : 1, current.zones.hand.length)
    if (x <= 0) return
    host.askSkill({
      skillId: KUANGSHOU, ownerId, step: 'discard', data: { x },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【恇守】：弃置${x}张牌`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...current.zones.hand], hiddenCardSlots: [], min: x, max: x,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = cardIds.filter((id) => owner?.zones.hand.includes(id))
    if (!owner?.alive || valid.length === 0) return
    for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: KUANGSHOU }, { sourceId: ownerId, cardIds: valid })
  },
})

export const HANFU: CharacterDefinition = {
  id: 'hanfu',
  name: '韩馥',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: SHUZI, name: '束辎', description: '出牌阶段限一次，交给一名角色2张牌，其交给韩馥1张手牌；若牌名与之前给出的两张中至少一张相同，韩馥可以对其造成1点伤害或移动场上一张牌至其合法区域。' },
    { id: KUANGSHOU, name: '恇守', description: '锁定技，韩馥受到伤害后，摸3张牌，然后弃置X张牌，X为当前 TurnInstance 中受到过伤害的不同角色数量。' },
  ],
}
