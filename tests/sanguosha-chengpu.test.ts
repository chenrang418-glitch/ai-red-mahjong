import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { cardDamageDealt } from '@/sanguosha/engine/card-damage-ledger'
import { CHUN_PILE, chunOf } from '@/sanguosha/data/characters/yjcm2012-chengpu'
import { buildPlayerView } from '@/sanguosha/engine/view'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 程普（一将成名 2012）。
 *
 * 逐条有断言的主张：
 *
 * - 【疠火】只吃**普通**【杀】：雷【杀】、已经是火【杀】的都不在候选里；
 * - 转换发生在**指定目标之前**，所以火【杀】的额外目标才用得上；
 * - 转换的是同一次使用：实体牌还是原来那张，只是属性变成火；
 * - 「造成过伤害」以这张牌的这次使用为根：两个目标各伤一次也只失去 **1 点**；
 * - 一点伤害都没造成（被闪掉）就不失去体力；
 * - 本来就是火【杀】的也能多选一个目标，而且**不失去体力**；
 * - 【醇】公开、只收实体【杀】、不为空时不能再存；
 * - 醇醪救人时使用者是那名**濒死角色本人**，而且高顺【禁酒】拦不住。
 */

const CAST = ['zhangfei', 'chengpu', 'zhaoyun', 'huangzhong', 'guojia']
const CHENGPU_ID = 'p1'

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
      case 'distribute-cards': return { assignments: [] }
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

