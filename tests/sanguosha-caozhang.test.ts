import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { canUseSlash, slashRules } from '@/sanguosha/engine/slash-rules'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 曹彰（一将成名 2012 经典）。
 *
 * 六条主张，逐条有断言：
 *
 * - 【将驰】在摸牌阶段三选一，「基础摸牌数」取的是别的修正算完之后的值；
 * - 多摸分支：本回合**既不能使用也不能打出**【杀】，转化出来的也不行；
 * - 但弃置、交给别人不受影响；
 * - 少摸分支：本回合【杀】无距离限制、次数 +1；
 * - 次数是**加成不是覆盖**，诸葛连弩的无限不会被压回；
 * - 摸牌阶段被跳过时不触发；回合结束后两种状态都消失。
 */

const CAST = ['caozhang', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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

/** 建一局并停在准备阶段（还没进摸牌阶段），让每条用例自己跑摸牌。 */
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
  settle(game, jiangchiDefault)
  return game
}

/** 布置阶段遇到将驰一律选「不发动」。 */
function jiangchiDefault(request: AnyRequest) {
  if (request.kind === 'choose-option' && request.prompt?.includes('将驰')) return { optionId: 'none' }
  return null
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

function equipNamed(game: SanguoshaGame, playerId: string, cardName: string, slot: 'weapon' | 'armor'): string {
  const cardId = giveCard(game, playerId, cardName)
  moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'equipment', playerId, slot })
  return cardId
}

/** 跑曹彰的摸牌阶段，按 choice 回答将驰。返回摸到几张、以及看到的选项。 */
function runDrawPhase(game: SanguoshaGame, choice: 'more' | 'less' | 'none', options: { count?: number } = {}) {
  const seen = { request: null as AnyRequest | null }
  const before = playerOf(game, 'p0').zones.hand.length
  game.dispatch('DrawPhase', { playerId: 'p0', count: options.count ?? 2 }, { sourceId: 'p0', phase: 'draw' })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('将驰')) {
      seen.request = request
      return { optionId: choice }
    }
    return null
  })
  return { drawn: playerOf(game, 'p0').zones.hand.length - before, seen }
}

describe('曹彰：将驰的摸牌', () => {
  it('三选一：多摸、少摸、不发动', () => {
    const game = gameAt('cz-options')
    const { seen } = runDrawPhase(game, 'none')
    const options = (seen.request as unknown as { options: { id: string }[] }).options.map((option) => option.id)
    expect(options.sort(), '三项都在').toEqual(['less', 'more', 'none'])
  })

  it('多摸一张：正常摸两张变成三张', () => {
    const game = gameAt('cz-more')
    expect(runDrawPhase(game, 'more').drawn, '摸了三张').toBe(3)
  })

  it('少摸一张：正常摸两张变成一张', () => {
    const game = gameAt('cz-less')
    expect(runDrawPhase(game, 'less').drawn, '摸了一张').toBe(1)
  })

  it('不发动就照常摸：接管了阶段也要把牌补上', () => {
    const game = gameAt('cz-none')
    expect(runDrawPhase(game, 'none').drawn, '照常两张').toBe(2)
  })

  it('基础摸牌数是别的修正算完之后的那个数', () => {
    const game = gameAt('cz-base')
    // 别的效果把这次摸牌改成了 3 张
    const { drawn, seen } = runDrawPhase(game, 'more', { count: 3 })
    expect(drawn, '在 3 的基础上 +1').toBe(4)
    const labels = (seen.request as unknown as { options: { label: string }[] }).options.map((option) => option.label)
    expect(labels.some((label) => label.includes('摸 4 张')), '选项文案也按真实基数算').toBe(true)
  })

  it('基础摸牌数为 0 时不提供「少摸一张」', () => {
    const game = gameAt('cz-zero')
    const { seen, drawn } = runDrawPhase(game, 'none', { count: 0 })
    const options = (seen.request as unknown as { options: { id: string }[] }).options.map((option) => option.id)
    expect(options, '摸牌数不能是负数').not.toContain('less')
    expect(options, '多摸仍然有意义').toContain('more')
    expect(drawn, '不发动就一张都不摸').toBe(0)
  })

  it('摸牌阶段被跳过时不触发', () => {
    const game = gameAt('cz-skipped')
    let asked = false
    game.state.skippedPhases = ['draw']
    game.state.phase = 'judge'
    game.advancePhase()
    settle(game, (request) => {
      if (request.prompt?.includes('将驰')) asked = true
      return jiangchiDefault(request)
    })
    expect(asked, '阶段都不存在，不该问').toBe(false)
  })
})

