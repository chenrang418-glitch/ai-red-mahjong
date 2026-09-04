import { markUsedThisTurn, usedThisTurn } from './turn-usage'
import { performJudgment, registerJudgmentContinuation } from './judgment'
import { registerSkillRuntime, type SkillHost } from './skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from './requests'
import type { CardId, DamageNature, PlayerId, SanguoshaState } from './types'
import { hasWeapon } from './equipment'
import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from './card-pick'
import { locateOwnedCard, moveCard } from './zones'
import { effectiveGenderOf } from './huashen'

/**
 * 需要向玩家发问、并且要动引擎内部状态的效果。
 *
 * 大部分是装备，但也有武将技能（大乔【流离】要改杀的结算目标、
 * 貂蝉【离间】要凭空发起一次决斗）。它们放在这里而不是武将数据里，
 * 是因为武将数据被 `standard.ts` 汇总，而 `standard.ts` 又被引擎 import——
 * 放过去会成环。
 *
 * 走的是和武将技能同一套 `askSkill` / `resume`——`getSkillRuntime` 是全局按 id 查的，
 * 不依赖武将技能表，所以装备用 `equip:` 前缀的 id 注册进去就行，不用另起一套机制。
 *
 * 发问时机全部选在**结算已经收干净**的位置：
 * 【杀】被闪抵消之后，`cardResolution` 已经清空、实体牌已经归位，
 * 这时候挂起不会和任何未完成的结算抢状态。要用到的事实（谁打谁、伤害多少）
 * 在发问时抓进 `data`，`resume` 里再重新确认一遍前提。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

/** 闪避成功之后，攻击方手上的武器还能做什么。 */
export interface DodgedSlashFacts {
  sourceId: PlayerId
  targetId: PlayerId
  amount: number
  nature: DamageNature
  cardId: CardId
}

export const GUANSHIFU_SKILL = 'equip:guanshifu'
export const QINGLONGDAO_SKILL = 'equip:qinglongdao'

/**
 * 【杀】被闪抵消之后，问攻击方要不要动用武器特效。
 *
 * 返回 true 表示已经问出去了。一个人只可能装一把武器，所以两者不会同时触发。
 */
export function askDodgedSlashWeapon(host: SkillHost, facts: DodgedSlashFacts): boolean {
  const source = host.state.players.find((player) => player.id === facts.sourceId)
  const target = host.state.players.find((player) => player.id === facts.targetId)
  if (!source?.alive || !target?.alive) return false
  if (host.state.skillResolution) return false

  if (hasWeapon(host.state, facts.sourceId, '贯石斧')) {
    // 弃两张牌硬吃这一闪。手牌加装备一共不到两张就发动不了
    if (discardableCards(host.state, facts.sourceId).length < 2) return false
    host.askSkill({
      skillId: GUANSHIFU_SKILL,
      ownerId: facts.sourceId,
      step: 'ask',
      data: { ...facts },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: facts.sourceId,
        prompt: `发动【贯石斧】？弃置两张牌，令这张【杀】对 ${target.nickname} 依然造成伤害`,
        timeoutMs: 20_000,
        optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
      }),
    })
    return true
  }

  if (hasWeapon(host.state, facts.sourceId, '青龙偃月刀')) {
    const slashes = source.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
    if (slashes.length === 0) return false
    host.askSkill({
      skillId: QINGLONGDAO_SKILL,
      ownerId: facts.sourceId,
      step: 'ask',
      data: { ...facts },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: facts.sourceId,
        prompt: `发动【青龙偃月刀】？立即对 ${target.nickname} 再使用一张【杀】`,
        timeoutMs: 20_000,
        // 可选：不选就是放弃
        optional: true,
        purpose: 'skill',
        cardIds: slashes,
        hiddenCardSlots: [],
        min: 0,
        max: 1,
      }),
    })
    return true
  }

  return false
}

/** 可以被弃置的牌：手牌 + 装备区。判定区的牌不算自己的。 */
function discardableCards(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const owner = playerOf(state, playerId)
  return [
    ...owner.zones.hand,
    ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)),
  ]
}

/**
 * 装备特效要用到的回调，由 cards/basic.ts 在注册时注入。
 *
 * 直接 import basic.ts 会形成环（basic 要 import 这里的 askDodgedSlashWeapon），
 * 所以反过来让调用方把能力交进来。
 */
