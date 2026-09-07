import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { flipCharacter, setChained } from '@/sanguosha/engine/character-state'
import { damageIsFromTrick, isBasicCard, nonBasicCardsOf } from '@/sanguosha/engine/damage-provenance'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 徐庶（一将成名 2011 · 2015 合并后的经典版）。
 *
 * 六条主张，逐条有断言：
 *
 * - 【无言】认的是「这次伤害挂在哪张牌上」，不是「谁造成的」；
 * - 他用的锦囊打不出伤害，别人的锦囊也伤不到他；【闪电】算锦囊伤害；
 * - 技能伤害不被误防；
 * - 防止 ≠ 改成 0 点：连环不传导、「受到伤害后」的时机一个都不跑；
 * - 【举荐】的代价是**非基本牌**，手牌和装备区都算，判定区不算；
 * - 三选一由**目标本人**决定；「复原武将牌」= 翻回正面 + 解除横置。
 */

const CAST = ['xushu', 'zhangfei', 'xiahoudun', 'huangzhong', 'guojia']

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
  while (game.state.phase !== 'play') {
    game.advancePhase()
    settle(game)
  }
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
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as never }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的【${cardName}】`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  for (const cardId of playerOf(game, playerId).zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 造成一次伤害，返回目标实际掉了几点、以及「受到伤害后」的时机跑了没有。 */
function hit(
  game: SanguoshaGame,
  options: { sourceId: string | null; targetId: string; cardName?: string | null; nature?: 'normal' | 'fire' | 'thunder' },
) {
  const before = playerOf(game, options.targetId).hp
  const damaged: string[] = []
  const off = game.events.on('Damaged', (handled) => { damaged.push(String(handled.event.targetId)) })
  resolveDamage(game as never, {
    sourceId: options.sourceId,
    targetId: options.targetId,
    amount: 1,
    nature: options.nature ?? 'normal',
    cardName: options.cardName ?? null,
  })
  game.settle()
  settle(game)
  off?.()
  return { delta: before - playerOf(game, options.targetId).hp, damaged }
}

describe('徐庶：无言', () => {
  it('他使用的锦囊造不成伤害', () => {
    const game = gameAt('xs-out')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    const result = hit(game, { sourceId: 'p0', targetId: 'p1', cardName: '决斗' })
    expect(result.delta, '决斗的伤害被防止').toBe(0)
    expect(result.damaged, '一次伤害事件都没有').toEqual([])
  })

  it('别人的锦囊也伤不到他', () => {
    for (const [seed, cardName] of [['xs-in-duel', '决斗'], ['xs-in-nanman', '南蛮入侵'], ['xs-in-wanjian', '万箭齐发'], ['xs-in-huogong', '火攻']] as const) {
      const game = gameAt(seed)
      const owner = playerOf(game, 'p0')
      owner.hp = owner.maxHp
      const result = hit(game, { sourceId: 'p1', targetId: 'p0', cardName, nature: cardName === '火攻' ? 'fire' : 'normal' })
      expect(result.delta, `${cardName} 伤不到他`).toBe(0)
    }
  })

  it('【闪电】造成的伤害也算锦囊伤害', () => {
    const game = gameAt('xs-lightning')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    const result = hit(game, { sourceId: null, targetId: 'p0', cardName: '闪电', nature: 'thunder' })
    expect(result.delta, '闪电的雷伤被防止').toBe(0)
  })

  it('【杀】照常打进来：基本牌不是锦囊牌', () => {
    const game = gameAt('xs-slash')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    const result = hit(game, { sourceId: 'p1', targetId: 'p0', cardName: '杀' })
    expect(result.delta, '杀不是锦囊').toBe(1)
  })

  it('技能造成的伤害不被误防：它不归属于任何一张牌', () => {
    const game = gameAt('xs-skill-damage')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    const result = hit(game, { sourceId: 'p1', targetId: 'p0', cardName: null })
    expect(result.delta, '没有来源牌的伤害照常打进来').toBe(1)
  })

  it('防止不是「改成 0 点」：连环不传导，也不触发受伤时机', () => {
    const game = gameAt('xs-chain')
    for (const id of ['p0', 'p2']) {
      const player = playerOf(game, id)
      player.hp = player.maxHp
      player.chained = true
    }
    // p2 是夏侯惇（刚烈），靠「受到伤害后」吃饭
    const skills: string[] = []
    game.events.on('SkillActivated', (handled) => {
      const skillId = (handled.event.payload as { skillId?: string }).skillId
      if (skillId) skills.push(skillId)
    })
    const result = hit(game, { sourceId: 'p1', targetId: 'p0', cardName: '火攻', nature: 'fire' })
    expect(result.delta, '徐庶没掉血').toBe(0)
    expect(playerOf(game, 'p2').hp, '连环上的另一个人没有被传导').toBe(playerOf(game, 'p2').maxHp)
    expect(playerOf(game, 'p0').chained, '连环也没被解除——根本没有属性伤害发生').toBe(true)
    expect(skills, '无言确实报了一行').toContain('wuyan')
    assertGameInvariants(game.state)
  })

  it('无言 × 绝情：只产生一条结果，不会既防止又扣血', () => {
    // p1 是张春华（绝情）：她用锦囊打徐庶
    const game = gameAt('xs-jueqing', ['xushu', 'zhangchunhua', 'xiahoudun', 'huangzhong', 'guojia'])
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    const lost: number[] = []
    game.events.on('LoseHp', (handled) => {
      if (handled.event.targetId === 'p0') lost.push(Number(handled.event.payload.amount))
    })
    const result = hit(game, { sourceId: 'p1', targetId: 'p0', cardName: '决斗' })
    /*
     * 绝情排在**无言之前**：伤害先被整个换成失去体力，
     * 换完之后已经不存在「一次伤害」，无言也就没有可防的东西。
     * 断言守的是「只结算一次」：掉的血正好等于失去体力的点数。
     */
    expect(result.damaged, '没有伤害事件').toEqual([])
    expect(lost, '换成了等量的失去体力').toEqual([1])
    expect(result.delta, '总共只掉 1 点').toBe(1)
  })
})

describe('徐庶：非基本牌的判定', () => {
  it('杀闪桃酒是基本牌，锦囊和装备不是', () => {
    const game = gameAt('xs-category')
    for (const name of ['杀', '闪', '桃']) {
      const cardId = giveCard(game, 'p0', name)
      expect(isBasicCard(game.state, cardId), `${name} 是基本牌`).toBe(true)
    }
    for (const name of ['决斗', '青龙偃月刀', '乐不思蜀']) {
      const cardId = giveCard(game, 'p0', name)
      expect(isBasicCard(game.state, cardId), `${name} 不是基本牌`).toBe(false)
    }
  })

  it('可作代价的范围是手牌 + 装备区，不含判定区', () => {
    const game = gameAt('xs-cost-zones')
    trimHand(game, 'p0', 0)
    const weapon = giveCard(game, 'p0', '青龙偃月刀')
    moveCard(game.state, weapon, { kind: 'hand', playerId: 'p0' }, { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    const judged = giveCard(game, 'p0', '乐不思蜀')
    moveCard(game.state, judged, { kind: 'hand', playerId: 'p0' }, { kind: 'judgingArea', playerId: 'p0' })
    const inHand = giveCard(game, 'p0', '决斗')
    giveCard(game, 'p0', '桃')

    const options = nonBasicCardsOf(game.state, 'p0')
    expect(options, '手牌里的锦囊算').toContain(inHand)
    expect(options, '装备区的装备算').toContain(weapon)
    expect(options, '判定区的牌不算').not.toContain(judged)
    expect(options.every((cardId) => !isBasicCard(game.state, cardId)), '一张基本牌都没有').toBe(true)
  })

  it('伤害来源牌的类别判断认的是有效牌名', () => {
    const game = gameAt('xs-provenance')
    const duel = giveCard(game, 'p0', '决斗')
    const slash = giveCard(game, 'p0', '杀')
    expect(damageIsFromTrick(game.state, { cardId: duel, cardName: null }), '实体锦囊').toBe(true)
    expect(damageIsFromTrick(game.state, { cardId: slash, cardName: null }), '实体基本牌').toBe(false)
    expect(damageIsFromTrick(game.state, { cardId: null, cardName: '火攻' }), '只有牌名的虚拟锦囊').toBe(true)
    expect(damageIsFromTrick(game.state, { cardId: null, cardName: null }), '什么都没有：不属于任何牌').toBe(false)
  })
})

/** 跑徐庶的结束阶段，按 plan 回答举荐。 */
function runJujian(game: SanguoshaGame, plan: { invoke: boolean; option?: 'draw' | 'recover' | 'restore'; targetId?: string }) {
  const seen = { costRequest: null as AnyRequest | null, choiceRequest: null as AnyRequest | null }
  game.dispatch('PhaseStart', { playerId: 'p0', phase: 'finish' }, { sourceId: 'p0', phase: 'finish' })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-cards' && request.prompt?.includes('举荐')) {
      seen.costRequest = request
      const pick = request as unknown as { cardIds: string[] }
      return { cardIds: plan.invoke ? pick.cardIds.slice(0, 1) : [] }
    }
    if (request.kind === 'choose-targets' && request.prompt?.includes('举荐')) {
      const pick = request as unknown as { candidateIds: string[] }
      const targetId = plan.targetId && pick.candidateIds.includes(plan.targetId) ? plan.targetId : pick.candidateIds[0]
      return { targetIds: [targetId] }
    }
    if (request.kind === 'choose-option' && request.prompt?.includes('举荐')) {
      seen.choiceRequest = request
      return { optionId: plan.option ?? 'draw' }
    }
    return null
  })
  return seen
}

describe('徐庶：举荐', () => {
  it('代价只能是非基本牌，选项里一张基本牌都没有', () => {
    const game = gameAt('xs-jujian-cost')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '桃')
    giveCard(game, 'p0', '决斗')
    const seen = runJujian(game, { invoke: false })
    const request = seen.costRequest as unknown as { cardIds: string[] }
    expect(request.cardIds.every((cardId) => !isBasicCard(game.state, cardId)), '只给非基本牌').toBe(true)
    expect(request.cardIds.length, '那张决斗在里面').toBeGreaterThan(0)
  })

  it('一张非基本牌都没有时不弹窗', () => {
    const game = gameAt('xs-jujian-nocost')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '桃')
    giveCard(game, 'p0', '杀')
    const seen = runJujian(game, { invoke: false })
    expect(seen.costRequest, '拿不出代价就不该问').toBeNull()
  })

  it('三选一是目标本人回答，不是徐庶', () => {
    const game = gameAt('xs-jujian-decider')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '决斗')
    const seen = runJujian(game, { invoke: true, targetId: 'p1', option: 'draw' })
    expect(seen.choiceRequest?.playerId, '问的是目标').toBe('p1')
  })

  it('选摸两张：真的摸两张', () => {
    const game = gameAt('xs-jujian-draw')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '决斗')
    const before = playerOf(game, 'p1').zones.hand.length
    runJujian(game, { invoke: true, targetId: 'p1', option: 'draw' })
    expect(playerOf(game, 'p1').zones.hand, '摸了两张').toHaveLength(before + 2)
    assertCardConservation(game.state)
  })

  it('选回血：回复 1 点，满血时也允许选、只是没有变化', () => {
    const game = gameAt('xs-jujian-recover')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '决斗')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp - 2
    runJujian(game, { invoke: true, targetId: 'p1', option: 'recover' })
    expect(playerOf(game, 'p1').hp, '回了 1 点').toBe(target.maxHp - 1)

    const full = gameAt('xs-jujian-recover-full')
    trimHand(full, 'p0', 0)
    giveCard(full, 'p0', '决斗')
    playerOf(full, 'p1').hp = playerOf(full, 'p1').maxHp
    const seen = runJujian(full, { invoke: true, targetId: 'p1', option: 'recover' })
    const options = (seen.choiceRequest as unknown as { options: { id: string }[] }).options
    expect(options.map((option) => option.id), '满血时三个选项都在').toContain('recover')
    expect(playerOf(full, 'p1').hp, '没有超过上限').toBe(playerOf(full, 'p1').maxHp)
  })

  it('选复原：翻回正面并解除横置，两件事一起做', () => {
    const game = gameAt('xs-jujian-restore')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '决斗')
    flipCharacter(game as never, 'p1', 'test', true)
    setChained(game as never, 'p1', 'test', true)
    expect(playerOf(game, 'p1').faceDown).toBe(true)
    expect(playerOf(game, 'p1').chained).toBe(true)
    runJujian(game, { invoke: true, targetId: 'p1', option: 'restore' })
    expect(playerOf(game, 'p1').faceDown, '翻回正面').toBe(false)
    expect(playerOf(game, 'p1').chained, '同时解除横置').toBe(false)
  })

  it('复原绕不过连环锁：神刘备仍然是横置的', () => {
    const game = gameAt('xs-jujian-jieying', ['xushu', 'shenliubei', 'xiahoudun', 'huangzhong', 'guojia'])
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '决斗')
    flipCharacter(game as never, 'p1', 'test', true)
    setChained(game as never, 'p1', 'test', true)
    runJujian(game, { invoke: true, targetId: 'p1', option: 'restore' })
    expect(playerOf(game, 'p1').faceDown, '翻面照常复原').toBe(false)
    expect(playerOf(game, 'p1').chained, '连环被技能锁住，复原解不开').toBe(true)
  })

  it('弃装备当代价时走统一的装备离场', () => {
    const game = gameAt('xs-jujian-equip')
    trimHand(game, 'p0', 0)
    const lion = giveCard(game, 'p0', '白银狮子')
    moveCard(game.state, lion, { kind: 'hand', playerId: 'p0' }, { kind: 'equipment', playerId: 'p0', slot: 'armor' })
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 2
    const lost: string[] = []
    game.events.on('LoseEquipment', (handled) => {
      lost.push(String((handled.event.payload as { cardId?: string }).cardId))
    })
    runJujian(game, { invoke: true, targetId: 'p1', option: 'draw' })
    expect(lost, '装备离场事件发出来了').toContain(lion)
    expect(playerOf(game, 'p0').hp, '白银狮子离场回 1 点').toBe(owner.maxHp - 1)
    assertCardConservation(game.state)
  })
})

describe('徐庶：版本锁', () => {
  it('只有【无言】【举荐】', () => {
    const character = getCharacter('xushu')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['wuyan', 'jujian'])
    expect(character.pack).toBe('yjcm2011')
    expect(character.maxHp).toBe(3)
    expect(character.kingdom).toBe('shu')
    expect(character.skills.find((skill) => skill.id === 'jujian')?.description, '举荐是三选一的那一版')
      .toContain('复原其武将牌')
  })
})