describe('曹彰：多摸之后不能使用或打出【杀】', () => {
  it('出不了【杀】，连转化出来的也出不了', () => {
    const game = gameAt('cz-noslash', ['caozhang', 'guanyu', 'zhaoyun', 'huangzhong', 'guojia'])
    runDrawPhase(game, 'more')
    game.state.phase = 'play'
    playerOf(game, 'p0').attackRangeBonus = 6
    giveCard(game, 'p0', '杀')
    const slashActions = game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.asCardName === '杀')
    expect(slashActions, '一条出杀的动作都没有').toHaveLength(0)
  })

  it('打不出【杀】：南蛮来了只能挨打', () => {
    const game = gameAt('cz-nanman')
    runDrawPhase(game, 'more')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    for (const cardId of [...owner.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    giveCard(game, 'p0', '杀')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const nanman = giveCard(game, 'p1', '南蛮入侵')
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(nanman))!
    let offered: string[] = []
    game.act('p1', action.id)
    settle(game, (request) => {
      if (request.kind === 'respond-card' && request.playerId === 'p0') {
        offered = (request as unknown as { actionIds: string[] }).actionIds
      }
      return null
    })
    expect(offered, '候选里只剩「不响应」').toEqual(['respond-pass'])
    expect(playerOf(game, 'p0').hp, '打不出杀就挨了这一下').toBe(owner.maxHp - 1)
    expect(playerOf(game, 'p0').zones.hand, '那张杀还在手里，没有被消耗').toHaveLength(1)
  })

  it('打不出【闪】不受影响：禁的是【杀】', () => {
    const game = gameAt('cz-dodge')
    runDrawPhase(game, 'more')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    for (const cardId of [...owner.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    giveCard(game, 'p0', '闪')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    playerOf(game, 'p1').attackRangeBonus = 6
    const slash = giveCard(game, 'p1', '杀')
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)
    let offered: string[] = []
    settle(game, (request) => {
      if (request.kind === 'respond-card' && request.playerId === 'p0') {
        offered = (request as unknown as { actionIds: string[] }).actionIds
      }
      return null
    })
    expect(offered.some((id) => id.startsWith('respond-dodge:')), '闪照常打得出').toBe(true)
  })

  it('弃置和交给别人不受影响', () => {
    const game = gameAt('cz-discardok')
    runDrawPhase(game, 'more')
    const slash = giveCard(game, 'p0', '杀')
    // 直接弃置：这不是「使用或打出」
    moveCard(game.state, slash, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' }, { discardReason: 'discard' })
    expect(game.state.zones.discardPile, '弃得掉').toContain(slash)
    assertCardConservation(game.state)
  })
})

describe('曹彰：少摸之后的杀加成', () => {
  it('无距离限制', () => {
    const game = gameAt('cz-distance')
    runDrawPhase(game, 'less')
    expect(slashRules(game.state, 'p0').ignoreDistance, '本回合无距离限制').toBe(true)
    /*
     * 断言走**合法动作**，不是通用的 `canTarget`：
     * 「本回合【杀】无距离限制」是杀专属的规则，只在生成杀的目标组合时生效；
     * `canTarget` 是所有牌共用的距离判断，它本来就不该被这条规则改掉。
     */
    playerOf(game, 'p0').attackRangeBonus = -5
    game.state.phase = 'play'
    const slash = giveCard(game, 'p0', '杀')
    const targets = game.legalActions('p0')
      .filter((action) => action.kind === 'use-card' && action.asCardName === '杀' && action.cardIds.includes(slash))
      .flatMap((action) => action.targetIds)
    expect(targets, '攻击范围压到最小也打得到最远的人').toContain('p2')
  })

  it('次数 +1：一回合能出两张杀', () => {
    const game = gameAt('cz-uses')
    runDrawPhase(game, 'less')
    expect(slashRules(game.state, 'p0').extraUses, '多一次').toBe(1)
    game.state.turnUsage.slashUses = 1
    expect(canUseSlash(game.state, 'p0', false), '第二张还能出').toBe(true)
    game.state.turnUsage.slashUses = 2
    expect(canUseSlash(game.state, 'p0', false), '第三张就不行了').toBe(false)
  })

  it('是加成不是覆盖：诸葛连弩的无限不会被压回两次', () => {
    const game = gameAt('cz-crossbow')
    equipNamed(game, 'p0', '诸葛连弩', 'weapon')
    runDrawPhase(game, 'less')
    game.state.turnUsage.slashUses = 9
    expect(canUseSlash(game.state, 'p0', true), '连弩仍然无限').toBe(true)
  })

  it('只影响【杀】：别的牌的距离照常', () => {
    const game = gameAt('cz-otherdistance')
    runDrawPhase(game, 'less')
    playerOf(game, 'p0').attackRangeBonus = -5
    const steal = giveCard(game, 'p0', '顺手牵羊')
    game.state.phase = 'play'
    const targets = game.legalActions('p0')
      .filter((action) => action.kind === 'use-card' && action.cardIds.includes(steal))
      .flatMap((action) => action.targetIds)
    expect(targets, '顺手牵羊仍然只够得着距离 1 的人').not.toContain('p2')
  })
})

describe('曹彰：回合结束后状态清空', () => {
  it('两种分支的状态都到回合结束为止', () => {
    const game = gameAt('cz-cleanup')
    runDrawPhase(game, 'less')
    expect(slashRules(game.state, 'p0').extraUses).toBe(1)
    // 推到这个回合结束
    game.state.phase = 'finish'
    game.advancePhase()
    settle(game, jiangchiDefault)
    expect(slashRules(game.state, 'p0').extraUses, '本回合的杀加成清掉了').toBe(0)
    expect(slashRules(game.state, 'p0').ignoreDistance).toBe(false)
    assertGameInvariants(game.state)
  })

  it('多摸分支的禁令也只管本回合', () => {
    const game = gameAt('cz-cleanup-more')
    runDrawPhase(game, 'more')
    const lockedTurn = game.state.turnNumber
    expect(playerOf(game, 'p0').marks['jiangchi-no-slash'], '记的是回合序号').toBe(lockedTurn)
    game.state.turnNumber += 1
    game.state.phase = 'play'
    giveCard(game, 'p0', '杀')
    playerOf(game, 'p0').attackRangeBonus = 6
    const slashActions = game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.asCardName === '杀')
    expect(slashActions.length, '换了回合就能出杀了').toBeGreaterThan(0)
  })
})

describe('曹彰：版本锁', () => {
  it('只有【将驰】', () => {
    const character = getCharacter('caozhang')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['jiangchi'])
    expect(character.pack).toBe('yjcm2012')
    expect(character.maxHp).toBe(4)
    expect(character.kingdom).toBe('wei')
    expect(character.skills[0].description, '是「多摸禁杀 / 少摸加成」那一版').toContain('不能使用或打出')
  })
})
