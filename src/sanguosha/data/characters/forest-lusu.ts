import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { giveCards, swapHands } from '../../engine/hand-transfer'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 林包·鲁肃。经典「神话再临·林」首版，不是界鲁肃。
 *
 * 【好施】「摸牌阶段，你可以多摸两张牌，然后若你的手牌数大于 5，
 *   你将一半的手牌（向下取整）交给手牌最少的一名其他角色。」
 * 【缔盟】「出牌阶段限一次，你可以选择两名其他角色并弃置 X 张牌
 *   （X 为这两名角色手牌数的差），然后令这两名角色交换手牌。」
 *
 * 两个技能都不自己搬牌：给牌和换手牌都走 `engine/hand-transfer.ts`。
 * **交给 ≠ 弃置**，牌一步都不能路过弃牌堆。
 */

export const HAOSHI = 'haoshi'
export const DIMENG = 'dimeng'

/** 好施的手牌阈值和额外摸牌数，写成常量是为了让规则文本和实现一眼对得上。 */
const HAOSHI_EXTRA_DRAW = 2
const HAOSHI_HAND_THRESHOLD = 5

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function otherAlive(state: SanguoshaState, ownerId: PlayerId) {
  return state.players.filter((player) => player.alive && player.id !== ownerId)
}

// ─────────────────────────────── 好施 ───────────────────────────────

/**
 * 现在手牌最少的其他角色。可能并列，由鲁肃自己选一个。
 *
 * **不含鲁肃自己**：技能文本写的是「其他角色」，哪怕鲁肃手牌更少也不参与。
 * 数量必须现算——发问和结算之间别人的手牌可能已经变了。
 */
function fewestHandIds(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const others = otherAlive(state, ownerId)
  if (others.length === 0) return []
  const fewest = Math.min(...others.map((player) => player.zones.hand.length))
  return others.filter((player) => player.zones.hand.length === fewest).map((player) => player.id)
}

/** 要交出去几张：当前手牌的一半，向下取整。 */
function giveCount(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner) return 0
  return Math.floor(owner.zones.hand.length / 2)
}

/**
 * 摸完之后决定要不要走交牌那一半。
 *
 * 阈值判的是**当前真实手牌数**，不是「原手牌 + 4」推出来的——
 * 中间可能插进别的摸牌、洗牌或技能。
 */
function continueHaoshi(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (owner.zones.hand.length <= HAOSHI_HAND_THRESHOLD) return
  const candidates = fewestHandIds(host.state, ownerId)
  if (candidates.length === 0) return

  // 唯一最少时不必多问一步；并列才让鲁肃选
  if (candidates.length === 1) {
    askHaoshiCards(host, ownerId, candidates[0])
    return
  }
  host.askSkill({
    skillId: HAOSHI, ownerId, step: 'target',
    build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId,
      prompt: `【好施】：把一半手牌交给谁？（这几名角色手牌都最少）`,
      timeoutMs: 20_000, optional: false,
      candidateIds: candidates, min: 1, max: 1,
    }),
  })
}

