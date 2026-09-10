import { aggregateCardColor, setCardColorOverride } from '../../engine/card-color'
import { instantTrickActions } from '../../engine/cards/tricks'
import { executeUseCardAction } from '../../engine/cards/basic'
import { drawCards } from '../../engine/draw'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { createVirtualTrick, virtualTrickChoices } from '../../engine/virtual-trick'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 荀攸（一将成名 2012 经典）。
 *
 * 【奇策】：出牌阶段限一次，你可以将所有手牌当任意一张普通锦囊牌使用（至少一张手牌）。
 * 【智愚】：当你受到伤害后，你可以摸一张牌并展示所有手牌，
 *          若颜色均相同，则伤害来源弃置一张手牌。
 *
 * 六处最容易做错的：
 *
 * 1. **必须是全部手牌**，不能只选一部分；一张手牌都没有时不能发动。
 * 2. **锦囊候选从注册表动态生成**，不写死牌名清单——和神·郭嘉【佐幸】
 *    同一个入口，逐张试算「现在有没有合法目标」。【无懈可击】因此
 *    自然不在候选里：它不是出牌阶段可以主动使用的牌。
 * 3. **子牌真的被消耗**：全部进弃牌堆，然后用一张虚拟锦囊结算。
 * 4. **颜色按全部子牌聚合**：全红算红、全黑算黑、混着就是**无色**。
 *    取第一张子牌的颜色是错的。
 * 5. **智愚一次伤害只给一次机会**，不按点数循环；伤害被防止或被换成
 *    失去体力时不触发——那些情况下他没有受到伤害。
 * 6. **弃哪一张由伤害来源自己选**：荀攸看不到对方的手牌。
 */

const QICE = 'qice'
const ZHIYU = 'zhiyu'
const QICE_ACTION = 'qice-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 奇策 ───────────────────────────────

registerSkillRuntime({
  id: QICE,
  announcesSelf: true,
  /*
   * 这条主动入口最终会**使用一张牌**，所以被「不能使用牌」的效果封住时
   * 不该再展示。
   *
   * `legalPlayActions` 末尾那道禁用过滤只筛 `use-card` 动作，筛不到
   * 主动技按钮；不声明这一条的话，按钮照出、点下去却静默失败，
   * 场面一点没变——压测里这就是个无限循环（seed=banner-18）。
   */
  activeActionUsesCard: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisPhase(state, ownerId, QICE)) return []
    const owner = playerOf(state, ownerId)
    // **至少一张手牌**：没有子牌就不存在「把所有手牌当作」这件事
    if (!owner?.alive || owner.zones.hand.length === 0) return []
    if (virtualTrickChoices(state, ownerId).length === 0) return []
    return [{ id: QICE_ACTION, label: '奇策：将所有手牌当一张普通锦囊牌使用' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== QICE_ACTION) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const choices = virtualTrickChoices(host.state, ownerId)
    if (choices.length === 0) return
    host.askSkill({
      skillId: QICE, ownerId, step: 'trick',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【奇策】：将全部 ${owner.zones.hand.length} 张手牌当作哪张普通锦囊使用`,
        timeoutMs: 25_000,
        // 取消不消耗「出牌阶段限一次」
        optional: true,
        options: [
          ...choices.map((name) => ({ id: name, label: `当作【${name}】` })),
          { id: 'cancel', label: '不发动' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'trick') {
      const name = (response.payload as { optionId?: string }).optionId
      if (!name || name === 'cancel' || !owner?.alive) return
      // 落地前重新验一次：发问期间手牌和场面都可能变了
      if (owner.zones.hand.length === 0) return
      if (!virtualTrickChoices(host.state, ownerId).includes(name)) return
      markUsedThisPhase(host.state, ownerId, QICE)

      /*
       * **代价先付：所有手牌进弃牌堆。**
       *
       * 付完之后手上是空的，所以随后印出来的虚拟锦囊是这一步里唯一的牌，
       * 目标合法性算出来的就是它自己的。
       */
      const subCards: CardId[] = [...owner.zones.hand]
      const color = aggregateCardColor(host.state, subCards)
      for (const cardId of subCards) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }, { discardReason: 'other' })
      }
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: subCards, reason: QICE }, { targetId: ownerId, cardIds: subCards })

      const cardId = createVirtualTrick(host.state, ownerId, name, QICE)
      /*
       * 颜色按全部子牌聚合，单独记在牌上——虚拟牌没有真实花色，
       * 不记的话它会被当成牌面上那个占位花色（黑桃）。
       */
      setCardColorOverride(host.state, cardId, color)
      host.dispatch('SkillActivated', {
        skillId: QICE, skillName: '奇策', playerId: ownerId,
        logText: `${owner.nickname}发动【奇策】，将 ${subCards.length} 张手牌当作【${name}】使用`,
      }, { sourceId: ownerId })

      const [action] = instantTrickActions(host.state, ownerId, cardId, name)
      if (!action || action.kind !== 'use-card') {
        // 落地时已经没有合法目标：把印出来的牌撤掉，不留残牌
        discardVirtual(host.state, ownerId, cardId)
        return
      }
      // 固定目标的锦囊（南蛮、万箭、桃园、五谷）直接走，不必再问
      if (action.targetMode === 'fixed' || action.targetMax === 0) {
        executeUseCardAction(host as never, ownerId, action)
        return
      }
      host.askSkill({
        skillId: QICE, ownerId, step: 'targets', data: { cardId, cardName: name },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【奇策】：为【${name}】选择目标`,
          timeoutMs: 25_000, optional: false,
          candidateIds: action.targetIds, min: action.targetMin, max: action.targetMax,
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const cardId = resolution.data.cardId as CardId
      const name = resolution.data.cardName as string
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const [action] = instantTrickActions(host.state, ownerId, cardId, name)
      if (!action || action.kind !== 'use-card' || targetIds.length === 0) {
        discardVirtual(host.state, ownerId, cardId)
        return
      }
      executeUseCardAction(host as never, ownerId, { ...action, targetIds })
    }
  },
})

