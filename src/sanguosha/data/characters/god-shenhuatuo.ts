import { isSoleTargetOf } from '../../engine/card-use-targets'
import {
  advanceCyclicStatus,
  currentCyclicValue,
  cyclicStatusOf,
  grantCyclicStatus,
} from '../../engine/cyclic-status'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { recover } from '../../engine/recover'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ArrangeOptionsRequest, ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神华佗。
 *
 * 【五灵】：出牌阶段限两次，令一名没有「五灵」的角色获得「五灵」，
 *   由你指定虎、鹤、熊、猿、鹿的完整顺序。该角色立刻进入第一种，
 *   之后于其准备阶段切换到下一种，走完一轮回到第一种。
 *   虎：其使用的、只指定了一个目标的牌对该目标造成伤害时，伤害 +1。
 *   鹤：进入时摸三张牌。
 *   熊：每个回合限一次，其受到伤害时该伤害 -1。
 *   猿：进入时可获得另一名角色装备区里的一张牌。
 *   鹿：进入时回复 1 点体力并弃置判定区所有牌；拥有鹿期间不能成为延时锦囊的目标。
 * 【游医】：弃牌阶段结束时，你可以把本阶段弃置的牌置入「仁」；
 *   出牌阶段限一次，你可以弃置「仁」中所有牌，令所有存活角色各回复 1 点体力。
 *
 * 整套技能里最容易做错的一处：**五灵不是五个技能，是同一个状态的五个取值。**
 * 拆成五个技能之后「当前是哪一种」就没有唯一事实来源了，切换要靠加一个删一个，
 * 中间任何一次异常都会留下两种灵同时生效。所以它走公共的有序循环状态。
 */

const WULING = 'wuling'
const YOUYI = 'youyi'
/**
 * 五灵带来的持续效果挂在**状态拥有者**身上，所以它是一个可被授予的技能。
 *
 * 触发器只对拥有该技能的人生效——引擎就是这么设计的。把虎的加伤、熊的减伤、
 * 鹿的目标禁止都写在神华佗自己身上是不行的：`prohibitsTarget` 查的是
 * **目标本人**的技能表，写在神华佗身上只会保护神华佗自己。
 */
const WULING_SPIRIT = 'wuling-spirit'

/** 五灵在公共循环状态里的 key。 */
export const WULING_STATUS = 'wuling'
/** 五种灵。顺序在这里只是书写顺序，真正的排列由施加者每次指定。 */
export const WULING_SPIRITS = ['tiger', 'crane', 'bear', 'ape', 'deer'] as const
export type WulingSpirit = (typeof WULING_SPIRITS)[number]
const SPIRIT_NAMES: Record<WulingSpirit, string> = {
  tiger: '虎', crane: '鹤', bear: '熊', ape: '猿', deer: '鹿',
}

/** 「仁」区在角色专属牌堆里的名字。默认公开可见。 */
export const REN_PILE = 'ren'
/** 出牌阶段最多发动几次五灵。 */
const WULING_USES_PER_TURN = 2
/** 本回合已经发动过几次五灵。回合开始清零。 */
const WULING_USES_MARK = 'wuling-uses'
/** 熊灵本回合已经减过伤了。存的是那个回合的编号，换回合自然失效。 */
const BEAR_USED_TURN_MARK = 'wuling-bear-turn'

const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 这个人当前处在哪一种灵。没有五灵时返回 null。 */
export function wulingSpiritOf(state: SanguoshaState, playerId: PlayerId): WulingSpirit | null {
  return currentCyclicValue(state, WULING_STATUS, playerId) as WulingSpirit | null
}

/** 五灵的合法目标：还没有五灵的存活角色（含自己）。 */
function wulingTargets(state: SanguoshaState, _ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && !cyclicStatusOf(state, WULING_STATUS, candidate.id))
    .map((candidate) => candidate.id)
}

