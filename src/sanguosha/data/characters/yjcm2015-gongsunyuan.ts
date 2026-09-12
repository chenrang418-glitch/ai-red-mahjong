import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { loseHp } from '../../engine/hp'
import { effectiveCardColor, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 公孙渊（一将成名 2015）。
 *
 * 【怀异】：出牌阶段限一次，你展示所有手牌，若其中包含不止一种颜色，则你
 *          选择一种颜色并弃置该颜色的所有手牌，然后你可以获得至多 X 名
 *          其他角色的各一张牌（X 为你以此法弃置的手牌数）；若你以此法获得
 *          的牌不少于两张，你失去 1 点体力。
 *
 * 三处最容易做错的：
 *
 * 1. **展示是无条件的，一旦发动就计入本回合次数**——哪怕手牌只有一种颜色、
 *    条件不成立，这次发动照样消耗掉。
 * 2. **颜色判断按有效颜色**，无色牌不构成「另一种颜色」，也不会被弃置。
 * 3. **获得的目标依次单独结算**（同凌统【旋风】的做法），最后按累计获得的
 *    张数（不是目标数）判断是否达到「不少于两张」。
 */

const HUAIYI = 'huaiyi'
const USED_TURN_MARK = 'huaiyi-used-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: HUAIYI,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.marks[USED_TURN_MARK] === state.turnNumber) return []
    if (owner.zones.hand.length === 0) return []
    return [{ id: HUAIYI, label: '怀异：展示所有手牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== HUAIYI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    owner.marks[USED_TURN_MARK] = host.state.turnNumber
    const handCardIds = [...owner.zones.hand]
    host.dispatch('SkillActivated', {
      skillId: HUAIYI, skillName: '怀异', playerId: ownerId, cardIds: handCardIds,
      logText: `${owner.nickname}发动【怀异】，展示所有手牌`,
    }, { sourceId: ownerId, cardIds: handCardIds })

    const colors = new Set(
      handCardIds
        .map((cardId) => effectiveCardColor(host.state, ownerId, cardId))
        .filter((color): color is 'red' | 'black' => color === 'red' || color === 'black'),
    )
    if (colors.size < 2) return

    host.askSkill({
      skillId: HUAIYI, ownerId, step: 'color',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【怀异】：选择一种颜色，弃置该颜色的所有手牌',
        timeoutMs: 20_000, optional: false,
        options: [...colors].map((color) => ({ id: color, label: color === 'red' ? '红色' : '黑色' })),
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'color') {
      const color = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (color !== 'red' && color !== 'black')) return
      const discarded = owner.zones.hand.filter((cardId) => effectiveCardColor(host.state, ownerId, cardId) === color)
      if (discarded.length === 0) return
      for (const cardId of discarded) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: HUAIYI }, { targetId: ownerId, cardIds: discarded })

      const x = discarded.length
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: HUAIYI, ownerId, step: 'targets', data: { x },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【怀异】：选择至多 ${x} 名其他角色，各获得一张牌`,
          timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: Math.min(x, candidateIds.length),
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      if (targetIds.length === 0) return
      continuePlan(host, ownerId, targetIds.map((targetId) => ({ targetId })), 0)
      return
    }

    if (resolution.step === 'gain') {
      const targetId = resolution.data.targetId as PlayerId
      const plan = (resolution.data.plan as Array<{ targetId: PlayerId }>) ?? []
      let gained = resolution.data.gained as number
      const [choice] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      if (choice) {
        const cardId = resolvePickedCard(host.state, targetId, choice)
        if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: HUAIYI }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
          gained += 1
        }
      }
      continuePlan(host, ownerId, plan, gained)
    }
  },
})

function continuePlan(host: SkillHost, ownerId: PlayerId, plan: Array<{ targetId: PlayerId }>, gained: number): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const remaining = [...plan]
  while (remaining.length > 0) {
    const next = remaining.shift()!
    const target = playerOf(host.state, next.targetId)
    if (!target?.alive || !hasPickableCards(host.state, next.targetId)) continue
    const pickable = pickableCardsOf(host.state, next.targetId)
    host.askSkill({
      skillId: HUAIYI, ownerId, step: 'gain', data: { targetId: next.targetId, plan: remaining, gained },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【怀异】：获得${target.nickname}的一张牌`,
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
        min: 0, max: 1,
      }),
    })
    return
  }
  // 计划走完（或全员没牌可拿）：按累计获得的张数结算失血
  if (gained >= 2) loseHp(host as never, ownerId, 1, HUAIYI)
}

export const GONGSUNYUAN: CharacterDefinition = {
  id: 'gongsunyuan',
  name: '公孙渊',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2015',
  skills: [
    {
      id: HUAIYI,
      name: '怀异',
      description: '出牌阶段限一次，你展示所有手牌，若其中包含不止一种颜色，则你选择一种颜色并弃置该颜色的所有手牌，然后你可以获得至多 X 名其他角色的各一张牌（X 为你以此法弃置的手牌数）；若你以此法获得的牌不少于两张，你失去 1 点体力。',
    },
  ],
}
