import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { cyclicStatusOf, currentCyclicValue } from '@/sanguosha/engine/cyclic-status'
import { isSoleTargetOf } from '@/sanguosha/engine/card-use-targets'
import { REN_PILE, WULING_SPIRITS, WULING_STATUS, wulingSpiritOf } from '@/sanguosha/data/characters/god-shenhuatuo'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·华佗。
 *
 * 两个技能的重心完全不同：
 *
 * - 【五灵】的难点在**状态机**。五种灵是同一个状态的五个取值，不是五个技能；
 *   排列、当前位置、来源都要跟着快照走，重连之后一样都不能少。
 * - 【游医】的难点在**溯源**。只能收本次弃牌阶段、自己弃的、而且此刻仍然
 *   躺在弃牌堆里的牌——少一个条件就会凭空多复制一张牌出来。
 */

const CAST = ['shenhuatuo', 'zhangfei', 'guanyu', 'zhaoyun', 'machao']

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
      case 'arrange-options': {
        // 默认按选项原顺序给一个完整排列；可选的那种就交白卷表示放弃
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
  for (let guard = 0; guard < 300; guard += 1) {
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

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const own = playerOf(game, playerId)
  const card = Object.values(game.state.cards)
    .find((candidate) => candidate.name === cardName && !own.zones.hand.includes(candidate.id))
  if (!card) throw new Error('牌堆里没有【' + cardName + '】')
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function stripCard(game: SanguoshaGame, cardName: string): void {
  for (const player of game.state.players) {
    for (const cardId of [...player.zones.hand]) {
      if (game.state.cards[cardId]?.name !== cardName) continue
      moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
    }
  }
}

function useOn(game: SanguoshaGame, actorId: string, cardId: string, targetIds: string[]): void {
  const action = game.legalActions(actorId).find((candidate) => (
    candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId)
    && candidate.targetIds.length === targetIds.length
    && targetIds.every((id) => candidate.targetIds.includes(id))
  ))
  if (!action) throw new Error('找不到出牌动作：' + cardId + ' -> ' + targetIds.join(','))
  game.act(actorId, action.id)
}

/** 发动一次五灵，把排列按参数依次选完。 */
function grantWuling(game: SanguoshaGame, targetId: string, order: readonly string[]): void {
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'wuling')
  if (!action) throw new Error('五灵入口不可用')
  game.act('p0', action.id)
  let targeted = false
  settle(game, (request) => {
    if (request.kind === 'choose-targets' && request.playerId === 'p0' && !targeted) {
      targeted = true
      return { targetIds: [targetId] }
    }
    // 排列一次给全：请求层会校验它必须是五种灵的全排列
    if (request.kind === 'arrange-options' && request.playerId === 'p0') return { optionIds: [...order] }
    return null
  })
}

describe('神·华佗：五灵的状态机', () => {
  it('完整排列必须五种各一次，目标立刻进入第一种', () => {
    const game = gameAt('huatuo-order')
    grantWuling(game, 'p1', ['bear', 'tiger', 'crane', 'ape', 'deer'])
    const status = cyclicStatusOf(game.state, WULING_STATUS, 'p1')!
    expect(status.order).toEqual(['bear', 'tiger', 'crane', 'ape', 'deer'])
    expect(new Set(status.order).size, '五种各一次，无重无漏').toBe(5)
    expect(status.index, '立刻进入第一种，不等下一个准备阶段').toBe(0)
    expect(wulingSpiritOf(game.state, 'p1')).toBe('bear')
    expect(status.sourceId, '来源要记住：一桌两个神华佗不能串线').toBe('p0')
  })

  it('准备阶段依次切换，走完一轮回到第一种', () => {
    const game = gameAt('huatuo-cycle')
    grantWuling(game, 'p1', [...WULING_SPIRITS])
    const seen: (string | null)[] = [wulingSpiritOf(game.state, 'p1')]
    for (let round = 0; round < 5; round += 1) {
      game.dispatch('PhaseStart', { playerId: 'p1', phase: 'prepare' }, { sourceId: 'p1', phase: 'prepare' })
      settle(game)
      seen.push(wulingSpiritOf(game.state, 'p1'))
    }
    expect(seen.slice(0, 5)).toEqual([...WULING_SPIRITS])
    expect(seen[5], '第六次回到第一种——是循环，不是走完就结束').toBe(WULING_SPIRITS[0])
  })

  it('已经有五灵的人不再是合法目标', () => {
    const game = gameAt('huatuo-once-each')
    grantWuling(game, 'p1', [...WULING_SPIRITS])
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'wuling')!
    game.act('p0', action.id)
    const request = game.state.pendingRequests[0] as unknown as { candidateIds: string[] }
    expect(request.candidateIds, '不能重复授予').not.toContain('p1')
    settle(game)
  })

  it('出牌阶段限两次', () => {
    const game = gameAt('huatuo-twice')
    grantWuling(game, 'p1', [...WULING_SPIRITS])
    grantWuling(game, 'p2', [...WULING_SPIRITS])
    const again = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'wuling')
    expect(again, '一个出牌阶段最多两次').toBeUndefined()
  })

  it('排列和当前位置跟着快照走，重连不丢', () => {
    const game = gameAt('huatuo-restore')
    grantWuling(game, 'p1', ['deer', 'ape', 'bear', 'crane', 'tiger'])
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    const status = cyclicStatusOf(restored.state, WULING_STATUS, 'p1')!
    expect(status.order).toEqual(['deer', 'ape', 'bear', 'crane', 'tiger'])
    expect(status.index).toBe(0)
    expect(currentCyclicValue(restored.state, WULING_STATUS, 'p1')).toBe('deer')
  })
})

