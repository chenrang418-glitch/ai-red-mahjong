import { setChained } from '../../engine/character-state'
import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { suppressSkill } from '../../engine/skill-suppression'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神马超。
 *
 * 【驭雳】：锁定技，你造成的伤害若不为雷电伤害，则改为雷电伤害；若已是雷电伤害，
 *   则伤害值 +1。你受到雷电伤害时，防止之，然后你摸等同于伤害值的牌。
 * 【霆威】：你使用【杀】指定目标后，你可以获得四枚「霆」，然后选择其中一名目标，
 *   该目标选择 0~4 项，你每因此失去一枚「霆」。一项都不选则该目标横置。
 * 【寂灭】：限定技，你的出牌阶段结束时，若你有至少八枚「霆」，你可以失去八枚「霆」，
 *   对一名角色造成等同于其体力上限的伤害。若你此后【驭雳】的两半都各生效过一次，
 *   【寂灭】重置。
 *
 * 四处最容易做错的：
 *
 * 1. **改属性要排在藤甲、狂风、大雾之前。** 晚一步的话加成和防御按的都是
 *    已经不存在的属性。这条不在这个文件里排队，走公共的伤害修正管线。
 * 2. **防止伤害是「没有发生」，不是「扣了再补」。** 补回来的话狂暴、忍戒、
 *    濒死全都被错误地触发一遍。
 * 3. **失效的是「非锁定技」这个条件，不是一份技能 id 名单。** 期间新获得的
 *    非锁定技也要一并失效，所以存的是范围，每次现算。
 * 4. **那个 +1 只属于这张【杀】对这一名目标。** 不是他本回合所有伤害 +1，
 *    也不是这张【杀】的其他目标一起 +1；这张【杀】最终没造成伤害，就不该凭空多出 1 点。
 */

const YULI = 'yuli'
const TINGWEI = 'tingwei'
const JIEMIE = 'jiemie'

/** 公共具名标记：霆。座位卡上要显示，所以键名固定在这里。 */
const TING = 'ting'
/** 发动一次霆威给几枚霆。 */
const TINGWEI_GAIN = 4
/** 寂灭的门槛与开销。 */
const JIEMIE_COST = 8

/** 驭雳「造成伤害」那一半本轮期内生效过。 */
const YULI_PART1 = 'yuli-part1'
/** 驭雳「防止雷伤并摸牌」那一半本轮期内生效过。 */
const YULI_PART2 = 'yuli-part2'
/** 这一次出牌阶段结束窗口里已经发动过寂灭。 */
const JIEMIE_WINDOW = 'jiemie-window'

const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

/** 这张牌上已经发动过霆威。随牌记账，多目标【杀】只发动一次靠它。 */
function usedMark(cardId: CardId): string {
  return `tingwei-used:${cardId}`
}

/** 霆威第三项给这张牌对这名目标的伤害 +1，键上带着牌和目标，绝不外溢。 */
function bonusMark(cardId: CardId, targetId: PlayerId): string {
  return `tingwei-bonus:${cardId}:${targetId}`
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function tingOf(state: SanguoshaState, ownerId: PlayerId): number {
  return playerOf(state, ownerId)?.marks[TING] ?? 0
}

function addTing(state: SanguoshaState, ownerId: PlayerId, delta: number): void {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  // 霆是公共标记，永远不能是负数
  owner.marks[TING] = Math.max(0, (owner.marks[TING] ?? 0) + delta)
}

/** 装备牌：手牌里的装备 + 装备区上的实体装备。 */
function equipmentCardsOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  const inHand = player.zones.hand.filter((cardId) => state.cards[cardId]?.category === 'equipment')
  const equipped = EQUIPMENT_SLOTS
    .map((slot) => player.zones.equipment[slot])
    .filter((cardId): cardId is CardId => !!cardId)
  return [...inHand, ...equipped]
}

/** 随机弃牌的牌池：手牌 + 装备区。判定区的牌不属于他，不进池。 */
function discardablePoolOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  const equipped = EQUIPMENT_SLOTS
    .map((slot) => player.zones.equipment[slot])
    .filter((cardId): cardId is CardId => !!cardId)
  return [...player.zones.hand, ...equipped]
}

