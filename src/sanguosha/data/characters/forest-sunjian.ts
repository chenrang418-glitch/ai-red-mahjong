import { hasPickableCards } from '../../engine/card-pick'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 林包·孙坚【英魂】。经典「神话再临·林」首版。
 *
 * **不是十周年那版**——那一版会给目标一枚「魂」标记，这里没有任何标记。
 * 也不是孙策，别把【英姿】混进来。
 *
 * 原文：「准备阶段，若你已受伤，你可以选择一名其他角色并选择一项令其执行之：
 *   1. 摸 X 张牌并弃置一张牌；2. 摸一张牌并弃置 X 张牌（X 为你已损失的体力值）。」
 *
 * 决策链的归属必须分清楚：**发不发动、选谁、选哪一项，全是孙坚决定的**；
 * 目标只决定「具体弃自己的哪几张牌」。搞反了就变成了「让对手自己挑轻的受」。
 */

export const YINGHUN = 'yinghun'

/** 摸 X 弃 1。 */
const MODE_DRAW_MANY = 'yinghun-draw-many'
/** 摸 1 弃 X。 */
const MODE_DISCARD_MANY = 'yinghun-discard-many'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** X = 已损失体力值。**不写死 4**：主公上限会 +1。 */
function lostHp(state: SanguoshaState, playerId: PlayerId): number {
  const owner = playerOf(state, playerId)
  if (!owner) return 0
  return Math.max(0, owner.maxHp - owner.hp)
}

function otherAliveIds(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
}

/** 这名角色现在能弃的牌：手牌 + 装备区。技能文本写的是「牌」，不是「手牌」。 */
function discardableOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const target = playerOf(state, playerId)
  if (!target?.alive) return []
  return [
    ...target.zones.hand,
    ...Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
  ]
}

/**
 * 摸完之后要求目标弃牌。
 *
 * 两条边界：
 * - **牌不足就弃光**，不能发一个 min 永远满足不了的死请求；
 * - **一张都没有就别弹空窗口**，直接结束。
 */
function askDiscard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, want: number): void {
  const pool = discardableOf(host.state, targetId)
  const required = Math.min(want, pool.length)
  if (required <= 0 || !hasPickableCards(host.state, targetId)) return
  host.askSkill({
    skillId: YINGHUN, ownerId, step: 'discard', data: { targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards',
      // 弃哪几张由**目标自己**挑，孙坚只定了数量
      playerId: targetId,
      prompt: `【英魂】：弃置 ${required} 张牌`,
      timeoutMs: 30_000, optional: false, purpose: 'skill',
      cardIds: pool, hiddenCardSlots: [],
      min: required, max: required,
    }),
  })
}

registerSkillRuntime({
  id: YINGHUN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      // 没受伤就不发动，也不弹一个只能拒绝的窗口
      if (lostHp(host.state, ownerId) <= 0) return
      if (otherAliveIds(host.state, ownerId).length === 0) return
      host.askSkill({
        skillId: YINGHUN, ownerId, step: 'ask',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `发动【英魂】？选择一名其他角色，令其摸 ${lostHp(host.state, ownerId)} 张牌后弃 1 张，或摸 1 张后弃 ${lostHp(host.state, ownerId)} 张`,
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动英魂' }, { id: 'no', label: '放弃' }],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') return
      const candidateIds = otherAliveIds(host.state, ownerId)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: YINGHUN, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【英魂】：选择一名其他角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const count = lostHp(host.state, ownerId)
      if (count <= 0) return
      host.askSkill({
        skillId: YINGHUN, ownerId, step: 'mode', data: { targetId, count },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option',
          // 选哪一项是**孙坚**的决定，不是目标的
          playerId: ownerId,
          prompt: `【英魂】：令${target.nickname}执行哪一项？`,
          timeoutMs: 20_000, optional: false,
          // 写清楚数字，不用「模式一 / 模式二」这种玩家看不懂的说法
          options: [
            { id: `${MODE_DRAW_MANY}:${targetId}`, label: `摸 ${count} 张牌，然后弃置 1 张牌` },
            { id: `${MODE_DISCARD_MANY}:${targetId}`, label: `摸 1 张牌，然后弃置 ${count} 张牌` },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'mode') {
      const targetId = resolution.data.targetId as PlayerId
      const count = Number(resolution.data.count ?? 0)
      const target = playerOf(host.state, targetId)
      if (!target?.alive || count <= 0) return
      const drawMany = (response.payload as { optionId: string }).optionId.startsWith(MODE_DRAW_MANY)

      /*
       * **先摸后弃，而且要真的分两步。**
       * 摸完之后手牌才是最终形态，弃牌请求必须基于摸完的状态生成——
       * 先让目标挑要弃的牌再摸，规则和体验都是错的。
       */
      drawCards(host.state, host.rng, targetId, drawMany ? count : 1, (name, payload) => { host.dispatch(name, payload) })
      askDiscard(host, ownerId, targetId, drawMany ? 1 : count)
      return
    }

    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds: CardId[] }).cardIds
      for (const cardId of selected) {
        const from = locateOwnedCard(host.state, targetId, cardId)
        if (!from || from.kind === 'judgingArea') continue
        moveCard(host.state, cardId, from, { kind: 'discardPile' })
        // 装备离场走统一收尾，枭姬和白银狮子才触发得到
        if (from.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
      }
      if (selected.length > 0) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: selected, reason: YINGHUN }, { sourceId: targetId, cardIds: selected })
      }
    }
  },
})

export const SUNJIAN: CharacterDefinition = {
  id: 'sunjian',
  name: '孙坚',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'forest',
  skills: [{
    id: YINGHUN,
    name: '英魂',
    description: '准备阶段，若你已受伤，你可以选择一名其他角色并选择一项令其执行（X 为你已损失的体力值）：摸 X 张牌然后弃置一张牌；或摸一张牌然后弃置 X 张牌。',
  }],
}