/** 印出来但没用出去的虚拟牌要就地销毁，不能留在手上，也不能进弃牌堆。 */
function discardVirtual(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): void {
  const owner = playerOf(state, ownerId)
  if (owner) owner.zones.hand = owner.zones.hand.filter((candidate) => candidate !== cardId)
  delete state.cards[cardId]
}

// ─────────────────────────────── 智愚 ───────────────────────────────

registerSkillRuntime({
  id: ZHIYU,
  triggers: [{
    /*
     * 「受到伤害后」——**一次伤害一次机会**，不按点数循环。
     * 挂在 `AfterDamage` 上：被防止的、被【绝情】换成失去体力的都走不到这里。
     */
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const sourceId = (context.event.sourceId as PlayerId | undefined) ?? null
      host.queueSkill({ skillId: ZHIYU, ownerId, step: 'ask', data: { sourceId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: ZHIYU, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【智愚】：摸一张牌并展示所有手牌？若颜色均相同，伤害来源弃置一张手牌',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【智愚】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })

      /*
       * **展示是公开的**：所有人都看得到他此刻的全部手牌。
       * 事件里带上牌 id，前端和战报据此显示；这是智愚明码标价的代价。
       */
      const hand = [...owner.zones.hand]
      host.dispatch('CardMove', { cardIds: hand, reason: ZHIYU, revealed: true, playerId: ownerId }, { targetId: ownerId, cardIds: hand })
      const color = aggregateCardColor(host.state, hand)
      host.dispatch('SkillActivated', {
        skillId: ZHIYU, skillName: '智愚', playerId: ownerId,
        logText: `${owner.nickname}发动【智愚】，展示 ${hand.length} 张手牌`
          + (color ? `（颜色均相同）` : `（颜色不同）`),
      }, { sourceId: ownerId })
      if (!color || hand.length === 0) return

      const sourceId = (resolution.data.sourceId as PlayerId | null) ?? null
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      // 没有伤害来源（闪电这类）时到此为止；来源没有手牌也不弹空窗口
      if (!source?.alive || source.zones.hand.length === 0) return
      host.askSkill({
        skillId: ZHIYU, ownerId, step: 'discard', data: { sourceId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards',
          // **弃哪一张由来源自己选**：荀攸看不到对方手牌
          playerId: sourceId!,
          prompt: `【智愚】：${owner.nickname}的手牌颜色均相同，弃置你的一张手牌`,
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: [...source.zones.hand], hiddenCardSlots: [],
          min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const sourceId = resolution.data.sourceId as PlayerId
      const source = playerOf(host.state, sourceId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!source?.alive || !cardId || !source.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' }, { discardReason: 'discard' })
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: ZHIYU }, { targetId: sourceId, cardIds: [cardId] })
    }
  },
})

export const XUNYOU: CharacterDefinition = {
  id: 'xunyou',
  name: '荀攸',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2012',
  skills: [
    {
      id: QICE,
      name: '奇策',
      description: '出牌阶段限一次，你可以将所有手牌当任意一张普通锦囊牌使用（至少一张手牌）。',
    },
    {
      id: ZHIYU,
      name: '智愚',
      description: '当你受到伤害后，你可以摸一张牌并展示所有手牌，'
        + '若颜色均相同，则伤害来源弃置一张手牌。',
    },
  ],
}
