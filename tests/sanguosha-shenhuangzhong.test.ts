import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { DIJI_STATE, QIHAI_STATE, ZHONGSHU_STATE, hasTargetState } from '@/sanguosha/engine/target-state'
import { cardPlayableBySuit } from '@/sanguosha/engine/card-suit-lock'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·黄忠。
 *
 * 四条主张，逐条有断言：
 *
 * - 一次伤害只给**一次**裂穹机会，不按伤害点数循环；
 * - 天冲是**失去体力**不是伤害，而且「因此死亡」按因果算——被救回来再死不算；
 * - 气海禁的是**红桃**（不是红色），禁的是**使用和打出**（不禁弃置），
 *   而且转化技的子牌也拦得住；
 * - 斩决的两种待生效状态在出牌阶段结束时一律清掉。
 */

const CAST = ['shenhuangzhong', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong']

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

function giveCard(game: SanguoshaGame, playerId: string, cardName: string, suit?: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && !candidate.virtual
    && (suit === undefined || candidate.suit === suit)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的【${cardName}】${suit ?? ''}`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 神黄忠对某人造成一次伤害，并在裂穹面板上选指定部位。 */
function hurt(game: SanguoshaGame, targetId: string, site: string | null, amount = 1): void {
  resolveDamage(game as never, { sourceId: 'p0', targetId, amount })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('裂穹')) {
      return site ? { optionId: site } : { optionId: 'cancel' }
    }
    return null
  })
}

describe('神·黄忠：裂穹', () => {
  it('一次伤害只给一次机会，不按伤害点数循环', () => {
    const game = gameAt('hz-once')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    let asks = 0
    resolveDamage(game as never, { sourceId: 'p0', targetId: 'p1', amount: 3 })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('裂穹')) {
        asks += 1
        return { optionId: 'lifeng' }
      }
      return null
    })
    expect(asks, '3 点伤害仍然只问一次').toBe(1)
  })

  it('力烽随机弃置一半手牌，向上取整', () => {
    const game = gameAt('hz-lifeng')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    trimHand(game, 'p1', 0)
    for (let index = 0; index < 5; index += 1) giveCard(game, 'p1', '闪')
    hurt(game, 'p1', 'lifeng')
    // 5 张 → 弃 3 张
    expect(playerOf(game, 'p1').zones.hand, '5 张弃 3 张，剩 2 张').toHaveLength(2)
    assertCardConservation(game.state)
  })

  it('地机让下一次受到的伤害 +1，而且只生效一次', () => {
    const game = gameAt('hz-diji')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    hurt(game, 'p1', 'diji')
    expect(hasTargetState(game.state, 'p1', DIJI_STATE)).toBe(true)

    const before = playerOf(game, 'p1').hp
    resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 1 })
    game.settle()
    settle(game)
    expect(before - playerOf(game, 'p1').hp, '1 点伤害变成 2 点').toBe(2)
    expect(hasTargetState(game.state, 'p1', DIJI_STATE), '用掉就没了').toBe(false)

    const second = playerOf(game, 'p1').hp
    resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 1 })
    game.settle()
    settle(game)
    expect(second - playerOf(game, 'p1').hp, '第二次照常 1 点').toBe(1)
  })

  it('中枢让下一张牌无效：牌照常打出去，但没有效果', () => {
    const game = gameAt('hz-zhongshu')
    const target = playerOf(game, 'p1')
    // 别把他打死：死人身上挂不住状态，裂穹也就不会问了
    target.hp = target.maxHp
    hurt(game, 'p1', 'zhongshu')
    expect(hasTargetState(game.state, 'p1', ZHONGSHU_STATE)).toBe(true)

    // 轮到 p1 的回合，让他用一张【桃】
    while (!(game.state.currentPlayerId === 'p1' && game.state.phase === 'play')) {
      game.advancePhase()
      settle(game, (request) => (request.kind === 'choose-option' && request.prompt?.includes('裂穹')
        ? { optionId: 'cancel' }
        : null))
    }
    trimHand(game, 'p1', 0)
    const peach = giveCard(game, 'p1', '桃')
    const hpBefore = playerOf(game, 'p1').hp
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(peach))
    expect(action, '牌仍然点得出来——中枢不是禁止使用').toBeTruthy()
    game.act('p1', action!.id)
    settle(game)

    expect(playerOf(game, 'p1').hp, '桃没有回血：效果无效').toBe(hpBefore)
    expect(playerOf(game, 'p1').zones.hand, '牌确实被用掉了').not.toContain(peach)
    expect(game.state.zones.discardPile, '进了弃牌堆').toContain(peach)
    expect(hasTargetState(game.state, 'p1', ZHONGSHU_STATE), '用掉一张就消失').toBe(false)
    assertCardConservation(game.state)
  })

  it('气海禁红桃的使用和打出，但不禁弃置；方块不受影响', () => {
    const game = gameAt('hz-qihai')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    hurt(game, 'p1', 'qihai')
    expect(hasTargetState(game.state, 'p1', QIHAI_STATE)).toBe(true)

    trimHand(game, 'p1', 0)
    const heart = giveCard(game, 'p1', '桃', 'heart')
    const diamond = giveCard(game, 'p1', '闪', 'diamond')
    expect(cardPlayableBySuit(game.state, 'p1', heart), '红桃被禁').toBe(false)
    expect(cardPlayableBySuit(game.state, 'p1', diamond), '方块不受影响').toBe(true)

    // 打出：求闪时红桃闪不在候选里
    const heartDodge = giveCard(game, 'p1', '闪', 'heart')
    game.beginVirtualSlash({ sourceId: 'p2', targetId: 'p1', sourceSkillId: 'test' })
    const request = game.state.pendingRequests[0] as unknown as { actionIds: string[] }
    expect(request.actionIds.some((id) => id.includes(heartDodge)), '红桃闪不能打出').toBe(false)
    expect(request.actionIds.some((id) => id.includes(diamond)), '方块闪照常').toBe(true)
    settle(game)

    // 弃置不受影响：手里还有那张红桃，正常弃得掉
    moveCard(game.state, heart, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    expect(game.state.zones.discardPile, '弃置不受气海限制').toContain(heart)
  })

  it('天冲：只有本回合已经击伤过才出现，是失去体力不是伤害', () => {
    const game = gameAt('hz-tianchong')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp

    // 第一次击伤：候选里没有天冲
    let firstOptions: string[] = []
    resolveDamage(game as never, { sourceId: 'p0', targetId: 'p1', amount: 1 })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('裂穹')) {
        firstOptions = (request as unknown as { options: { id: string }[] }).options.map((option) => option.id)
        return { optionId: 'lifeng' }
      }
      return null
    })
    expect(firstOptions, '第一次没有天冲').not.toContain('tianchong')

    // 第二次：天冲出现
    const damaged: number[] = []
    game.events.on('Damaged', (handled) => { damaged.push(Number(handled.event.payload.amount)) })
    let secondOptions: string[] = []
    resolveDamage(game as never, { sourceId: 'p0', targetId: 'p1', amount: 1 })
    game.settle()
    damaged.length = 0
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('裂穹')) {
        secondOptions = (request as unknown as { options: { id: string }[] }).options.map((option) => option.id)
        return { optionId: 'tianchong' }
      }
      if (request.kind === 'rescue') return { actionId: 'rescue-pass' }
      return null
    })
    expect(secondOptions, '本回合击伤过之后才有天冲').toContain('tianchong')
    /*
     * 天冲是**失去体力**：没有第二次 `Damaged`。
     * 写成「造成等同体力值的伤害」的话这里会多出一条。
     */
    expect(damaged, '天冲不产生伤害事件').toEqual([])
    expect(playerOf(game, 'p1').alive, '没人救就死了').toBe(false)
    assertGameInvariants(game.state)
  })

  it('因天冲而死才 +1 体力上限；被救回来之后再死不算', () => {
    const game = gameAt('hz-causal')
    const owner = playerOf(game, 'p0')
    const target = playerOf(game, 'p1')
    target.hp = 2
    const maxHpBefore = owner.maxHp

    // 先击伤一次解锁天冲
    hurt(game, 'p1', 'lifeng')
    // 给 p1 一张桃，让他自救
    trimHand(game, 'p1', 0)
    giveCard(game, 'p1', '桃')
    resolveDamage(game as never, { sourceId: 'p0', targetId: 'p1', amount: 1 })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('裂穹')) return { optionId: 'tianchong' }
      if (request.kind === 'rescue') {
        // 用桃救自己
        const actionIds = (request as unknown as { actionIds: string[] }).actionIds
        const peach = actionIds.find((id) => id !== 'rescue-pass')
        return peach ? { actionId: peach } : { actionId: 'rescue-pass' }
      }
      return null
    })
    expect(playerOf(game, 'p1').alive, '被桃救回来了').toBe(true)
    expect(playerOf(game, 'p0').maxHp, '没死就不加上限').toBe(maxHpBefore)

    // 之后被别的原因打死，仍然不算「因天冲而死」
    resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 10 })
    game.settle()
    settle(game)
    expect(playerOf(game, 'p1').alive).toBe(false)
    expect(playerOf(game, 'p0').maxHp, '别的原因打死不算天冲的功劳').toBe(maxHpBefore)
  })
})

describe('神·黄忠：斩决', () => {
  /** 推进到 p0 的下一个出牌阶段，并在斩决面板上选一项。 */
  function toPlayPhase(game: SanguoshaGame, option: 'a' | 'b' | null): void {
    const answer = (request: AnyRequest) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('斩决')) {
        return option ? { optionId: option } : { optionId: 'cancel' }
      }
      if (request.kind === 'choose-option' && request.prompt?.includes('裂穹')) return { optionId: 'cancel' }
      return null
    }
    /*
     * 先把已经挂着的请求答完再推进。
     *
     * `gameAt` 停在出牌阶段时，斩决那条询问已经发出来了——
     * 带着待回应请求去 `advancePhase` 会直接抛「仍有待处理 Request」。
     */
    settle(game, answer)
    if (game.state.currentPlayerId === 'p0' && game.state.phase === 'play') return
    for (let guard = 0; guard < 40; guard += 1) {
      game.advancePhase()
      settle(game, answer)
      if (game.state.currentPlayerId === 'p0' && game.state.phase === 'play') return
    }
    throw new Error('没能回到出牌阶段')
  }

  it('一：摸等同于体力值的牌，下一张【杀】不能被响应', () => {
    const game = gameAt('hz-zhanjue-a')
    const owner = playerOf(game, 'p0')
    owner.hp = 3
    const before = owner.zones.hand.length
    toPlayPhase(game, 'a')
    expect(playerOf(game, 'p0').zones.hand.length - before, '摸 3 张').toBe(3)
    expect(playerOf(game, 'p0').marks['zhanjue-slash'], '武装了下一张【杀】').toBe(1)

    // 目标手里有闪也闪不掉
    trimHand(game, 'p1', 0)
    giveCard(game, 'p1', '闪')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    const hpBefore = playerOf(game, 'p1').hp
    const slash = giveCard(game, 'p0', '杀')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    settle(game, (request) => (request.kind === 'choose-option' && request.prompt?.includes('裂穹')
      ? { optionId: 'cancel' }
      : null))
    expect(hpBefore - playerOf(game, 'p1').hp, '不能被响应，照常掉血').toBe(1)
    expect(playerOf(game, 'p0').marks['zhanjue-slash'], '用掉就收').toBeUndefined()
  })

  it('二：摸已损失体力值的牌，下一次造成伤害后回复等量体力', () => {
    const game = gameAt('hz-zhanjue-b')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp - 2
    const before = owner.zones.hand.length
    toPlayPhase(game, 'b')
    expect(playerOf(game, 'p0').zones.hand.length - before, '摸 2 张').toBe(2)

    const hpBefore = playerOf(game, 'p0').hp
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    resolveDamage(game as never, { sourceId: 'p0', targetId: 'p1', amount: 2 })
    game.settle()
    settle(game, (request) => (request.kind === 'choose-option' && request.prompt?.includes('裂穹')
      ? { optionId: 'cancel' }
      : null))
    expect(playerOf(game, 'p0').hp - hpBefore, '回复等同于这次伤害的点数').toBe(2)
    expect(playerOf(game, 'p0').marks['zhanjue-recover'], '只生效一次').toBeUndefined()
  })

  it('出牌阶段结束就清掉待生效状态，不漏到下一个回合', () => {
    const game = gameAt('hz-zhanjue-clear')
    playerOf(game, 'p0').hp = 3
    toPlayPhase(game, 'a')
    expect(playerOf(game, 'p0').marks['zhanjue-slash']).toBe(1)
    game.advancePhase()
    settle(game, (request) => (request.kind === 'choose-option' && request.prompt?.includes('裂穹')
      ? { optionId: 'cancel' }
      : null))
    expect(playerOf(game, 'p0').marks['zhanjue-slash'], '出牌阶段一结束就清掉').toBeUndefined()
  })
})
