import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { QUAN_PILE, quanCountOf } from '@/sanguosha/data/characters/yjcm2012-zhonghui'
import { getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { buildPlayerView } from '@/sanguosha/engine/view'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 钟会（一将成名 2012 经典）。
 *
 * 七条主张，逐条有断言：
 *
 * - 【权计】按**每 1 点伤害**各给一次机会，不是一次伤害问一次；
 * - 顺序是先摸一张、再从当前手牌里挑一张进「权」；
 * - 进权不是弃牌；权是公开的实体牌堆；
 * - 手牌上限实时 +X；
 * - 【自立】在权满三张时觉醒，顺序是减上限 → 二选一 → 获得【排异】，只来一次；
 * - 【排异】先付权（上限立刻降）、目标摸两张、比较发生在摸完之后；
 * - 选自己时不会自伤。
 */

const CAST = ['zhonghui', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  for (const cardId of playerOf(game, playerId).zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

function setHand(game: SanguoshaGame, playerId: string, count: number): void {
  trimHand(game, playerId, count)
  const player = playerOf(game, playerId)
  while (player.zones.hand.length < count) {
    moveCard(game.state, game.state.zones.drawPile[0], { kind: 'drawPile' }, { kind: 'hand', playerId })
  }
}

/** 直接往权堆里塞 n 张牌（跳过权计流程，用于摆自立/排异的场面）。 */
function stackQuan(game: SanguoshaGame, playerId: string, count: number): string[] {
  const placed: string[] = []
  for (let index = 0; index < count; index += 1) {
    const cardId = game.state.zones.drawPile[0]
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId, pile: QUAN_PILE })
    placed.push(cardId)
  }
  return placed
}

/** 打钟会 amount 点伤害，按 plan 回答权计。返回被问了几次。 */
function hitZhongHui(game: SanguoshaGame, amount: number, plan: { invoke: boolean } = { invoke: true }) {
  let asked = 0
  const owner = playerOf(game, 'p0')
  owner.hp = owner.maxHp
  resolveDamage(game as never, { sourceId: 'p1', targetId: 'p0', amount, nature: 'normal' })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('权计')) {
      asked += 1
      return { optionId: plan.invoke ? 'yes' : 'no' }
    }
    return null
  })
  return asked
}

describe('钟会：权计', () => {
  it('每 1 点伤害各给一次机会', () => {
    for (const [seed, amount] of [['zh-1', 1], ['zh-2', 2], ['zh-3', 3]] as const) {
      const game = gameAt(seed)
      expect(hitZhongHui(game, amount, { invoke: false }), `${amount} 点伤害问 ${amount} 次`).toBe(amount)
    }
  })

  it('发动之后：先摸一张，再放一张进权', () => {
    const game = gameAt('zh-place')
    setHand(game, 'p0', 2)
    const handBefore = playerOf(game, 'p0').zones.hand.length
    hitZhongHui(game, 1)
    expect(quanCountOf(game.state, 'p0'), '权多了一张').toBe(1)
    // 摸一张 +1、放一张进权 -1，净额不变
    expect(playerOf(game, 'p0').zones.hand, '手牌净额不变').toHaveLength(handBefore)
    assertCardConservation(game.state)
  })

  it('可以不发动', () => {
    const game = gameAt('zh-decline')
    hitZhongHui(game, 2, { invoke: false })
    expect(quanCountOf(game.state, 'p0'), '一张权都没有').toBe(0)
  })

  it('进权不是弃牌：不进弃牌堆', () => {
    const game = gameAt('zh-notdiscard')
    setHand(game, 'p0', 2)
    const discardBefore = game.state.zones.discardPile.length
    hitZhongHui(game, 1)
    expect(game.state.zones.discardPile.length, '弃牌堆没有变多').toBe(discardBefore)
    const quan = playerOf(game, 'p0').characterPiles?.[QUAN_PILE] ?? []
    expect(quan, '牌在权堆里').toHaveLength(1)
  })

  it('权是公开的：所有人都看得到牌面', () => {
    const game = gameAt('zh-quan-public')
    setHand(game, 'p0', 2)
    hitZhongHui(game, 1)
    const quan = playerOf(game, 'p0').characterPiles?.[QUAN_PILE] ?? []
    for (const viewerId of ['p0', 'p1', 'p2']) {
      const seat = buildPlayerView(game.state, viewerId).players.find((player) => player.id === 'p0')!
      expect((seat.characterPiles[QUAN_PILE] ?? []).map((card) => card.id), `${viewerId} 看得到权`).toEqual(quan)
    }
  })

  it('手牌上限 +X，实时按权的张数算', () => {
    const game = gameAt('zh-maxcards')
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    const base = maxCardsOf(game.state, 'p0')
    stackQuan(game, 'p0', 3)
    expect(maxCardsOf(game.state, 'p0'), '三张权 → 上限 +3').toBe(base + 3)
    // 拿走一张，立刻降 1
    const quan = owner.characterPiles![QUAN_PILE]
    moveCard(game.state, quan[0], { kind: 'characterPile', playerId: 'p0', pile: QUAN_PILE }, { kind: 'discardPile' })
    expect(maxCardsOf(game.state, 'p0'), '少一张就降一').toBe(base + 2)
  })
})

