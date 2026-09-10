import { createCharacterWeapon, isCharacterEquipment } from '../../engine/character-equipment'
import { sampleCharacters, type PoolCharacter } from '../../engine/character-pool'
import { resolveDamage } from '../../engine/damage'
import { abolishSlot, equipmentSlotsOf, grantExtraWeaponSlot } from '../../engine/equipment-slots'
import { handleEquipmentLost } from '../../engine/equipment'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { canTarget, getDistance } from '../../engine/distance'
import { declinedThisPhase, markDeclinedThisPhase } from '../../engine/phase-usage'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神典韦。
 *
 * 【捐甲】：锁定技，游戏开始时，你废除防具栏，然后获得一个额外的武器栏。
 * 【挈挟】：锁定技，准备阶段，你随机观看五张武将牌，然后可以将其中任意张
 *   当武器牌置于你的装备区。
 * 【摧决】：出牌阶段，你可以弃置一张牌，对你攻击范围内距离最远的一名其他角色
 *   造成 1 点伤害；每名角色每回合限一次。
 *
 * 四处最容易做错的：
 *
 * 1. **额外武器栏是真的多一栏**，不是「攻击范围按两把算」这种界面说法：
 *    它能独立装备、独立被替换，两把武器的效果同时生效。
 * 2. **武将牌当武器时没有花色、没有点数**，而且**一离开装备区就销毁**——
 *    不能进手牌、弃牌堆或牌堆，被顺被拆也一样。
 * 3. **借来的技能来源是装备**，不是他的武将牌：【断肠】管不到它，
 *    【夺锐】也偷不走它。
 * 4. **「最远」每次发动都重算**，而且限制是「每名角色每回合一次」，
 *    不是「这个技能每回合一次」。
 */

const JUANJIA = 'juanjia'
const QIEXIE = 'qiexie'
const CUIJUE = 'cuijue'

/** 挈挟每次看几张武将牌。 */
const QIEXIE_SAMPLE = 5
/** 摧决本回合已经打过谁：记在标记里，可序列化。 */
const CUIJUE_HIT_MARK = 'cuijue-hit'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function cuijueHitMark(targetId: PlayerId): string {
  return `${CUIJUE_HIT_MARK}:${targetId}`
}

// ─────────────────────────────── 捐甲 ───────────────────────────────

registerSkillRuntime({
  id: JUANJIA,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    /*
     * 防具栏是**废除**，不是「装不上防具」：栏本身没了，
     * 界面上要显示成废除，别人也不能给他装防具。
     */
    const armor = owner.zones.equipment.armor
    if (armor) {
      moveCard(host.state, armor, { kind: 'equipment', playerId: ownerId, slot: 'armor' }, { kind: 'discardPile' })
      handleEquipmentLost(host as never, ownerId, armor)
    }
    abolishSlot(host.state, ownerId, 'armor')
    grantExtraWeaponSlot(host.state, ownerId)
    host.dispatch('SkillActivated', {
      skillId: JUANJIA, skillName: '捐甲', playerId: ownerId,
      logText: `${owner.nickname}废除防具栏，获得一个额外的武器栏`,
    }, { sourceId: ownerId })
  },
})

// ─────────────────────────────── 挈挟 ───────────────────────────────

/** 候选武将牌在选择面板上怎么显示。 */
function describeCharacter(character: PoolCharacter): string {
  return `${character.name}（攻击范围 ${Math.max(1, character.maxHp)}）`
}

