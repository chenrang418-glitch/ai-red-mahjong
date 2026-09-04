import { findLegalAction, type LegalAction } from '../actions'
import { resolveDamage } from '../damage'
import { canTarget, getDistance } from '../distance'
import type { ChooseCardsRequest, GameResponse, RespondCardRequest } from '../requests'
import { validateResponse } from '../requests'
import { dodgeViewAsOptions, ignoresTrickDistance, responseViewAsOptions, skillIdsOf } from '../../data/characters/standard'
import { effectiveCardColor, getSkillRuntime, isCardUseProhibited, isTargetProhibited, skillsOf, trickDistanceBonusOf } from '../skills/runtime'
import { performJudgment, registerJudgmentContinuation } from '../judgment'
import { advanceGamePhase } from '../phase'
import { recover } from '../recover'
import type { CardId, PlayerId, SanguoshaState, SlashResolutionState } from '../types'
import { effectiveCardName, locateOwnedCard, moveCard, setCardAlias } from '../zones'
import { BAGUA_ACTION_ID, canInvokeBagua, handleEquipmentLost, hasUnlimitedSlash, isCardIneffective } from '../equipment'
import { canUseSlash, slashRules, slashTargetLimit } from '../slash-rules'
import { PASS_ROUND_ACTION } from '../nullification'
import { GUHUO_RESPOND_ACTION, canGuhuoRespond, guhuoGrantedAs } from '../guhuo-response'
import { RENNAI_ACTION, RENNAI_SKILL, canRennai } from '../rennai'
import { usedThisTurn } from '../turn-usage'
import { equipmentPlayActions, provideSlashLookup, provideSkillLookup, askCixiongSword, askSlashTransfer, askTieji, askDodgedSlashWeapon, askMengjin, askPreDamageWeapon, provideEquipmentCallbacks, queueQilingong, type DodgedSlashFacts } from '../equipment-requests'
import { skillDisplayName } from '../presentation'
import type { CardEngineHost } from './host'
import { beginPhysicalCard, finishPhysicalCard, playerOf, playerOf as player, useAction } from './host'
import {
  INSTANT_TRICKS,
  askNullification,
  beginInstantTrick,
  instantTrickActions,
  resolveTrickEffectResponse,
  resolveTrickPickResponse,
  resumeTrickResolution,
  resumeTrickTarget,
} from './tricks'

export type { CardEngineHost }

const DELAYED_TRICKS = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

/** 出牌阶段这名玩家能做的所有牌面转化。 */
function viewAsPlayOptions(state: SanguoshaState, playerId: PlayerId) {
  return skillsOf(state, playerId, skillIdsOf).flatMap((runtime) => runtime.viewAs?.(state, playerId) ?? [])
}

function hasDelayedTrick(state: SanguoshaState, playerId: PlayerId, name: string): boolean {
  return player(state, playerId).zones.judgingArea.some((cardId) => effectiveCardName(state, cardId) === name)
}

function canPlaceDelayedTrick(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId, name: string, cardId: CardId): boolean {
  const target = player(state, targetId)
  if (!target.alive) return false
  if (name === '闪电') return targetId === sourceId && !hasDelayedTrick(state, targetId, name)
  if (targetId === sourceId || hasDelayedTrick(state, targetId, name)) return false
  if (isTargetProhibited(state, sourceId, targetId, name, skillIdsOf, cardId)) return false
  if (name !== '兵粮寸断') return true
  if (ignoresTrickDistance(state, sourceId)) return true
  return getDistance(state, sourceId, targetId) <= 1 + trickDistanceBonusOf(state, sourceId, targetId, name, skillIdsOf)
}

/** 只从当前公开规则状态生成操作；客户端不自行推断距离或卡牌用途。 */
export function legalPlayActions(state: SanguoshaState, playerId: PlayerId): LegalAction[] {
  if (state.status !== 'playing' || state.phase !== 'play' || state.currentPlayerId !== playerId || state.pendingRequests.length > 0 || state.cardResolution) return []
  const source = player(state, playerId)
  if (!source.alive) return []
  const actions: LegalAction[] = [{ id: 'play:pass', kind: 'pass', playerId, label: '结束出牌', requestId: `play-${state.turnNumber}` }]
  const allCardUseBlocked = isCardUseProhibited(state, playerId, '', { dyingPlayerId: null }, skillIdsOf)

  // 主动技（苦肉等）：技能自己报告现在能不能发动，前端不猜
  for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
    if (allCardUseBlocked && runtime.activeActionUsesCard) continue
    for (const option of runtime.activeActions?.(state, playerId) ?? []) {
      actions.push({ id: option.id, kind: 'invoke-skill', playerId, label: option.label, skillId: runtime.id, cardIds: [], targetIds: [] })
    }
  }

  // 主公技授权（黄天）：动作出现在**别人**的出牌阶段，所以要扫全场的技能，
  // 而不只是当前玩家自己的。技能 id 记在动作上，执行时才知道回调谁。
  for (const other of state.players) {
    if (!other.alive || other.id === playerId) continue
    for (const runtime of skillsOf(state, other.id, skillIdsOf)) {
      for (const option of runtime.grantsPlayActions?.(state, other.id, playerId) ?? []) {
        actions.push({ id: option.id, kind: 'invoke-skill', playerId, label: option.label, skillId: runtime.id, cardIds: [], targetIds: [] })
      }
    }
  }

  // 转化技（武圣、龙胆）：把「这张红牌当杀打某人」作为独立动作发出去。
  // 不能让前端自己猜牌的用途——同一张红牌既可以原样用，也可以当杀，
  // 必须两条动作都在，玩家才选得到用途。
  for (const option of viewAsPlayOptions(state, playerId)) {
    actions.push(...declaredCardActions(state, playerId, option.cardId, option.asCardName, option.label))
  }

  // 丈八蛇矛和方天画戟都会产生大量组合（6 张手牌 × 4 个目标就是 60 条动作，
  // 界面上选中一张牌会冒出 20 个按钮，手机上根本没法用）。
  // 改成和主动技一样的两步交互：一个按钮，然后选牌、选目标。
  if (!allCardUseBlocked) {
    for (const option of equipmentPlayActions(state, playerId)) {
      actions.push({ id: option.id, kind: 'invoke-skill', playerId, label: option.label, skillId: option.skillId, cardIds: [], targetIds: [] })
    }
  }

  for (const cardId of source.zones.hand) {
    const card = state.cards[cardId]
    if (!card) continue
    if (card.name === '杀' && canUseSlash(state, playerId, hasUnlimitedSlash(state, playerId))) {
      for (const combo of slashTargetCombos(state, playerId)) {
        const names = combo.map((id) => state.players.find((candidate) => candidate.id === id)!.nickname).join('、')
        actions.push({
          ...useAction(cardId, playerId, '杀', combo, `对${names}使用【杀】`),
          // 多目标那条要有自己的 id，否则和单目标那条撞在一起
          id: combo.length > 1 ? `play:${cardId}:${combo.join(',')}` : `play:${cardId}:${combo[0]}`,
        })
      }
    } else if (card.name === '桃' && source.hp < source.maxHp) {
      actions.push(useAction(cardId, playerId, '桃', [playerId], '使用【桃】回复体力'))
    } else if (card.name === '酒' && state.turnUsage.wineUses < 1) {
      actions.push(useAction(cardId, playerId, '酒', [playerId], '使用【酒】强化下一张杀'))
    } else if (card.category === 'equipment' && card.equipmentSlot) {
      actions.push(useAction(cardId, playerId, card.name, [playerId], `装备【${card.name}】`))
    } else if (INSTANT_TRICKS.has(card.name)) {
      actions.push(...instantTrickActions(state, playerId, cardId))
    } else if (card.name === '乐不思蜀') {
      for (const target of state.players.filter((candidate) => canPlaceDelayedTrick(state, playerId, candidate.id, card.name, cardId))) {
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【乐不思蜀】`))
      }
    } else if (card.name === '兵粮寸断') {
      for (const target of state.players.filter((candidate) => canPlaceDelayedTrick(state, playerId, candidate.id, card.name, cardId))) {
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【兵粮寸断】`))
      }
    } else if (card.name === '闪电' && canPlaceDelayedTrick(state, playerId, playerId, card.name, cardId)) {
      actions.push(useAction(cardId, playerId, card.name, [playerId], '将【闪电】置入自己的判定区'))
    }
  }
  return actions.filter((action) => action.kind !== 'use-card'
    || !isCardUseProhibited(state, playerId, action.asCardName, { dyingPlayerId: null }, skillIdsOf))
}

