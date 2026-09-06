import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { isSkillSuppressed } from '@/sanguosha/engine/skill-suppression'
import { isLockedSkill } from '@/sanguosha/engine/locked-skills'
import { resolveDamage } from '@/sanguosha/engine/damage'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·马超。
 *
 * 四条主张，逐条有断言：
 *
 * - 【驭雳】改属性排在藤甲、狂风、大雾**之前**，所以那些效果读到的是改完之后的属性；
 * - 防止雷伤是「**没有发生**」，不是「扣了再补」——「受到伤害后」那批时机一个都不跑；
 * - 【霆威】压的是「**非锁定技**」这个条件，期间新拿到的非锁定技也一并失效，锁定技不受影响；
 * - 那个 +1 只属于**这张【杀】对这一名目标**，别的目标和别的牌都不沾。
 */

/** p1 用关羽：【武圣】是非锁定技，压制那条要拿它来看。 */
const CAST = ['shenmachao', 'guanyu', 'zhaoyun', 'huangzhong', 'zhangfei']

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
      }
      case 'choose-options': {
        const pick = request as unknown as { options: { id: string }[]; min: number }
        return { optionIds: pick.options.slice(0, pick.min ?? 0).map((option) => option.id) }
      }
      case 'choose-cards': {
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
        return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
      }
      case 'choose-targets': {
        const pick = request as unknown as { candidateIds: string[]; min: number }
        return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
      }
      case 'arrange-cards': {
        const pick = request as unknown as { cardIds: string[] }
        return { top: [...pick.cardIds], bottom: [] }
      }
      case 'rescue': return { actionId: 'rescue-pass' }
      default: return { actionId: 'respond-pass' }
    }
  })()
  return { requestId: request.id, playerId: request.playerId, payload }
}

function settle(
  game: SanguoshaGame,
  choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const custom = choose(request)
    game.respond(custom
      ? { requestId: request.id, playerId: request.playerId, payload: custom }
      : defaultResponse(request))
  }
  throw new Error('结算没有收敛')
}

function gameAt(seed: string, characterIds: string[] = CAST): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  settle(game)
  while (game.state.phase !== 'play') game.advancePhase()
  return game
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

/** 从牌堆或弃牌堆里拿一张闲置的牌塞给某人，不去抢别人手上的。 */
function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error('牌堆里没有闲置的【' + cardName + '】')
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

/**
 * 直接把诸葛连弩装到装备槽里。
 *
 * 一个出牌阶段要连打两张【杀】的用例才需要它——神马超自己没有无限杀，
 * 第二张会因为出杀次数用完而根本不在合法动作里，那不是被测的东西。
 */
function equipCrossbow(game: SanguoshaGame, playerId: string): void {
  const cardId = giveCard(game, playerId, '诸葛连弩')
  moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'equipment', playerId, slot: 'weapon' })
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 神马超对某人打一张真实的【杀】，途中的选择交给 choose 决定。 */
function slash(
  game: SanguoshaGame,
  targetId: string,
  choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
): void {
  const cardId = giveCard(game, 'p0', '杀')
  // 合法动作里已经把目标枚举好了，直接挑「这张牌打这个人」那一条
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.asCardName === '杀'
    && candidate.cardIds.includes(cardId)
    && candidate.targetIds.includes(targetId))
  if (!action) throw new Error('没有可用的【杀】动作')
  game.act('p0', action.id)
  settle(game, choose)
}

describe('神·马超：驭雳', () => {
  it('普通伤害改成雷电，而且不额外 +1', () => {
    const game = gameAt('mc-yuli-normal')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    const natures: string[] = []
    game.events.on('Damaged', (handled) => { natures.push(handled.event.damageNature ?? 'normal') })

    slash(game, 'p1', (request) => (request.kind === 'choose-option' && request.prompt?.includes('霆威')
      ? { optionId: 'cancel' }
      : null))

    expect(natures, '一次伤害，属性是雷电').toEqual(['thunder'])
    expect(target.maxHp - target.hp, '数值仍然是 1，不因为改属性而变大').toBe(1)
  })

  it('本来就是雷电伤害则 +1', () => {
    const game = gameAt('mc-yuli-thunder')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    const amounts: number[] = []
    game.events.on('Damaged', (handled) => { amounts.push(Number(handled.event.payload.amount)) })

    // 技能发起的雷【杀】：属性本来就是雷电
    game.beginVirtualSlash({ sourceId: 'p0', targetId: 'p1', sourceSkillId: 'test', nature: 'thunder' })
    settle(game, (request) => (request.kind === 'choose-option' && request.prompt?.includes('霆威')
      ? { optionId: 'cancel' }
      : null))

    expect(amounts, '雷电 1 变成雷电 2').toEqual([2])
  })

  it('受到雷电伤害时防止之并摸等量的牌，「受到伤害后」一个都不触发', () => {
    const game = gameAt('mc-yuli-prevent')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    const handBefore = owner.zones.hand.length
    const damaged: number[] = []
    game.events.on('Damaged', (handled) => { damaged.push(Number(handled.event.payload.amount)) })

    resolveDamage(game as never, { sourceId: 'p1', targetId: 'p0', amount: 3, nature: 'thunder' })
    game.settle()
    settle(game)

    expect(playerOf(game, 'p0').hp, '一点血都没掉').toBe(owner.maxHp)
    expect(damaged, '伤害没有发生，Damaged 一次都没派发').toEqual([])
    expect(playerOf(game, 'p0').zones.hand.length - handBefore, '摸等同于伤害值的牌').toBe(3)
    assertCardConservation(game.state)
  })
})

