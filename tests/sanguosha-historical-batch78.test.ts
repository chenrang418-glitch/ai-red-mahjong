import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { resolveDamageSequence } from '@/sanguosha/engine/damage'
import { buildPlayerView } from '@/sanguosha/engine/view'
import { declaredCardActions, executeUseCardAction } from '@/sanguosha/engine/cards/basic'
import { HISTORICAL_BATCH78_CHARACTERS } from '@/sanguosha/data/characters/historical-batch78'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((entry) => { entry.characterId = null })
  return game
}

describe('武将册第78批运行时基础规则', () => {
  it('武将册次序与批次定义一致，人物与技能 ID 均无重复', () => {
    expect(HISTORICAL_BATCH78_CHARACTERS.map(({ name }) => name)).toEqual([
      '星·袁术', '夏侯楙', '乐大乔', '乐小乔', '曹宪', '星·袁绍', '星·张春华', '神·许褚', '谋·司马懿', '谋·蒋济',
    ])
    expect(new Set(HISTORICAL_BATCH78_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    const skillIds = HISTORICAL_BATCH78_CHARACTERS.flatMap(({ skills }) => skills.map(({ id }) => id))
    expect(new Set(skillIds).size).toBe(skillIds.length)
    for (const skillId of skillIds) expect(getSkillRuntime(skillId), skillId).toBeDefined()
  })

  it('【壮魄】只把牌名含“杀”的实体手牌列为【决斗】转化', () => {
    const game = gameFor('b78-zhuangpo-viewas')
    const owner = game.state.players[0]!
    game.state.phase = 'play'
    const slash = game.state.zones.drawPile.find((id) => (game.state.cards[id]?.name ?? '').includes('杀'))!
    const peach = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, peach, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const options = getSkillRuntime('zhuangpo-god-xuchu-b78')!.viewAs!(game.state, owner.id)
    expect(options.map(({ cardId, asCardName }) => [cardId, asCardName])).toEqual([[slash, '决斗']])
  })

  it('【争擎】按本轮各单回合已结算伤害总值给最高者擎标记', () => {
    const game = gameFor('b78-zhengqing-round')
    const owner = game.state.players[0]!
    const winner = game.state.players[1]!
    owner.characterId = 'god-xuchu-b78'
    const runtime = getSkillRuntime('zhengqing-god-xuchu-b78')!
    const settled = runtime.triggers!.find(({ event }) => event === 'DamageSettled')!
    settled.handle(game as never, owner.id, { event: { name: 'DamageSettled', sourceId: winner.id,
      payload: { finalAmount: 2 } } } as never)
    const roundEnd = runtime.triggers!.find(({ event }) => event === 'RoundEnd')!
    roundEnd.handle(game as never, owner.id, { event: { name: 'RoundEnd', payload: { roundNumber: game.state.roundNumber } } } as never)
    expect(winner.marks['zhengqing-god-xuchu:b78']).toBe(2)
    expect(game.state.players.every((entry) => entry.marks['zhengqing-god-xuchu:b78'] === 0 || entry.id === winner.id)).toBe(true)
  })

  it('【平辽】进行中的杀只向使用者和当前目标公开目标身份', () => {
    const game = gameFor('b78-pingliao-private-target')
    const [source, target, observer] = game.state.players
    source!.characterId = 'mou-simayi-b78'
    game.state.currentPlayerId = source!.id
    game.state.phase = 'play'
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: source!.id })
    const action = declaredCardActions(game.state, source!.id, slashId, '杀', '测试【平辽】')
      .find((entry) => entry.kind === 'use-card' && entry.targetIds.includes(target!.id))
    expect(action?.kind).toBe('use-card')
    if (action?.kind !== 'use-card') return
    executeUseCardAction(game as never, source!.id, action)
    expect(game.state.cardResolution?.kind).toBe('slash')
    if (game.state.cardResolution?.kind !== 'slash') return
    expect(game.state.cardResolution.privateTargets).toBe(true)
    const sourceView = buildPlayerView(game.state, source!.id).cardResolution!
    const targetView = buildPlayerView(game.state, target!.id).cardResolution!
    const observerView = buildPlayerView(game.state, observer!.id).cardResolution!
    expect(sourceView.targetIds).toEqual([target!.id])
    expect(targetView.currentTargetId).toBe(target!.id)
    expect(observerView.targetIds).toEqual([])
    expect(observerView.currentTargetId).toBeNull()
  })

  it('【傲势】只有袁绍为主公时才向群势力角色提供出牌阶段入口', () => {
    const game = gameFor('b78-aoshi-lord-only')
    const owner = game.state.players[0]!
    const actor = game.state.players[1]!
    owner.characterId = 'star-yuanshao-b78'
    actor.kingdomOverride = 'qun'
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: actor.id })
    game.state.currentPlayerId = actor.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('aoshi-star-yuanshao-b78')!
    expect(runtime.grantsPlayActions!(game.state, owner.id, actor.id)).toHaveLength(0)
    owner.identity = 'lord'
    expect(runtime.grantsPlayActions!(game.state, owner.id, actor.id)).toHaveLength(1)
  })

  it('【权谋】未在出牌阶段触发的待处理效果不会泄漏到后续阶段', () => {
    const game = gameFor('b78-quanmou-phase-expiry')
    const owner = game.state.players[0]!
    const runtime = getSkillRuntime('quanmu-mou-simayi-b78')!
    const state = game.state as typeof game.state & { b78?: Record<string, any> }
    state.b78 = { quanMouPending: { [owner.id]: { targetId: game.state.players[1]!.id, turn: game.state.turnNumber, state: 'yin' } } }
    runtime.triggers!.find(({ event }) => event === 'PhaseEnd')!.handle!(game as never, owner.id,
      { event: { name: 'PhaseEnd', payload: { playerId: owner.id, phase: 'play' } } } as never)
    expect(state.b78?.quanMouPending?.[owner.id]).toBeUndefined()
  })

  it('公共多目标伤害序列在所有目标结算完毕后只发出一次完成时机', () => {
    const game = gameFor('b78-damage-sequence-complete')
    const source = game.state.players[0]!
    const targets = game.state.players.slice(1, 3)
    const seen: Array<{ sourceSkillId?: string; targetIds?: string[] }> = []
    const events = (game as never as { events: { on(name: string, handler: (context: { event: { sourceSkillId?: string; payload: unknown } }) => void): void } }).events
    events.on('DamageSequenceResolved', (context) => seen.push({ sourceSkillId: context.event.sourceSkillId,
      targetIds: (context.event.payload as { targetIds?: string[] }).targetIds }))
    resolveDamageSequence(game, { sourceId: source.id, targetIds: targets.map(({ id }) => id), amount: 1,
      nature: 'fire', cardId: null, cardName: null, sourceSkillId: 'test-batch78' })
    expect(seen).toEqual([{ sourceSkillId: 'test-batch78', targetIds: targets.map(({ id }) => id) }])
    expect(game.state.damageSequence).toBeNull()
  })

  it('【纵势】将原花色其余手牌作为同一次实体【杀】材料消耗', () => {
    const game = gameFor('b78-zongshi-use')
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const prototypeId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const suit = game.state.cards[prototypeId]!.suit
    const materialId = game.state.zones.drawPile.find((id) => id !== prototypeId && game.state.cards[id]?.suit === suit)!
    moveCard(game.state, prototypeId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, materialId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime('zongshi-star-yuanshao-b78')!
    expect(runtime.activeActions!(game.state, owner.id)).toHaveLength(1)
    runtime.invokeActive!(game as never, owner.id, 'zongshi:activate')
    const prototypeRequest = game.state.pendingRequests.find((request) => request.kind === 'choose-cards')!
    game.respond({ requestId: prototypeRequest.id, playerId: owner.id, payload: { cardIds: [prototypeId] } } as never)
    const targetRequest = game.state.pendingRequests.find((request) => request.kind === 'choose-targets')!
    expect(targetRequest.kind).toBe('choose-targets')
    if (targetRequest.kind !== 'choose-targets') return
    const targetId = targetRequest.candidateIds.find((id) => id !== owner.id)!
    game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [targetId] } } as never)
    expect(game.state.cardResolution?.kind).toBe('slash')
    expect(game.state.zones.processingArea).toContain(materialId)
    expect(owner.zones.hand).toContain(prototypeId)
    expect(owner.zones.hand).not.toContain(materialId)
  })

  it('【纵势】的无目标普通锦囊也消耗全部同花色材料并正常结算', () => {
    const game = gameFor('b78-zongshi-trick')
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const prototypeId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '无中生有')!
    const suit = game.state.cards[prototypeId]!.suit
    const materialId = game.state.zones.drawPile.find((id) => id !== prototypeId && game.state.cards[id]?.suit === suit)!
    moveCard(game.state, prototypeId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, materialId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime('zongshi-star-yuanshao-b78')!
    runtime.invokeActive!(game as never, owner.id, 'zongshi:activate')
    const prototypeRequest = game.state.pendingRequests.find((request) => request.kind === 'choose-cards')!
    game.respond({ requestId: prototypeRequest.id, playerId: owner.id, payload: { cardIds: [prototypeId] } } as never)
    const targetRequest = game.state.pendingRequests.find((request) => request.kind === 'choose-targets')!
    expect(targetRequest?.kind).toBe('choose-targets')
    if (targetRequest?.kind !== 'choose-targets') return
    game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [owner.id] } } as never)
    expect(game.state.zones.discardPile).toContain(materialId)
    expect(owner.zones.hand).toContain(prototypeId)
    expect(owner.zones.hand).toHaveLength(3)
    expect(game.state.cardResolution).toBeNull()
  })
})
