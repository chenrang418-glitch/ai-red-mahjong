import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { isLockedSkill } from '../../engine/locked-skills'
import { grantTurnSlashBonus, revokeTurnSlashBonus } from '../../engine/slash-rules'
import { drawCards } from '../../engine/draw'
import { loseMaxHp } from '../../engine/hp'
import { sampleSkills } from '../../engine/random-skill-pool'
import { grantSkill, ownedSkillIds, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import { skillIdsOf } from './standard'
import type { ChooseCardsRequest, ChooseOptionsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神孙权。
 *
 * 【驭衡】：锁定技，回合开始时，你可以弃置任意张花色互不相同的牌，
 *   然后随机获得等量个吴势力角色的技能；回合结束时，你失去这些技能并摸等量的牌。
 * 【帝力】：觉醒技，准备阶段，若你的技能数大于体力上限，你减 1 点体力上限，
 *   然后失去任意个其他技能，并按失去的个数依次获得【圣质】【权道】【持纲】。
 * 【圣质】：锁定技，你发动一个非锁定技后，本回合你使用的下一张牌无距离限制且无次数限制。
 * 【权道】：锁定技，你使用【杀】或普通锦囊牌时，你将手牌中这两类牌的数量弃至相同，然后摸一张牌。
 * 【持纲】：转换技，锁定技，阳：你的判定阶段改为摸牌阶段；阴：你的判定阶段改为出牌阶段。
 *
 * 四处最容易做错的：
 *
 * 1. **「任意张」包含零张。** 锁定技说的是「这件事一定发生」，不是
 *    「一定要弃牌」；逼玩家至少弃一张是另一个技能。
 * 2. **技能池要现算**。手写一个技能名数组，第二天就和武将表脱节了。
 * 3. **圣质武装的是「下一张牌」**，不是「本回合所有牌」，而且那张牌
 *    哪怕最后没打出效果，也算用掉了这一次。
 * 4. **持纲是把判定阶段「改成」摸牌/出牌阶段**，不是额外多一个阶段，
 *    也不是在判定阶段里偷偷摸两张牌——判定阶段本身不执行。
 */

const YUHENG = 'yuheng'
const DILI = 'dili'
const SHENGZHI = 'shengzhi'
const QUANDAO = 'quandao'
const CHIGANG = 'chigang'

/** 驭衡授予的技能挂在这个来源下，一次一整批。 */
const YUHENG_SOURCE = 'yuheng'
/** 本次驭衡实际拿到了几个技能，回合结束按它摸牌。 */
const YUHENG_COUNT_MARK = 'yuheng-count'
/** 圣质已经武装、还没被用掉。 */
const SHENGZHI_ARMED_MARK = 'shengzhi-armed'
/** 帝力按顺序给出的三个衍生技能。 */
const DILI_REWARDS = [SHENGZHI, QUANDAO, CHIGANG] as const

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 驭衡 ───────────────────────────────

/**
 * 这些牌的花色互不相同吗。
 *
 * **没有花色的牌不算数**：虚拟牌和武将牌变的装备都没有花色，
 * 拿它们去凑「四种花色」等于凭空多一张。
 */
function suitsAllDistinct(state: SanguoshaState, cardIds: readonly CardId[]): boolean {
  const suits = new Set<string>()
  for (const cardId of cardIds) {
    const card = state.cards[cardId]
    if (!card || card.virtual) return false
    if (suits.has(card.suit)) return false
    suits.add(card.suit)
  }
  return true
}

registerSkillRuntime({
  id: YUHENG,
  triggers: [{
    event: 'TurnStart',
    handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      /*
       * **排队问，不在时机里当场问。**
       *
       * 回合开始这个时机上挂着好几个技能，它们是在同一次派发里依次跑完的：
       * 当场挂一条请求之后，后面那些技能照样继续跑，其中任何一个都可能
       * 把他打死——于是牌桌上留下一条发给死人的请求，
       * 「Request 响应玩家非法」（压测 seed=balance-5-117 抓到）。
       * 技能队列会等这一批时机走完、桌面干净、而且他还活着，才放出来。
       */
      host.queueSkill({ skillId: YUHENG, ownerId, step: 'discard', data: {} })
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      const count = owner.marks[YUHENG_COUNT_MARK] ?? 0
      // 先收技能再摸牌：顺序反过来的话，摸牌时那些技能还在，会误触发
      replaceYuhengBatch(host, ownerId, [])
      delete owner.marks[YUHENG_COUNT_MARK]
      if (count <= 0 || !owner.alive) return
      /*
       * 摸的张数按**本次实际获得的技能个数**算，记在标记里。
       *
       * 不去数「现在还剩几个临时技能」：中途被别的效果换掉或压制掉的那些
       * 仍然算他这次获得过，少摸一张是错的。
       */
      host.dispatch('SkillActivated', {
        skillId: YUHENG, skillName: '驭衡', playerId: ownerId,
        logText: `${owner.nickname}失去【驭衡】获得的 ${count} 个技能，摸 ${count} 张牌`,
      }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: YUHENG, ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【驭衡】：弃置任意张花色互不相同的牌（可以一张都不弃）',
        timeoutMs: 30_000,
        // 「任意张」包含零张：锁定技管的是「这件事发生」，不是「必须弃牌」
        optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [],
        min: 0, max: Math.min(4, owner.zones.hand.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (cardIds.length === 0) return
    // 花色必须互不相同；不合法就当作一张都没弃，不替玩家挑一个子集
    if (!suitsAllDistinct(host.state, cardIds)) return
    if (!cardIds.every((cardId) => owner.zones.hand.includes(cardId))) return

    for (const cardId of cardIds) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    }
    host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: YUHENG }, { targetId: ownerId, cardIds })

    const owned = ownedSkillIds(host.state, ownerId, skillIdsOf)
    const picked = sampleSkills(host.rng, 'wu', cardIds.length, owned)
    if (picked.length === 0) return
    replaceYuhengBatch(host, ownerId, picked.map((skill) => skill.id))
    owner.marks[YUHENG_COUNT_MARK] = picked.length
    host.dispatch('SkillActivated', {
      skillId: YUHENG, skillName: '驭衡', playerId: ownerId, cardIds,
      logText: `${owner.nickname}弃置 ${cardIds.length} 张不同花色的牌，随机获得：${picked.map((skill) => skill.name).join('、')}`,
    }, { sourceId: ownerId, cardIds })
  },
})

/**
 * 把这一整批临时技能原子地换掉。
 *
 * `replaceTemporarySkill` 一次只换一个技能，而驭衡给的是**一批**：
 * 逐个调用会把前一个覆盖掉，最后只剩一个。所以这里直接按来源整批替换。
 */
function replaceYuhengBatch(host: SkillHost, ownerId: PlayerId, skillIds: readonly string[]): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  owner.temporaryGrantedSkills ??= []
  const removed = new Set(owner.temporaryGrantedSkills
    .filter((entry) => entry.source === YUHENG_SOURCE)
    .map((entry) => entry.skillId))
  owner.temporaryGrantedSkills = owner.temporaryGrantedSkills.filter((entry) => entry.source !== YUHENG_SOURCE)
  if (removed.size > 0) {
    // 已经排队但还没问出去的那些，随技能一起收走
    host.state.skillQueue = host.state.skillQueue.filter((prompt) => prompt.ownerId !== ownerId || !removed.has(prompt.skillId))
  }
  for (const skillId of skillIds) owner.temporaryGrantedSkills.push({ source: YUHENG_SOURCE, skillId })
}

// ─────────────────────────────── 帝力 ───────────────────────────────

/**
 * 觉醒条件里数的是**武将技能**：自己的、被授予的、临时获得的都算，
 * 装备借来的不算——那是装备的能力，不是他的。
 */
function skillCountOf(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner) return 0
  const own = skillIdsOf(owner.characterId ?? '')
  const granted = owner.grantedSkills ?? []
  const temporary = (owner.temporaryGrantedSkills ?? []).map((entry) => entry.skillId)
  return new Set([...own, ...granted, ...temporary]).size
}