/** 把某人的一张牌弃掉，不管它在手上还是装备区。 */
function discardOne(host: SkillHost, playerId: PlayerId, cardId: CardId): void {
  const player = playerOf(host.state, playerId)
  if (!player) return
  if (player.zones.hand.includes(cardId)) {
    moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  } else {
    const slot = EQUIPMENT_SLOTS.find((candidate) => player.zones.equipment[candidate] === cardId)
    if (!slot) return
    moveCard(host.state, cardId, { kind: 'equipment', playerId, slot }, { kind: 'discardPile' })
    // 装备离场走正常路径：白银狮子那类「失去装备时」的效果照常触发
    handleEquipmentLost(host as never, playerId, cardId)
  }
  host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: TINGWEI }, { targetId: playerId, cardIds: [cardId] })
}

// ─────────────────────────────── 驭雳 ───────────────────────────────

registerSkillRuntime({
  id: YULI,
  outgoingDamage(_state, _ownerId, context) {
    /*
     * 属性和数值**一次算完**。
     *
     * 分两步写的话「原本不是雷电」这个前提会被自己第一步改掉：
     * 一发普通伤害先变雷电，再因为「已经是雷电」而 +1，凭空多出一点。
     */
    if (context.nature === 'thunder') return { nature: 'thunder', amount: context.amount + 1 }
    return { nature: 'thunder', amount: context.amount }
  },
  interceptIncomingDamage(host, ownerId, context) {
    if (context.nature !== 'thunder') return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    /*
     * 防止之后**才**摸牌，摸的是这次伤害的数值。
     * 伤害既然被防止，「受到伤害后」那批时机一个都不该跑——那由公共管线保证，
     * 这里只要如实返回 true。
     */
    drawCards(host.state, host.rng, ownerId, context.amount, (name, payload) => { host.dispatch(name, payload) })
    owner.marks[YULI_PART2] = 1
    return true
  },
  triggers: [
    {
      /** 造成伤害那一半确实生效过：寂灭的重置要按这个记账。 */
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        if (context.event.damageNature !== 'thunder') return
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        owner.marks[YULI_PART1] = 1
      },
    },
  ],
})

// ─────────────────────────────── 霆威 ───────────────────────────────

/** 霆威的四项。顺序固定，联机两端和回放都按这个顺序读。 */
const TINGWEI_OPTIONS = ['suppress', 'equipment', 'damage', 'discard'] as const
type TingweiOption = (typeof TINGWEI_OPTIONS)[number]
const OPTION_LABELS: Record<TingweiOption, string> = {
  suppress: '你的非锁定技失效至你下个回合结束',
  equipment: '交给他一张装备牌',
  damage: '此【杀】对你造成的伤害 +1',
  discard: '随机弃置你的一张牌',
}

/**
 * 结算顺序。交装备排最后：只有它还要再问一次，前面几项必须先落定。
 */
const SETTLE_ORDER: readonly TingweiOption[] = ['suppress', 'damage', 'discard', 'equipment']

/** 这一项现在选得起吗。选不起的项不进候选：不给玩家一个付不出的选择。 */
function optionAvailable(state: SanguoshaState, targetId: PlayerId, option: TingweiOption): boolean {
  if (option === 'equipment') return equipmentCardsOf(state, targetId).length > 0
  if (option === 'discard') return discardablePoolOf(state, targetId).length > 0
  return true
}

