import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { buildPlayerView } from '@/sanguosha/engine/view'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·姜维。
 *
 * 四处最容易做错的，每一处都在下面有对应的断言：
 *
 * - 【星魂】看到的牌堆顶五张，在正式展示之前**只有他自己看得到**；
 * - 那次交换是**等量、原子**的，牌堆顶不能在中间态少一张多一张；
 * - 展示之后那几张【杀】是**真的逐张使用**，而且不占出牌阶段的出杀次数；
 * - 【回天】的代价按**轮**算，不是按回合——额外回合是插队，不推进轮次。
 */

const CAST = ['shenjiangwei', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong']

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
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
      case 'arrange-options': {
        const pick = request as unknown as { options: { id: string }[]; optional?: boolean }
        return { optionIds: pick.optional ? [] : pick.options.map((option) => option.id) }
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
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

/**
 * 从**牌堆或弃牌堆**里拿一张指定牌名的牌塞给某人。
 *
 * 只排除「不在他自己手里」是不够的：那样会把上一行刚发给别人的那张牌
 * 又抽走，布置好的局面在下一行就被自己拆了。
 */
function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error('牌堆里没有闲置的【' + cardName + '】')
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

/** 把指定牌名的牌按给定顺序摆到牌堆顶，返回它们的 id。 */
function stackTop(game: SanguoshaGame, cardNames: string[]): string[] {
  const picked: string[] = []
  for (const name of cardNames) {
    const card = Object.values(game.state.cards).find((candidate) => candidate.name === name
      && !picked.includes(candidate.id)
      && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
    if (!card) throw new Error('牌堆里没有闲置的【' + name + '】')
    moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'drawPile' })
    picked.push(card.id)
  }
  const pile = game.state.zones.drawPile
  const rest = pile.filter((cardId) => !picked.includes(cardId))
  pile.splice(0, pile.length, ...picked, ...rest)
  return picked
}

/** 把手牌裁到指定张数；多的正经弃掉，不能凭空丢。 */
function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

function invoke(game: SanguoshaGame, playerId: string, skillId: string): void {
  const action = game.legalActions(playerId)
    .find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === skillId)
  if (!action) throw new Error('没有【' + skillId + '】这条动作')
  game.act(playerId, action.id)
}

