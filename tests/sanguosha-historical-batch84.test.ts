import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getDistance } from '@/sanguosha/engine/distance'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { withNextCardTargetChoices } from '@/sanguosha/engine/cards/basic'
import { markUsedThisPhase, usedThisPhase } from '@/sanguosha/engine/phase-usage'
import { abolishSlot } from '@/sanguosha/engine/equipment-slots'
import { moveCard } from '@/sanguosha/engine/zones'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import '@/sanguosha/data/characters/historical-batch84'

function gameForBatch84(seed: string) {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 6 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.skillResolution = null
  return game
}

function activateChiguo(game: SanguoshaGame, ownerId: string) {
  const runtime = getSkillRuntime('chiguo-xingjiangwan-b84')!
  const phaseStart = runtime.triggers!.find((trigger) => trigger.event === 'PhaseStart')!
  phaseStart.handle(game as never, ownerId, { event: { name: 'PhaseStart', payload: { playerId: ownerId, phase: 'play' } } } as never)
  const prompt = game.state.skillQueue.shift()!
  runtime.startQueued!(game as never, ownerId, prompt)
  let request = game.state.pendingRequests[0]!
  game.respond({ requestId: request.id, playerId: ownerId, payload: { optionId: 'yes' } } as never)
  request = game.state.pendingRequests[0]!
  expect(request.kind).toBe('choose-cards')
  expect((request as { viewOnlyCardIds?: string[] }).viewOnlyCardIds).toHaveLength(3)
  game.respond({ requestId: request.id, playerId: ownerId, payload: { cardIds: [] } } as never)
  return runtime
}