export interface EngineCallbacks {
  dealSlashDamage(host: SkillHost, facts: DodgedSlashFacts): void
  useExtraSlash(host: SkillHost, sourceId: PlayerId, targetId: PlayerId, cardId: CardId): void
  /** 「成为目标时」那一步结束之后，回到正常的求闪流程。 */
  resumeSlashAfterEquipment(host: SkillHost): void
  /**
   * 当前目标结算完了，接着走：还有目标就换下一个（方天画戟），没有就收牌。
   * 每个会「结束一个目标」的装备特效都必须在最后调它，否则结算会停住。
   */
  continueSlash(host: SkillHost): void
  /** 流离：把这张【杀】改指向新目标，然后重新走一遍插入点。 */
  transferSlashTarget(host: SkillHost, newTargetId: PlayerId): void
  /**
   * 离间：用一张实体牌作为载体，视为 sourceId 对 targetId 使用了某张普通锦囊。
   * `cardOwnerId` 是牌现在在谁手上——发动技能的人，通常不是「使用者」。
   */
  startVirtualTrick(host: SkillHost, sourceId: PlayerId, targetId: PlayerId, cardId: CardId, asName: string, cardOwnerId: PlayerId): void
  /**
   * 借刀杀人：目标打出的那张【杀】要走完整的杀结算，
   * 否则仁王盾挡不住、无双不生效、流离转不走。牌已经在弃牌堆里。
   */
  beginBorrowedSlash(host: SkillHost, sourceId: PlayerId, targetId: PlayerId, cardId: CardId): void
  /** 装备的主动效果选完牌和目标之后，用它开一次正常的【杀】结算。 */
  beginSlashFromAction(host: SkillHost, sourceId: PlayerId, cardIds: CardId[], targetIds: PlayerId[]): void
}

let callbacks: EngineCallbacks | null = null

export function provideEquipmentCallbacks(next: EngineCallbacks): void {
  callbacks = next
}

/** 给 tricks.ts 用：它不能直接 import basic.ts（会成环）。 */
export function getEngineCallbacks(): EngineCallbacks | null {
  return callbacks
}

// —— 贯石斧 ——
registerSkillRuntime({
  id: GUANSHIFU_SKILL,
  resume(host, _ownerId, resolution, response) {
    const facts = resolution.data as unknown as DodgedSlashFacts
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') {
        callbacks?.continueSlash(host)
        return
      }
      const pool = discardableCards(host.state, facts.sourceId)
      // 发问期间牌可能已经被别人拿走了，这里必须重新确认
      if (pool.length < 2) {
        callbacks?.continueSlash(host)
        return
      }
      host.askSkill({
        skillId: GUANSHIFU_SKILL,
        ownerId: facts.sourceId,
        step: 'discard',
        data: { ...facts },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: facts.sourceId,
          prompt: '【贯石斧】：弃置两张牌',
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds: pool,
          hiddenCardSlots: [],
          min: 2,
          max: 2,
        }),
      })
      return
    }

    const cardIds = (response.payload as { cardIds: CardId[] }).cardIds
    const owner = playerOf(host.state, facts.sourceId)
    for (const cardId of cardIds) {
      if (owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: facts.sourceId }, { kind: 'discardPile' })
        continue
      }
      const slot = (Object.keys(owner.zones.equipment) as Array<keyof typeof owner.zones.equipment>)
        .find((key) => owner.zones.equipment[key] === cardId)
      if (!slot) throw new Error('贯石斧弃置的牌不在自己的区域里')
      moveCard(host.state, cardId, { kind: 'equipment', playerId: facts.sourceId, slot }, { kind: 'discardPile' })
    }
    host.dispatch('LoseCard', { playerId: facts.sourceId, cardIds, reason: '贯石斧' }, { sourceId: facts.sourceId, cardIds })

    const target = host.state.players.find((player) => player.id === facts.targetId)
    // dealSlashDamage 自己会收尾，这里不能再调一次 continueSlash
    if (target?.alive) callbacks?.dealSlashDamage(host, facts)
    else callbacks?.continueSlash(host)
  },
})

// —— 青龙偃月刀 ——
registerSkillRuntime({
  id: QINGLONGDAO_SKILL,
  resume(host, _ownerId, resolution, response) {
    const facts = resolution.data as unknown as DodgedSlashFacts
    const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, facts.sourceId)
    const target = host.state.players.find((player) => player.id === facts.targetId)
    const usable = cardId
      && owner.alive
      && owner.zones.hand.includes(cardId)
      && host.state.cards[cardId]?.name === '杀'
      && target?.alive
    // 空选或前提不成立就是放弃，但外层这张【杀】仍然要收尾
    if (!usable) {
      callbacks?.continueSlash(host)
      return
    }
    // 先把外层那张【杀】收完，再插自己的追杀
    callbacks?.continueSlash(host)
    /*
     * 外层是多目标【杀】时，`continueSlash` 会推进到下一个目标并当场发出求闪请求。
     * 这时候**不能**马上开追杀：`beginSlash` 会覆盖掉外层的结算状态，
     * 把刚发出去的请求变成孤儿。改成排队，等这张【杀】整个结算完、
     * 牌局回到干净状态再补上——「立即」在规则上指的是同一张杀的结算之内，
     * 不是插到别的目标中间。
     */
    if (host.state.cardResolution || host.state.pendingRequests.length > 0) {
      host.queueSkill({ skillId: QINGLONGDAO_SKILL, ownerId: facts.sourceId, step: 'extra', data: { ...facts, cardId } })
      return
    }
    callbacks?.useExtraSlash(host, facts.sourceId, facts.targetId, cardId)
  },
  startQueued(host, _ownerId, prompt) {
    // 队列排空前牌局又走了一段，前提要重新确认一遍
    const sourceId = prompt.data.sourceId as PlayerId
    const targetId = prompt.data.targetId as PlayerId
    const cardId = prompt.data.cardId as CardId
    const owner = host.state.players.find((player) => player.id === sourceId)
    const target = host.state.players.find((player) => player.id === targetId)
    if (!owner?.alive || !target?.alive) return
    if (!owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.name !== '杀') return
    if (host.state.cardResolution) return
    callbacks?.useExtraSlash(host, sourceId, targetId, cardId)
  },
})

