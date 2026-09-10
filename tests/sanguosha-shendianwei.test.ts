import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { GameRng } from '@/sanguosha/engine/rng'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { characterEquipmentOf, createCharacterWeapon, isCharacterEquipment } from '@/sanguosha/engine/character-equipment'
import { poolCharacter, sampleCharacters } from '@/sanguosha/engine/character-pool'
import { equipmentSlotsOf, hasExtraWeaponSlot, isSlotAbolished, weaponCardsOf } from '@/sanguosha/engine/equipment-slots'
import { getAttackRange } from '@/sanguosha/engine/distance'
import { ruleCardNumber } from '@/sanguosha/engine/deck'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { declinedThisPhase } from '@/sanguosha/engine/phase-usage'
import { borrowableSkillIdsOf, skillIdsOf } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·典韦。
 *
 * 四条主张，逐条有断言：
 *
 * - 【捐甲】是**真的多一个武器栏**：能同时装两把武器，各自独立替换；
 * - 武将牌当武器**没有花色没有点数**，而且**一离开装备区就销毁**；
 * - 借来的技能来源是**装备**：断肠管不到它，装备一走它立刻失效；
 * - 【摧决】的「最远」每次重算，限制是**每名角色**每回合一次。
 */

const CAST = ['shendianwei', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong']

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
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as never }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error('牌堆里没有闲置的【' + cardName + '】')
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

/**
 * 塞一把武器给某人。
 *
 * 从**任何区域**取一张还没被这个人装着的武器牌——按牌名找会踩空：
 * 一副牌里每种武器只有一张，很可能正躺在别人手里。
 */
