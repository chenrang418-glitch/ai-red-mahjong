import { getAttackRange, getDistance } from '../../engine/distance'
import { handleEquipmentLost } from '../../engine/equipment'
import { abolishSlot, abolishableSlotsOf, abolishedSlotsOf, isSlotAbolished, restoreSlot, SLOT_LABELS } from '../../engine/equipment-slots'
import type { ChooseOptionRequest } from '../../engine/requests'
import { recheckZeroHpAfterSkillLoss, registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import { suppressSkill, suppressionBySource } from '../../engine/skill-suppression'
import { stealableSkillsOf } from '../../engine/skill-theft'
import type { EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import { getCharacter } from './standard'
import type { CharacterDefinition } from './types'

/**
 * 神张辽。本项目的自研玩法表述。
 *
 * 【夺锐】：当你于出牌阶段内对一名其他角色造成伤害后，你可以废除你的一个装备栏
 *   （武器栏、防具栏、+1 坐骑栏、-1 坐骑栏之一），然后选择该角色的武将牌上的一个技能
 *   （限定技、觉醒技、使命技、主公技、部分规则冲突技能除外），
 *   则其下回合结束之前，其被你选择的技能无效，
 *   然后你于其下回合结束或其死亡之前获得所选技能且不能发动【夺锐】。
 * 【止啼】：锁定技，你攻击范围内已受伤的角色手牌上限 -1；
 *   当你和这些角色拼点或【决斗】你赢时，你恢复一个装备栏。
 *   当你受到伤害后，若来源在你的攻击范围内且已受伤，你恢复一个装备栏。
 *
 * **不是旧 OL 版**：没有「夺锐后直接结束出牌阶段」，
 * 止啼也不是「按全场受伤人数分档给摸牌 / 废装备栏」。
 *
 * 三个关键点：
 *
 * 1. **不能先废栏再发现没技能可选**。进入之前先把合法技能集合算出来，
 *    为空就根本不发问——否则玩家白白废掉一个装备栏。
 * 2. **夺锐期间不能再发动夺锐**，所以同时最多持有一个夺来的技能。
 * 3. 期限是目标的**下一个实际回合结束**：目标先拿到额外回合的话，
 *    那个额外回合结束就到期。到期和目标死亡都由公共机制统一收尾。
 */

const DUORUI = 'duorui'
const ZHITI = 'zhiti'

/** 某个武将牌上印着的技能条目（含 granted 标记），交给资格判定用。 */
function characterSkillsOf(characterId: string): Array<{ id: string; name: string; granted?: boolean }> {
  return (getCharacter(characterId)?.skills ?? []) as Array<{ id: string; name: string; granted?: boolean }>
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isWounded(state: SanguoshaState, playerId: PlayerId): boolean {
  const player = playerOf(state, playerId)
  return Boolean(player?.alive) && player!.hp < player!.maxHp
}

/** 这个人是否在神张辽的攻击范围内。攻击范围会随武器栏被废除而变化。 */
function inAttackRange(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  const target = playerOf(state, targetId)
  if (!owner?.alive || !target?.alive || ownerId === targetId) return false
  return getDistance(state, ownerId, targetId) <= getAttackRange(state, ownerId)
}

/** 神张辽现在是不是正持有一个夺来的技能（持有期间不能再发动夺锐）。 */
function holdingStolenSkill(state: SanguoshaState, ownerId: PlayerId): boolean {
  return suppressionBySource(state, ownerId, DUORUI) !== null
}

// ─────────────────────────────── 夺锐 ───────────────────────────────

registerSkillRuntime({
  id: DUORUI,
  announcesSelf: true,

  triggers: [{
    /**
     * 出牌阶段内对其他角色造成伤害后。
     *
     * 牌本身可以是【杀】【决斗】【南蛮】【火攻】，也可以是技能造成的伤害——
     * 文本只要求「于你的出牌阶段内造成伤害」，不限来源牌。
     */
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const targetId = context.event.targetId
      if (!targetId || targetId === ownerId) return
      // 必须在**神张辽自己的出牌阶段内**
      if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
      if (!playerOf(host.state, ownerId)?.alive) return
      // 夺锐期间不能再发动
      if (holdingStolenSkill(host.state, ownerId)) return
      // 至少要有一个可废除的装备栏
      if (abolishableSlotsOf(host.state, ownerId).length === 0) return
      /*
       * **先算合法技能集合**，为空就不发问。
       * 否则玩家选完装备栏才发现没技能可选，白废一个栏——
       * 被断肠清空技能的目标正是这种情况。
       */
      if (stealableSkillsOf(host.state, targetId, characterSkillsOf).length === 0) return
      host.queueSkill({ skillId: DUORUI, ownerId, step: 'ask', data: { targetId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const targetId = prompt.data.targetId as PlayerId
    if (!playerOf(host.state, ownerId)?.alive) return
    // 排队期间条件可能已经不成立，逐条重新验
    if (holdingStolenSkill(host.state, ownerId)) return
    const slots = abolishableSlotsOf(host.state, ownerId)
    const skills = stealableSkillsOf(host.state, targetId, characterSkillsOf)
    if (slots.length === 0 || skills.length === 0) return
    host.askSkill({
      skillId: DUORUI, ownerId, step: 'slot', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `发动【夺锐】？废除自己的一个装备栏，夺取${playerOf(host.state, targetId)?.nickname}的一个技能`,
        timeoutMs: 30_000, optional: true,
        options: [
          ...slots.map((slot) => ({ id: `slot:${slot}`, label: `废除${SLOT_LABELS[slot]}` })),
          { id: 'no', label: '放弃' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const optionId = (response.payload as { optionId?: string }).optionId ?? 'no'

    if (resolution.step === 'slot') {
      if (!optionId.startsWith('slot:')) return
      const slot = optionId.slice('slot:'.length) as EquipmentSlot
      const targetId = resolution.data.targetId as PlayerId
      // 落地前再验一次，避免排队期间状态变化
      if (!abolishableSlotsOf(host.state, ownerId).includes(slot)) return
      const skills = stealableSkillsOf(host.state, targetId, characterSkillsOf)
      if (skills.length === 0) return
      /*
       * **先问技能再一次性落地**：废栏和夺技能是同一次结算，
       * 中途不能出现「栏废了但技能没夺到」。
       */
      host.askSkill({
        skillId: DUORUI, ownerId, step: 'skill', data: { targetId, slot },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【夺锐】：选择要夺取${playerOf(host.state, targetId)?.nickname}的哪个技能`,
          timeoutMs: 30_000, optional: false,
          options: skills.map((skill) => ({ id: skill.skillId, label: skill.name })),
        }),
      })
      return
    }

    if (resolution.step === 'skill') {
      const targetId = resolution.data.targetId as PlayerId
      const slot = resolution.data.slot as EquipmentSlot
      const skillId = optionId
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      // 最后一次校验：三个前提都还成立才落地
      if (!abolishableSlotsOf(host.state, ownerId).includes(slot)) return
      if (!stealableSkillsOf(host.state, targetId, characterSkillsOf).some((skill) => skill.skillId === skillId)) return
      if (holdingStolenSkill(host.state, ownerId)) return

      // 1) 废除装备栏。栏里有牌的话按正常规则离场，枭姬、白银狮子照常触发
      const equipped = owner.zones.equipment[slot]
      if (equipped) {
        moveCard(host.state, equipped, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
        handleEquipmentLost(host as never, ownerId, equipped)
      }
      abolishSlot(host.state, ownerId, slot)

      // 2) 目标的这个技能失效，直到其下一个实际回合结束
      suppressSkill(host.state, {
        targetId, skillId, sourceId: ownerId, sourceSkillId: DUORUI, armedAtTurn: host.state.turnNumber,
      })
      // 3) 神张辽临时获得它。同来源只保留一个，天然保证同时最多持有一个
      replaceTemporarySkill(host.state, ownerId, DUORUI, skillId)

      host.dispatch('SkillActivated', {
        skillId: DUORUI, skillName: '夺锐', playerId: ownerId, targetIds: [targetId],
        logText: `${owner.nickname}发动【夺锐】，废除自己的${SLOT_LABELS[slot]}，`
          + `夺取${playerOf(host.state, targetId)?.nickname}的一个技能直到其下回合结束`,
      }, { sourceId: ownerId, targetId })

      /*
       * **夺走的可能正是对方赖以活着的技能。**
       *
       * 周泰靠【不屈】在 0 体力存活；夺锐把不屈拿走之后他就没有依据了，
       * 必须立刻重新进入濒死，否则留下一个「0 血非濒死存活」的非法状态
       * （压测 seed=balance-5-105 抓到）。
       * 走公共入口——左慈换化身、蔡文姬【断肠】剥夺技能踩的是同一个坑。
       */
      recheckZeroHpAfterSkillLoss(host as never, targetId)
    }
  },
})

// ─────────────────────────────── 止啼 ───────────────────────────────

/** 恢复一个装备栏：只有一个就自动恢复，多个就问选哪个。 */
function askRestoreSlot(
  host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['startQueued']>>[0],
  ownerId: PlayerId,
): void {
  const abolished = abolishedSlotsOf(host.state, ownerId)
  // 没有已废除的栏时不发空请求
  if (abolished.length === 0) return
  if (abolished.length === 1) {
    restoreSlot(host.state, ownerId, abolished[0])
    announceRestore(host, ownerId, abolished[0])
    return
  }
  host.askSkill({
    skillId: ZHITI, ownerId, step: 'restore',
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【止啼】：恢复一个已废除的装备栏',
      timeoutMs: 20_000, optional: false,
      options: abolished.map((slot) => ({ id: slot, label: SLOT_LABELS[slot] })),
    }),
  })
}

function announceRestore(
  host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['startQueued']>>[0],
  ownerId: PlayerId,
  slot: EquipmentSlot,
): void {
  host.dispatch('SkillActivated', {
    skillId: ZHITI, skillName: '止啼', playerId: ownerId,
    logText: `${playerOf(host.state, ownerId)?.nickname}发动【止啼】，恢复${SLOT_LABELS[slot]}`,
  }, { sourceId: ownerId })
}

registerSkillRuntime({
  id: ZHITI,

  /**
   * 攻击范围内**已受伤**的角色手牌上限 -1。
   *
   * - 只看「已受伤」和「在攻击范围内」，**不分敌友**。
   * - 神张辽不在自己的攻击范围内，所以不影响自己。
   * - 攻击范围随武器、坐骑、马术、距离修正动态变化；
   *   武器栏被废除时武器不存在，范围跟着变——`getAttackRange` 已经处理。
   */
  globalMaxCardsBonus(state, ownerId, targetId) {
    if (targetId === ownerId) return 0
    if (!isWounded(state, targetId)) return 0
    return inAttackRange(state, ownerId, targetId) ? -1 : 0
  },

  triggers: [
    {
      /**
       * 受到伤害后：来源在攻击范围内且已受伤，恢复一个装备栏。
       *
       * 按「受到伤害后」的**实时状态**判断——来源在这次伤害过程中掉了装备、
       * 被打成濒死甚至死了，都按最终状态算。
       */
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const sourceId = context.event.sourceId
        if (!sourceId || sourceId === ownerId) return
        if (!playerOf(host.state, ownerId)?.alive) return
        if (abolishedSlotsOf(host.state, ownerId).length === 0) return
        if (!isWounded(host.state, sourceId)) return
        if (!inAttackRange(host.state, ownerId, sourceId)) return
        host.queueSkill({ skillId: ZHITI, ownerId, step: 'restore', data: {} })
      },
    },
    {
      /**
       * 拼点赢、或决斗赢：恢复一个装备栏。
       *
       * 两者都走引擎统一的胜负事件，不能拿「最后一次伤害来源是他」凑——
       * **平局不算赢**。
       */
      event: 'PindianResult',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { winnerId?: PlayerId; loserId?: PlayerId }
        if (payload.winnerId !== ownerId) return
        const opponentId = payload.loserId
        if (!opponentId || !isWounded(host.state, opponentId)) return
        if (!inAttackRange(host.state, ownerId, opponentId)) return
        if (abolishedSlotsOf(host.state, ownerId).length === 0) return
        host.queueSkill({ skillId: ZHITI, ownerId, step: 'restore', data: {} })
      },
    },
    {
      event: 'DuelResult',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { winnerId?: PlayerId; loserId?: PlayerId }
        if (payload.winnerId !== ownerId) return
        const opponentId = payload.loserId
        if (!opponentId || !isWounded(host.state, opponentId)) return
        if (!inAttackRange(host.state, ownerId, opponentId)) return
        if (abolishedSlotsOf(host.state, ownerId).length === 0) return
        host.queueSkill({ skillId: ZHITI, ownerId, step: 'restore', data: {} })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'restore') return
    if (!playerOf(host.state, ownerId)?.alive) return
    askRestoreSlot(host, ownerId)
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'restore') return
    const slot = (response.payload as { optionId?: string }).optionId as EquipmentSlot | undefined
    if (!slot || !isSlotAbolished(host.state, ownerId, slot)) return
    restoreSlot(host.state, ownerId, slot)
    announceRestore(host, ownerId, slot)
  },
})

export const SHENZHANGLIAO: CharacterDefinition = {
  id: 'shenzhangliao',
  name: '神·张辽',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: DUORUI,
      name: '夺锐',
      description: '当你于出牌阶段内对一名其他角色造成伤害后，你可以废除你的一个装备栏，然后选择该角色武将牌上的一个技能（限定技、觉醒技、使命技、主公技、部分规则冲突技能除外），令其于其下回合结束之前无效，然后你于其下回合结束或其死亡之前获得该技能且不能发动【夺锐】。',
    },
    {
      id: ZHITI,
      name: '止啼',
      description: '锁定技，你攻击范围内已受伤的角色手牌上限-1；当你和这些角色拼点或【决斗】你赢时，你恢复一个装备栏；当你受到伤害后，若来源在你的攻击范围内且已受伤，你恢复一个装备栏。',
    },
  ],
}
