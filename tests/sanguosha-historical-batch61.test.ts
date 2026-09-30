import { describe, expect, it } from 'vitest'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH61_CHARACTERS } from '@/sanguosha/data/characters/historical-batch61'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { drawCards, DrawAttemptInterrupted } from '@/sanguosha/engine/draw'
import { buildPlayerView } from '@/sanguosha/engine/view'
import { moveCard } from '@/sanguosha/engine/zones'

function gameFor(seed: string) {
  const game = new SanguoshaGame({ seed, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  return game
}

describe('武将册续开发第61批', () => {
  it('公共摸牌入口在移动牌前提供可取消的摸牌时机', () => {
    const game = gameFor('b61-draw-attempt-window')
    const owner = game.state.players[0]!
    let attempt: { playerId?: string; count?: number; isDraw?: boolean; attemptIndex?: number } | undefined
    game.events.on('DrawAttempt', (context) => {
      attempt = context.event.payload
      context.cancel()
    })
    const drawPileBefore = [...game.state.zones.drawPile]
    const handBefore = [...owner.zones.hand]
    const rngBefore = game.rng.snapshot()

    expect(() => drawCards(game.state, game.rng, owner.id, 2))
      .toThrow(DrawAttemptInterrupted)

    expect(attempt).toEqual({ playerId: owner.id, count: 2, isDraw: true, attemptIndex: -1 })
    expect(game.state.zones.drawPile).toEqual(drawPileBefore)
    expect(owner.zones.hand).toEqual(handBefore)
    expect(game.rng.snapshot()).toBe(rngBefore)
  })

  it('十名武将按武将册顺序注册，且每个登记技能都有运行时', () => {
    expect(HISTORICAL_BATCH61_CHARACTERS.map(({ name }) => name)).toEqual([
      '芮姬', 'SP·孟获', '郭槐', '邓忠', '张芝', '阿会喃', '屈晃', '孙弘', '王瓘', '郝普',
    ])
    for (const character of HISTORICAL_BATCH61_CHARACTERS) {
      expect(getCharacter(character.id)?.id, `${character.name}未进入正式武将注册表`).toBe(character.id)
      expect(character.skills.length, `${character.name}没有技能`).toBeGreaterThan(0)
      for (const skill of character.skills)
        expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】缺少运行时`).toBeDefined()
    }
  })

  it.each(['draw', 'forbid'] as const)('孙弘的谮润替代锦囊摸牌并续接目标回报：%s', (rewardChoice) => {
    let game = gameFor('b61-sunhong-zanrun')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'sun-hong-b61'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const noYoungCard = Object.values(game.state.cards).find((card) => card.name === '无中生有')!
    moveCard(game.state, noYoungCard.id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const targetCard = game.state.zones.drawPile[0]!
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const equipmentCardId = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.category === 'equipment')!
    const equipmentSlot = game.state.cards[equipmentCardId]!.equipmentSlot!
    moveCard(game.state, equipmentCardId, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot: equipmentSlot })
    const beforeOwnerHand = owner.zones.hand.length
    const beforeTargetHand = target.zones.hand.length

    const noYoungAction = game.legalActions(owner.id).find((action) => action.kind === 'use-card' && action.asCardName === '无中生有')
    expect(noYoungAction).toBeDefined()
    game.act(owner.id, noYoungAction!.id)
    game = SanguoshaGame.restore(game.serialize())
    const invoke = game.state.pendingRequests.at(-1)!
    expect(invoke.kind).toBe('choose-option')
    expect(game.state.drawOperationReplay?.attemptIndex).toBe(0)
    expect(game.state.skillResolution?.requestId).toBe(invoke.id)
    game.respond({ requestId: invoke.id, playerId: owner.id, payload: { optionId: 'yes' } })
    game = SanguoshaGame.restore(game.serialize())

    const chooseTarget = game.state.pendingRequests.at(-1)!
    expect(chooseTarget.kind).toBe('choose-targets')
    game.respond({ requestId: chooseTarget.id, playerId: owner.id, payload: { targetIds: [target.id] } })
    game = SanguoshaGame.restore(game.serialize())

    const take = game.state.pendingRequests.at(-1)!
    expect(take.kind).toBe('choose-cards')
    if (take.kind !== 'choose-cards') throw new Error('谮润未请求等量手牌')
    game.respond({ requestId: take.id, playerId: owner.id, payload: { cardIds: [take.hiddenCardSlots[0]!, equipmentCardId] } })
    game = SanguoshaGame.restore(game.serialize())
    expect(game.state.players.find((player) => player.id === owner.id)?.zones.hand).toHaveLength(beforeOwnerHand + 1)
    expect(game.state.players.find((player) => player.id === target.id)?.zones.hand).toHaveLength(beforeTargetHand - 1)
    expect(game.state.players.find((player) => player.id === target.id)?.zones.equipment[equipmentSlot]).toBeNull()

    const reward = game.state.pendingRequests.at(-1)!
    expect(reward.playerId).toBe(target.id)
    game.respond({ requestId: reward.id, playerId: target.id, payload: { optionId: rewardChoice } })
    expect(game.state.players.find((player) => player.id === target.id)?.zones.hand)
      .toHaveLength(beforeTargetHand + (rewardChoice === 'draw' ? 1 : -1))
    expect(game.state.players.find((player) => player.id === owner.id)?.zones.hand).toHaveLength(beforeOwnerHand + 1)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.drawOperationReplay).toBeUndefined()
    expect(game.state.cardUseHistory?.some((entry) => entry.sourceId === owner.id && entry.cardName === '无中生有')).toBe(true)
    if (rewardChoice === 'forbid')
      expect((game.state as typeof game.state & { b61SunhongForbiddenTargets?: Record<string, string[]> }).b61SunhongForbiddenTargets?.[owner.id]).toContain(target.id)
  })

  it('孙弘拒绝谮润时恢复原摸牌并正常完成同步出牌结算', () => {
    let game = gameFor('b61-sunhong-zanrun-decline')
    const ownerId = game.state.players[0]!.id
    const targetId = game.state.players[1]!.id
    game.state.players[0]!.characterId = 'sun-hong-b61'
    game.state.currentPlayerId = ownerId
    game.state.phase = 'play'
    const noYoungCard = Object.values(game.state.cards).find((card) => card.name === '无中生有')!
    moveCard(game.state, noYoungCard.id, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    for (const cardId of game.state.zones.drawPile.slice(0, 2))
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
    const ownerHandBefore = game.state.players[0]!.zones.hand.length
    const drawPileBefore = game.state.zones.drawPile.length
    const action = game.legalActions(ownerId).find((candidate) => candidate.kind === 'use-card' && candidate.asCardName === '无中生有')!

    game.act(ownerId, action.id)
    const invoke = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: invoke.id, playerId: ownerId, payload: { optionId: 'no' } })

    expect(game.state.players.find((player) => player.id === ownerId)?.zones.hand).toHaveLength(ownerHandBefore + 1)
    expect(game.state.zones.drawPile).toHaveLength(drawPileBefore - 2)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.drawOperationReplay).toBeUndefined()
  })

  it('孙弘的谮润覆盖真实摸牌阶段入口而不是依赖DrawPhase接管', () => {
    const game = gameFor('b61-sunhong-zanrun-draw-phase')
    const ownerId = game.state.players[0]!.id
    const targetId = game.state.players[1]!.id
    game.state.players[0]!.characterId = 'sun-hong-b61'
    game.state.currentPlayerId = ownerId
    game.state.phase = 'judge'
    for (const cardId of game.state.zones.drawPile.slice(0, 2))
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })

    game.advancePhase()
    expect(game.state.phase).toBe('draw')
    expect(game.state.pendingRequests.at(-1)?.kind).toBe('choose-option')
    expect(game.state.drawOperationReplay?.operation.kind).toBe('advance-phase')
    const invoke = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: invoke.id, playerId: ownerId, payload: { optionId: 'no' } })
    expect(game.state.players.find((player) => player.id === ownerId)?.zones.hand).toHaveLength(2)
    expect(game.state.drawOperationReplay).toBeUndefined()
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('孙弘的谮润可在伤害触发的同步摸牌中挂起并恢复伤害结算', () => {
    const game = gameFor('b61-sunhong-zanrun-damage-root')
    const ownerId = game.state.players[0]!.id
    const sourceId = game.state.players[1]!.id
    game.state.players[0]!.characterId = 'sun-hong-b61'
    const sourceCard = game.state.zones.drawPile[0]!
    moveCard(game.state, sourceCard, { kind: 'drawPile' }, { kind: 'hand', playerId: sourceId })
    game.events.on('Damaged', () => { drawCards(game.state, game.rng, ownerId, 1) })
    const hpBefore = game.state.players[0]!.hp

    game.damage({ sourceId, targetId: ownerId, amount: 1 })
    const invoke = game.state.pendingRequests.at(-1)!
    expect(game.state.drawOperationReplay?.operation.kind).toBe('damage')
    game.respond({ requestId: invoke.id, playerId: ownerId, payload: { optionId: 'no' } })

    expect(game.state.players.find((player) => player.id === ownerId)?.hp).toBe(hpBefore - 1)
    expect(game.state.players.find((player) => player.id === ownerId)?.zones.hand).toHaveLength(1)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.drawOperationReplay).toBeUndefined()
  })

  it('孙弘的谮润拦截另一技能续接中发生的摸牌，并可在恢复存档后完成', () => {
    let game = gameFor('b61-sunhong-zanrun-response-root')
    const ownerId = game.state.players[0]!.id
    const targetId = game.state.players[1]!.id
    game.state.players[0]!.characterId = 'sun-hong-b61'
    game.state.currentPlayerId = ownerId
    game.state.phase = 'play'
    const equipment = game.state.zones.drawPile
      .filter((cardId) => game.state.cards[cardId]?.category === 'equipment')
      .filter((cardId, index, ids) => ids.findIndex((otherId) => game.state.cards[otherId]?.equipmentSlot === game.state.cards[cardId]?.equipmentSlot) === index)
      .slice(0, 2)
    for (const cardId of equipment) {
      const slot = game.state.cards[cardId]!.equipmentSlot!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'equipment', playerId: targetId, slot })
    }
    const xianbi = HISTORICAL_BATCH61_CHARACTERS.find(({ name }) => name === '孙弘')!.skills.find(({ name }) => name === '险诐')!
    getSkillRuntime(xianbi.id)!.invokeActive!(game as never, ownerId, xianbi.id)
    const chooseTarget = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: chooseTarget.id, playerId: ownerId, payload: { targetIds: [targetId] } })
    expect(game.state.drawOperationReplay?.operation.kind).toBe('respond')
    game = SanguoshaGame.restore(game.serialize())

    const invoke = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: invoke.id, playerId: ownerId, payload: { optionId: 'yes' } })
    const takeTarget = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: takeTarget.id, playerId: ownerId, payload: { targetIds: [targetId] } })
    const take = game.state.pendingRequests.at(-1)!
    if (take.kind !== 'choose-cards') throw new Error('谮润未请求装备牌')
    game.respond({ requestId: take.id, playerId: ownerId, payload: { cardIds: equipment } })
    const reward = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: reward.id, playerId: targetId, payload: { optionId: 'forbid' } })

    expect(game.state.players.find((player) => player.id === ownerId)?.zones.hand).toHaveLength(2)
    expect(Object.values(game.state.players.find((player) => player.id === targetId)!.zones.equipment).every((cardId) => cardId === null)).toBe(true)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.drawOperationReplay).toBeUndefined()
  })

  it('郝普镇荧双方调整后手牌相同，不臆造未写明的决斗使用者', () => {
    const game = gameFor('b61-haopu-tie')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'hao-pu-b61'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    for (const [index, cardId] of game.state.zones.drawPile.slice(0, 6).entries()) {
      const recipient = index < 3 ? owner : target
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: recipient.id })
    }
    const zhenying = HISTORICAL_BATCH61_CHARACTERS.find(({ name }) => name === '郝普')!.skills[0]!.id
    const runtime = getSkillRuntime(zhenying)!
    runtime.invokeActive!(game as never, owner.id, `${zhenying}:0`)
    const chooseTarget = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: chooseTarget.id, playerId: owner.id, payload: { targetIds: [target.id] } })
    const simultaneous = game.state.pendingRequests.filter((request) => request.kind === 'choose-cards')
    expect(simultaneous).toHaveLength(2)
    for (const request of simultaneous) {
      if (request.kind !== 'choose-cards') continue
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: request.cardIds.slice(0, 1) } })
    }
    expect(owner.zones.hand).toHaveLength(2)
    expect(target.zones.hand).toHaveLength(2)
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('张芝笔心每次类型声明只计一次发动，并强制处理仍可使用的同类手牌', () => {
    const game = gameFor('b61-zhangzhi-bixin')
    const owner = game.state.players[0]!
    const other = game.state.players[1]!
    owner.characterId = 'zhang-zhi-b61'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const basicIds = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.category === 'basic')
    const basicSet = new Set(basicIds.slice(0, 3))
    game.state.zones.drawPile = [...basicSet, ...game.state.zones.drawPile.filter((id) => !basicSet.has(id))]

    game.dispatch('PhaseStart', { playerId: other.id, phase: 'prepare' }, { sourceId: other.id, phase: 'prepare' })
    const chooseType = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: chooseType.id, playerId: owner.id, payload: { optionId: 'basic' } })
    const bixinState = game.state as typeof game.state & { b61ZhangzhiBixinActivations?: Record<string, number> }
    expect(bixinState.b61ZhangzhiBixinActivations?.[owner.id]).toBe(1)
    const chooseCard = game.state.pendingRequests.at(-1)!
    expect(chooseCard.kind).toBe('choose-cards')
    if (chooseCard.kind !== 'choose-cards') throw new Error('笔心未进入同类手牌使用流程')
    expect(chooseCard.optional).toBe(false)
    expect(chooseCard.min).toBe(1)
  })

  it('张芝洗墨逐次收窄阶段触发范围，第三次之后不再由阶段触发笔心', () => {
    for (const [activations, phase, shouldTrigger] of [
      [0, 'prepare', true], [0, 'finish', true],
      [1, 'prepare', true], [1, 'finish', true],
      [2, 'prepare', false], [2, 'finish', true],
      [3, 'prepare', false], [3, 'finish', false],
    ] as const) {
      const game = gameFor(`b61-zhangzhi-ximo-stage-${activations}-${phase}`)
      const owner = game.state.players[0]!
      owner.characterId = 'zhang-zhi-b61'
      ;(game.state as typeof game.state & { b61ZhangzhiBixinActivations?: Record<string, number> })
        .b61ZhangzhiBixinActivations = { [owner.id]: activations }
      const playerId = activations === 0 ? game.state.players[1]!.id : owner.id
      game.dispatch('PhaseStart', { playerId, phase }, { sourceId: playerId, phase })
      expect(game.state.pendingRequests.length > 0).toBe(shouldTrigger)
    }
  })

  it('张芝洗墨逐次修改可序列化笔心规则文本，第三次交换摸牌量与类别次数', () => {
    const game = gameFor('b61-zhangzhi-ximo-text')
    const owner = game.state.players[0]!
    owner.characterId = 'zhang-zhi-b61'
    const state = game.state as typeof game.state & { b61ZhangzhiBixinDescription?: Record<string, string> }
    const skillId = 'bixin-zhangzhi:b61'
    const descriptions = [
      '准备阶段和结束阶段，你可以声明一种牌的类型并摸3张牌（每种类型限1次），将所有此类型手牌当你本轮未使用过的基本牌使用。',
      '结束阶段，你可以声明一种牌的类型并摸3张牌（每种类型限1次），将所有此类型手牌当你本轮未使用过的基本牌使用。',
      '你可以声明一种牌的类型并摸1张牌（每种类型限3次），将所有此类型手牌当你本轮未使用过的基本牌使用。',
    ]
    for (const expected of descriptions) {
      game.dispatch('SkillActivated', { skillId }, { sourceId: owner.id })
      expect(state.b61ZhangzhiBixinDescription?.[owner.id]).toBe(expected)
      const skill = buildPlayerView(game.state, owner.id).players
        .find((player) => player.id === owner.id)?.skills.find((entry) => entry.id === skillId)
      expect(skill?.description).toBe(expected)
    }
  })

  it('张芝第三形态可在杀的求闪中选类别摸牌并用对应手牌响应，失去资格时按未响应续结算', () => {
    const game = gameFor('b61-zhangzhi-ximo-response')
    const owner = game.state.players[0]!
    const attacker = game.state.players[1]!
    owner.characterId = 'zhang-zhi-b61'
    for (let index = 0; index < 3; index += 1)
      game.dispatch('SkillActivated', { skillId: 'bixin-zhangzhi:b61' }, { sourceId: owner.id })
    const material = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.category === 'basic')!
    moveCard(game.state, material, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })

    expect(game.beginVirtualSlash({ sourceId: attacker.id, targetId: owner.id, sourceSkillId: 'b61-response-test' })).toBe(true)
    const response = game.state.pendingRequests.at(-1)!
    expect(response.kind).toBe('respond-card')
    if (response.kind !== 'respond-card') throw new Error('杀未进入求闪请求')
    expect(response.actionIds).toContain('virtual-basic:bixin-zhangzhi:b61:闪')
    game.respond({ requestId: response.id, playerId: owner.id, payload: { actionId: 'virtual-basic:bixin-zhangzhi:b61:闪' } })

    const chooseType = game.state.pendingRequests.at(-1)!
    expect(chooseType.kind).toBe('choose-option')
    if (chooseType.kind !== 'choose-option') throw new Error('笔心未询问牌类别')
    game.respond({ requestId: chooseType.id, playerId: owner.id, payload: { optionId: 'basic' } })
    const chooseCard = game.state.pendingRequests.at(-1)!
    expect(chooseCard.kind).toBe('choose-cards')
    if (chooseCard.kind !== 'choose-cards') throw new Error('笔心未请求类别手牌')
    expect(chooseCard.cardIds).toContain(material)
    game.respond({ requestId: chooseCard.id, playerId: owner.id, payload: { cardIds: [material] } })

    expect(owner.zones.hand).not.toContain(material)
    expect(game.state.zones.discardPile).toContain(material)
    expect(owner.hp).toBe(owner.maxHp)
    expect(game.state.cardResolution).toBeNull()
  })

  it('张芝第三形态的实体牌响应能续接决斗并轮到下一名响应者', () => {
    const game = gameFor('b61-zhangzhi-ximo-duel-response')
    const owner = game.state.players[0]!
    const attacker = game.state.players[1]!
    owner.characterId = 'zhang-zhi-b61'
    for (let index = 0; index < 3; index += 1)
      game.dispatch('SkillActivated', { skillId: 'bixin-zhangzhi:b61' }, { sourceId: owner.id })
    const material = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.category === 'basic')!
    moveCard(game.state, material, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })

    expect(game.beginVirtualTrick({ sourceId: attacker.id, targetId: owner.id, cardName: '决斗', sourceSkillId: 'b61-duel-test' })).toBe(true)
    const response = game.state.pendingRequests.at(-1)!
    expect(response.kind).toBe('respond-card')
    if (response.kind !== 'respond-card') throw new Error('决斗未进入求杀请求')
    expect(response.requiredCardName).toBe('杀')
    expect(response.actionIds).toContain('virtual-basic:bixin-zhangzhi:b61:杀')
    game.respond({ requestId: response.id, playerId: owner.id, payload: { actionId: 'virtual-basic:bixin-zhangzhi:b61:杀' } })
    const chooseType = game.state.pendingRequests.at(-1)!
    if (chooseType.kind !== 'choose-option') throw new Error('笔心未询问牌类别')
    game.respond({ requestId: chooseType.id, playerId: owner.id, payload: { optionId: 'basic' } })
    const chooseCard = game.state.pendingRequests.at(-1)!
    if (chooseCard.kind !== 'choose-cards') throw new Error('笔心未请求类别手牌')
    game.respond({ requestId: chooseCard.id, playerId: owner.id, payload: { cardIds: [material] } })

    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(attacker.id)
    expect(game.state.pendingRequests.at(-1)?.kind).toBe('respond-card')
    expect(game.state.zones.discardPile).toContain(material)
  })

  it('张芝第三形态摸牌后没有声明类别手牌时恢复原求闪并承受伤害', () => {
    const game = gameFor('b61-zhangzhi-ximo-response-pass')
    const owner = game.state.players[0]!
    const attacker = game.state.players[1]!
    owner.characterId = 'zhang-zhi-b61'
    for (let index = 0; index < 3; index += 1)
      game.dispatch('SkillActivated', { skillId: 'bixin-zhangzhi:b61' }, { sourceId: owner.id })
    const basicTop = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.category === 'basic')!
    game.state.zones.drawPile = [basicTop, ...game.state.zones.drawPile.filter((cardId) => cardId !== basicTop)]
    const hpBefore = owner.hp

    expect(game.beginVirtualSlash({ sourceId: attacker.id, targetId: owner.id, sourceSkillId: 'b61-pass-test' })).toBe(true)
    const response = game.state.pendingRequests.at(-1)!
    if (response.kind !== 'respond-card') throw new Error('杀未进入求闪请求')
    game.respond({ requestId: response.id, playerId: owner.id, payload: { actionId: 'virtual-basic:bixin-zhangzhi:b61:闪' } })
    const chooseType = game.state.pendingRequests.at(-1)!
    if (chooseType.kind !== 'choose-option') throw new Error('笔心未询问牌类别')
    game.respond({ requestId: chooseType.id, playerId: owner.id, payload: { optionId: 'equipment' } })

    expect(owner.hp).toBe(hpBefore - 1)
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('张芝第三形态可在濒死救援中以所选类别手牌当桃并继续濒死流程', () => {
    const game = gameFor('b61-zhangzhi-ximo-rescue')
    const owner = game.state.players[0]!
    owner.characterId = 'zhang-zhi-b61'
    for (let index = 0; index < 3; index += 1)
      game.dispatch('SkillActivated', { skillId: 'bixin-zhangzhi:b61' }, { sourceId: owner.id })
    const material = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.category === 'trick')!
    moveCard(game.state, material, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    owner.hp = 0
    game.enterDying(owner.id)

    const rescue = game.state.pendingRequests.at(-1)!
    expect(rescue.kind).toBe('rescue')
    if (rescue.kind !== 'rescue') throw new Error('未进入濒死救援请求')
    expect(rescue.actionIds).toContain('rescue:bixin-zhangzhi:b61:桃')
    game.respond({ requestId: rescue.id, playerId: owner.id, payload: { actionId: 'rescue:bixin-zhangzhi:b61:桃' } })
    const chooseType = game.state.pendingRequests.at(-1)!
    if (chooseType.kind !== 'choose-option') throw new Error('笔心未询问救援牌类别')
    game.respond({ requestId: chooseType.id, playerId: owner.id, payload: { optionId: 'trick' } })
    const chooseCard = game.state.pendingRequests.at(-1)!
    if (chooseCard.kind !== 'choose-cards') throw new Error('笔心未请求锦囊手牌')
    expect(chooseCard.cardIds).toContain(material)
    game.respond({ requestId: chooseCard.id, playerId: owner.id, payload: { cardIds: [material] } })

    expect(owner.hp).toBe(1)
    expect(game.state.dying).toBeNull()
    expect(game.state.zones.discardPile).toContain(material)
  })

  it('张芝第三形态在出牌阶段从声明类别摸一张并以实体牌使用合法基本牌', () => {
    const game = gameFor('b61-zhangzhi-ximo-play-use')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'zhang-zhi-b61'
    for (let index = 0; index < 3; index += 1)
      game.dispatch('SkillActivated', { skillId: 'bixin-zhangzhi:b61' }, { sourceId: owner.id })
    const material = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.category === 'trick')!
    moveCard(game.state, material, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('bixin-zhangzhi:b61')!
    const action = runtime.activeActions!(game.state, owner.id).find((entry) => entry.id === 'bixin-zhangzhi:b61:need-basic')
    expect(action).toBeDefined()
    runtime.invokeActive!(game as never, owner.id, action!.id)

    const chooseType = game.state.pendingRequests.at(-1)!
    if (chooseType.kind !== 'choose-option') throw new Error('笔心未询问牌类别')
    game.respond({ requestId: chooseType.id, playerId: owner.id, payload: { optionId: 'trick' } })
    const chooseCard = game.state.pendingRequests.at(-1)!
    if (chooseCard.kind !== 'choose-cards') throw new Error('笔心未请求类别手牌')
    expect(chooseCard.cardIds).toContain(material)
    game.respond({ requestId: chooseCard.id, playerId: owner.id, payload: { cardIds: [material] } })
    const chooseName = game.state.pendingRequests.at(-1)!
    if (chooseName.kind !== 'choose-option') throw new Error('笔心未询问转化基本牌')
    expect(chooseName.options.some((option) => option.id === '杀')).toBe(true)
    game.respond({ requestId: chooseName.id, playerId: owner.id, payload: { optionId: '杀' } })
    const chooseTarget = game.state.pendingRequests.at(-1)!
    if (chooseTarget.kind !== 'choose-option') throw new Error('笔心未询问合法目标')
    const slashAction = chooseTarget.options[0]
    expect(slashAction).toBeDefined()
    game.respond({ requestId: chooseTarget.id, playerId: owner.id, payload: { optionId: slashAction!.id } })

    expect(game.state.cardResolution?.kind).toBe('slash')
    expect(game.state.cardResolution?.kind === 'slash' ? game.state.cardResolution.targetId : null).toBe(target.id)
    expect(game.state.zones.processingArea).toContain(material)
  })

  it('王瓘失路直接使用目标展示的实体手牌，不先制造一次获得牌', () => {
    const game = gameFor('b61-wangguan-shilu')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const cardId = game.state.zones.drawPile[0]!
    game.state.status = 'playing'
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const ownerHandBefore = owner.zones.hand.length

    expect(game.beginSkillSlashFromOtherHand({
      sourceId: owner.id, physicalOwnerId: target.id, cardId, targetId: target.id, sourceSkillId: 'shilu-wangguan:b61',
    })).toBe(true)
    expect(owner.zones.hand).toHaveLength(ownerHandBefore)
    expect(target.zones.hand).not.toContain(cardId)
    expect(game.state.zones.processingArea).toContain(cardId)
    expect(game.state.cardResolution?.cardId).toBe(cardId)
  })
})