/**
 * 「把某张牌当作另一张牌用」能产生哪些合法动作。
 *
 * 转化技（武圣、龙胆、奇袭、国色）和于吉【蛊惑】的声明牌**共用这一份合法性**：
 * 出杀次数、攻击范围、距离、禁止目标、同名延时锦囊不能叠……全在这里算一次。
 * 蛊惑解决的是「实体牌和声明牌不一致」，不是绕开牌规则，所以它必须走这里。
 *
 * 返回空数组就表示「现在不能这样用」——调用方据此把这个声明从候选里去掉。
 */
export function declaredCardActions(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId: CardId,
  asCardName: string,
  label: string,
): LegalAction[] {
  const actions: LegalAction[] = []
  if (asCardName === '杀') {
    // 转化出来的杀同样受本回合的临时规则约束：天义失败时武圣、龙胆、蛊惑
    // 一律用不出杀，不能只把手牌那条藏起来
    if (!canUseSlash(state, playerId, hasUnlimitedSlash(state, playerId))) return actions
    for (const combo of slashTargetCombos(state, playerId)) {
      const names = combo.map((id) => state.players.find((candidate) => candidate.id === id)!.nickname).join('、')
      actions.push({
        ...useAction(cardId, playerId, '杀', combo, `${label}，目标${names}`),
        id: `play:viewas:${cardId}:${combo.join(',')}`,
      })
    }
    return actions
  }
  // 转化成延时锦囊（大乔【国色】）：放进目标判定区，判定时按转化后的牌名结算
  if (DELAYED_TRICKS.has(asCardName)) {
    for (const target of state.players) {
      if (!canPlaceDelayedTrick(state, playerId, target.id, asCardName, cardId)) continue
      actions.push({
        ...useAction(cardId, playerId, asCardName, [target.id], `${label}，目标${target.nickname}`),
        id: `play:viewas:${cardId}:${target.id}`,
      })
    }
    return actions
  }
  // 转化成普通锦囊（甘宁【奇袭】）：目标合法性按转化后的牌名算。
  // 之前这里只处理【杀】，于是奇袭虽然注册了却永远产生不出动作——
  // 「服务端支持不等于前端点得到」，这种情况下连服务端都没支持。
  if (INSTANT_TRICKS.has(asCardName)) {
    for (const trick of instantTrickActions(state, playerId, cardId, asCardName)) {
      if (trick.kind !== 'use-card') continue
      actions.push({
        ...trick,
        // 【连环】转化出的铁索仍要保留“重铸”动作前缀；执行层和 AI 都用
        // 这个前缀区分“使用锦囊”和“弃牌摸一张”，不能统一改成 viewas。
        id: trick.id.startsWith('play:recast:')
          ? `play:recast:viewas:${cardId}`
          : `play:viewas:${cardId}:${trick.targetIds.join(',') || 'self'}`,
        label: `${label}，${trick.label}`,
      })
    }
    return actions
  }
  // 基本牌里只有【桃】【酒】能对自己用；【闪】在出牌阶段用不了
  const owner = player(state, playerId)
  if (asCardName === '桃' && owner.hp < owner.maxHp) {
    actions.push(useAction(cardId, playerId, '桃', [playerId], `${label}，回复体力`))
  } else if (asCardName === '酒' && state.turnUsage.wineUses < 1) {
    actions.push(useAction(cardId, playerId, '酒', [playerId], `${label}，强化下一张杀`))
  }
  return actions
}

/**
 * 这张【杀】可以指定哪些目标组合。
 *
 * 正常是每个合法目标一条单目标动作；本回合有「多指定 N 个目标」时
 * （太史慈【天义】）再补上多目标的组合。逐目标的规则（藤甲、流离、无双、
 * 铁骑、烈弓）仍然由 SlashResolution 一个个走，这里只负责列出组合。
 *
 * 只生成到 `slashTargetLimit` 为止，且**不做全排列**：多目标是少数情况，
 * 组合数按人数是 C(n,2)，5~8 人局最多二十来条，够用又不会把动作表撑爆。
 */
function slashTargetCombos(state: SanguoshaState, playerId: PlayerId): PlayerId[][] {
  const rules = slashRules(state, playerId)
  const skillIgnoreDistance = skillsOf(state, playerId, skillIdsOf)
    .some((runtime) => runtime.slashIgnoresDistance?.(state, playerId) ?? false)
  const legal = state.players
    .filter((target) => {
      if (isTargetProhibited(state, playerId, target.id, '杀', skillIdsOf)) return false
      // 无距离限制时只剩「不是自己、还活着」两条
      if (rules.ignoreDistance || skillIgnoreDistance) return target.alive && target.id !== playerId
      return canTarget(state, playerId, target.id)
    })
    .map((target) => target.id)

  const combos: PlayerId[][] = legal.map((id) => [id])
  const limit = slashTargetLimit(state, playerId)
  if (limit < 2) return combos
  for (let first = 0; first < legal.length; first += 1) {
    for (let second = first + 1; second < legal.length; second += 1) {
      combos.push([legal[first], legal[second]])
    }
  }
  return combos
}

function recordPlayDecision(host: CardEngineHost, playerId: PlayerId, actionId: string): void {
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: `play-${host.state.turnNumber}`,
    playerId,
    kind: 'play-action',
    payload: { actionId },
  })
}

