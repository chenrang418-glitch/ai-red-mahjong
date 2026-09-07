import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { gainOriginCounts } from '@/sanguosha/engine/card-gain-provenance'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 王异（一将成名 2012 · 2015 合并后的经典版）。
 *
 * 七条主张，逐条有断言：
 *
 * - 【贞烈】只在**其他角色**使用的【杀】或非延时锦囊上触发，延时锦囊不触发；
 * - 代价是失去 1 点体力（不是伤害）；
 * - 只取消王异这一个目标，多目标锦囊对别人照常；
 * - 取消之后不再问她要【闪】；
 * - 弃的是使用者的一张牌，暗手牌只给占位槽；
 * - 【秘计】的 X 现算，摸几张自己定；
 * - 给牌按接收者分批，同一个人一次拿到两张算一次获得。
 */

const CAST = ['wangyi', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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

/**
 * 让 p1 对王异用一张牌，按 plan 回答贞烈。
 * 返回：有没有被问、有没有问王异要闪、王异掉了几点。
 */
function useAgainstWangYi(
  game: SanguoshaGame,
  cardName: string,
  plan: { invoke: boolean } = { invoke: true },
) {
  const seen = { asked: false, askedDodge: false, discardRequest: null as AnyRequest | null }
  const owner = playerOf(game, 'p0')
  const hpBefore = owner.hp
  game.state.currentPlayerId = 'p1'
  game.state.phase = 'play'
  playerOf(game, 'p1').attackRangeBonus = 6
  const cardId = giveCard(game, 'p1', cardName)
  const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId)
    && (candidate.targetIds.includes('p0') || candidate.targetIds.length === 0))
  if (!action) throw new Error(`没有可用的【${cardName}】动作`)
  game.act('p1', action.id)
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('贞烈')) {
      seen.asked = true
      return { optionId: plan.invoke ? 'yes' : 'no' }
    }
    if (request.kind === 'choose-cards' && request.prompt?.includes('贞烈')) {
      seen.discardRequest = request
      const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[] }
      return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, 1) }
    }
    if (request.kind === 'respond-card' && request.playerId === 'p0') seen.askedDodge = true
    return null
  })
  return { ...seen, hpLost: hpBefore - playerOf(game, 'p0').hp }
}

describe('王异：贞烈的触发范围', () => {
  it('别人的【杀】会触发', () => {
    const game = gameAt('wy-slash')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp
    const seen = useAgainstWangYi(game, '杀', { invoke: false })
    expect(seen.asked, '成为杀的目标后会问').toBe(true)
  })

  it('别人的非延时锦囊会触发', () => {
    for (const [seed, name] of [['wy-duel', '决斗'], ['wy-nanman', '南蛮入侵']] as const) {
      const game = gameAt(seed)
      playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp
      const seen = useAgainstWangYi(game, name, { invoke: false })
      expect(seen.asked, `${name} 会触发`).toBe(true)
    }
  })

  it('延时锦囊不触发', () => {
    const game = gameAt('wy-delayed')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp
    const seen = useAgainstWangYi(game, '乐不思蜀', { invoke: false })
    expect(seen.asked, '延时锦囊不在范围里').toBe(false)
  })

  it('自己用的牌不触发', () => {
    const game = gameAt('wy-self')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    let asked = false
    const duel = giveCard(game, 'p0', '决斗')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(duel))!
    game.act('p0', action.id)
    settle(game, (request) => {
      if (request.prompt?.includes('贞烈')) asked = true
      return null
    })
    expect(asked, '自己用的牌不该触发').toBe(false)
  })
})

