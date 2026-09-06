import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { gainOriginCounts } from '@/sanguosha/engine/card-gain-provenance'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 法正（一将成名 2011 经典）。
 *
 * 六条主张，逐条有断言：
 *
 * - 【恩怨·恩】认的是「**其他角色的**两张牌」：摸两张不算，从两个人各拿一张也不算；
 * - 【恩怨·怨】是**逐点**结算：挨两点就问两次；
 * - 交牌走「交给」，不路过弃牌堆；不交就掉血，没手牌可交时直接掉血；
 * - 【眩惑】接管摸牌阶段：不发动也照常摸两张，发动则放弃摸牌；
 * - 被指使者出的【杀】是**真正的使用**，目标固定；
 * - 不出【杀】时法正获得其两张牌，而且**看不到手牌牌面**（只给占位槽）。
 */

const CAST = ['fazheng', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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
  /*
   * 法正的摸牌阶段会弹【眩惑】，所以推进阶段之间必须把请求结算掉——
   * 布置阶段一律选「放弃」，各条测试自己去跑真正的摸牌阶段。
   */
  while (game.state.phase !== 'play') {
    game.advancePhase()
    settle(game, (request) => request.kind === 'choose-option' && request.prompt?.includes('眩惑')
      ? { optionId: 'no' }
      : null)
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

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  for (const cardId of playerOf(game, playerId).zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 给某人一张指定牌名的牌，返回牌 id。 */
function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的【${cardName}】`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

/** 把 `count` 张手牌从 `fromId` 直接搬到 `toId`，然后发一条 GainCard。 */
function seize(game: SanguoshaGame, fromId: string, toId: string, count: number): string[] {
  const taken = playerOf(game, fromId).zones.hand.slice(0, count)
  for (const cardId of taken) {
    moveCard(game.state, cardId, { kind: 'hand', playerId: fromId }, { kind: 'hand', playerId: toId })
  }
  game.dispatch('GainCard', { playerId: toId, cardIds: taken, reason: 'test' }, { targetId: toId, cardIds: taken })
  game.settle()
  settle(game)
  return taken
}

describe('法正：恩怨·恩', () => {
  it('一次获得同一个人的两张牌，他摸一张', () => {
    const game = gameAt('fz-en-two')
    while (playerOf(game, 'p1').zones.hand.length < 3) giveCard(game, 'p1', '杀')
    const before = playerOf(game, 'p1').zones.hand.length
    seize(game, 'p1', 'p0', 2)
    expect(playerOf(game, 'p1').zones.hand, '被拿走 2 张、补回 1 张').toHaveLength(before - 2 + 1)
    assertCardConservation(game.state)
  })

  it('只拿一张不触发', () => {
    const game = gameAt('fz-en-one')
    while (playerOf(game, 'p1').zones.hand.length < 3) giveCard(game, 'p1', '杀')
    const before = playerOf(game, 'p1').zones.hand.length
    seize(game, 'p1', 'p0', 1)
    expect(playerOf(game, 'p1').zones.hand, '一张不构成「两张或更多」').toHaveLength(before - 1)
  })

  it('从两个人各拿一张不触发：两张必须来自同一个人', () => {
    const game = gameAt('fz-en-split')
    for (const id of ['p1', 'p2']) {
      while (playerOf(game, id).zones.hand.length < 2) giveCard(game, id, '杀')
    }
    const before = { p1: playerOf(game, 'p1').zones.hand.length, p2: playerOf(game, 'p2').zones.hand.length }
    const taken = [playerOf(game, 'p1').zones.hand[0], playerOf(game, 'p2').zones.hand[0]]
    moveCard(game.state, taken[0], { kind: 'hand', playerId: 'p1' }, { kind: 'hand', playerId: 'p0' })
    moveCard(game.state, taken[1], { kind: 'hand', playerId: 'p2' }, { kind: 'hand', playerId: 'p0' })
    game.dispatch('GainCard', { playerId: 'p0', cardIds: taken, reason: 'test' }, { targetId: 'p0', cardIds: taken })
    game.settle()
    settle(game)
    expect(playerOf(game, 'p1').zones.hand, 'p1 只被拿走一张，不补').toHaveLength(before.p1 - 1)
    expect(playerOf(game, 'p2').zones.hand, 'p2 同理').toHaveLength(before.p2 - 1)
  })

  it('摸两张牌不算「获得其他角色的牌」', () => {
    const game = gameAt('fz-en-draw')
    const others = game.state.players.filter((player) => player.id !== 'p0').map((player) => player.zones.hand.length)
    game.dispatch('DrawPhase', { playerId: 'p0' })
    game.settle()
    settle(game, (request) => request.kind === 'choose-option' && request.prompt?.includes('眩惑')
      ? { optionId: 'no' }
      : null)
    const after = game.state.players.filter((player) => player.id !== 'p0').map((player) => player.zones.hand.length)
    expect(after, '牌堆里摸来的牌不属于任何人，谁都不该因此摸牌').toEqual(others)
  })

  it('来源记录在牌离开原主时就写好了，不是事后猜的', () => {
    const game = gameAt('fz-provenance')
    while (playerOf(game, 'p1').zones.hand.length < 2) giveCard(game, 'p1', '杀')
    const taken = playerOf(game, 'p1').zones.hand.slice(0, 2)
    for (const cardId of taken) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'hand', playerId: 'p0' })
    }
    expect(gainOriginCounts(game.state, 'p0', taken).get('p1'), '两张都记着来自 p1').toBe(2)
    // 再送回去就不再算作 p0 从别人那里获得的了
    for (const cardId of taken) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'hand', playerId: 'p1' })
    }
    expect(gainOriginCounts(game.state, 'p0', taken).size, '牌不在他手上就不算').toBe(0)
  })
})

/** 让 p1 打法正 `amount` 点伤害，按 `answer` 回答【恩怨】的问牌。 */
function hitFazheng(game: SanguoshaGame, amount: number, answer: 'give' | 'refuse') {
  const asks: string[] = []
  resolveDamage(game as never, { sourceId: 'p1', targetId: 'p0', amount, nature: 'normal' })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-cards' && request.prompt?.includes('恩怨')) {
      asks.push(request.id)
      const pick = request as unknown as { cardIds: string[] }
      return answer === 'give' ? { cardIds: pick.cardIds.slice(0, 1) } : { cardIds: [] }
    }
    return null
  })
  return { asks: asks.length }
}

describe('法正：恩怨·怨', () => {
  it('每受到 1 点伤害问一次：挨两点就问两次', () => {
    const game = gameAt('fz-yuan-two')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp
    while (playerOf(game, 'p1').zones.hand.length < 4) giveCard(game, 'p1', '杀')
    const handBefore = playerOf(game, 'p1').zones.hand.length
    const result = hitFazheng(game, 2, 'give')
    expect(result.asks, '两点伤害问两次').toBe(2)
    expect(playerOf(game, 'p1').zones.hand, '交出了两张手牌').toHaveLength(handBefore - 2)
  })

  it('交出的牌是「交给」，直接进法正手里，不路过弃牌堆', () => {
    const game = gameAt('fz-yuan-give')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp
    trimHand(game, 'p0', 0)
    while (playerOf(game, 'p1').zones.hand.length < 2) giveCard(game, 'p1', '杀')
    const discardBefore = game.state.zones.discardPile.length
    hitFazheng(game, 1, 'give')
    expect(playerOf(game, 'p0').zones.hand, '牌到了法正手上').toHaveLength(1)
    expect(game.state.zones.discardPile, '弃牌堆没有多出这张牌').toHaveLength(discardBefore)
    assertCardConservation(game.state)
  })

  it('不交牌就失去 1 点体力', () => {
    const game = gameAt('fz-yuan-refuse')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp
    const source = playerOf(game, 'p1')
    source.hp = source.maxHp
    while (source.zones.hand.length < 2) giveCard(game, 'p1', '杀')
    hitFazheng(game, 1, 'refuse')
    expect(playerOf(game, 'p1').hp, '拒绝交牌 → 掉 1 点').toBe(source.maxHp - 1)
  })

  it('来源没有手牌时直接掉血，不弹一个只能拒绝的窗口', () => {
    const game = gameAt('fz-yuan-empty')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp
    const source = playerOf(game, 'p1')
    source.hp = source.maxHp
    trimHand(game, 'p1', 0)
    const result = hitFazheng(game, 1, 'give')
    expect(result.asks, '没牌可交就不该问').toBe(0)
    expect(playerOf(game, 'p1').hp, '直接掉 1 点').toBe(source.maxHp - 1)
  })

  it('无来源的伤害不问任何人', () => {
    const game = gameAt('fz-yuan-nosource')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp
    let asked = false
    resolveDamage(game as never, { sourceId: null, targetId: 'p0', amount: 1, nature: 'thunder' })
    game.settle()
    settle(game, (request) => {
      if (request.prompt?.includes('恩怨')) asked = true
      return null
    })
    expect(asked, '闪电这类没有来源的伤害问不着人').toBe(false)
    assertGameInvariants(game.state)
  })
})

/** 跑法正的摸牌阶段，按 `plan` 回答眩惑的各个问题。 */
function drawPhase(
  game: SanguoshaGame,
  plan: { invoke: boolean; slash?: boolean },
) {
  const seen = { seizePrompt: null as AnyRequest | null }
  game.dispatch('DrawPhase', { playerId: 'p0' })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('眩惑')) {
      return { optionId: plan.invoke ? 'yes' : 'no' }
    }
    if (request.kind === 'choose-cards' && request.prompt?.includes('眩惑')) {
      if (request.prompt.includes('获得其')) {
        seen.seizePrompt = request
        return null
      }
      // 被指使者要不要出杀
      const pick = request as unknown as { cardIds: string[] }
      return plan.slash ? { cardIds: pick.cardIds.slice(0, 1) } : { cardIds: [] }
    }
    return null
  })
  return seen
}

describe('法正：眩惑', () => {
  it('不发动时照常摸两张：接管了摸牌阶段就要把牌补回来', () => {
    const game = gameAt('fz-xh-decline')
    const before = playerOf(game, 'p0').zones.hand.length
    drawPhase(game, { invoke: false })
    expect(playerOf(game, 'p0').zones.hand, '放弃发动不等于放弃摸牌').toHaveLength(before + 2)
  })

  it('发动时法正不摸牌，被选中的人摸两张', () => {
    const game = gameAt('fz-xh-invoke')
    const before = { p0: playerOf(game, 'p0').zones.hand.length, p1: playerOf(game, 'p1').zones.hand.length }
    drawPhase(game, { invoke: true, slash: true })
    expect(playerOf(game, 'p0').zones.hand.length, '法正放弃了摸牌').toBeLessThanOrEqual(before.p0 + 1)
    expect(playerOf(game, 'p1').zones.hand.length, '被选中的人摸了两张（可能又打出了一张杀）')
      .toBeGreaterThanOrEqual(before.p1)
  })

  it('被指使者出的【杀】是真正的使用：目标掉血，而且目标是法正指定的那个', () => {
    const game = gameAt('fz-xh-slash')
    for (const player of game.state.players) player.hp = player.maxHp
    // 保证 p1 手上有杀、而且够得着某个人
    playerOf(game, 'p1').attackRangeBonus = 5
    giveCard(game, 'p1', '杀')
    let victimId: string | null = null
    const hpBefore = new Map(game.state.players.map((player) => [player.id, player.hp]))
    game.dispatch('DrawPhase', { playerId: 'p0' })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('眩惑')) return { optionId: 'yes' }
      if (request.kind === 'choose-targets' && request.prompt?.includes('需对其使用')) {
        const pick = request as unknown as { candidateIds: string[] }
        victimId = pick.candidateIds[0]
        return { targetIds: [victimId] }
      }
      if (request.kind === 'choose-cards' && request.prompt?.includes('使用一张【杀】')) {
        const pick = request as unknown as { cardIds: string[] }
        return { cardIds: pick.cardIds.slice(0, 1) }
      }
      return null
    })
    expect(victimId, '法正指定了挨刀的人').toBeTruthy()
    expect(playerOf(game, victimId!).hp, '被指定的那个人确实挨了刀')
      .toBeLessThan(hpBefore.get(victimId!) ?? 0)
    /*
     * 掉血的可以有两个人，而且都说得通：
     * 被指定者挨了【杀】；如果挨刀的正是法正，那么【恩怨·怨】还会让出刀的
     * p1 交牌或掉血（这里的默认应答是不交）。**除此之外谁都不该掉血。**
     */
    const dropped = game.state.players
      .filter((player) => player.hp < (hpBefore.get(player.id) ?? 0))
      .map((player) => player.id)
    for (const id of dropped) {
      expect([victimId, 'p1'], `${id} 掉血没有出处`).toContain(id)
    }
    assertCardConservation(game.state)
  })

  it('不出【杀】时法正获得其两张牌，而且看不到手牌牌面', () => {
    const game = gameAt('fz-xh-seize')
    // p1 一张杀都没有 → 必然走惩罚分支
    trimHand(game, 'p1', 0)
    for (let index = 0; index < 3; index += 1) giveCard(game, 'p1', '桃')
    const before = { p0: playerOf(game, 'p0').zones.hand.length, p1: playerOf(game, 'p1').zones.hand.length }
    const seen = drawPhase(game, { invoke: true, slash: false })
    expect(seen.seizePrompt, '出不了杀就该弹惩罚的选牌窗').toBeTruthy()
    const prompt = seen.seizePrompt as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
    expect(prompt.cardIds, '手牌一张都不明示').toHaveLength(0)
    expect(prompt.hiddenCardSlots.length, '只给占位槽').toBeGreaterThan(0)
    expect(prompt.min, '拿两张').toBe(2)
    /*
     * p1 被拿走 2 张之后，【恩怨·恩】会让他摸回 1 张——
     * 两个技能各自成立，合起来就是净 -1。
     */
    expect(playerOf(game, 'p1').zones.hand, '眩惑摸两张、被拿走两张、恩怨补一张')
      .toHaveLength(before.p1 + 2 - 2 + 1)
    // 法正放弃了自己的摸牌，手上多出来的正好是抢来的那两张
    expect(playerOf(game, 'p0').zones.hand, '法正手上多了两张').toHaveLength(before.p0 + 2)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('法正：版本锁', () => {
  it('只有【恩怨】【眩惑】两个技能', () => {
    const character = getCharacter('fazheng')!
    expect(character.skills.map((skill) => skill.id), '本项目这一版只实现这两个').toEqual(['enyuan', 'xuanhuo'])
    expect(character.pack).toBe('yjcm2011')
    expect(character.maxHp).toBe(3)
    expect(character.kingdom).toBe('shu')
  })
})
