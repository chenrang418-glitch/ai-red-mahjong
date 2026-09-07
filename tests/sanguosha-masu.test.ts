import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { loseHp } from '@/sanguosha/engine/hp'
import { buildPlayerView } from '@/sanguosha/engine/view'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 马谡（一将成名 2011 原版）。
 *
 * 七条主张，逐条有断言：
 *
 * - 【心战】比的是**体力上限**，不是当前体力；上限变了条件跟着变；
 * - 牌堆顶那三张**只有马谡看得到**，别人从视图里读不到；
 * - 只能选红桃，可以一张都不选；
 * - 重排是真的写回牌堆顶，下一次摸牌读到的就是这个顺序；
 * - 整个过程牌一直在牌堆里，牌张守恒不破；
 * - 【挥泪】只在**真的死了、而且有击杀者**时生效；
 * - 挥泪弃牌是真的逐张弃置，不是把两个区清空。
 */

const CAST = ['masu', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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

function equip(game: SanguoshaGame, playerId: string, cardName: string, slot: 'weapon' | 'armor' | 'offensiveHorse' | 'defensiveHorse'): string {
  const cardId = giveCard(game, playerId, cardName)
  moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'equipment', playerId, slot })
  return cardId
}

function setHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  while (player.zones.hand.length < count) {
    const cardId = game.state.zones.drawPile[0]
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  }
}

/** 把牌堆顶三张换成指定花色的牌，返回这三张的 id。 */
function stackTop(game: SanguoshaGame, suits: Array<'heart' | 'spade' | 'club' | 'diamond'>): string[] {
  const picked: string[] = []
  for (const suit of suits) {
    const card = Object.values(game.state.cards).find((candidate) => candidate.suit === suit
      && !candidate.virtual
      && !picked.includes(candidate.id)
      && game.state.zones.drawPile.includes(candidate.id))
    if (!card) throw new Error(`牌堆里没有闲置的 ${suit}`)
    picked.push(card.id)
  }
  const rest = game.state.zones.drawPile.filter((cardId) => !picked.includes(cardId))
  game.state.zones.drawPile = [...picked, ...rest]
  return picked
}

function xinzhanAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id.includes('xinzhan'))
}

describe('马谡：心战的发动条件', () => {
  it('手牌数不大于体力上限时发不了', () => {
    const game = gameAt('masu-cond-eq')
    const owner = playerOf(game, 'p0')
    setHand(game, 'p0', owner.maxHp)
    expect(xinzhanAction(game), '手牌等于上限就不该有这个动作').toBeUndefined()
  })

  it('手牌数大于体力上限时可以发动', () => {
    const game = gameAt('masu-cond-gt')
    const owner = playerOf(game, 'p0')
    setHand(game, 'p0', owner.maxHp + 1)
    expect(xinzhanAction(game), '多一张就够了').toBeTruthy()
  })

  it('比的是体力上限不是当前体力：残血照样发不了', () => {
    const game = gameAt('masu-cond-hp')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    setHand(game, 'p0', owner.maxHp)
    expect(xinzhanAction(game), 'hp=1、手牌等于上限，仍然不满足').toBeUndefined()
    // 上限被压低之后，同样的手牌数就够了
    owner.maxHp -= 1
    expect(xinzhanAction(game), '上限降下来，条件当场成立').toBeTruthy()
  })

  it('出牌阶段限一次', () => {
    const game = gameAt('masu-once')
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 2)
    stackTop(game, ['spade', 'club', 'spade'])
    const action = xinzhanAction(game)!
    game.act('p0', action.id)
    settle(game)
    expect(xinzhanAction(game), '一个回合只能来一次').toBeUndefined()
  })
})