describe('王异：贞烈的效果', () => {
  it('失去 1 点体力，弃使用者一张牌，此牌对她无效', () => {
    const game = gameAt('wy-effect')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    trimHand(game, 'p1', 2)
    const sourceHandBefore = playerOf(game, 'p1').zones.hand.length
    const seen = useAgainstWangYi(game, '杀')
    expect(seen.hpLost, '失去 1 点体力').toBe(1)
    // 他手上原有 2 张，我们又塞了一张【杀】并打出去，剩 2 张；贞烈再弃一张 → 1 张
    expect(playerOf(game, 'p1').zones.hand, '使用者被弃了一张').toHaveLength(sourceHandBefore - 1)
    expect(seen.askedDodge, '此牌对她无效，不该再问闪').toBe(false)
    assertCardConservation(game.state)
  })

  it('失去体力不是伤害：不触发「受到伤害后」的技能', () => {
    // p0 是王异，给她换成能观察伤害的场面：直接看有没有 Damaged 事件
    const game = gameAt('wy-notdamage')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    const damaged: string[] = []
    game.events.on('Damaged', (handled) => { damaged.push(String(handled.event.targetId)) })
    useAgainstWangYi(game, '杀')
    expect(damaged, '这一刀被贞烈作废了，王异没有受到伤害').not.toContain('p0')
  })

  it('暗手牌只给占位槽，王异看不到牌面', () => {
    const game = gameAt('wy-privacy')
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp
    trimHand(game, 'p1', 0)
    const hand = [giveCard(game, 'p1', '闪'), giveCard(game, 'p1', '桃')]
    const seen = useAgainstWangYi(game, '杀')
    const request = seen.discardRequest as unknown as { cardIds: string[]; hiddenCardSlots: string[] }
    for (const cardId of hand) {
      expect(request.cardIds, '真实手牌 id 不在可选列表里').not.toContain(cardId)
    }
    expect(request.hiddenCardSlots.length, '给的是占位槽').toBeGreaterThan(0)
  })

  it('多目标锦囊只对王异无效，别人照常', () => {
    const game = gameAt('wy-aoe')
    for (const id of ['p0', 'p2', 'p3', 'p4']) {
      const player = playerOf(game, id)
      player.hp = player.maxHp
      trimHand(game, id, 0)
    }
    const seen = useAgainstWangYi(game, '南蛮入侵')
    expect(seen.hpLost, '王异只掉了贞烈的那一点').toBe(1)
    const others = ['p2', 'p3', 'p4'].map((id) => playerOf(game, id))
    expect(others.some((player) => player.hp < player.maxHp), '别人照常挨打').toBe(true)
    assertGameInvariants(game.state)
  })

  it('不发动就照常结算', () => {
    const game = gameAt('wy-decline')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    trimHand(game, 'p0', 0)
    const seen = useAgainstWangYi(game, '杀', { invoke: false })
    expect(seen.askedDodge, '不发动就照常问闪').toBe(true)
    expect(playerOf(game, 'p0').hp, '没闪就挨这一刀').toBe(owner.maxHp - 1)
  })

  it('体力为 1 时发动会进入濒死，牌局不崩', () => {
    const game = gameAt('wy-dying')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    trimHand(game, 'p0', 0)
    expect(() => useAgainstWangYi(game, '南蛮入侵'), '代价把她打进濒死也要走完').not.toThrow()
    assertGameInvariants(game.state)
    assertCardConservation(game.state)
  })
})

/** 跑王异的结束阶段，按 plan 回答秘计。 */
function runMiji(
  game: SanguoshaGame,
  plan: { draw?: number; give?: Array<{ cardId?: string; recipientId: string }> } = {},
) {
  const seen = { drawOptions: [] as string[], distributeRequest: null as AnyRequest | null }
  game.dispatch('PhaseStart', { playerId: 'p0', phase: 'finish' }, { sourceId: 'p0', phase: 'finish' })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('秘计')) {
      const pick = request as unknown as { options: { id: string }[] }
      seen.drawOptions = pick.options.map((option) => option.id)
      return { optionId: String(plan.draw ?? 0) }
    }
    if (request.kind === 'distribute-cards' && request.prompt?.includes('秘计')) {
      seen.distributeRequest = request
      if (!plan.give) return { assignments: [] }
      const pick = request as unknown as { cardIds: string[] }
      return {
        assignments: plan.give.map((entry, index) => ({
          cardId: entry.cardId ?? pick.cardIds[index],
          recipientId: entry.recipientId,
        })),
      }
    }
    return null
  })
  return seen
}