registerSkillRuntime({
  id: TINGWEI,
  outgoingDamage(state, ownerId, context) {
    if (!context.cardId) return null
    const bonus = playerOf(state, ownerId)?.marks[bonusMark(context.cardId, context.targetId)] ?? 0
    if (bonus <= 0) return null
    // 只对这张牌打这名目标的这一下生效；属性归【驭雳】，这里只改数值
    return { amount: context.amount + bonus }
  },
  triggers: [{
    /*
     * 那个绑定到「这张牌 + 这名目标」的 +1 用完就收。
     *
     * 不收的话它会一直躺在标记里，同一张实体牌下次被使用时会白拿一次加成。
     */
    event: 'AfterCardUse',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      for (const key of Object.keys(owner.marks)) {
        if (key.startsWith('tingwei-bonus:') || key.startsWith('tingwei-used:')) delete owner.marks[key]
      }
    },
  }],
  /*
   * 挂在**使用者的目标插入点**上，不是 `TargetSpecified` 事件上。
   *
   * 事件里发问不会让这张【杀】停下来：请求还挂着，结算已经走到目标方的
   * 反应了，下一个想发问的技能直接撞上「已有技能正在等待回应」。
   * 这个插入点是引擎给的正经挂起点，【铁骑】走的也是它。
   */
  interceptSourceTarget(host, ownerId, context) {
    if (context.cardName !== '杀') return false
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, context.targetId)
    if (!owner?.alive || !target?.alive) return false
    /*
     * **一次使用最多发动一次**，多目标【杀】也一样。
     *
     * 每个目标各自结算一次，所以「一次使用只发动一次」得靠这枚随牌记账的标记，
     * 而不是靠结算状态——那是按目标分的。
     */
    if (owner.marks[usedMark(context.cardId)]) return false
    host.askSkill({
      skillId: TINGWEI, ownerId, step: 'invoke', data: { targetId: context.targetId, cardId: context.cardId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【霆威】：对${target.nickname}发动，获得四枚「霆」？`,
        timeoutMs: 25_000, optional: true,
        options: [
          { id: 'invoke', label: '发动【霆威】' },
          { id: 'cancel', label: '不发动' },
        ],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      const targetId = String(resolution.data.targetId ?? '')
      const cardId = String(resolution.data.cardId ?? '')
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      const invoked = (response.payload as { optionId?: string }).optionId === 'invoke'
      if (!invoked || !owner?.alive || !target?.alive) { host.resumeCardTarget(); return }
      owner.marks[usedMark(cardId)] = 1
      // 先拿霆再让对方选：四项的开销正是从这四枚里付
      addTing(host.state, ownerId, TINGWEI_GAIN)
      host.dispatch('SkillActivated', {
        skillId: TINGWEI, skillName: '霆威', playerId: ownerId, targetId,
        logText: `${owner.nickname}对${target.nickname}发动【霆威】，获得四枚「霆」`,
      }, { sourceId: ownerId, targetId })
      if (!askOptions(host, ownerId, targetId, cardId)) host.resumeCardTarget()
      return
    }

    if (resolution.step === 'give-equipment') {
      const targetId = String(resolution.data.targetId ?? '')
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (owner?.alive && target?.alive && cardId && equipmentCardsOf(host.state, targetId).includes(cardId)) {
        const slot = EQUIPMENT_SLOTS.find((candidate) => target.zones.equipment[candidate] === cardId)
        if (slot) {
          moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'hand', playerId: ownerId })
          // 装备离场走正常路径
          handleEquipmentLost(host as never, targetId, cardId)
        } else {
          moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        }
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: TINGWEI }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
      // 这是霆威的最后一步，走到这里就把控制权交回这张【杀】
      host.resumeCardTarget()
      return
    }

    if (resolution.step !== 'options') return
    const targetId = String(resolution.data.targetId ?? '')
    const cardId = String(resolution.data.cardId ?? '')
    const chosen = ((response.payload as { optionIds?: string[] }).optionIds ?? [])
      .filter((id): id is TingweiOption => TINGWEI_OPTIONS.includes(id as TingweiOption))
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) { host.resumeCardTarget(); return }
    // 同一项最多选一次
    const unique = [...new Set(chosen)].filter((option) => optionAvailable(host.state, targetId, option))

    if (unique.length === 0) {
      /*
       * 一项都不选就横置。**是置为连环，不是切换**：
       * 已经横置的人继续横置，不能因为「再来一次」反而解除。
       */
      setChained(host as never, targetId, TINGWEI, true)
      host.dispatch('SkillActivated', {
        skillId: TINGWEI, skillName: '霆威', playerId: ownerId, targetId,
        logText: `${target.nickname}一项都不选，被横置`,
      }, { sourceId: ownerId, targetId })
      host.resumeCardTarget()
      return
    }

    /*
     * 按固定顺序结算，客户端传来的顺序不作数：顺序不稳定的话同一个种子
     * 会走出两局不同的牌。交装备排在最后——只有它还要再问一次，
     * 前面几项必须在那次发问之前就落定。
     */
    for (const option of SETTLE_ORDER) {
      if (!unique.includes(option)) continue
      // 付的是神马超的霆，不是目标的
      addTing(host.state, ownerId, -1)
      applyOption(host, ownerId, targetId, cardId, option)
    }
    // 交装备那一项已经发过问了，控制权由它那一步交回
    if (!unique.includes('equipment')) host.resumeCardTarget()
  },
})

/** 问目标要选哪几项；真的问出去了才返回 true。 */
function askOptions(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, cardId: string): boolean {
  const available = TINGWEI_OPTIONS.filter((option) => optionAvailable(host.state, targetId, option))
  // 一项都选不起时不必问：结果只能是「一项都不选」，直接横置
  if (available.length === 0) {
    setChained(host as never, targetId, TINGWEI, true)
    return false
  }
  host.askSkill({
    skillId: TINGWEI, ownerId, step: 'options', data: { targetId, cardId },
    build: (requestId): ChooseOptionsRequest => ({
      id: requestId, kind: 'choose-options',
      // **四项由目标自己选**，不是神马超替他选
      playerId: targetId,
      prompt: '【霆威】：选择任意项（一项都不选则你横置）',
      timeoutMs: 30_000, optional: true,
      options: available.map((option) => ({ id: option, label: OPTION_LABELS[option] })),
      min: 0, max: available.length,
    }),
  })
  return true
}

function applyOption(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, cardId: string, option: TingweiOption): void {
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  if (option === 'suppress') {
    /*
     * 压的是**「非锁定技」这个条件**，不是当前技能 id 的快照——
     * 期间新获得的非锁定技也要一并失效。期限是目标的下一个**实际**回合结束，
     * 额外回合也算，由公共的到期检查按回合序号处理。
     */
    suppressSkill(host.state, {
      targetId, scope: 'non-locked', sourceId: ownerId, sourceSkillId: TINGWEI,
      armedAtTurn: host.state.turnNumber,
    })
    host.dispatch('SkillActivated', {
      skillId: TINGWEI, skillName: '霆威', playerId: ownerId, targetId,
      logText: `${target.nickname}的非锁定技失效至其下个回合结束`,
    }, { sourceId: ownerId, targetId })
    return
  }
  if (option === 'equipment') {
    /*
     * 哪一张由目标自己挑，所以再问他一次。
     *
     * **直接发问，不能排队**：此刻这张【杀】正挂在插入点上，桌面不干净，
     * 技能队列要等桌面收干净才放行——排进去就等于永远不问，牌局卡死。
     */
    const cards = equipmentCardsOf(host.state, targetId)
    if (cards.length === 0) return
    host.askSkill({
      skillId: TINGWEI, ownerId, step: 'give-equipment', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards',
        // 交哪一张由**交牌的人**自己挑
        playerId: targetId,
        prompt: '【霆威】：交给对方一张装备牌',
        timeoutMs: 25_000, optional: false, purpose: 'skill',
        cardIds: cards, hiddenCardSlots: [],
        min: 1, max: 1,
      }),
    })
    return
  }
  if (option === 'damage') {
    /*
     * 这个 +1 绑死在「这张牌 + 这名目标」上。这张【杀】最终没造成伤害的话，
     * 标记会在 `AfterCardUse` 被清掉，不会凭空多出一点伤害。
     */
    const owner = playerOf(host.state, ownerId)
    if (owner) owner.marks[bonusMark(cardId, targetId)] = 1
    host.dispatch('SkillActivated', {
      skillId: TINGWEI, skillName: '霆威', playerId: ownerId, targetId,
      logText: `此【杀】对${target.nickname}造成的伤害 +1`,
    }, { sourceId: ownerId, targetId })
    return
  }
  const pool = discardablePoolOf(host.state, targetId)
  if (pool.length === 0) return
  /*
   * **随机用牌局自己的种子**，不是客户端随机：同一个种子必须走出同一个结果，
   * 重连和回放才对得上。
   */
  const picked = pool[host.rng.nextInt(pool.length)]
  discardOne(host, targetId, picked)
  host.dispatch('SkillActivated', {
    skillId: TINGWEI, skillName: '霆威', playerId: ownerId, targetId, cardIds: [picked],
    logText: `${target.nickname}被随机弃置一张牌`,
  }, { sourceId: ownerId, targetId, cardIds: [picked] })
}

// ─────────────────────────────── 寂灭 ───────────────────────────────

registerSkillRuntime({
  id: JIEMIE,
  limited: true,
  triggers: [{
    /*
     * 记账位齐了就解锁。挂在回合结束而不是伤害时机上：
     * 解锁发生在牌桌干净的时刻，不会插进正在结算的一发伤害中间。
     */
    event: 'TurnEnd',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      // 窗口标记只管一个出牌阶段结束窗口，回合一过就作废
      delete owner.marks[JIEMIE_WINDOW]
      if (!owner.usedLimitedSkills.includes(JIEMIE)) return
      if (!owner.marks[YULI_PART1] || !owner.marks[YULI_PART2]) return
      owner.usedLimitedSkills = owner.usedLimitedSkills.filter((skillId) => skillId !== JIEMIE)
      host.dispatch('SkillActivated', {
        skillId: JIEMIE, skillName: '寂灭', playerId: ownerId,
        logText: `${owner.nickname}的【寂灭】重置`,
      }, { sourceId: ownerId })
    },
  }, {
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (owner.usedLimitedSkills.includes(JIEMIE)) return
      if (tingOf(host.state, ownerId) < JIEMIE_COST) return
      /*
       * **同一个结束窗口里不能连发**。
       *
       * 寂灭是可重置的限定技，理论上它造成的伤害可以在同一个窗口里
       * 把两个记账位都点亮、当场解锁下一次——那样就成了无限连发。
       * 这一枚窗口标记在阶段结束时清掉。
       */
      if (owner.marks[JIEMIE_WINDOW]) return
      host.askSkill({
        skillId: JIEMIE, ownerId, step: 'invoke',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【寂灭】：失去八枚「霆」，对一名角色造成等同于其体力上限的伤害？（当前 ${tingOf(host.state, ownerId)} 枚）`,
          timeoutMs: 25_000, optional: true,
          options: [{ id: 'invoke', label: '发动【寂灭】' }, { id: 'cancel', label: '不发动' }],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'invoke') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.usedLimitedSkills.includes(JIEMIE)) return
      if (tingOf(host.state, ownerId) < JIEMIE_COST) return
      host.askSkill({
        skillId: JIEMIE, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【寂灭】：对哪名角色造成等同于其体力上限的伤害',
          timeoutMs: 25_000, optional: false,
          candidateIds: host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id),
          min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    if (tingOf(host.state, ownerId) < JIEMIE_COST) return

    addTing(host.state, ownerId, -JIEMIE_COST)
    owner.usedLimitedSkills.push(JIEMIE)
    owner.marks[JIEMIE_WINDOW] = 1
    /*
     * 重置是按**轮期**算的：每次发动之后两个记账位清零，
     * 之后【驭雳】的两半各再生效一次，寂灭才恢复。
     */
    delete owner.marks[YULI_PART1]
    delete owner.marks[YULI_PART2]
    host.dispatch('SkillActivated', {
      skillId: JIEMIE, skillName: '寂灭', playerId: ownerId, targetId: target.id,
      logText: `${owner.nickname}对${target.nickname}发动【寂灭】，造成 ${target.maxHp} 点伤害`,
    }, { sourceId: ownerId, targetId: target.id })
    /*
     * 伤害值是**体力上限**，不是当前体力。属性给 normal，
     * 由【驭雳】按统一管线改成雷电——因为原本不是雷电，所以不再额外 +1。
     */
    resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: target.maxHp, nature: 'normal' })
  },
})

export const SHENMACHAO: CharacterDefinition = {
  id: 'shenmachao',
  name: '神·马超',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: YULI,
      name: '驭雳',
      description: '锁定技，你造成的伤害若不为雷电伤害，则改为雷电伤害，否则此伤害+1；你受到雷电伤害时，防止此伤害，然后你摸等同于此伤害值的牌。',
    },
    {
      id: TINGWEI,
      name: '霆威',
      description: '你使用【杀】指定目标后，你可以获得四枚「霆」，然后选择其中一名目标，该目标选择任意项：1.其非锁定技失效至其下个回合结束；2.其交给你一张装备牌；3.此【杀】对其造成的伤害+1；4.随机弃置其一张牌。你每因此执行一项，失去一枚「霆」；若其一项都未选择，则其横置。',
    },
    {
      id: JIEMIE,
      name: '寂灭',
      description: '限定技，你的出牌阶段结束时，若你有至少八枚「霆」，你可以失去八枚「霆」，对一名角色造成等同于其体力上限的伤害。此后你的【驭雳】的两种效果各生效过一次时，你重置此技能。',
    },
  ],
}