function canInvoke(game: SanguoshaGame, playerId: string, skillId: string): boolean {
  return game.legalActions(playerId)
    .some((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === skillId)
}

describe('神·姜维：星魂', () => {
  it('牌堆顶那五张在展示之前只有他自己看得到', () => {
    const game = gameAt('jw-xinghun-privacy')
    const top = game.state.zones.drawPile.slice(0, 5)
    invoke(game, 'p0', 'xinghun')

    const request = game.state.pendingRequests[0] as unknown as { playerId: string; viewOnlyCardIds?: string[] }
    expect(request.playerId, '这条请求只发给他本人').toBe('p0')
    expect(request.viewOnlyCardIds, '看到的正是牌堆顶五张').toEqual(top)

    /*
     * 关键的一条：**别人连这条请求的存在都读不到**。
     * 玩家视图是白名单投影，只带观看者自己的那条待回应请求；
     * 漏出去的话，旁人就能从「他在被问什么」反推牌堆顶。
     */
    const others = buildPlayerView(game.state, 'p2')
    expect(others.pendingRequest, '别人的视图里没有这条请求').toBeFalsy()
    expect(JSON.stringify(others), '别人的视图里不出现这五张牌的任何一张')
      .not.toMatch(new RegExp(top.map((cardId) => cardId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')))
  })

  it('交换是等量的，而且一次做完', () => {
    const game = gameAt('jw-xinghun-swap')
    trimHand(game, 'p0', 3)
    const top = stackTop(game, ['桃', '桃', '桃', '桃', '桃'])
    const handBefore = [...playerOf(game, 'p0').zones.hand]

    invoke(game, 'p0', 'xinghun')
    // 换出去两张手牌
    const pickHand = game.state.pendingRequests[0] as AnyRequest
    game.respond({ requestId: pickHand.id, playerId: 'p0', payload: { cardIds: handBefore.slice(0, 2) } })

    const pickTop = game.state.pendingRequests[0] as unknown as AnyRequest & { min: number; max: number }
    expect([pickTop.min, pickTop.max], '必须挑等量的牌堆顶牌').toEqual([2, 2])
    game.respond({ requestId: pickTop.id, playerId: 'p0', payload: { cardIds: [top[0], top[1]] } })

    const owner = playerOf(game, 'p0')
    expect(owner.zones.hand, '换进来的两张在手里').toEqual(expect.arrayContaining([top[0], top[1]]))
    expect(owner.zones.hand, '换出去的两张不在手里了').not.toEqual(expect.arrayContaining(handBefore.slice(0, 2)))
    expect(owner.zones.hand, '手牌张数不变').toHaveLength(handBefore.length)
    expect(game.state.zones.drawPile.slice(0, 5).slice().sort(), '牌堆顶仍然是五张，换过内容')
      .toEqual([handBefore[0], handBefore[1], top[2], top[3], top[4]].sort())
    assertCardConservation(game.state)

    settle(game)
    assertGameInvariants(game.state)
  })

  it('展示之后逐张真的把【杀】用出去，而且不占出杀次数', () => {
    const game = gameAt('jw-xinghun-slash')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    // 牌堆顶摆三张【杀】两张【桃】：只有【杀】会被用出去
    stackTop(game, ['杀', '杀', '杀', '桃', '桃'])
    const hpBefore = target.hp

    invoke(game, 'p0', 'xinghun')
    settle(game, (request) => {
      if (request.kind === 'choose-cards' && request.prompt?.includes('换出去')) return { cardIds: [] }
      if (request.kind === 'choose-targets' && request.prompt?.includes('依次使用')) return { targetIds: ['p1'] }
      return null
    })

    expect(hpBefore - playerOf(game, 'p1').hp, '三张【杀】各打一下').toBe(3)
    /*
     * 出杀次数是这里的重点：技能使用的【杀】走的是 `countUsage: false` 那条路，
     * 三张打完之后他这个出牌阶段仍然可以正常出一张自己的【杀】。
     */
    giveCard(game, 'p0', '杀')
    expect(
      game.legalActions('p0').some((action) => action.kind === 'use-card' && action.asCardName === '杀'),
      '本回合的出杀次数没有被技能吃掉',
    ).toBe(true)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('出牌阶段限一次', () => {
    const game = gameAt('jw-xinghun-once')
    expect(canInvoke(game, 'p0', 'xinghun')).toBe(true)
    invoke(game, 'p0', 'xinghun')
    settle(game, (request) => (request.kind === 'choose-cards' && request.prompt?.includes('换出去') ? { cardIds: [] } : null))
    expect(canInvoke(game, 'p0', 'xinghun'), '同一个出牌阶段不能再来一次').toBe(false)
  })
})

describe('神·姜维：天涛', () => {
  /** 推进到结束阶段，让天涛的时机到来。 */
  function toFinishPhase(game: SanguoshaGame): void {
    for (let guard = 0; guard < 10 && game.state.phase !== 'finish'; guard += 1) game.advancePhase()
    expect(game.state.phase).toBe('finish')
  }

  it('弃的那一批里有【杀】就不掉血', () => {
    const game = gameAt('jw-tiantao-slash')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '杀')
    giveCard(game, 'p0', '桃')
    const hpBefore = playerOf(game, 'p0').hp

    toFinishPhase(game)
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('天涛')) return { optionId: 'hand' }
      if (request.kind === 'choose-targets' && request.prompt?.includes('天涛')) return { targetIds: [] }
      return null
    })
    expect(playerOf(game, 'p0').zones.hand, '整个手牌区都弃掉了').toHaveLength(0)
    expect(playerOf(game, 'p0').hp, '这批牌里有【杀】，不掉血').toBe(hpBefore)
    assertCardConservation(game.state)
  })

  it('一批里一张【杀】都没有才掉 1 点，而且只掉 1 点', () => {
    const game = gameAt('jw-tiantao-nosl')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '桃')
    giveCard(game, 'p0', '闪')
    giveCard(game, 'p0', '无中生有')
    const hpBefore = playerOf(game, 'p0').hp

    toFinishPhase(game)
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('天涛')) return { optionId: 'hand' }
      if (request.kind === 'choose-targets' && request.prompt?.includes('天涛')) return { targetIds: [] }
      return null
    })
    /*
     * 三张非【杀】只掉 1 点。判据是「这一批里一张【杀】都没有」，
     * 不是逐张各判一次——逐张判的话这里就要掉三点了。
     */
    expect(hpBefore - playerOf(game, 'p0').hp).toBe(1)
  })

  it('被点到的人自己选弃哪张；弃的不是【杀】才掉血', () => {
    const game = gameAt('jw-tiantao-others')
    trimHand(game, 'p0', 0)
    giveCard(game, 'p0', '杀')
    trimHand(game, 'p1', 0)
    const p1Slash = giveCard(game, 'p1', '杀')
    trimHand(game, 'p2', 0)
    const p2Peach = giveCard(game, 'p2', '桃')
    const p1Hp = playerOf(game, 'p1').hp
    const p2Hp = playerOf(game, 'p2').hp

    toFinishPhase(game)
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('天涛')) return { optionId: 'hand' }
      if (request.kind === 'choose-targets' && request.prompt?.includes('天涛')) return { targetIds: ['p1', 'p2'] }
      if (request.kind === 'choose-cards' && request.prompt?.includes('天涛')) {
        // 弃牌请求发给的是**被弃的那个人**，不是神姜维
        expect(['p1', 'p2']).toContain(request.playerId)
        return { cardIds: request.playerId === 'p1' ? [p1Slash] : [p2Peach] }
      }
      return null
    })
    expect(playerOf(game, 'p1').hp, '弃的是【杀】，不掉血').toBe(p1Hp)
    expect(p2Hp - playerOf(game, 'p2').hp, '弃的是【桃】，掉 1 点').toBe(1)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('神·姜维：神霈', () => {
  /** 把某人打到濒死。伤害来源用 p4，免得和被测的技能纠缠。 */
  function beat(game: SanguoshaGame, playerId: string, amount: number): void {
    game.dispatch('BeforeDamage', {})
    const victim = playerOf(game, playerId)
    victim.hp = Math.max(0, victim.hp)
    for (let i = 0; i < amount; i += 1) {
      if (victim.hp <= 0) break
      victim.hp -= 1
    }
    if (victim.hp <= 0) game.enterDying(playerId)
    game.settle()
  }

  it('X 是本局进入濒死的次数，回复的是 X 点而不是回复到 X 点', () => {
    const game = gameAt('jw-shenpei-x')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    beat(game, 'p0', 1)

    const request = game.state.pendingRequests[0] as unknown as AnyRequest & { options: { id: string }[] }
    expect(request.prompt, '濒死时先问限定技').toContain('神霈')
    expect(owner.dyingEntryCount, '本局第一次进入濒死').toBe(1)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'invoke' } })

    // X = 1：从 0 回复 1 点就是 1 点，不是「回复到 1 点」之外的任何值
    expect(playerOf(game, 'p0').hp).toBe(1)
    const damage = game.state.pendingRequests[0] as unknown as AnyRequest & { candidateIds: string[] }
    expect(damage.prompt, '接着问雷电伤害打谁').toContain('雷电')
    expect(damage.candidateIds, '「一名角色」没有排除自己').toContain('p0')

    const targetHp = playerOf(game, 'p1').hp
    game.respond({ requestId: damage.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    settle(game)
    expect(targetHp - playerOf(game, 'p1').hp, 'X 点雷电伤害').toBe(1)
    expect(playerOf(game, 'p0').grantedSkills, '发动之后拿到【回天】').toContain('huitian')
    assertGameInvariants(game.state)
  })

  it('救不回来的时候根本不给发动机会，限定技不白扔', () => {
    const game = gameAt('jw-shenpei-futile')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    // 一次性打到 -2：X = 1，回复 1 点之后仍然是 -1，人还在濒死里
    owner.hp = -2
    game.enterDying('p0')
    game.settle()

    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    expect(request?.prompt ?? '', '直接进求桃，不问神霈').not.toContain('神霈')
    expect(playerOf(game, 'p0').usedLimitedSkills, '限定技没有被消耗').not.toContain('shenpei')
  })
})

