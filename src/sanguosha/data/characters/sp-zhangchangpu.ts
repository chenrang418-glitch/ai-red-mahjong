import { moveCard } from '../../engine/zones'
import { revealTopCards, drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张昌蒲（三国杀 OL 经典身份 SP）。
 *
 * 【严教】：出牌阶段限一次，张昌蒲选择一名其他角色，从牌堆顶亮出 4 张牌
 *          （加上【省身】累积的额外张数），目标将这些牌分成点数之和相等
 *          的两组（允许部分牌不进入任何一组），张昌蒲与目标各获得一组；
 *          若未分组的牌数量大于 1，直到本回合结束张昌蒲手牌上限 -1。
 * 【省身】：张昌蒲受到伤害后，可以随机摸 1~2 张牌，并使下一次【严教】
 *          额外亮出等同于当前失去体力值的牌（最多亮出 10 张，可跨多次
 *          省身累加）。
 *
 * 分组校验只做「服务端能验证的最小版本」：目标各自提交两组牌，服务端
 * 只核实两组点数和相等且互不重复；不做通用的最优分组搜索。校验失败
 * （和不相等，或有一组为空）时全部亮出的牌直接进入弃牌堆，作为安全兜底。
 */

const YANJIAO = 'yanjiao'
const SHENGSHEN = 'shengshen'
const MAX_CARDS_PENALTY_MARK = 'yanjiao-maxcards-penalty'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function rankOf(state: SanguoshaState, cardId: CardId): number {
  return state.cards[cardId]?.rank ?? 0
}

registerSkillRuntime({
  id: YANJIAO,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(YANJIAO)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: YANJIAO, label: '严教：选择一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== YANJIAO) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: YANJIAO, ownerId, step: 'pick-target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【严教】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  maxCardsBonus(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner || owner.marks[MAX_CARDS_PENALTY_MARK] !== state.turnNumber) return 0
    return -1
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      if (!owner.turnUsedSkills.includes(YANJIAO)) owner.turnUsedSkills.push(YANJIAO)
      const bonus = Math.min(6, host.state.yanjiaoBonus?.[ownerId] ?? 0)
      host.state.yanjiaoBonus ??= {}
      host.state.yanjiaoBonus[ownerId] = 0
      const revealed = revealTopCards(host.state, host.rng, 4 + bonus, YANJIAO, (name, payload) => { host.dispatch(name, payload) })
      if (revealed.length === 0) return
      host.dispatch('SkillActivated', { skillId: YANJIAO, skillName: '严教', playerId: ownerId, targetId, logText: `${owner.nickname}发动【严教】，亮出${revealed.length}张牌` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: YANJIAO, ownerId, step: 'group-a', data: { targetId, revealed },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【严教】：从亮出的牌中选出第一组（点数之和需与第二组相等）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: revealed, hiddenCardSlots: [], min: 0, max: revealed.length,
        }),
      })
      return
    }

    if (resolution.step === 'group-a') {
      const { targetId, revealed } = resolution.data as { targetId: PlayerId; revealed: CardId[] }
      const groupA = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const remaining = revealed.filter((cardId) => !groupA.includes(cardId))
      host.askSkill({
        skillId: YANJIAO, ownerId, step: 'group-b', data: { targetId, revealed, groupA },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【严教】：从剩余的牌中选出第二组（点数之和需与第一组相等）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: remaining, hiddenCardSlots: [], min: 0, max: remaining.length,
        }),
      })
      return
    }

    if (resolution.step === 'group-b') {
      const { targetId, revealed, groupA } = resolution.data as { targetId: PlayerId; revealed: CardId[]; groupA: CardId[] }
      const groupB = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const sumA = groupA.reduce((sum, cardId) => sum + rankOf(host.state, cardId), 0)
      const sumB = groupB.reduce((sum, cardId) => sum + rankOf(host.state, cardId), 0)
      const valid = groupA.length > 0 && groupB.length > 0 && sumA === sumB
      const leftover = revealed.filter((cardId) => !groupA.includes(cardId) && !groupB.includes(cardId))
      const target = playerOf(host.state, targetId)
      if (!valid || !target?.alive) {
        for (const cardId of revealed) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: null, cardIds: revealed, reason: YANJIAO }, { cardIds: revealed })
        return
      }
      for (const cardId of groupA) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      for (const cardId of groupB) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
      for (const cardId of leftover) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      if (groupA.length > 0) host.dispatch('GainCard', { playerId: ownerId, cardIds: groupA, reason: YANJIAO }, { targetId: ownerId, cardIds: groupA })
      host.dispatch('GainCard', { playerId: targetId, cardIds: groupB, reason: YANJIAO }, { targetId, cardIds: groupB })
      if (leftover.length > 0) host.dispatch('LoseCard', { playerId: null, cardIds: leftover, reason: YANJIAO }, { cardIds: leftover })
      if (leftover.length > 1) owner.marks[MAX_CARDS_PENALTY_MARK] = host.state.turnNumber
    }
  },
})

registerSkillRuntime({
  id: SHENGSHEN,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const lostHp = Math.max(0, owner.maxHp - owner.hp)
      host.state.yanjiaoBonus ??= {}
      host.state.yanjiaoBonus[ownerId] = Math.min(6, (host.state.yanjiaoBonus[ownerId] ?? 0) + lostHp)
      const amount = 1 + host.rng.nextInt(2)
      drawCards(host.state, host.rng, ownerId, amount, (name, payload) => { host.dispatch(name, payload) })
      host.dispatch('SkillActivated', { skillId: SHENGSHEN, skillName: '省身', playerId: ownerId, logText: `${owner.nickname}发动【省身】，摸${amount}张牌` }, { sourceId: ownerId })
    },
  }],
})

export const ZHANGCHANGPU: CharacterDefinition = {
  id: 'zhangchangpu',
  name: '张昌蒲',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: YANJIAO, name: '严教', description: '出牌阶段限一次，选择一名其他角色，从牌堆顶亮出4张牌（可因【省身】增加），目标将这些牌分成点数之和相等的两组，你与其各得一组；若未分组的牌数量大于1，直到本回合结束你手牌上限-1。' },
    { id: SHENGSHEN, name: '省身', description: '你受到伤害后，可以随机摸1~2张牌，然后下一次【严教】额外亮出等同于你已损失体力值的牌（最多亮出10张）。' },
  ],
}
