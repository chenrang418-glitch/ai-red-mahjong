import { describe, expect, it } from 'vitest'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import { hiddenHandSlot } from '@/sanguosha/engine/cards/host'
import { pushCardUseTargets } from '@/sanguosha/engine/card-use-targets'

const FUYU = 'fuyu-xing-wanglang:b59'
const ZHANSHI = 'zhanshi-xing-wanglang:b59'
const ZHENGPI = 'zhengpi-cuiyan-maojie:b59'
const FENGYING = 'fengying-cuiyan-maojie:b59'
const SHANXI = 'shanxi-shiheqi:b59'
const QIZHOU = 'qizhou-shiheqi:b59'

function gameFor(seed: string) {
  const game = new SanguoshaGame({ seed, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  game.state.status = 'playing'
  return game
}

function giveCard(game: SanguoshaGame, playerId: string, name?: string) {
  const cardId = game.state.zones.drawPile.find((id) => !name || game.state.cards[id]?.name === name)
  if (!cardId) throw new Error(`牌堆没有可用牌：${name ?? '任意'}`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function trigger(game: SanguoshaGame, skillId: string, eventName: string, ownerId: string, payload: Record<string, unknown>) {
  const runtime = getSkillRuntime(skillId)
  const handler = runtime?.triggers?.find((entry) => entry.event === eventName)
  if (!handler) throw new Error(`${skillId} 缺少 ${eventName} 触发器`)
  handler.handle(game as never, ownerId, {
    event: { id: `test-${eventName}`, seq: game.state.seq + 1, name: eventName, sourceId: ownerId, sourceSkillId: skillId, payload },
    cancelled: false,
    cancel() {},
  } as never)
}

describe('武将册续开发第59批', () => {
  it('按武将册顺序注册十名角色，且每项技能都有实际运行时', () => {
    const expected: Array<[string, string]> = [
      ['cheli-ji-b59', '彻里吉'], ['sun-jun-shi-b59', '势·孙峻'], ['zhou-yu-shi-b59', '势·周瑜'],
      ['zhou-fei-jie-b59', '界周妃'], ['wanglang-star-b59', '星·王朗'], ['cao-zhen-shi-b59', '势·曹真'],
      ['shi-xiao-qiao-b59', '势·小乔'], ['yan-yan-jie-b59', '界严颜'], ['cuiyan-maojie-b59', '崔琰毛玠'], ['heqi-shi-b59', '势·贺齐'],
    ]
    expect(expected.map(([id]) => getCharacter(id)?.id)).toEqual(expected.map(([id]) => id))
    const actual = expected.map(([id]) => getCharacter(id)?.name)
    expect(actual).toEqual(expected.map(([, name]) => name))
    for (const [id, name] of expected) {
      for (const skill of getCharacter(id)?.skills ?? [])
        expect(getSkillRuntime(skill.id), `${name}【${skill.name}】缺少运行时`).toBeDefined()
    }
  })

  it('负隅只对唯一目标的普通牌发起拼点，并用技能名建立真实拼点流程', () => {
    const game = gameFor('b59-fuyu')
    const [owner, target] = game.state.players
    if (!owner || !target) throw new Error('fixture players missing')
    owner.characterId = 'wanglang-star-b59'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const slash = giveCard(game, owner.id, '杀')
    giveCard(game, owner.id)
    giveCard(game, target.id)
    pushCardUseTargets(game.state, { cardId: slash, sourceId: owner.id, targetIds: [target.id] })
    const runtime = getSkillRuntime(FUYU)!
    const accepted = runtime.interceptSourceTargetEach?.(game as never, owner.id, {
      sourceId: owner.id, targetId: target.id, cardId: slash, cardName: '杀', category: 'basic',
    })
    expect(accepted).toBe(true)
    const invoke = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: invoke.id, playerId: owner.id, payload: { optionId: 'yes' } })
    expect(game.state.pindian?.reason).toBe(FUYU)
    expect(game.state.pindian?.initiatorId).toBe(owner.id)
  })

  it('瞻势弃置与押注人数相同的牌，所押角色获胜后摸三张', () => {
    const game = gameFor('b59-zhanshi')
    const [owner, target] = game.state.players
    if (!owner || !target) throw new Error('fixture players missing')
    owner.characterId = 'wanglang-star-b59'
    const spent = giveCard(game, owner.id)
    giveCard(game, owner.id)
    trigger(game, ZHANSHI, 'PindianStart', owner.id, { pindianId: 'pd-test', initiatorId: owner.id, opponentId: target.id })
    const runtime = getSkillRuntime(ZHANSHI)!
    runtime.startQueued?.(game as never, owner.id, { skillId: ZHANSHI, ownerId: owner.id, step: 'participants', data: { pindianId: 'pd-test', candidates: [owner.id, target.id] } })
    const choose = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: choose.id, playerId: owner.id, payload: { targetIds: [owner.id] } })
    const discard = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: discard.id, playerId: owner.id, payload: { cardIds: [hiddenHandSlot(owner.id, 0)] } })
    expect(game.state.zones.discardPile).toContain(spent)
    const before = owner.zones.hand.length
    trigger(game, ZHANSHI, 'PindianEnd', owner.id, { pindianId: 'pd-test', initiatorId: owner.id, opponentId: target.id, outcome: 'initiator-win' })
    expect(owner.zones.hand.length).toBe(before + 3)
  })

  it('征辟从目标区域取牌并等量交换；目标选三张只增加一次后续目标机会', () => {
    const game = gameFor('b59-zhengpi')
    const [owner, target, secondTarget] = game.state.players
    if (!owner || !target || !secondTarget) throw new Error('fixture players missing')
    owner.characterId = 'cuiyan-maojie-b59'
    game.state.currentPlayerId = owner.id
    const ownCards = [giveCard(game, owner.id), giveCard(game, owner.id), giveCard(game, owner.id)]
    const targetCards = [giveCard(game, target.id), giveCard(game, target.id), giveCard(game, target.id)]
    giveCard(game, secondTarget.id)
    trigger(game, ZHENGPI, 'PhaseStart', owner.id, { playerId: owner.id, phase: 'prepare' })
    const selectTarget = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: selectTarget.id, playerId: owner.id, payload: { targetIds: [target.id] } })
    const targetGive = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: targetGive.id, playerId: target.id, payload: { cardIds: [0, 1, 2].map((index) => hiddenHandSlot(target.id, index)) } })
    const ownerGive = game.state.pendingRequests.at(-1)!
    const returned = owner.zones.hand.filter((id) => !ownCards.includes(id)).slice(0, 3)
    game.respond({ requestId: ownerGive.id, playerId: owner.id, payload: { cardIds: returned } })
    expect(target.zones.hand).toEqual(expect.arrayContaining(returned))
    expect(targetCards.every((id) => target.zones.hand.includes(id))).toBe(true)
    const bonusTarget = game.state.pendingRequests.at(-1)!
    expect(bonusTarget.kind).toBe('choose-targets')
    game.respond({ requestId: bonusTarget.id, playerId: owner.id, payload: { targetIds: [secondTarget.id] } })
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(secondTarget.id)
  })

  it('奉迎让范围内角色实际消耗手牌并对指定角色结算无中生有', () => {
    const game = gameFor('b59-fengying')
    const [actor, target, owner] = game.state.players
    if (!actor || !target || !owner) throw new Error('fixture players missing')
    owner.characterId = 'cuiyan-maojie-b59'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const material = giveCard(game, actor.id)
    const before = target.zones.hand.length
    const runtime = getSkillRuntime(FENGYING)!
    runtime.invokeActive?.(game as never, owner.id)
    const targetRequest = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } })
    const actorRequest = game.state.pendingRequests.at(-1)!
    expect(actorRequest.playerId).toBe(actor.id)
    game.respond({ requestId: actorRequest.id, playerId: actor.id, payload: { cardIds: [material] } })
    while (game.state.pendingRequests.some((request) => request.kind === 'respond-card' && request.requiredCardName === '无懈可击')) {
      const request = game.state.pendingRequests.find((item) => item.kind === 'respond-card' && item.requiredCardName === '无懈可击')!
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    }
    expect(actor.zones.hand).not.toContain(material)
    expect(game.state.zones.discardPile).toContain(material)
    expect(target.zones.hand.length).toBe(before + 2)
    expect(game.state.extraTurns.some((entry) => entry.playerId === owner.id)).toBe(true)
  })

  it('绮胄单次只标记一张；杀触发的下次发动摸牌并标记，闪袭按目标每阶段限一次', () => {
    const game = gameFor('b59-heqi')
    const [owner, target] = game.state.players
    if (!owner || !target) throw new Error('fixture players missing')
    owner.characterId = 'heqi-shi-b59'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const slash = giveCard(game, owner.id, '杀')
    const targetCard = giveCard(game, target.id)
    const state = game.state as typeof game.state & { b59HeQi?: Record<string, { marked: string[]; slashChainPending: boolean; playPhaseSerial: number; usedTargets: Record<string, number> }> }
    state.b59HeQi = { [owner.id]: { marked: [], slashChainPending: true, playPhaseSerial: 1, usedTargets: {} } }
    const qizhou = getSkillRuntime(QIZHOU)!
    qizhou.startQueued?.(game as never, owner.id, { skillId: QIZHOU, ownerId: owner.id, step: 'mark-target', data: { cardId: slash, nextSlash: true, grantDraw: true } })
    const chooseTarget = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: chooseTarget.id, playerId: owner.id, payload: { targetIds: [target.id] } })
    const chooseCard = game.state.pendingRequests.at(-1)!
    expect(chooseCard.kind).toBe('choose-cards')
    if (chooseCard.kind !== 'choose-cards') throw new Error('绮胄未请求选择暗置手牌')
    expect(chooseCard.max).toBe(1)
    game.respond({ requestId: chooseCard.id, playerId: owner.id, payload: { cardIds: [hiddenHandSlot(target.id, 0)] } })
    const entry = state.b59HeQi?.[owner.id]
    expect(entry?.marked).toContain(targetCard)
    expect(entry?.marked).toHaveLength(3)
    const shanxi = getSkillRuntime(SHANXI)!
    expect(shanxi.viewAs?.(game.state, owner.id)).toHaveLength(2)
    trigger(game, SHANXI, 'CardUsed', owner.id, { cardName: '决斗', targetIds: [target.id] })
    expect(shanxi.prohibitsSourceTarget?.(game.state, owner.id, target.id, '决斗', SHANXI)).toBe(true)
    trigger(game, QIZHOU, 'TurnEnd', owner.id, {})
    expect(entry?.marked).toEqual([])
    expect(game.state.zones.discardPile).toContain(targetCard)
  })
})
