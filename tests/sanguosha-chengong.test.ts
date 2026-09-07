import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 陈宫（一将成名 2011 经典）。
 *
 * 七条主张，逐条有断言：
 *
 * - 【明策】的代价是手牌里的【杀】或装备牌，加上装备区里的装备；
 * - 牌是真的交过去的，装备进的是手牌、不会自动装备；
 * - 选哪一项由收牌的人决定；拿不出合法的 B 就直接摸一张；
 * - 那一刀是**虚拟的**：使用者和伤害来源都是 A，刚收到的【杀】仍在他手里；
 * - 【智迟】只在回合外真的受到伤害后触发，自己回合、被防止的都不算；
 * - 激活后【杀】和非延时锦囊对他无效，而且**不问他要闪**；
 * - 延时锦囊不受影响；当前回合结束就失效。
 */

const CAST = ['chengong', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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

function equipAny(game: SanguoshaGame, playerId: string, slot: 'weapon' | 'armor' | 'defensiveHorse'): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.category === 'equipment'
    && candidate.equipmentSlot === slot
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的${slot}装备`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'equipment', playerId, slot })
  return card.id
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  for (const cardId of playerOf(game, playerId).zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

function mingceAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id.includes('mingce'))
}

/** 跑一次明策。 */
function runMingce(
  game: SanguoshaGame,
  plan: { cardId?: string; userId?: string; victimId?: string; choice?: 'slash' | 'draw' } = {},
) {
  const seen = {
    costRequest: null as AnyRequest | null,
    victimRequest: null as AnyRequest | null,
    choiceRequest: null as AnyRequest | null,
  }
  const action = mingceAction(game)
  if (!action) return seen
  game.act('p0', action.id)
  settle(game, (request) => {
    if (request.kind === 'choose-cards' && request.prompt?.includes('明策')) {
      seen.costRequest = request
      const pick = request as unknown as { cardIds: string[] }
      const wanted = plan.cardId && pick.cardIds.includes(plan.cardId) ? plan.cardId : pick.cardIds[0]
      return { cardIds: wanted ? [wanted] : [] }
    }
    if (request.kind === 'choose-targets' && request.prompt?.includes('交给哪名角色')) {
      const pick = request as unknown as { candidateIds: string[] }
      const wanted = plan.userId && pick.candidateIds.includes(plan.userId) ? plan.userId : pick.candidateIds[0]
      return { targetIds: [wanted] }
    }
    if (request.kind === 'choose-targets' && request.prompt?.includes('攻击范围内的角色')) {
      seen.victimRequest = request
      const pick = request as unknown as { candidateIds: string[] }
      const wanted = plan.victimId && pick.candidateIds.includes(plan.victimId) ? plan.victimId : pick.candidateIds[0]
      return { targetIds: [wanted] }
    }
    if (request.kind === 'choose-option' && request.prompt?.includes('明策')) {
      seen.choiceRequest = request
      return { optionId: plan.choice ?? 'draw' }
    }
    return null
  })
  return seen
}

describe('陈宫：明策', () => {
  it('代价是手牌里的【杀】或装备牌，普通锦囊不行', () => {
    const game = gameAt('cg-cost')
    trimHand(game, 'p0', 0)
    const slash = giveCard(game, 'p0', '杀')
    const equip = giveCard(game, 'p0', '青龙偃月刀')
    const trick = giveCard(game, 'p0', '决斗')
    const seen = runMingce(game, { choice: 'draw' })
    const request = seen.costRequest as unknown as { cardIds: string[] }
    expect(request.cardIds, '手牌里的杀可以').toContain(slash)
    expect(request.cardIds, '手牌里的装备可以').toContain(equip)
    expect(request.cardIds, '普通锦囊不行').not.toContain(trick)
  })

  it('装备区里的装备也能交出去', () => {
    const game = gameAt('cg-equipzone')
    trimHand(game, 'p0', 0)
    const weapon = equipAny(game, 'p0', 'weapon')
    const seen = runMingce(game, { cardId: weapon, userId: 'p1', choice: 'draw' })
    const request = seen.costRequest as unknown as { cardIds: string[] }
    expect(request.cardIds, '装备区的装备在候选里').toContain(weapon)
    expect(playerOf(game, 'p1').zones.hand, '交过去之后进的是手牌').toContain(weapon)
    expect(Object.values(playerOf(game, 'p1').zones.equipment), '不会自动装备').not.toContain(weapon)
    assertCardConservation(game.state)
  })

  it('出牌阶段限一次', () => {
    const game = gameAt('cg-once')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '杀')
    giveCard(game, 'p0', '杀')
    runMingce(game, { choice: 'draw' })
    expect(mingceAction(game), '一个回合只能来一次').toBeUndefined()
  })

  it('选哪一项由收牌的那个人回答', () => {
    const game = gameAt('cg-decider')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '杀')
    playerOf(game, 'p1').attackRangeBonus = 6
    const seen = runMingce(game, { userId: 'p1', choice: 'draw' })
    expect(seen.choiceRequest?.playerId, '问的是收牌的人').toBe('p1')
  })

  it('选摸一张就真的摸一张', () => {
    const game = gameAt('cg-draw')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '杀')
    playerOf(game, 'p1').attackRangeBonus = 6
    const before = playerOf(game, 'p1').zones.hand.length
    runMingce(game, { userId: 'p1', choice: 'draw' })
    // 收到明策那张牌 +1，再摸一张 +1
    expect(playerOf(game, 'p1').zones.hand, '收到一张、又摸了一张').toHaveLength(before + 2)
    assertCardConservation(game.state)
  })

  it('A 的攻击范围里没有别人时直接摸一张，不弹空窗口', () => {
    const game = gameAt('cg-nob')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '杀')
    // 把 p1 的攻击范围压到够不着任何人
    for (const player of game.state.players) player.attackRangeBonus = -5
    const before = playerOf(game, 'p1').zones.hand.length
    const seen = runMingce(game, { userId: 'p1' })
    expect(seen.victimRequest, '没有合法的 B 就不该问').toBeNull()
    expect(seen.choiceRequest, '也不该给一个只能摸牌的选择窗').toBeNull()
    expect(playerOf(game, 'p1').zones.hand, '直接摸一张').toHaveLength(before + 2)
  })

  it('B 可以是陈宫自己', () => {
    const game = gameAt('cg-b-self')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '杀')
    playerOf(game, 'p1').attackRangeBonus = 6
    const seen = runMingce(game, { userId: 'p1', victimId: 'p0', choice: 'draw' })
    const request = seen.victimRequest as unknown as { candidateIds: string[] }
    expect(request.candidateIds, '陈宫本人也在候选里').toContain('p0')
  })

  it('选出杀：那一刀是虚拟的，刚收到的【杀】仍然留在他手里', () => {
    const game = gameAt('cg-slash')
    trimHand(game, 'p0', 0)
    const given = giveCard(game, 'p0', '杀')
    trimHand(game, 'p2', 0)
    playerOf(game, 'p1').attackRangeBonus = 6
    const victim = playerOf(game, 'p2')
    victim.hp = victim.maxHp
    const damages: Array<{ source?: string; target?: string }> = []
    game.events.on('Damaged', (handled) => {
      damages.push({ source: handled.event.sourceId, target: handled.event.targetId })
    })
    runMingce(game, { userId: 'p1', victimId: 'p2', choice: 'slash' })
    expect(playerOf(game, 'p1').zones.hand, '明策交过去的那张杀没有被当成载体').toContain(given)
    expect(damages, '伤害来源是收牌的那个人，不是陈宫')
      .toEqual([{ source: 'p1', target: 'p2' }])
    assertCardConservation(game.state)
  })

  it('虚拟【杀】完整走求闪流程', () => {
    const game = gameAt('cg-dodge')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '杀')
    playerOf(game, 'p1').attackRangeBonus = 6
    trimHand(game, 'p2', 0)
    giveCard(game, 'p2', '闪')
    const victim = playerOf(game, 'p2')
    victim.hp = victim.maxHp
    let askedDodge = false
    const action = mingceAction(game)!
    game.act('p0', action.id)
    settle(game, (request) => {
      if (request.kind === 'respond-card' && request.playerId === 'p2') askedDodge = true
      if (request.kind === 'choose-cards' && request.prompt?.includes('明策')) {
        const pick = request as unknown as { cardIds: string[] }
        return { cardIds: pick.cardIds.slice(0, 1) }
      }
      if (request.kind === 'choose-targets' && request.prompt?.includes('交给哪名角色')) return { targetIds: ['p1'] }
      if (request.kind === 'choose-targets' && request.prompt?.includes('攻击范围内的角色')) return { targetIds: ['p2'] }
      if (request.kind === 'choose-option' && request.prompt?.includes('明策')) return { optionId: 'slash' }
      return null
    })
    expect(askedDodge, '照常问被打的人要闪').toBe(true)
  })
})

/** 让 p1 在自己的回合里打陈宫一下。 */
function damageChenGongOutsideTurn(game: SanguoshaGame, options: { cardName?: string | null } = {}) {
  game.state.currentPlayerId = 'p1'
  const owner = playerOf(game, 'p0')
  owner.hp = owner.maxHp
  resolveDamage(game as never, {
    sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'normal', cardName: options.cardName ?? null,
  })
  game.settle()
  settle(game)
}

function zhichiActive(game: SanguoshaGame): boolean {
  return playerOf(game, 'p0').marks['zhichi-turn'] === game.state.turnNumber
}

describe('陈宫：智迟的触发', () => {
  it('回合外受到伤害后激活', () => {
    const game = gameAt('cg-zhichi-on')
    damageChenGongOutsideTurn(game)
    expect(zhichiActive(game), '回合外挨打就激活').toBe(true)
  })

  it('自己回合里受到伤害不激活', () => {
    const game = gameAt('cg-zhichi-own')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    // currentPlayerId 仍然是 p0
    resolveDamage(game as never, { sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'normal' })
    game.settle()
    settle(game)
    expect(zhichiActive(game), '自己的回合不触发').toBe(false)
  })

  it('伤害被防止就不算受到伤害', () => {
    // p0 是陈宫，同时让他被无言保护是不现实的；这里用大雾式的完全防止：
    // 直接把伤害量设成会被绝情替换掉的情形——张春华当来源
    const game = gameAt('cg-zhichi-prevented', ['chengong', 'zhangchunhua', 'zhaoyun', 'huangzhong', 'guojia'])
    game.state.currentPlayerId = 'p1'
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    resolveDamage(game as never, { sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'normal' })
    game.settle()
    settle(game)
    expect(owner.hp, '绝情把伤害换成了失去体力，血照掉').toBe(owner.maxHp - 1)
    expect(zhichiActive(game), '但他没有「受到伤害」，智迟不触发').toBe(false)
  })
})

describe('陈宫：智迟的效果', () => {
  it('【杀】对他无效，而且不问他要闪', () => {
    const game = gameAt('cg-zhichi-slash')
    damageChenGongOutsideTurn(game)
    const before = playerOf(game, 'p0').hp
    let askedDodge = false
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    playerOf(game, 'p1').attackRangeBonus = 6
    const slash = giveCard(game, 'p1', '杀')
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)
    settle(game, (request) => {
      if (request.kind === 'respond-card' && request.playerId === 'p0') askedDodge = true
      return null
    })
    expect(playerOf(game, 'p0').hp, '这一刀打不进来').toBe(before)
    expect(askedDodge, '既然无效就不该问他要闪').toBe(false)
  })

  it('非延时锦囊对他无效：决斗、南蛮、桃园、五谷都一样', () => {
    for (const [seed, cardName] of [
      ['cg-duel', '决斗'],
      ['cg-nanman', '南蛮入侵'],
      ['cg-taoyuan', '桃园结义'],
      ['cg-wugu', '五谷丰登'],
    ] as const) {
      const game = gameAt(seed)
      damageChenGongOutsideTurn(game)
      const owner = playerOf(game, 'p0')
      owner.hp = 1
      const handBefore = owner.zones.hand.length
      const skills: string[] = []
      game.events.on('SkillActivated', (handled) => {
        const skillId = (handled.event.payload as { skillId?: string }).skillId
        if (skillId) skills.push(skillId)
      })
      game.state.currentPlayerId = 'p1'
      game.state.phase = 'play'
      const cardId = giveCard(game, 'p1', cardName)
      const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
        && candidate.cardIds.includes(cardId))
      if (!action) continue
      game.act('p1', action.id)
      settle(game)
      expect(skills, `${cardName} 对陈宫无效要报一行`).toContain('zhichi')
      if (cardName === '桃园结义') {
        expect(playerOf(game, 'p0').hp, '桃园对他无效，回不了血').toBe(1)
      }
      if (cardName === '五谷丰登') {
        expect(playerOf(game, 'p0').zones.hand, '五谷对他无效，拿不到牌').toHaveLength(handBefore)
      }
      assertCardConservation(game.state)
    }
  })

  it('延时锦囊不受影响', () => {
    const game = gameAt('cg-delayed')
    damageChenGongOutsideTurn(game)
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const cardId = giveCard(game, 'p1', '乐不思蜀')
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(cardId) && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)
    settle(game)
    expect(playerOf(game, 'p0').zones.judgingArea, '延时锦囊照常贴上').toContain(cardId)
    assertCardConservation(game.state)
  })

  it('南蛮对其他人照常生效，只有陈宫那一份无效', () => {
    const game = gameAt('cg-aoe')
    damageChenGongOutsideTurn(game)
    const chengongHp = playerOf(game, 'p0').hp
    for (const id of ['p2', 'p3', 'p4']) {
      const player = playerOf(game, id)
      player.hp = player.maxHp
      for (const cardId of [...player.zones.hand]) {
        moveCard(game.state, cardId, { kind: 'hand', playerId: id }, { kind: 'discardPile' })
      }
    }
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const cardId = giveCard(game, 'p1', '南蛮入侵')
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(cardId))!
    game.act('p1', action.id)
    settle(game)
    expect(playerOf(game, 'p0').hp, '陈宫没掉血').toBe(chengongHp)
    const others = ['p2', 'p3', 'p4'].map((id) => playerOf(game, id))
    expect(others.some((player) => player.hp < player.maxHp), '别人照常挨打').toBe(true)
  })

  it('当前回合结束就失效', () => {
    const game = gameAt('cg-expire')
    damageChenGongOutsideTurn(game)
    expect(zhichiActive(game)).toBe(true)
    // 回合序号一变就自然过期，不需要另外注册清理
    game.state.turnNumber += 1
    expect(zhichiActive(game), '下一个回合它就不生效了').toBe(false)
    assertGameInvariants(game.state)
  })
})

describe('陈宫：版本锁', () => {
  it('只有【明策】【智迟】', () => {
    const character = getCharacter('chengong')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['mingce', 'zhichi'])
    expect(character.pack).toBe('yjcm2011')
    expect(character.maxHp).toBe(3)
    expect(character.kingdom).toBe('qun')
  })
})
