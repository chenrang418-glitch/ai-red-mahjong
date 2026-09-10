import { continueDyingRescue, killPlayer, resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { queueExtraTurn } from '../../engine/turn'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { moveCard } from '../../engine/zones'
import type { ArrangeCardsRequest, ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神姜维。
 *
 * 【星魂】：出牌阶段限一次，你观看牌堆顶五张牌，可以用等量手牌与之交换，
 *   然后重新排列这五张牌；接着选择一名其他角色，展示这五张牌并对其依次
 *   使用其中的【杀】。
 * 【天涛】：锁定技，结束阶段，你选择一个区域并弃置你该区域的所有牌，
 *   然后你可以令任意名其他角色各弃置其该区域的一张牌；因此弃置的牌中
 *   没有【杀】的角色失去 1 点体力。
 * 【神霈】：限定技，你进入濒死状态时可以发动，令 X 为你本局进入濒死状态的次数，
 *   你回复 X 点体力，然后对一名角色造成 X 点雷电伤害，并获得【回天】。
 * 【回天】：一名其他角色的回合结束时，若其体力值大于你，你可以摸一张牌并获得
 *   一个额外回合；若你于上一轮发动过【回天】，则你于本轮开始时死亡。
 *
 * 四处最容易做错的：
 *
 * 1. **牌堆顶五张在正式展示前只有他自己看得到。** 请求只发给本人，
 *    第三方连这条请求的存在都读不到。
 * 2. **交换必须一次做完。** 一张张来回搬会在中间态暴露信息。
 * 3. **那几张【杀】要真的逐张使用**，而且要等上一张彻底结算完。
 * 4. **回天的代价按「轮」算，不是按「回合」。** 额外回合是插队、不推进轮次，
 *    拿回合去凑的话回天自己带来的那个额外回合就会把死亡判定提前引爆。
 */

const XINGHUN = 'xinghun'
const TIANTAO = 'tiantao'
const SHENPEI = 'shenpei'
const HUITIAN = 'huitian'

/** 星魂每次看几张牌堆顶。 */
const XINGHUN_DEPTH = 5
/** 上一次发动回天是在第几轮；代价按轮结算，所以记的是轮次不是回合。 */
const HUITIAN_ROUND_MARK = 'huitian-round'

const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']
/** 天涛可以选的区域。 */
const TIANTAO_ZONES = ['hand', 'equipment', 'judging'] as const
type TiantaoZone = (typeof TIANTAO_ZONES)[number]
const ZONE_NAMES: Record<TiantaoZone, string> = { hand: '手牌区', equipment: '装备区', judging: '判定区' }

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isTiantaoZone(value: unknown): value is TiantaoZone {
  return TIANTAO_ZONES.includes(value as TiantaoZone)
}

/** 某名角色某个区域里的牌。 */
function zoneCards(state: SanguoshaState, playerId: PlayerId, zone: TiantaoZone): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  if (zone === 'hand') return [...player.zones.hand]
  if (zone === 'judging') return [...player.zones.judgingArea]
  return EQUIPMENT_SLOTS
    .map((slot) => player.zones.equipment[slot])
    .filter((cardId): cardId is CardId => !!cardId)
}

/** 把某名角色某个区域的一张牌弃掉；装备离场走正常路径。 */
function discardFromZone(host: SkillHost, playerId: PlayerId, zone: TiantaoZone, cardId: CardId): void {
  const player = playerOf(host.state, playerId)
  if (!player) return
  if (zone === 'hand') {
    moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  } else if (zone === 'judging') {
    moveCard(host.state, cardId, { kind: 'judgingArea', playerId }, { kind: 'discardPile' })
  } else {
    const slot = EQUIPMENT_SLOTS.find((candidate) => player.zones.equipment[candidate] === cardId)
    if (!slot) return
    moveCard(host.state, cardId, { kind: 'equipment', playerId, slot }, { kind: 'discardPile' })
    // 白银狮子、枭姬这些「失去装备时」的效果该触发就触发
    handleEquipmentLost(host as never, playerId, cardId)
  }
  host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: TIANTAO }, { targetId: playerId, cardIds: [cardId] })
}

// ─────────────────────────────── 星魂 ───────────────────────────────