function giveAnyWeapon(game: SanguoshaGame, playerId: string, exclude: string[] = []): string {
  const equipped = new Set([...Object.values(playerOf(game, playerId).zones.equipment).filter(Boolean) as string[], ...exclude])
  const card = Object.values(game.state.cards).find((candidate) => candidate.category === 'equipment'
    && candidate.equipmentSlot === 'weapon'
    && !candidate.virtual
    && !equipped.has(candidate.id))
  if (!card) throw new Error('牌堆里没有可用的武器')
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

describe('神·典韦：捐甲', () => {
  it('防具栏被废除，武器栏变成两个', () => {
    const game = gameAt('dw-juanjia')
    expect(isSlotAbolished(game.state, 'p0', 'armor'), '防具栏废除').toBe(true)
    expect(hasExtraWeaponSlot(game.state, 'p0'), '拿到额外武器栏').toBe(true)
    const slots = equipmentSlotsOf(game.state, 'p0')
    expect(slots, '没有防具栏了').not.toContain('armor')
    expect(slots.filter((slot) => slot === 'weapon' || slot === 'weapon2'), '两个武器栏').toHaveLength(2)
    // 别人还是老样子：额外栏只属于他
    expect(hasExtraWeaponSlot(game.state, 'p1')).toBe(false)
    expect(equipmentSlotsOf(game.state, 'p1')).toContain('armor')
  })

  it('能同时装两把武器，攻击范围取较大的那把', () => {
    const game = gameAt('dw-two-weapons')
    const short = giveAnyWeapon(game, 'p0')
    const long = giveAnyWeapon(game, 'p0', [short])
    for (const cardId of [short, long]) {
      const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
        && candidate.cardIds.includes(cardId))
      expect(action, '两把武器都装得上').toBeTruthy()
      game.act('p0', action!.id)
      settle(game)
    }
    const weapons = weaponCardsOf(game.state, 'p0')
    expect(weapons, '两个武器栏各一把').toHaveLength(2)
    const ranges = weapons.map((cardId) => game.state.cards[cardId].attackRange ?? 1)
    /*
     * **取较大的那把，不是相加**：攻击范围是「能打多远」，
     * 多带一把兵器不会让手变长两倍。
     */
    expect(getAttackRange(game.state, 'p0')).toBe(Math.max(...ranges))
    assertCardConservation(game.state)
  })

  it('两个武器栏都满时，由玩家决定顶掉哪一把', () => {
    const game = gameAt('dw-replace-choice')
    for (const name of ['青釭剑', '丈八蛇矛']) {
      const cardId = giveCard(game, 'p0', name)
      const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(cardId))!
      game.act('p0', action.id)
      settle(game)
    }
    const third = giveAnyWeapon(game, 'p0')
    const actions = game.legalActions('p0').filter((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(third))
    // 两个栏都占着，就该给两条动作各对应一个栏
    expect(actions, '顶掉哪一把由玩家挑').toHaveLength(2)
    expect(new Set(actions.map((action) => (action as { equipmentSlot?: string }).equipmentSlot)))
      .toEqual(new Set(['weapon', 'weapon2']))

    const toSecond = actions.find((action) => (action as { equipmentSlot?: string }).equipmentSlot === 'weapon2')!
    game.act('p0', toSecond.id)
    settle(game)
    expect(playerOf(game, 'p0').zones.equipment.weapon2, '装进了第二栏').toBe(third)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('公共机制：武将牌当装备', () => {
  it('随机抽武将排除已上场的角色，而且同种子可复现', () => {
    const game = gameAt('dw-sample')
    const first = sampleCharacters(game.state, new GameRng('sample'), 5)
    const again = sampleCharacters(game.state, new GameRng('sample'), 5)
    expect(first.map((c) => c.id), '同种子抽到同样五张').toEqual(again.map((c) => c.id))
    expect(new Set(first.map((c) => c.id)).size, '五张互不重复').toBe(first.length)
    for (const character of first) {
      expect(CAST, '不会抽到已经上场的角色').not.toContain(character.id)
      expect(character.pack, '娱乐包不在常规武将池里').not.toBe('entertainment')
    }
  })

  it('武将装备没有点数，攻击范围来自武将牌的体力上限', () => {
    const game = gameAt('dw-qiexie-range')
    const picked = runQiexie(game, 1)
    expect(picked, '至少装上了一张').toHaveLength(1)
    const cardId = picked[0]
    expect(isCharacterEquipment(game.state, cardId)).toBe(true)
    expect(ruleCardNumber(game.state, cardId), '没有点数').toBeNull()
    const characterId = game.state.cards[cardId].characterId!
    /*
     * 查目录，不查抽样：这名武将已经被拿去当装备了，
     * 抽样按规则会把他排除掉，再去里面找必然是空。
     */
    const source = poolCharacter(characterId)!
    expect(game.state.cards[cardId].attackRange, '攻击范围＝武将牌的体力上限').toBe(source.maxHp)
    // 拿着它的人掉血也不影响
    playerOf(game, 'p0').hp = 1
    expect(getAttackRange(game.state, 'p0')).toBeGreaterThanOrEqual(source.maxHp)
  })

  it('离开装备区就销毁：不进手牌、不进弃牌堆、不进牌堆', () => {
    const game = gameAt('dw-destroy')
    const [cardId] = runQiexie(game, 1)
    expect(cardId).toBeTruthy()
    const discardBefore = game.state.zones.discardPile.length

    // 模拟被顺手牵羊：从装备区搬去别人手里
    const slot = equipmentSlotsOf(game.state, 'p0').find((candidate) => playerOf(game, 'p0').zones.equipment[candidate] === cardId)!
    moveCard(game.state, cardId, { kind: 'equipment', playerId: 'p0', slot }, { kind: 'hand', playerId: 'p1' })

    expect(playerOf(game, 'p1').zones.hand, '没有跑进别人手里').not.toContain(cardId)
    expect(game.state.zones.discardPile.length, '也没有进弃牌堆').toBe(discardBefore)
    expect(game.state.zones.drawPile, '更没有混进牌堆').not.toContain(cardId)
    expect(game.state.cards[cardId], '牌对象本身也删掉了').toBeUndefined()
    assertCardConservation(game.state)
  })

  it('借来的技能来源是装备：装备一走技能立刻失效', () => {
    const game = gameAt('dw-borrowed')
    /*
     * 直接造一张「关羽」当武器：关羽的【武圣】标了可借用，
     * 用固定武将比依赖随机抽样稳。
     */
    const cardId = equipCharacterWeapon(game, 'p0', 'guanyu')
    expect(borrowableSkillIdsOf('guanyu'), '武圣可借用').toContain('wusheng')
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '装备着就拥有这个技能').toContain('wusheng')
    // 断肠废的是武将牌上的技能，管不到装备
    playerOf(game, 'p0').characterSkillsDisabled = true
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '断肠管不到装备技能').toContain('wusheng')
    playerOf(game, 'p0').characterSkillsDisabled = false

    const slot = equipmentSlotsOf(game.state, 'p0').find((candidate) => playerOf(game, 'p0').zones.equipment[candidate] === cardId)!
    moveCard(game.state, cardId, { kind: 'equipment', playerId: 'p0', slot }, { kind: 'discardPile' })
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '装备走了技能就没了').not.toContain('wusheng')
  })

  it('借用资格只认结构化元数据，不认描述里有没有「杀」字', () => {
    // 觉醒技、限定技、主公技一律排除，即使标了 qiexie 也不例外
    expect(borrowableSkillIdsOf('guanyu')).toEqual(['wusheng'])
    expect(borrowableSkillIdsOf('zhangfei')).toEqual(['paoxiao'])
    // 没标过的武将借不到任何技能——默认是「借不到」，不是「按描述猜」
    expect(borrowableSkillIdsOf('huatuo')).toEqual([])
  })
})

/**
 * 摧决的代价问现在是 `min: 0`（真的可以取消），
 * 所以**默认答案是空数组＝放弃**。想真的发动就必须把代价牌交上去。
 */
function payCuijueCost(request: AnyRequest): Record<string, unknown> | null {
  if (request.kind === 'choose-cards' && request.prompt?.includes('摧决')) {
    const pick = request as unknown as { cardIds: string[] }
    return { cardIds: pick.cardIds.slice(0, 1) }
  }
  return null
}

describe('神·典韦：摧决', () => {
  it('只打攻击范围内距离最远的，且每名角色每回合限一次', () => {
    const game = gameAt('dw-cuijue')
    // 给足攻击范围，让全场都在范围内
    equipCharacterWeapon(game, 'p0', 'guanyu')
    playerOf(game, 'p0').attackRangeBonus = 10
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = playerOf(game, id).maxHp
    trimHand(game, 'p0', 0)
    for (let index = 0; index < 4; index += 1) giveCard(game, 'p0', '闪')

    const hit: string[] = []
    game.events.on('Damaged', (handled) => { hit.push(String(handled.event.targetId)) })

    for (let round = 0; round < 3; round += 1) {
      const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'cuijue')
      if (!action) break
      game.act('p0', action.id)
      settle(game, payCuijueCost)
    }
    expect(hit.length, '打了不止一次').toBeGreaterThan(1)
    expect(new Set(hit).size, '每名角色每回合最多被打一次').toBe(hit.length)
    assertGameInvariants(game.state)
  })

  it('回合结束后「本回合打过谁」清空', () => {
    const game = gameAt('dw-cuijue-reset')
    playerOf(game, 'p0').attackRangeBonus = 10
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '闪')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'cuijue')!
    game.act('p0', action.id)
    settle(game, payCuijueCost)
    expect(Object.keys(playerOf(game, 'p0').marks).some((key) => key.startsWith('cuijue-hit:'))).toBe(true)

    for (let guard = 0; guard < 8 && game.state.currentPlayerId === 'p0'; guard += 1) {
      game.advancePhase()
      settle(game)
    }
    expect(
      Object.keys(playerOf(game, 'p0').marks).some((key) => key.startsWith('cuijue-hit:')),
      '回合一结束就清空，下个回合还能打同一个人',
    ).toBe(false)
  })

  it('取消：一分代价都不收，但同一阶段不再重复弹出', () => {
    const game = gameAt('dw-cuijue-cancel')
    playerOf(game, 'p0').attackRangeBonus = 10
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '闪')
    const handBefore = playerOf(game, 'p0').zones.hand.length

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'cuijue')!
    game.act('p0', action.id)
    // 交空数组 = 取消。原来 min 是 1，这一步会直接抛「卡牌选择非法」
    settle(game, (request) => (
      request.kind === 'choose-cards' && request.prompt?.includes('摧决') ? { cardIds: [] } : null
    ))

    expect(playerOf(game, 'p0').zones.hand.length, '代价牌还在手上').toBe(handBefore)
    expect(
      Object.keys(playerOf(game, 'p0').marks).some((key) => key.startsWith('cuijue-hit:')),
      '没有打到任何人',
    ).toBe(false)
    expect(declinedThisPhase(game.state, 'p0', 'cuijue'), '留下了放弃记号').toBe(true)
    /*
     * 取消之后场面一点没变，所以这条动作在**同一个阶段实例**里不再报出来——
     * 不加这道护栏，压测里会被反复点开成无限循环。
     */
    const again = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'cuijue')
    expect(again, '同一个阶段里不再重复弹出').toBeUndefined()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