export const HANBINGJIAN_SKILL = 'equip:hanbingjian'
export const QILINGONG_SKILL = 'equip:qilingong'

/**
 * 【杀】命中、伤害结算之前问一次寒冰剑。
 *
 * 寒冰剑是**替代**伤害，所以只能问在伤害之前。调用方必须先把实体牌收干净
 * （`finishPhysicalCard` + 清空 `cardResolution`）再调这里，
 * 否则挂起时会留下一个半结算的状态。
 *
 * 返回 true 表示已经问出去了，伤害交给 `resume` 处理，调用方不要再自己结算。
 */
export function askPreDamageWeapon(host: SkillHost, facts: DodgedSlashFacts): boolean {
  if (host.state.skillResolution) return false
  if (!hasWeapon(host.state, facts.sourceId, '寒冰剑')) return false
  const source = host.state.players.find((player) => player.id === facts.sourceId)
  const target = host.state.players.find((player) => player.id === facts.targetId)
  if (!source?.alive || !target?.alive) return false
  // 目标一张牌都没有时，寒冰剑没有可弃的，不如让伤害照常结算
  if (discardableCards(host.state, facts.targetId).length === 0) return false

  host.askSkill({
    skillId: HANBINGJIAN_SKILL,
    ownerId: facts.sourceId,
    step: 'ask',
    data: { ...facts },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      playerId: facts.sourceId,
      prompt: `发动【寒冰剑】？改为弃置 ${target.nickname} 的两张牌，本次不造成伤害`,
      timeoutMs: 20_000,
      optional: true,
      options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
    }),
  })
  return true
}

/** 别人区域里可以被弃置的牌，手牌用暗槽表示。 */
function foreignCardChoices(state: SanguoshaState, targetId: PlayerId): { cardIds: CardId[]; hiddenCardSlots: string[] } {
  const target = playerOf(state, targetId)
  return {
    cardIds: Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)),
    hiddenCardSlots: target.zones.hand.map((_, index) => `hidden:${targetId}:${index}`),
  }
}

/** 把某人指定的一张牌弃掉。暗槽按索引还原成真实手牌。 */
function discardForeignCard(host: SkillHost, targetId: PlayerId, picked: string, reason: string): void {
  const target = playerOf(host.state, targetId)
  const hiddenIndex = target.zones.hand.findIndex((_, index) => `hidden:${targetId}:${index}` === picked)
  if (hiddenIndex >= 0) {
    const cardId = target.zones.hand[hiddenIndex]
    moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason }, { targetId, cardIds: [cardId] })
    return
  }
  const slot = (Object.keys(target.zones.equipment) as Array<keyof typeof target.zones.equipment>)
    .find((key) => target.zones.equipment[key] === picked)
  if (!slot) return
  moveCard(host.state, picked, { kind: 'equipment', playerId: targetId, slot }, { kind: 'discardPile' })
  host.dispatch('LoseEquipment', { playerId: targetId, cardIds: [picked], reason }, { targetId, cardIds: [picked] })
}

// —— 寒冰剑 ——
registerSkillRuntime({
  id: HANBINGJIAN_SKILL,
  resume(host, _ownerId, resolution, response) {
    const facts = resolution.data as unknown as DodgedSlashFacts
    const target = host.state.players.find((player) => player.id === facts.targetId)

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') {
        // 放弃发动：伤害照常。dealSlashDamage 会自己收尾
        if (target?.alive) callbacks?.dealSlashDamage(host, facts)
        else callbacks?.continueSlash(host)
        return
      }
      if (!target?.alive || !askHanbingjianCard(host, facts, 1)) {
        // 目标已经没牌可弃：寒冰剑发动不了，这个目标到此结算完毕
        callbacks?.continueSlash(host)
      }
      return
    }

    const [picked] = (response.payload as { cardIds: string[] }).cardIds
    if (picked && target?.alive) discardForeignCard(host, facts.targetId, picked, '寒冰剑')
    const round = Number(resolution.data.round ?? 1)
    // 第二张：目标还有牌才继续问
    if (round === 1 && target?.alive && askHanbingjianCard(host, facts, 2)) return
    // 寒冰剑替代了伤害，这个目标到此结算完毕
    callbacks?.continueSlash(host)
  },
})

