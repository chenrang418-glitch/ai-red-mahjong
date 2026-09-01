import { registerSkillRuntime, type SkillHost } from './skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from './requests'
import type { CardId, DamageNature, PlayerId, SanguoshaState } from './types'
import { hasWeapon } from './equipment'
import { moveCard } from './zones'

/**
 * 需要向玩家发问的装备特效。
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
export interface EquipmentCallbacks {
  dealSlashDamage(host: SkillHost, facts: DodgedSlashFacts): void
  useExtraSlash(host: SkillHost, sourceId: PlayerId, targetId: PlayerId, cardId: CardId): void
  /** 雌雄双股剑那一步结束之后，回到正常的求闪流程。 */
  resumeSlashAfterEquipment(host: SkillHost): void
}

let callbacks: EquipmentCallbacks | null = null

export function provideEquipmentCallbacks(next: EquipmentCallbacks): void {
  callbacks = next
}

// —— 贯石斧 ——
registerSkillRuntime({
  id: GUANSHIFU_SKILL,
  resume(host, _ownerId, resolution, response) {
    const facts = resolution.data as unknown as DodgedSlashFacts
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') return
      const pool = discardableCards(host.state, facts.sourceId)
      // 发问期间牌可能已经被别人拿走了，这里必须重新确认
      if (pool.length < 2) return
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
    if (!target?.alive) return
    callbacks?.dealSlashDamage(host, facts)
  },
})

// —— 青龙偃月刀 ——
registerSkillRuntime({
  id: QINGLONGDAO_SKILL,
  resume(host, _ownerId, resolution, response) {
    const facts = resolution.data as unknown as DodgedSlashFacts
    const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
    // 空选就是放弃
    if (!cardId) return
    const owner = playerOf(host.state, facts.sourceId)
    if (!owner.alive || !owner.zones.hand.includes(cardId)) return
    if (host.state.cards[cardId]?.name !== '杀') return
    const target = host.state.players.find((player) => player.id === facts.targetId)
    if (!target?.alive) return
    callbacks?.useExtraSlash(host, facts.sourceId, facts.targetId, cardId)
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
        // 放弃发动：伤害照常
        if (target?.alive) callbacks?.dealSlashDamage(host, facts)
        return
      }
      if (!target?.alive) return
      askHanbingjianCard(host, facts, 1)
      return
    }

    const [picked] = (response.payload as { cardIds: string[] }).cardIds
    if (picked && target?.alive) discardForeignCard(host, facts.targetId, picked, '寒冰剑')
    const round = Number(resolution.data.round ?? 1)
    // 第二张：目标还有牌才继续问
    if (round === 1 && target?.alive && discardableCards(host.state, facts.targetId).length > 0) {
      askHanbingjianCard(host, facts, 2)
    }
  },
})

function askHanbingjianCard(host: SkillHost, facts: DodgedSlashFacts, round: number): void {
  const choices = foreignCardChoices(host.state, facts.targetId)
  if (choices.cardIds.length + choices.hiddenCardSlots.length === 0) return
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
 * 停在 `awaiting-equipment`，invariants 对这个阶段单独放行。
 *
 * 返回 true 表示已经问出去了，调用方不要再去求闪。
 */
export function askCixiongSword(host: SkillHost, sourceId: PlayerId, targetId: PlayerId): boolean {
  if (host.state.skillResolution) return false
  if (!hasWeapon(host.state, sourceId, '雌雄双股剑')) return false
  const source = host.state.players.find((player) => player.id === sourceId)
  const target = host.state.players.find((player) => player.id === targetId)
  if (!source?.alive || !target?.alive) return false
  const sourceGender = genderOf(source.characterId)
  const targetGender = genderOf(target.characterId)
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

let genderLookup: ((characterId: string) => 'male' | 'female' | undefined) | null = null

/** 性别表在武将数据那边，运行时回注，避免引擎反向依赖 data 层。 */
export function provideGenderLookup(lookup: (characterId: string) => 'male' | 'female' | undefined): void {
  genderLookup = lookup
}

function genderOf(characterId: string | null): 'male' | 'female' | undefined {
  return characterId ? genderLookup?.(characterId) : undefined
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