describe('第84批被动公共规则', () => {
  it('十名武将均按武将册顺序加入正式注册表且姓名唯一', () => {
    const expected = ['崔令仪', '威·马超', '马铁', '凌烈', '星·蒋琬', '陶璜', '威·孙尚香', '谋·徐盛', '谋·骆统', '谋·黄权']
    const batch = ALL_CHARACTERS.filter(({ id }) => id.endsWith('-b84'))
    expect(batch.map(({ name }) => name)).toEqual(expected)
    expect(new Set(batch.map(({ name }) => name)).size).toBe(expected.length)
  })

  it('崔令仪【华裳】开局置入红黑各一张，装备区双色时无距离限制，置入后补手牌', () => {
    const game = gameForBatch84('b84-huashang')
    const owner = game.state.players[0]!
    const runtime = getSkillRuntime('huashang-cuilingyi-b84')!
    runtime.onGameStart!(game as never, owner.id)
    const pile = owner.characterPiles[`huashang-cuilingyi-b84:${owner.id}`]!
    expect(pile).toHaveLength(2)
    expect(new Set(pile.map((id) => game.state.cards[id]!.color))).toEqual(new Set(['red', 'black']))
    expect(runtime.ignoresDistanceTo!(game.state, owner.id)).toBe(true)

    const [usedCard, offeredCard] = game.state.zones.drawPile.slice(0, 2)
    moveCard(game.state, usedCard!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, offeredCard!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.cards[usedCard]!.suit = 'club'; game.state.cards[offeredCard]!.suit = 'club'
    game.state.cards[offeredCard]!.category = 'basic'
    runtime.triggers!.find((trigger) => trigger.event === 'CardResolved')!.handle(game as never, owner.id,
      { event: { name: 'CardResolved', sourceId: owner.id, payload: { cardId: usedCard } } } as never)
    const prompt = game.state.skillQueue.find((entry) => entry.skillId === 'huashang-cuilingyi-b84')!
    runtime.startQueued!(game as never, owner.id, prompt)
    const resolution = game.state.skillResolution!
    runtime.resume!(game as never, owner.id, resolution as never,
      { playerId: owner.id, payload: { cardIds: [offeredCard] } } as never)
    expect(pile).toContain(offeredCard)
    expect(owner.zones.hand.length).toBeGreaterThanOrEqual(new Set(pile.map((id) => game.state.cards[id]!.suit)).size)
  })

  it('威·马超【极斩】只在装备牌后紧接黑色牌时触发，并累加技能发动次数', () => {
    const game = gameForBatch84('b84-jizhan')
    const owner = game.state.players[0]!
    const runtime = getSkillRuntime('jizhan-weimachao-b84')!
    const onCardUsed = runtime.triggers!.find((trigger) => trigger.event === 'CardUsed')!
    const [equipmentId, blackId, redId] = game.state.zones.drawPile.slice(0, 3)
    game.state.cards[equipmentId!]!.category = 'equipment'
    game.state.cards[blackId!]!.category = 'basic'
    game.state.cards[blackId!]!.suit = 'spade'
    game.state.cards[redId!]!.category = 'basic'
    game.state.cards[redId!]!.suit = 'heart'
    const use = (cardId: string) => onCardUsed.handle(game as never, owner.id, { event: {
      name: 'CardUsed', sourceId: owner.id, payload: { cardId, cardName: game.state.cards[cardId]!.name },
    } } as never)

    use(equipmentId!)
    use(blackId!)
    expect(game.state.skillQueue).toHaveLength(1)
    expect(game.state.skillQueue[0]).toMatchObject({ skillId: 'jizhan-weimachao-b84', step: 'choose-mode', data: { uses: 1 } })
    use(redId!)
    expect(game.state.skillQueue).toHaveLength(1)
  })

  it('威·马超【极斩】伤害分支按发动次数结算并锁至本回合结束', () => {
    const game = gameForBatch84('b84-jizhan-damage')
    const owner = game.state.players[0]!, target = game.state.players[1]!
    target.characterId = 'test-neutral'
    const hpBefore = target.hp
    const runtime = getSkillRuntime('jizhan-weimachao-b84')!
    runtime.startQueued!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'choose-mode', data: { turn: game.state.turnNumber, uses: 2 } } as never)
    let request = game.state.pendingRequests[0]!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'damage' } } as never)
    request = game.state.pendingRequests[0]!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    expect(target.hp).toBe(hpBefore - 2)
  })

  it('威·马超【极斩】弃牌分支通过暗手牌槽弃置所选角色的真实手牌', () => {
    const game = gameForBatch84('b84-jizhan-discard')
    const owner = game.state.players[0]!, target = game.state.players[1]!
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const runtime = getSkillRuntime('jizhan-weimachao-b84')!
    runtime.startQueued!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'choose-mode', data: { turn: game.state.turnNumber, uses: 1 } } as never)
    let request = game.state.pendingRequests[0]!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'discard' } } as never)
    request = game.state.pendingRequests[0]!
    expect(request.kind).toBe('choose-cards')
    const hiddenSlot = (request as { hiddenCardSlots: string[] }).hiddenCardSlots.find((slot) => slot.startsWith(`hidden:${target.id}:`))!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [hiddenSlot] } } as never)
    expect(target.zones.hand).not.toContain(cardId)
    expect(game.state.zones.discardPile).toContain(cardId)
  })

  it('谋·骆统【抗明】以其为目标的牌结算后摸一张；选择摸牌分支后摸三张并按时限失效', () => {
    const game = gameForBatch84('b84-kangming')
    const owner = game.state.players[0]!, source = game.state.players[1]!
    const runtime = getSkillRuntime('kangming-mouluotong-b84')!
    const trigger = runtime.triggers!.find((item) => item.event === 'CardResolved')!
    const cardId = game.state.zones.drawPile[0]!
    const before = owner.zones.hand.length
    trigger.handle(game as never, owner.id, { event: {
      name: 'CardResolved', sourceId: source.id, targetId: owner.id,
      payload: { cardId, targetIds: [owner.id], cancelled: true },
    } } as never)
    expect(owner.zones.hand).toHaveLength(before)
    const prompt = game.state.skillQueue.shift()!
    runtime.startQueued!(game as never, owner.id, prompt)
    expect(owner.zones.hand).toHaveLength(before + 1)
    const request = game.state.pendingRequests[0]!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'draw' } } as never)
    expect(owner.zones.hand).toHaveLength(before + 4)
    trigger.handle(game as never, owner.id, { event: {
      name: 'CardResolved', sourceId: source.id, targetId: owner.id,
      payload: { cardId: game.state.zones.drawPile[0], targetIds: [owner.id] },
    } } as never)
    expect(game.state.skillQueue).toHaveLength(0)
  })

  it('谋·骆统【抗明】展示一张本回合未公开展示的【杀】并对原使用者使用', () => {
    const game = gameForBatch84('b84-kangming-use')
    const owner = game.state.players[0]!, source = game.state.players[1]!
    owner.characterId = 'test-neutral'
    source.characterId = 'test-neutral'
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.cards[cardId]!.name = '杀'
    game.state.cards[cardId]!.category = 'basic'
    game.state.cards[cardId]!.suit = 'heart'
    const runtime = getSkillRuntime('kangming-mouluotong-b84')!
    const trigger = runtime.triggers!.find((item) => item.event === 'CardResolved')!
    trigger.handle(game as never, owner.id, { event: { name: 'CardResolved', sourceId: source.id,
      payload: { cardId: game.state.zones.drawPile[0], targetIds: [owner.id] } } } as never)
    runtime.startQueued!(game as never, owner.id, game.state.skillQueue.shift()!)
    let request = game.state.pendingRequests[0]!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'use' } } as never)
    request = game.state.pendingRequests[0]!
    expect((request as { cardIds: string[] }).cardIds).toContain(cardId)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [cardId] } } as never)
    request = game.state.pendingRequests[0]!
    const useOptions = (request as { options: Array<{ id: string; label: string }> }).options
    expect(useOptions.some((option) => option.label.includes(source.nickname))).toBe(true)
    const useActionId = useOptions[0]!.id
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: useActionId } } as never)
    expect(game.state.revealedCardIdsThisTurn?.cardIds).toContain(cardId)
    expect(game.state.cardUseHistory?.some((entry) => entry.sourceId === owner.id && entry.cardName === '杀')).toBe(true)
    expect(owner.zones.hand).not.toContain(cardId)
    expect(game.state.zones.processingArea.includes(cardId) || game.state.zones.discardPile.includes(cardId)).toBe(true)
  })

  it('全局公开展示记录按回合累计并在新回合更新', () => {
    const game = gameForBatch84('b84-public-reveal')
    const [first, second] = game.state.zones.drawPile
    game.dispatch('CardMove', { cardIds: [first], revealed: true }, { cardIds: [first] })
    game.dispatch('CardResponded', { cardId: second, revealed: true }, { cardIds: [second] })
    expect(game.state.revealedCardIdsThisTurn?.cardIds).toEqual([first, second])
    game.state.turnNumber += 1
    game.dispatch('CardMove', { cardIds: [second], revealed: true })
    expect(game.state.revealedCardIdsThisTurn).toEqual({ turnNumber: game.state.turnNumber, cardIds: [second] })
  })

  it('星·蒋琬【持国】异花色时把底牌交给所用牌的一名目标并继续原牌结算', () => {
    const game = gameForBatch84('b84-chiguo-give')
    const owner = game.state.players[0]!, target = game.state.players[1]!
    owner.characterId = 'test-neutral'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = activateChiguo(game, owner.id)
    const revealedId = game.state.zones.drawPile.at(-1)!
    game.state.cards[cardId]!.name = '杀'
    game.state.cards[cardId]!.category = 'basic'
    game.state.cards[cardId]!.suit = 'heart'
    game.state.cards[revealedId]!.suit = 'spade'
    const before = target.zones.hand.length
    const action = { id: 'chiguo-slash', kind: 'use-card' as const, playerId: owner.id, label: '【杀】',
      cardIds: [cardId], targetIds: [target.id], targetMin: 1, targetMax: 1, asCardName: '杀',
      interceptedSkillKeys: [`${owner.id}:${runtime.id}`] }
    expect(runtime.interceptPlayAction!(game as never, owner.id, action)).toBe(true)
    const request = game.state.pendingRequests[0]!
    expect(request.kind).toBe('choose-targets')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    expect(target.zones.hand).toHaveLength(before + 1)
    expect(target.zones.hand).toContain(revealedId)
    expect(game.state.cardResolution?.kind).toBe('slash')
  })

  it('星·蒋琬【持国】同花色时提供真实增加目标的动作，并弃置亮出的底牌', () => {
    const game = gameForBatch84('b84-chiguo-target')
    const owner = game.state.players[0]!, target = game.state.players[1]!
    owner.characterId = 'test-neutral'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = activateChiguo(game, owner.id)
    const revealedId = game.state.zones.drawPile.at(-1)!
    game.state.cards[cardId]!.name = '杀'
    game.state.cards[cardId]!.category = 'basic'
    game.state.cards[cardId]!.suit = 'heart'
    game.state.cards[revealedId]!.suit = 'heart'
    const action = { id: 'chiguo-slash-add', kind: 'use-card' as const, playerId: owner.id, label: '【杀】',
      cardIds: [cardId], targetIds: [target.id], targetMin: 1, targetMax: 1, asCardName: '杀',
      interceptedSkillKeys: [`${owner.id}:${runtime.id}`] }
    expect(runtime.interceptPlayAction!(game as never, owner.id, action)).toBe(true)
    const request = game.state.pendingRequests[0]!
    expect(request.kind).toBe('choose-option')
    const options = (request as { options: Array<{ id: string }> }).options
    expect(options.some((option) => option.id.includes(':target-plus:'))).toBe(true)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: options[0]!.id } } as never)
    expect(game.state.zones.discardPile).toContain(revealedId)
    expect(game.state.cardResolution?.kind).toBe('slash')
    expect(game.state.cardResolution?.kind === 'slash'
      ? [game.state.cardResolution.targetId, ...game.state.cardResolution.remainingTargetIds].length : 0).toBe(2)
  })

  it('星·蒋琬【持国】同花色时可以减少多目标牌的目标且至少保留一个', () => {
    const game = gameForBatch84('b84-chiguo-remove')
    const owner = game.state.players[0]!, firstTarget = game.state.players[1]!, secondTarget = game.state.players[2]!
    owner.characterId = 'test-neutral'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = activateChiguo(game, owner.id)
    const revealedId = game.state.zones.drawPile.at(-1)!
    game.state.cards[cardId]!.name = '铁索连环'
    game.state.cards[cardId]!.category = 'trick'
    game.state.cards[cardId]!.suit = 'heart'
    game.state.cards[revealedId]!.suit = 'heart'
    const action = { id: 'chiguo-chain-remove', kind: 'use-card' as const, playerId: owner.id, label: '【铁索连环】',
      cardIds: [cardId], targetIds: [firstTarget.id, secondTarget.id], targetMin: 1, targetMax: 2, asCardName: '铁索连环',
      interceptedSkillKeys: [`${owner.id}:${runtime.id}`] }
    expect(runtime.interceptPlayAction!(game as never, owner.id, action)).toBe(true)
    const request = game.state.pendingRequests[0]!
    const remove = (request as { options: Array<{ id: string }> }).options.find((option) => option.id.includes(':target-minus:'))!
    expect(remove).toBeDefined()
    const removedId = remove.id.split(':target-minus:').at(-1)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: remove.id } } as never)
    expect([firstTarget, secondTarget].filter((target) => target.chained)).toHaveLength(1)
    expect(removedId === firstTarget.id ? firstTarget.chained : secondTarget.chained).toBe(false)
    expect(game.state.zones.discardPile).toContain(revealedId)
  })

  it('谋·骆统【举策】额外目标选择会建立该角色下回合的强制追加目标', () => {
    const game = gameForBatch84('b84-juce')
    const owner = game.state.players[0]!, selected = game.state.players[1]!, originalTarget = game.state.players[2]!
    owner.grantedSkills = ['juce-mouluotong-b84']
    const cardId = game.state.zones.drawPile[0]!
    game.state.cards[cardId]!.name = '杀'
    game.state.cards[cardId]!.category = 'basic'
    const runtime = getSkillRuntime('juce-mouluotong-b84')!
    const action = { id: 'test-slash', kind: 'use-card' as const, playerId: owner.id, label: 'test Slash',
      cardIds: [cardId], targetIds: [originalTarget.id], targetMin: 1, targetMax: 1, asCardName: '杀' }
    const expanded = withNextCardTargetChoices(game.state, owner.id, [action], () => ['juce-mouluotong-b84'])
      .find((candidate) => candidate.kind === 'use-card' && candidate.targetExpansionSkillId === runtime.id
        && candidate.targetExpansionTargetId === selected.id)
    expect(expanded).toBeDefined()

    const chosenTrigger = runtime.triggers!.find((trigger) => trigger.event === 'TargetExpansionSelected')!
    chosenTrigger.handle(game as never, owner.id, { event: { name: 'TargetExpansionSelected', sourceId: owner.id,
      sourceSkillId: runtime.id, payload: { addedTargetId: selected.id } } } as never)
    const turnStart = runtime.triggers!.find((trigger) => trigger.event === 'TurnStart')!
    turnStart.handle(game as never, owner.id, { event: { name: 'TurnStart', payload: { playerId: selected.id } } } as never)
    expect(runtime.forcedAdditionalTargetsOnUse!(game.state, owner.id, selected.id, cardId, '杀', [], () => []))
      .toEqual([owner.id])

    const used = runtime.triggers!.find((trigger) => trigger.event === 'CardUsed')!
    used.handle(game as never, owner.id, { event: { name: 'CardUsed', sourceId: selected.id,
      payload: { cardId, cardName: '杀', targetIds: [originalTarget.id, owner.id] } } } as never)
    expect(runtime.forcedAdditionalTargetsOnUse!(game.state, owner.id, selected.id, cardId, '杀', [], () => []))
      .toEqual([])
  })

  it('陶璜【制绝】距离修正为-2，造成伤害补牌后在当前回合结束恢复', () => {
    const game = gameForBatch84('b84-zhijue')
    const owner = game.state.players[0]!, target = game.state.players[1]!
    const runtime = getSkillRuntime('zhijue-taohuang-b84')!
    const modifier = runtime.distanceModifier!.toOthers!
    expect(typeof modifier === 'function' ? modifier(game.state, owner.id) : modifier).toBe(-2)
    owner.maxHp = 4; owner.hp = 2
    const trigger = runtime.triggers!.find((entry) => entry.event === 'DamageSettled')!
    trigger.handle(game as never, owner.id, { event: { name: 'DamageSettled', sourceId: owner.id, targetId: target.id,
      payload: { requestedAmount: 1, finalAmount: 1 } } } as never)
    expect(owner.zones.hand).toHaveLength(4)
    expect((modifier as (state: typeof game.state, id: string) => number)(game.state, owner.id)).toBe(0)
    runtime.triggers!.find((entry) => entry.event === 'TurnEnd')!.handle(game as never, owner.id,
      { event: { name: 'TurnEnd', payload: { playerId: target.id, turnNumber: game.state.turnNumber } } } as never)
    expect((modifier as (state: typeof game.state, id: string) => number)(game.state, owner.id)).toBe(-2)
  })

  it('马铁【追击】只将本回合对牌目标的单向距离覆盖为1', () => {
    const game = gameForBatch84('b84-zhuiji')
    const owner = game.state.players[0]!, target = game.state.players[3]!
    expect(getDistance(game.state, owner.id, target.id)).not.toBe(1)
    const runtime = getSkillRuntime('zhuiji-matie-b84')!
    runtime.triggers!.find((entry) => entry.event === 'CardResolved')!.handle(game as never, owner.id,
      { event: { name: 'CardResolved', sourceId: owner.id, payload: { targetIds: [target.id] } } } as never)
    expect(getDistance(game.state, owner.id, target.id)).toBe(1)
    expect(getDistance(game.state, target.id, owner.id)).not.toBe(1)
  })

  it('凌烈【狩虎】结算后双向距离+1，目标因此阵亡时摸牌并清除本阶段限次', () => {
    const game = gameForBatch84('b84-shouhu')
    const owner = game.state.players[0]!, target = game.state.players[2]!
    const runtime = getSkillRuntime('shouhu-linglie-b84')!
    const firstDistance = runtime.globalDistanceModifier!(game.state, owner.id, owner.id, target.id)
    const reverseDistance = runtime.globalDistanceModifier!(game.state, owner.id, target.id, owner.id)
    runtime.triggers!.filter((trigger) => trigger.event === 'CardResolved').forEach((trigger) => trigger.handle(game as never, owner.id,
      { event: { name: 'CardResolved', sourceId: owner.id, sourceSkillId: 'shouhu-linglie-b84',
        payload: { targetIds: [target.id] } } } as never))
    expect(runtime.globalDistanceModifier!(game.state, owner.id, owner.id, target.id)).toBe(firstDistance + 1)
    expect(runtime.globalDistanceModifier!(game.state, owner.id, target.id, owner.id)).toBe(reverseDistance + 1)

    const cardId = game.state.zones.drawPile[1]!
    const removed = game.state.zones.drawPile[0]!
    moveCard(game.state, removed, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    markUsedThisPhase(game.state, owner.id, 'shouhu-linglie-b84')
    game.state.cardResolution = { kind: 'slash', cardId, sourceId: owner.id, targetId: target.id,
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-intercept', targetAsked: [], requestId: null } as never
    game.state.cardUseSourceSkills ??= {}; game.state.cardUseSourceSkills[cardId] = 'shouhu-linglie-b84'
    target.hp = 0
    const phaseUse = getSkillRuntime('shouhu-linglie-b84')
    phaseUse!.triggers!.filter((trigger) => trigger.event === 'Death').forEach((trigger) => trigger.handle(game as never, owner.id,
      { event: { name: 'Death', sourceId: owner.id, targetId: target.id, payload: { playerId: target.id } } } as never))
    const granted = owner.zones.hand.at(-1)!
    expect(owner.zones.hand).toHaveLength(owner.maxHp)
    expect(runtime.unlimitedCardUses!(game.state, owner.id, granted)).toBe(true)
    expect(usedThisPhase(game.state, owner.id, 'shouhu-linglie-b84')).toBe(false)

    game.state.currentPlayerId = owner.id; game.state.phase = 'play'
    runtime.triggers!.find((trigger) => trigger.event === 'PhaseStart')!.handle(game as never, owner.id,
      { event: { name: 'PhaseStart', payload: { playerId: owner.id, phase: 'play' } } } as never)
    markUsedThisPhase(game.state, owner.id, 'shouhu-linglie-b84')
    owner.attackRangeBonus = 20
    runtime.triggers!.find((trigger) => trigger.event === 'CardZoneMoved')!.handle(game as never, owner.id,
      { event: { name: 'CardZoneMoved', payload: {} } } as never)
    expect(usedThisPhase(game.state, owner.id, 'shouhu-linglie-b84')).toBe(false)
  })

  it('凌烈【凝准】每两张牌结算后询问，并让攻击范围选项即时生效', () => {
    const game = gameForBatch84('b84-ningzhun')
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id; game.state.phase = 'play'
    const runtime = getSkillRuntime('ningzhun-linglie-b84')!
    runtime.triggers!.find((trigger) => trigger.event === 'TurnStart')!.handle(game as never, owner.id,
      { event: { name: 'TurnStart', payload: { playerId: owner.id } } } as never)
    const resolveEvent = () => runtime.triggers!.find((trigger) => trigger.event === 'CardResolved')!.handle(game as never, owner.id,
      { event: { name: 'CardResolved', sourceId: owner.id, payload: { cardName: '杀' } } } as never)
    resolveEvent()
    expect(game.state.skillQueue.some((entry) => entry.skillId === 'ningzhun-linglie-b84')).toBe(false)
    resolveEvent()
    const queued = game.state.skillQueue.find((entry) => entry.skillId === 'ningzhun-linglie-b84')!
    runtime.startQueued!(game as never, owner.id, queued)
    const resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never,
      { playerId: owner.id, payload: { optionId: 'plus' } } as never)
    expect(runtime.attackRangeBonus!(game.state, owner.id)).toBe(1)
  })

  it('威·孙尚香【淑任】废除装备栏、失去原装备、回复并分配展示牌', () => {
    const game = gameForBatch84('b84-shuren')
    const owner = game.state.players[0]!, recipient = game.state.players[1]!
    owner.hp = owner.maxHp - 1
    const weapon = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment'
      && game.state.cards[id]?.equipmentSlot === 'weapon')!
    moveCard(game.state, weapon, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot: 'weapon' })
    const runtime = getSkillRuntime('shuren-weisunshangxiang-b84')!
    game.state.currentPlayerId = owner.id; game.state.phase = 'play'
    runtime.invokeActive!(game as never, owner.id, 'shuren-weisunshangxiang-b84:activate')
    let resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { optionId: 'weapon' } } as never)
    expect(game.state.abolishedSlots?.[owner.id]).toContain('weapon')
    expect(owner.zones.equipment.weapon).toBeNull()
    expect(owner.hp).toBe(owner.maxHp)
    expect(usedThisPhase(game.state, owner.id, 'shuren-weisunshangxiang-b84')).toBe(false)

    resolution = game.state.skillResolution!
    const revealed = resolution.data.revealed as string[]
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { cardIds: [revealed[0]] } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { targetIds: [recipient.id] } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { cardIds: [revealed[1]] } } as never)
    expect(owner.zones.hand).toContain(revealed[0])
    expect(recipient.zones.hand).toContain(revealed[1])
    expect(game.state.zones.discardPile).toContain(revealed[2])
    expect(revealed.every((id) => !game.state.zones.processingArea.includes(id))).toBe(true)
  })

  it('谋·徐盛【勤强】按连续同色手牌使用数分别记录摸牌与伤害选项', () => {
    const game = gameForBatch84('b84-qinqiang')
    const owner = game.state.players[0]!, target = game.state.players[1]!
    const slashes = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.name === '杀'
      && game.state.cards[id]?.color === 'black').slice(0, 3)
    expect(slashes).toHaveLength(3)
    for (const cardId of slashes) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime('qinjiang-mouxusheng-b84')!
    const used = (cardId: string) => runtime.triggers!.find((trigger) => trigger.event === 'CardUsed')!.handle(game as never, owner.id,
      { event: { name: 'CardUsed', sourceId: owner.id, payload: { cardId, cardName: '杀', fromKind: 'hand' } } } as never)
    used(slashes[0]!)
    const queued = game.state.skillQueue.find((entry) => entry.skillId === 'qinjiang-mouxusheng-b84')!
    runtime.startQueued!(game as never, owner.id, queued)
    let resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    const beforeDraw = owner.zones.hand.length
    runtime.resume!(game as never, owner.id, resolution as never,
      { playerId: owner.id, payload: { optionId: 'draw' } } as never)
    expect(owner.zones.hand).toHaveLength(beforeDraw + 1)
    game.state.skillQueue = []
    used(slashes[1]!)
    const nextQueued = game.state.skillQueue.find((entry) => entry.skillId === 'qinjiang-mouxusheng-b84')!
    runtime.startQueued!(game as never, owner.id, nextQueued)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never,
      { playerId: owner.id, payload: { optionId: 'damage' } } as never)
    expect(runtime.outgoingDamage!(game.state, owner.id, { targetId: target.id, amount: 1, nature: 'normal',
      cardId: slashes[1] as never, cardName: '杀', chainTransfer: false })?.amount).toBe(3)
  })

  it('谋·徐盛【疑阵】双方选择对方手牌弃置，同色时谋徐盛获得两张', () => {
    const game = gameForBatch84('b84-yizhen')
    const owner = game.state.players[0]!, source = game.state.players[1]!
    const cards = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.color === 'red').slice(0, 2)
    expect(cards).toHaveLength(2)
    moveCard(game.state, cards[0]!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, cards[1]!, { kind: 'drawPile' }, { kind: 'hand', playerId: source.id })
    const runtime = getSkillRuntime('yizhen-mouxusheng-b84')!
    runtime.triggers!.find((trigger) => trigger.event === 'DamageSettled')!.handle(game as never, owner.id,
      { event: { name: 'DamageSettled', sourceId: source.id, targetId: owner.id,
        payload: { requestedAmount: 1, finalAmount: 1 } } } as never)
    let queued = game.state.skillQueue.find((entry) => entry.skillId === 'yizhen-mouxusheng-b84')!
    runtime.startQueued!(game as never, owner.id, queued)
    let resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { optionId: 'yes' } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { cardIds: [cards[1]] } } as never)
    resolution = game.state.skillResolution!
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(source.id)
    expect((game.state.pendingRequests.at(-1) as { viewOnlyCardIds?: string[] }).viewOnlyCardIds).toContain(cards[0])
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: source.id, payload: { cardIds: [cards[0]] } } as never)
    expect(owner.zones.hand).toContain(cards[0])
    expect(owner.zones.hand).toContain(cards[1])
    expect(source.zones.hand).not.toContain(cards[1])
  })

  it('威·孙尚香【飒然】按当前装备区牌数增加出杀次数', () => {
    const game = gameForBatch84('b84-saran')
    const owner = game.state.players[0]!
    owner.zones.equipment.weapon = 'b84-test-weapon' as never
    owner.zones.equipment.armor = 'b84-test-armor' as never
    const runtime = getSkillRuntime('saran-weisunshangxiang-b84')!
    expect(runtime.globalSlashUses!(game.state, owner.id, owner.id)).toBe(2)
    owner.zones.equipment.armor = null
    expect(runtime.globalSlashUses!(game.state, owner.id, owner.id)).toBe(1)
    expect(runtime.globalSlashUses!(game.state, owner.id, game.state.players[1]!.id)).toBe(0)
  })

  it('威·孙尚香【飒然】受伤或造成伤害后先恢复废除栏，再随机使用牌堆或弃牌堆装备', () => {
    const game = gameForBatch84('b84-saran-trigger')
    const owner = game.state.players[0]!, attacker = game.state.players[1]!
    const armor = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment'
      && game.state.cards[id]?.equipmentSlot === 'armor')!
    moveCard(game.state, armor, { kind: 'drawPile' }, { kind: 'discardPile' })
    abolishSlot(game.state, owner.id, 'armor')
    const runtime = getSkillRuntime('saran-weisunshangxiang-b84')!
    runtime.triggers!.find((trigger) => trigger.event === 'DamageSettled')!.handle(game as never, owner.id,
      { event: { name: 'DamageSettled', sourceId: attacker.id, targetId: owner.id,
        payload: { requestedAmount: 1, finalAmount: 1 } } } as never)
    const queued = game.state.skillQueue.find((entry) => entry.skillId === 'saran-weisunshangxiang-b84')!
    runtime.startQueued!(game as never, owner.id, queued)
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(owner.id)
    let resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { optionId: 'armor' } } as never)
    expect(game.state.abolishedSlots?.[owner.id] ?? []).not.toContain('armor')
    const equipped = Object.values(owner.zones.equipment).filter((cardId) => cardId !== null)
    expect(equipped).toHaveLength(1)
    expect(game.state.zones.drawPile).not.toContain(equipped[0])
    expect(game.state.zones.discardPile).not.toContain(equipped[0])

    const skipGame = gameForBatch84('b84-saran-skip')
    const skipOwner = skipGame.state.players[0]!, skipRuntime = getSkillRuntime('saran-weisunshangxiang-b84')!
    abolishSlot(skipGame.state, skipOwner.id, 'armor')
    skipRuntime.triggers!.find((trigger) => trigger.event === 'DamageSettled')!.handle(skipGame as never, skipOwner.id,
      { event: { name: 'DamageSettled', sourceId: attacker.id, targetId: skipOwner.id,
        payload: { requestedAmount: 1, finalAmount: 1 } } } as never)
    const skipPrompt = skipGame.state.skillQueue.find((entry) => entry.skillId === 'saran-weisunshangxiang-b84')!
    skipRuntime.startQueued!(skipGame as never, skipOwner.id, skipPrompt)
    expect((skipGame.state.pendingRequests.at(-1) as { options?: Array<{ id: string }> }).options?.map(({ id }) => id)).toContain('skip')
    const skipResolution = skipGame.state.skillResolution!
    skipRuntime.resume!(skipGame as never, skipOwner.id, skipResolution as never,
      { playerId: skipOwner.id, payload: { optionId: 'skip' } } as never)
    expect(skipGame.state.abolishedSlots?.[skipOwner.id]).toContain('armor')
    expect(Object.values(skipOwner.zones.equipment).some(Boolean)).toBe(true)
  })

  it('谋·黄权【巧对】给出手牌后，使用者分支重复结算，成为目标分支令整张牌失效', () => {
    const game = gameForBatch84('b84-qiaodui')
    const owner = game.state.players[0]!, victim = game.state.players[1]!, recipient = game.state.players[2]!
    const gift = game.state.zones.drawPile[0]!
    moveCard(game.state, gift, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.currentPlayerId = owner.id
    const runtime = getSkillRuntime('qiaodui-mouhuangquan-b84')!
    game.resumeCardTarget = () => {}
    const host = game
    game.state.cardResolution = { kind: 'trick', cardId: game.state.zones.drawPile[0]!, cardName: '无中生有',
      sourceId: owner.id, targetIds: [victim.id], targetIndex: 0, responderIndex: 0, nullificationCount: 0,
      nullifiedTargetIds: [], cancelledTargetIds: [], declinedAllIds: [], unresponsiveTargetIds: [], stage: 'awaiting-effect',
      effect: null, requestId: null, interceptsDone: [] } as never
    expect(runtime.interceptSourceTarget!(host as never, owner.id, { sourceId: owner.id, targetId: victim.id,
      cardId: game.state.cardResolution!.cardId, cardName: '无中生有', category: 'trick' })).toBe(true)
    let resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(host as never, owner.id, resolution as never, { playerId: owner.id, payload: { targetIds: [recipient.id] } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(host as never, owner.id, resolution as never, { playerId: owner.id, payload: { cardIds: [gift] } } as never)
    expect(recipient.zones.hand).toContain(gift)
    expect(runtime.repeatTargetEffectCount!(game.state, owner.id, victim.id, game.state.cardResolution!.cardId)).toBe(1)

    game.state.turnNumber += 1
    game.state.currentPlayerId = victim.id
    const incomingCard = game.state.cardResolution!.cardId
    const incomingGift = game.state.zones.drawPile[0]!
    moveCard(game.state, incomingGift, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    expect(runtime.interceptTarget!(host as never, owner.id, { sourceId: victim.id, targetId: owner.id,
      cardId: incomingCard, cardName: '无中生有', category: 'trick' })).toBe(true)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(host as never, owner.id, resolution as never, { playerId: owner.id, payload: { targetIds: [recipient.id] } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(host as never, owner.id, resolution as never, { playerId: owner.id, payload: { cardIds: [incomingGift] } } as never)
    expect(recipient.zones.hand).toContain(incomingGift)
    expect(game.state.invalidatedCardUses?.[incomingCard]?.skillId).toBe('qiaodui-mouhuangquan-b84')
  })

  it('星·蒋琬【镇庭】统计本回合受伤角色与弃牌堆新入牌，并将所选两牌给伤害来源', () => {
    const game = gameForBatch84('b84-zhenting')
    const owner = game.state.players[0]!, source = game.state.players[3]!
    const firstVictim = game.state.players[1]!, secondVictim = game.state.players[2]!
    const runtime = getSkillRuntime('zhenting-xingjiangwan-b84')!
    const damage = (targetId: string) => runtime.triggers!.find((trigger) => trigger.event === 'DamageSettled')!.handle(game as never, owner.id,
      { event: { name: 'DamageSettled', sourceId: source.id, targetId,
        payload: { requestedAmount: 1, finalAmount: 1 } } } as never)
    damage(firstVictim.id); damage(secondVictim.id)
    const cards = game.state.zones.drawPile.slice(0, 2)
    for (const cardId of cards) {
      moveCard(game.state, cardId!, { kind: 'drawPile' }, { kind: 'discardPile' })
      runtime.triggers!.find((trigger) => trigger.event === 'CardEnteredDiscardByMove')!.handle(game as never, owner.id,
        { event: { name: 'CardEnteredDiscardByMove', payload: { cardId, fromKind: 'drawPile', reason: 'discard' } } } as never)
    }
    runtime.triggers!.find((trigger) => trigger.event === 'TurnEnd')!.handle(game as never, owner.id,
      { event: { name: 'TurnEnd', payload: { playerId: game.state.currentPlayerId, turnNumber: game.state.turnNumber } } } as never)
    const queued = game.state.skillQueue.find((entry) => entry.skillId === 'zhenting-xingjiangwan-b84')!
    runtime.startQueued!(game as never, owner.id, queued)
    let resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { optionId: 'gain' } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { targetIds: [source.id] } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { cardIds: cards } } as never)
    expect(source.zones.hand).toEqual(expect.arrayContaining(cards))
    expect(cards.every((cardId) => !game.state.zones.discardPile.includes(cardId!))).toBe(true)
  })

  it('星·蒋琬【镇庭】回复所选受伤角色并摸牌', () => {
    const game = gameForBatch84('b84-zhenting-recover')
    const owner = game.state.players[0]!, source = game.state.players[3]!, victim = game.state.players[1]!
    victim.hp = victim.maxHp - 1
    const runtime = getSkillRuntime('zhenting-xingjiangwan-b84')!
    for (const targetId of [victim.id, game.state.players[2]!.id])
      runtime.triggers!.find((trigger) => trigger.event === 'DamageSettled')!.handle(game as never, owner.id,
        { event: { name: 'DamageSettled', sourceId: source.id, targetId,
          payload: { requestedAmount: 1, finalAmount: 1 } } } as never)
    runtime.triggers!.find((trigger) => trigger.event === 'TurnEnd')!.handle(game as never, owner.id,
      { event: { name: 'TurnEnd', payload: { playerId: game.state.currentPlayerId, turnNumber: game.state.turnNumber } } } as never)
    const queued = game.state.skillQueue.find((entry) => entry.skillId === 'zhenting-xingjiangwan-b84')!
    runtime.startQueued!(game as never, owner.id, queued)
    let resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { optionId: 'recover' } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    const before = victim.zones.hand.length
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { targetIds: [victim.id] } } as never)
    expect(victim.hp).toBe(victim.maxHp)
    expect(victim.zones.hand).toHaveLength(before + 1)
  })

  it('陶璜【维卫】交换各一张手牌，结算后可使用收到的牌，回合结束检查交出牌', () => {
    const game = gameForBatch84('b84-weiwei')
    const owner = game.state.players[0]!, source = game.state.players[1]!
    const exchangedOut = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    const exchangedIn = game.state.zones.drawPile.find((id) => id !== exchangedOut)!
    const triggeringCard = game.state.zones.drawPile.find((id) => id !== exchangedOut && id !== exchangedIn)!
    moveCard(game.state, exchangedOut, { kind: 'drawPile' }, { kind: 'hand', playerId: source.id })
    moveCard(game.state, exchangedIn, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.cardResolution = { kind: 'slash', cardId: triggeringCard, sourceId: source.id, targetId: owner.id,
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-intercept', targetAsked: [], requestId: null } as never
    game.resumeCardTarget = () => {}
    const runtime = getSkillRuntime('weiwei-taohuang-b84')!
    expect(runtime.interceptTarget!(game as never, owner.id, { sourceId: source.id, targetId: owner.id,
      cardId: triggeringCard, cardName: '杀', category: 'basic' })).toBe(true)
    let resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { optionId: 'yes' } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { cardIds: [exchangedIn] } } as never)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: source.id, payload: { cardIds: [exchangedOut] } } as never)
    expect(owner.zones.hand).toContain(exchangedOut)
    expect(source.zones.hand).toContain(exchangedIn)

    game.state.cardResolution = null
    runtime.triggers!.find((trigger) => trigger.event === 'CardResolved')!.handle(game as never, owner.id,
      { event: { name: 'CardResolved', sourceId: source.id, payload: { cardId: triggeringCard } } } as never)
    const usePrompt = game.state.skillQueue.find((entry) => entry.skillId === 'weiwei-taohuang-b84')!
    runtime.startQueued!(game as never, owner.id, usePrompt)
    resolution = game.state.skillResolution!
    const useRequest = game.state.pendingRequests.at(-1) as { actionIds: string[] }
    expect(useRequest.actionIds.length).toBeGreaterThan(0)
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never,
      { playerId: owner.id, payload: { actionId: useRequest.actionIds[0] } } as never)
    expect(Object.values(owner.zones.equipment)).toContain(exchangedOut)

    const hp = source.hp
    expect(source.zones.hand).toContain(exchangedIn)
    const weiweiClaim = (game.state as never as { b84: { weiwei: Record<string, { turn: number; claims: Array<{ turn: number; sourceId: string; givenCardId: string }> }> } })
      .b84.weiwei[owner.id].claims[0]
    expect(weiweiClaim?.turn).toBe(game.state.turnNumber)
    expect(weiweiClaim?.sourceId).toBe(source.id)
    expect(weiweiClaim?.givenCardId).toBe(exchangedIn)
    game.state.skillQueue = []
    runtime.triggers!.find((trigger) => trigger.event === 'TurnEnd')!.handle(game as never, owner.id,
      { event: { name: 'TurnEnd', payload: { turnNumber: game.state.turnNumber } } } as never)
    const damagePrompt = game.state.skillQueue.find((entry) => entry.skillId === 'weiwei-taohuang-b84')!
    runtime.startQueued!(game as never, owner.id, damagePrompt)
    resolution = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never, { playerId: owner.id, payload: { optionId: 'yes' } } as never)
    expect(source.hp).toBe(hp - 1)
  })

  it('崔令仪【逾制】的装备闪只对当前这张杀开放一次，伤害分支只加在该杀上', () => {
    const game = gameForBatch84('b84-yuzhi')
    const owner = game.state.players[0]!, source = game.state.players[1]!
    const equipment = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    const slot = game.state.cards[equipment]!.equipmentSlot!
    moveCard(game.state, equipment, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot })
    const huashangCard = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category !== 'equipment')!
    moveCard(game.state, huashangCard, { kind: 'drawPile' },
      { kind: 'characterPile', playerId: owner.id, pile: `huashang-cuilingyi-b84:${owner.id}` })
    const slashCardId = game.state.zones.drawPile[0]!
    game.state.cardResolution = { kind: 'slash', cardId: slashCardId, sourceId: source.id, targetId: owner.id,
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-intercept', targetAsked: [], requestId: null } as never
    const runtime = getSkillRuntime('yuzhi-cuilingyi-b84')!
    expect(runtime.interceptTarget!(game as never, owner.id, { sourceId: source.id, targetId: owner.id,
      cardId: slashCardId, cardName: '杀', category: 'basic' } as never)).toBe(true)
    const fakeHost = { state: game.state, resumeCardTarget() {} }
    runtime.resume!(fakeHost as never, owner.id, { step: 'choose-effect', data: { cardId: slashCardId, sourceId: source.id } } as never,
      { playerId: owner.id, payload: { optionId: 'dodge' } } as never)
    expect(runtime.viewAs!(game.state, owner.id).some((option) => option.cardId === equipment && option.asCardName === '闪')).toBe(true)
    expect(runtime.viewAs!(game.state, owner.id).some((option) => option.cardId === huashangCard && option.asCardName === '闪')).toBe(true)
    runtime.triggers!.find((trigger) => trigger.event === 'CardResponded')!.handle(game as never, owner.id,
      { event: { name: 'CardResponded', sourceId: owner.id, payload: { slashCardId, cardName: '闪' } } } as never)
    expect(runtime.viewAs!(game.state, owner.id)).toHaveLength(0)
    game.state.pendingRequests = []; game.state.skillResolution = null

    const optionIdsForIncomingSlash = (incomingId: string) => {
      game.state.pendingRequests = []; game.state.skillResolution = null
      game.state.cardResolution = { kind: 'slash', cardId: incomingId, sourceId: source.id, targetId: owner.id,
        damageNature: 'normal', damageAmount: 1, stage: 'awaiting-intercept', targetAsked: [], requestId: null } as never
      runtime.interceptTarget!(game as never, owner.id, { sourceId: source.id, targetId: owner.id,
        cardId: incomingId, cardName: '杀', category: 'basic' } as never)
      const options = (game.state.pendingRequests.at(-1) as { options?: Array<{ id: string }> }).options ?? []
      game.state.pendingRequests = []; game.state.skillResolution = null
      return options.map(({ id }) => id)
    }
    const nextSlashId = game.state.zones.drawPile[0]!
    const otherTurn = runtime.triggers!.find((trigger) => trigger.event === 'TurnStart')!
    otherTurn.handle(game as never, owner.id,
      { event: { name: 'TurnStart', payload: { playerId: source.id } } } as never)
    expect(optionIdsForIncomingSlash(nextSlashId)).not.toContain('dodge')
    otherTurn.handle(game as never, owner.id,
      { event: { name: 'TurnStart', payload: { playerId: owner.id } } } as never)
    expect(optionIdsForIncomingSlash(`next:${nextSlashId}`)).toContain('dodge')
  })

  it('马铁【驱险】取得真实【杀】，并按攻击范围为其他角色建立顺序响应', () => {
    const game = gameForBatch84('b84-quxian')
    const owner = game.state.players[0]!, attacker = game.state.players[1]!, target = game.state.players[2]!
    game.state.currentPlayerId = owner.id
    const attackerSlash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, attackerSlash, { kind: 'drawPile' }, { kind: 'hand', playerId: attacker.id })
    const runtime = getSkillRuntime('quxian-matie-b84')!
    runtime.triggers!.find((trigger) => trigger.event === 'TurnStart')!.handle(game as never, owner.id,
      { event: { name: 'TurnStart', payload: { playerId: owner.id } } } as never)
    const activation = game.state.skillResolution!
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(owner.id)
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, activation as never,
      { playerId: owner.id, payload: { optionId: 'yes' } } as never)
    expect(owner.zones.hand.some((id) => game.state.cards[id]?.name === '杀')).toBe(true)
    const targetRequest = game.state.skillResolution!
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, targetRequest as never,
      { playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    const prompt = game.state.skillQueue.find((entry) => entry.skillId === 'quxian-matie-b84')!
    runtime.startQueued!(game as never, owner.id, prompt)
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(attacker.id)
    expect(game.state.pendingRequests.at(-1)?.prompt).toContain('【杀】')
  })

  it('谋·黄权【推诚】排除刚交出的牌，等量收牌后不触发递归', () => {
    const game = gameForBatch84('b84-tuicheng')
    const owner = game.state.players[0]!, recipient = game.state.players[1]!
    const given = game.state.zones.drawPile[0]!, repayment = game.state.zones.drawPile[1]!
    moveCard(game.state, given, { kind: 'drawPile' }, { kind: 'hand', playerId: recipient.id })
    moveCard(game.state, repayment, { kind: 'drawPile' }, { kind: 'hand', playerId: recipient.id })
    const runtime = getSkillRuntime('tuicheng-mouhuangquan-b84')!
    runtime.triggers!.find((trigger) => trigger.event === 'CardGiven')!.handle(game as never, owner.id,
      { event: { name: 'CardGiven', sourceId: owner.id, targetId: recipient.id,
        payload: { fromId: owner.id, toId: recipient.id, cardIds: [given] } } } as never)
    const queued = game.state.skillQueue.find((entry) => entry.skillId === 'tuicheng-mouhuangquan-b84')!
    runtime.startQueued!(game as never, owner.id, queued)
    const resolution = game.state.skillResolution!
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(recipient.id)
    expect((game.state.pendingRequests.at(-1) as { cardIds?: string[] }).cardIds).not.toContain(given)
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never,
      { playerId: recipient.id, payload: { cardIds: [repayment] } } as never)
    expect(owner.zones.hand).toContain(repayment)
    expect(recipient.zones.hand).toContain(given)
    expect(recipient.zones.hand).not.toContain(repayment)
  })
})
