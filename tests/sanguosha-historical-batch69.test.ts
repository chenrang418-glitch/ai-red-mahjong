import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import { discardCardsByOwners } from '@/sanguosha/engine/discard-all'
import { isCardIneffective } from '@/sanguosha/engine/equipment'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import '@/sanguosha/data/characters/historical-batch69'

const JUETU = 'juetu-yangzhong-b69'
const YINGXIANG = 'yingxiang-xunshi-b69'
const DINGAN = 'dingan-xunyu-b69'
const YICHI = 'yichi-yangbiao-b69'
const JUEWEI = 'juewei-lujing-b69'
const SHENGMO = 'shengmo-wangmingshan-b69'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第69批进行中的技能', () => {
  it('按武将册第915–924条顺序登记10名武将且无批内重复', () => {
    const batch = ALL_CHARACTERS.filter((character) => character.id.endsWith('-b69'))
    expect(batch.map((character) => character.name)).toEqual([
      '族·杨彪', '族·陆绩', '族·王广', '族·王明山', '族·杨众',
      '族·陆景', '族·荀彧', '族·陈群', '族·荀莳', '族·陆郁生',
    ])
    expect(new Set(batch.map((character) => character.id)).size).toBe(10)
  })

  it('【革制】可原子弃置两名角色的同类别牌（同类别时由技能层决定不施加限制）', () => {
    const game = gameFor('b69-gezhi-atomic-discard')
    const [owner, source] = game.state.players
    const firstCard = game.state.zones.drawPile[0]!
    const sameCategory = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.category === game.state.cards[firstCard]?.category && cardId !== firstCard)!
    const cards = [firstCard, sameCategory]
    moveCard(game.state, firstCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, sameCategory, { kind: 'drawPile' }, { kind: 'hand', playerId: source!.id })
    const moved = discardCardsByOwners(game as never, [
      { playerId: owner!.id, cardId: firstCard }, { playerId: source!.id, cardId: sameCategory },
    ], 'test-gezhi')
    expect(moved).toHaveLength(2)
    expect(cards.every((cardId) => game.state.zones.discardPile.includes(cardId))).toBe(true)
    expect(source!.alive).toBe(true)
  })

  it('陆景【绝围】整张伤害牌无效记录覆盖【杀】目标并在该牌结算后清理', () => {
    const game = gameFor('b69-juewei-global-invalidation')
    const [owner, target] = game.state.players
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    game.state.invalidatedCardUses = { [slash]: { sourceId: owner!.id, skillId: JUEWEI } }
    expect(isCardIneffective(game.state, target!.id, '杀', null, 'normal', owner!.id, undefined, slash)).toBe(true)

    const runtime = getSkillRuntime(JUEWEI)!
    runtime.triggers?.find((trigger) => trigger.event === 'AfterCardUse')!.handle(game, owner!.id, {
      event: { id: 'test-juewei-after-use', seq: 5, name: 'AfterCardUse', payload: { cardId: slash } },
      cancelled: false, cancel() { this.cancelled = true },
    })
    expect(game.state.invalidatedCardUses?.[slash]).toBeUndefined()
  })

  it('陆景【绝围】的弃置装备选项挂起后作废整张【杀】，不再索要【闪】', () => {
    const game = gameFor('b69-juewei-interaction')
    const [owner, target] = game.state.players
    target!.characterId = 'clan-lujing-b69'
    const equipment = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    const slot = game.state.cards[equipment]!.equipmentSlot!
    moveCard(game.state, equipment, { kind: 'drawPile' }, { kind: 'equipment', playerId: target!.id, slot })
    const targetHp = target!.hp
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'processingArea' })
    game.state.cardResolution = {
      kind: 'slash', cardId: slash, sourceId: owner!.id, targetId: target!.id,
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-intercept',
      interceptsDone: [`skill:${JUEWEI}`], extraCardIds: [], remainingTargetIds: [],
      requestId: null, dodgeRemaining: 1, surrogate: null,
    }
    expect(getSkillRuntime(JUEWEI)!.interceptTarget!(game, target!.id, {
      sourceId: owner!.id, targetId: target!.id, cardId: slash, cardName: '杀', category: 'basic',
    })).toBe(true)

    let request = game.state.pendingRequests.at(-1)!
    expect((request as { options: Array<{ id: string }> }).options.map((option) => option.id)).toContain('invalidate')
    game.respond({ requestId: request.id, playerId: target!.id, payload: { optionId: 'invalidate' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-cards', cardIds: [equipment] })
    game.respond({ requestId: request.id, playerId: target!.id, payload: { cardIds: [equipment] } })

    expect(game.state.zones.discardPile).toContain(equipment)
    expect(target!.hp).toBe(targetHp)
    expect(game.state.cardResolution).toBeNull()
    const followUp = game.state.pendingRequests.at(-1)
    if (followUp?.kind === 'choose-targets' && followUp.skillId === 'zelei-clan-lu-b69') {
      game.respond({ requestId: followUp.id, playerId: target!.id, payload: { targetIds: [owner!.id] } })
    }
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('王明山【剩墨】在濒死求【桃】时可取得本回合牌并以中间点数救援', () => {
    const game = gameFor('b69-shengmo-rescue')
    const owner = game.state.players[0]!
    owner.characterId = 'clan-wangmingshan-b69'
    owner.hp = 0
    const low = game.state.zones.drawPile.find((id) => game.state.cards[id]?.rank === 1)!
    const middle = game.state.zones.drawPile.find((id) => game.state.cards[id]?.rank === 7 && id !== low)!
    const high = game.state.zones.drawPile.find((id) => game.state.cards[id]?.rank === 13 && id !== low && id !== middle)!
    for (const cardId of [low, middle, high]) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    ;(game.state as typeof game.state & { b69?: { shengmoDiscardTurn?: Record<string, number> } }).b69 = {
      shengmoDiscardTurn: { [low]: game.state.turnNumber, [middle]: game.state.turnNumber, [high]: game.state.turnNumber },
    }

    game.enterDying(owner.id)
    let request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'rescue', playerId: owner.id })
    expect((request as { actionIds: string[] }).actionIds).toContain(`${SHENGMO}:rescue`)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { actionId: `${SHENGMO}:rescue` } })

    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: owner.id, cardIds: expect.arrayContaining([middle]) })
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [middle] } })
    expect(owner.hp).toBe(1)
    expect(game.state.zones.discardPile).toContain(middle)
    expect((game.state as typeof game.state & { b69?: { shengmoUsedRound?: Record<string, number> } }).b69?.shengmoUsedRound?.[owner.id]).toBe(game.state.roundNumber)
  })

  it('杨众【绝途】按展示牌花色选择伤害或以展示牌真实使用过河拆桥', () => {
    const game = gameFor('b69-juetu-dismantlement')
    const [owner, revealer, victim] = game.state.players
    const ownerSpade = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === 'spade')!
    const revealedSpade = game.state.zones.drawPile.find((id) => id !== ownerSpade && game.state.cards[id]?.suit === 'spade')!
    const victimCard = game.state.zones.drawPile.find((id) => id !== ownerSpade && id !== revealedSpade)!
    moveCard(game.state, ownerSpade, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, revealedSpade, { kind: 'drawPile' }, { kind: 'hand', playerId: revealer!.id })
    moveCard(game.state, victimCard, { kind: 'drawPile' }, { kind: 'hand', playerId: victim!.id })

    const runtime = getSkillRuntime(JUETU)!
    const trigger = runtime.triggers?.find((candidate) => candidate.event === 'PhaseStart')!
    const event = { id: 'test-phase', seq: 1, name: 'PhaseStart' as const, payload: { playerId: owner!.id, phase: 'discard' } }
    trigger.handle(game, owner!.id, { event, cancelled: false, cancel() { this.cancelled = true } })

    let request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-targets', playerId: owner!.id })
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [revealer!.id] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: revealer!.id, cardIds: [revealedSpade] })
    game.respond({ requestId: request.id, playerId: revealer!.id, payload: { cardIds: [revealedSpade] } })

    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-targets', playerId: owner!.id })
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [victim!.id] } })

    expect(game.state.cardUseHistory?.some((entry) => entry.sourceId === owner!.id && entry.cardName === '过河拆桥')).toBe(true)
    expect(game.state.zones.processingArea).toContain(revealedSpade)
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-cards', playerId: owner!.id, cardIds: [] })
    expect((game.state.pendingRequests.at(-1) as { hiddenCardSlots?: string[] }).hiddenCardSlots).toHaveLength(1)
  })

  it('荀莳【萦香】追踪转交后的持有者，牌被使用后双方各摸一张', () => {
    const game = gameFor('b69-yingxiang-transfer')
    const [owner, firstHolder, nextHolder] = game.state.players
    const gifted = game.state.zones.drawPile[0]!
    moveCard(game.state, gifted, { kind: 'drawPile' }, { kind: 'hand', playerId: firstHolder!.id })
    const runtime = getSkillRuntime(YINGXIANG)!
    const handLeft = runtime.triggers?.find((trigger) => trigger.event === 'HandCardLeft')!
    const afterUse = runtime.triggers?.find((trigger) => trigger.event === 'AfterCardUse')!
    const ctx = (name: 'HandCardLeft' | 'AfterCardUse', payload: Record<string, unknown>) => ({
      event: { id: `test-${name}`, seq: 1, name, payload }, cancelled: false, cancel() { this.cancelled = true },
    })

    handLeft.handle(game, owner!.id, ctx('HandCardLeft', {
      cardId: gifted, playerId: owner!.id, destination: { kind: 'hand', playerId: firstHolder!.id },
    }))
    handLeft.handle(game, owner!.id, ctx('HandCardLeft', {
      cardId: gifted, playerId: firstHolder!.id, destination: { kind: 'hand', playerId: nextHolder!.id },
    }))
    const ownerHandBefore = owner!.zones.hand.length
    const holderHandBefore = nextHolder!.zones.hand.length
    afterUse.handle(game, owner!.id, ctx('AfterCardUse', { cardId: gifted, sourceId: nextHolder!.id }))

    expect(owner!.zones.hand).toHaveLength(ownerHandBefore + 1)
    expect(nextHolder!.zones.hand).toHaveLength(holderHandBefore + 1)
    afterUse.handle(game, owner!.id, ctx('AfterCardUse', { cardId: gifted, sourceId: nextHolder!.id }))
    expect(owner!.zones.hand).toHaveLength(ownerHandBefore + 1)
  })

  it('荀彧【定安】只响应本回合牌名第二次使用，并排除该牌目标', () => {
    const game = gameFor('b69-dingan-second-use')
    const [owner, cardTarget, secondUser, other] = game.state.players
    const turnNumber = game.state.turnNumber
    game.state.cardUseHistory = [
      { turnNumber, turnKind: 'normal', sourceId: cardTarget!.id, cardName: '杀' },
      { turnNumber, turnKind: 'normal', sourceId: secondUser!.id, cardName: '杀' },
    ]
    const runtime = getSkillRuntime(DINGAN)!
    const eventContext = (name: 'TurnStart' | 'AfterCardUse', payload: Record<string, unknown>) => ({
      event: { id: `test-${name}`, seq: 2, name, payload }, cancelled: false, cancel() { this.cancelled = true },
    })
    runtime.triggers?.find((trigger) => trigger.event === 'TurnStart')!.handle(game, owner!.id,
      eventContext('TurnStart', { playerId: secondUser!.id, turnNumber }))
    runtime.triggers?.find((trigger) => trigger.event === 'AfterCardUse')!.handle(game, owner!.id,
      eventContext('AfterCardUse', { cardName: '杀', targetIds: [cardTarget!.id] }))

    expect(game.state.pendingRequests.at(-1)).toMatchObject({
      kind: 'choose-targets', playerId: owner!.id,
      candidateIds: [secondUser!.id, other!.id, game.state.players[4]!.id],
    })
  })

  it('杨彪【义叱】第四项濒死后等 QuitDying 完成，再继续并释放拼点牌', () => {
    const game = gameFor('b69-yichi-dying')
    const [owner, target] = game.state.players
    target!.hp = 1
    const peach = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '桃')!
    moveCard(game.state, peach, { kind: 'drawPile' }, { kind: 'hand', playerId: game.state.players[2]!.id })
    const settlementCards = game.state.zones.drawPile.slice(0, 2)
    for (const cardId of settlementCards) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    game.state.pindianSettlement = { id: 'b69-yichi-pindian', cardIds: settlementCards }
    ;(game.state as typeof game.state & { b69?: { yichiPending?: Record<string, { targetId: string; count: number; nextOption: number }> } }).b69 = {
      yichiPending: { [owner!.id]: { targetId: target!.id, count: 4, nextOption: 3 } },
    }

    const runtime = getSkillRuntime(YICHI)!
    runtime.startQueued!(game, owner!.id, { skillId: YICHI, ownerId: owner!.id, step: 'resume-after-dying', data: {} })
    expect(game.state.dying?.playerId).toBe(target!.id)
    expect(game.state.pindianSettlement?.id).toBe('b69-yichi-pindian')
    expect((game.state as typeof game.state & { b69?: { yichiPending?: Record<string, unknown> } }).b69?.yichiPending?.[owner!.id]).toBeTruthy()

    target!.hp = 1
    runtime.triggers?.find((trigger) => trigger.event === 'QuitDying')!.handle(game, owner!.id, {
      event: { id: 'test-yichi-quit-dying', seq: 4, name: 'QuitDying', payload: { playerId: target!.id } },
      cancelled: false, cancel() { this.cancelled = true },
    })
    expect(game.state.skillQueue.at(-1)?.step).toBe('resume-after-dying')
    game.state.dying = null
    runtime.startQueued!(game, owner!.id, { skillId: YICHI, ownerId: owner!.id, step: 'resume-after-dying', data: {} })
    expect(game.state.pindianSettlement).toBeNull()
    expect((game.state as typeof game.state & { b69?: { yichiPending?: Record<string, unknown> } }).b69?.yichiPending?.[owner!.id]).toBeUndefined()
  })
})