describe('神·马超：霆威', () => {
  /** 打一张【杀】并发动霆威，四项由 pick 决定。 */
  function tingwei(
    game: SanguoshaGame,
    targetId: string,
    pick: string[],
    choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
  ): void {
    slash(game, targetId, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('霆威')) return { optionId: 'invoke' }
      if (request.kind === 'choose-options') return { optionIds: pick }
      return choose(request)
    })
  }

  it('发动就是四枚「霆」，每执行一项由神马超付一枚', () => {
    const game = gameAt('mc-tingwei-cost')
    tingwei(game, 'p1', ['suppress'])
    expect(playerOf(game, 'p0').marks.ting, '四枚进账，一项出账').toBe(3)
    expect(playerOf(game, 'p1').marks.ting, '付霆的是神马超，不是目标').toBeUndefined()
  })

  it('一项都不选就横置；已经横置的继续横置，不会被解除', () => {
    const game = gameAt('mc-tingwei-chain')
    equipCrossbow(game, 'p0')
    /*
     * 让目标把【杀】闪掉。
     *
     * 不闪的话这一下是雷电伤害（【驭雳】改的），而雷电伤害打在横置角色身上
     * 会触发连环传导，传导前全场横置会被解除——那是铁索的规则，
     * 不是「霆威把横置又取消了」。这条用例要看的是霆威本身。
     */
    const dodge = (request: AnyRequest) => {
      if (request.kind !== 'respond-card') return null
      const actionIds = (request as unknown as { actionIds: string[] }).actionIds
      const play = actionIds.find((actionId) => actionId !== 'respond-pass')
      return play ? { actionId: play } : null
    }
    giveCard(game, 'p1', '闪')
    tingwei(game, 'p1', [], dodge)
    expect(playerOf(game, 'p1').chained, '一项都不选 → 横置').toBe(true)
    expect(playerOf(game, 'p0').marks.ting, '四枚全留着').toBe(4)

    giveCard(game, 'p1', '闪')
    tingwei(game, 'p1', [], dodge)
    expect(playerOf(game, 'p1').chained, '再来一次仍然是横置，不是切换回去').toBe(true)
  })

  it('失效的是「非锁定技」这个条件：锁定技照常，期间新拿到的非锁定技也失效', () => {
    const game = gameAt('mc-tingwei-suppress')
    // p1 是关羽：【武圣】是非锁定技
    expect(isLockedSkill('wusheng'), '武圣不是锁定技').toBe(false)
    expect(isLockedSkill('paoxiao'), '咆哮是锁定技').toBe(true)
    tingwei(game, 'p1', ['suppress'])

    expect(isSkillSuppressed(game.state, 'p1', 'wusheng'), '非锁定技失效').toBe(true)
    // 压的是条件，所以锁定技无论落在谁身上都不受影响
    expect(isSkillSuppressed(game.state, 'p1', 'paoxiao'), '锁定技不受影响').toBe(false)
    /*
     * 关键的一半：压的是条件，不是名单。**期间新获得的非锁定技一样失效**——
     * 只快照当前技能 id 的话这条会漏。
     */
    playerOf(game, 'p1').grantedSkills.push('guanxing')
    expect(isSkillSuppressed(game.state, 'p1', 'guanxing'), '新拿到的非锁定技也失效').toBe(true)
  })

  it('那个 +1 只属于这张【杀】对这一名目标', () => {
    const game = gameAt('mc-tingwei-bonus')
    equipCrossbow(game, 'p0')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    const amounts: number[] = []
    game.events.on('Damaged', (handled) => { amounts.push(Number(handled.event.payload.amount)) })

    tingwei(game, 'p1', ['damage'])
    expect(amounts, '这一下是 1 + 1').toEqual([2])
    expect(playerOf(game, 'p0').marks['ting'], '只付了一枚').toBe(3)

    // 下一张【杀】不该沾上一次的加成
    amounts.length = 0
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    slash(game, 'p1', (request) => (request.kind === 'choose-option' && request.prompt?.includes('霆威')
      ? { optionId: 'cancel' }
      : null))
    expect(amounts, '加成用完就收，下一张【杀】还是 1 点').toEqual([1])
  })

  it('交出的装备可以来自装备区，交完在神马超手里', () => {
    const game = gameAt('mc-tingwei-equipment')
    const weapon = giveCard(game, 'p1', '青龙偃月刀')
    moveCard(game.state, weapon, { kind: 'hand', playerId: 'p1' }, { kind: 'equipment', playerId: 'p1', slot: 'weapon' })
    trimHand(game, 'p1', 0)

    tingwei(game, 'p1', ['equipment'])
    expect(playerOf(game, 'p0').zones.hand, '装备进了神马超手里').toContain(weapon)
    expect(playerOf(game, 'p1').zones.equipment.weapon, '目标的装备槽空了').toBeNull()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('随机弃牌用的是牌局自己的种子：同一个种子弃的是同一张', () => {
    const picked = new Set<string>()
    for (let round = 0; round < 2; round += 1) {
      const game = gameAt('mc-tingwei-discard')
      trimHand(game, 'p1', 3)
      const before = [...playerOf(game, 'p1').zones.hand]
      tingwei(game, 'p1', ['discard'])
      const after = playerOf(game, 'p1').zones.hand
      const gone = before.filter((cardId) => !after.includes(cardId))
      expect(gone, '正好弃掉一张').toHaveLength(1)
      picked.add(gone[0])
    }
    expect(picked.size, '同一个种子跑两遍，弃的是同一张').toBe(1)
  })
})

