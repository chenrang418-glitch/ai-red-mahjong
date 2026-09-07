import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { effectiveCardColor } from '@/sanguosha/engine/skills/runtime'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 关兴张苞【父魂】。
 *
 * 逐条有断言的主张：
 *
 * - 恰好两张、只能是手牌；装备区不算，手牌不足两张时按钮不出现；
 * - 合成的【杀】走**正常**使用管线：距离、次数照常，不是「技能生成的杀」；
 * - 颜色按两张子牌聚合：全红红、全黑黑、混色**无色**；
 * - 造成伤害之后才授技，被闪掉不授；
 * - 授的是既有的【武圣】【咆哮】两个技能运行时，两个都在；
 * - 回合结束收回，而且只收回这一次授予的。
 */

const CAST = ['guanxingzhangbao', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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

/** 清空手牌，然后按颜色精确发牌，让「两张子牌的颜色」可控。 */
function dealHand(game: SanguoshaGame, playerId: string, colors: Array<'red' | 'black'>): string[] {
  const owner = playerOf(game, playerId)
  for (const cardId of [...owner.zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  const used = new Set<string>()
  const dealt: string[] = []
  for (const color of colors) {
    const card = Object.values(game.state.cards).find((candidate) => !candidate.virtual
      && candidate.color === color
      && !used.has(candidate.id)
      // 不用会自己触发效果的牌当子牌：这里只关心颜色
      && candidate.category === 'basic'
      && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
    if (!card) throw new Error(`牌堆里凑不出一张${color}色基本牌`)
    used.add(card.id)
    moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
    dealt.push(card.id)
  }
  return dealt
}

function fuhunAction(game: SanguoshaGame, playerId: string) {
  return game.legalActions(playerId).find((action) => action.kind === 'invoke-skill' && action.id === 'fuhun-invoke')
}

/**
 * 用父魂对 targetId 打一张【杀】。
 * `dodge` 决定目标是否闪掉。返回目标掉了几点体力。
 */
function playFuhunSlash(
  game: SanguoshaGame,
  ownerId: string,
  targetId: string,
  subCards: string[],
  options: { dodge?: boolean } = {},
): number {
  const before = playerOf(game, targetId).hp
  const action = fuhunAction(game, ownerId)!
  game.act(ownerId, action.id)
  settle(game, (request) => {
    if (request.playerId === ownerId && request.kind === 'choose-cards' && request.prompt?.includes('父魂')) {
      return { cardIds: subCards }
    }
    if (request.playerId === ownerId && request.kind === 'choose-targets' && request.prompt?.includes('父魂')) {
      return { targetIds: [targetId] }
    }
    if (request.playerId === targetId && !options.dodge) return { actionId: 'respond-pass' }
    return null
  })
  return before - playerOf(game, targetId).hp
}

describe('关兴张苞【父魂】：合成', () => {
  it('手牌不足两张时按钮不出现', () => {
    const game = gameAt('fuhun-need-two')
    playerOf(game, 'p0').attackRangeBonus = 6
    dealHand(game, 'p0', ['red'])
    expect(fuhunAction(game, 'p0'), '只有一张手牌，凑不出两张').toBeUndefined()
    dealHand(game, 'p0', ['red', 'black'])
    expect(fuhunAction(game, 'p0'), '两张手牌就能发动').toBeDefined()
  })

  it('装备区的牌不算：手牌只剩一张时仍然发不出', () => {
    const game = gameAt('fuhun-hand-only')
    playerOf(game, 'p0').attackRangeBonus = 6
    const [handCard] = dealHand(game, 'p0', ['red', 'black'])
    const other = playerOf(game, 'p0').zones.hand.find((cardId) => cardId !== handCard)!
    // 把第二张塞进装备区当武器位占位，手上只剩一张
    moveCard(game.state, other, { kind: 'hand', playerId: 'p0' }, { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    expect(fuhunAction(game, 'p0'), '装备区的牌不能当父魂的子牌').toBeUndefined()
  })

  it('两张子牌真的被消耗，合成的【杀】结算完不留残牌', () => {
    const game = gameAt('fuhun-consume')
    playerOf(game, 'p0').attackRangeBonus = 6
    const subCards = dealHand(game, 'p0', ['red', 'black'])
    playFuhunSlash(game, 'p0', 'p1', subCards)

    expect(playerOf(game, 'p0').zones.hand, '两张子牌都离手了').toHaveLength(0)
    for (const cardId of subCards) {
      expect(game.state.zones.discardPile, '子牌进弃牌堆').toContain(cardId)
    }
    const leftovers = Object.keys(game.state.cards).filter((cardId) => cardId.startsWith('virtual:fuhun'))
    expect(leftovers, '虚拟【杀】结算完已经销毁').toHaveLength(0)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('走的是正常使用管线：出杀次数照常消耗', () => {
    /*
     * 这里刻意让目标**闪掉**这一张。
     *
     * 打中的话父魂会当场授予【咆哮】，出杀就没有次数限制了——
     * 那时候第二个按钮仍然在是**对的**，验不出「次数照常消耗」这件事。
     * 所以要用一张没造成伤害的【杀】来验次数。
     */
    const game = gameAt('fuhun-counts-usage')
    playerOf(game, 'p0').attackRangeBonus = 6
    const subCards = dealHand(game, 'p0', ['red', 'black', 'red', 'black'])
    const dodge = Object.values(game.state.cards).find((card) => card.name === '闪' && !card.virtual
      && (game.state.zones.drawPile.includes(card.id) || game.state.zones.discardPile.includes(card.id)))!
    moveCard(game.state, dodge.id, locate(game.state, dodge.id), { kind: 'hand', playerId: 'p1' })

    const action = fuhunAction(game, 'p0')!
    game.act('p0', action.id)
    settle(game, (request) => {
      if (request.playerId === 'p0' && request.kind === 'choose-cards' && request.prompt?.includes('父魂')) {
        return { cardIds: subCards.slice(0, 2) }
      }
      if (request.playerId === 'p0' && request.kind === 'choose-targets' && request.prompt?.includes('父魂')) {
        return { targetIds: ['p1'] }
      }
      if (request.playerId === 'p1') return { actionId: `respond-dodge:${dodge.id}` }
      return null
    })

    expect(game.state.turnUsage.slashUses, '这一张【杀】计入次数').toBe(1)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '被闪掉，没有拿到咆哮').not.toContain('paoxiao')
    expect(playerOf(game, 'p0').zones.hand.length, '手上还剩两张，凑得出第二次').toBe(2)
    expect(fuhunAction(game, 'p0'), '本阶段的出杀次数用完了，父魂也用不出第二张').toBeUndefined()
  })

  it('打中之后拿到【咆哮】，同一个出牌阶段里还能再用一次父魂', () => {
    const game = gameAt('fuhun-paoxiao-unlimited')
    playerOf(game, 'p0').attackRangeBonus = 6
    const subCards = dealHand(game, 'p0', ['red', 'black', 'red', 'black'])
    playFuhunSlash(game, 'p0', 'p1', subCards.slice(0, 2))
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '打中了，拿到咆哮').toContain('paoxiao')
    expect(fuhunAction(game, 'p0'), '咆哮让出杀不限次，第二张父魂杀合法').toBeDefined()
    expect(playFuhunSlash(game, 'p0', 'p1', subCards.slice(2)), '第二张也真的打出去了').toBe(1)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('关兴张苞【父魂】：颜色按两张子牌聚合', () => {
  const cases: Array<[string, Array<'red' | 'black'>, 'red' | 'black' | null]> = [
    ['两张都是红的就是红牌', ['red', 'red'], 'red'],
    ['两张都是黑的就是黑牌', ['black', 'black'], 'black'],
    ['一红一黑就是无色', ['red', 'black'], null],
  ]
  for (const [name, colors, expected] of cases) {
    it(name, () => {
      const game = gameAt(`fuhun-color-${colors.join('-')}`)
      playerOf(game, 'p0').attackRangeBonus = 6
      const subCards = dealHand(game, 'p0', colors)
      const action = fuhunAction(game, 'p0')!
      game.act('p0', action.id)

      let observed: 'red' | 'black' | null | undefined
      settle(game, (request) => {
        if (request.playerId === 'p0' && request.kind === 'choose-cards' && request.prompt?.includes('父魂')) {
          return { cardIds: subCards }
        }
        if (request.playerId === 'p0' && request.kind === 'choose-targets' && request.prompt?.includes('父魂')) {
          // 选目标这一步印出来的【杀】已经在手上了，正好在这里读它的颜色
          const slash = playerOf(game, 'p0').zones.hand.find((cardId) => cardId.startsWith('virtual:fuhun'))!
          observed = effectiveCardColor(game.state, 'p0', slash)
          return { targetIds: ['p1'] }
        }
        return null
      })
      expect(observed, '颜色按两张子牌聚合').toBe(expected)
    })
  }
})

describe('关兴张苞【父魂】：打出', () => {
  /** 让 p1 对全场用一张【南蛮入侵】，p0 必须打出【杀】。 */
  function playInvasion(game: SanguoshaGame): string {
    const card = Object.values(game.state.cards).find((candidate) => candidate.name === '南蛮入侵'
      && !candidate.virtual
      && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))!
    moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId: 'p1' })
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '南蛮入侵')!
    game.act('p1', action.id)
    return card.id
  }

  it('可以用两张手牌当【杀】打出来响应【南蛮入侵】', () => {
    const game = gameAt('fuhun-respond')
    const subCards = dealHand(game, 'p0', ['red', 'black'])
    playInvasion(game)

    // 南蛮按座次逐个问，关兴张苞排在最后；这里记下轮到他时面板上有哪些动作
    let offered: string[] = []
    settle(game, (request) => {
      if (request.playerId === 'p0' && request.kind === 'choose-cards' && request.prompt?.includes('父魂')) {
        return { cardIds: subCards }
      }
      if (request.playerId === 'p0') {
        offered = (request as AnyRequest & { actionIds?: string[] }).actionIds ?? []
        return { actionId: 'multi-viewas' }
      }
      return null
    })
    expect(offered, '响应面板上有多牌转化这一条').toContain('multi-viewas')

    expect(playerOf(game, 'p0').hp, '打出了【杀】，没有受到南蛮的伤害').toBe(playerOf(game, 'p0').maxHp)
    expect(playerOf(game, 'p0').zones.hand, '两张牌都花出去了').toHaveLength(0)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('打出不授技', () => {
    const game = gameAt('fuhun-respond-no-grant')
    const subCards = dealHand(game, 'p0', ['red', 'black'])
    playInvasion(game)
    settle(game, (request) => {
      if (request.playerId === 'p0' && request.kind === 'choose-cards' && request.prompt?.includes('父魂')) {
        return { cardIds: subCards }
      }
      if (request.playerId === 'p0') return { actionId: 'multi-viewas' }
      return null
    })
    const owned = ownedSkillIds(game.state, 'p0', skillIdsOf)
    expect(owned, '打出不是「使用」，不授武圣').not.toContain('wusheng')
    expect(owned, '打出不是「使用」，不授咆哮').not.toContain('paoxiao')
  })

  it('手牌只有一张时响应面板上没有这一条', () => {
    const game = gameAt('fuhun-respond-need-two')
    dealHand(game, 'p0', ['red'])
    playInvasion(game)
    let offered: string[] | null = null
    settle(game, (request) => {
      if (request.playerId === 'p0') offered = (request as AnyRequest & { actionIds?: string[] }).actionIds ?? []
      return null
    })
    expect(offered, '关兴张苞确实被问到了').not.toBeNull()
    expect(offered ?? [], '凑不出两张就不给这个选项').not.toContain('multi-viewas')
  })
})

describe('关兴张苞【父魂】：授技', () => {
  it('造成伤害后视为拥有【武圣】和【咆哮】', () => {
    const game = gameAt('fuhun-grant')
    playerOf(game, 'p0').attackRangeBonus = 6
    const subCards = dealHand(game, 'p0', ['red', 'black'])
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '一开始没有武圣').not.toContain('wusheng')

    const lost = playFuhunSlash(game, 'p0', 'p1', subCards)
    expect(lost, '这一张【杀】真的造成了伤害').toBe(1)
    const owned = ownedSkillIds(game.state, 'p0', skillIdsOf)
    expect(owned, '临时获得武圣').toContain('wusheng')
    expect(owned, '临时获得咆哮，两个都要给').toContain('paoxiao')
  })

  it('被闪掉就不授技', () => {
    const game = gameAt('fuhun-dodged')
    playerOf(game, 'p0').attackRangeBonus = 6
    const subCards = dealHand(game, 'p0', ['red', 'black'])
    // 给目标一张【闪】并让他打出来
    const dodge = Object.values(game.state.cards).find((card) => card.name === '闪' && !card.virtual
      && (game.state.zones.drawPile.includes(card.id) || game.state.zones.discardPile.includes(card.id)))!
    moveCard(game.state, dodge.id, locate(game.state, dodge.id), { kind: 'hand', playerId: 'p1' })

    const action = fuhunAction(game, 'p0')!
    game.act('p0', action.id)
    settle(game, (request) => {
      if (request.playerId === 'p0' && request.kind === 'choose-cards' && request.prompt?.includes('父魂')) {
        return { cardIds: subCards }
      }
      if (request.playerId === 'p0' && request.kind === 'choose-targets' && request.prompt?.includes('父魂')) {
        return { targetIds: ['p1'] }
      }
      if (request.playerId === 'p1') return { actionId: `respond-dodge:${dodge.id}` }
      return null
    })

    expect(playerOf(game, 'p1').hp, '被闪掉，没有掉血').toBe(playerOf(game, 'p1').maxHp)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '没有造成伤害就不授技').not.toContain('wusheng')
  })

  it('回合结束时收回，而且只收回这一次授予的', () => {
    const game = gameAt('fuhun-expire')
    playerOf(game, 'p0').attackRangeBonus = 6
    const subCards = dealHand(game, 'p0', ['red', 'black'])
    // 他本来就被别处授予了咆哮：回合结束时这一个不能被一起收走
    playerOf(game, 'p0').grantedSkills = [...(playerOf(game, 'p0').grantedSkills ?? []), 'paoxiao']

    playFuhunSlash(game, 'p0', 'p1', subCards)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).toContain('wusheng')

    // 走到这个回合结束
    for (let guard = 0; guard < 12; guard += 1) {
      game.advancePhase()
      settle(game)
      if (game.state.currentPlayerId !== 'p0') break
    }
    const owned = ownedSkillIds(game.state, 'p0', skillIdsOf)
    expect(owned, '父魂临时授予的武圣已经收回').not.toContain('wusheng')
    expect(owned, '别处授予的咆哮不受影响').toContain('paoxiao')
    assertGameInvariants(game.state)
  })
})