describe('神·华佗：五种灵的效果', () => {
  it('鹤：进入时摸三张，不是每个准备阶段都摸', () => {
    const game = gameAt('huatuo-crane')
    const before = playerOf(game, 'p1').zones.hand.length
    grantWuling(game, 'p1', ['crane', 'tiger', 'bear', 'ape', 'deer'])
    expect(playerOf(game, 'p1').zones.hand.length - before, '进入鹤立刻摸三张').toBe(3)

    // 切到虎：不该再摸
    const afterCrane = playerOf(game, 'p1').zones.hand.length
    game.dispatch('PhaseStart', { playerId: 'p1', phase: 'prepare' }, { sourceId: 'p1', phase: 'prepare' })
    settle(game)
    expect(wulingSpiritOf(game.state, 'p1')).toBe('tiger')
    expect(playerOf(game, 'p1').zones.hand.length, '不在鹤上就不摸').toBe(afterCrane)
  })

  it('虎：只指定一个目标的牌伤害 +1，多目标不加', () => {
    const game = gameAt('huatuo-tiger')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    grantWuling(game, 'p1', ['tiger', 'crane', 'bear', 'ape', 'deer'])

    game.state.currentPlayerId = 'p1'
    const single = giveCard(game, 'p1', '杀')
    const hpBefore = playerOf(game, 'p2').hp
    useOn(game, 'p1', single, ['p2'])
    settle(game)
    expect(playerOf(game, 'p2').hp, '单目标杀：1 点变 2 点').toBe(hpBefore - 2)

    // 多目标锦囊：不加
    const arrowsHp = playerOf(game, 'p3').hp
    const arrows = giveCard(game, 'p1', '万箭齐发')
    useOn(game, 'p1', arrows, ['p0', 'p2', 'p3', 'p4'])
    settle(game)
    expect(playerOf(game, 'p3').hp, '多目标牌不触发虎').toBe(arrowsHp - 1)
  })

  it('熊：每个实际回合限一次，3 点变 2 点而不是变 0', () => {
    const game = gameAt('huatuo-bear')
    grantWuling(game, 'p1', ['bear', 'tiger', 'crane', 'ape', 'deer'])
    const target = playerOf(game, 'p1')
    target.hp = 4

    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 3 })
    settle(game)
    expect(target.hp, '一次减 1，不是每点各减一次').toBe(4 - 2)

    // 同一个回合里第二次不再减
    const afterFirst = target.hp
    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 1 })
    settle(game)
    expect(target.hp, '本回合已经用过').toBe(afterFirst - 1)
  })

  it('熊：换一个回合重新可用', () => {
    const game = gameAt('huatuo-bear-reset')
    grantWuling(game, 'p1', ['bear', 'tiger', 'crane', 'ape', 'deer'])
    const target = playerOf(game, 'p1')
    target.hp = 8
    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 2 })
    settle(game)
    const afterFirstTurn = target.hp

    // 换一个回合实例：额外回合也算新的一个
    game.state.turnNumber += 1
    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 2 })
    settle(game)
    expect(target.hp, '新回合重新可用，2 点又变 1 点').toBe(afterFirstTurn - 1)
  })

  it('鹿：进入时回复一点并弃掉判定区的牌', () => {
    const game = gameAt('huatuo-deer')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp - 2
    // 判定区先塞一张延时锦囊
    const indulgence = giveCard(game, 'p1', '乐不思蜀')
    moveCard(game.state, indulgence, { kind: 'hand', playerId: 'p1' }, { kind: 'judgingArea', playerId: 'p1' })

    grantWuling(game, 'p1', ['deer', 'ape', 'bear', 'crane', 'tiger'])

    expect(target.hp, '回复 1 点').toBe(target.maxHp - 1)
    expect(target.zones.judgingArea, '判定区清空').toHaveLength(0)
    expect(game.state.zones.discardPile, '进的是弃牌堆，不是某个凭空造出来的区域').toContain(indulgence)
    assertCardConservation(game.state)
  })

  it('鹿：不能成为延时锦囊的目标——是禁止指定，不是效果无效', () => {
    const game = gameAt('huatuo-deer-target')
    grantWuling(game, 'p1', ['deer', 'ape', 'bear', 'crane', 'tiger'])
    game.state.currentPlayerId = 'p2'
    const indulgence = giveCard(game, 'p2', '乐不思蜀')
    /*
     * 必须把**转化**出来的动作排掉。
     *
     * 关羽【武圣】可以把这张红牌当【杀】用，那条动作当然可以指向鹿——
     * 鹿禁的是延时锦囊，不是所有牌。只按 cardId 过滤会把它一起算进来。
     */
    const actions = game.legalActions('p2').filter((candidate) => (
      candidate.kind === 'use-card'
      && candidate.cardIds.includes(indulgence)
      && (candidate.asCardName ?? '乐不思蜀') === '乐不思蜀'
    ))
    expect(actions.some((action) => action.targetIds.includes('p1')), '一开始就不能指向鹿').toBe(false)
    expect(actions.length, '对别人照常能用').toBeGreaterThan(0)
  })

  it('猿：进入时可获得另一名角色装备区的一张牌，没人有装备就不发问', () => {
    const game = gameAt('huatuo-ape-empty')
    // 先确认全场没有装备时不会弹出必然点不动的请求
    for (const player of game.state.players) {
      for (const slot of ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse'] as const) {
        const cardId = player.zones.equipment[slot]
        if (cardId) moveCard(game.state, cardId, { kind: 'equipment', playerId: player.id, slot }, { kind: 'discardPile' })
      }
    }
    grantWuling(game, 'p1', ['ape', 'bear', 'crane', 'deer', 'tiger'])
    expect(game.state.pendingRequests, '没有装备就不该有请求挂着').toHaveLength(0)
    assertCardConservation(game.state)
  })
})

