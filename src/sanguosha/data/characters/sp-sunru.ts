import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { handleEquipmentLost } from '../../engine/equipment'
import { ABOLISHABLE_SLOTS, abolishSlot, restoreSlot, abolishableSlotsOf, abolishedSlotsOf } from '../../engine/equipment-slots'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孙茹（三国杀 OL 经典身份 SP）。
 *
 * 【持室】：每个 TurnInstance 限一次，当前回合角色A失去其某一区域（手牌/
 *          装备区/判定区）内最后一张牌后，你可以发动：A摸2张牌，且A本
 *          回合MaxCards+2。
 * 【慰勉】：出牌阶段限一次，废除自己至多3个（至少1个）未废除的装备栏，
 *          N为实际废除数量；选择一名角色，其选择N项不同的效果：恢复一个
 *          被废除的装备栏/回复1点体力/弃置所有手牌然后摸4张。
 */

const CHISHI = 'chishi'
const WEIMIAN = 'weimian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function zoneCounts(state: SanguoshaState, playerId: PlayerId) {
  const player = playerOf(state, playerId)
  if (!player) return { hand: 0, equipment: 0, judgment: 0 }
  return {
    hand: player.zones.hand.length,
    equipment: Object.values(player.zones.equipment).filter(Boolean).length,
    judgment: player.zones.judgingArea.length,
  }
}

registerSkillRuntime({
  id: CHISHI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || !payload.playerId) return
        host.state.sunruSnapshot = { turnNumber: host.state.turnNumber, playerId: payload.playerId, ...zoneCounts(host.state, payload.playerId) }
        void ownerId
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.turnUsedSkills.includes(CHISHI)) return
        const payload = context.event.payload as { playerId?: PlayerId }
        const targetId = payload.playerId
        if (!targetId || targetId !== host.state.currentPlayerId) return
        const snapshot = host.state.sunruSnapshot
        if (!snapshot || snapshot.turnNumber !== host.state.turnNumber || snapshot.playerId !== targetId) return
        const current = zoneCounts(host.state, targetId)
        const emptied = (snapshot.hand >= 1 && current.hand === 0)
          || (snapshot.equipment >= 1 && current.equipment === 0)
          || (snapshot.judgment >= 1 && current.judgment === 0)
        if (!emptied) return
        owner.turnUsedSkills.push(CHISHI)
        host.queueSkill({ skillId: CHISHI, ownerId, step: 'ask', data: { targetId } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    host.askSkill({
      skillId: CHISHI, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【持室】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    host.dispatch('SkillActivated', { skillId: CHISHI, skillName: '持室', playerId: ownerId, targetId, logText: `${owner.nickname}发动【持室】` }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, targetId, 2, (name, payload) => { host.dispatch(name, payload) })
    target.marks['chishi-maxcards-turn'] = host.state.turnNumber
  },
  maxCardsBonus(state, playerId) {
    const player = playerOf(state, playerId)
    return player?.marks['chishi-maxcards-turn'] === state.turnNumber ? 2 : 0
  },
})

registerSkillRuntime({
  id: WEIMIAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(WEIMIAN) || abolishableSlotsOf(state, ownerId).length === 0) return []
    return [{ id: WEIMIAN, label: '慰勉：废除自己至多3个装备栏，选一名角色获得对应数量效果' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== WEIMIAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(WEIMIAN)) return
    const candidates = abolishableSlotsOf(host.state, ownerId)
    if (candidates.length === 0) return
    owner.turnUsedSkills.push(WEIMIAN)
    host.askSkill({
      skillId: WEIMIAN, ownerId, step: 'pick-slots', data: {},
      build: (requestId): ChooseOptionsRequest => ({
        id: requestId, kind: 'choose-options', playerId: ownerId,
        prompt: '【慰勉】：废除自己至多3个（至少1个）未废除的装备栏', timeoutMs: 20_000, optional: false,
        options: candidates.map((slot) => ({ id: slot, label: slot })),
        min: 1, max: Math.min(3, candidates.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-slots') {
      const slots = ((response.payload as { optionIds?: string[] }).optionIds ?? []).filter((slot): slot is typeof ABOLISHABLE_SLOTS[number] => (ABOLISHABLE_SLOTS as readonly string[]).includes(slot)).slice(0, 3)
      if (!owner?.alive || slots.length === 0) return
      for (const slot of slots) {
        const equipped = owner.zones.equipment[slot]
        if (equipped) {
          moveCard(host.state, equipped, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
          handleEquipmentLost(host as never, ownerId, equipped)
        }
        abolishSlot(host.state, ownerId, slot)
      }
      const n = slots.length
      host.dispatch('SkillActivated', { skillId: WEIMIAN, skillName: '慰勉', playerId: ownerId, logText: `${owner.nickname}发动【慰勉】，废除${n}个装备栏` }, { sourceId: ownerId })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: WEIMIAN, ownerId, step: 'pick-recipient', data: { n },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【慰勉】：选择一名角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-recipient') {
      const { n } = resolution.data as { n: number }
      const [recipientId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const recipient = recipientId ? playerOf(host.state, recipientId) : undefined
      if (!recipient?.alive) return
      const options: Array<{ id: string; label: string }> = []
      if (abolishedSlotsOf(host.state, recipientId).length > 0) options.push({ id: 'restore', label: '恢复一个被废除的装备栏' })
      options.push({ id: 'recover', label: '回复1点体力' })
      options.push({ id: 'redraw', label: '弃置所有手牌，然后摸4张' })
      const max = Math.min(n, options.length)
      host.askSkill({
        skillId: WEIMIAN, ownerId, step: 'pick-effects', data: { recipientId },
        build: (requestId): ChooseOptionsRequest => ({
          id: requestId, kind: 'choose-options', playerId: recipientId,
          prompt: `【慰勉】：选择${max}项不同的效果`, timeoutMs: 20_000, optional: false,
          options, min: max, max,
        }),
      })
      return
    }
    if (resolution.step === 'pick-effects') {
      const { recipientId } = resolution.data as { recipientId: PlayerId }
      const recipient = playerOf(host.state, recipientId)
      if (!recipient?.alive) return
      const picked = new Set((response.payload as { optionIds?: string[] }).optionIds ?? [])
      if (picked.has('restore')) {
        const abolished = abolishedSlotsOf(host.state, recipientId)
        if (abolished.length > 0) restoreSlot(host.state, recipientId, abolished[0])
      }
      if (picked.has('recover') && recipient.hp < recipient.maxHp) recover(host as never, recipientId, 1, ownerId)
      if (picked.has('redraw')) {
        const cardIds = [...recipient.zones.hand]
        for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: recipientId }, { kind: 'discardPile' })
        if (cardIds.length > 0) host.dispatch('LoseCard', { playerId: recipientId, cardIds, reason: WEIMIAN }, { sourceId: ownerId, targetId: recipientId, cardIds })
        drawCards(host.state, host.rng, recipientId, 4, (name, payload) => { host.dispatch(name, payload) })
      }
    }
  },
})

export const SUNRU: CharacterDefinition = {
  id: 'sunru',
  name: '孙茹',
  kingdom: 'wu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: CHISHI, name: '持室', description: '每个 TurnInstance 限一次，当前回合角色失去其某一区域内最后一张牌后，你可以发动：其摸2张牌，且其本回合MaxCards+2。' },
    { id: WEIMIAN, name: '慰勉', description: '出牌阶段限一次，废除自己至多3个（至少1个）未废除的装备栏，选择一名角色，其选择等量的不同效果：恢复一个被废除的装备栏/回复1点体力/弃置所有手牌然后摸4张。' },
  ],
}