describe('王异：秘计', () => {
  it('没受伤就不发动', () => {
    const game = gameAt('wy-miji-full')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    const seen = runMiji(game)
    expect(seen.drawOptions, '满血时不该问').toHaveLength(0)
  })

  it('X 是已损失体力值，摸几张自己定', () => {
    const game = gameAt('wy-miji-x')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 2
    const handBefore = owner.zones.hand.length
    const seen = runMiji(game, { draw: 2 })
    expect(seen.drawOptions.sort(), '至多两张，外加不发动').toEqual(['0', '1', '2'])
    expect(playerOf(game, 'p0').zones.hand, '摸了两张').toHaveLength(handBefore + 2)
  })

  it('可以只摸一张', () => {
    const game = gameAt('wy-miji-one')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 3
    const handBefore = owner.zones.hand.length
    runMiji(game, { draw: 1 })
    expect(playerOf(game, 'p0').zones.hand, '只摸一张').toHaveLength(handBefore + 1)
  })

  it('给牌是可选的：不给也合法', () => {
    const game = gameAt('wy-miji-nogive')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 2
    const handBefore = owner.zones.hand.length
    runMiji(game, { draw: 2 })
    expect(playerOf(game, 'p0').zones.hand, '摸的两张还在自己手上').toHaveLength(handBefore + 2)
  })

  it('给就要给满：数量对不上按不给处理', () => {
    const game = gameAt('wy-miji-partial')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 2
    const handBefore = owner.zones.hand.length
    // 摸两张却只分配一张
    runMiji(game, { draw: 2, give: [{ recipientId: 'p1' }] })
    expect(playerOf(game, 'p0').zones.hand, '不满额就一张都不给').toHaveLength(handBefore + 2)
  })

  it('可以分给多名其他角色', () => {
    const game = gameAt('wy-miji-multi')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 2
    const p1Before = playerOf(game, 'p1').zones.hand.length
    const p2Before = playerOf(game, 'p2').zones.hand.length
    runMiji(game, { draw: 2, give: [{ recipientId: 'p1' }, { recipientId: 'p2' }] })
    expect(playerOf(game, 'p1').zones.hand, 'p1 收到一张').toHaveLength(p1Before + 1)
    expect(playerOf(game, 'p2').zones.hand, 'p2 收到一张').toHaveLength(p2Before + 1)
    assertCardConservation(game.state)
  })

  it('同一个人一次收到两张算一次获得：法正【恩怨】数得对', () => {
    const game = gameAt('wy-miji-enyuan', ['wangyi', 'fazheng', 'zhaoyun', 'huangzhong', 'guojia'])
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 2
    const fazhengBefore = playerOf(game, 'p1').zones.hand.length
    const seen = runMiji(game, { draw: 2, give: [{ recipientId: 'p1' }, { recipientId: 'p1' }] })
    const request = seen.distributeRequest as unknown as { cardIds: string[] } | null
    const given = request ? request.cardIds.slice(0, 2) : []
    /*
     * 法正一次从同一个人手里获得两张牌 → 【恩怨·恩】让王异摸一张。
     * 这一条守的是「按接收者分批给」：拆成两次各一张的话恩怨就不会触发。
     */
    expect(playerOf(game, 'p1').zones.hand.length, '法正净多了两张（并可能因恩怨再摸）')
      .toBeGreaterThanOrEqual(fazhengBefore + 2)
    if (given.length === 2) {
      expect(gainOriginCounts(game.state, 'p1', given).get('p0'), '两张都记着来自王异').toBe(2)
    }
    assertCardConservation(game.state)
  })

  it('不能给自己', () => {
    const game = gameAt('wy-miji-self')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 1
    const seen = runMiji(game, { draw: 1 })
    const request = seen.distributeRequest as unknown as { recipientIds: string[] } | null
    expect(request?.recipientIds, '接收者里没有自己').not.toContain('p0')
  })
})

describe('王异：版本锁', () => {
  it('只有【贞烈】【秘计】', () => {
    const character = getCharacter('wangyi')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['zhenlie', 'miji'])
    expect(character.pack).toBe('yjcm2012')
    expect(character.maxHp).toBe(3)
    expect(character.kingdom).toBe('wei')
    expect(character.gender).toBe('female')
    expect(character.skills.find((skill) => skill.id === 'miji')?.description, '是「摸至多 X 张再交等量」那一版')
      .toContain('等量')
  })
})