registerSkillRuntime({
  id: XINGHUN,
  /*
   * 这条主动入口最终会**使用【杀】**，所以被「不能使用牌 / 不能使用【杀】」
   * 的效果封住时不该再展示。`legalPlayActions` 末尾那道封牌过滤只筛
   * use-card 动作，筛不到主动技按钮。
   */
  activeActionUsesCard: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, XINGHUN)) return []
    if (state.zones.drawPile.length < XINGHUN_DEPTH) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: XINGHUN, label: '发动【星魂】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== XINGHUN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, XINGHUN)) return
    if (host.state.zones.drawPile.length < XINGHUN_DEPTH) return
    markUsedThisTurn(host.state, ownerId, XINGHUN)
    const top = host.state.zones.drawPile.slice(0, XINGHUN_DEPTH)
    /*
     * 牌堆顶五张**只发给他一个人**。
     *
     * 玩家视图只带观看者自己的那条 pendingRequest，所以第三方连这条请求的
     * 存在都读不到，更看不到牌面。这里同时把他的手牌摆出来：要换就得选等量的手牌。
     */
    host.askSkill({
      skillId: XINGHUN, ownerId, step: 'pick-hand', data: { top },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【星魂】：选择要换出去的手牌（可以一张都不换）',
        timeoutMs: 30_000, optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand],
        // 牌堆顶那五张只看不选：它们要在下一步单独挑
        viewOnlyCardIds: top,
        hiddenCardSlots: [],
        min: 0, max: Math.min(owner.zones.hand.length, XINGHUN_DEPTH),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pick-hand') {
      const top = (resolution.data.top as CardId[] | undefined) ?? []
      const handCards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (handCards.length === 0) { askReorder(host, ownerId, currentTop(host)); return }
      host.askSkill({
        skillId: XINGHUN, ownerId, step: 'pick-top', data: { top, handCards },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【星魂】：从牌堆顶挑 ${handCards.length} 张换进手里`,
          timeoutMs: 30_000, optional: false, purpose: 'skill',
          cardIds: top, hiddenCardSlots: [],
          // 数量必须完全相等，这正是这次交换的定义
          min: handCards.length, max: handCards.length,
        }),
      })
      return
    }

    if (resolution.step === 'pick-top') {
      const top = (resolution.data.top as CardId[] | undefined) ?? []
      const handCards = (resolution.data.handCards as CardId[] | undefined) ?? []
      const topCards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const swappable = topCards.length === handCards.length
        && handCards.every((cardId) => owner.zones.hand.includes(cardId))
        && topCards.every((cardId) => host.state.zones.drawPile.includes(cardId))
      // 发问期间牌可能已经被别的效果动过，换不成就只排序
      if (!swappable) { askReorder(host, ownerId, currentTop(host)); return }
      /*
       * **一次性完成交换**，不是一张张来回搬。
       *
       * 逐张搬会在中间态暴露信息（旁观者能看到牌堆顶少一张又多一张），
       * 也会把「失去牌 / 获得牌」这批时机各触发一遍。
       * 先算好交换之后这五张分别是什么，搬完再把这个顺序写回牌堆顶。
       */
      const nextTop = top.map((cardId) => {
        const index = topCards.indexOf(cardId)
        return index >= 0 ? handCards[index] : cardId
      })
      for (const cardId of handCards) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
      }
      for (const cardId of topCards) {
        moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      }
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: handCards, reason: XINGHUN }, { targetId: ownerId, cardIds: handCards })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: topCards, reason: XINGHUN }, { targetId: ownerId, cardIds: topCards })
      writeTop(host, nextTop)
      askReorder(host, ownerId, nextTop)
      return
    }

    if (resolution.step === 'reorder') {
      const ordered = (response.payload as { top?: CardId[] }).top ?? []
      if (ordered.length === XINGHUN_DEPTH && ordered.every((cardId) => host.state.zones.drawPile.includes(cardId))) {
        writeTop(host, ordered)
      }
      const candidateIds = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== ownerId)
        .map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: XINGHUN, ownerId, step: 'target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【星魂】：展示这五张牌，并对哪名角色依次使用其中的【杀】',
          timeoutMs: 25_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    const revealed = currentTop(host)
    // 展示是公开动作：这一刻这五张牌不再是暗信息
    host.dispatch('SkillActivated', {
      skillId: XINGHUN, skillName: '星魂', playerId: ownerId, targetId: target.id, cardIds: revealed,
      logText: `${owner.nickname}对${target.nickname}发动【星魂】，展示牌堆顶五张牌`,
    }, { sourceId: ownerId, targetId: target.id, cardIds: revealed })
    host.dispatch('CardMove', { cardIds: revealed, reason: XINGHUN, revealed: true }, { sourceId: ownerId, cardIds: revealed })

    /*
     * 其中的【杀】**逐张真实使用**，不是直接算伤害：闪、无双、肉林、藤甲、
     * 属性伤害、连环传导、濒死全都要照常走。
     *
     * 用技能队列排队而不是在这里连着发：一张【杀】结算期间桌面是脏的，
     * 引擎会等它收干净、没有待回应请求了才放下一张出来。
     */
    for (const cardId of revealed) {
      if (host.state.cards[cardId]?.name !== '杀') continue
      host.queueSkill({ skillId: XINGHUN, ownerId, step: 'slash', data: { targetId: target.id, cardId } })
    }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'slash') return
    const data = prompt.data as { targetId?: PlayerId; cardId?: CardId }
    const cardId = data.cardId
    const owner = playerOf(host.state, ownerId)
    const target = data.targetId ? playerOf(host.state, data.targetId) : undefined
    // 排队期间局势会变：目标可能已经死了，牌也可能已经被别的效果摸走
    if (!cardId || !owner?.alive || !target?.alive || target.id === ownerId) return
    if (!host.state.zones.drawPile.includes(cardId)) return
    if (host.state.cards[cardId]?.name !== '杀') return
    // 借给他当载体：`beginVirtualSlash` 要求载体牌在使用者手里
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    /*
     * 走 `beginVirtualSlash`：它内部用 `countUsage: false`，
     * 技能使用的【杀】不占出牌阶段的出杀次数，否则第一张就把额度用光了。
     */
    /*
     * 用不出去（他被封牌 / 本回合不能使用【杀】）时，
     * **借出去的那张牌要还回牌堆顶**——否则它会白白留在他手上，
     * 而技能文本里根本没有「获得这张牌」这一条。
     */
    if (!host.beginVirtualSlash({ sourceId: ownerId, targetId: target.id, sourceSkillId: XINGHUN, cardId })) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
    }
  },
})

/** 牌堆顶的五张（不足则有多少算多少）。 */
function currentTop(host: SkillHost): CardId[] {
  return host.state.zones.drawPile.slice(0, XINGHUN_DEPTH)
}

/** 把这几张牌按给定顺序放回牌堆顶，其余顺序不动。 */
function writeTop(host: SkillHost, ordered: readonly CardId[]): void {
  const pile = host.state.zones.drawPile
  const rest = pile.filter((cardId) => !ordered.includes(cardId))
  // 原地改写，不换数组对象：牌堆是被多处持有引用的状态
  pile.splice(0, pile.length, ...ordered, ...rest)
}

function askReorder(host: SkillHost, ownerId: PlayerId, top: readonly CardId[]): void {
  if (top.length === 0) return
  host.askSkill({
    skillId: XINGHUN, ownerId, step: 'reorder', data: {},
    build: (requestId): ArrangeCardsRequest => ({
      id: requestId, kind: 'arrange-cards', playerId: ownerId,
      prompt: '【星魂】：重新排列这五张牌（最上面的最先被使用）',
      timeoutMs: 30_000, optional: false,
      cardIds: [...top],
      // 五张全部留在牌堆顶，只排顺序，不许往牌堆底放
      minTop: top.length, maxTop: top.length, allowBottom: false,
    }),
  })
}

// ─────────────────────────────── 天涛 ───────────────────────────────

registerSkillRuntime({
  id: TIANTAO,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const zones = TIANTAO_ZONES.filter((zone) => zoneCards(host.state, ownerId, zone).length > 0)
      // 三个区域都空着就没什么可弃的
      if (zones.length === 0) return
      host.askSkill({
        skillId: TIANTAO, ownerId, step: 'zone',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【天涛】：选择一个区域，弃置你该区域里的所有牌',
          // 锁定技，选哪个区域是他的决定，发不发动不是
          timeoutMs: 25_000, optional: false,
          options: zones.map((zone) => ({ id: zone, label: ZONE_NAMES[zone] })),
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'zone') {
      const zone = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      if (!isTiantaoZone(zone) || !owner?.alive) return
      const own = zoneCards(host.state, ownerId, zone)
      if (own.length === 0) return
      host.dispatch('SkillActivated', {
        skillId: TIANTAO, skillName: '天涛', playerId: ownerId,
        logText: `${owner.nickname}发动【天涛】，弃置${ZONE_NAMES[zone]}的所有牌`,
      }, { sourceId: ownerId })
      /*
       * **他自己也参与「弃的牌里没有【杀】就失去 1 点体力」的判断。**
       *
       * 他一次弃的是整个区域，所以判据是「这一批牌里一张【杀】都没有」，
       * 而不是逐张各判一次——逐张判的话弃三张非【杀】就要掉三点，那不是这个技能。
       */
      const hadSlash = own.some((cardId) => host.state.cards[cardId]?.name === '杀')
      for (const cardId of own) discardFromZone(host, ownerId, zone, cardId)
      if (!hadSlash) loseHp(host as never, ownerId, 1, TIANTAO)
      if (!owner.alive) return

      /*
       * 第二段**必须排队问，不能接着当场问**。
       *
       * 上面这一批弃牌和可能的失去体力会牵动别人的技能——枭姬、刚烈、
       * 濒死求桃都可能已经占住了「技能等待回应」那个唯一的槽位，
       * 这时候再发一条就是「已有技能正在等待回应」。
       * 交给技能队列，它会等桌面收干净了再放出来。
       */
      host.queueSkill({ skillId: TIANTAO, ownerId, step: 'targets', data: { zone } })
      return
    }

    if (resolution.step === 'targets') {
      const zone = resolution.data.zone
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!isTiantaoZone(zone) || targetIds.length === 0) return
      /*
       * 按**座次**逐个处理，不按客户端传来的顺序：弃牌会触发别人的技能，
       * 顺序不稳定的话同一个种子会走出两局不同的牌。
       */
      const ordered = host.state.players
        .filter((candidate) => candidate.alive && targetIds.includes(candidate.id))
        .sort((left, right) => left.seat - right.seat)
      for (const target of ordered) {
        host.queueSkill({ skillId: TIANTAO, ownerId, step: 'discard-one', data: { zone, targetId: target.id } })
      }
      return
    }

    if (resolution.step !== 'discard-one') return
    const zone = resolution.data.zone
    const targetId = String(resolution.data.targetId ?? '')
    const target = playerOf(host.state, targetId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!isTiantaoZone(zone) || !target?.alive || !cardId) return
    if (!zoneCards(host.state, targetId, zone).includes(cardId)) return
    const isSlash = host.state.cards[cardId]?.name === '杀'
    discardFromZone(host, targetId, zone, cardId)
    // 弃的不是【杀】才掉血；这是「失去体力」，不是伤害
    if (!isSlash) loseHp(host as never, targetId, 1, TIANTAO)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'targets') {
      const zone = (prompt.data as { zone?: unknown }).zone
      const owner = playerOf(host.state, ownerId)
      if (!isTiantaoZone(zone) || !owner?.alive) return
      // 排队期间别人的那个区域可能已经空了，甚至人已经不在了
      const candidateIds = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== ownerId)
        .filter((candidate) => zoneCards(host.state, candidate.id, zone).length > 0)
        .map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: TIANTAO, ownerId, step: 'targets', data: { zone },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【天涛】：令任意名其他角色各弃置其${ZONE_NAMES[zone]}的一张牌`,
          timeoutMs: 25_000,
          // 「任意名」包含一个都不选
          optional: true,
          candidateIds, min: 0, max: candidateIds.length,
        }),
      })
      return
    }
    if (prompt.step !== 'discard-one') return
    const data = prompt.data as { zone?: unknown; targetId?: PlayerId }
    const zone = data.zone
    const targetId = data.targetId
    if (!isTiantaoZone(zone) || !targetId) return
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const cards = zoneCards(host.state, targetId, zone)
    // 排队期间对方那个区域可能已经空了
    if (cards.length === 0) return
    host.askSkill({
      skillId: TIANTAO, ownerId, step: 'discard-one', data: { zone, targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards',
        // 弃哪一张由**被弃的人**自己选
        playerId: targetId,
        prompt: `【天涛】：弃置你${ZONE_NAMES[zone]}的一张牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill',
        cardIds: cards, hiddenCardSlots: [],
        min: 1, max: 1,
      }),
    })
  },
})

// ─────────────────────────────── 神霈 ───────────────────────────────

/** 神霈这次能不能真的把他救回来。 */
function shenpeiSaves(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner) return false
  const x = Math.max(1, owner.dyingEntryCount ?? 1)
  /*
   * **回复 X 点，不是「回复到 X 点」。**体力 -2 时回复 1 点的结果是 -1，
   * 人还在濒死里。这种情况下不发动——发动了就得留在濒死中继续求桃，
   * 而限定技已经用掉了，纯亏。
   */
  return owner.hp + Math.min(x, owner.maxHp - owner.hp) > 0
}

registerSkillRuntime({
  id: SHENPEI,
  limited: true,
  dyingIntercept(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(SHENPEI)) return false
    if (!shenpeiSaves(host.state, ownerId)) return false
    host.askSkill({
      skillId: SHENPEI, ownerId, step: 'dying',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `你处于濒死状态，是否发动限定技【神霈】？（本局第 ${owner.dyingEntryCount ?? 1} 次进入濒死）`,
        timeoutMs: 20_000, optional: true,
        options: [
          { id: 'invoke', label: `发动【神霈】：回复 ${Math.max(1, owner.dyingEntryCount ?? 1)} 点体力并造成等量雷电伤害` },
          { id: 'cancel', label: '不发动，继续求桃' },
        ],
      }),
    })
    return 'pending'
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'dying') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || host.state.dying?.playerId !== ownerId) return
      const invoked = (response.payload as { optionId?: string }).optionId === 'invoke'
      if (!invoked || owner.usedLimitedSkills.includes(SHENPEI) || !shenpeiSaves(host.state, ownerId)) {
        continueDyingRescue(host as never)
        if (!host.state.dying) host.resumeAfterDying()
        return
      }
      owner.usedLimitedSkills.push(SHENPEI)
      const x = Math.max(1, owner.dyingEntryCount ?? 1)
      host.dispatch('SkillActivated', {
        skillId: SHENPEI, skillName: '神霈', playerId: ownerId,
        logText: `${owner.nickname}发动【神霈】，X 为 ${x}`,
      }, { sourceId: ownerId })
      recover(host as never, ownerId, x, ownerId)
      /*
       * **先把濒死收干净再造成伤害。**
       *
       * 濒死流程是全局单例，还挂着的时候造成的伤害一旦把别人打进濒死，
       * 统一入口会直接抛「已有濒死流程正在进行」。
       */
      host.dispatch('QuitDying', { playerId: ownerId, hp: owner.hp, reason: SHENPEI }, { targetId: ownerId })
      host.state.dying = null

      /*
       * 先拿【回天】：这个技能后面那一下伤害可能打死人、可能连环传导、
       * 可能让他自己又进濒死，等到那之后再改技能列表就不一定还轮得到。
       */
      grantSkill(host.state, ownerId, HUITIAN)
      host.dispatch('SkillActivated', {
        skillId: SHENPEI, skillName: '神霈', playerId: ownerId,
        logText: `${owner.nickname}获得【回天】`,
      }, { sourceId: ownerId })

      /*
       * **那一下伤害排队打，不在这里当场打。**
       *
       * 走到这里时牌桌不一定干净：把他打进濒死的那发伤害可能正是一条
       * 属性伤害传导链里的一环，链上还有人排着队等着挨打。在这中间再插一发
       * 新伤害，会把还没走完的那条链直接顶掉（`damageChain` 只有一个槽），
       * 压测里就是「属性伤害传导尚未结束」。
       * 交给技能队列，它会等链走完、桌面收干净了再放出来。
       */
      host.queueSkill({ skillId: SHENPEI, ownerId, step: 'damage', data: { x } })
      host.resumeAfterDying()
      return
    }

    if (resolution.step !== 'damage') return
    const x = Math.max(1, Number(resolution.data.x ?? 1))
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (targetId && playerOf(host.state, targetId)?.alive) {
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: x, nature: 'thunder' })
    }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'damage') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const x = Math.max(1, Number((prompt.data as { x?: unknown }).x ?? 1))
    host.askSkill({
      skillId: SHENPEI, ownerId, step: 'damage', data: { x },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【神霈】：对一名角色造成 ${x} 点雷电伤害`,
        timeoutMs: 25_000, optional: false,
        // 「一名角色」没有排除自己
        candidateIds: host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id),
        min: 1, max: 1,
      }),
    })
  },
})