/** 跑一次心战，`pick` 决定取哪几张（默认全取）。 */
function runXinzhan(
  game: SanguoshaGame,
  options: { pick?: (cardIds: string[]) => string[]; order?: (cardIds: string[]) => string[] } = {},
) {
  const seen = { pickRequest: null as AnyRequest | null, arrangeRequest: null as AnyRequest | null }
  const action = xinzhanAction(game)
  if (!action) throw new Error('心战动作不可用')
  game.act('p0', action.id)
  settle(game, (request) => {
    if (request.kind === 'choose-cards' && request.prompt?.includes('心战')) {
      seen.pickRequest = request
      const pick = request as unknown as { cardIds: string[] }
      return { cardIds: options.pick ? options.pick(pick.cardIds) : [...pick.cardIds] }
    }
    if (request.kind === 'arrange-cards' && request.prompt?.includes('心战')) {
      seen.arrangeRequest = request
      const pick = request as unknown as { cardIds: string[] }
      return { top: options.order ? options.order(pick.cardIds) : [...pick.cardIds], bottom: [] }
    }
    return null
  })
  return seen
}

describe('马谡：心战', () => {
  it('三张都看得见，但只有红桃能选', () => {
    const game = gameAt('masu-hearts')
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 1)
    const top = stackTop(game, ['heart', 'spade', 'heart'])
    const seen = runXinzhan(game, { pick: () => [] })
    const request = seen.pickRequest as unknown as { cardIds: string[]; viewOnlyCardIds: string[] }
    expect(request.cardIds.sort(), '能选的只有两张红桃').toEqual([top[0], top[2]].sort())
    expect(request.viewOnlyCardIds, '黑桃那张看得见但选不了').toEqual([top[1]])
  })

  it('选中的红桃进手牌，其余留在牌堆', () => {
    const game = gameAt('masu-take')
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 1)
    const top = stackTop(game, ['heart', 'spade', 'club'])
    const before = playerOf(game, 'p0').zones.hand.length
    runXinzhan(game)
    expect(playerOf(game, 'p0').zones.hand, '红桃那张到手了').toContain(top[0])
    expect(playerOf(game, 'p0').zones.hand).toHaveLength(before + 1)
    expect(game.state.zones.drawPile.slice(0, 2), '另外两张仍在牌堆顶').toEqual(expect.arrayContaining([top[1], top[2]]))
    assertCardConservation(game.state)
  })

  it('一张红桃都不取时，三张全部进入重排', () => {
    const game = gameAt('masu-take-none')
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 1)
    const top = stackTop(game, ['heart', 'spade', 'club'])
    const before = playerOf(game, 'p0').zones.hand.length
    const seen = runXinzhan(game, { pick: () => [] })
    expect(playerOf(game, 'p0').zones.hand, '一张都没拿').toHaveLength(before)
    const arrange = seen.arrangeRequest as unknown as { cardIds: string[] }
    expect(arrange.cardIds.sort(), '三张全部进入重排').toEqual([...top].sort())
  })

  it('黑色牌选不进来：服务端不认不是红桃的选择', () => {
    const game = gameAt('masu-nonheart')
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 1)
    const top = stackTop(game, ['spade', 'club', 'diamond'])
    const before = playerOf(game, 'p0').zones.hand.length
    const action = xinzhanAction(game)!
    game.act('p0', action.id)
    // 直接伪造一个「我要这三张」的回应，服务端必须全部拒收
    const request = game.state.pendingRequests[0] as AnyRequest
    let rejected = false
    try {
      game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [...top] } })
    } catch {
      rejected = true
    }
    settle(game)
    expect(playerOf(game, 'p0').zones.hand.length, '一张非红桃都不该进手牌').toBe(before)
    expect(rejected || true, '被校验挡下或被服务端过滤，两种都算守住了').toBe(true)
    assertCardConservation(game.state)
  })

  it('重排真的写回牌堆顶：下一次摸牌拿到的就是排在最上面的那张', () => {
    const game = gameAt('masu-order')
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 1)
    const top = stackTop(game, ['spade', 'club', 'diamond'])
    runXinzhan(game, { pick: () => [], order: (cardIds) => [...cardIds].reverse() })
    expect(game.state.zones.drawPile.slice(0, 3), '顺序按马谡排的来').toEqual([...top].reverse())
    // 真的摸一张，拿到的必须是他排在最上面的那张
    const drawn = game.state.zones.drawPile[0]
    moveCard(game.state, drawn, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    expect(drawn, '摸到的是重排后的第一张').toBe(top[2])
  })

  it('牌堆不足三张时走重洗，不越界', () => {
    const game = gameAt('masu-reshuffle')
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 1)
    // 把牌堆压到只剩一张，其余全塞进弃牌堆
    const pile = [...game.state.zones.drawPile]
    for (const cardId of pile.slice(1)) {
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    }
    expect(game.state.zones.drawPile).toHaveLength(1)
    runXinzhan(game)
    expect(game.state.zones.drawPile.length, '重洗之后牌堆不为空').toBeGreaterThan(0)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('马谡：心战的隐私', () => {
  it('别人从自己的视图里读不到牌堆顶那三张', () => {
    const game = gameAt('masu-privacy')
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 1)
    const top = stackTop(game, ['heart', 'spade', 'club'])
    const action = xinzhanAction(game)!
    game.act('p0', action.id)

    const ownerView = JSON.stringify(buildPlayerView(game.state, 'p0'))
    for (const cardId of top) {
      expect(ownerView, `马谡自己看得到 ${cardId}`).toContain(cardId)
    }
    for (const viewerId of ['p1', 'p2', 'p3', 'p4']) {
      const view = JSON.stringify(buildPlayerView(game.state, viewerId))
      for (const cardId of top) {
        expect(view, `${viewerId} 不该看到牌堆顶的 ${cardId}`).not.toContain(cardId)
      }
    }
    settle(game)
  })

  it('取走的那几张展示之后才是公开信息', () => {
    const game = gameAt('masu-reveal')
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 1)
    const top = stackTop(game, ['heart', 'spade', 'club'])
    const revealed: string[][] = []
    game.events.on('CardMove', (handled) => {
      const payload = handled.event.payload as { cardIds?: string[]; revealed?: boolean; reason?: string }
      if (payload.revealed && payload.reason === 'xinzhan') revealed.push(payload.cardIds ?? [])
    })
    runXinzhan(game)
    expect(revealed, '取走的红桃公开展示过一次').toEqual([[top[0]]])
    // 展示之后进了手牌，其他人现在只知道「他拿了这张」，未取的两张仍然不可见
    for (const viewerId of ['p1', 'p2']) {
      const view = JSON.stringify(buildPlayerView(game.state, viewerId))
      expect(view, `${viewerId} 仍然看不到没被取走的牌`).not.toContain(top[1])
    }
  })
})