describe('神·马超：寂灭', () => {
  /** 直接把霆记到位，跳过攒霆的过程。 */
  function withTing(game: SanguoshaGame, count: number): void {
    playerOf(game, 'p0').marks.ting = count
  }

  /** 推进到出牌阶段结束。 */
  function endPlayPhase(game: SanguoshaGame): void {
    game.advancePhase()
  }

  it('霆不够八枚时根本不问', () => {
    const game = gameAt('mc-jiemie-not-enough')
    withTing(game, 7)
    const prompts: string[] = []
    endPlayPhase(game)
    settle(game, (request) => { prompts.push(request.prompt ?? ''); return null })
    expect(prompts.some((prompt) => prompt.includes('寂灭')), '七枚不够').toBe(false)
  })

  it('八枚可以发动：扣八枚，伤害等于目标的体力上限', () => {
    const game = gameAt('mc-jiemie-damage')
    withTing(game, 8)
    const target = playerOf(game, 'p1')
    target.hp = 2
    const amounts: number[] = []
    game.events.on('Damaged', (handled) => { amounts.push(Number(handled.event.payload.amount)) })

    endPlayPhase(game)
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('寂灭')) return { optionId: 'invoke' }
      if (request.kind === 'choose-targets' && request.prompt?.includes('寂灭')) return { targetIds: ['p1'] }
      return null
    })

    /*
     * 伤害值看的是**体力上限**，不是当前体力：目标 2/4 时是 4 点，不是 2 点。
     * 属性由【驭雳】从普通改成雷电，因为原本不是雷电，所以不再额外 +1。
     */
    expect(amounts, '等于体力上限').toEqual([target.maxHp])
    expect(playerOf(game, 'p0').marks.ting, '扣掉八枚').toBe(0)
    expect(playerOf(game, 'p0').usedLimitedSkills, '限定技记账').toContain('jiemie')
  })

  it('限定技：没重置之前不会再问第二次', () => {
    const game = gameAt('mc-jiemie-once')
    withTing(game, 16)
    playerOf(game, 'p0').usedLimitedSkills.push('jiemie')
    const prompts: string[] = []
    endPlayPhase(game)
    settle(game, (request) => { prompts.push(request.prompt ?? ''); return null })
    expect(prompts.some((prompt) => prompt.includes('寂灭')), '用过就不再问').toBe(false)
  })

  it('两半都各生效过一次才重置，缺一半不算', () => {
    const game = gameAt('mc-jiemie-reset')
    const owner = playerOf(game, 'p0')
    owner.usedLimitedSkills.push('jiemie')
    owner.marks['yuli-part1'] = 1

    // 只有一半：回合结束时不该重置
    for (let guard = 0; guard < 12 && game.state.currentPlayerId === 'p0'; guard += 1) {
      game.advancePhase()
      settle(game)
    }
    expect(playerOf(game, 'p0').usedLimitedSkills, '只有一半，不重置').toContain('jiemie')

    playerOf(game, 'p0').marks['yuli-part2'] = 1
    // 再走一整轮回到他的回合结束
    for (let guard = 0; guard < 80 && playerOf(game, 'p0').usedLimitedSkills.includes('jiemie'); guard += 1) {
      if (game.state.status !== 'playing') break
      game.advancePhase()
      settle(game)
    }
    expect(playerOf(game, 'p0').usedLimitedSkills, '两半齐了就重置').not.toContain('jiemie')
  })
})
