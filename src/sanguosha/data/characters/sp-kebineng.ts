import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { canTarget } from '../../engine/distance'
import { executeUseCardAction } from '../../engine/cards/basic'
import { handleEquipmentLost } from '../../engine/equipment'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 轲比能（三国杀 OL 经典身份 SP）。
 *
 * 【平端】：出牌阶段限一次，选择一名角色A，A依次执行：1.使用一张基本牌
 *          2.重铸一张锦囊牌 3.可以令轲比能获得A装备区一张牌；A每真正执行
 *          成功一项就摸1张牌。
 */

const PINGDUAN = 'pingduan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function basicCardsOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  // 闪只能打出/响应，引擎的使用牌管线不支持"使用一张闪"，候选里排除
  return playerOf(state, playerId)?.zones.hand.filter((id) => state.cards[id]?.category === 'basic' && state.cards[id]?.name !== '闪') ?? []
}

function trickCardsOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  return playerOf(state, playerId)?.zones.hand.filter((id) => state.cards[id]?.category === 'trick') ?? []
}

registerSkillRuntime({
  id: PINGDUAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(PINGDUAN)) return []
    if (!state.players.some((candidate) => candidate.alive)) return []
    return [{ id: PINGDUAN, label: '平端：选择一名角色依次执行三项' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== PINGDUAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(PINGDUAN)) return
    owner.turnUsedSkills.push(PINGDUAN)
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: PINGDUAN, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【平端】：选择一名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const pending = host.state.kebinengPingduanPending
      if (!pending || pending.ownerId !== ownerId || context.event.sourceId !== pending.targetId) return
      host.state.kebinengPingduanPending = undefined
      drawCards(host.state, host.rng, pending.targetId, 1, (n, p) => { host.dispatch(n, p) })
      host.queueSkill({ skillId: PINGDUAN, ownerId, step: 'advance-item2', data: { targetId: pending.targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'advance-item2') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    startItem2(host, ownerId, targetId)
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.dispatch('SkillActivated', { skillId: PINGDUAN, skillName: '平端', playerId: ownerId, logText: `${owner.nickname}发动【平端】` }, { sourceId: ownerId, targetId })
      startItem1(host, ownerId, targetId)
      return
    }

    if (resolution.step === 'item1-pick-card') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) { startItem2(host, ownerId, targetId); return }
      const name = host.state.cards[cardId]?.name ?? ''
      if (name === '杀') {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== targetId && canTarget(host.state, targetId, candidate.id)).map((candidate) => candidate.id)
        if (candidateIds.length === 0) { startItem2(host, ownerId, targetId); return }
        host.askSkill({
          skillId: PINGDUAN, ownerId, step: 'item1-pick-slash-target', data: { targetId, cardId },
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: targetId,
            prompt: '【平端】：选择【杀】的目标', timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: 1,
          }),
        })
        return
      }
      host.state.kebinengPingduanPending = { ownerId, targetId }
      executeUseCardAction(host as never, targetId, {
        kind: 'use-card', id: `pingduan-item1:${cardId}`, playerId: targetId,
        cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1,
        asCardName: name, label: `【平端】：使用【${name}】`,
      })
      return
    }

    if (resolution.step === 'item1-pick-slash-target') {
      const { targetId, cardId } = resolution.data as { targetId: PlayerId; cardId: CardId }
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!victimId || !playerOf(host.state, victimId)?.alive) { startItem2(host, ownerId, targetId); return }
      // 出杀本身可能挂起求闪，不能在同一步里紧接着再问"重铸"，
      // 这里推迟到 AfterCardUse（杀完全结算完毕）之后再继续。
      host.state.kebinengPingduanPending = { ownerId, targetId }
      executeUseCardAction(host as never, targetId, {
        kind: 'use-card', id: `pingduan-item1:${cardId}`, playerId: targetId,
        cardIds: [cardId], targetIds: [victimId], targetMin: 1, targetMax: 1,
        asCardName: '杀', label: '【平端】：使用【杀】',
      })
      return
    }

    if (resolution.step === 'item2-pick') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (target?.alive && cardId && target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: 'recast' }, { sourceId: targetId, cardIds: [cardId] })
        drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: PINGDUAN, skillName: '平端', playerId: ownerId, logText: `${target.nickname}重铸一张锦囊` }, { sourceId: targetId })
        drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
      }
      startItem3(host, ownerId, targetId)
      return
    }

    if (resolution.step === 'item3-ask') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const optionId = (response.payload as { optionId?: string }).optionId
      const target = playerOf(host.state, targetId)
      if (optionId !== 'none' && target?.alive) {
        const slot = optionId as EquipmentSlot
        const cardId = target.zones.equipment[slot]
        if (cardId) {
          moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'hand', playerId: ownerId })
          handleEquipmentLost(host as never, targetId, cardId)
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: PINGDUAN }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
          drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
          host.dispatch('SkillActivated', { skillId: PINGDUAN, skillName: '平端', playerId: ownerId, logText: `轲比能获得${target.nickname}的一件装备` }, { sourceId: ownerId, targetId })
        }
      }
    }
  },
})

function startItem1(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const basics = basicCardsOf(host.state, targetId)
  if (basics.length === 0) { startItem2(host, ownerId, targetId); return }
  host.askSkill({
    skillId: PINGDUAN, ownerId, step: 'item1-pick-card', data: { targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: targetId,
      prompt: '【平端】：使用一张基本牌', timeoutMs: 20_000, optional: true,
      purpose: 'skill', cardIds: basics, hiddenCardSlots: [], min: 0, max: 1,
    }),
  })
}

function startItem2(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const tricks = trickCardsOf(host.state, targetId)
  if (tricks.length === 0) { startItem3(host, ownerId, targetId); return }
  host.askSkill({
    skillId: PINGDUAN, ownerId, step: 'item2-pick', data: { targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: targetId,
      prompt: '【平端】：重铸一张锦囊牌', timeoutMs: 20_000, optional: true,
      purpose: 'skill', cardIds: tricks, hiddenCardSlots: [], min: 0, max: 1,
    }),
  })
}

function startItem3(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  const slots = target ? (Object.entries(target.zones.equipment).filter(([, id]) => id) as Array<[EquipmentSlot, CardId]>) : []
  if (slots.length === 0) return
  host.askSkill({
    skillId: PINGDUAN, ownerId, step: 'item3-ask', data: { targetId },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: targetId,
      prompt: '【平端】：是否令轲比能获得你装备区的一张牌？', timeoutMs: 20_000, optional: true,
      options: [...slots.map(([slot, cardId]) => ({ id: slot, label: `交出${host.state.cards[cardId]?.name ?? slot}` })), { id: 'none', label: '不交出' }],
    }),
  })
}

export const KEBINENG: CharacterDefinition = {
  id: 'kebineng',
  name: '轲比能',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: PINGDUAN, name: '平端', description: '出牌阶段限一次，选择一名角色，其依次执行：使用一张基本牌；重铸一张锦囊牌；可以令你获得其装备区一张牌。每真正执行成功一项，其摸1张牌。' },
  ],
}