/** 装备区里有牌的其他存活角色。猿灵的候选。 */
function equippedOthers(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .filter((candidate) => EQUIPMENT_SLOTS.some((slot) => candidate.zones.equipment[slot]))
    .map((candidate) => candidate.id)
}

/**
 * 进入某一种灵时立刻发生的事。
 *
 * 鹤、猿、鹿都是**进入时**触发，不是「处于这种灵期间每个准备阶段都触发」。
 * 所以它挂在状态切换那一刻，而不是挂在准备阶段上——包括刚获得五灵、
 * 立刻进入第一种的那一次，以及以后每一轮重新转回来的那一次。
 */
function onEnterSpirit(host: SkillHost, ownerId: PlayerId, spirit: WulingSpirit): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  host.dispatch('SkillActivated', {
    skillId: WULING, skillName: '五灵', playerId: ownerId,
    logText: `${owner.nickname}进入「${SPIRIT_NAMES[spirit]}」`,
  }, { sourceId: ownerId })

  if (spirit === 'crane') {
    drawCards(host.state, host.rng, ownerId, 3, (name, payload) => host.dispatch(name, payload))
    return
  }
  if (spirit === 'deer') {
    recover(host as never, ownerId, 1, ownerId)
    /*
     * 判定区清空走的是**弃置**，牌真的进弃牌堆。
     * 不要为它另造一个「移出游戏」区域：那会让牌张守恒多出一个谁都不认识的
     * 落点，闪电这类还要继续传递的牌也会凭空消失。
     */
    for (const cardId of [...owner.zones.judgingArea]) {
      moveCard(host.state, cardId, { kind: 'judgingArea', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: WULING }, { targetId: ownerId, cardIds: [cardId] })
    }
    return
  }
  if (spirit === 'ape') {
    const candidateIds = equippedOthers(host.state, ownerId)
    // 没人有装备就不要弹一个必然点不动的请求
    if (candidateIds.length === 0) return
    host.queueSkill({ skillId: WULING, ownerId, step: 'ape-target', data: {} })
  }
}

// ─────────────────────────────── 五灵 ───────────────────────────────