// ─────────────────────────────── 回天 ───────────────────────────────

registerSkillRuntime({
  id: HUITIAN,
  triggers: [
    {
      /** 一名其他角色的回合结束时，若其体力值大于自己。 */
      event: 'TurnEnd',
      handle(host, ownerId, context) {
        const actorId = (context.event.payload as { playerId?: PlayerId }).playerId
        const owner = playerOf(host.state, ownerId)
        const actor = actorId ? playerOf(host.state, actorId) : undefined
        if (!owner?.alive || !actor?.alive || actor.id === ownerId) return
        // 比的是**当前体力值**，相等不算
        if (actor.hp <= owner.hp) return
        host.queueSkill({ skillId: HUITIAN, ownerId, step: 'invoke', data: { actorId: actor.id } })
      },
    },
    {
      /*
       * 代价按**轮**结算：上一轮发动过，这一轮开始时死亡。
       *
       * 额外回合是插队、不推进轮次，所以拿回合去凑的话，回天自己带来的
       * 那个额外回合就会把死亡判定提前引爆——他连一个额外回合都打不完。
       */
      event: 'RoundStart',
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const usedRound = owner.marks[HUITIAN_ROUND_MARK]
        if (usedRound === undefined) return
        const roundNumber = Number((context.event.payload as { roundNumber?: number }).roundNumber ?? 0)
        if (usedRound >= roundNumber) return
        delete owner.marks[HUITIAN_ROUND_MARK]
        host.dispatch('SkillActivated', {
          skillId: HUITIAN, skillName: '回天', playerId: ownerId,
          logText: `${owner.nickname}上一轮发动过【回天】，于本轮开始时死亡`,
        }, { sourceId: ownerId })
        /*
         * 直接死亡，既不是「受到足以致死的伤害」也不是「失去体力」——
         * 伪造伤害会触发奸雄、刚烈这些时机，走濒死则会给别人求桃的机会，
         * 两者都不是这个技能说的事。
         */
        killPlayer(host as never, ownerId, null, HUITIAN)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const actorId = String((prompt.data as { actorId?: unknown }).actorId ?? '')
    const owner = playerOf(host.state, ownerId)
    const actor = playerOf(host.state, actorId)
    // 排队期间双方体力都可能变，落地前重新验一次
    if (!owner?.alive || !actor?.alive || actor.hp <= owner.hp) return
    // 已经欠着一次死亡了就不必再问：再发动一次也只是同一笔账
    if (owner.marks[HUITIAN_ROUND_MARK] !== undefined) return
    host.askSkill({
      skillId: HUITIAN, ownerId, step: 'invoke', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【回天】：摸一张牌并获得一个额外回合？代价是你将于下一轮开始时死亡',
        timeoutMs: 25_000, optional: true,
        options: [
          { id: 'invoke', label: '发动【回天】' },
          { id: 'cancel', label: '不发动' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke') return
    if ((response.payload as { optionId?: string }).optionId !== 'invoke') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.marks[HUITIAN_ROUND_MARK] !== undefined) return
    host.dispatch('SkillActivated', {
      skillId: HUITIAN, skillName: '回天', playerId: ownerId,
      logText: `${owner.nickname}发动【回天】，摸一张牌并获得一个额外回合`,
    }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    // 记下发动是在第几轮，下一轮开始时按它结算死亡
    owner.marks[HUITIAN_ROUND_MARK] = host.state.roundNumber ?? 1
    // 走公共的额外回合队列，绝不直接改 currentPlayerId
    queueExtraTurn(host.state, ownerId, { skillId: HUITIAN })
  },
})

export const SHENJIANGWEI: CharacterDefinition = {
  id: 'shenjiangwei',
  name: '神·姜维',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: XINGHUN,
      name: '星魂',
      description: '出牌阶段限一次，你可以观看牌堆顶的五张牌，然后你可以用任意张手牌交换其中等量的牌，并重新排列这五张牌。然后你选择一名其他角色，展示这五张牌并对其依次使用其中的【杀】。',
    },
    {
      id: TIANTAO,
      name: '天涛',
      description: '锁定技，结束阶段，你选择一个区域并弃置你该区域里的所有牌，然后你可以令任意名其他角色各弃置其该区域里的一张牌。因此弃置的牌中没有【杀】的角色失去1点体力。',
    },
    {
      id: SHENPEI,
      name: '神霈',
      description: '限定技，你处于濒死状态时，你可以令X为你本局游戏进入濒死状态的次数，你回复X点体力，然后对一名角色造成X点雷电伤害，并获得【回天】。',
    },
    {
      id: HUITIAN,
      name: '回天',
      description: '一名其他角色的回合结束时，若其体力值大于你，你可以摸一张牌并获得一个额外回合。若你于上一轮发动过此技能，则你于本轮开始时死亡。',
      granted: true,
    },
  ],
}
