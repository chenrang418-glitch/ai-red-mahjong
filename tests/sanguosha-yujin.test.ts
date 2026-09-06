import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 于禁（一将成名 2011 原版）。
 *
 * 三条主张，逐条有断言：
 *
 * - 条件是**防具栏里没有防具**，不是「装备区空着」；
 * - 是「对你**无效**」而不是「不能选你」：目标照常指定，但不问他要【闪】；
 * - 颜色按**有效颜色**算，转化技把黑牌当【杀】用同样被挡。
 */

/**
 * 于禁坐 p1：出牌阶段属于 p0，所以攻击者必须是 p0，被打的那个才是他。
 * 把他放 p0 的话根本没人能在他自己的回合里打他。
 */
const CAST = ['guanyu', 'yujin', 'zhangfei', 'zhaoyun', 'huangzhong']

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

/** 给某人一张指定牌名 + 颜色的牌。 */
function giveCard(game: SanguoshaGame, playerId: string, cardName: string, color?: 'red' | 'black'): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && !candidate.virtual
    && (color === undefined || candidate.color === color)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的【${cardName}】${color ?? ''}`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function equip(game: SanguoshaGame, playerId: string, cardName: string, slot: 'weapon' | 'armor' | 'offensiveHorse' | 'defensiveHorse'): string {
  const cardId = giveCard(game, playerId, cardName)
  moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'equipment', playerId, slot })
  return cardId
}

/**
 * p0 用一张【杀】打 p1（于禁），返回这次是否问过他要【闪】。
 */
function slashYuJin(game: SanguoshaGame, cardId: string): { askedDodge: boolean; damage: number } {
  const before = playerOf(game, 'p1').hp
  let askedDodge = false
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.asCardName === '杀'
    && candidate.cardIds.includes(cardId)
    && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('没有可用的【杀】动作')
  game.act('p0', action.id)
  settle(game, (request) => {
    if (request.kind === 'respond-card' && request.playerId === 'p1') askedDodge = true
    return null
  })
  return { askedDodge, damage: before - playerOf(game, 'p1').hp }
}

describe('于禁：毅重', () => {
  it('没有防具时，黑色【杀】对他无效，而且不会问他要【闪】', () => {
    const game = gameAt('yj-black')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    // 手里只留一张【闪】：牌根本没对他生效，这张闪不该被消耗
    for (const cardId of [...playerOf(game, 'p1').zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    giveCard(game, 'p1', '闪')
    const slash = giveCard(game, 'p0', '杀', 'black')

    const result = slashYuJin(game, slash)
    expect(result.damage, '黑色【杀】打不进来').toBe(0)
    expect(result.askedDodge, '既然无效就不该再问他要闪').toBe(false)
    expect(playerOf(game, 'p1').zones.hand, '闪也没被消耗').toHaveLength(1)
    assertCardConservation(game.state)
  })

  it('红色【杀】照常结算', () => {
    const game = gameAt('yj-red')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    const slash = giveCard(game, 'p0', '杀', 'red')
    const result = slashYuJin(game, slash)
    expect(result.askedDodge, '红【杀】照常求闪').toBe(true)
    expect(result.damage, '没闪就照常掉血').toBe(1)
  })

  it('只有武器或只有马时，毅重照样生效', () => {
    for (const [seed, slot, name] of [
      ['yj-weapon', 'weapon', '青龙偃月刀'],
      ['yj-horse', 'defensiveHorse', '绝影'],
    ] as const) {
      const game = gameAt(seed)
      playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
      // +1 马会把距离拉开，这里测的不是距离，所以给攻击者足够的攻击范围
      playerOf(game, 'p0').attackRangeBonus = 5
      equip(game, 'p1', name, slot)
      const slash = giveCard(game, 'p0', '杀', 'black')
      const result = slashYuJin(game, slash)
      expect(result.damage, `${name}：条件看的是防具栏，不是整个装备区`).toBe(0)
    }
  })

  it('装上防具之后毅重就不生效了', () => {
    const game = gameAt('yj-armor')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    equip(game, 'p1', '仁王盾', 'armor')
    const slash = giveCard(game, 'p0', '杀', 'black')
    const result = slashYuJin(game, slash)
    /*
     * 仁王盾自己就挡黑【杀】，所以这里断言的是「毅重让位、按装备规则走」：
     * 伤害仍然是 0，但那是仁王盾挡的。换一件不挡黑杀的防具才看得出毅重没生效。
     */
    expect(result.damage).toBe(0)

    const other = gameAt('yj-armor-bagua')
    playerOf(other, 'p1').hp = playerOf(other, 'p1').maxHp
    equip(other, 'p1', '八卦阵', 'armor')
    const blackSlash = giveCard(other, 'p0', '杀', 'black')
    let asked = false
    const action = other.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.cardIds.includes(blackSlash) && candidate.targetIds.includes('p1'))!
    other.act('p0', action.id)
    settle(other, (request) => {
      if (request.playerId === 'p1') asked = true
      return null
    })
    expect(asked, '有防具时毅重不生效，照常进入响应流程').toBe(true)
  })

  it('技能凭空生成的【杀】没有颜色，不被毅重挡', () => {
    const game = gameAt('yj-virtual')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    /*
     * 虚拟【杀】没有实体牌，也就没有颜色。
     * 「没有颜色」不等于「黑色」——毅重管的是黑色的【杀】。
     */
    game.beginVirtualSlash({ sourceId: 'p0', targetId: 'p1', sourceSkillId: 'test' })
    settle(game)
    expect(playerOf(game, 'p1').hp, '无色【杀】照常打进来').toBeLessThan(target.maxHp)
  })

  it('转化牌按有效颜色算：关羽用红牌当【杀】，毅重挡不住', () => {
    // p0 是关羽，【武圣】可以把红色牌当【杀】用
    const game = gameAt('yj-viewas')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    const red = giveCard(game, 'p0', '桃', 'red')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.cardIds.includes(red) && candidate.targetIds.includes('p1'))
    expect(action, '武圣把红牌当【杀】的动作应当存在').toBeTruthy()
    game.act('p0', action!.id)
    let asked = false
    settle(game, (request) => {
      if (request.kind === 'respond-card' && request.playerId === 'p1') asked = true
      return null
    })
    /*
     * 有效颜色是**红**，所以毅重不该挡——这一条正好证明判断读的是
     * 实体牌的有效颜色，而不是「这是一张【杀】」。
     */
    expect(asked, '红色转化【杀】照常求闪').toBe(true)
    assertGameInvariants(game.state)
  })

  it('技能造成的无效会报一行战报：牌不能凭空消失', () => {
    const game = gameAt('yj-log')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    const skills: string[] = []
    game.events.on('SkillActivated', (handled) => {
      const skillId = (handled.event.payload as { skillId?: string }).skillId
      if (skillId) skills.push(skillId)
    })
    const slash = giveCard(game, 'p0', '杀', 'black')
    slashYuJin(game, slash)
    /*
     * 仁王盾、藤甲摆在桌上，玩家自己看得见；技能造成的无效没有任何可见凭据，
     * 不报的话所有人只会看到一张【杀】凭空消失。
     */
    expect(skills, '毅重挡下来的时候要有战报').toContain('yizhong')
  })
})

describe('于禁：版本锁', () => {
  it('只有【毅重】，没有别的技能', () => {
    const character = getCharacter('yujin')!
    expect(character.skills.map((skill) => skill.id), '本项目这一版只实现毅重').toEqual(['yizhong'])
    expect(character.pack).toBe('yjcm2011')
    expect(character.maxHp).toBe(4)
  })
})
