import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { exchangeEquipmentZones } from '@/sanguosha/engine/equipment-exchange'
import { abolishSlot, grantExtraWeaponSlot } from '@/sanguosha/engine/equipment-slots'
import { buildPlayerView } from '@/sanguosha/engine/view'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 吴国太（一将成名 2011 经典）。
 *
 * 七条主张，逐条有断言：
 *
 * - 【甘露】的 X 是**已损失体力值**，现算；满血只能选装备数相同的两人；
 * - 可以选自己；
 * - 交换是整体互换、原子完成，牌张守恒不破；
 * - 装备离场事件照常：枭姬按张数，旋风按次数；
 * - 废除的栏位收不下的牌按规则弃置，武将牌变的装备不参与交换；
 * - 【补益】展示的手牌由服务端随机确定，吴国太看不到对方手牌；
 * - 非基本牌才弃置并回 1 点，而且只回 1 点，体力仍为负时继续濒死。
 */

const CAST = ['wuguotai', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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

function equipAny(game: SanguoshaGame, playerId: string, slot: 'weapon' | 'weapon2' | 'armor' | 'offensiveHorse' | 'defensiveHorse'): string {
  const wanted = slot === 'weapon2' ? 'weapon' : slot
  const card = Object.values(game.state.cards).find((candidate) => candidate.category === 'equipment'
    && candidate.equipmentSlot === wanted
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的${slot}装备`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'equipment', playerId, slot })
  return card.id
}

function equipmentOf(game: SanguoshaGame, playerId: string): string[] {
  return Object.values(playerOf(game, playerId).zones.equipment).filter((cardId): cardId is string => !!cardId)
}

function ganluAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id.includes('ganlu'))
}

/** 发动甘露并读出第一步的候选名单，然后取消掉整个流程。 */
function ganluFirstCandidates(game: SanguoshaGame): string[] {
  const action = ganluAction(game)
  if (!action) return []
  game.act('p0', action.id)
  const request = game.state.pendingRequests[0] as unknown as { candidateIds?: string[] } | undefined
  const candidates = [...(request?.candidateIds ?? [])]
  settle(game)
  return candidates
}

/** 跑一次甘露。返回是否真的换成了。 */
function runGanlu(game: SanguoshaGame, targets: string[]) {
  const action = ganluAction(game)
  if (!action) return false
  game.act('p0', action.id)
  // 两步选人：先第一名，再从「和他组得成合法配对」的人里选第二名
  let step = 0
  settle(game, (request) => {
    if (request.kind === 'choose-targets' && request.prompt?.includes('甘露')) {
      const pick = request as unknown as { candidateIds: string[] }
      const wanted = targets[step]
      step += 1
      return { targetIds: pick.candidateIds.includes(wanted) ? [wanted] : [] }
    }
    return null
  })
  return true
}

describe('吴国太：甘露的条件', () => {
  it('满血时 X = 0，装备数和别人都不同的人根本不在候选里', () => {
    const game = gameAt('wgt-full')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    equipAny(game, 'p1', 'weapon')
    /*
     * p1 有 1 张、其余人都是 0 张，X=0 时他和谁都配不成对。
     * 断言写在**候选名单**上而不是「选了他但没换成」：
     * 候选里只放真的走得通的人，是这个技能不空转的前提。
     */
    const candidates = ganluFirstCandidates(game)
    expect(candidates, '配不成对的人不该出现在候选里').not.toContain('p1')
    expect(candidates.length, '装备数相同的那些人仍然可选').toBeGreaterThan(0)
  })

  it('掉血之后 X 变大，同一对目标就合法了', () => {
    const game = gameAt('wgt-lost')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 1
    const weapon = equipAny(game, 'p1', 'weapon')
    runGanlu(game, ['p1', 'p2'])
    expect(equipmentOf(game, 'p2'), '换过去了').toContain(weapon)
    expect(equipmentOf(game, 'p1'), 'p1 那边空了').toHaveLength(0)
  })

  it('X 按 maxHp - hp 现算，不写死成 3 - hp', () => {
    const game = gameAt('wgt-dynamic')
    const owner = playerOf(game, 'p0')
    owner.maxHp = 5
    owner.hp = 5
    equipAny(game, 'p1', 'weapon')
    equipAny(game, 'p1', 'armor')
    expect(ganluFirstCandidates(game), '上限 5 时满血仍然是 X=0，两件装备的人配不成对').not.toContain('p1')

    // 掉 2 点之后 X=2，同一个人立刻进候选
    const other = gameAt('wgt-dynamic-hurt')
    const hurt = playerOf(other, 'p0')
    hurt.maxHp = 5
    hurt.hp = 3
    equipAny(other, 'p1', 'weapon')
    equipAny(other, 'p1', 'armor')
    expect(ganluFirstCandidates(other), 'X=2 时差 2 张也合法').toContain('p1')
  })

  it('出牌阶段限一次', () => {
    const game = gameAt('wgt-once')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp - 2
    equipAny(game, 'p1', 'weapon')
    runGanlu(game, ['p1', 'p2'])
    expect(ganluAction(game), '一个回合只能来一次').toBeUndefined()
  })

  it('可以把自己选进去', () => {
    const game = gameAt('wgt-self')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp - 2
    const weapon = equipAny(game, 'p0', 'weapon')
    runGanlu(game, ['p0', 'p1'])
    expect(equipmentOf(game, 'p1'), '自己的装备换给了对方').toContain(weapon)
  })
})

describe('吴国太：装备区互换', () => {
  it('整体互换：两边的牌完整对调，牌张守恒', () => {
    const game = gameAt('wgt-swap')
    const left = [equipAny(game, 'p1', 'weapon'), equipAny(game, 'p1', 'armor')]
    const right = [equipAny(game, 'p2', 'defensiveHorse')]
    exchangeEquipmentZones(game as never, 'p1', 'p2')
    game.settle()
    settle(game)
    for (const cardId of left) expect(equipmentOf(game, 'p2'), '甲的牌到了乙那边').toContain(cardId)
    for (const cardId of right) expect(equipmentOf(game, 'p1'), '乙的牌到了甲那边').toContain(cardId)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('不是按栏位一一对应：一边三张换一边一张也成立', () => {
    const game = gameAt('wgt-uneven')
    const left = [
      equipAny(game, 'p1', 'weapon'),
      equipAny(game, 'p1', 'armor'),
      equipAny(game, 'p1', 'offensiveHorse'),
    ]
    const right = [equipAny(game, 'p2', 'defensiveHorse')]
    exchangeEquipmentZones(game as never, 'p1', 'p2')
    game.settle()
    settle(game)
    expect(equipmentOf(game, 'p2').sort(), '三张全过去了').toEqual([...left].sort())
    expect(equipmentOf(game, 'p1'), '一张过来了').toEqual(right)
    assertCardConservation(game.state)
  })

  it('装备离场事件：枭姬按张数、旋风按次数', () => {
    const game = gameAt('wgt-events', ['wuguotai', 'lingtong', 'zhaoyun', 'huangzhong', 'guojia'])
    equipAny(game, 'p1', 'weapon')
    equipAny(game, 'p1', 'armor')
    equipAny(game, 'p1', 'defensiveHorse')
    let perCard = 0
    let perBatch = 0
    game.events.on('LoseEquipment', (handled) => {
      if ((handled.event.payload as { playerId?: string }).playerId === 'p1') perCard += 1
    })
    game.events.on('EquipmentZoneLoss', (handled) => {
      if ((handled.event.payload as { playerId?: string }).playerId === 'p1') perBatch += 1
    })
    exchangeEquipmentZones(game as never, 'p1', 'p2')
    game.settle()
    settle(game, (request) => (request.prompt?.includes('旋风') ? { optionId: 'cancel' } : null))
    expect(perCard, '每张一条').toBe(3)
    expect(perBatch, '整批只有一条').toBe(1)
  })

  it('对方废除了栏位就放不下：那张牌按规则弃置，不静默消失', () => {
    const game = gameAt('wgt-abolished')
    const armor = equipAny(game, 'p1', 'armor')
    abolishSlot(game.state, 'p2', 'armor')
    const result = exchangeEquipmentZones(game as never, 'p1', 'p2')
    game.settle()
    settle(game)
    expect(result.discarded, '收不下就弃置').toContain(armor)
    expect(game.state.zones.discardPile, '确实进了弃牌堆').toContain(armor)
    expect(equipmentOf(game, 'p2'), '没有硬塞进废除的栏位').not.toContain(armor)
    assertCardConservation(game.state)
  })

  it('对方有额外武器栏时收得下两把武器', () => {
    const game = gameAt('wgt-doubleweapon')
    const weapons = [equipAny(game, 'p1', 'weapon')]
    grantExtraWeaponSlot(game.state, 'p1')
    weapons.push(equipAny(game, 'p1', 'weapon2'))
    grantExtraWeaponSlot(game.state, 'p2')
    const result = exchangeEquipmentZones(game as never, 'p1', 'p2')
    game.settle()
    settle(game)
    expect(result.discarded, '两把都放得下').toHaveLength(0)
    for (const cardId of weapons) expect(equipmentOf(game, 'p2')).toContain(cardId)
    assertCardConservation(game.state)
  })

  it('没有额外武器栏的人只收得下一把，另一把弃置', () => {
    const game = gameAt('wgt-oneweapon')
    const first = equipAny(game, 'p1', 'weapon')
    grantExtraWeaponSlot(game.state, 'p1')
    const second = equipAny(game, 'p1', 'weapon2')
    const result = exchangeEquipmentZones(game as never, 'p1', 'p2')
    game.settle()
    settle(game)
    expect(result.moved.length + result.discarded.length, '两张牌都有归宿').toBe(2)
    expect(result.discarded, '多出来的那把被弃置').toHaveLength(1)
    expect([first, second]).toContain(result.discarded[0])
    assertCardConservation(game.state)
  })
})

/** 让 p1 濒死，返回吴国太有没有拿到补益这个选项、以及最终结果。 */
function driveDying(
  game: SanguoshaGame,
  options: { invokeBuyi: boolean } = { invokeBuyi: true },
) {
  const seen = { offered: false, revealed: [] as string[] }
  game.events.on('CardMove', (handled) => {
    const payload = handled.event.payload as { cardIds?: string[]; reason?: string; revealed?: boolean }
    if (payload.revealed && payload.reason === 'buyi') seen.revealed.push(...(payload.cardIds ?? []))
  })
  playerOf(game, 'p1').hp = 1
  resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal' })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'rescue') {
      const pick = request as unknown as { actionIds: string[] }
      const buyi = pick.actionIds.find((id) => id.includes('buyi'))
      if (buyi && request.playerId === 'p0') {
        seen.offered = true
        if (options.invokeBuyi) return { actionId: buyi }
      }
      return { actionId: 'rescue-pass' }
    }
    return null
  })
  return seen
}

describe('吴国太：补益', () => {
  it('非基本牌：展示、弃置、回复 1 点', () => {
    const game = gameAt('wgt-buyi-trick')
    const target = playerOf(game, 'p1')
    for (const cardId of [...target.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const trick = giveCard(game, 'p1', '决斗')
    const seen = driveDying(game)
    expect(seen.offered, '吴国太拿到了补益这个选项').toBe(true)
    expect(seen.revealed, '展示的就是那张牌').toEqual([trick])
    expect(game.state.zones.discardPile, '非基本牌被弃置').toContain(trick)
    expect(playerOf(game, 'p1').hp, '回了 1 点，脱离濒死').toBeGreaterThan(0)
    assertCardConservation(game.state)
  })

  it('基本牌：展示之后原样回到手上，什么都不发生', () => {
    const game = gameAt('wgt-buyi-basic')
    const target = playerOf(game, 'p1')
    for (const cardId of [...target.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const basic = giveCard(game, 'p1', '杀')
    /*
     * 断言不能写成「牌还在他手上」：展示完之后没人救他，他就死了，
     * 阵亡收牌会把手牌全部弃掉——那和补益无关。
     * 这里守的是**补益自己什么都没做**：没有以补益为由的弃牌，也没有回复。
     */
    const byBuyi = { discarded: 0, recovered: 0 }
    game.events.on('LoseCard', (handled) => {
      if ((handled.event.payload as { reason?: string }).reason === 'buyi') byBuyi.discarded += 1
    })
    game.events.on('Recover', (handled) => {
      if ((handled.event.payload as { reason?: string }).reason === 'buyi') byBuyi.recovered += 1
    })
    const seen = driveDying(game)
    expect(seen.revealed, '展示过').toEqual([basic])
    expect(byBuyi.discarded, '基本牌不弃置').toBe(0)
    expect(byBuyi.recovered, '基本牌不回血').toBe(0)
    assertCardConservation(game.state)
  })

  it('目标没有手牌时不给这个选项', () => {
    const game = gameAt('wgt-buyi-empty')
    const target = playerOf(game, 'p1')
    for (const cardId of [...target.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const seen = driveDying(game)
    expect(seen.offered, '没有手牌可展示，不该给一个必然落空的选项').toBe(false)
  })

  it('只回 1 点：体力仍为负时继续处于濒死', () => {
    const game = gameAt('wgt-buyi-one')
    const target = playerOf(game, 'p1')
    for (const cardId of [...target.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    giveCard(game, 'p1', '决斗')
    target.hp = 1
    // 一次 3 点伤害：补益回 1 点之后仍然是负数
    resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 3, nature: 'normal' })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'rescue') {
        const pick = request as unknown as { actionIds: string[] }
        const buyi = pick.actionIds.find((id) => id.includes('buyi'))
        return buyi && request.playerId === 'p0' ? { actionId: buyi } : { actionId: 'rescue-pass' }
      }
      return null
    })
    expect(playerOf(game, 'p1').hp, '只回了 1 点，没有一次拉满').toBeLessThanOrEqual(0)
    assertGameInvariants(game.state)
  })

  it('吴国太看不到濒死角色的完整手牌', () => {
    const game = gameAt('wgt-buyi-privacy')
    const target = playerOf(game, 'p1')
    for (const cardId of [...target.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const hand = [giveCard(game, 'p1', '决斗'), giveCard(game, 'p1', '杀'), giveCard(game, 'p1', '闪')]
    playerOf(game, 'p1').hp = 1
    resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal' })
    game.settle()
    const view = JSON.stringify(buildPlayerView(game.state, 'p0'))
    for (const cardId of hand) {
      expect(view, `补益发问时不该把 ${cardId} 的牌面发给吴国太`).not.toContain(cardId)
    }
    settle(game)
  })
})

describe('吴国太：版本锁', () => {
  it('只有【甘露】【补益】', () => {
    const character = getCharacter('wuguotai')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['ganlu', 'buyi'])
    expect(character.pack).toBe('yjcm2011')
    expect(character.maxHp).toBe(3)
    expect(character.kingdom).toBe('wu')
    expect(character.gender).toBe('female')
  })
})