/** 帝力可以失去哪些技能：他现在拥有的、除帝力本身之外的武将技能。 */
function sacrificeCandidates(state: SanguoshaState, ownerId: PlayerId): string[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const own = skillIdsOf(owner.characterId ?? '')
  const granted = owner.grantedSkills ?? []
  const temporary = (owner.temporaryGrantedSkills ?? []).map((entry) => entry.skillId)
  return [...new Set([...own, ...granted, ...temporary])].filter((skillId) => skillId !== DILI)
}

registerSkillRuntime({
  id: DILI,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      if (!owner?.alive) return false
      // **严格大于**体力上限
      return skillCountOf(state, ownerId) > owner.maxHp
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      loseMaxHp(host as never, ownerId, 1, DILI)
      if (sacrificeCandidates(host.state, ownerId).length === 0) return
      /*
       * 选失去哪些技能这一步**排队问**。
       *
       * 觉醒是在准备阶段结算的，而【驭衡】在回合开始时就已经挂了一条发问——
       * 当场再挂一条会直接撞上「已有技能正在等待回应」。
       */
      host.queueSkill({ skillId: DILI, ownerId, step: 'sacrifice', data: {} })
    },
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'sacrifice') return
    const candidates = sacrificeCandidates(host.state, ownerId)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: DILI, ownerId, step: 'sacrifice',
      build: (requestId): ChooseOptionsRequest => ({
        id: requestId, kind: 'choose-options', playerId: ownerId,
        prompt: '【帝力】：失去任意个其他技能，按失去的个数依次获得【圣质】【权道】【持纲】',
        timeoutMs: 30_000, optional: true,
        options: candidates.map((skillId) => ({ id: skillId, label: skillDisplayLabel(skillId) })),
        min: 0, max: candidates.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'sacrifice') return
    const chosen = (response.payload as { optionIds?: string[] }).optionIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const valid = chosen.filter((skillId) => sacrificeCandidates(host.state, ownerId).includes(skillId))
    for (const skillId of valid) loseSkill(host, ownerId, skillId)
    /*
     * 失去几个就按顺序拿前几个：1 个拿【圣质】，2 个拿【圣质】【权道】，
     * 3 个及以上三个全拿。**不是随便挑三个里的几个**。
     */
    const rewards = DILI_REWARDS.slice(0, Math.min(valid.length, DILI_REWARDS.length))
    for (const skillId of rewards) grantSkill(host.state, ownerId, skillId)
    host.dispatch('SkillActivated', {
      skillId: DILI, skillName: '帝力', playerId: ownerId,
      logText: `${owner.nickname}失去 ${valid.length} 个技能，获得：${rewards.length > 0 ? rewards.map(skillDisplayLabel).join('、') : '（无）'}`,
    }, { sourceId: ownerId })
  },
})

