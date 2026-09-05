import { revealTopCards } from '../../engine/draw'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { effectiveCardSuit, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import { skillIdsOf } from './standard'
import type { CharacterDefinition } from './types'

/**
 * 神吕蒙。本项目自研表述。
 *
 * - **涉猎**：摸牌阶段，你可以放弃摸牌，改为亮出牌堆顶五张牌，
 *   然后获得其中每种花色的牌各一张，其余的牌置入弃牌堆。
 * - **攻心**：出牌阶段限一次，你可以观看一名其他角色的手牌，
 *   然后你可以展示其中一张红桃牌，并将之置于牌堆顶或弃置之。
 */

export const SHELIE = 'shelie'
export const GONGXIN = 'gongxin'

const SHELIE_REASON = '涉猎'
const GONGXIN_ACTION = 'gongxin-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 花色按**有效花色**取，红颜之类的修正一并生效。 */
function suitOf(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): Suit {
  return effectiveCardSuit(state, ownerId, cardId, skillIdsOf)
}

// ─────────────────────────────── 涉猎 ───────────────────────────────

/**
 * 亮出的五张牌里，还有哪些花色可以拿。
 *
 * 「每种花色各一张」：已经拿过的花色不能再拿第二张。
 */
function remainingSuits(state: SanguoshaState, ownerId: PlayerId, pool: CardId[], taken: CardId[]): Suit[] {
  const takenSuits = new Set(taken.map((cardId) => suitOf(state, ownerId, cardId)))
  const available = new Set(pool.map((cardId) => suitOf(state, ownerId, cardId)))
  return [...available].filter((suit) => !takenSuits.has(suit))
}

/**
 * 问下一张要拿哪张。
 *
 * 同一花色出现多张时**由玩家自己选**，不能系统固定拿第一张。
 * 候选只列出「还没拿过的花色」里的牌，于是「每种花色各一张」在协议层就成立了。
 */
function askSheliePick(host: SkillHost, ownerId: PlayerId, pool: CardId[], taken: CardId[]): boolean {
  const suits = remainingSuits(host.state, ownerId, pool, taken)
  if (suits.length === 0) return false
  const candidates = pool.filter((cardId) => suits.includes(suitOf(host.state, ownerId, cardId)))
  if (candidates.length === 0) return false
  host.askSkill({
    skillId: SHELIE, ownerId, step: 'pick', data: { pool, taken },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【涉猎】：从亮出的牌里获得一张（每种花色各一张，还剩 ${suits.length} 种）`,
      timeoutMs: 20_000, optional: false, purpose: 'skill',
      // 亮出的牌是公开的，直接列出来
      cardIds: candidates, hiddenCardSlots: [],
      min: 1, max: 1,
    }),
  })
  return true
}

/** 拿完之后：剩下的牌进弃牌堆。 */
function finishShelie(host: SkillHost, pool: CardId[], taken: CardId[]): void {
  const rest = pool.filter((cardId) => !taken.includes(cardId))
  for (const cardId of rest) {
    if (!host.state.zones.processingArea.includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }
  // 阶段的补牌到此为止，交回阶段状态机
  host.advancePhase()
}

registerSkillRuntime({
  id: SHELIE,
  announcesSelf: true,

  triggers: [{
    /**
     * 摸牌阶段替代。
     *
     * 走「取消 DrawPhase 事件」这条既有约定（裸衣、突袭、双雄、再起同一条）：
     * 取消之后这个阶段的补牌完全由技能负责。
     * **摸牌阶段被跳过时（兵粮寸断、巧变）根本不会派发 DrawPhase**，
     * 所以涉猎自然发动不了，不需要额外判断。
     */
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      context.cancel()
      host.askSkill({
        skillId: SHELIE, ownerId, step: 'ask',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '发动【涉猎】？放弃摸牌，改为亮出牌堆顶五张牌，获得其中每种花色各一张',
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动涉猎' }, { id: 'no', label: '正常摸牌' }],
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') {
        // 放弃发动：DrawPhase 已经被取消了，得由技能自己把两张摸回来
        drawNormally(host, ownerId)
        host.advancePhase()
        return
      }
      const emit = (name: Parameters<SkillHost['dispatch']>[0], payload?: Record<string, unknown>): void => { host.dispatch(name, payload) }
      const revealed = revealTopCards(host.state, host.rng, 5, SHELIE_REASON, emit)
      if (revealed.length === 0) {
        host.advancePhase()
        return
      }
      host.dispatch('SkillActivated', {
        skillId: SHELIE, skillName: SHELIE_REASON, playerId: ownerId, result: 'reveal', cardIds: revealed,
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【涉猎】，亮出 ${revealed.length} 张牌`,
      }, { sourceId: ownerId, cardIds: revealed })
      if (!askSheliePick(host, ownerId, revealed, [])) finishShelie(host, revealed, [])
      return
    }

    if (resolution.step === 'pick') {
      const pool = (resolution.data.pool as CardId[]) ?? []
      const taken = [...((resolution.data.taken as CardId[]) ?? [])]
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      if (cardId && host.state.zones.processingArea.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        // 亮过的牌是公开的，所以 GainCard 带 revealed
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SHELIE_REASON, revealed: true }, { targetId: ownerId, cardIds: [cardId] })
        taken.push(cardId)
      }
      if (!askSheliePick(host, ownerId, pool, taken)) finishShelie(host, pool, taken)
    }
  },
})