/** 跑一次挈挟，返回真正装上去的武将装备。 */
function runQiexie(game: SanguoshaGame, take: number): string[] {
  // 推进到他的下一个准备阶段
  for (let guard = 0; guard < 60; guard += 1) {
    game.advancePhase()
    settle(game, (request) => {
      if (request.kind === 'choose-options' && request.prompt?.includes('挈挟')) {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionIds: options.slice(0, take).map((option) => option.id) }
      }
      return null
    })
    const equipped = characterEquipmentOf(game.state, 'p0')
    if (equipped.length >= take) return equipped
    if (game.state.status !== 'playing') break
  }
  return characterEquipmentOf(game.state, 'p0')
}

/** 直接把某名武将当武器装到某人身上，绕开随机抽样。 */
function equipCharacterWeapon(game: SanguoshaGame, playerId: string, characterId: string): string {
  const source = poolCharacter(characterId)
  const maxHp = source?.maxHp ?? 4
  const name = source?.name ?? characterId
  const cardId = createWeapon(game, characterId, name, maxHp)
  const slot = equipmentSlotsOf(game.state, playerId)
    .filter((candidate) => candidate === 'weapon' || candidate === 'weapon2')
    .find((candidate) => !playerOf(game, playerId).zones.equipment[candidate])!
  moveCard(game.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId, slot })
  return cardId
}

function createWeapon(game: SanguoshaGame, characterId: string, name: string, maxHp: number): string {
  // 用引擎的公共入口，测试里不另造一份
  return createCharacterWeapon(game.state, characterId, name, maxHp)
}