/** 跑一次准备阶段，按 choice 回答自立。 */
function runPrepare(game: SanguoshaGame, choice: 'recover' | 'draw') {
  let awakened = false
  game.dispatch('PhaseStart', { playerId: 'p0', phase: 'prepare' }, { sourceId: 'p0', phase: 'prepare' })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('自立')) {
      awakened = true
      return { optionId: choice }
    }
    return null
  })
  return awakened
}

describe('钟会：自立', () => {
  it('权不满三张不觉醒', () => {
    const game = gameAt('zh-zili-no')
    stackQuan(game, 'p0', 2)
    expect(runPrepare(game, 'draw'), '两张不够').toBe(false)
  })

  it('权满三张：减体力上限，然后二选一，最后获得【排异】', () => {
    const game = gameAt('zh-zili-yes')
    const owner = playerOf(game, 'p0')
    /*
     * 体力要比上限低**两点**：减 1 点上限之后体力会被压到新上限，
     * 只低一点的话回复那一步已经满了，看不出「回没回」。
     */
    owner.hp = owner.maxHp - 2
    const maxBefore = owner.maxHp
    const hpBefore = owner.hp
    stackQuan(game, 'p0', 3)
    expect(runPrepare(game, 'recover'), '觉醒了').toBe(true)
    expect(playerOf(game, 'p0').maxHp, '体力上限减一').toBe(maxBefore - 1)
    expect(playerOf(game, 'p0').hp, '选了回复：回一点').toBe(hpBefore + 1)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '获得了排异').toContain('paiyi')
  })

  it('选摸两张', () => {
    const game = gameAt('zh-zili-draw')
    setHand(game, 'p0', 1)
    stackQuan(game, 'p0', 3)
    const handBefore = playerOf(game, 'p0').zones.hand.length
    runPrepare(game, 'draw')
    expect(playerOf(game, 'p0').zones.hand, '摸了两张').toHaveLength(handBefore + 2)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).toContain('paiyi')
  })

  it('只觉醒一次', () => {
    const game = gameAt('zh-zili-once')
    stackQuan(game, 'p0', 3)
    expect(runPrepare(game, 'draw')).toBe(true)
    const maxAfterFirst = playerOf(game, 'p0').maxHp
    expect(runPrepare(game, 'draw'), '第二次准备阶段不再觉醒').toBe(false)
    expect(playerOf(game, 'p0').maxHp, '上限没有再掉').toBe(maxAfterFirst)
  })
})

function paiyiAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id.includes('paiyi'))
}

/** 跑一次排异。 */
function runPaiyi(game: SanguoshaGame, targetId: string) {
  const action = paiyiAction(game)
  if (!action) return false
  game.act('p0', action.id)
  settle(game, (request) => {
    if (request.kind === 'choose-cards' && request.prompt?.includes('排异')) {
      const pick = request as unknown as { cardIds: string[] }
      return { cardIds: pick.cardIds.slice(0, 1) }
    }
    if (request.kind === 'choose-targets' && request.prompt?.includes('排异')) {
      const pick = request as unknown as { candidateIds: string[] }
      return { targetIds: [pick.candidateIds.includes(targetId) ? targetId : pick.candidateIds[0]] }
    }
    return null
  })
  return true
}