function askHaoshiCards(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner || !target?.alive) return
  const count = giveCount(host.state, ownerId)
  if (count <= 0) return
  host.askSkill({
    skillId: HAOSHI, ownerId, step: 'cards', data: { targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【好施】：选 ${count} 张手牌交给${target.nickname}`,
      timeoutMs: 30_000, optional: false, purpose: 'skill',
      // 只能给手牌，装备区不行
      cardIds: [...owner.zones.hand], hiddenCardSlots: [],
      min: count, max: count,
    }),
  })
}

registerSkillRuntime({
  id: HAOSHI,
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      // 已经有技能占着发问位就让开（和裸衣、突袭、双雄、再起同一条约定）
      if (host.state.skillResolution) return
      /*
       * 摸牌阶段整个被跳过（兵粮寸断、神速）时，DrawPhase 事件根本不会派发，
       * 所以好施自然不会触发——不需要在这里额外判断，也**不能**挂到别的时机上。
       */
      context.cancel()
      host.askSkill({
        skillId: HAOSHI, ownerId, step: 'ask',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `发动【好施】？多摸 ${HAOSHI_EXTRA_DRAW} 张牌；若摸完手牌多于 ${HAOSHI_HAND_THRESHOLD} 张，须将一半手牌交给手牌最少的一名其他角色`,
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动好施' }, { id: 'no', label: '正常摸两张牌' }],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const invoked = (response.payload as { optionId: string }).optionId === 'yes'
      // DrawPhase 已经被取消，这个阶段的牌全由技能负责补
      drawCards(host.state, host.rng, ownerId, invoked ? 2 + HAOSHI_EXTRA_DRAW : 2, (name, payload) => { host.dispatch(name, payload) })
      /*
       * 交牌那一半**只在真的发动过好施时**检查。
       * 直接接在同一条续接里，所以不需要额外存一个「本阶段发动过」的标记——
       * 没发动的路径根本走不到这里。
       */
      if (invoked) continueHaoshi(host, ownerId)
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      askHaoshiCards(host, ownerId, targetId)
      return
    }

    if (resolution.step === 'cards') {
      const targetId = resolution.data.targetId as PlayerId
      const cardIds = (response.payload as { cardIds: CardId[] }).cardIds
      giveCards(host, ownerId, targetId, cardIds, '好施')
    }
  },
})

// ─────────────────────────────── 缔盟 ───────────────────────────────

/** 缔盟的代价能从哪些牌里出：手牌 + 装备区。文本写的是「弃置 X 张牌」，不是「手牌」。 */
function discardableOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const owner = playerOf(state, playerId)
  if (!owner?.alive) return []
  return [
    ...owner.zones.hand,
    ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
  ]
}

/** X = 两名目标手牌数之差。结算当时现算，不用锁定目标那一刻的快照。 */
function dimengCost(state: SanguoshaState, leftId: PlayerId, rightId: PlayerId): number {
  const left = playerOf(state, leftId)
  const right = playerOf(state, rightId)
  if (!left || !right) return 0
  return Math.abs(left.zones.hand.length - right.zones.hand.length)
}

function performDimeng(host: SkillHost, ownerId: PlayerId, leftId: PlayerId, rightId: PlayerId): void {
  const left = playerOf(host.state, leftId)
  const right = playerOf(host.state, rightId)
  if (!left?.alive || !right?.alive) return
  markUsedThisTurn(host.state, ownerId, DIMENG)
  host.dispatch('SkillActivated', {
    skillId: DIMENG, skillName: '缔盟', playerId: ownerId, targetIds: [leftId, rightId], result: 'swap',
    logText: `${playerOf(host.state, ownerId)?.nickname}发动【缔盟】，${left.nickname}与${right.nickname}交换手牌`,
  }, { sourceId: ownerId, targetId: leftId })
  swapHands(host, leftId, rightId, '缔盟')
}

registerSkillRuntime({
  id: DIMENG,
  announcesSelf: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    if (usedThisTurn(state, ownerId, DIMENG)) return []
    if (otherAlive(state, ownerId).length < 2) return []
    return [{ id: `skill:${DIMENG}`, label: '发动【缔盟】：令两名其他角色交换手牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${DIMENG}`) return
    const candidateIds = otherAlive(host.state, ownerId).map((player) => player.id)
    if (candidateIds.length < 2) return
    host.askSkill({
      skillId: DIMENG, ownerId, step: 'targets',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【缔盟】：选择两名其他角色交换手牌，代价是弃置张数等于两人手牌数之差的牌',
        timeoutMs: 25_000, optional: true,
        /*
         * min 写 0 而不是 2，是为了让「放弃发动」有路可走：
         * choose-targets 的校验只看 min/max，不看 optional，min 为 2 时
         * 交空数组会被判非法，玩家和 AI 都没法收手。
         * 「必须选满两个」由下面的续接把关：不足两个一律当作放弃，
         * 不消耗本回合这一次。鲁肃自己本来就不在候选里。
         */
        candidateIds, min: 0, max: 2,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds
      // 放弃发动：不消耗本回合这一次
      if (targetIds.length < 2) return
      const [leftId, rightId] = targetIds
      if (leftId === rightId || leftId === ownerId || rightId === ownerId) return
      const left = playerOf(host.state, leftId)
      const right = playerOf(host.state, rightId)
      if (!left?.alive || !right?.alive) return

      const cost = dimengCost(host.state, leftId, rightId)
      // X = 0：两人手牌一样多，不弹「请选择 0 张牌」的空窗口，直接换
      if (cost === 0) {
        performDimeng(host, ownerId, leftId, rightId)
        return
      }
      const pool = discardableOf(host.state, ownerId)
      if (pool.length < cost) {
        // 付不起就当作没发动过，本回合还能重新挑一对
        host.dispatch('SkillActivated', {
          skillId: DIMENG, skillName: '缔盟', playerId: ownerId, result: 'unaffordable',
          logText: `${playerOf(host.state, ownerId)?.nickname}的牌不足 ${cost} 张，无法发动【缔盟】`,
        }, { sourceId: ownerId })
        return
      }
      host.askSkill({
        skillId: DIMENG, ownerId, step: 'cost', data: { leftId, rightId, cost },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【缔盟】：弃置 ${cost} 张牌（${left.nickname}与${right.nickname}手牌数之差）`,
          timeoutMs: 30_000, optional: false, purpose: 'skill',
          cardIds: pool, hiddenCardSlots: [],
          min: cost, max: cost,
        }),
      })
      return
    }

    if (resolution.step === 'cost') {
      const leftId = resolution.data.leftId as PlayerId
      const rightId = resolution.data.rightId as PlayerId
      const selected = (response.payload as { cardIds: CardId[] }).cardIds
      /*
       * 鲁肃付出的这几张是**真的弃置**，走正常弃牌路径（枭姬、白银狮子照常触发）。
       * 两名目标交换手牌则不是弃置，绝不能混为一谈。
       */
      for (const cardId of selected) {
        const from = locateOwnedCard(host.state, ownerId, cardId)
        if (!from || from.kind === 'judgingArea') continue
        moveCard(host.state, cardId, from, { kind: 'discardPile' })
        if (from.kind === 'equipment') handleEquipmentLost(host as never, ownerId, cardId)
      }
      if (selected.length > 0) {
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: selected, reason: '缔盟' }, { sourceId: ownerId, cardIds: selected })
      }
      performDimeng(host, ownerId, leftId, rightId)
    }
  },
})

export const LUSU: CharacterDefinition = {
  id: 'lusu',
  name: '鲁肃',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'forest',
  skills: [
    {
      id: HAOSHI,
      name: '好施',
      description: '摸牌阶段，你可以多摸两张牌，然后若你的手牌数大于 5，你将一半的手牌（向下取整）交给手牌最少的一名其他角色。',
    },
    {
      id: DIMENG,
      name: '缔盟',
      description: '出牌阶段限一次，你可以选择两名其他角色并弃置 X 张牌（X 为这两名角色手牌数之差），然后令这两名角色交换手牌。',
    },
  ],
}