describe('神·姜维：回天', () => {
  /** 让神姜维直接拿到【回天】，跳过神霈那一段。 */
  function grantHuitian(game: SanguoshaGame): void {
    const owner = playerOf(game, 'p0')
    if (!owner.grantedSkills.includes('huitian')) owner.grantedSkills.push('huitian')
  }

  /**
   * 一直推进到某个条件成立或者牌局结束。
   *
   * `onPrompt` 在【回天】那条询问弹出来的**那一刻**回调，用来抓当时的现场——
   * 事后再看已经晚了：额外回合排进去就被取走，手牌也早被后面的摸牌阶段冲掉。
   */
  function runUntil(game: SanguoshaGame, done: () => boolean, guardLimit = 400, onPrompt: () => void = () => {}): boolean {
    for (let guard = 0; guard < guardLimit; guard += 1) {
      if (done()) return true
      if (game.state.status !== 'playing') return false
      game.advancePhase()
      settle(game, (request) => {
        if (request.kind === 'choose-option' && request.prompt?.includes('回天')) {
          onPrompt()
          return { optionId: 'invoke' }
        }
        return null
      })
    }
    return done()
  }

  it('别人回合结束、体力比他高时才问，摸一张牌并插一个额外回合', () => {
    const game = gameAt('jw-huitian-extra')
    grantHuitian(game)
    const owner = playerOf(game, 'p0')
    /*
     * 血不能压到 1：【天涛】是锁定技，他自己每个结束阶段都可能再掉 1 点，
     * 压到 1 的话人会先被自己的锁定技耗死，测的就不是【回天】了。
     */
    owner.hp = 3
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = playerOf(game, id).maxHp

    /*
     * 用**留痕的标记**判定发动，而不是去数 `extraTurns`：
     * 排进去的额外回合在下一个回合开始时就被取走了，抽查的那一瞬间大概率已经空了。
     */
    let handAtPrompt = -1
    let actorHpAtPrompt = -1
    const invoked = runUntil(game, () => owner.marks['huitian-round'] !== undefined, 60, () => {
      handAtPrompt = owner.zones.hand.length
      actorHpAtPrompt = playerOf(game, game.state.currentPlayerId!).hp
    })
    expect(invoked, '一名体力更高的角色回合结束后应当问到他').toBe(true)
    expect(actorHpAtPrompt, '只在那名角色体力值高于他时才问').toBeGreaterThan(owner.hp)
    expect(owner.zones.hand.length, '发动时摸一张牌').toBe(handAtPrompt + 1)
    expect(owner.marks['huitian-round'], '记下的是发动时的轮次').toBe(game.state.roundNumber)
    /*
     * 额外回合**当场就被取走开打了**，所以这里不去翻队列——翻到的必然是空的。
     * 看的是结果：刚才结束回合的是别人，现在轮到的是他，这就是插队生效。
     */
    expect(game.state.currentPlayerId, '插队的额外回合立刻轮到他').toBe('p0')
  })

  it('代价按轮结算：发动过的那一轮不死，下一轮开始时才死', () => {
    const game = gameAt('jw-huitian-cost')
    grantHuitian(game)
    const owner = playerOf(game, 'p0')
    owner.hp = 3
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = playerOf(game, id).maxHp

    const reached = runUntil(game, () => owner.marks['huitian-round'] !== undefined, 60)
    expect(reached, '先发动一次').toBe(true)
    const usedRound = owner.marks['huitian-round']
    expect(owner.alive, '发动的这一轮他还活着').toBe(true)

    /*
     * 关键：**额外回合不推进轮次**。回天自己带来的那个额外回合走完了，
     * 轮次仍然是发动时那一轮，他不该在自己的额外回合里就倒下。
     */
    runUntil(game, () => game.state.roundNumber > usedRound || !owner.alive, 400)
    expect(game.state.roundNumber, '确实跨到了下一轮').toBeGreaterThan(usedRound)
    expect(playerOf(game, 'p0').alive, '新的一轮一开始就死亡').toBe(false)
    assertGameInvariants(game.state)
  })
})