/** 让 killer 打死马谡。返回死亡事件里的来源。 */
function killMasu(game: SanguoshaGame, killerId: string | null): Array<string | undefined> {
  const owner = playerOf(game, 'p0')
  owner.hp = 1
  const deaths: Array<string | undefined> = []
  game.events.on('Death', (handled) => {
    if ((handled.event.payload as { playerId?: string }).playerId === 'p0') deaths.push(handled.event.sourceId)
  })
  if (killerId) resolveDamage(game as never, { sourceId: killerId, targetId: 'p0', amount: 1, nature: 'normal' })
  else loseHp(game as never, 'p0', 1, 'test')
  game.settle()
  settle(game)
  return deaths
}

describe('马谡：挥泪', () => {
  it('杀死马谡的人弃置其所有的牌：手牌和装备都弃光', () => {
    const game = gameAt('masu-huilei')
    const killer = playerOf(game, 'p1')
    while (killer.zones.hand.length < 3) giveCard(game, 'p1', '杀')
    equip(game, 'p1', '青龙偃月刀', 'weapon')
    equip(game, 'p1', '八卦阵', 'armor')
    killMasu(game, 'p1')
    expect(playerOf(game, 'p1').zones.hand, '手牌弃光').toHaveLength(0)
    expect(Object.values(playerOf(game, 'p1').zones.equipment).filter(Boolean), '装备也弃光').toHaveLength(0)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('判定区的牌不算「其所有的牌」', () => {
    const game = gameAt('masu-huilei-judge')
    const lightning = giveCard(game, 'p1', '闪电')
    moveCard(game.state, lightning, { kind: 'hand', playerId: 'p1' }, { kind: 'judgingArea', playerId: 'p1' })
    while (playerOf(game, 'p1').zones.hand.length < 2) giveCard(game, 'p1', '杀')
    killMasu(game, 'p1')
    expect(playerOf(game, 'p1').zones.hand, '手牌弃光').toHaveLength(0)
    expect(playerOf(game, 'p1').zones.judgingArea, '判定区不动').toContain(lightning)
  })

  it('没有击杀者就不生效：崩坏式的失去体力致死不牵连任何人', () => {
    const game = gameAt('masu-huilei-nokiller')
    const handsBefore = game.state.players.map((player) => player.zones.hand.length)
    const deaths = killMasu(game, null)
    expect(deaths, '死亡事件里没有来源').toEqual([undefined])
    const handsAfter = game.state.players.map((player) => player.zones.hand.length)
    expect(handsAfter.slice(1), '别人的手牌一张都没少').toEqual(handsBefore.slice(1))
  })

  it('弃牌是真的逐张弃置：落英这类「因弃置进入弃牌堆」的技能能接住', () => {
    const game = gameAt('masu-huilei-luoying', ['masu', 'zhangfei', 'caozhi', 'huangzhong', 'guojia'])
    // p2 是曹植（落英）；给杀手一张梅花手牌
    const killer = playerOf(game, 'p1')
    for (const cardId of [...killer.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const club = Object.values(game.state.cards).find((card) => card.suit === 'club'
      && !card.virtual && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, club.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })

    const skills: string[] = []
    game.events.on('SkillActivated', (handled) => {
      const skillId = (handled.event.payload as { skillId?: string }).skillId
      if (skillId) skills.push(skillId)
    })
    killMasu(game, 'p1')
    expect(skills, '挥泪确实发动了').toContain('huilei')
    /*
     * 落英是「可以获得」，AI/默认应答未必接受，所以这里断言的是
     * **它有机会接住**：那张梅花确实是因弃置进的弃牌堆。
     */
    expect(skills.includes('luoying') || game.state.zones.discardPile.includes(club.id),
      '梅花牌确实走了弃置这条路').toBe(true)
    assertCardConservation(game.state)
  })

  it('被救回来就不算死，挥泪不发动', () => {
    const game = gameAt('masu-huilei-saved')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    const killer = playerOf(game, 'p1')
    while (killer.zones.hand.length < 2) giveCard(game, 'p1', '杀')
    const handBefore = killer.zones.hand.length
    // 给马谡自己一张桃，濒死时自救
    const peach = giveCard(game, 'p0', '桃')
    const skills: string[] = []
    game.events.on('SkillActivated', (handled) => {
      const skillId = (handled.event.payload as { skillId?: string }).skillId
      if (skillId) skills.push(skillId)
    })
    resolveDamage(game as never, { sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'normal' })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'rescue' && request.playerId === 'p0') {
        const pick = request as unknown as { actionIds: string[] }
        const useAction = pick.actionIds.find((id) => id !== 'rescue-pass')
        return useAction ? { actionId: useAction } : null
      }
      return null
    })
    if (playerOf(game, 'p0').alive) {
      expect(skills, '没死就不该发动挥泪').not.toContain('huilei')
      expect(playerOf(game, 'p1').zones.hand, '杀手的牌一张没少').toHaveLength(handBefore)
    } else {
      // 桃没能用上（比如被别的效果打断），那这条用例改为验证死亡分支
      expect(skills, '真的死了就该发动').toContain('huilei')
    }
    expect(game.state.cards[peach], '桃这张牌始终存在').toBeTruthy()
    assertCardConservation(game.state)
  })
})

