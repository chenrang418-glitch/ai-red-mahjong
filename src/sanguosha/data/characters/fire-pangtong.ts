import { setChained, flipCharacter } from '../../engine/character-state'
import { continueDyingRescue } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import type { ChooseOptionRequest, GameResponse } from '../../engine/requests'
import { effectiveCardSuit, registerSkillRuntime, type ViewAsOption } from '../../engine/skills/runtime'
import type { EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

export const LIANHUAN = 'lianhuan'
export const NIEPAN = 'niepan'
const NIEPAN_INVOKE = 'niepan-invoke'
const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

function ownerOf(state: SanguoshaState, ownerId: PlayerId) {
  return state.players.find((player) => player.id === ownerId)
}

registerSkillRuntime({
  id: LIANHUAN,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = ownerOf(state, ownerId)
    if (!owner?.alive) return []
    return owner.zones.hand
      .filter((cardId) => effectiveCardSuit(state, ownerId, cardId) === 'club')
      .filter((cardId) => state.cards[cardId]?.name !== '铁索连环')
      .map((cardId) => ({ asCardName: '铁索连环', cardId, label: `发动【连环】：将【${state.cards[cardId].name}】当【铁索连环】使用或重铸` }))
  },
})

registerSkillRuntime({
  id: NIEPAN,
  dyingIntercept(host, ownerId) {
    const owner = ownerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(NIEPAN)) return false
    host.askSkill({
      skillId: NIEPAN,
      ownerId,
      step: 'dying',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: '你处于濒死状态，是否发动限定技【涅槃】？',
        timeoutMs: 20_000,
        optional: true,
        options: [
          { id: NIEPAN_INVOKE, label: '发动【涅槃】：弃置区域内所有牌，摸三张牌并回复至3点体力' },
          { id: 'cancel', label: '不发动，继续求桃' },
        ],
      }),
    })
    return 'pending'
  },
  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step !== 'dying' || host.state.dying?.playerId !== ownerId) return
    const owner = ownerOf(host.state, ownerId)
    if (!owner?.alive) return
    if ((response.payload as { optionId?: string }).optionId !== NIEPAN_INVOKE) {
      continueDyingRescue(host)
      if (!host.state.dying) host.resumeAfterDying()
      return
    }
    if (owner.usedLimitedSkills.includes(NIEPAN)) {
      continueDyingRescue(host)
      if (!host.state.dying) host.resumeAfterDying()
      return
    }

    owner.usedLimitedSkills.push(NIEPAN)
    for (const cardId of [...owner.zones.hand]) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    }
    for (const slot of EQUIPMENT_SLOTS) {
      const cardId = owner.zones.equipment[slot]
      if (!cardId) continue
      moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
      handleEquipmentLost(host, ownerId, cardId)
    }
    for (const cardId of [...owner.zones.judgingArea]) {
      moveCard(host.state, cardId, { kind: 'judgingArea', playerId: ownerId }, { kind: 'discardPile' })
    }
    flipCharacter(host, ownerId, NIEPAN, false)
    setChained(host, ownerId, NIEPAN, false)
    drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
    const recovered = Math.max(0, Math.min(owner.maxHp, 3) - owner.hp)
    owner.hp = Math.min(owner.maxHp, 3)
    if (recovered > 0) host.dispatch('Recover', { playerId: ownerId, amount: recovered, reason: NIEPAN }, { targetId: ownerId })
    host.dispatch('QuitDying', { playerId: ownerId, hp: owner.hp, reason: NIEPAN }, { targetId: ownerId })
    host.state.dying = null
    host.resumeAfterDying()
  },
})

export const PANGTONG: CharacterDefinition = {
  id: 'pangtong',
  name: '庞统',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'fire',
  skills: [
    { id: LIANHUAN, name: '连环', description: '你可以将一张梅花手牌当【铁索连环】使用或重铸。' },
    { id: NIEPAN, name: '涅槃', description: '限定技，当你处于濒死状态时，你可以弃置你区域内的所有牌，重置武将牌，摸三张牌并将体力回复至3点。' },
  ],
}
