import { pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { skipPhase } from '../../engine/turn'
import type { CardId, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 山包·张郃【巧变】。本项目自研表述。。
 *
 * 原文：「你可以弃置一张手牌，跳过一个阶段。若你以此法跳过了摸牌阶段，
 *   你可以获得至多两名其他角色各一张手牌；若你以此法跳过了出牌阶段，
 *   你可以将场上的一张牌移动到另一个合法位置。」
 *
 * **不是界张郃、谋张郃、星张郃。** 界张郃跳判定阶段会获得判定区的牌，
 * 谋张郃有额外摸牌/额外出牌阶段的强化——这里一样都没有。
 *
 * 【巧变】本质上不是一个「出牌阶段按钮」，而是**在阶段开始前提供一个
 * 付代价跳过该阶段的替代选择**，所以它走的是引擎的公共
 * `offerPhaseSkip` 窗口，不在 turn.ts 里写 `if (characterId === 'zhanghe')`。
 * 刘禅【放权】挂的是同一个窗口。
 */

export const QIAOBIAN = 'qiaobian'

/**
 * 巧变能跳过的阶段。
 *
 * 准备阶段和结束阶段不在内：那两个阶段跳过去既无收益，经典版也没有对应文本。
 */
const SKIPPABLE: readonly TurnPhase[] = ['judge', 'draw', 'play', 'discard']

const PHASE_LABEL: Record<string, string> = {
  judge: '判定阶段',
  draw: '摸牌阶段',
  play: '出牌阶段',
  discard: '弃牌阶段',
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 摸牌阶段巧变的候选：**有手牌**的其他存活角色。没手牌的不进候选。 */
function stealCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)
    .map((candidate) => candidate.id)
}

/** 出牌阶段巧变的候选：场上真正搬得动的牌（有合法落点的才算）。 */
function movableFieldCards(state: SanguoshaState): CardId[] {
  return fieldCards(state)
    .filter((candidate) => fieldMoveDestinations(state, candidate.cardId).length > 0)
    .map((candidate) => candidate.cardId)
}

/**
 * 向下一名目标要一张手牌。
 *
 * **只给占位槽，不给具体牌面**：张郃不能先看清对方手牌再挑。
 * 走的是和顺手牵羊、烈刃同一份 `pickableCardsOf`，这里只取手牌部分——
 * 经典文本是「各一张手牌」，装备区不在内。
 */
function askSteal(host: SkillHost, ownerId: PlayerId, remaining: PlayerId[]): boolean {
  while (remaining.length > 0) {
    const targetId = remaining[0]
    const target = playerOf(host.state, targetId)
    // 轮到他的时候手牌可能已经没了（前一个目标结算引发的连锁），跳过
    if (!target?.alive || target.zones.hand.length === 0) {
      remaining.shift()
      continue
    }
    const slots = pickableCardsOf(host.state, targetId).hiddenCardSlots
    host.askSkill({
      skillId: QIAOBIAN, ownerId, step: 'steal-pick', data: { targetId, remaining: remaining.slice(1) },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【巧变】：获得${target.nickname}的一张手牌`,
        timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: [], hiddenCardSlots: slots,
        min: 1, max: 1,
      }),
    })
    return true
  }
  return false
}

registerSkillRuntime({
  id: QIAOBIAN,

  offerPhaseSkip(host, ownerId, phase) {
    if (!SKIPPABLE.includes(phase)) return false
    const owner = playerOf(host.state, ownerId)
    // 没有手牌就付不起代价：直接正常进入该阶段，**不弹一个只能拒绝的窗口**
    if (!owner?.alive || owner.zones.hand.length === 0) return false
    host.askSkill({
      skillId: QIAOBIAN, ownerId, step: 'ask', data: { phase },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `发动【巧变】？弃置一张手牌，跳过${PHASE_LABEL[phase] ?? phase}`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: `弃一张手牌跳过${PHASE_LABEL[phase] ?? phase}` }, { id: 'no', label: '放弃' }],
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    const phase = resolution.data.phase as TurnPhase | undefined

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') {
        // 放弃：把控制权交回阶段窗口，正常开始这个阶段
        host.resumePhaseEntry()
        return
      }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0 || !phase) {
        host.resumePhaseEntry()
        return
      }
      host.askSkill({
        skillId: QIAOBIAN, ownerId, step: 'cost', data: { phase },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【巧变】：弃置一张手牌以跳过${PHASE_LABEL[phase] ?? phase}`,
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          // 代价**只能是手牌**：装备、判定区、专属牌堆都不行
          cardIds: [...owner.zones.hand], hiddenCardSlots: [],
          min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'cost') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !phase || !cardId || !owner.zones.hand.includes(cardId)) {
        host.resumePhaseEntry()
        return
      }
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: QIAOBIAN }, { sourceId: ownerId, cardIds: [cardId] })
      // **真正的跳过**：走公共 skippedPhases，不是「摸 0 张」「手牌上限设无穷」
      skipPhase(host.state, phase)

      if (phase === 'draw') {
        const candidateIds = stealCandidates(host.state, ownerId)
        if (candidateIds.length === 0) {
          host.resumePhaseEntry()
          return
        }
        host.askSkill({
          skillId: QIAOBIAN, ownerId, step: 'steal-targets',
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【巧变】：获得至多两名其他角色各一张手牌',
            timeoutMs: 20_000, optional: true,
            // 至多两名，可以一个都不选；同一人只能被选一次，所以拿不到「同一人两张」
            candidateIds, min: 0, max: 2,
          }),
        })
        return
      }

      if (phase === 'play') {
        const movable = movableFieldCards(host.state)
        if (movable.length === 0) {
          host.resumePhaseEntry()
          return
        }
        host.askSkill({
          skillId: QIAOBIAN, ownerId, step: 'move-card',
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: '【巧变】：将场上的一张牌移动到另一个合法位置',
            timeoutMs: 20_000, optional: true, purpose: 'skill',
            // 装备区和判定区都是公开牌，直接列出来，不需要占位槽
            cardIds: movable, hiddenCardSlots: [],
            min: 0, max: 1,
          }),
        })
        return
      }

      // 判定阶段 / 弃牌阶段：跳过就是全部效果，没有后续
      host.resumePhaseEntry()
      return
    }

    if (resolution.step === 'steal-targets') {
      const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      // 一个都不选也合法（「至多两名」）
      if (!askSteal(host, ownerId, [...targetIds])) host.resumePhaseEntry()
      return
    }

    if (resolution.step === 'steal-pick') {
      const targetId = resolution.data.targetId as PlayerId
      const remaining = (resolution.data.remaining as PlayerId[] | undefined) ?? []
      const [picked] = (response.payload as { cardIds: string[] }).cardIds
      const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (cardId) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: QIAOBIAN }, { targetId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: QIAOBIAN }, { targetId: ownerId, cardIds: [cardId] })
      }
      // 剩下的目标继续，一个不剩就把控制权交回阶段窗口
      if (!askSteal(host, ownerId, [...remaining])) host.resumePhaseEntry()
      return
    }

    if (resolution.step === 'move-card') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      const destinations = cardId ? fieldMoveDestinations(host.state, cardId) : []
      if (!cardId || destinations.length === 0) {
        host.resumePhaseEntry()
        return
      }
      host.askSkill({
        skillId: QIAOBIAN, ownerId, step: 'move-dest', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【巧变】：将${host.state.cards[cardId]?.name ?? '这张牌'}移动给谁`,
          timeoutMs: 20_000, optional: false,
          candidateIds: destinations, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'move-dest') {
      const cardId = resolution.data.cardId as CardId
      const [toPlayerId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      // 发问期间状态可能变了（目标死了、槽被占了），落地前重新验一次
      if (toPlayerId && fieldMoveDestinations(host.state, cardId).includes(toPlayerId)) {
        moveFieldCard(host as never, cardId, toPlayerId)
      }
      host.resumePhaseEntry()
    }
  },
})

export const ZHANGHE: CharacterDefinition = {
  id: 'zhanghe',
  name: '张郃',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'mountain',
  skills: [{
    id: QIAOBIAN,
    name: '巧变',
    description: '你可以弃置一张手牌，跳过一个阶段（准备阶段和结束阶段除外）。若你以此法跳过了摸牌阶段，你可以获得至多两名其他角色各一张手牌；若你以此法跳过了出牌阶段，你可以将场上的一张牌移动到另一个合法位置。',
  }],
}