function beginSlash(
  host: CardEngineHost,
  action: Extract<LegalAction, { kind: 'use-card' }>,
  options: { countUsage?: boolean; consumeWine?: boolean } = {},
): void {
  const [cardId, ...extraCardIds] = action.cardIds
  let targetIds = [...action.targetIds]
  const candidateIds = host.state.players
    .filter((target) => target.alive && target.id !== action.playerId && !targetIds.includes(target.id)
      && !isTargetProhibited(host.state, action.playerId, target.id, '杀', skillIdsOf, cardId))
    .map((target) => target.id)
  for (const runtime of skillsOf(host.state, action.playerId, skillIdsOf)) {
    targetIds = runtime.modifySlashTargets?.(host, action.playerId, targetIds, candidateIds) ?? targetIds
  }
  const [targetId, ...remainingTargetIds] = targetIds
  const card = host.state.cards[cardId]
  if (!beginActionPhysicalCard(host, action.playerId, cardId, targetIds, '杀')) return
  // 丈八蛇矛：第二张牌和主牌一起进处理区，结算结束时一起弃掉
  for (const extra of extraCardIds) {
    moveCard(host.state, extra, { kind: 'hand', playerId: action.playerId }, { kind: 'processingArea' })
  }
  const countUsage = options.countUsage ?? true
  const consumeWine = options.consumeWine ?? true
  const damageAmount = 1 + (consumeWine ? host.state.turnUsage.wineDamageBonus : 0)
  if (countUsage) host.state.turnUsage.slashUses += 1
  if (consumeWine) host.state.turnUsage.wineDamageBonus = 0
  host.state.cardResolution = {
    kind: 'slash', cardId, sourceId: action.playerId, targetId,
    damageNature: card.damageNature ?? 'normal', damageAmount,
    stage: 'awaiting-dodge', requestId: null, surrogate: null, interceptsDone: [], extraCardIds,
    remainingTargetIds: [...remainingTargetIds],
    dodgeRemaining: slashDodgeRequirement(host, action.playerId, targetId),
  }
  enterSlashTarget(host)
}

/**
 * 支持转化技从装备区和武将专属牌堆使用牌，并保证装备离场时机只走一次。
 *
 * 专属牌堆是邓艾【急袭】要的：把一张「田」当【顺手牵羊】用，底牌就是那张
 * 真实的田。**不能先把田挪回手牌再使用**——那会多出一次 GainCard、
 * 让手牌数在界面上闪一下，还会被「获得牌后」的技能误触发。
 */
function beginActionPhysicalCard(host: CardEngineHost, playerId: PlayerId, cardId: CardId, targetIds: PlayerId[], cardName: string): boolean {
  const from = locateOwnedCard(host.state, playerId, cardId, { includeCharacterPiles: true })
  if (!from || from.kind === 'judgingArea') throw new Error('卡牌不属于出牌玩家的手牌区、装备区或专属牌堆')
  const started = beginPhysicalCard(host, playerId, cardId, targetIds, cardName, from)
  if (from.kind === 'equipment') handleEquipmentLost(host, playerId, cardId)
  return started
}

/**
 * 技能生成的【杀】共用正常【杀】管线，但不消耗距离、次数或酒增伤。
 *
 * 不给 `cardId` 时造一张临时牌，结算结束由 finishPhysicalCard 销毁；
 * 给了 `cardId` 就用这张**实体手牌**——牛来【麻麻】的「跟上」要求真的花掉
 * 一张【杀】，实体牌上的花色和属性（火杀、雷杀）也要照常生效，
 * 所以不能改成「弃掉实体牌再放一张虚拟杀」。
 */
export function beginVirtualSlash(
  host: CardEngineHost,
  options: {
    sourceId: PlayerId
    targetId: PlayerId
    sourceSkillId: string
    nature?: 'normal' | 'fire' | 'thunder'
    /** 用作载体的实体手牌；不传则生成临时牌 */
    cardId?: CardId
  },
): void {
  if (host.state.cardResolution) throw new Error('已有卡牌正在结算')
  const source = player(host.state, options.sourceId)
  const target = player(host.state, options.targetId)
  if (!source.alive || !target.alive || source.id === target.id) throw new Error('虚拟杀目标非法')
  if (options.cardId) {
    if (!source.zones.hand.includes(options.cardId)) throw new Error('作为载体的【杀】不在手牌里')
    /*
     * 看**有效牌名**而不是印刷名。
     *
     * 关羽【武圣】把一张红牌当【杀】用时，实体牌印的仍然是别的名字；
     * 只认印刷名的话，这类转化杀就永远走不进技能发起的【杀】管线
     * （贾诩【乱武】逼人出杀时就会漏掉他们）。调用方把别名设好，
     * 这里按统一口径确认它现在确实是一张【杀】。
     */
    if (effectiveCardName(host.state, options.cardId) !== '杀') throw new Error('作为载体的牌不是【杀】')
    const realAction = useAction(options.cardId, source.id, '杀', [target.id], `对${target.nickname}使用【杀】`)
    if (realAction.kind !== 'use-card') throw new Error('技能杀动作构造失败')
    beginSlash(host, realAction, { countUsage: false, consumeWine: false })
    return
  }
  const cardId = `virtual:${options.sourceSkillId}:${host.state.seq + 1}:${host.state.decisions.length}`
  host.state.cards[cardId] = {
    id: cardId,
    ruleset: host.state.rulesetVersion,
    expansion: 'standard',
    name: '杀',
    // 虚拟牌没有真实花色；字段仅满足统一牌对象结构，规则判断必须查看 virtual。
    suit: 'spade',
    rank: 1,
    color: 'black',
    category: 'basic',
    damageNature: options.nature ?? 'normal',
    virtual: true,
    sourceSkillId: options.sourceSkillId,
  }
  source.zones.hand.push(cardId)
  const action = useAction(cardId, source.id, '杀', [target.id], `对${target.nickname}使用虚拟【杀】`)
  if (action.kind !== 'use-card') throw new Error('虚拟杀动作构造失败')
  beginSlash(host, action, { countUsage: false, consumeWine: false })
}

/**
 * 这一次【杀】需要连续打出几张【闪】。
 *
 * 两类来源，**都要看**：
 *
 * - 出杀方的固定加成（吕布【无双】）：`slashDodgeResponses`；
 * - 攻守任意一方的条件加成（董卓【肉林】要看对方性别）：`dodgeResponsesFor`。
 *   肉林在「董卓砍女性」和「女性砍董卓」两个方向都生效，后者技能在**目标**身上，
 *   所以只查出杀方的技能是不够的。
 *
 * 多个来源取 **max 而不是相加**：无双和肉林撞在一起仍然是两张闪，不是四张。
 * 规则上这类效果是「需要 N 张才能抵消」，不是各自独立叠加。
 */
function slashDodgeRequirement(host: CardEngineHost, sourceId: PlayerId, targetId: PlayerId): number {
  const counts = [1]
  for (const runtime of skillsOf(host.state, sourceId, skillIdsOf)) {
    counts.push(runtime.slashDodgeResponses ?? 1)
    counts.push(runtime.dodgeResponsesFor?.(host.state, sourceId, sourceId, targetId) ?? 1)
  }
  for (const runtime of skillsOf(host.state, targetId, skillIdsOf)) {
    counts.push(runtime.dodgeResponsesFor?.(host.state, targetId, sourceId, targetId) ?? 1)
  }
  return Math.max(...counts)
}

/**
 * 开始结算当前这个目标。
 *
 * 仁王盾 / 藤甲让这张牌对某个目标完全无效，那个目标直接跳过——
 * 多目标时其余目标仍然照常结算。
 */
