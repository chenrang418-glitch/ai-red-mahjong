import { instantTrickActions } from '../../engine/cards/tricks'
import { executeUseCardAction } from '../../engine/cards/basic'
import { drawCards } from '../../engine/draw'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { effectiveKingdomOf } from '../../engine/huashen'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘谌（一将成名 2015）。
 *
 * 【战绝】：出牌阶段，刘谌可以将所有手牌（至少一张）当作【决斗】使用。此
 *          【决斗】结算完毕后，刘谌摸一张牌；若有角色因这次战绝造成的
 *          【决斗】真正受到过伤害，该角色摸一张牌。若刘谌本出牌阶段因战绝
 *          累计摸牌 ≥2 张，本回合不能再发动战绝。
 * 【勤王】：主公技，只有刘谌担任主公时生效，其他蜀势力角色可以代替他打出
 *          需要的【杀】。
 *
 * 两处最容易做错的：
 *
 * 1. **战绝的子牌真实消耗**：所有手牌先进弃牌堆，再印一张虚拟【决斗】，
 *    走既有的虚拟锦囊生命周期（结算完自动销毁），不产生实体牌。
 * 2. **战绝的摸牌上限按「刘谌因战绝累计摸过多少张」计**，若刘谌本人就是
 *    受伤者，他这一次战绝就摸了 2 张（自己那 1 张 + 受伤者那 1 张），
 *    立刻达到本回合的封顶。
 */

// 'zhanjue' 已被神黄忠【斩绝】占用，技能 id 全局唯一，这里改名 'liuchen-zhanjue'
const ZHANJUE = 'liuchen-zhanjue'
const ZHANJUE_ACTION = 'zhanjue-invoke'
const QINWANG = 'qinwang'
const DRAW_COUNT_MARK = 'zhanjue-draw-count'
const DISABLED_MARK = 'zhanjue-disabled-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: ZHANJUE,
  announcesSelf: true,
  activeActionUsesCard: true,

  triggers: [{
    event: 'AfterDamage',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (!payload.cardId || !host.state.trackedDuelVictim || !(payload.cardId in host.state.trackedDuelVictim)) return
      if (host.state.trackedDuelVictim[payload.cardId]) return
      host.state.trackedDuelVictim[payload.cardId] = context.event.targetId!
    },
  }],

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if ((playerOf(state, ownerId)?.marks[DISABLED_MARK] ?? -1) === state.turnNumber) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return []
    const probeId = `zhanjue-probe:${ownerId}`
    state.cards[probeId] = {
      id: probeId, ruleset: state.rulesetVersion, expansion: 'standard', name: '决斗',
      suit: 'spade', rank: 1, color: 'black', category: 'trick', virtual: true,
    }
    let usable = false
    try { usable = instantTrickActions(state, ownerId, probeId, '决斗').length > 0 } finally { delete state.cards[probeId] }
    if (!usable) return []
    return [{ id: ZHANJUE_ACTION, label: '战绝：将所有手牌当作【决斗】使用' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHANJUE_ACTION) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const subCards = [...owner.zones.hand]
    for (const cardId of subCards) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }, { discardReason: 'other' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: subCards, reason: ZHANJUE }, { targetId: ownerId, cardIds: subCards })

    const cardId = createVirtualTrick(host.state, ownerId, '决斗', ZHANJUE)
    host.state.trackedDuelVictim ??= {}
    host.state.trackedDuelVictim[cardId] = null as unknown as PlayerId
    host.dispatch('SkillActivated', {
      skillId: ZHANJUE, skillName: '战绝', playerId: ownerId,
      logText: `${owner.nickname}发动【战绝】，将 ${subCards.length} 张手牌当作【决斗】使用`,
    }, { sourceId: ownerId })

    const [action] = instantTrickActions(host.state, ownerId, cardId, '决斗')
    if (!action || action.kind !== 'use-card') {
      delete host.state.cards[cardId]
      if (host.state.trackedDuelVictim) delete host.state.trackedDuelVictim[cardId]
      return
    }
    if (action.targetMax === 1 && action.targetIds.length === 1) {
      executeUseCardAction(host as never, ownerId, action)
      return
    }
    host.askSkill({
      skillId: ZHANJUE, ownerId, step: 'target', data: { cardId },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【战绝】：为这张【决斗】选择目标',
        timeoutMs: 25_000, optional: false,
        candidateIds: action.targetIds, min: action.targetMin, max: action.targetMax,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const cardId = resolution.data.cardId as CardId
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const [action] = instantTrickActions(host.state, ownerId, cardId, '决斗')
    if (!action || action.kind !== 'use-card' || targetIds.length === 0) {
      if (host.state.cards[cardId]) delete host.state.cards[cardId]
      if (host.state.trackedDuelVictim) delete host.state.trackedDuelVictim[cardId]
      return
    }
    executeUseCardAction(host as never, ownerId, { ...action, targetIds })
  },
})

/** 决斗结算完毕（无论有没有造成伤害）后的收尾：摸牌、累计计数、达到上限就本回合封锁。 */
registerSkillRuntime({
  id: `${ZHANJUE}-finish`,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
      if (payload.sourceSkillId !== ZHANJUE || !payload.cardId) return
      const cardId = payload.cardId
      const victim = host.state.trackedDuelVictim?.[cardId] || null
      if (host.state.trackedDuelVictim) delete host.state.trackedDuelVictim[cardId]
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      let drawn = 1
      drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      if (victim && victim !== ownerId && playerOf(host.state, victim)?.alive) {
        drawCards(host.state, host.rng, victim, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      } else if (victim === ownerId) {
        drawn += 1
      }
      const total = (owner.marks[DRAW_COUNT_MARK] ?? 0) + drawn
      owner.marks[DRAW_COUNT_MARK] = total
      if (total >= 2) owner.marks[DISABLED_MARK] = host.state.turnNumber
    },
  }],
})

registerSkillRuntime({
  id: QINWANG,
  lord: true,
  surrogateResponders(state, ownerId, requiredCardName) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.identity !== 'lord' || requiredCardName !== '杀') return []
    const result: PlayerId[] = []
    for (let offset = 1; offset < state.players.length; offset += 1) {
      const candidate = state.players[(owner.seat + offset) % state.players.length]
      if (candidate.alive && candidate.characterId && effectiveKingdomOf(state, candidate.id) === 'shu') result.push(candidate.id)
    }
    return result
  },
})

export const LIUCHEN: CharacterDefinition = {
  id: 'liuchen',
  name: '刘谌',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2015',
  skills: [
    {
      id: ZHANJUE,
      name: '战绝',
      description: '出牌阶段，刘谌可以将所有手牌（至少一张）当作【决斗】使用。此【决斗】结算完毕后，刘谌摸一张牌；若有角色因这次战绝造成的【决斗】真正受到过伤害，该角色摸一张牌。若刘谌本出牌阶段因战绝累计摸牌达到 2 张，本回合不能再发动战绝。',
    },
    {
      id: QINWANG,
      name: '勤王',
      description: '主公技，只有刘谌担任主公时生效，其他蜀势力角色可以代替他打出需要的【杀】。',
    },
  ],
}