registerSkillRuntime({
  id: QIEXIE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      /*
       * 随机用牌局自己的种子抽，抽完**立刻记进 resolution 的 data**。
       *
       * 不能等玩家回答时再抽一次：那样重连之后候选会变成另外五张，
       * 而玩家看到的是第一次那五张。
       */
      const sampled = sampleCharacters(host.state, host.rng, QIEXIE_SAMPLE)
      if (sampled.length === 0) return
      host.askSkill({
        skillId: QIEXIE, ownerId, step: 'pick',
        data: { sampled: sampled.map((character) => ({ id: character.id, name: character.name, maxHp: character.maxHp })) },
        build: (requestId): ChooseOptionsRequest => ({
          id: requestId, kind: 'choose-options',
          /*
           * **只发给他一个人**。玩家视图只带观看者自己的待回应请求，
           * 所以第三方连这五张是谁都读不到——没选中的那几张始终是暗信息。
           */
          playerId: ownerId,
          prompt: '【挈挟】：随机观看五张武将牌，选择任意张当武器牌置于装备区',
          timeoutMs: 30_000, optional: true,
          options: sampled.map((character) => ({ id: character.id, label: describeCharacter(character) })),
          min: 0, max: sampled.length,
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const sampled = (resolution.data.sampled as Array<{ id: string; name: string; maxHp: number }> | undefined) ?? []
    const chosen = (response.payload as { optionIds?: string[] }).optionIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || chosen.length === 0) return

    for (const characterId of chosen) {
      const character = sampled.find((candidate) => candidate.id === characterId)
      if (!character) continue
      const slot = freeWeaponSlot(host.state, ownerId)
      /*
       * 没有空的武器栏就装不下了。**不自动顶掉已有的武器**——
       * 那是玩家的牌，技能没说要替他扔掉。
       */
      if (!slot) break
      const cardId = createCharacterWeapon(host.state, character.id, character.name, character.maxHp)
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId: ownerId, slot })
      host.dispatch('SkillActivated', {
        skillId: QIEXIE, skillName: '挈挟', playerId: ownerId, cardIds: [cardId],
        logText: `${owner.nickname}将${character.name}当武器牌置于装备区（攻击范围 ${Math.max(1, character.maxHp)}）`,
      }, { sourceId: ownerId, cardIds: [cardId] })
    }
  },
})

/**
 * 找一个空的武器栏。
 *
 * 武将牌是凭空生成的，**必须放进一个空栏**：放进占着的栏会把玩家原来那把武器
 * 顶进弃牌堆，而技能没说要这么做。
 */
function freeWeaponSlot(state: SanguoshaState, playerId: PlayerId): EquipmentSlot | null {
  const player = playerOf(state, playerId)
  if (!player) return null
  return equipmentSlotsOf(state, playerId)
    .filter((slot) => slot === 'weapon' || slot === 'weapon2')
    .find((slot) => !player.zones.equipment[slot]) ?? null
}

// ─────────────────────────────── 摧决 ───────────────────────────────

/**
 * 现在能被摧决打到的角色：攻击范围内、距离最远、且本回合还没被摧决打过。
 *
 * **每次发动都重算**：上一次摧决可能弃掉了一匹马，攻击范围和距离都变了。
 */
function cuijueTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  const inRange = state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .filter((candidate) => canTarget(state, ownerId, candidate.id))
    .filter((candidate) => !owner.marks[cuijueHitMark(candidate.id)])
  if (inRange.length === 0) return []
  const distances = inRange.map((candidate) => getDistance(state, ownerId, candidate.id))
  const farthest = Math.max(...distances)
  // 并列最远的都是合法目标
  return inRange.filter((_, index) => distances[index] === farthest).map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: CUIJUE,
  triggers: [{
    /*
     * 「每名角色每回合限一次」是**回合作用域**的记账，回合一结束就清空。
     * 不清的话第二个回合他谁都打不了了。
     */
    event: 'TurnEnd',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      for (const key of Object.keys(owner.marks)) {
        if (key.startsWith(`${CUIJUE_HIT_MARK}:`)) delete owner.marks[key]
      }
    },
  }],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    /*
     * 这个阶段里已经点开又放弃过：不再报出来。
     *
     * 取消之后场面一点没变，同一条动作会原样重新出现——压测里那就是个
     * 无限循环。护栏的完整说明见 `docs/sanguosha-architecture.md`
     * 的「可取消主动技的活锁护栏」一节。
     */
    if (declinedThisPhase(state, ownerId, CUIJUE)) return []
    // 代价是弃一张自己的牌：手牌或装备区都行
    if (owner.zones.hand.length === 0 && Object.values(owner.zones.equipment).every((cardId) => !cardId)) return []
    if (cuijueTargets(state, ownerId).length === 0) return []
    return [{ id: CUIJUE, label: '发动【摧决】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== CUIJUE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || cuijueTargets(host.state, ownerId).length === 0) return
    const payable = [
      ...owner.zones.hand,
      ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => !!cardId),
    ]
    if (payable.length === 0) return
    host.askSkill({
      skillId: CUIJUE, ownerId, step: 'cost',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【摧决】：弃置一张牌',
        timeoutMs: 25_000, optional: true, purpose: 'skill',
        cardIds: payable, hiddenCardSlots: [],
        /*
         * **可取消的「恰好选 N 张」必须写成 `min: 0`。**
         *
         * `optional: true` 只是给界面看的；校验读的是 `min`，
         * 超时兜底（`timeout-default.ts`）读的也是 `min === 0`。
         * 写成 `min: 1` 的话，技能标着「可以取消」却交不上空数组，
         * 联机超时还会落到没有默认答案的分支。
         */
        min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      // 交空数组 = 放弃：一分代价都不收，但要留下放弃记号免得被反复点开
      if (!cardId) {
        markDeclinedThisPhase(host.state, ownerId, CUIJUE)
        return
      }
      if (!owner?.alive) return
      discardOwn(host, ownerId, cardId)
      /*
       * **弃完之后重新算目标**。
       *
       * 付出去的那张牌可能正是一匹马或一把武器，攻击范围和距离当场就变了——
       * 拿弃牌之前算好的目标去打，打的是一个已经不成立的局面。
       */
      const targets = cuijueTargets(host.state, ownerId)
      if (targets.length === 0) return
      if (targets.length === 1) {
        strike(host, ownerId, targets[0])
        return
      }
      host.askSkill({
        skillId: CUIJUE, ownerId, step: 'target',
        build: (requestId) => ({
          id: requestId, kind: 'choose-targets' as const, playerId: ownerId,
          prompt: '【摧决】：并列最远的角色里选一名',
          timeoutMs: 25_000, optional: false,
          candidateIds: targets, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    // 落地前再验一次：并列最远的集合在这中间仍可能变
    if (!targetId || !cuijueTargets(host.state, ownerId).includes(targetId)) return
    strike(host, ownerId, targetId)
  },
})

/** 弃掉自己的一张牌，手牌和装备区都支持。 */
function discardOwn(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  if (owner.zones.hand.includes(cardId)) {
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
  } else {
    const slot = equipmentSlotsOf(host.state, ownerId).find((candidate) => owner.zones.equipment[candidate] === cardId)
    if (!slot) return
    const character = isCharacterEquipment(host.state, cardId)
    moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
    // 武将牌变的装备离开装备区就销毁了，不会真的躺进弃牌堆
    if (!character) handleEquipmentLost(host as never, ownerId, cardId)
  }
  host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: CUIJUE }, { targetId: ownerId, cardIds: [cardId] })
}

function strike(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive) return
  /*
   * 「每名角色每回合限一次」记在**目标身上的标记**，不是一个「本回合发动过」的开关：
   * 打完 A 之后如果 B 仍是并列最远，同一个回合还可以再打 B。
   */
  owner.marks[cuijueHitMark(targetId)] = 1
  host.dispatch('SkillActivated', {
    skillId: CUIJUE, skillName: '摧决', playerId: ownerId, targetId,
    logText: `${owner.nickname}对${target.nickname}发动【摧决】`,
  }, { sourceId: ownerId, targetId })
  resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1 })
}



export const SHENDIANWEI: CharacterDefinition = {
  id: 'shendianwei',
  name: '神·典韦',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: JUANJIA,
      name: '捐甲',
      description: '锁定技，游戏开始时，你废除你的防具栏，然后获得一个额外的武器栏。',
    },
    {
      id: QIEXIE,
      name: '挈挟',
      description: '锁定技，准备阶段，你随机观看五张武将牌，然后你可以将其中任意张当武器牌置于你的装备区（攻击范围为该武将牌的体力上限）。',
    },
    {
      id: CUIJUE,
      name: '摧决',
      description: '出牌阶段，你可以弃置一张牌，然后对你攻击范围内距离你最远的一名其他角色造成1点伤害。每名角色每回合限一次。',
    },
  ],
}
