import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 祖茂（三国杀 OL 经典身份 SP）。
 *
 * 【引兵】：结束阶段，祖茂可以将任意张非基本牌置于自己武将牌上，称为
 *          「引兵牌」（character pile）；祖茂受到【杀】或【决斗】造成的
 *          伤害后，若有引兵牌，移去1张（不论伤害数值多少，一次只移1张）。
 * 【绝地】：锁定技，准备阶段选择一项：A. 移去所有引兵牌，然后摸牌至体力
 *          上限；B. 选择一名体力值不大于祖茂的其他角色，令其获得祖茂所有
 *          引兵牌，然后回复1点体力并摸等量的牌。
 */

const YINBING = 'yinbing'
const JUEDI = 'juedi'
const YINBING_PILE = 'yinbing'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: YINBING,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        const candidates = owner?.zones.hand.filter((cardId) => host.state.cards[cardId]?.category !== 'basic') ?? []
        if (!owner?.alive || candidates.length === 0) return
        host.queueSkill({ skillId: YINBING, ownerId, step: 'ask', data: { candidates } })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string }
        if (context.event.targetId !== ownerId || (payload.cardName !== '杀' && payload.cardName !== '决斗')) return
        const owner = playerOf(host.state, ownerId)
        const pile = owner?.characterPiles[YINBING_PILE]
        if (!owner?.alive || !pile || pile.length === 0) return
        const [cardId] = pile
        moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YINBING_PILE }, { kind: 'discardPile' })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const { candidates } = prompt.data as { candidates: CardId[] }
    if (!owner?.alive || candidates.length === 0) return
    host.askSkill({
      skillId: YINBING, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【引兵】：可以将任意张非基本牌置于武将牌上', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: candidates.length,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = cardIds.filter((cardId) => owner?.zones.hand.includes(cardId))
    if (!owner?.alive || valid.length === 0) return
    for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: YINBING_PILE })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: YINBING }, { sourceId: ownerId, cardIds: valid })
    host.dispatch('SkillActivated', { skillId: YINBING, skillName: '引兵', playerId: ownerId, logText: `${owner.nickname}发动【引兵】` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: JUEDI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const pile = owner.characterPiles[YINBING_PILE] ?? []
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.hp <= owner.hp).map((candidate) => candidate.id)
      const options: Array<{ id: string; label: string }> = [{ id: 'A', label: '移去所有引兵牌，摸牌至体力上限' }]
      if (pile.length > 0 && candidateIds.length > 0) options.push({ id: 'B', label: '选择一名体力值不大于自己的角色，令其获得所有引兵牌' })
      if (options.length === 1) { host.queueSkill({ skillId: JUEDI, ownerId, step: 'branch-a', data: {} }); return }
      host.queueSkill({ skillId: JUEDI, ownerId, step: 'ask', data: { options, candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'branch-a') { doBranchA(host, ownerId); return }
    if (prompt.step === 'ask') {
      const { options, candidateIds } = prompt.data as { options: Array<{ id: string; label: string }>; candidateIds: PlayerId[] }
      host.askSkill({
        skillId: JUEDI, ownerId, step: 'ask', data: { candidateIds },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【绝地】：选择一项', timeoutMs: 20_000, optional: false, options,
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'ask') {
      const branch = (response.payload as { optionId?: string }).optionId
      if (branch === 'A') { doBranchA(host, ownerId); return }
      const { candidateIds } = resolution.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: JUEDI, ownerId, step: 'target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【绝地】：选择一名体力值不大于自己的角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const pile = [...(owner.characterPiles[YINBING_PILE] ?? [])]
      if (!target?.alive || pile.length === 0) return
      for (const cardId of pile) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YINBING_PILE }, { kind: 'hand', playerId: targetId! })
      host.dispatch('GainCard', { playerId: targetId, cardIds: pile, reason: JUEDI }, { targetId, cardIds: pile })
      host.dispatch('SkillActivated', { skillId: JUEDI, skillName: '绝地', playerId: ownerId, targetId, logText: `${owner.nickname}发动【绝地】` }, { sourceId: ownerId, targetId })
      recover(host as never, targetId!, 1, ownerId)
      if (playerOf(host.state, targetId!)?.alive) drawCards(host.state, host.rng, targetId!, pile.length, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

function doBranchA(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const pile = [...(owner.characterPiles[YINBING_PILE] ?? [])]
  for (const cardId of pile) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YINBING_PILE }, { kind: 'discardPile' })
  host.dispatch('SkillActivated', { skillId: JUEDI, skillName: '绝地', playerId: ownerId, logText: `${owner.nickname}发动【绝地】，摸牌至体力上限` }, { sourceId: ownerId })
  const need = Math.max(0, owner.maxHp - owner.zones.hand.length)
  if (need > 0) drawCards(host.state, host.rng, ownerId, need, (name, payload) => { host.dispatch(name, payload) })
}

export const ZUMAO: CharacterDefinition = {
  id: 'zumao',
  name: '祖茂',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: YINBING, name: '引兵', description: '结束阶段，祖茂可以将任意张非基本牌置于自己武将牌上，称为“引兵牌”；祖茂受到【杀】或【决斗】造成的伤害后，若有引兵牌，移去1张。' },
    { id: JUEDI, name: '绝地', description: '锁定技，准备阶段选择一项：移去所有引兵牌，摸牌至体力上限；或选择一名体力值不大于自己的角色，令其获得所有引兵牌，然后回复1点体力并摸等量的牌。' },
  ],
}