/** 返回 false 表示没问出去（目标已经没牌了），调用方必须自己收尾。 */
function askHanbingjianCard(host: SkillHost, facts: DodgedSlashFacts, round: number): boolean {
  const choices = foreignCardChoices(host.state, facts.targetId)
  if (choices.cardIds.length + choices.hiddenCardSlots.length === 0) return false
  host.askSkill({
    skillId: HANBINGJIAN_SKILL,
    ownerId: facts.sourceId,
    step: 'pick',
    data: { ...facts, round },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId,
      kind: 'choose-cards',
      playerId: facts.sourceId,
      prompt: `【寒冰剑】：弃置目标的第 ${round} 张牌`,
      timeoutMs: 20_000,
      optional: false,
      purpose: 'skill',
      cardIds: choices.cardIds,
      hiddenCardSlots: choices.hiddenCardSlots,
      min: 1,
      max: 1,
    }),
  })
  return true
}

/**
 * 【杀】造成伤害之后，麒麟弓可以弃掉目标的一匹坐骑。
 *
 * 伤害已经结算完了，所以走延后发问队列——和「受到伤害后」的技能同一条路，
 * 不去打断还没走完的濒死流程。
 */
export function queueQilingong(host: SkillHost, facts: DodgedSlashFacts): void {
  if (!hasWeapon(host.state, facts.sourceId, '麒麟弓')) return
  host.queueSkill({ skillId: QILINGONG_SKILL, ownerId: facts.sourceId, step: 'ask', data: { ...facts } })
}

registerSkillRuntime({
  id: QILINGONG_SKILL,
  startQueued(host, ownerId, prompt) {
    const facts = prompt.data as unknown as DodgedSlashFacts
    const target = host.state.players.find((player) => player.id === facts.targetId)
    if (!target?.alive) return
    const horses = [target.zones.equipment.offensiveHorse, target.zones.equipment.defensiveHorse]
      .filter((id): id is CardId => Boolean(id))
    // 排队期间马可能已经没了，前提不成立就安静放弃
    if (horses.length === 0) return
    host.askSkill({
      skillId: QILINGONG_SKILL,
      ownerId,
      step: 'pick',
      data: { ...facts },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: ownerId,
        prompt: `发动【麒麟弓】？弃置 ${target.nickname} 装备区里的一匹坐骑`,
        timeoutMs: 20_000,
        // 可选：空选就是放弃
        optional: true,
        purpose: 'skill',
        cardIds: horses,
        hiddenCardSlots: [],
        min: 0,
        max: 1,
      }),
    })
  },
  resume(host, _ownerId, resolution, response) {
    const facts = resolution.data as unknown as DodgedSlashFacts
    const [picked] = (response.payload as { cardIds: string[] }).cardIds ?? []
    if (!picked) return
    const target = host.state.players.find((player) => player.id === facts.targetId)
    if (!target?.alive) return
    discardForeignCard(host, facts.targetId, picked, '麒麟弓')
  },
})

export const CIXIONG_SKILL = 'equip:cixiongjian'

/**
 * 雌雄双股剑：指定异性角色为【杀】的目标后，令其弃一张手牌，或你摸一张牌。
 *
 * 问的是**目标**，而且要问在求闪之前——那正是这张剑的意义所在。
 * 这一步挂的是技能 Request 而不是求闪 Request，所以 `cardResolution.stage`
 * 停在 `awaiting-intercept`，invariants 对这个阶段单独放行。
 *
 * 返回 true 表示已经问出去了，调用方不要再去求闪。
 */
export function askCixiongSword(host: SkillHost, sourceId: PlayerId, targetId: PlayerId): boolean {
  if (host.state.skillResolution) return false
  if (!hasWeapon(host.state, sourceId, '雌雄双股剑')) return false
  const source = host.state.players.find((player) => player.id === sourceId)
  const target = host.state.players.find((player) => player.id === targetId)
  if (!source?.alive || !target?.alive) return false
  const sourceGender = effectiveGenderOf(host.state, sourceId)
  const targetGender = effectiveGenderOf(host.state, targetId)
  // 性别未知（武将还没定）时不触发，宁可不生效也不猜
  if (!sourceGender || !targetGender || sourceGender === targetGender) return false

  const options = [{ id: 'draw', label: `让 ${source.nickname} 摸一张牌` }]
  // 没手牌就只能让对方摸牌，这时候不该给一个点不了的选项
  if (target.zones.hand.length > 0) options.unshift({ id: 'discard', label: '弃置一张手牌' })

  host.askSkill({
    skillId: CIXIONG_SKILL,
    ownerId: targetId,
    step: 'choose',
    data: { sourceId, targetId },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      // 问的是目标，不是持剑的人
      playerId: targetId,
      prompt: `${source.nickname}的【雌雄双股剑】：请选择`,
      timeoutMs: 20_000,
      optional: false,
      options,
    }),
  })
  return true
}