/** 开局，然后把回合直接交给程普并停在他的出牌阶段。 */
function gameAtChengpuPlay(seed: string, characterIds: string[] = CAST): SanguoshaGame {
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
  for (let guard = 0; guard < 20; guard += 1) {
    game.advancePhase()
    settle(game)
    if (game.state.currentPlayerId === CHENGPU_ID && game.state.phase === 'play') return game
  }
  throw new Error('没有走到程普的出牌阶段')
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

function findSlash(game: SanguoshaGame, nature: 'normal' | 'fire' | 'thunder'): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === '杀'
    && !candidate.virtual
    && (candidate.damageNature ?? 'normal') === nature
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的${nature}【杀】`)
  return card.id
}

/** 清空手牌再精确发牌，让候选可控。 */
function setHand(game: SanguoshaGame, playerId: string, cardIds: string[]): void {
  const owner = playerOf(game, playerId)
  for (const cardId of [...owner.zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  for (const cardId of cardIds) {
    moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId })
  }
}

function lihuoAction(game: SanguoshaGame) {
  return game.legalActions(CHENGPU_ID).find((action) => action.kind === 'invoke-skill' && action.id === 'lihuo-invoke')
}

describe('程普【疠火】：转换', () => {
  it('只吃普通【杀】：雷【杀】和火【杀】都不在候选里', () => {
    const game = gameAtChengpuPlay('chengpu-normal-only')
    playerOf(game, CHENGPU_ID).attackRangeBonus = 6
    setHand(game, CHENGPU_ID, [findSlash(game, 'thunder')])
    expect(lihuoAction(game), '雷【杀】不是普通【杀】').toBeUndefined()
    setHand(game, CHENGPU_ID, [findSlash(game, 'fire')])
    expect(lihuoAction(game), '已经是火【杀】了，没什么可改').toBeUndefined()
    setHand(game, CHENGPU_ID, [findSlash(game, 'normal')])
    expect(lihuoAction(game), '普通【杀】才能改').toBeDefined()
  })

  it('转换在指定目标之前：改成火【杀】之后可以多选一个目标', () => {
    const game = gameAtChengpuPlay('chengpu-extra-target')
    playerOf(game, CHENGPU_ID).attackRangeBonus = 6
    const slash = findSlash(game, 'normal')
    setHand(game, CHENGPU_ID, [slash])

    // 对照：不发动疠火时，这张普通【杀】只出得了单目标动作
    const plain = game.legalActions(CHENGPU_ID).filter((action) => action.kind === 'use-card'
      && action.asCardName === '杀' && action.cardIds.includes(slash))
    expect(plain.every((action) => action.kind === 'use-card' && action.targetIds.length === 1),
      '普通【杀】只能指定一个目标').toBe(true)

    let maxOffered = 0
    game.act(CHENGPU_ID, lihuoAction(game)!.id)
    settle(game, (request) => {
      if (request.playerId !== CHENGPU_ID) return null
      if (request.kind === 'choose-cards' && request.prompt?.includes('疠火')) return { cardIds: [slash] }
      if (request.kind === 'choose-targets' && request.prompt?.includes('疠火')) {
        maxOffered = (request as unknown as { max: number }).max
        return { targetIds: ['p0', 'p2'] }
      }
      return null
    })
    expect(maxOffered, '火【杀】可以多选择一个目标').toBe(2)
    expect(playerOf(game, 'p0').hp, 'p0 中了火【杀】').toBe(playerOf(game, 'p0').maxHp - 1)
    expect(playerOf(game, 'p2').hp, 'p2 也中了').toBe(playerOf(game, 'p2').maxHp - 1)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('转换的是同一次使用：实体牌还是原来那张，进弃牌堆', () => {
    const game = gameAtChengpuPlay('chengpu-same-card')
    playerOf(game, CHENGPU_ID).attackRangeBonus = 6
    const slash = findSlash(game, 'normal')
    setHand(game, CHENGPU_ID, [slash])
    game.act(CHENGPU_ID, lihuoAction(game)!.id)
    settle(game, (request) => {
      if (request.playerId !== CHENGPU_ID) return null
      if (request.kind === 'choose-cards' && request.prompt?.includes('疠火')) return { cardIds: [slash] }
      if (request.kind === 'choose-targets' && request.prompt?.includes('疠火')) return { targetIds: ['p0'] }
      return null
    })
    expect(game.state.zones.discardPile, '还是那张实体牌').toContain(slash)
    const leftovers = Object.keys(game.state.cards).filter((cardId) => cardId.startsWith('virtual:lihuo'))
    expect(leftovers, '没有另造一张虚拟牌').toHaveLength(0)
    assertCardConservation(game.state)
  })
})

describe('程普【疠火】：体力代价', () => {
  /** 用疠火打指定目标，返回程普掉了几点体力。`dodgers` 里的人会打出【闪】。 */
  function playLihuo(game: SanguoshaGame, targetIds: string[], dodgers: string[] = []): number {
    const before = playerOf(game, CHENGPU_ID).hp
    const dodgeCards = new Map<string, string>()
    for (const id of dodgers) {
      const dodge = Object.values(game.state.cards).find((card) => card.name === '闪' && !card.virtual
        && (game.state.zones.drawPile.includes(card.id) || game.state.zones.discardPile.includes(card.id)))!
      moveCard(game.state, dodge.id, locate(game.state, dodge.id), { kind: 'hand', playerId: id })
      dodgeCards.set(id, dodge.id)
    }
    game.act(CHENGPU_ID, lihuoAction(game)!.id)
    settle(game, (request) => {
      if (request.playerId === CHENGPU_ID) {
        if (request.kind === 'choose-cards' && request.prompt?.includes('疠火')) return null
        if (request.kind === 'choose-targets' && request.prompt?.includes('疠火')) return { targetIds }
        return null
      }
      const dodge = dodgeCards.get(request.playerId)
      if (dodge) return { actionId: `respond-dodge:${dodge}` }
      return null
    })
    return before - playerOf(game, CHENGPU_ID).hp
  }

  it('造成过伤害就失去 1 点体力', () => {
    const game = gameAtChengpuPlay('chengpu-cost')
    playerOf(game, CHENGPU_ID).attackRangeBonus = 6
    setHand(game, CHENGPU_ID, [findSlash(game, 'normal')])
    expect(playLihuo(game, ['p0']), '打中了，失去 1 点').toBe(1)
  })

  it('两个目标各伤一次，仍然只失去 1 点', () => {
    const game = gameAtChengpuPlay('chengpu-cost-once')
    playerOf(game, CHENGPU_ID).attackRangeBonus = 6
    setHand(game, CHENGPU_ID, [findSlash(game, 'normal')])
    expect(playLihuo(game, ['p0', 'p2']), '账是一本，读一次').toBe(1)
    expect(playerOf(game, 'p0').hp).toBe(playerOf(game, 'p0').maxHp - 1)
    expect(playerOf(game, 'p2').hp).toBe(playerOf(game, 'p2').maxHp - 1)
  })

  it('全被闪掉就不失去体力', () => {
    const game = gameAtChengpuPlay('chengpu-cost-dodged')
    playerOf(game, CHENGPU_ID).attackRangeBonus = 6
    setHand(game, CHENGPU_ID, [findSlash(game, 'normal')])
    expect(playLihuo(game, ['p0'], ['p0']), '一点伤害都没造成').toBe(0)
    expect(playerOf(game, 'p0').hp, '目标没掉血').toBe(playerOf(game, 'p0').maxHp)
  })

  it('两个目标只伤了一个，仍然失去 1 点', () => {
    const game = gameAtChengpuPlay('chengpu-cost-partial')
    playerOf(game, CHENGPU_ID).attackRangeBonus = 6
    setHand(game, CHENGPU_ID, [findSlash(game, 'normal')])
    expect(playLihuo(game, ['p0', 'p2'], ['p0']), '任意一个目标受到过伤害就成立').toBe(1)
  })

  it('本来就是火【杀】的：能多选一个目标，但不失去体力', () => {
    const game = gameAtChengpuPlay('chengpu-real-fire')
    playerOf(game, CHENGPU_ID).attackRangeBonus = 6
    const fire = findSlash(game, 'fire')
    setHand(game, CHENGPU_ID, [fire])
    const multi = game.legalActions(CHENGPU_ID).filter((action) => action.kind === 'use-card'
      && action.asCardName === '杀' && action.cardIds.includes(fire)
      && action.targetIds.length === 2)
    expect(multi.length, '实体火【杀】同样多一个目标').toBeGreaterThan(0)

    const before = playerOf(game, CHENGPU_ID).hp
    game.act(CHENGPU_ID, multi[0].id)
    settle(game)
    expect(playerOf(game, CHENGPU_ID).hp, '代价只属于「疠火把普通杀改成火杀」这一种').toBe(before)
  })

  it('伤害账随这次使用结算收束一起销毁', () => {
    const game = gameAtChengpuPlay('chengpu-ledger-cleared')
    playerOf(game, CHENGPU_ID).attackRangeBonus = 6
    const slash = findSlash(game, 'normal')
    setHand(game, CHENGPU_ID, [slash])
    playLihuo(game, ['p0'])
    expect(cardDamageDealt(game.state, slash), '账已经销毁，不会留到下一次使用').toBe(0)
    expect(game.state.lihuoCardIds ?? [], '疠火的牌标记也摘掉了').toHaveLength(0)
  })
})

describe('程普【醇醪】', () => {
  /** 走到程普的结束阶段并按 `store` 存醇。 */
  function storeChun(game: SanguoshaGame, store: string[] | null): void {
    for (let guard = 0; guard < 12; guard += 1) {
      if (game.state.phase === 'finish' && game.state.currentPlayerId === CHENGPU_ID) break
      game.advancePhase()
      settle(game, (request) => {
        if (request.playerId === CHENGPU_ID && request.kind === 'choose-cards' && request.prompt?.includes('醇醪')) {
          return { cardIds: store ?? [] }
        }
        return null
      })
    }
    // 结束阶段的时机是在进入 finish 时发的，上面那一轮已经问过了
  }

  it('把手牌里的实体【杀】置于武将牌上，而且是公开的', () => {
    const game = gameAtChengpuPlay('chunlao-store')
    const slashes = [findSlash(game, 'normal'), findSlash(game, 'fire')]
    setHand(game, CHENGPU_ID, slashes)
    storeChun(game, slashes)

    expect(chunOf(game.state, CHENGPU_ID).slice().sort(), '两张都放上去了').toEqual(slashes.slice().sort())
    // 公开：别人看得到牌面
    const seat = buildPlayerView(game.state, 'p0').players.find((player) => player.id === CHENGPU_ID)!
    expect((seat.characterPiles[CHUN_PILE] ?? []).map((card) => card.id).sort(), '醇对所有人公开').toEqual(slashes.slice().sort())
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('醇不为空时不能再存', () => {
    const game = gameAtChengpuPlay('chunlao-not-empty')
    const first = findSlash(game, 'normal')
    setHand(game, CHENGPU_ID, [first])
    storeChun(game, [first])
    expect(chunOf(game.state, CHENGPU_ID)).toHaveLength(1)

    // 再走一圈到他的结束阶段，这次不该再问
    let askedAgain = false
    let reachedFinishAgain = false
    for (let guard = 0; guard < 60; guard += 1) {
      game.advancePhase()
      settle(game, (request) => {
        if (request.playerId === CHENGPU_ID && request.kind === 'choose-cards' && request.prompt?.includes('醇醪')) {
          askedAgain = true
        }
        return null
      })
      if (game.state.phase === 'finish' && game.state.currentPlayerId === CHENGPU_ID && guard > 6) {
        reachedFinishAgain = true
        break
      }
    }
    // 先确认真的又走到了他的结束阶段，否则「没再问」是句空话
    expect(reachedFinishAgain, '确实又走到了程普的结束阶段').toBe(true)
    expect(chunOf(game.state, CHENGPU_ID), '醇还在，没被用掉').toHaveLength(1)
    expect(askedAgain, '醇还没用完就不再问').toBe(false)
  })

  it('濒死时移去一张醇：使用者是那名濒死角色本人', () => {
    const game = gameAtChengpuPlay('chunlao-rescue')
    const chun = findSlash(game, 'normal')
    setHand(game, CHENGPU_ID, [chun])
    storeChun(game, [chun])
    expect(chunOf(game.state, CHENGPU_ID)).toHaveLength(1)

    const victim = playerOf(game, 'p0')
    victim.hp = 1
    // 让 p2 用一张【杀】把 p0 打进濒死
    const slash = findSlash(game, 'normal')
    moveCard(game.state, slash, locate(game.state, slash), { kind: 'hand', playerId: 'p2' })
    playerOf(game, 'p2').attackRangeBonus = 6
    game.state.currentPlayerId = 'p2'
    game.state.phase = 'play'
    const action = game.legalActions('p2').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes('p0'))!
    game.act('p2', action.id)

    let wineUser: string | null = null
    game.events.on('CardUsed', (context) => {
      const payload = context.event.payload as { cardName?: string }
      if (payload.cardName === '酒') wineUser = context.event.sourceId ?? null
    })
    settle(game, (request) => {
      if (request.kind === 'rescue' && request.playerId === CHENGPU_ID) return { actionId: 'chunlao-rescue' }
      return null
    })

    expect(victim.alive, '被救活了').toBe(true)
    expect(victim.hp, '酒在濒死时回复 1 点').toBe(1)
    expect(wineUser, '使用者是濒死角色本人，不是程普').toBe('p0')
    expect(chunOf(game.state, CHENGPU_ID), '醇被移去一张').toHaveLength(0)
    expect(game.state.zones.discardPile, '那张【杀】进弃牌堆').toContain(chun)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('高顺【禁酒】拦不住醇醪：他濒死时照样被救得起来', () => {
    const game = gameAtChengpuPlay('chunlao-jinjiu', ['gaoshun', 'chengpu', 'zhaoyun', 'huangzhong', 'guojia'])
    const chun = findSlash(game, 'normal')
    setHand(game, CHENGPU_ID, [chun])
    storeChun(game, [chun])

    const gaoshun = playerOf(game, 'p0')
    gaoshun.hp = 1
    const slash = findSlash(game, 'normal')
    moveCard(game.state, slash, locate(game.state, slash), { kind: 'hand', playerId: 'p2' })
    playerOf(game, 'p2').attackRangeBonus = 6
    game.state.currentPlayerId = 'p2'
    game.state.phase = 'play'
    const action = game.legalActions('p2').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes('p0'))!
    game.act('p2', action.id)
    settle(game, (request) => {
      if (request.kind === 'rescue' && request.playerId === CHENGPU_ID) return { actionId: 'chunlao-rescue' }
      return null
    })

    /*
     * 禁酒改写的是**高顺手上的那张【酒】牌**，而醇醪给出的是
     * 「视为使用一张【酒】」的技能效果，不经过他的手牌，所以拦不住。
     */
    expect(gaoshun.alive, '高顺被醇醪救活').toBe(true)
    expect(gaoshun.hp).toBe(1)
    assertCardConservation(game.state)
  })
})