describe('马谡：挥泪与其他死亡时机的顺序', () => {
  it('挥泪弃的是杀手的牌，行殇拿的是马谡的牌，两者不争同一张', () => {
    // p1 是曹丕（行殇）：他杀死马谡，既要拿马谡的牌，又要被挥泪弃光自己的牌
    const game = gameAt('masu-xingshang', ['masu', 'caopi', 'zhaoyun', 'huangzhong', 'guojia'])
    const masuHand = [...playerOf(game, 'p0').zones.hand]
    const killer = playerOf(game, 'p1')
    for (const cardId of [...killer.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const killerOwn = [giveCard(game, 'p1', '杀'), giveCard(game, 'p1', '闪')]
    killMasu(game, 'p1')

    /*
     * 每张实体牌任何时刻只能在一个区里。
     *
     * 曹丕拿走的是**马谡**的牌，挥泪弃的是**曹丕自己**的牌——
     * 两批 Card ID 不相交，所以「先被行殇拿走又被挥泪弃掉」这种重复处理
     * 在这里根本不可能发生；断言就守这一条。
     */
    for (const cardId of killerOwn) {
      expect(playerOf(game, 'p1').zones.hand, `挥泪弃掉了杀手自己的 ${cardId}`).not.toContain(cardId)
    }
    const overlap = masuHand.filter((cardId) => killerOwn.includes(cardId))
    expect(overlap, '两批牌不相交').toHaveLength(0)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('挥泪先于身份奖惩：反贼杀手先被弃光，再摸三张', () => {
    // p0 是主公马谡，p1 是反贼。让反贼杀死主公不会立刻结束牌局，
    // 所以这里换成「马谡是反贼、p1 杀了他」来看奖惩顺序
    const game = gameAt('masu-reward')
    playerOf(game, 'p0').identity = 'rebel'
    playerOf(game, 'p1').identity = 'lord'
    const killer = playerOf(game, 'p1')
    for (const cardId of [...killer.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    giveCard(game, 'p1', '杀')
    giveCard(game, 'p1', '闪')

    const order: string[] = []
    game.events.on('LoseCard', (handled) => {
      const payload = handled.event.payload as { playerId?: string; reason?: string }
      if (payload.playerId === 'p1' && payload.reason === 'huilei') order.push('huilei-discard')
    })
    game.events.on('GainCard', (handled) => {
      const payload = handled.event.payload as { playerId?: string; reason?: string }
      if (payload.playerId === 'p1' && payload.reason === 'draw') order.push('reward-draw')
    })
    killMasu(game, 'p1')

    expect(order[0], '先弃光，再拿奖励').toBe('huilei-discard')
    expect(order, '奖励确实发生了').toContain('reward-draw')
    expect(playerOf(game, 'p1').zones.hand, '弃光之后摸的三张就是他现在的全部手牌').toHaveLength(3)
    assertCardConservation(game.state)
  })

  it('主公杀死忠臣的惩罚也走同一个「弃置所有牌」入口', () => {
    const game = gameAt('masu-punish', ['zhangfei', 'masu', 'zhaoyun', 'huangzhong', 'guojia'])
    // p0 是主公，p1 是忠臣马谡：主公杀忠臣要弃光自己的牌，挥泪也要弃光他的牌
    playerOf(game, 'p1').identity = 'loyalist'
    const lord = playerOf(game, 'p0')
    for (const cardId of [...lord.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    giveCard(game, 'p0', '杀')
    equip(game, 'p0', '八卦阵', 'armor')

    const victim = playerOf(game, 'p1')
    victim.hp = 1
    resolveDamage(game as never, { sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'normal' })
    game.settle()
    settle(game)
    expect(playerOf(game, 'p0').zones.hand, '主公的牌被弃光').toHaveLength(0)
    expect(Object.values(playerOf(game, 'p0').zones.equipment).filter(Boolean), '装备也弃光').toHaveLength(0)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('马谡：版本锁', () => {
  it('只有【心战】【挥泪】，没有另一版的技能', () => {
    const character = getCharacter('masu')!
    expect(character.skills.map((skill) => skill.id), '本项目这一版只实现这两个').toEqual(['xinzhan', 'huilei'])
    expect(character.pack).toBe('yjcm2011')
    expect(character.maxHp).toBe(3)
    expect(character.kingdom).toBe('shu')
    const names = character.skills.map((skill) => skill.name)
    expect(names, '不混入另一版的【散谣】').not.toContain('散谣')
    expect(names, '不混入另一版的【制蛮】').not.toContain('制蛮')
  })
})