registerSkillRuntime({
  id: CIXIONG_SKILL,
  resume(host, _ownerId, resolution, response) {
    const sourceId = resolution.data.sourceId as PlayerId
    const targetId = resolution.data.targetId as PlayerId
    const target = host.state.players.find((player) => player.id === targetId)
    const optionId = (response.payload as { optionId: string }).optionId

    if (optionId === 'discard' && target?.alive && target.zones.hand.length > 0) {
      host.askSkill({
        skillId: CIXIONG_SKILL,
        ownerId: targetId,
        step: 'discard',
        data: { sourceId, targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: targetId,
          prompt: '【雌雄双股剑】：弃置一张手牌',
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds: [...target.zones.hand],
          hiddenCardSlots: [],
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      if (target?.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '雌雄双股剑' }, { targetId, cardIds: [cardId] })
      }
    } else {
      const source = host.state.players.find((player) => player.id === sourceId)
      const drawn = source?.alive ? host.state.zones.drawPile.shift() : undefined
      if (source && drawn) {
        source.zones.hand.push(drawn)
        host.dispatch('GainCard', { playerId: sourceId, cardIds: [drawn], reason: '雌雄双股剑' }, { targetId: sourceId, cardIds: [drawn] })
      }
    }

    // 剑的效果结束，回到正常的求闪流程
    callbacks?.resumeSlashAfterEquipment(host)
  },
})

// 技能 id 直接用武将数据里的那个，`getSkillRuntime` 才查得到
export const TIEJI_SKILL = 'tieji'

/**
 * 马超【铁骑】：使用【杀】指定目标后可以判定，为红则该目标不能用【闪】响应。
 *
 * 挂在杀的拦截链最前面——它是使用者在「指定目标后」立刻发动的，
 * 先于雌雄双股剑和目标方的流离。判定放在 resume 里做，因为发不发动要先问。
 */
export function askTieji(host: SkillHost, sourceId: PlayerId, targetId: PlayerId): boolean {
  if (host.state.skillResolution) return false
  const source = host.state.players.find((player) => player.id === sourceId)
  if (!source?.alive || !source.characterId) return false
  if (!skillIdsProvider?.(source.characterId).includes(TIEJI_SKILL)) return false
  const target = host.state.players.find((player) => player.id === targetId)
  if (!target?.alive) return false

  host.askSkill({
    skillId: TIEJI_SKILL,
    ownerId: sourceId,
    step: 'ask',
    data: { targetId },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      playerId: sourceId,
      prompt: `发动【铁骑】？判定为红色则 ${target.nickname} 不能用【闪】响应`,
      timeoutMs: 20_000,
      optional: true,
      options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
    }),
  })
  return true
}

const TIEJI_TAG = 'tieji'

registerJudgmentContinuation(TIEJI_TAG, (host, judged) => {
  const resolution = host.state.cardResolution
  if (judged.color === 'red' && resolution?.kind === 'slash') resolution.noDodge = true
  // 判定挂起过也一样：控制权最终都要交回这次【杀】的结算
  callbacks?.resumeSlashAfterEquipment(host)
})

registerSkillRuntime({
  id: TIEJI_SKILL,
  resume(host, ownerId, _resolution, response) {
    const invoked = (response.payload as { optionId?: string }).optionId === 'yes'
    if (!invoked) {
      callbacks?.resumeSlashAfterEquipment(host)
      return
    }
    // 走统一的判定入口，判定相关的时机（天妒、鬼才）才对得上。
    // 判定可能挂起等改判，所以收尾放进续接，两条路径共用一个出口
    performJudgment(host, ownerId, '铁骑', { tag: TIEJI_TAG })
  },
})

export const MENGJIN_SKILL = 'mengjin'

/**
 * 庞德【猛进】：你使用的【杀】被【闪】抵消后，可以弃置一张牌，然后弃置该角色的一张牌。
 *
 * 经典火包版，带「弃置一张牌」的代价。
 *
 * 挂在「杀被闪抵消后」这个时机上——贯石斧和青龙偃月刀走的是同一条链，
 * 所以这里不需要新造时机，只是往链上再加一环。
 */
export function askMengjin(host: SkillHost, facts: DodgedSlashFacts): boolean {
  if (host.state.skillResolution) return false
  const source = host.state.players.find((player) => player.id === facts.sourceId)
  const target = host.state.players.find((player) => player.id === facts.targetId)
  if (!source?.alive || !target?.alive || !source.characterId) return false
  if (!skillIdsProvider?.(source.characterId).includes(MENGJIN_SKILL)) return false
  // 自己没牌可弃、或者对方没牌可拆，都发动不了
  if (discardableCards(host.state, facts.sourceId).length === 0) return false
  if (discardableCards(host.state, facts.targetId).length === 0) return false

  host.askSkill({
    skillId: MENGJIN_SKILL,
    ownerId: facts.sourceId,
    step: 'ask',
    data: { ...facts },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      playerId: facts.sourceId,
      prompt: `发动【猛进】？弃置一张牌，然后弃置 ${target.nickname} 的一张牌`,
      timeoutMs: 20_000,
      optional: true,
      options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
    }),
  })
  return true
}