/** 放弃涉猎时把常规的两张补回来——DrawPhase 已经被取消，引擎不会再发牌。 */
function drawNormally(host: SkillHost, ownerId: PlayerId): void {
  const emit = (name: Parameters<SkillHost['dispatch']>[0], payload?: Record<string, unknown>): void => { host.dispatch(name, payload) }
  const drawn = revealTopCards(host.state, host.rng, 2, SHELIE_REASON, emit)
  for (const cardId of drawn) {
    if (!host.state.zones.processingArea.includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
  }
  if (drawn.length > 0) {
    host.dispatch('GainCard', { playerId: ownerId, cardIds: drawn, reason: '摸牌' }, { targetId: ownerId, cardIds: drawn })
  }
}

// ─────────────────────────────── 攻心 ───────────────────────────────

const GONGXIN_DISCARD = 'gongxin-discard'
const GONGXIN_TOPDECK = 'gongxin-topdeck'

registerSkillRuntime({
  id: GONGXIN,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisTurn(state, ownerId, GONGXIN)) return []
    if (gongxinTargets(state, ownerId).length === 0) return []
    return [{ id: GONGXIN_ACTION, label: '攻心：观看一名其他角色的手牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== GONGXIN_ACTION) return
    const candidateIds = gongxinTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: GONGXIN, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【攻心】：观看哪名角色的手牌',
        timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      // 取消不消耗「出牌阶段限一次」
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.zones.hand.length === 0) return
      markUsedThisTurn(host.state, ownerId, GONGXIN)

      /*
       * **观看全部手牌**。
       *
       * 把真实 cardId 放进一个发给神吕蒙的请求里是安全的：
       * `buildPlayerView` 只下发**观看者自己**那一条 pendingRequest
       * （`state.pendingRequests.find(r => r.playerId === viewerId)`），
       * 第三方连这条请求的存在都看不到，更看不到牌面。
       *
       * 没有红桃时仍然给他看完，只是候选为空、之后没有可处理的牌——
       * 规则是「观看手牌，然后**可以**展示其中一张红桃牌」。
       */
      const hearts = target.zones.hand.filter((cardId) => suitOf(host.state, ownerId, cardId) === 'heart')
      host.dispatch('SkillActivated', {
        skillId: GONGXIN, skillName: '攻心', playerId: ownerId, targetIds: [targetId],
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【攻心】，观看${target.nickname}的手牌`,
      }, { sourceId: ownerId, targetId })

      host.askSkill({
        skillId: GONGXIN, ownerId, step: 'view', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: hearts.length > 0
            ? `【攻心】：${target.nickname}的手牌（可展示其中一张红桃）`
            : `【攻心】：${target.nickname}的手牌里没有红桃`,
          timeoutMs: 30_000, optional: true, purpose: 'skill',
          // 全部手牌都发给神吕蒙看；只有红桃能被选中处理
          cardIds: hearts, hiddenCardSlots: [],
          min: 0, max: hearts.length > 0 ? 1 : 0,
        }),
      })
      return
    }

    if (resolution.step === 'view') {
      const targetId = resolution.data.targetId as PlayerId
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      const target = playerOf(host.state, targetId)
      // 没有红桃、或者选择不处理：攻心到此结束
      if (!cardId || !target?.alive || !target.zones.hand.includes(cardId)) return
      host.askSkill({
        skillId: GONGXIN, ownerId, step: 'dispose', data: { targetId, cardId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【攻心】：如何处理${host.state.cards[cardId]?.name ?? ''}`,
          timeoutMs: 20_000, optional: false,
          options: [
            { id: GONGXIN_TOPDECK, label: '置于牌堆顶' },
            { id: GONGXIN_DISCARD, label: '弃置' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'dispose') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = resolution.data.cardId as CardId
      const target = playerOf(host.state, targetId)
      // 发问期间牌可能已经不在他手上了，落地前重新验一次
      if (!target?.alive || !target.zones.hand.includes(cardId)) return
      const optionId = (response.payload as { optionId: string }).optionId

      // 展示出来的那张牌是公开的
      host.dispatch('SkillActivated', {
        skillId: GONGXIN, skillName: '攻心', playerId: ownerId, targetIds: [targetId], cardIds: [cardId],
        logText: `【攻心】展示${target.nickname}的${host.state.cards[cardId]?.name ?? ''}，${optionId === GONGXIN_TOPDECK ? '置于牌堆顶' : '弃置'}`,
      }, { sourceId: ownerId, targetId, cardIds: [cardId] })

      // 两条都是**真实移动**，不是复制：置顶之后下一张摸到的就是它
      moveCard(
        host.state, cardId,
        { kind: 'hand', playerId: targetId },
        { kind: optionId === GONGXIN_TOPDECK ? 'drawPile' : 'discardPile' },
        optionId === GONGXIN_TOPDECK ? { toTop: true } : {},
      )
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: GONGXIN }, { targetId, cardIds: [cardId] })
    }
  },
})

/** 攻心的候选：**有手牌**的其他存活角色。没手牌的看了也没意义。 */
function gongxinTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)
    .map((candidate) => candidate.id)
}

export const SHENLVMENG: CharacterDefinition = {
  id: 'shenlvmeng',
  name: '神·吕蒙',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 3,
  pack: 'god',
  skills: [
    {
      id: SHELIE,
      name: '涉猎',
      description: '摸牌阶段，你可以放弃摸牌，改为亮出牌堆顶五张牌，然后获得其中每种花色的牌各一张，其余的牌置入弃牌堆。',
    },
    {
      id: GONGXIN,
      name: '攻心',
      description: '出牌阶段限一次，你可以观看一名其他角色的手牌，然后你可以展示其中一张红桃牌，并将之置于牌堆顶或弃置之。',
    },
  ],
}