/** 技能的显示名，只用于面板和战报。 */
function skillDisplayLabel(skillId: string): string {
  const names: Record<string, string> = {
    [YUHENG]: '驭衡', [DILI]: '帝力', [SHENGZHI]: '圣质', [QUANDAO]: '权道', [CHIGANG]: '持纲',
  }
  return names[skillId] ?? skillId
}

/** 让他失去一个技能，自己的 / 被授予的 / 临时的都能失去。 */
function loseSkill(host: SkillHost, ownerId: PlayerId, skillId: string): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  owner.grantedSkills = (owner.grantedSkills ?? []).filter((candidate) => candidate !== skillId)
  owner.temporaryGrantedSkills = (owner.temporaryGrantedSkills ?? []).filter((entry) => entry.skillId !== skillId)
  /*
   * 武将牌上自带的技能靠**压制**来「失去」：`skillIdsOf` 读的是武将定义，
   * 那是模块级共享常量，改它会让全进程的同名武将一起变。
   */
  host.state.skillSuppressions ??= []
  host.state.skillSuppressions.push({
    targetId: ownerId, skillId, sourceId: ownerId, sourceSkillId: DILI,
    // 永久失效：给一个永远不会到期的回合号
    armedAtTurn: Number.MAX_SAFE_INTEGER,
  })
}

