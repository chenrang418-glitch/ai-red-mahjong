import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { effectiveKingdomOf } from '../../engine/huashen'
import { DELAYED_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孙皓（三国杀 OL 经典身份 SP）。
 *
 * 【残蚀】：摸牌阶段，孙皓可以额外摸X张牌（X=已受伤角色数，含自己，受
 *          【归命】影响）；发动后直到本回合结束，孙皓使用杀/普通锦囊时
 *          必须弃置1张牌（用 `prohibitsCardUse` 挡掉手牌不足以支付的
 *          情况，成功使用后再强制弃1张）。
 * 【仇海】：锁定技，孙皓没有手牌时，受到的伤害+1。
 * 【归命】：主公技，锁定技，仅当孙皓是主公时，自己回合内其他吴势力角色
 *          视为已受伤（只影响"是否已受伤"这类判定，不改真实体力）。
 */

const CANSHI = 'canshi2'
const CHOUHAI = 'chouhai'
const GUIMING = 'guiming'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 归命：孙皓自己回合内、孙皓是主公时，其他吴势力角色视为已受伤。 */
function isConsideredWounded(state: SanguoshaState, playerId: PlayerId): boolean {
  const player = playerOf(state, playerId)
  if (!player) return false
  if (player.hp < player.maxHp) return true
  const sunhao = state.players.find((candidate) => candidate.characterId === 'sunhao' && candidate.alive)
  if (!sunhao || sunhao.identity !== 'lord' || state.currentPlayerId !== sunhao.id) return false
  return sunhao.id !== playerId && effectiveKingdomOf(state, playerId) === 'wu'
}

function isCanshiCostCard(_state: SanguoshaState, cardName: string): boolean {
  if (cardName === '杀') return true
  return INSTANT_TRICKS.has(cardName) && !DELAYED_TRICKS.has(cardName)
}

registerSkillRuntime({
  id: CANSHI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: CANSHI, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string; cancelled?: boolean }
        if (context.event.sourceId !== ownerId || payload.cancelled || !payload.cardName) return
        if (host.state.sunhaoCostTurn !== host.state.turnNumber || !isCanshiCostCard(host.state, payload.cardName)) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        host.queueSkill({ skillId: CANSHI, ownerId, step: 'pay', data: {} })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      const woundedCount = host.state.players.filter((candidate) => candidate.alive && isConsideredWounded(host.state, candidate.id)).length
      if (woundedCount <= 0) return
      host.askSkill({
        skillId: CANSHI, ownerId, step: 'ask', data: { woundedCount },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【残蚀】：是否额外摸${woundedCount}张牌？`, timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'pay') {
      host.askSkill({
        skillId: CANSHI, ownerId, step: 'pay',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【残蚀】：弃置1张牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const { woundedCount } = resolution.data as { woundedCount: number }
      host.dispatch('SkillActivated', { skillId: CANSHI, skillName: '残蚀', playerId: ownerId, logText: `${owner.nickname}发动【残蚀】，摸${woundedCount}张牌` }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, woundedCount, (name, payload) => { host.dispatch(name, payload) })
      host.state.sunhaoCostTurn = host.state.turnNumber
      return
    }
    if (resolution.step === 'pay') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: CANSHI }, { sourceId: ownerId, cardIds: [cardId] })
    }
  },

  prohibitsCardUse(state, ownerId, context) {
    if (context.userId !== ownerId || state.sunhaoCostTurn !== state.turnNumber) return false
    if (!isCanshiCostCard(state, context.cardName)) return false
    const owner = playerOf(state, ownerId)
    return (owner?.zones.hand.length ?? 0) < 2
  },
})

registerSkillRuntime({
  id: CHOUHAI,
  incomingDamage(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    if (!owner || owner.zones.hand.length > 0) return null
    return { amount: context.amount + 1 }
  },
})

registerSkillRuntime({
  id: GUIMING,
  lord: true,
})

export const SUNHAO: CharacterDefinition = {
  id: 'sunhao',
  name: '孙皓',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: CANSHI, name: '残蚀', description: '摸牌阶段，孙皓可以额外摸X张牌（X为已受伤角色数，含自己）；若发动，直到本回合结束，孙皓使用杀或普通锦囊后须弃置1张牌，弃不出则不能使用。' },
    { id: CHOUHAI, name: '仇海', description: '锁定技，孙皓没有手牌时，受到的伤害+1。' },
    { id: GUIMING, name: '归命', description: '主公技，锁定技，孙皓担任主公时，自己回合内其他吴势力角色视为已受伤。' },
  ],
}