registerSkillRuntime({
  id: WULING,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    if ((owner.marks[WULING_USES_MARK] ?? 0) >= WULING_USES_PER_TURN) return []
    if (wulingTargets(state, ownerId).length === 0) return []
    return [{ id: WULING, label: '发动【五灵】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== WULING) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if ((owner.marks[WULING_USES_MARK] ?? 0) >= WULING_USES_PER_TURN) return
    const candidateIds = wulingTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    owner.marks[WULING_USES_MARK] = (owner.marks[WULING_USES_MARK] ?? 0) + 1
    host.askSkill({
      skillId: WULING, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【五灵】：令哪名角色获得「五灵」',
        timeoutMs: 25_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  triggers: [
    {
      /** 回合开始：清掉本回合的发动次数。 */
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner) delete owner.marks[WULING_USES_MARK]
      },
    },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      // 发问期间对方可能已经拿到五灵、或者已经死了，落地前重新验一次
      if (!targetId || !wulingTargets(host.state, ownerId).includes(targetId)) return
      askSpiritOrder(host, ownerId, targetId)
      return
    }
    if (resolution.step === 'order') {
      const targetId = String(resolution.data.targetId ?? '')
      const optionIds = (response.payload as { optionIds?: string[] }).optionIds ?? []
      // 请求层已经保证这是一个全排列，这里只把它收窄成灵的类型
      if (optionIds.length !== WULING_SPIRITS.length) return
      if (!optionIds.every((spirit) => WULING_SPIRITS.includes(spirit as WulingSpirit))) return
      grantWuling(host, ownerId, targetId, optionIds as WulingSpirit[])
      return
    }
    if (resolution.step === 'ape-target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      if (!targetId || !equippedOthers(host.state, ownerId).includes(targetId)) return
      const target = playerOf(host.state, targetId)!
      const cardIds = EQUIPMENT_SLOTS
        .map((slot) => target.zones.equipment[slot])
        .filter((cardId): cardId is CardId => !!cardId)
      host.askSkill({
        skillId: WULING, ownerId, step: 'ape-card', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【猿】：获得${target.nickname}装备区里的一张牌`,
          timeoutMs: 25_000, optional: false, purpose: 'skill',
          cardIds, hiddenCardSlots: [],
          min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'ape-card') return
    const targetId = String(resolution.data.targetId ?? '')
    const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!cardId || !owner?.alive || !target) return
    const slot = EQUIPMENT_SLOTS.find((candidate) => target.zones.equipment[candidate] === cardId)
    if (!slot) return
    moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'hand', playerId: ownerId })
    /*
     * 装备离场要走正常路径：白银狮子、枭姬这些「失去装备时」的效果该触发就触发。
     * 直接把牌搬走会把它们全部跳过。
     */
    handleEquipmentLost(host as never, targetId, cardId)
    host.dispatch('SkillActivated', {
      skillId: WULING, skillName: '五灵', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动「猿」，获得${target.nickname}装备区的一张牌`,
    }, { sourceId: ownerId, targetId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WULING }, { sourceId: ownerId, targetId, cardIds: [cardId] })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ape-target') return
    const candidateIds = equippedOthers(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: WULING, ownerId, step: 'ape-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【猿】：获得哪名角色装备区里的一张牌',
        timeoutMs: 25_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
})

/**
 * 一次定完五种灵的完整排列。
 *
 * 用排列请求而不是连问五次单选：连问的话玩家点第三种时已经看不到前两种是什么，
 * 改主意只能等超时，联机时每一步还各要一个网络往返。
 * 排列请求可以边点边看整条顺序、可以撤销，只付一次往返，
 * 而且「必须是全排列」由请求层统一校验，无重无漏是天然的。
 */
function askSpiritOrder(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  host.askSkill({
    skillId: WULING, ownerId, step: 'order', data: { targetId },
    build: (requestId): ArrangeOptionsRequest => ({
      id: requestId, kind: 'arrange-options', playerId: ownerId,
      prompt: `【五灵】：为${target?.nickname ?? ''}指定五种灵的顺序`,
      timeoutMs: 30_000, optional: false,
      options: WULING_SPIRITS.map((spirit) => ({ id: spirit, label: SPIRIT_NAMES[spirit] })),
    }),
  })
}

function grantWuling(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, order: WulingSpirit[]): void {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive) return
  const first = grantCyclicWuling(host, ownerId, targetId, order)
  if (!first) return
  // 持续效果靠这张技能挂到目标身上；没有它，虎熊鹿三种灵一个都不会生效
  grantSkill(host.state, targetId, WULING_SPIRIT)
  host.dispatch('SkillActivated', {
    skillId: WULING, skillName: '五灵', playerId: ownerId, targetId,
    logText: `${owner.nickname}对${target.nickname}发动【五灵】：${order.map((spirit) => SPIRIT_NAMES[spirit]).join('→')}`,
  }, { sourceId: ownerId, targetId })
  // 获得五灵之后**立刻**进入第一种，不等到下一个准备阶段
  onEnterSpirit(host, targetId, first)
}

function grantCyclicWuling(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, order: WulingSpirit[]): WulingSpirit | null {
  // 这里再验一次排列的完整性：五种恰好各一次
  if (order.length !== WULING_SPIRITS.length) return null
  if (new Set(order).size !== WULING_SPIRITS.length) return null
  return grantCyclicStatus(host.state, {
    key: WULING_STATUS, ownerId: targetId, sourceId: ownerId, order,
  }) as WulingSpirit | null
}

// ── 五灵带来的持续效果：挂在一个独立的锁定技上 ──
//
// 它们不属于「神华佗会做什么」，而属于「身上有五灵的人会怎么样」。
// 所以挂在**状态拥有者**身上，由引擎按状态查询，而不是由神华佗遥控。

registerSkillRuntime({
  id: WULING_SPIRIT,
  triggers: [
    {
      /** 准备阶段切换到排列里的下一种灵。 */
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        if (!cyclicStatusOf(host.state, WULING_STATUS, ownerId)) return
        const next = advanceCyclicStatus(host.state, WULING_STATUS, ownerId) as WulingSpirit | null
        if (next) onEnterSpirit(host, ownerId, next)
      },
    },
    {
      /*
       * 虎：**只指定了一个目标**的牌对该目标造成伤害时 +1。
       *
       * 「只有一个目标」查的是这次使用当初指定的目标表，不是结算到现在还剩几个。
       * 多目标【杀】走到最后一个目标时剩余表已经空了，看起来和单目标一模一样。
       */
      event: 'DamageCaused',
      handle(host, ownerId, context) {
        if (wulingSpiritOf(host.state, ownerId) !== 'tiger') return
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { amount?: number; cardId?: CardId }
        const targetId = context.event.targetId
        if (!targetId || !payload.cardId) return
        if (!isSoleTargetOf(host.state, payload.cardId, targetId)) return
        payload.amount = Math.max(0, Math.trunc(Number(payload.amount ?? 0))) + 1
        host.dispatch('SkillActivated', {
          skillId: WULING, skillName: '五灵', playerId: ownerId, targetId,
          logText: `「虎」令这次伤害 +1`,
        }, { sourceId: ownerId, targetId })
      },
    },
    {
      /*
       * 熊：每个**实际回合**限一次，受到的伤害 -1。
       *
       * 作用域是当前这个回合实例，不是「自己的回合」——谁在行动都算。
       * 记的是回合编号而不是布尔：换回合自然失效，不需要另外找地方清零，
       * 额外回合也天然算作新的一个回合。
       */
      event: 'DamageInflicted',
      handle(host, ownerId, context) {
        if (wulingSpiritOf(host.state, ownerId) !== 'bear') return
        if (context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        if (owner.marks[BEAR_USED_TURN_MARK] === host.state.turnNumber) return
        const payload = context.event.payload as { amount?: number }
        const amount = Math.max(0, Math.trunc(Number(payload.amount ?? 0)))
        if (amount <= 0) return
        owner.marks[BEAR_USED_TURN_MARK] = host.state.turnNumber
        // 一次减 1，不是每点伤害各减一次：3 点变 2 点，不是变 0
        payload.amount = amount - 1
        host.dispatch('SkillActivated', {
          skillId: WULING, skillName: '五灵', playerId: ownerId,
          logText: `「熊」令${owner.nickname}受到的这次伤害 -1`,
        }, { targetId: ownerId })
      },
    },
  ],
  /**
   * 鹿：不能成为延时锦囊的目标。
   *
   * 这是**禁止指定目标**，不是「效果无效」——延时锦囊一开始就不能合法地
   * 指向他，而不是贴上去之后不生效。
   */
  prohibitsTarget(state, ownerId, _sourceId, cardName) {
    if (wulingSpiritOf(state, ownerId) !== 'deer') return false
    return DELAYED_TRICK_NAMES.includes(cardName)
  },
})

const DELAYED_TRICK_NAMES = ['乐不思蜀', '兵粮寸断', '闪电']

// ─────────────────────────────── 游医 ───────────────────────────────

registerSkillRuntime({
  id: YOUYI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    // 仁区为空时不显示一个什么都不会发生的入口
    if ((owner.characterPiles?.[REN_PILE] ?? []).length === 0) return []
    if (owner.turnUsedSkills?.includes(YOUYI)) return []
    return [{ id: YOUYI, label: '发动【游医】：弃置「仁」，全场回复 1 点体力' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YOUYI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const pile = [...(owner.characterPiles?.[REN_PILE] ?? [])]
    if (pile.length === 0) return
    if (owner.turnUsedSkills?.includes(YOUYI)) return
    owner.turnUsedSkills = [...(owner.turnUsedSkills ?? []), YOUYI]
    host.dispatch('SkillActivated', {
      skillId: YOUYI, skillName: '游医', playerId: ownerId,
      logText: `${owner.nickname}发动【游医】，弃置「仁」中的 ${pile.length} 张牌`,
    }, { sourceId: ownerId })
    for (const cardId of pile) {
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: REN_PILE }, { kind: 'discardPile' })
    }
    /*
     * 全场回复按**稳定座次**执行，不按 players 数组的原始顺序：
     * 回复会触发别人的技能，顺序不稳定的话同一个种子会走出两条不同的牌局。
     */
    const order = [...host.state.players].filter((candidate) => candidate.alive).sort((left, right) => left.seat - right.seat)
    for (const candidate of order) recover(host as never, candidate.id, 1, ownerId)
  },
  triggers: [{
    /*
     * 弃牌阶段结束时把本阶段弃掉的牌收进「仁」。
     *
     * 只认**这一次弃牌阶段、自己弃的、而且此刻仍然躺在弃牌堆里**的牌。
     * 中途被别的技能拿走的那些不能再复制一张进仁区——那会凭空多出一张牌。
     */
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'discard' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const cardIds = discardedThisPhase(host.state, ownerId)
      if (cardIds.length === 0) return
      host.askSkill({
        skillId: YOUYI, ownerId, step: 'collect', data: { cardIds },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【游医】：将本阶段弃置的 ${cardIds.length} 张牌置入「仁」？`,
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '置入「仁」' }, { id: 'no', label: '不置入' }],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'collect') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    /*
     * **落地前重新查一遍**：发问期间牌可能已经被别的技能从弃牌堆拿走了。
     * 拿当初那份名单直接搬会把一张已经在别人手上的牌再搬一次。
     */
    const cardIds = discardedThisPhase(host.state, ownerId)
    if (cardIds.length === 0) return
    for (const cardId of cardIds) {
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: REN_PILE })
    }
    host.dispatch('SkillActivated', {
      skillId: YOUYI, skillName: '游医', playerId: ownerId,
      logText: `${owner.nickname}发动【游医】，将 ${cardIds.length} 张牌置入「仁」`,
    }, { sourceId: ownerId })
  },
})

/**
 * 本次弃牌阶段里、这个人弃掉的、而且**此刻仍在弃牌堆**的牌。
 *
 * 「仍在弃牌堆」这一条不能省：同一阶段的弃牌可能已经被别的技能拿走，
 * 再往仁区搬一次就等于凭空复制一张。
 */
function discardedThisPhase(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const ledger = state.discardPhaseLedger
  if (!ledger || ledger.ownerPlayerId !== playerId) return []
  return ledger.records
    .filter((record) => record.sourcePlayerId === playerId)
    .map((record) => record.cardId)
    .filter((cardId) => state.zones.discardPile.includes(cardId))
}

export const SHENHUATUO: CharacterDefinition = {
  id: 'shenhuatuo',
  name: '神·华佗',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 3,
  pack: 'god',
  skills: [
    {
      id: WULING,
      name: '五灵',
      description: '出牌阶段限两次，你可以令一名没有「五灵」的角色获得「五灵」，并由你指定虎、鹤、熊、猿、鹿的顺序。该角色立即进入第一种，此后于其准备阶段依次切换至下一种，循环往复。虎：其使用的仅指定一个目标的牌对该目标造成伤害时，此伤害+1。鹤：进入时摸三张牌。熊：每回合限一次，其受到伤害时此伤害-1。猿：进入时可获得另一名角色装备区里的一张牌。鹿：进入时回复1点体力并弃置判定区里的所有牌，且不能成为延时锦囊牌的目标。',
    },
    {
      id: WULING_SPIRIT,
      name: '五灵',
      description: '你依次处于虎、鹤、熊、猿、鹿之一，并于准备阶段切换至下一种。',
      granted: true,
    },
    {
      id: YOUYI,
      name: '游医',
      description: '弃牌阶段结束时，你可以将此阶段弃置的牌置入「仁」。出牌阶段限一次，你可以弃置「仁」中的所有牌，令所有存活角色各回复1点体力。',
    },
  ],
}
