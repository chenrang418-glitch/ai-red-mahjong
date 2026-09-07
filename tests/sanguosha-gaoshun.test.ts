import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { canUseCardAs } from '@/sanguosha/engine/forced-identity'
import { isArmorSuppressed } from '@/sanguosha/engine/armor-suppression'
import { canUseSlashAtTargets } from '@/sanguosha/engine/slash-rules'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 高顺（一将成名 2011 经典）。
 *
 * 八条主张，逐条有断言：
 *
 * - 【陷阵】走公共拼点：双方各自秘密选牌，平局算「没赢」；
 * - 赢了之后三项都**只对那个目标**成立：无距离、无视防具、杀无次数；
 * - 多目标的杀只有在每个目标都是陷阵目标时才免次数；
 * - 无视防具是压制防具技能，牌仍然装着，对别人照常；
 * - 武将技能不是防具技能：于禁【毅重】不受影响；
 * - 没赢就本回合不能**使用**【杀】，但仍然可以打出响应；
 * - 【禁酒】把【酒】强制改写成【杀】：不能当酒喝、濒死救不了自己；
 * - 花色点数继承原牌。
 */

const CAST = ['gaoshun', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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

/** 给某人一张指定点数的牌，用来控制拼点结果。 */
function giveRank(game: SanguoshaGame, playerId: string, rank: number): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.rank === rank
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有点数 ${rank} 的闲置牌`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

/** 给某人装上**任意**一张防具。一副牌里同名防具只有一张，按名字找会撞车。 */
function equipAnyArmor(game: SanguoshaGame, playerId: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.category === 'equipment'
    && candidate.equipmentSlot === 'armor'
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error('牌堆里没有闲置的防具')
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'equipment', playerId, slot: 'armor' })
  return card.id
}

function equipNamed(game: SanguoshaGame, playerId: string, cardName: string, slot: 'weapon' | 'armor' | 'offensiveHorse' | 'defensiveHorse'): string {
  const cardId = giveCard(game, playerId, cardName)
  moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'equipment', playerId, slot })
  return cardId
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  for (const cardId of playerOf(game, playerId).zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

function xianzhenAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id.includes('xianzhen'))
}

/** 摆一场必胜 / 必败 / 平局的陷阵。 */
function runXianzhen(game: SanguoshaGame, targetId: string, outcome: 'win' | 'lose' | 'tie') {
  trimHand(game, 'p0', 0)
  trimHand(game, targetId, 0)
  const mine = outcome === 'win' ? 13 : outcome === 'lose' ? 2 : 7
  const cards = [giveRank(game, 'p0', mine), giveRank(game, targetId, 7)]
  const action = xianzhenAction(game)
  if (!action) throw new Error('陷阵动作不可用')
  game.act('p0', action.id)
  settle(game, (request) => {
    if (request.kind === 'choose-targets' && request.prompt?.includes('陷阵')) {
      return { targetIds: [targetId] }
    }
    return null
  })
  return cards
}

describe('高顺：陷阵的拼点', () => {
  it('双方都要有手牌才能拼点', () => {
    const game = gameAt('gs-nohand')
    trimHand(game, 'p0', 0)
    expect(xianzhenAction(game), '自己没有手牌就发不了').toBeUndefined()
  })

  it('赢了：对那个目标无距离限制、杀无次数限制、无视防具', () => {
    const game = gameAt('gs-win')
    equipNamed(game, 'p1', '八卦阵', 'armor')
    runXianzhen(game, 'p1', 'win')
    expect(isArmorSuppressed(game.state, 'p1', 'p0'), '防具对高顺失效').toBe(true)
    expect(canUseSlashAtTargets(game.state, 'p0', false, ['p1']), '对他出杀不受次数限制').toBe(true)
    expect(Object.values(playerOf(game, 'p1').zones.equipment).filter(Boolean), '牌还装着').toHaveLength(1)
  })

  it('平局算没赢：本回合不能使用【杀】', () => {
    const game = gameAt('gs-tie')
    runXianzhen(game, 'p1', 'tie')
    expect(canUseSlashAtTargets(game.state, 'p0', false, ['p1']), '平局走失败分支').toBe(false)
    expect(isArmorSuppressed(game.state, 'p1', 'p0'), '也没有无视防具').toBe(false)
  })

  it('输了：本回合不能使用【杀】', () => {
    const game = gameAt('gs-lose')
    runXianzhen(game, 'p1', 'lose')
    giveCard(game, 'p0', '杀')
    playerOf(game, 'p0').attackRangeBonus = 6
    const slashActions = game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.asCardName === '杀')
    expect(slashActions, '一条出杀的动作都不该有').toHaveLength(0)
  })

  it('拼点牌按统一规则进弃牌堆', () => {
    const game = gameAt('gs-pindian-discard')
    const cards = runXianzhen(game, 'p1', 'win')
    // 盯这两张牌本身，不数弃牌堆长度——布置阶段本来就往里丢了不少牌
    for (const cardId of cards) {
      expect(game.state.zones.discardPile, '拼点牌进了弃牌堆').toContain(cardId)
    }
    assertCardConservation(game.state)
  })
})

describe('高顺：陷阵的定向范围', () => {
  it('只对拼点的那个目标成立，别人不受影响', () => {
    const game = gameAt('gs-scoped')
    equipAnyArmor(game, 'p1')
    equipAnyArmor(game, 'p2')
    runXianzhen(game, 'p1', 'win')
    expect(isArmorSuppressed(game.state, 'p1', 'p0'), '拼点目标的防具失效').toBe(true)
    expect(isArmorSuppressed(game.state, 'p2', 'p0'), '别人的防具照常').toBe(false)
    expect(canUseSlashAtTargets(game.state, 'p0', false, ['p2']), '对别人出杀仍然受次数限制').toBe(true)
  })

  it('别人打陷阵目标时，他的防具照常生效', () => {
    const game = gameAt('gs-scoped-source')
    equipNamed(game, 'p1', '八卦阵', 'armor')
    runXianzhen(game, 'p1', 'win')
    expect(isArmorSuppressed(game.state, 'p1', 'p0'), '对高顺失效').toBe(true)
    expect(isArmorSuppressed(game.state, 'p1', 'p2'), '对别人不失效').toBe(false)
  })

  it('次数用光之后仍然打得到陷阵目标，但打不了别人', () => {
    const game = gameAt('gs-uses')
    runXianzhen(game, 'p1', 'win')
    playerOf(game, 'p0').attackRangeBonus = 6
    // 先正常出一张杀，把本回合的次数用掉
    const first = giveCard(game, 'p0', '杀')
    const firstAction = game.legalActions('p0').find((action) => action.kind === 'use-card'
      && action.asCardName === '杀' && action.cardIds.includes(first) && action.targetIds.includes('p2'))!
    game.act('p0', firstAction.id)
    settle(game)

    const second = giveCard(game, 'p0', '杀')
    const actions = game.legalActions('p0').filter((action) => action.kind === 'use-card'
      && action.asCardName === '杀' && action.cardIds.includes(second))
    const targets = actions.map((action) => action.targetIds.join(','))
    expect(targets, '还打得到陷阵目标').toContain('p1')
    expect(targets, '打不了别人了').not.toContain('p2')
  })

  it('多目标的一张杀不能捎带普通目标绕过次数限制', () => {
    const game = gameAt('gs-multi')
    runXianzhen(game, 'p1', 'win')
    // 把本回合的次数用掉
    game.state.turnUsage.slashUses = 1
    expect(canUseSlashAtTargets(game.state, 'p0', false, ['p1']), '只打陷阵目标可以').toBe(true)
    expect(canUseSlashAtTargets(game.state, 'p0', false, ['p1', 'p2']), '捎带一个普通目标就不行').toBe(false)
    expect(canUseSlashAtTargets(game.state, 'p0', false, ['p2']), '只打普通目标当然不行').toBe(false)
  })

  it('武将技能不是防具技能：于禁【毅重】不受无视防具影响', () => {
    const game = gameAt('gs-yizhong', ['gaoshun', 'yujin', 'zhaoyun', 'huangzhong', 'guojia'])
    runXianzhen(game, 'p1', 'win')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    playerOf(game, 'p0').attackRangeBonus = 6
    const black = Object.values(game.state.cards).find((card) => card.name === '杀' && card.color === 'black'
      && !card.virtual && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, black.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.cardIds.includes(black.id) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    settle(game)
    expect(playerOf(game, 'p1').hp, '毅重照常挡住黑【杀】——它不是防具技能').toBe(target.maxHp)
  })

  it('目标没有防具时压制是安全的空操作', () => {
    const game = gameAt('gs-noarmor')
    runXianzhen(game, 'p1', 'win')
    expect(Object.values(playerOf(game, 'p1').zones.equipment).filter(Boolean), '本来就没有装备').toHaveLength(0)
    expect(isArmorSuppressed(game.state, 'p1', 'p0'), '记录照常，只是没有作用对象').toBe(true)
    assertGameInvariants(game.state)
  })
})

describe('高顺：禁酒', () => {
  it('【酒】只能当【杀】用，出不了「喝酒」那条动作', () => {
    const game = gameAt('gs-jinjiu')
    trimHand(game, 'p0', 0)
    const wine = giveCard(game, 'p0', '酒')
    playerOf(game, 'p0').attackRangeBonus = 6
    const actions = game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.cardIds.includes(wine))
    expect(actions.length, '有动作').toBeGreaterThan(0)
    expect(actions.every((action) => action.asCardName === '杀'), '全是当【杀】用的').toBe(true)
    expect(canUseCardAs(game.state, 'p0', wine, '酒'), '不能再当酒用').toBe(false)
    expect(canUseCardAs(game.state, 'p0', wine, '杀'), '可以当杀用').toBe(true)
  })

  it('花色点数继承原牌：黑色的酒是黑色的【杀】，会被【毅重】挡下', () => {
    const game = gameAt('gs-jinjiu-color', ['gaoshun', 'yujin', 'zhaoyun', 'huangzhong', 'guojia'])
    trimHand(game, 'p0', 0)
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    playerOf(game, 'p0').attackRangeBonus = 6
    const wine = Object.values(game.state.cards).find((card) => card.name === '酒' && card.color === 'black'
      && !card.virtual && (game.state.zones.drawPile.includes(card.id) || game.state.zones.discardPile.includes(card.id)))
    if (!wine) return
    moveCard(game.state, wine.id, locate(game.state, wine.id), { kind: 'hand', playerId: 'p0' })
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.cardIds.includes(wine.id) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    settle(game)
    expect(playerOf(game, 'p1').hp, '黑色的酒当杀用，毅重照样挡').toBe(target.maxHp)
  })

  it('濒死时不能用【酒】自救', () => {
    const game = gameAt('gs-jinjiu-dying')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '酒')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    let offeredWine = false
    game.dispatch('LoseHp', { playerId: 'p0', amount: 1, reason: 'test' }, { targetId: 'p0' })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'rescue' && request.playerId === 'p0') {
        const pick = request as unknown as { actionIds: string[] }
        if (pick.actionIds.some((id) => id.startsWith('rescue-card:'))) offeredWine = true
      }
      return null
    })
    /*
     * 只断言「没给他用酒的选项」。**不能顺带断言他一定会死**——
     * 别人手里可能有【桃】，那是另一回事。
     */
    expect(offeredWine, '他手里那张「酒」此刻是【杀】，救不了自己').toBe(false)
    assertCardConservation(game.state)
  })

  it('陷阵失败之后，酒变的【杀】同样不能使用', () => {
    const game = gameAt('gs-jinjiu-prohibited')
    runXianzhen(game, 'p1', 'lose')
    const wine = giveCard(game, 'p0', '酒')
    playerOf(game, 'p0').attackRangeBonus = 6
    const actions = game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.cardIds.includes(wine))
    expect(actions, '禁止使用【杀】把它也挡住了').toHaveLength(0)
  })

  it('需要打出【杀】时，那张酒可以顶上', () => {
    const game = gameAt('gs-jinjiu-respond')
    trimHand(game, 'p0', 0)
    const wine = giveCard(game, 'p0', '酒')
    expect(canUseCardAs(game.state, 'p0', wine, '杀'), '当【杀】打出是合法的').toBe(true)
    expect(canUseCardAs(game.state, 'p0', wine, '闪'), '当【闪】不行').toBe(false)
  })
})

describe('高顺：版本锁', () => {
  it('只有【陷阵】【禁酒】，没有界版的增强', () => {
    const character = getCharacter('gaoshun')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['xianzhen', 'jinjiu'])
    expect(character.pack).toBe('yjcm2011')
    expect(character.maxHp).toBe(4)
    expect(character.kingdom).toBe('qun')
    const jinjiu = character.skills.find((skill) => skill.id === 'jinjiu')!
    expect(jinjiu.description, '不加「其他角色不能使用酒」那类界版内容').not.toContain('其他角色')
    const xianzhen = character.skills.find((skill) => skill.id === 'xianzhen')!
    expect(xianzhen.description, '不加界版的普通锦囊额外目标').not.toContain('锦囊')
  })
})