// ─────────────────────────────── 圣质 ───────────────────────────────

registerSkillRuntime({
  id: SHENGZHI,
  triggers: [{
    /*
     * 「发动一个非锁定技后」——锁定技不算。
     *
     * 判断走 `isLockedSkill` 这个统一口径，不列技能名单：
     * 名单第二天就会漏掉新技能。
     */
    event: 'SkillActivated',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { skillId?: string; playerId?: PlayerId }
      if (payload.playerId !== ownerId || !payload.skillId) return
      if (payload.skillId === SHENGZHI) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (isLockedSkill(payload.skillId)) return
      /*
       * **只武装一次**：还没用掉之前再发动一个非锁定技，不会叠成两次。
       * 叠层是另一种效果，这个技能说的是「下一张牌」。
       */
      if (owner.marks[SHENGZHI_ARMED_MARK]) return
      owner.marks[SHENGZHI_ARMED_MARK] = 1
      // 「无次数限制」走公共的本回合出杀规则，不另造一套计数
      grantTurnSlashBonus(host.state, ownerId, { extraUses: 1 })
      host.dispatch('SkillActivated', {
        skillId: SHENGZHI, skillName: '圣质', playerId: ownerId,
        logText: `${owner.nickname}的下一张牌无距离限制且无次数限制`,
      }, { sourceId: ownerId })
    },
  }, {
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if ((context.event.sourceId ?? '') !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      /*
       * 用掉了就消耗。**哪怕这张牌最后没造成任何效果**——
       * 技能说的是「下一张使用的牌」，用了就是用了。
       */
      if (!owner.marks[SHENGZHI_ARMED_MARK]) return
      delete owner.marks[SHENGZHI_ARMED_MARK]
      revokeTurnSlashBonus(host.state, ownerId, { extraUses: 1 })
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId) {
      // 「本回合」的效果，回合一结束就作废；出杀加成由公共清理统一抹掉
      const owner = playerOf(host.state, ownerId)
      if (owner) delete owner.marks[SHENGZHI_ARMED_MARK]
    },
  }],
  slashIgnoresDistance(state, ownerId) {
    return !!playerOf(state, ownerId)?.marks[SHENGZHI_ARMED_MARK]
  },
  ignoresTrickDistance(state, ownerId) {
    return !!playerOf(state, ownerId)?.marks[SHENGZHI_ARMED_MARK]
  },
})

// ─────────────────────────────── 权道 ───────────────────────────────

/** 手牌里的【杀】。看的是**有效牌名**，转化技把别的牌当杀时不算在手牌里。 */
function handSlashes(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return owner.zones.hand.filter((cardId) => state.cards[cardId]?.name === '杀')
}

/** 手牌里的普通锦囊（延时锦囊不算）。 */
function handTricks(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return owner.zones.hand.filter((cardId) => {
    const card = state.cards[cardId]
    return card?.category === 'trick' && !DELAYED_TRICKS.has(card.name)
  })
}

const DELAYED_TRICKS = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