registerSkillRuntime({
  id: MENGJIN_SKILL,
  resume(host, _ownerId, resolution, response) {
    const facts = resolution.data as unknown as DodgedSlashFacts
    const bail = () => { callbacks?.continueSlash(host) }

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') return bail()
      const pool = discardableCards(host.state, facts.sourceId)
      // 发问期间牌可能已经没了，重新确认
      if (pool.length === 0) return bail()
      host.askSkill({
        skillId: MENGJIN_SKILL,
        ownerId: facts.sourceId,
        step: 'cost',
        data: { ...facts },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: facts.sourceId,
          prompt: '【猛进】：弃置自己的一张牌',
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds: pool,
          hiddenCardSlots: [],
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'cost') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      const from = locateOwnedCard(host.state, facts.sourceId, cardId)
      if (!from) return bail()
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') {
        host.dispatch('LoseEquipment', { playerId: facts.sourceId, cardId, slot: from.slot }, { targetId: facts.sourceId, cardIds: [cardId] })
      }
      const target = host.state.players.find((player) => player.id === facts.targetId)
      if (!target?.alive) return bail()
      if (!hasPickableCards(host.state, facts.targetId)) return bail()
      // 手牌是暗的，只给占位槽——不能让庞德先看见点数花色再挑。
      // 这条隐私规则由 engine/card-pick.ts 统一负责，烈刃用的是同一份。
      const pickable = pickableCardsOf(host.state, facts.targetId)
      host.askSkill({
        skillId: MENGJIN_SKILL,
        ownerId: facts.sourceId,
        step: 'pick',
        data: { ...facts },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: facts.sourceId,
          prompt: `【猛进】：弃置 ${target.nickname} 的一张牌`,
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds: pickable.cardIds,
          hiddenCardSlots: pickable.hiddenCardSlots,
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick') {
      const target = host.state.players.find((player) => player.id === facts.targetId)
      if (!target?.alive) return bail()
      const [picked] = (response.payload as { cardIds: string[] }).cardIds
      const realId = resolvePickedCard(host.state, facts.targetId, picked)
      if (realId) movePickedCard(host, facts.targetId, realId, { kind: 'discardPile' })
      return bail()
    }
  },
})

export const LIULI_SKILL = 'liuli'

/**
 * 大乔【流离】：成为【杀】的目标时，弃一张牌把这张【杀】转给攻击范围内的另一名角色。
 *
 * 放在这里而不是武将数据里，是因为它要改 `cardResolution.targetId`——
 * 那是杀的结算状态，和雌雄双股剑走同一个插入点、同一套恢复路径。
 *
 * 返回 true 表示已经问出去了。
 */
export function askSlashTransfer(host: SkillHost, sourceId: PlayerId, targetId: PlayerId): boolean {
  if (host.state.skillResolution) return false
  const target = host.state.players.find((player) => player.id === targetId)
  if (!target?.alive || !target.characterId) return false
  if (!skillIdsProvider?.(target.characterId).includes('liuli')) return false
  // 手上一张牌都没有就弃不出去
  if (discardableCards(host.state, targetId).length === 0) return false
  if (transferCandidates(host.state, sourceId, targetId).length === 0) return false

  host.askSkill({
    skillId: LIULI_SKILL,
    ownerId: targetId,
    step: 'ask',
    data: { sourceId, targetId },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      playerId: targetId,
      prompt: '发动【流离】？弃置一张牌，把这张【杀】转给你攻击范围内的另一名角色',
      timeoutMs: 20_000,
      optional: true,
      options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
    }),
  })
  return true
}

/** 流离能转给谁：自己攻击范围内、不是【杀】的使用者、也不是自己。 */
function transferCandidates(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): PlayerId[] {
  if (!canTargetProvider) return []
  return state.players
    .filter((player) => player.alive && player.id !== targetId && player.id !== sourceId)
    .filter((player) => canTargetProvider!(state, targetId, player.id))
    .map((player) => player.id)
}

let skillIdsProvider: ((characterId: string) => string[]) | null = null
let canTargetProvider: ((state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId) => boolean) | null = null

/** 技能表和攻击范围计算都在别处，运行时回注，避免形成 import 环。 */
export function provideSkillLookup(
  skillIdsOf: (characterId: string) => string[],
  canTarget: (state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId) => boolean,
): void {
  skillIdsProvider = skillIdsOf
  canTargetProvider = canTarget
}

