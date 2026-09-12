import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 马云騄（三国杀 OL 经典身份 SP）。
 *
 * 【马术】：锁定技，计算与其他角色的距离 -1（马岱同款，直接复用
 *          `distanceModifier`，不新写实现）。
 * 【凤魄】：自己的回合内第一次使用【杀】或【决斗】指定目标后，X 为当前
 *          目标手牌中的方块牌数量，选择：马云騄摸 X 张牌；或这张牌造成的
 *          伤害 +X。
 *
 * 两处最容易做错的：
 *
 * 1. **凤魄只认「本回合第一次」**，走 `turn-usage.ts` 的一次性标记，
 *    不是「每张杀/决斗都问一次」。
 * 2. **伤害 +X 绑定这一张牌的这一次结算**，走 `BeforeDamage` 只改这一张
 *    牌（按 `cardId` 匹配）的伤害数值，不建立「本回合永久 +X」的常驻加成。
 */

// 'mashu' 已被马岱等武将占用，技能 id 全局唯一，这里改名 'mayunlu-mashu'
const MASHU = 'mayunlu-mashu'
const FENGPO = 'fengpo'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: MASHU,
  distanceModifier: { toOthers: -1 },
})

registerSkillRuntime({
  id: FENGPO,
  triggers: [
    {
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string; targetId?: PlayerId }
        if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
        if (payload.cardName !== '杀' && payload.cardName !== '决斗') return
        if (usedThisTurn(host.state, ownerId, FENGPO)) return
        const targetId = payload.targetId ?? context.event.targetId
        if (!targetId) return
        const target = playerOf(host.state, targetId)
        if (!target?.alive) return
        markUsedThisTurn(host.state, ownerId, FENGPO)
        const x = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === 'diamond').length
        if (x <= 0) return
        host.queueSkill({ skillId: FENGPO, ownerId, step: 'ask', data: { x, cardId: (context.event.payload as { cardId?: CardId }).cardId } })
      },
    },
    {
      event: 'BeforeDamage',
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const pending = host.state.pendingFengpoBonus?.[ownerId]
        const payload = context.event.payload as { cardId?: CardId; amount?: number }
        if (context.event.sourceId !== ownerId || !payload.cardId || !pending || payload.cardId !== pending.cardId) return
        context.event.payload.amount = (payload.amount ?? 0) + pending.amount
        delete host.state.pendingFengpoBonus![ownerId]
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { x } = prompt.data as { x: number }
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: FENGPO, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【凤魄】：选择一项（X = ${x}）`,
        timeoutMs: 20_000, optional: true,
        options: [
          { id: 'draw', label: `摸 ${x} 张牌` },
          { id: 'damage', label: `这张牌造成的伤害 +${x}` },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { x, cardId } = resolution.data as { x: number; cardId?: CardId }
    const owner = playerOf(host.state, ownerId)
    const optionId = (response.payload as { optionId?: string }).optionId
    if (!owner?.alive || !optionId) return
    if (optionId === 'draw') {
      host.dispatch('SkillActivated', {
        skillId: FENGPO, skillName: '凤魄', playerId: ownerId,
        logText: `${owner.nickname}发动【凤魄】，摸 ${x} 张牌`,
      }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, x, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    if (optionId === 'damage' && cardId) {
      host.state.pendingFengpoBonus ??= {}
      host.state.pendingFengpoBonus[ownerId] = { cardId, amount: x }
      host.dispatch('SkillActivated', {
        skillId: FENGPO, skillName: '凤魄', playerId: ownerId,
        logText: `${owner.nickname}发动【凤魄】，这张牌造成的伤害 +${x}`,
      }, { sourceId: ownerId })
    }
  },
})

export const MAYUNLU: CharacterDefinition = {
  id: 'mayunlu',
  name: '马云騄',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 4,
  pack: 'sp',
  skills: [
    {
      id: MASHU,
      name: '马术',
      description: '锁定技，计算与其他角色的距离 -1。',
      locked: true,
    },
    {
      id: FENGPO,
      name: '凤魄',
      description: '马云騄在自己的回合内第一次使用【杀】或【决斗】指定目标后，X 为当前目标手牌中的方块牌数量，选择：马云騄摸 X 张牌；或这张牌造成的伤害 +X。',
    },
  ],
}