registerSkillRuntime({
  id: QUANDAO,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if ((context.event.sourceId ?? '') !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const cardName = payload.cardName ?? ''
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      const isTrick = cardName !== '' && card?.category === 'trick' && !DELAYED_TRICKS.has(cardName)
      if (cardName !== '杀' && !isTrick) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      /*
       * 排队问，不当场问：这张牌还在结算里，当场挂一个弃牌请求会和
       * 它自己的目标询问抢同一个玩家。
       */
      host.queueSkill({ skillId: QUANDAO, ownerId, step: 'balance', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'balance') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const slashes = handSlashes(host.state, ownerId)
    const tricks = handTricks(host.state, ownerId)
    const surplus = Math.abs(slashes.length - tricks.length)
    /*
     * 数的是**当前手牌**：正在使用的那张已经离开手牌进了处理区，不再计入。
     * 两类一样多时弃 0 张，但**仍然摸一张**。
     */
    if (surplus === 0) {
      finishQuandao(host, ownerId)
      return
    }
    const pool = slashes.length > tricks.length ? slashes : tricks
    host.askSkill({
      skillId: QUANDAO, ownerId, step: 'balance',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【权道】：弃置 ${surplus} 张${slashes.length > tricks.length ? '【杀】' : '普通锦囊牌'}`,
        timeoutMs: 25_000, optional: false, purpose: 'skill',
        // 弃哪几张由他自己挑，不是随机弃
        cardIds: pool, hiddenCardSlots: [],
        min: surplus, max: surplus,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'balance') return
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const valid = cardIds.filter((cardId) => owner.zones.hand.includes(cardId))
    for (const cardId of valid) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    }
    if (valid.length > 0) {
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: QUANDAO }, { targetId: ownerId, cardIds: valid })
    }
    finishQuandao(host, ownerId)
  },
})

function finishQuandao(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  host.dispatch('SkillActivated', {
    skillId: QUANDAO, skillName: '权道', playerId: ownerId,
    logText: `${owner.nickname}发动【权道】，摸一张牌`,
  }, { sourceId: ownerId })
  drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
}

// ─────────────────────────────── 持纲 ───────────────────────────────

registerSkillRuntime({
  id: CHIGANG,
  replacesPhase(state, ownerId, slot): TurnPhase | null {
    if (slot !== 'judge') return null
    if (state.currentPlayerId !== ownerId) return null
    if (!playerOf(state, ownerId)?.alive) return null
    // 阳：判定阶段改为摸牌阶段；阴：改为出牌阶段
    return conversionStateOf(state, ownerId, CHIGANG) === 'yang' ? 'draw' : 'play'
  },
  triggers: [{
    /*
     * 换上来的那个阶段真正开始之后才切换阴阳。
     *
     * 转换技的规矩是「成功发动之后切换」，不是发问之前，
     * 也不是按回合数推导——判定位被跳过时这一次就不该切。
     */
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId) return
      if (host.state.phaseReplacedFrom !== 'judge') return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      const before = conversionStateOf(host.state, ownerId, CHIGANG)
      toggleConversionState(host.state, ownerId, CHIGANG)
      host.dispatch('SkillActivated', {
        skillId: CHIGANG, skillName: '持纲', playerId: ownerId,
        logText: `${owner.nickname}发动【持纲】（${before === 'yang' ? '阳' : '阴'}）：判定阶段改为${payload.phase === 'draw' ? '摸牌' : '出牌'}阶段`,
      }, { sourceId: ownerId })
    },
  }],
})

export const SHENSUNQUAN: CharacterDefinition = {
  id: 'shensunquan',
  name: '神·孙权',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: YUHENG,
      name: '驭衡',
      description: '锁定技，你的回合开始时，你可以弃置任意张花色互不相同的牌，然后随机获得等量个吴势力角色的技能；你的回合结束时，你失去以此法获得的技能，然后摸等量的牌。',
    },
    {
      id: DILI,
      name: '帝力',
      description: '觉醒技，准备阶段，若你的技能数大于你的体力上限，你减1点体力上限，然后失去任意个其他技能，并依次获得【圣质】【权道】【持纲】中的前X个（X为你失去的技能数）。',
    },
    {
      id: SHENGZHI,
      name: '圣质',
      description: '锁定技，你发动一个非锁定技后，本回合你使用的下一张牌无距离限制且无次数限制。',
      granted: true,
    },
    {
      id: QUANDAO,
      name: '权道',
      description: '锁定技，你使用【杀】或普通锦囊牌时，你将手牌中【杀】与普通锦囊牌的数量弃置至相同，然后摸一张牌。',
      granted: true,
    },
    {
      id: CHIGANG,
      name: '持纲',
      description: '转换技，锁定技，阳：你的判定阶段改为摸牌阶段；阴：你的判定阶段改为出牌阶段。',
      granted: true,
    },
  ],
}
