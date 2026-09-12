import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 沮授（一将成名 2014）。
 *
 * 【渐营】：出牌阶段内，沮授使用一张牌时，若这张牌与本出牌阶段沮授使用的
 *          上一张牌点数相同或花色相同，可以摸一张牌。
 * 【矢北】：锁定技，沮授在一个回合内第一次受到伤害后回复 1 点体力，第二次
 *          及以后每次受到伤害后额外失去 1 点体力。
 *
 * 三处最容易做错的：
 *
 * 1. **渐营比较的只是紧邻的上一张牌**，按回合号近似「本出牌阶段」记账，
 *    新回合自然清空；无花色或无点数的牌只比较有定义的那一项。
 * 2. **矢北按伤害事件次数计数，不按点数**：一次 3 点伤害只算一次，
 *    回合结束（回合号变化）自动重新计数。
 * 3. **矢北的失血分支必须走 `queueSkill` 延后，不能在 `AfterDamage` 里直接
 *    调 `loseHp`**：`finalizeDamage` 派发 `AfterDamage` 之后自己还要检查
 *    同一个目标的体力、必要时调用 `enterDying`；如果在 `AfterDamage` handler
 *    里同步把这个目标也减到 0 血，会在 `finalizeDamage` 自己的检查那里对
 *    同一个人重复进濒死，直接抛「已有濒死流程正在进行」（压测复现：
 *    seed=bisect-jushou-6）。回复体力（第一次受伤）没有这个问题，
 *    只有会把人打进濒死的失血分支需要延后。
 */

const JIANYING = 'jianying'
const SHIBEI = 'shibei'
const TURN_MARK = 'jianying-turn'
const RANK_MARK = 'jianying-rank'
const SUIT_MARK = 'jianying-suit'
const SUIT_CODES: Record<Suit, number> = { spade: 1, heart: 2, club: 3, diamond: 4 }
const DAMAGE_TURN_MARK = 'shibei-turn'
const DAMAGE_COUNT_MARK = 'shibei-count'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: JIANYING,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.phase !== 'play') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { cardId?: CardId }
      const cardId = payload.cardId
      const rank = cardId ? host.state.cards[cardId]?.rank ?? null : null
      const suit = cardId ? effectiveCardSuit(host.state, ownerId, cardId) : null

      const hasPrevious = owner.marks[TURN_MARK] === host.state.turnNumber
      if (hasPrevious) {
        const prevRank = owner.marks[RANK_MARK]
        const prevSuit = owner.marks[SUIT_MARK]
        const rankMatch = rank != null && prevRank != null && prevRank === rank
        const suitMatch = suit != null && prevSuit != null && SUIT_CODES[suit] === prevSuit
        if (rankMatch || suitMatch) {
          host.dispatch('SkillActivated', {
            skillId: JIANYING, skillName: '渐营', playerId: ownerId,
            logText: `${owner.nickname}发动【渐营】，摸一张牌`,
          }, { sourceId: ownerId })
          drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
        }
      }

      owner.marks[TURN_MARK] = host.state.turnNumber
      if (rank != null) owner.marks[RANK_MARK] = rank; else delete owner.marks[RANK_MARK]
      if (suit != null) owner.marks[SUIT_MARK] = SUIT_CODES[suit]; else delete owner.marks[SUIT_MARK]
    },
  }],
})

registerSkillRuntime({
  id: SHIBEI,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (owner.marks[DAMAGE_TURN_MARK] !== host.state.turnNumber) {
        owner.marks[DAMAGE_TURN_MARK] = host.state.turnNumber
        owner.marks[DAMAGE_COUNT_MARK] = 0
      }
      owner.marks[DAMAGE_COUNT_MARK] = (owner.marks[DAMAGE_COUNT_MARK] ?? 0) + 1
      const count = owner.marks[DAMAGE_COUNT_MARK]
      host.dispatch('SkillActivated', {
        skillId: SHIBEI, skillName: '矢北', playerId: ownerId,
        logText: count === 1 ? `${owner.nickname}发动【矢北】，回复 1 点体力` : `${owner.nickname}发动【矢北】，失去 1 点体力`,
      }, { sourceId: ownerId })
      if (count === 1) {
        recover(host as never, ownerId, 1, SHIBEI)
      } else {
        // 失血可能把沮授打进濒死；这一刻还在原伤害的 AfterDamage 派发里，
        // 外层 finalizeDamage 稍后要对同一个人再查一次濒死，必须让它先走完
        host.queueSkill({ skillId: SHIBEI, ownerId, step: 'lose-hp', data: {} })
      }
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'lose-hp') return
    if (!playerOf(host.state, ownerId)?.alive) return
    loseHp(host as never, ownerId, 1, SHIBEI)
  },
})

export const JUSHOU: CharacterDefinition = {
  id: 'jushou',
  name: '沮授',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2014',
  skills: [
    {
      id: JIANYING,
      name: '渐营',
      description: '出牌阶段内，沮授使用一张牌时，若这张牌与本出牌阶段沮授使用的上一张牌点数相同或花色相同，可以摸一张牌。',
    },
    {
      id: SHIBEI,
      name: '矢北',
      description: '锁定技，沮授在一个回合内第一次受到伤害后回复 1 点体力，第二次及以后每次受到伤害后额外失去 1 点体力。',
    },
  ],
}