registerSkillRuntime({
  id: LIULI_SKILL,
  resume(host, _ownerId, resolution, response) {
    const sourceId = resolution.data.sourceId as PlayerId
    const targetId = resolution.data.targetId as PlayerId

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') {
        callbacks?.resumeSlashAfterEquipment(host)
        return
      }
      const pool = discardableCards(host.state, targetId)
      if (pool.length === 0) {
        callbacks?.resumeSlashAfterEquipment(host)
        return
      }
      host.askSkill({
        skillId: LIULI_SKILL,
        ownerId: targetId,
        step: 'discard',
        data: { sourceId, targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: targetId,
          prompt: '【流离】：弃置一张牌',
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds: pool,
          hiddenCardSlots: [],
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      discardOwnCard(host, targetId, cardId, '流离')
      const candidateIds = transferCandidates(host.state, sourceId, targetId)
      if (candidateIds.length === 0) {
        // 弃牌之后没人可转（有人死了）：这张【杀】仍然落在自己身上
        callbacks?.resumeSlashAfterEquipment(host)
        return
      }
      host.askSkill({
        skillId: LIULI_SKILL,
        ownerId: targetId,
        step: 'target',
        data: { sourceId, targetId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId,
          kind: 'choose-targets',
          playerId: targetId,
          prompt: '【流离】：把这张【杀】转给谁',
          timeoutMs: 20_000,
          optional: false,
          candidateIds,
          min: 1,
          max: 1,
        }),
      })
      return
    }

    const [newTargetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
    callbacks?.transferSlashTarget(host, newTargetId)
  },
})

/** 弃掉自己区域里的一张牌（手牌或装备）。 */
function discardOwnCard(host: SkillHost, playerId: PlayerId, cardId: CardId, reason: string): void {
  const owner = playerOf(host.state, playerId)
  if (owner.zones.hand.includes(cardId)) {
    moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  } else {
    const slot = (Object.keys(owner.zones.equipment) as Array<keyof typeof owner.zones.equipment>)
      .find((key) => owner.zones.equipment[key] === cardId)
    if (!slot) throw new Error(`${reason}弃置的牌不在自己的区域里`)
    moveCard(host.state, cardId, { kind: 'equipment', playerId, slot }, { kind: 'discardPile' })
  }
  host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason }, { sourceId: playerId, cardIds: [cardId] })
}


export const LIJIAN_SKILL = 'lijian'

/**
 * 貂蝉【离间】：出牌阶段限一次，弃一张牌，令两名男性角色进行【决斗】。
 *
 * 规则上这是一次「视为使用」的决斗，没有实体牌。这里用**被弃置的那张牌**
 * 作为载体走正常的锦囊结算——两者的可观察差别只有一处：
 * 那张牌会被当成「造成伤害的牌」，所以曹操【奸雄】可能把它拿走。
 * 用真正的虚拟牌需要给结算加一套无实体牌的路径，暂时不值得。
 */
registerSkillRuntime({
  id: LIJIAN_SKILL,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, LIJIAN_SKILL)) return []
    if (discardableCards(state, ownerId).length === 0) return []
    if (maleTargets(state, ownerId).length < 2) return []
    return [{ id: 'skill:lijian', label: '发动【离间】：弃一张牌，令两名男性角色决斗' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:lijian') throw new Error('离间动作不匹配')
    host.askSkill({
      skillId: LIJIAN_SKILL,
      ownerId,
      step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: ownerId,
        prompt: '【离间】：弃置一张牌',
        timeoutMs: 20_000,
        optional: false,
        purpose: 'skill',
        cardIds: discardableCards(host.state, ownerId),
        hiddenCardSlots: [],
        min: 1,
        max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      const candidateIds = maleTargets(host.state, ownerId)
      if (candidateIds.length < 2) return
      markUsedThisTurn(host.state, ownerId, LIJIAN_SKILL)
      // 这张牌先留在原处，等选完目标再作为决斗的载体打出去
      host.askSkill({
        skillId: LIJIAN_SKILL,
        ownerId,
        step: 'targets',
        data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId,
          kind: 'choose-targets',
          playerId: ownerId,
          prompt: '【离间】：选择两名男性角色，第一名视为对第二名使用【决斗】',
          timeoutMs: 25_000,
          optional: false,
          candidateIds,
          min: 2,
          max: 2,
        }),
      })
      return
    }

    const cardId = resolution.data.cardId as CardId
    const [attackerId, victimId] = (response.payload as { targetIds: PlayerId[] }).targetIds
    const attacker = host.state.players.find((player) => player.id === attackerId)
    const victim = host.state.players.find((player) => player.id === victimId)
    if (!attacker?.alive || !victim?.alive) return
    callbacks?.startVirtualTrick(host, attackerId, victimId, cardId, '决斗', ownerId)
  },
})

/** 离间能选的目标：存活的男性角色，不含貂蝉自己。 */
function maleTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((player) => player.alive && player.id !== ownerId)
    .filter((player) => effectiveGenderOf(state, player.id) === 'male')
    .map((player) => player.id)
}

export const ZHANGBA_SKILL = 'equip:zhangba'
export const FANGTIAN_SKILL = 'equip:fangtian'