describe('神·华佗：游医', () => {
  it('只收本阶段、自己弃的、而且还在弃牌堆里的牌', () => {
    const game = gameAt('huatuo-youyi')
    const owner = playerOf(game, 'p0')
    const kept = giveCard(game, 'p0', '杀')
    const taken = giveCard(game, 'p0', '闪')

    // 摆一个弃牌阶段账本：两张都是本阶段弃的，但其中一张已经被别人拿走了
    game.state.zones.discardPile.push(kept)
    owner.zones.hand = owner.zones.hand.filter((id) => id !== kept && id !== taken)
    playerOf(game, 'p1').zones.hand.push(taken)
    game.state.discardPhaseLedger = {
      phaseInstanceId: 'phase-1',
      ownerPlayerId: 'p0',
      records: [kept, taken].map((cardId) => ({
        cardId, sourcePlayerId: 'p0', originalZone: 'hand' as const,
        moveReason: 'discard' as const, enteredDiscardAt: 1,
      })),
    }

    game.dispatch('PhaseEnd', { playerId: 'p0', phase: 'discard' }, { sourceId: 'p0', phase: 'discard' })
    settle(game, (request) => (request.kind === 'choose-option' && request.playerId === 'p0' ? { optionId: 'yes' } : null))

    const ren = owner.characterPiles?.[REN_PILE] ?? []
    expect(ren, '还在弃牌堆里的那张进仁区').toContain(kept)
    expect(ren, '已经被别人拿走的那张不能再复制一份').not.toContain(taken)
    expect(playerOf(game, 'p1').zones.hand, '它仍然在别人手上').toContain(taken)
    assertCardConservation(game.state)
  })

  it('仁区为空时不显示技能入口', () => {
    const game = gameAt('huatuo-youyi-empty')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'youyi')
    expect(action, '空仁区没有任何意义，不该给入口').toBeUndefined()
  })

  it('发动：弃掉仁区所有牌，全场各回复一点', () => {
    const game = gameAt('huatuo-youyi-heal')
    const owner = playerOf(game, 'p0')
    const cards = [giveCard(game, 'p0', '杀'), giveCard(game, 'p0', '闪')]
    owner.characterPiles = { ...(owner.characterPiles ?? {}), [REN_PILE]: [] }
    for (const cardId of cards) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'characterPile', playerId: 'p0', pile: REN_PILE })
    }
    for (const player of game.state.players) player.hp = Math.max(1, player.maxHp - 2)
    const before = game.state.players.map((player) => player.hp)

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'youyi')!
    game.act('p0', action.id)
    settle(game)

    expect(owner.characterPiles?.[REN_PILE] ?? [], '仁区清空').toHaveLength(0)
    for (const cardId of cards) expect(game.state.zones.discardPile).toContain(cardId)
    game.state.players.forEach((player, index) => {
      expect(player.hp, `${player.nickname} 应回复 1 点`).toBe(before[index] + 1)
    })
    assertCardConservation(game.state)
  })
})

describe('公共机制：使用牌的目标表', () => {
  it('多目标牌走到最后一个目标时，仍然知道它当初不止一个目标', () => {
    const game = gameAt('huatuo-targets')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    game.state.currentPlayerId = 'p1'
    const arrows = giveCard(game, 'p1', '万箭齐发')
    let sawMultiTarget = false
    game.events.on('DamageCaused', () => {
      // 结算过程中的任何一刻，这张牌都不该被当成「只指定了一个目标」
      if (!isSoleTargetOf(game.state, arrows, 'p4')) sawMultiTarget = true
    })
    useOn(game, 'p1', arrows, ['p0', 'p2', 'p3', 'p4'])
    settle(game)
    expect(sawMultiTarget, '剩余目标表会被消耗掉，不能拿它判断原始目标数').toBe(true)
  })
})
