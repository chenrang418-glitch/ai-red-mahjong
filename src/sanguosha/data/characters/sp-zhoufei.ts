import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { handleEquipmentLost } from '../../engine/equipment'
import { isSlotAbolished } from '../../engine/equipment-slots'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 周妃（三国杀 OL 经典身份 SP）。
 *
 * 【箜声】：准备阶段，可以将任意张牌置于你的武将牌上；结束阶段，你获得
 *          其中所有非装备牌，然后令一名角色依次使用剩余装备牌，其后
 *          该角色失去1点体力。
 * 【良姻】：每个 TurnInstance 限一次，本项目没有独立的"移出游戏"判定域，
 *          良姻的移出/移入监听范围限定为箜声自身的入池/出池——箜声把牌
 *          放上武将牌视为"移出"，结束阶段这些牌回到手牌/使用视为"移入"。
 *          移出：你与另一名角色各摸1；移入：你与另一名角色各弃1；此后若
 *          你或该角色手牌数等于当前箜声牌数，可以令其中一人回复1点体力。
 */

const KONGSHENG = 'kongsheng'
const LIANGYIN = 'liangyin'
const PILE = 'kongsheng'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function fireLiangyin(host: SkillHost, ownerId: PlayerId, pileCount: number): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || owner.turnUsedSkills.includes(LIANGYIN)) return
  const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
  if (candidateIds.length === 0) return
  owner.turnUsedSkills.push(LIANGYIN)
  host.askSkill({
    skillId: LIANGYIN, ownerId, step: 'pick-partner', data: { pileCount },
    build: (requestId: string): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId,
      prompt: '【良姻】：选择另一名角色', timeoutMs: 20_000, optional: false,
      candidateIds, min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: KONGSHENG,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        host.queueSkill({ skillId: KONGSHENG, ownerId, step: 'ask-place', data: {} })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const pile = [...(owner.characterPiles?.[PILE] ?? [])]
        if (pile.length === 0) return
        const nonEquip = pile.filter((cardId) => host.state.cards[cardId]?.category !== 'equipment')
        const equip = pile.filter((cardId) => host.state.cards[cardId]?.category === 'equipment')
        if (nonEquip.length > 0) {
          for (const cardId of nonEquip) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: nonEquip, reason: KONGSHENG }, { targetId: ownerId, cardIds: nonEquip })
        }
        if (equip.length === 0) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: KONGSHENG, ownerId, step: 'pick-user', data: { equip } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask-place') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: KONGSHENG, ownerId, step: 'ask-place', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【箜声】：可以将任意张牌置于你的武将牌上', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: owner.zones.hand.length,
        }),
      })
      return
    }
    if (prompt.step === 'pick-user') {
      const { equip } = prompt.data as { equip: CardId[] }
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: KONGSHENG, ownerId, step: 'pick-user', data: { equip },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【箜声】：选择一名角色依次使用剩余的装备牌', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask-place') {
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((cardId) => owner?.zones.hand.includes(cardId))
      if (!owner?.alive || picked.length === 0) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: PILE })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: KONGSHENG }, { sourceId: ownerId, cardIds: picked })
      host.dispatch('SkillActivated', { skillId: KONGSHENG, skillName: '箜声', playerId: ownerId, logText: `${owner.nickname}发动【箜声】，置${picked.length}张牌于武将牌上` }, { sourceId: ownerId })
      fireLiangyin(host, ownerId, (owner.characterPiles?.[PILE] ?? []).length)
      return
    }
    if (resolution.step === 'pick-user') {
      const { equip } = resolution.data as { equip: CardId[] }
      const [userId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const user = userId ? playerOf(host.state, userId) : undefined
      if (!owner?.alive || !user?.alive) return
      let usedAny = false
      for (const cardId of equip) {
        if (!(owner.characterPiles?.[PILE] ?? []).includes(cardId)) continue
        const card = host.state.cards[cardId]
        const slot = card?.equipmentSlot as EquipmentSlot | undefined
        if (slot && !isSlotAbolished(host.state, userId, slot)) {
          const replaced = user.zones.equipment[slot]
          moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'equipment', playerId: userId, slot })
          if (replaced) handleEquipmentLost(host as never, userId, replaced)
          usedAny = true
        } else {
          moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'discardPile' })
        }
      }
      if (usedAny) host.dispatch('SkillActivated', { skillId: KONGSHENG, skillName: '箜声', playerId: ownerId, targetId: userId, logText: `${owner.nickname}发动【箜声】，令${user.nickname}使用装备牌` }, { sourceId: ownerId, targetId: userId })
      loseHp(host as never, userId, 1, KONGSHENG)
      if (playerOf(host.state, userId)?.alive) fireLiangyin(host, ownerId, 0)
    }
  },
})

registerSkillRuntime({
  id: LIANGYIN,
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-partner') return
    const { pileCount } = resolution.data as { pileCount: number }
    const [partnerId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const partner = partnerId ? playerOf(host.state, partnerId) : undefined
    if (!owner?.alive || !partner?.alive) return
    host.dispatch('SkillActivated', { skillId: LIANGYIN, skillName: '良姻', playerId: ownerId, targetId: partnerId, logText: `${owner.nickname}发动【良姻】` }, { sourceId: ownerId, targetId: partnerId })
    const x = pileCount > 0 ? pileCount : (owner.characterPiles?.[PILE] ?? []).length
    if (x > 0) {
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      drawCards(host.state, host.rng, partnerId, 1, (name, payload) => { host.dispatch(name, payload) })
    } else {
      const discard = (playerId: PlayerId): void => {
        const player = playerOf(host.state, playerId)
        if (!player?.alive || player.zones.hand.length === 0) return
        const cardId = player.zones.hand[0]
        moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: LIANGYIN }, { sourceId: ownerId, cardIds: [cardId] })
      }
      discard(ownerId)
      discard(partnerId)
    }
    const currentX = (playerOf(host.state, ownerId)?.characterPiles?.[PILE] ?? []).length
    const matches = [ownerId, partnerId].filter((id) => playerOf(host.state, id)?.zones.hand.length === currentX)
    if (matches.length === 0) return
    host.askSkill({
      skillId: LIANGYIN, ownerId, step: 'pick-recover', data: { matches },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【良姻】：可以令其中一人回复1点体力', timeoutMs: 20_000, optional: true,
        candidateIds: matches, min: 0, max: 1,
      }),
    })
  },
})

export const ZHOUFEI: CharacterDefinition = {
  id: 'zhoufei',
  name: '周妃',
  kingdom: 'wu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: KONGSHENG, name: '箜声', description: '准备阶段，可以将任意张牌置于你的武将牌上；结束阶段，你获得其中所有非装备牌，然后令一名角色依次使用剩余装备牌，其后该角色失去1点体力。' },
    { id: LIANGYIN, name: '良姻', description: '每个 TurnInstance 限一次，箜声牌进出你的武将牌堆后，你与另一名角色各摸1或各弃1；此后若你或该角色手牌数等于当前箜声牌数，可以令其中一人回复1点体力。' },
  ],
}