function enterSlashTarget(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return
  const card = host.state.cards[resolution.cardId]
  const slashColor = card.virtual ? null : effectiveCardColor(host.state, resolution.sourceId, card.id, skillIdsOf)
  if (isCardIneffective(host.state, resolution.targetId, '杀', slashColor, card.damageNature ?? 'normal', resolution.sourceId)) {
    continueSlash(host)
    return
  }
  applyUndodgeableSkills(host, resolution.sourceId, resolution.targetId)
  if (askSlashInterceptors(host)) return
  /*
   * 插入点可以**同步**取消这个目标：刘禅【享乐】在攻击者一张基本牌都没有时
   * 不发问，当场判这张【杀】对他无效。那种情况下 `interceptTarget` 返回的是
   * false（没有挂起任何 Request），但目标已经作废，不能再往下问闪——
   * 问了就是对一个已经无效的目标求闪，而且会留下一个没人回答的请求。
   */
  if (resolution.targetCancelled) {
    continueSlash(host)
    return
  }
  askSlashDodge(host)
}

/**
 * 锁定技造成的「不可闪避」。
 *
 * 铁骑是判定成功后写 noDodge，烈弓是看目标手牌数——都落到同一个字段上，
 * 后面求闪那一步只认这个字段，不需要知道是哪个技能写的。
 * 只加不减：铁骑已经判成功了，烈弓不满足条件也不能把它抹掉。
 */
function applyUndodgeableSkills(host: CardEngineHost, sourceId: PlayerId, targetId: PlayerId): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return
  for (const runtime of skillsOf(host.state, sourceId, skillIdsOf)) {
    if (runtime.slashUndodgeable?.(host.state, sourceId, targetId)) resolution.noDodge = true
  }
}

/**
 * 当前目标结算完了：还有目标就换下一个，没有就把这张牌收掉。
 *
 * 每个目标都是一次全新的响应，所以插入点记账、代打进度、无双次数全部重置。
 */
function continueSlash(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return
  /*
   * 跳过已经不在场的目标。
   *
   * 多目标【杀】（太史慈【天义】）里，前一个目标的结算完全可能顺带带走后一个
   * ——他死于反馈、刚烈，或者死在濒死流程里。不跳过的话下一轮会对着死人
   * 走结算，最后在 resolveDamage 抛「不能对死亡角色造成伤害」。
   */
  let next = resolution.remainingTargetIds.shift()
  while (next !== undefined && !host.state.players.find((candidate) => candidate.id === next)?.alive) {
    next = resolution.remainingTargetIds.shift()
  }
  if (next === undefined) {
    finishSlash(host, resolution)
    host.state.cardResolution = null
    return
  }
  resolution.targetId = next
  resolution.interceptsDone = []
  resolution.surrogate = null
  resolution.requestId = null
  resolution.stage = 'awaiting-dodge'
  resolution.dodgeRemaining = slashDodgeRequirement(host, resolution.sourceId, resolution.targetId)
  resolution.noDodge = false
  resolution.targetCancelled = false
  enterSlashTarget(host)
}

/** 结束一次【杀】的结算：主牌和一起打出的额外牌都进弃牌堆。 */
function finishSlash(host: CardEngineHost, resolution: SlashResolutionState): void {
  finishPhysicalCard(host, resolution.sourceId, resolution.cardId, [resolution.targetId], false, '杀')
  discardExtras(host, resolution.extraCardIds)
}