/**
 * 装备在出牌阶段能主动发动的效果。
 *
 * 丈八蛇矛（两张手牌当一张【杀】）和方天画戟（最后一张手牌指定多名角色）
 * 如果按组合枚举成动作，6 张手牌配 4 个目标就是 60 条，界面上选中一张牌
 * 会冒出 20 个按钮，手机上根本没法用。所以做成和主动技一样的两步交互。
 */
export function equipmentPlayActions(
  state: SanguoshaState,
  playerId: PlayerId,
): Array<{ id: string; label: string; skillId: string }> {
  if (!slashAvailable?.(state, playerId)) return []
  const owner = state.players.find((player) => player.id === playerId)
  if (!owner?.alive) return []
  const options: Array<{ id: string; label: string; skillId: string }> = []

  // 两条都要先确认「这一刀打得到人」。
  //
  // 不查的话会产生一条**什么也不做的合法动作**：invokeActive 发现没有目标就
  // 静默返回，状态没变，同一条动作下一轮还在——AI 会原地无限点下去。
  // 压测抓到过一次方天画戟连点 19734 次的死锁，就是这么来的。
  const canReachSomeone = (slashTargets?.(state, playerId) ?? []).length > 0

  if (hasWeapon(state, playerId, '丈八蛇矛') && owner.zones.hand.length >= 2 && canReachSomeone) {
    options.push({ id: 'skill:zhangba', label: '发动【丈八蛇矛】：两张手牌当一张【杀】使用', skillId: ZHANGBA_SKILL })
  }
  if (hasWeapon(state, playerId, '方天画戟')
    && owner.zones.hand.length === 1
    && state.cards[owner.zones.hand[0]]?.name === '杀'
    && canReachSomeone) {
    options.push({ id: 'skill:fangtian', label: '发动【方天画戟】：最后一张【杀】可以指定至多三名角色', skillId: FANGTIAN_SKILL })
  }
  return options
}

/** 出杀次数和目标合法性都在别处算，运行时回注。 */
let slashAvailable: ((state: SanguoshaState, playerId: PlayerId) => boolean) | null = null
let slashTargets: ((state: SanguoshaState, playerId: PlayerId) => PlayerId[]) | null = null

export function provideSlashLookup(
  available: (state: SanguoshaState, playerId: PlayerId) => boolean,
  targets: (state: SanguoshaState, playerId: PlayerId) => PlayerId[],
): void {
  slashAvailable = available
  slashTargets = targets
}

registerSkillRuntime({
  id: ZHANGBA_SKILL,
  invokeActive(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    host.askSkill({
      skillId: ZHANGBA_SKILL,
      ownerId,
      step: 'cards',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: ownerId,
        prompt: '【丈八蛇矛】：选择两张手牌当作一张【杀】',
        timeoutMs: 25_000,
        optional: false,
        purpose: 'skill',
        cardIds: [...owner.zones.hand],
        hiddenCardSlots: [],
        min: 2,
        max: 2,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cards') {
      const cardIds = (response.payload as { cardIds: CardId[] }).cardIds
      const candidateIds = slashTargets?.(host.state, ownerId) ?? []
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: ZHANGBA_SKILL,
        ownerId,
        step: 'target',
        data: { cardIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId,
          kind: 'choose-targets',
          playerId: ownerId,
          prompt: '【丈八蛇矛】：选择【杀】的目标',
          timeoutMs: 20_000,
          optional: false,
          candidateIds,
          min: 1,
          max: 1,
        }),
      })
      return
    }
    const cardIds = resolution.data.cardIds as CardId[]
    const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds
    const owner = playerOf(host.state, ownerId)
    // 发问期间牌可能已经没了，这里必须重新确认
    if (cardIds.some((cardId) => !owner.zones.hand.includes(cardId))) return
    callbacks?.beginSlashFromAction(host, ownerId, cardIds, targetIds)
  },
})

registerSkillRuntime({
  id: FANGTIAN_SKILL,
  invokeActive(host, ownerId) {
    const candidateIds = slashTargets?.(host.state, ownerId) ?? []
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: FANGTIAN_SKILL,
      ownerId,
      step: 'targets',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId,
        kind: 'choose-targets',
        playerId: ownerId,
        prompt: '【方天画戟】：选择至多三名角色',
        timeoutMs: 25_000,
        optional: false,
        candidateIds,
        min: 1,
        max: Math.min(3, candidateIds.length),
      }),
    })
  },
  resume(host, ownerId, _resolution, response) {
    const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds
    const owner = playerOf(host.state, ownerId)
    const [lastCard] = owner.zones.hand
    // 前提是「最后一张手牌」，发问期间手牌变了就作废
    if (owner.zones.hand.length !== 1 || host.state.cards[lastCard]?.name !== '杀') return
    callbacks?.beginSlashFromAction(host, ownerId, [lastCard], targetIds)
  },
})