/** 让钟会拿到排异并备好权。 */
function readyPaiyi(game: SanguoshaGame, quan = 2): void {
  stackQuan(game, 'p0', quan)
  const owner = playerOf(game, 'p0')
  owner.grantedSkills = [...(owner.grantedSkills ?? []), 'paiyi']
}

describe('钟会：排异', () => {
  it('要有权才能发动，弃权之后手牌上限立刻降', () => {
    const game = gameAt('zh-paiyi-cost')
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    readyPaiyi(game, 2)
    const maxBefore = maxCardsOf(game.state, 'p0')
    runPaiyi(game, 'p1')
    expect(quanCountOf(game.state, 'p0'), '花掉一张权').toBe(1)
    expect(maxCardsOf(game.state, 'p0'), '手牌上限立刻降一').toBe(maxBefore - 1)
    assertCardConservation(game.state)
  })

  it('没有权就没有这个动作', () => {
    const game = gameAt('zh-paiyi-noquan')
    const owner = playerOf(game, 'p0')
    owner.grantedSkills = [...(owner.grantedSkills ?? []), 'paiyi']
    expect(paiyiAction(game), '一张权都没有').toBeUndefined()
  })

  it('目标摸两张；摸完手牌比钟会多就挨一点伤害', () => {
    const game = gameAt('zh-paiyi-damage')
    readyPaiyi(game)
    setHand(game, 'p0', 1)
    setHand(game, 'p1', 3)
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    const handBefore = target.zones.hand.length
    runPaiyi(game, 'p1')
    expect(playerOf(game, 'p1').zones.hand, '摸了两张').toHaveLength(handBefore + 2)
    expect(playerOf(game, 'p1').hp, '手牌比钟会多，挨一点').toBe(target.maxHp - 1)
  })

  it('摸完之后手牌不比钟会多就不伤害', () => {
    const game = gameAt('zh-paiyi-nodamage')
    readyPaiyi(game)
    setHand(game, 'p0', 8)
    setHand(game, 'p1', 1)
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    runPaiyi(game, 'p1')
    expect(playerOf(game, 'p1').zones.hand, '摸了两张，一共三张').toHaveLength(3)
    expect(playerOf(game, 'p1').hp, '不比钟会的八张多，不挨打').toBe(target.maxHp)
  })

  it('选自己：只摸两张，不会自伤', () => {
    const game = gameAt('zh-paiyi-self')
    readyPaiyi(game)
    setHand(game, 'p0', 2)
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    const handBefore = owner.zones.hand.length
    runPaiyi(game, 'p0')
    expect(playerOf(game, 'p0').zones.hand, '自己摸了两张').toHaveLength(handBefore + 2)
    expect(playerOf(game, 'p0').hp, '手牌数不可能大于自己，不会自伤').toBe(owner.maxHp)
    assertGameInvariants(game.state)
  })

  it('出牌阶段限一次', () => {
    const game = gameAt('zh-paiyi-once')
    readyPaiyi(game, 3)
    runPaiyi(game, 'p1')
    expect(paiyiAction(game), '一个出牌阶段只能来一次').toBeUndefined()
  })
})

describe('钟会：版本锁', () => {
  it('只有【权计】【自立】，【排异】是觉醒后才获得的', () => {
    const character = getCharacter('zhonghui')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['quanji', 'zili', 'paiyi'])
    expect(character.skills.find((skill) => skill.id === 'paiyi')?.granted, '排异开局不拥有').toBe(true)
    expect(character.pack).toBe('yjcm2012')
    expect(character.maxHp).toBe(4)
    expect(character.kingdom).toBe('wei')
    // 开局只有前两个
    expect(skillIdsOf('zhonghui').sort(), '开局技能不含排异').toEqual(['quanji', 'zili'])
  })
})