function discardExtras(host: CardEngineHost, cardIds: readonly CardId[]): void {
  for (const cardId of cardIds) {
    if (!host.state.zones.processingArea.includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }
}

/**
 * 「成为目标时」的插入点。
 *
 * 雌雄双股剑问目标选一项，大乔【流离】把这张【杀】转给别人。
 * 返回 true 表示已经问出去了，调用方不要再求闪——结算会停在 `awaiting-intercept`，
 * 由 `resumeSlashAfterEquipment` 接回来。
 */
function askSlashInterceptors(host: CardEngineHost): boolean {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return false
  const interceptors: Array<[string, () => boolean]> = [
    // 铁骑排在最前：它是使用者在「指定目标后」立刻发动的，先于装备和目标方的反应
    ['tieji', () => askTieji(host, resolution.sourceId, resolution.targetId)],
    ['cixiong', () => askCixiongSword(host, resolution.sourceId, resolution.targetId)],
    ['liuli', () => askSlashTransfer(host, resolution.sourceId, resolution.targetId)],
  ]
  for (const runtime of skillsOf(host.state, resolution.targetId, skillIdsOf)) {
    if (!runtime.interceptTarget) continue
    interceptors.push([
      `skill:${runtime.id}`,
      () => runtime.interceptTarget!(host, resolution.targetId, {
        sourceId: resolution.sourceId,
        targetId: resolution.targetId,
        cardId: resolution.cardId,
        cardName: '杀',
        category: 'basic',
      }),
    ])
  }
  for (const [id, ask] of interceptors) {
    // 同一个目标只问一次：插入点结算完会回到这里，不记账就会把自己再问一遍
    if (resolution.interceptsDone.includes(id)) continue
    resolution.interceptsDone.push(id)
    if (!ask()) continue
    resolution.stage = 'awaiting-intercept'
    return true
  }
  return false
}

const BAGUA_TAG = 'bagua'

/**
 * 八卦阵判定完成后的分支。
 *
 * 判定牌是红色就等同于打出了一张【闪】，黑色则视为没有响应、伤害照常结算。
 * 结算状态从 `state.cardResolution` 现取——判定期间牌局没有换过这次结算，
 * 但中间可能插过改判询问，所以不能沿用调用前抓下来的引用。
 */
registerJudgmentContinuation(BAGUA_TAG, (host, judged) => {
  const engineHost = host as unknown as CardEngineHost
  const resolution = engineHost.state.cardResolution
  if (resolution?.kind !== 'slash') return
  if (judged.color === 'red') {
    finishDodgedSlash(engineHost, resolution)
    return
  }
  resolution.stage = 'awaiting-dying'
  resolveDamage(engineHost, {
    sourceId: resolution.sourceId,
    targetId: resolution.targetId,
    amount: resolution.damageAmount,
    nature: resolution.damageNature,
    cardName: '杀',
    cardId: resolution.cardId,
  })
  if (!engineHost.state.dying && !engineHost.state.damageChain) resumeCardResolution(engineHost)
})

/** 向【杀】的当前目标发出求闪。插入点结束之后也回到这里。 */
function askSlashDodge(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return
  // 铁骑判定成功：这一刀根本不问闪，直接走「没闪掉」那条路。
  // 用 landSlash 而不是直接结算伤害——寒冰剑这类「伤害前」的效果照样要有机会。
  if (resolution.noDodge) {
    landSlash(host, resolution)
    return
  }
  resolution.stage = 'awaiting-dodge'
  askDodge(host, resolution.targetId, `${player(host.state, resolution.sourceId).nickname}对你使用【杀】，请响应【闪】`, true)
}

/**
 * 请某人打出【闪】。
 *
 * 目标自己和主公技代打者共用这条路径，区别只有两点：
 * 代打者没有八卦阵可用（那是目标装备区里的牌），提示词也不一样。
 */
function askDodge(host: CardEngineHost, responderId: PlayerId, prompt: string, allowBagua: boolean): void {
  const responder = player(host.state, responderId)
  const actionIds = responder.zones.hand
    .filter((candidateId) => host.state.cards[candidateId]?.name === '闪')
    .map((candidateId) => `respond-dodge:${candidateId}`)
  // 龙胆把【杀】当【闪】打出，同样要作为独立动作发出去
  for (const option of dodgeViewAsOptions(host.state, responderId)) {
    actionIds.push(`respond-dodge:${option.cardId}`)
  }
  // 八卦阵不是手牌，但同样是「打出闪」的一种途径，必须出现在合法动作里，
  // 否则前端永远点不到它——服务端支持不等于前端能用。
  if (allowBagua && canInvokeBagua(host.state, responderId)) actionIds.push(BAGUA_ACTION_ID)
  // 于吉【蛊惑】：声明打出一张【闪】。入口只是多一条动作 id，
  // 挂起和恢复由 game.respondInner 统一处理
  if (canGuhuoRespond(host.state, responderId, '闪', skillIdsOf)) actionIds.push(GUHUO_RESPOND_ACTION)
  /*
   * 无亮【忍耐】：本来能响应才给这个入口。
   *
   * `actionIds.length > 0` 就是规则说的「若你可以响应」——手上没【闪】、
   * 被技能禁止响应时这里凑不出任何真响应，自然不能靠「不响应」白拿收益。
   *
   * 只给**目标本人**：主公技代打者走的也是这条路，他不是这张【杀】的目标。
   */
  const slash = host.state.cardResolution
  if (slash?.kind === 'slash' && slash.targetId === responderId
    && canRennai(host.state, responderId, slash.sourceId, actionIds.length > 0,
      usedThisTurn(host.state, responderId, RENNAI_SKILL), skillIdsOf)) {
    actionIds.push(RENNAI_ACTION)
  }
  actionIds.push('respond-pass')
  const request: RespondCardRequest = {
    // id 必须唯一：主公技代打会在同一个 seq 里连着问好几个人，
    // 复用 id 会让「响应后没有推进」的死锁守卫误报，也会让回放对不上
    id: `request-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'respond-card',
    playerId: responderId,
    prompt,
    timeoutMs: 30_000,
    optional: true,
    actionIds,
    requiredCardName: '闪',
  }
  host.state.pendingRequests.push(request)
  if (host.state.cardResolution) host.state.cardResolution.requestId = request.id
}

/**
 * 主公技代打（护驾）：目标放弃之后，转问同势力角色有没有人替他打。
 *
 * 返回 true 表示已经问出去了，调用方必须直接返回，不要继续结算伤害。
 */
function askLordSurrogate(host: CardEngineHost, resolution: SlashResolutionState): boolean {
  if (resolution.surrogate === null) {
    const runtime = skillsOf(host.state, resolution.targetId, skillIdsOf)
      .find((candidate) => candidate.surrogateResponders)
    if (!runtime) return false
    const order = runtime.surrogateResponders!(host.state, resolution.targetId, '闪')
    if (order.length === 0) return false
    resolution.surrogate = { skillId: runtime.id, order, index: 0 }
  } else {
    resolution.surrogate.index += 1
  }

  const { order, skillId } = resolution.surrogate
  // 问的过程中有人可能已经死了，跳过
  while (resolution.surrogate.index < order.length) {
    const responderId = order[resolution.surrogate.index]
    const responder = host.state.players.find((candidate) => candidate.id === responderId)
    if (responder?.alive) {
      askDodge(host, responderId, `主公需要【闪】，你可以发动【${skillId === 'hujia' ? '护驾' : '代打'}】替他打出`, false)
      return true
    }
    resolution.surrogate.index += 1
  }
  return false
}

function placeDelayedTrick(host: CardEngineHost, action: Extract<LegalAction, { kind: 'use-card' }>): void {
  const [cardId] = action.cardIds
  const [targetId] = action.targetIds
  if (!beginActionPhysicalCard(host, action.playerId, cardId, [targetId], action.asCardName)) return
  // 转化过来的延时锦囊要把「当作什么用」记下来，判定时才按它结算
  if (action.asCardName) setCardAlias(host.state, cardId, action.asCardName)
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'judgingArea', playerId: targetId })
  finishPhysicalCard(host, action.playerId, cardId, [targetId], false, action.asCardName)
}

export function performPlayAction(host: CardEngineHost, playerId: PlayerId, actionId: string): void {
  const action = findLegalAction(legalPlayActions(host.state, playerId), playerId, actionId)
  recordPlayDecision(host, playerId, actionId)
  if (action.kind === 'pass') {
    advanceGamePhase(host)
    return
  }
  if (action.kind === 'invoke-skill') {
    // 装备的主动效果（丈八蛇矛、方天画戟）不在武将技能表里，按 id 全局查
    const own = skillsOf(host.state, playerId, skillIdsOf).find((candidate) => candidate.id === action.skillId)
      ?? (action.skillId.startsWith('equip:') ? getSkillRuntime(action.skillId) : undefined)
    /*
     * 自己也有同名技能，**不代表这条动作是自己的主动技**。
     *
     * 一桌上出现两个同名武将时（娱乐包允许重复，压测的固定阵容也会造出来），
     * 被授权方自己那份「黄天」会先按 id 命中，然后卡在下面的
     * 「技能不可发动」——因为授权类技能只有 `invokeGrantedAction`，没有 `invokeActive`。
     * 所以命中的这份没有 `invokeActive` 时要当作没找到，继续去找真正的授权者。
     */
    const runtime = own?.invokeActive ? own : undefined

    // 主公技授权（黄天）：这条动作属于当前玩家，但技能长在别人身上，
    // 所以在自己的技能表里找不到时再去全场找一遍授权者
    if (!runtime) {
      const grantor = host.state.players.find((candidate) => candidate.alive && candidate.id !== playerId
        && skillsOf(host.state, candidate.id, skillIdsOf)
          .some((skill) => skill.id === action.skillId
            && (skill.grantsPlayActions?.(host.state, candidate.id, playerId) ?? []).some((option) => option.id === action.id)))
      const granted = grantor
        ? skillsOf(host.state, grantor.id, skillIdsOf).find((skill) => skill.id === action.skillId)
        : undefined
      if (!grantor || !granted?.invokeGrantedAction) throw new Error('技能不可发动')
      host.dispatch('SkillActivated', {
        skillId: action.skillId, skillName: skillDisplayName(action.skillId), targetIds: action.targetIds,
      }, { sourceId: playerId })
      granted.invokeGrantedAction(host, grantor.id, playerId, action.id)
      return
    }

    if (!runtime.invokeActive) throw new Error('技能不可发动')
    // 确认技能真的能发动之后再广播，界面才不会为一次失败的点击闪一下技能名。
    // 自己会报横幅的技能不补这条，否则中央会连播两遍同一个技能名
    if (!runtime.announcesSelf) {
      host.dispatch('SkillActivated', {
        skillId: action.skillId, skillName: skillDisplayName(action.skillId), targetIds: action.targetIds,
      }, { sourceId: playerId })
    }
    runtime.invokeActive(host, playerId, action.id)
    return
  }
  if (action.kind !== 'use-card') throw new Error('当前不是可执行的出牌动作')
  executeUseCardAction(host, playerId, action)
}

/**
 * 执行一条「使用牌」动作。
 *
 * 从 `performPlayAction` 里拆出来，让于吉【蛊惑】在质疑结束之后能够
 * **重放同一条动作**——那时候 `legalPlayActions` 已经查不到它了
 * （牌进过私有区、出牌次数也可能变了），但规则上这次使用是成立的。
 */
export function executeUseCardAction(
  host: CardEngineHost,
  playerId: PlayerId,
  action: Extract<LegalAction, { kind: 'use-card' }>,
  options: { skipPlayInterceptors?: boolean } = {},
): void {
  const [cardId] = action.cardIds
  const card = host.state.cards[cardId]
  /*
   * 丈八蛇矛会带两张牌，每一张都要确认在自己手上。
   *
   * 专属牌堆算「属于自己」：邓艾【急袭】的底牌是武将牌上的「田」，
   * 从那里直接使用，不路过手牌。判定区仍然排除——那不是你能拿去用的牌。
   */
  if (!card || action.cardIds.some((id) => {
    const zone = locateOwnedCard(host.state, playerId, id, { includeCharacterPiles: true })
    return !zone || zone.kind === 'judgingArea'
  })) throw new Error('卡牌不属于出牌玩家')
  if (isCardUseProhibited(host.state, playerId, action.asCardName, { dyingPlayerId: null }, skillIdsOf)) {
    /*
     * 多步技能可能在动作合法时开始、跨过若干 Request 后才真正续接到这里。
     * 期间若【限行】已经封住用牌，这条旧动作应安全失效，不能绕过限制，
     * 更不能抛错把整个联机房间打断。普通出牌仍由 legalPlayActions 提前隐藏。
     */
    return
  }
  if (!options.skipPlayInterceptors) {
    for (const owner of host.state.players) {
      if (!owner.alive) continue
      for (const runtime of skillsOf(host.state, owner.id, skillIdsOf)) {
        if (runtime.interceptPlayAction?.(host, owner.id, action)) return
      }
    }
  }

  // 重铸：弃掉这张牌摸一张，不算「使用」，所以不进处理区、没有无懈窗口
  if (action.id.startsWith('play:recast:')) {
    moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: 'recast' }, { sourceId: playerId, cardIds: [cardId] })
    const drawn = host.state.zones.drawPile.shift()
    if (drawn) {
      player(host.state, playerId).zones.hand.push(drawn)
      host.dispatch('GainCard', { playerId, cardIds: [drawn], reason: 'recast' }, { targetId: playerId, cardIds: [drawn] })
    }
    return
  }

  // 转化出的动作一律以 asCardName 为准：武圣打出的红桃按【杀】结算，
  // 甘宁打出的黑牌按【过河拆桥】结算，后续判定不再看牌面上印的名字。
  const effectiveName = action.asCardName || card.name
  if (effectiveName === '杀') {
    beginSlash(host, action)
    return
  }
  if (DELAYED_TRICKS.has(effectiveName)) {
    placeDelayedTrick(host, action)
    return
  }
  if (INSTANT_TRICKS.has(effectiveName)) {
    if (!beginActionPhysicalCard(host, playerId, cardId, action.targetIds, effectiveName)) return
    // 多张实体牌换一张锦囊（袁绍【乱击】）：第一张当主牌，其余跟着一起走
    beginInstantTrick(host, playerId, cardId, action.targetIds, effectiveName, action.cardIds.slice(1))
    return
  }
  if (!beginActionPhysicalCard(host, playerId, cardId, action.targetIds, effectiveName)) return
  // 这里也要看 effectiveName：转化成【桃】【酒】的牌（于吉【蛊惑】）
  // 按印刷名字判断会掉进最后那个 throw，等于「转化成桃」根本用不出来。
  // 装备只可能是它本身，所以那一支仍然按实体牌算。
  if (effectiveName === '桃') {
    recover(host, playerId, 1, playerId)
  } else if (effectiveName === '酒') {
    host.state.turnUsage.wineUses += 1
    host.state.turnUsage.wineDamageBonus = 1
  } else if (card.category === 'equipment' && card.equipmentSlot) {
    const replaced = playerOf(host.state, playerId).zones.equipment[card.equipmentSlot]
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId, slot: card.equipmentSlot })
    if (replaced) handleEquipmentLost(host, playerId, replaced)
  } else {
    throw new Error(`尚未实现卡牌：${effectiveName}`)
  }
  finishPhysicalCard(host, playerId, cardId, action.targetIds, false, effectiveName)
}

function removeResponseRequest(state: SanguoshaState, requestId: string): void {
  state.pendingRequests = state.pendingRequests.filter((request) => request.id !== requestId)
}

function recordResponse(host: CardEngineHost, request: RespondCardRequest, response: GameResponse): void {
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })
}

export function resolveCardResponse(host: CardEngineHost, request: RespondCardRequest, response: GameResponse): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.requestId !== request.id) throw new Error('卡牌响应 Request 已经过期')
  // 锦囊效果阶段问的是「打出杀/闪」，和无懈询问不是一回事，交给 tricks 处理
  if (resolution.kind === 'trick' && resolution.stage === 'awaiting-effect') {
    resolveTrickEffectResponse(host, request, response)
    return
  }
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const actionId = (response.payload as { actionId: string }).actionId

  // 八卦阵：判定红色就当作打出了一张【闪】，黑色则视为没有响应
  if (actionId === BAGUA_ACTION_ID) {
    if (resolution.kind !== 'slash' || !canInvokeBagua(host.state, response.playerId)) throw new Error('当前不能发动【八卦阵】')
    removeResponseRequest(host.state, request.id)
    resolution.requestId = null
    recordResponse(host, request, response)
    // 判定可能因为改判（鬼才）挂起，红黑分支写在续接里
    performJudgment(host, response.playerId, '八卦阵', { tag: BAGUA_TAG })
    return
  }

  // 「本轮均不使用」：这张牌剩下的目标都不再问他。五谷丰登这类多目标锦囊
  // 一路点「不使用」要点五六次，声明一次就够了。
  if (actionId === PASS_ROUND_ACTION) {
    if (resolution.kind !== 'trick') throw new Error('只有多目标锦囊才有本轮均不使用')
    removeResponseRequest(host.state, request.id)
    resolution.requestId = null
    recordResponse(host, request, response)
    if (!resolution.declinedAllIds.includes(response.playerId)) resolution.declinedAllIds.push(response.playerId)
    resolution.responderIndex += 1
    askNullification(host)
    return
  }

  let responseCardId: string | null = null
  if (actionId !== 'respond-pass') {
    const prefix = resolution.kind === 'slash' ? 'respond-dodge:' : 'respond-nullification:'
    const requiredName = resolution.kind === 'slash' ? '闪' : '无懈可击'
    if (!actionId.startsWith(prefix)) throw new Error('响应 action 类型不匹配')
    responseCardId = actionId.slice(prefix.length)
    const responder = player(host.state, response.playerId)
    const heldName = host.state.cards[responseCardId]?.name
    // 蛊惑成立的那一瞬间，那张牌被临时报成声明的牌，沿用这里原有的校验
    const granted = guhuoGrantedAs(host.state, response.playerId, responseCardId) === requiredName
    const convertible = granted || (resolution.kind === 'slash'
      ? dodgeViewAsOptions(host.state, response.playerId).some((option) => option.cardId === responseCardId)
      : responseViewAsOptions(host.state, response.playerId, requiredName).some((option) => option.cardId === responseCardId))
    if (!responder.zones.hand.includes(responseCardId) || (heldName !== requiredName && !convertible)) {
      throw new Error(`响应牌不是该玩家持有的${requiredName}`)
    }
  }
  removeResponseRequest(host.state, request.id)
  resolution.requestId = null
  recordResponse(host, request, response)

  if (resolution.kind === 'trick') {
    if (actionId !== 'respond-pass') {
      const cardId = responseCardId!
      const responder = player(host.state, response.playerId)
      const targetId = resolution.targetIds[resolution.targetIndex]
      moveCard(host.state, cardId, { kind: 'hand', playerId: responder.id }, { kind: 'processingArea' })
      host.dispatch('CardResponded', { asking: false, playerId: responder.id, cardId, cardName: '无懈可击' }, { sourceId: responder.id, targetId, cardIds: [cardId] })
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      resolution.nullificationCount += 1
      // 被无懈之后要从头再问一圈：任何人都可以对这张无懈再无懈。
      // 但记下是谁打的，下一圈跳过他自己——对自己的无懈再叠一张，
      // 效果等于两张都没打，只是白白多问一次（用户报的「连续问两遍」）。
      resolution.lastNullifierId = responder.id
      resolution.responderIndex = 0
    } else resolution.responderIndex += 1
    askNullification(host)
    return
  }

  if (actionId !== 'respond-pass') {
    const cardId = responseCardId!
    const responder = player(host.state, response.playerId)
    moveCard(host.state, cardId, { kind: 'hand', playerId: responder.id }, { kind: 'processingArea' })
    host.dispatch('CardResponded', { asking: false, playerId: responder.id, cardId, cardName: '闪' }, { sourceId: responder.id, targetId: resolution.sourceId, cardIds: [cardId] })
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    finishDodgedSlash(host, resolution)
    return
  }

  // 主公技：目标自己不出闪时，同势力角色还有机会代打
  if (askLordSurrogate(host, resolution)) return

  landSlash(host, resolution)
}

/**
 * 【杀】命中之后的结算。
 *
 * 寒冰剑是**替代**伤害，只能问在伤害之前。发问期间结算停在 `awaiting-intercept`——
 * 那个阶段的 invariants 允许挂技能 Request。伤害和收尾都交给它的 resume。
 */
function landSlash(host: CardEngineHost, resolution: SlashResolutionState): void {
  const facts: DodgedSlashFacts = {
    sourceId: resolution.sourceId,
    targetId: resolution.targetId,
    amount: resolution.damageAmount,
    nature: resolution.damageNature,
    cardId: resolution.cardId,
  }
  if (askPreDamageWeapon(host, facts)) {
    resolution.stage = 'awaiting-intercept'
    return
  }

  resolution.stage = 'awaiting-dying'
  resolveDamage(host, { ...facts, cardName: '杀' })
  // 麒麟弓在伤害之后生效，走延后发问队列，不打断还没走完的濒死流程
  queueQilingong(host, facts)
  if (!host.state.dying && !host.state.damageChain) resumeCardResolution(host)
}

/**
 * 一张【闪】打出来之后的收尾。
 *
 * 无双要两张闪，所以先看还差不差；不差了这个目标才算结算完。
 * 武器特效（贯石斧、青龙偃月刀）发问期间结算停在 `awaiting-intercept`，
 * 由它们的 resume 回调 `continueSlash` 接着走。
 */
function finishDodgedSlash(host: CardEngineHost, resolution: SlashResolutionState): void {
  resolution.dodgeRemaining -= 1
  if (resolution.dodgeRemaining > 0) {
    resolution.surrogate = null
    askDodge(host, resolution.targetId, '【无双】仍需再打出一张【闪】', true)
    return
  }
  const facts: DodgedSlashFacts = {
    sourceId: resolution.sourceId,
    targetId: resolution.targetId,
    amount: resolution.damageAmount,
    nature: resolution.damageNature,
    cardId: resolution.cardId,
  }
  // 「杀被【闪】抵消后」的时机链。装备（贯石斧、青龙偃月刀）和武将技能
  // （庞德【猛进】）走同一条链，谁先抢到就先问谁，回答完由各自的 resume
  // 调 continueSlash 交还控制。往这个时机加新技能只需要往这里加一环。
  const afterDodged: Array<() => boolean> = [
    () => askDodgedSlashWeapon(host, facts),
    () => askMengjin(host, facts),
  ]
  for (const ask of afterDodged) {
    if (!ask()) continue
    resolution.stage = 'awaiting-intercept'
    return
  }
  continueSlash(host)
}

/** 锦囊效果里的「挑一张牌」响应入口。 */
export function resolveCardPickResponse(host: CardEngineHost, request: ChooseCardsRequest, response: GameResponse): void {
  resolveTrickPickResponse(host, request, response)
}

export function resumeCardResolution(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution) return
  // 锦囊多目标：某个目标濒死救完之后要接着结算剩下的目标
  if (resolution.kind === 'trick') {
    resumeTrickResolution(host)
    return
  }
  if (resolution.stage !== 'awaiting-dying' || host.state.dying) return
  continueSlash(host)
}

/** 技能完成“成为目标后”的发问后，恢复当前目标的正常结算。 */
export function resumeCardTarget(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution) return
  if (resolution.kind === 'trick') {
    resumeTrickTarget(host)
    return
  }
  if (resolution.targetCancelled) {
    continueSlash(host)
    return
  }
  if (!askSlashInterceptors(host)) askSlashDodge(host)
}


// 装备特效要回头调用杀的结算，而 equipment-requests 又被这里 import，
// 直接互相 import 会成环，所以把能力交进去。
provideEquipmentCallbacks({
  dealSlashDamage(host, facts: DodgedSlashFacts) {
    const engineHost = host as CardEngineHost
    // 装备特效问完了，阶段要从 awaiting-intercept 拨回来再结算伤害——
    // 那个阶段的 invariants 要求必须挂着技能 Request
    const resolution = engineHost.state.cardResolution
    if (resolution?.kind === 'slash') resolution.stage = 'awaiting-dying'
    resolveDamage(engineHost, { ...facts, cardName: '杀' })
    // 不管伤害是正常命中还是贯石斧硬吃出来的，麒麟弓都该有机会
    queueQilingong(host, facts)
    // 伤害之后立刻收尾，调用方不用再各自记得调一次——
    // 忘掉的话结算会停在 awaiting-dying，整局卡死。
    // 濒死或属性传导还没走完时先不动，那两条路结束后会回到 resumeCardResolution。
    if (!engineHost.state.dying && !engineHost.state.damageChain) continueSlash(engineHost)
  },
  resumeSlashAfterEquipment(host) {
    const engineHost = host as CardEngineHost
    // 转移之后新目标同样要过一遍插入点（雌雄双股剑、下一个大乔）
    if (!askSlashInterceptors(engineHost)) askSlashDodge(engineHost)
  },
  startVirtualTrick(host, sourceId, targetId, cardId, asName, cardOwnerId) {
    const engineHost = host as CardEngineHost
    // 载体牌在发动技能的人手里，而「使用者」是被指定的那个人——
    // 所以不能直接用 beginPhysicalCard（它会从使用者手上取牌）。
    //
    // 来源不能写死成手牌：离间的代价是「弃置一张牌」，装备也算，
    // 写死 hand 会在貂蝉用装备当代价时抛「卡牌不在来源区域」。
    const from = locateOwnedCard(engineHost.state, cardOwnerId, cardId)
    if (!from) return
    moveCard(engineHost.state, cardId, from, { kind: 'processingArea' })
    if (from.kind === 'equipment') {
      engineHost.dispatch('LoseEquipment', { playerId: cardOwnerId, cardId, slot: from.slot }, { targetId: cardOwnerId, cardIds: [cardId] })
    }
    const metadata = { sourceId, targetId, cardIds: [cardId] }
    engineHost.dispatch('CardUsed', { cardId, cardName: asName, targetIds: [targetId] }, metadata)
    engineHost.dispatch('TargetSpecified', { cardId, cardName: asName, targetIds: [targetId] }, metadata)
    engineHost.dispatch('TargetConfirmed', { cardId, cardName: asName, targetId }, metadata)
    beginInstantTrick(engineHost, sourceId, cardId, [targetId], asName)
  },
  continueSlash(host) {
    continueSlash(host as CardEngineHost)
  },
  beginSlashFromAction(host, sourceId, cardIds, targetIds) {
    const engineHost = host as CardEngineHost
    const [first] = targetIds
    const target = engineHost.state.players.find((candidate) => candidate.id === first)
    if (!target) return
    const base = useAction(cardIds[0], sourceId, '杀', targetIds, `对${target.nickname}使用【杀】`)
    if (base.kind !== 'use-card') return
    beginSlash(engineHost, { ...base, cardIds, targetIds })
  },
  beginBorrowedSlash(host, sourceId, targetId, cardId) {
    const engineHost = host as CardEngineHost
    // 借刀本身的结算可能已经把人打死、把牌局打完了，前提不成立就别再起一次【杀】
    if (engineHost.state.status !== 'playing') return
    const attacker = engineHost.state.players.find((candidate) => candidate.id === sourceId)
    const victim = engineHost.state.players.find((candidate) => candidate.id === targetId)
    if (!attacker?.alive || !victim?.alive) return
    // 打出时这张【杀】已经进了弃牌堆，挪回处理区当作这次结算的实体牌
    if (engineHost.state.zones.discardPile.includes(cardId)) {
      moveCard(engineHost.state, cardId, { kind: 'discardPile' }, { kind: 'processingArea' })
    }
    const card = engineHost.state.cards[cardId]
    const metadata = { sourceId, targetId, cardIds: [cardId] }
    engineHost.dispatch('CardUsed', { cardId, cardName: '杀', targetIds: [targetId] }, metadata)
    engineHost.dispatch('TargetSpecified', { cardId, cardName: '杀', targetIds: [targetId] }, metadata)
    engineHost.dispatch('TargetConfirmed', { cardId, cardName: '杀', targetId }, metadata)
    engineHost.state.cardResolution = {
      kind: 'slash', cardId, sourceId, targetId,
      damageNature: card.damageNature ?? 'normal',
      // 借刀的【杀】不吃使用者的酒，也不占他的出杀次数——那不是他的出牌阶段
      damageAmount: 1,
      stage: 'awaiting-dodge', requestId: null, surrogate: null, interceptsDone: [],
      extraCardIds: [], remainingTargetIds: [],
      dodgeRemaining: slashDodgeRequirement(engineHost, sourceId, targetId),
    }
    enterSlashTarget(engineHost)
  },
  transferSlashTarget(host, newTargetId) {
    const engineHost = host as CardEngineHost
    const resolution = engineHost.state.cardResolution
    if (resolution?.kind !== 'slash') return
    resolution.targetId = newTargetId
    // 换了目标就是一次全新的响应：代打进度清掉，插入点也要对新目标重新问一遍
    resolution.surrogate = null
    resolution.interceptsDone = []
    // 需要几张闪也要按新目标重算：肉林看的是目标性别，转给别人之后条件可能就不成立了
    resolution.dodgeRemaining = slashDodgeRequirement(engineHost, resolution.sourceId, newTargetId)
    resolution.noDodge = false
    resolution.targetCancelled = false
    engineHost.dispatch('TargetSpecified', { cardId: resolution.cardId, targetId: newTargetId, reason: '流离' }, {
      sourceId: resolution.sourceId, targetId: newTargetId, cardIds: [resolution.cardId],
    })
    if (!askSlashInterceptors(engineHost)) askSlashDodge(engineHost)
  },
  useExtraSlash(host, sourceId, targetId, cardId) {
    const engineHost = host as CardEngineHost
    /*
     * **调用方必须先把外层那张【杀】彻底收完再进来。**
     *
     * 这里原来自己调 `continueSlash`，但多目标【杀】（太史慈【天义】、方天画戟）
     * 的 `continueSlash` 会推进到下一个目标并**当场发出求闪请求**，
     * 紧接着下面的 `beginSlash` 就把 `cardResolution` 覆盖掉了——
     * 那个刚发出去的请求从此没有对应的结算状态，谁回答都会撞上
     * 「卡牌响应 Request 已经过期」。约一千局出一次，压测抓到过。
     */
    const target = playerOf(engineHost.state, targetId)
    // 青龙偃月刀的追杀不受距离和次数限制，所以不走 legalPlayActions，
    // 直接构造动作。用完把次数补回去，免得吃掉本回合正常的出杀机会。
    const usesBefore = engineHost.state.turnUsage.slashUses
    const extraSlash = useAction(cardId, sourceId, '杀', [targetId], `【青龙偃月刀】追加【杀】，目标${target.nickname}`)
    if (extraSlash.kind !== 'use-card') throw new Error('青龙偃月刀追杀动作构造失败')
    beginSlash(engineHost, { ...extraSlash, id: `equip:qinglong:${cardId}:${targetId}` })
    engineHost.state.turnUsage.slashUses = usesBefore
  },
})


// 性别表在武将数据那边，运行时回注，引擎不反向依赖 data 层


// 流离要按攻击范围找可转移的目标，技能表和距离计算都在别处，运行时回注
provideSkillLookup(skillIdsOf, canTarget)


// 装备的主动效果要按出杀次数和距离筛目标，这些计算在这里，运行时回注
provideSlashLookup(
  (state: SanguoshaState, playerId: PlayerId) => canUseSlash(state, playerId, hasUnlimitedSlash(state, playerId)),
  (state: SanguoshaState, playerId: PlayerId) => state.players
    .filter((target) => canTarget(state, playerId, target.id) && !isTargetProhibited(state, playerId, target.id, '杀', skillIdsOf))
    .map((target) => target.id),
)
