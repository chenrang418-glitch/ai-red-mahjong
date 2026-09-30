import { describe, expect, it, vi } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { executeUseCardAction, withNextCardTargetChoices } from '@/sanguosha/engine/cards/basic'
import { instantTrickActions } from '@/sanguosha/engine/cards/tricks'
import { createVirtualTrick } from '@/sanguosha/engine/virtual-trick'
import type { CardId } from '@/sanguosha/engine/types'

const HISTORICAL_BATCH51_CHARACTERS = ALL_CHARACTERS.filter(({ id }) => id.endsWith('-b51'))

function gameFixture(playerCount = 5) {
  const game = new SanguoshaGame({ seed: 'historical-batch51-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: playerCount }, (_, index) => ({ id: `b51p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  return { game, owner: game.state.players[0], target: game.state.players[1] }
}

describe('第51批技能运行时进度检查', () => {
  it('公共手牌离手观察器覆盖普通区域移动并派发可续接事件', () => {
    const { game, owner } = gameFixture()
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const dispatch = vi.spyOn(game, 'dispatch')
    moveCard(game.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    expect(dispatch).toHaveBeenCalledWith('HandCardLeft', expect.objectContaining({ cardId, playerId: owner.id }))
  })

  it('寅谋用的手牌流失账本只计离开原手牌区的实体牌并按回合重置', () => {
    const { game, owner, target } = gameFixture()
    const [first, second, third] = game.state.zones.drawPile
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(third).toBeDefined()
    moveCard(game.state, first!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, second!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, third!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, first!, { kind: 'hand', playerId: owner.id }, { kind: 'hand', playerId: owner.id })
    expect(game.state.handCardLossThisTurn?.counts[owner.id] ?? 0).toBe(0)
    moveCard(game.state, first!, { kind: 'hand', playerId: owner.id }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, second!, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    expect(game.state.handCardLossThisTurn?.counts[owner.id]).toBe(2)
    game.state.turnNumber += 1
    const nextCard = owner.zones.hand[0]!
    moveCard(game.state, nextCard, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    expect(game.state.handCardLossThisTurn).toEqual({ turnNumber: game.state.turnNumber, counts: { [owner.id]: 1 } })
  })

  it('虚拟基本牌离开临时手牌载体时不伪增寅谋的失牌数或实体离手事件', () => {
    const { game, owner } = gameFixture()
    const cardId = game.state.zones.drawPile[0]!
    game.state.cards[cardId]!.virtual = true
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const dispatch = vi.spyOn(game, 'dispatch')
    moveCard(game.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'processingArea' })
    expect(game.state.handCardLossThisTurn?.counts[owner.id] ?? 0).toBe(0)
    expect(dispatch).not.toHaveBeenCalledWith('HandCardLeft', expect.anything())
  })

  it('批次清单保持10名且武将/技能 ID 无重复', () => {
    expect(HISTORICAL_BATCH51_CHARACTERS).toHaveLength(10)
    const characterIds = HISTORICAL_BATCH51_CHARACTERS.map(({ id }) => id)
    const skillIds = HISTORICAL_BATCH51_CHARACTERS.flatMap(({ skills }) => skills.map(({ id }) => id))
    expect(new Set(characterIds).size).toBe(characterIds.length)
    expect(new Set(ALL_CHARACTERS.map(({ id }) => id)).size).toBe(ALL_CHARACTERS.length)
    expect(new Set(skillIds).size).toBe(skillIds.length)
  })

  it('目前已有具体运行时的技能保持可查询，解围响应挂在解围而非据守下', () => {
    const runtimeSkills = HISTORICAL_BATCH51_CHARACTERS.flatMap(({ skills }) => skills)
      .filter(({ name }) => ['洛神', '倾国', '英姿', '据守', '解围', '闭月'].includes(name))
    for (const { id } of runtimeSkills) expect(getSkillRuntime(id)).toBeDefined()

    for (const { skills } of HISTORICAL_BATCH51_CHARACTERS) {
      for (const { id, name } of skills) expect(getSkillRuntime(id), `${name} (${id})`).toBeDefined()
    }

    const caoren = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·曹仁')!
    const jushou = getSkillRuntime(caoren.skills.find(({ name }) => name === '据守')!.id)!
    const jiewei = getSkillRuntime(caoren.skills.find(({ name }) => name === '解围')!.id)!
    expect(jushou.resume).toBeTypeOf('function')
    expect(jiewei.resume).toBeTypeOf('function')
  })

  it('谋周瑜反间猜错时仍转移扣置牌并令目标失去1点体力', () => {
    const { game, owner, target } = gameFixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·周瑜')!
      .skills.find(({ name }) => name === '反间')!.id)!
    const cardId = game.state.zones.drawPile[0] as CardId
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const actualSuit = game.state.cards[cardId].suit
    const declared = actualSuit === 'spade' ? 'heart' : 'spade'
    const initialHp = target.hp
    const state = game.state as typeof game.state & { b51Fanjian?: Record<string, { turn: number; usedSuits: string[]; disabled: boolean }> }
    state.b51Fanjian = { [owner.id]: { turn: game.state.turnNumber, usedSuits: [actualSuit], disabled: false } }

    runtime.resume!(game, owner.id, { step: 'target-choice', data: { cardId, targetId: target.id, declared } } as never,
      { payload: { optionId: 'match' } } as never)

    expect(owner.zones.hand).not.toContain(cardId)
    expect(target.zones.hand).toContain(cardId)
    expect(target.hp).toBe(initialHp - 1)
    expect(state.b51Fanjian?.[owner.id].disabled).toBe(false)
  })

  it('谋周瑜反间猜中后不失去体力并在本回合禁用技能', () => {
    const { game, owner, target } = gameFixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·周瑜')!
      .skills.find(({ name }) => name === '反间')!.id)!
    const cardId = game.state.zones.drawPile[0] as CardId
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const actualSuit = game.state.cards[cardId].suit
    const initialHp = target.hp
    const state = game.state as typeof game.state & { b51Fanjian?: Record<string, { turn: number; usedSuits: string[]; disabled: boolean }> }
    state.b51Fanjian = { [owner.id]: { turn: game.state.turnNumber, usedSuits: [actualSuit], disabled: false } }

    runtime.resume!(game, owner.id, { step: 'target-choice', data: { cardId, targetId: target.id, declared: actualSuit } } as never,
      { payload: { optionId: 'match' } } as never)

    expect(target.hp).toBe(initialHp)
    expect(state.b51Fanjian?.[owner.id].disabled).toBe(true)
  })

  it('谋周瑜英姿按三项条件逐项加摸牌和本回合手牌上限', () => {
    const { game, owner } = gameFixture()
    owner.characterId = 'mou-zhouyu-b51'
    owner.grantedSkills = [HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·周瑜')!
      .skills.find(({ name }) => name === '英姿')!.id]
    owner.hp = 2
    owner.zones.hand.push(...game.state.zones.drawPile.splice(0, 2))
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·周瑜')!
      .skills.find(({ name }) => name === '英姿')!
    const runtime = getSkillRuntime(skill.id)!
    const event = game.dispatch('DrawPhase', { playerId: owner.id, count: 2 })
    expect(event.event.payload).toMatchObject({ count: 4 })
    expect(runtime.maxCardsBonus?.(game.state, owner.id)).toBe(2)
  })

  it('谋甄姬洛神按牌色分流黑牌与红牌，并使获得的黑牌本回合不计手牌上限', () => {
    const { game, owner, target } = gameFixture()
    owner.characterId = 'mou-zhenji-b51'
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·甄姬')!
      .skills.find(({ name }) => name === '洛神')!
    const runtime = getSkillRuntime(skill.id)!
    const blackId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.color === 'black')!
    const redId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.color === 'red')!
    const second = game.state.players[2]!
    game.state.cards[blackId]!.suit = 'spade'
    game.state.cards[blackId]!.color = 'black'
    game.state.cards[redId]!.suit = 'heart'
    game.state.cards[redId]!.color = 'red'
    moveCard(game.state, blackId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, redId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, redId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: second.id })
    ;(game.state as typeof game.state & { b51Luoshen?: Record<string, { order: string[]; index: number; exemptCardIds: string[] }> }).b51Luoshen = {
      [owner.id]: { order: [target.id, second.id], index: 0, exemptCardIds: [] },
    }
    ;(game.state as typeof game.state & { b51LuoshenExempt?: Record<string, { turn: number; cardIds: string[] }> }).b51LuoshenExempt = {
      [owner.id]: { turn: game.state.turnNumber, cardIds: [] },
    }
    runtime.resume!(game, owner.id, { step: 'show-hand', data: { targetId: target.id } } as never,
      { payload: { cardIds: [blackId] } } as never)
    expect(owner.zones.hand).toContain(blackId)
    expect(runtime.handLimitExempt?.(game.state, owner.id, blackId)).toBe(true)
    runtime.resume!(game, owner.id, { step: 'show-hand', data: { targetId: second.id } } as never,
      { payload: { cardIds: [redId] } } as never)
    expect(game.state.zones.discardPile).toContain(redId)
    expect(target.zones.hand).not.toContain(redId)
  })

  it('谋甄姬倾国将黑色手牌当闪打出并完成杀的响应', () => {
    const { game, owner, target } = gameFixture()
    game.state.status = 'playing'
    owner.characterId = 'mou-zhenji-b51'
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·甄姬')!
      .skills.find(({ name }) => name === '倾国')!
    owner.grantedSkills = [skill.id]
    const blackCard = game.state.zones.drawPile.find((id) => game.state.cards[id]?.color === 'black')!
    moveCard(game.state, blackCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.beginVirtualSlash({ sourceId: target.id, targetId: owner.id, sourceSkillId: 'batch51-qingguo-test' })
    const request = game.state.pendingRequests.find((entry) => entry.kind === 'respond-card' && entry.playerId === owner.id)!
    expect(request.actionIds).toContain(`respond-dodge:${blackCard}`)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { actionId: `respond-dodge:${blackCard}` } })
    expect(owner.zones.hand).not.toContain(blackCard)
    expect(owner.hp).toBe(4)
  })

  it('谋曹操清正完成弃牌、指定目标花色、牌差伤害及治世增益流程', () => {
    const { game, owner, target } = gameFixture()
    game.state.status = 'playing'
    owner.characterId = 'mou-caocao-b51'
    owner.grantedSkills = [HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·曹操')!
      .skills.find(({ name }) => name === '清正')!.id]
    const picked = new Map<string, string>()
    for (const cardId of game.state.zones.drawPile) {
      const suit = game.state.cards[cardId]?.suit
      if (suit && !picked.has(suit)) picked.set(suit, cardId)
      if (picked.size === 3) break
    }
    expect(picked.size).toBe(3)
    for (const cardId of picked.values()) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const targetCard = game.state.zones.drawPile[0]!
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·曹操')!
      .skills.find(({ name }) => name === '清正')!
    const runtime = getSkillRuntime(skill.id)!
    const phaseStart = game.dispatch('PhaseStart', { playerId: owner.id, phase: 'play' })
    runtime.triggers?.[0].handle(game, owner.id, phaseStart)
    runtime.startQueued!(game, owner.id, game.state.skillQueue.at(-1)!)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'offer', data: {} } as never, { payload: { optionId: 'yes' } } as never)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-target', data: {} } as never,
      { payload: { targetIds: [target.id] } } as never)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-suits', data: { targetId: target.id, required: 3 } } as never,
      { payload: { optionIds: [...picked.keys()] } } as never)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    const targetHp = target.hp
    runtime.resume!(game, owner.id, { step: 'choose-discard-suit', data: { targetId: target.id } } as never,
      { payload: { suit: game.state.cards[targetCard]!.suit } } as never)
    expect(target.hp).toBe(targetHp - 1)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'gain-mark', data: {} } as never,
      { payload: { optionId: 'gain' } } as never)
    expect(owner.marks.mouCaoCaoZhishi).toBe(1)
  })

  it('谋曹操护驾转移伤害至魏势力角色并在其存活时令其摸牌', () => {
    const { game, owner } = gameFixture()
    const weiTarget = game.state.players[2]!
    game.state.status = 'playing'
    owner.characterId = 'mou-caocao-b51'
    owner.identity = 'lord'
    owner.grantedSkills = [HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·曹操')!
      .skills.find(({ name }) => name === '护驾')!.id]
    weiTarget.characterId = 'caocao'
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·曹操')!
      .skills.find(({ name }) => name === '护驾')!
    const runtime = getSkillRuntime(skill.id)!
    const data = { sourceId: game.state.players[3]!.id, amount: 1, nature: 'normal' as const,
      cardId: null, cardName: null, chainTransfer: false }
    runtime.resume!(game, owner.id, { step: 'offer-redirection', data } as never,
      { payload: { optionId: 'redirect' } } as never)
    const beforeHand = weiTarget.zones.hand.length
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-recipient', data } as never,
      { payload: { targetIds: [weiTarget.id] } } as never)
    expect(weiTarget.hp).toBe(3)
    expect(weiTarget.zones.hand.length).toBe(beforeHand + 1)
    expect(owner.hp).toBe(4)
  })

  it('界朱治安国只把标记者手牌上限补至体力上限，并按来源标记防止致命伤害', () => {
    const { game, owner, target } = gameFixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '界·朱治')!.skills[0].id)!
    target.marks.anGuo = 1
    const state = game.state as typeof game.state & {
      b51AnGuo?: Record<string, { targetId: string | null; everMarkedIds: string[] }>
    }
    state.b51AnGuo = { [owner.id]: { targetId: target.id, everMarkedIds: [target.id] } }
    expect(runtime.globalMaxCardsBonus?.(game.state, owner.id, target.id)).toBe(target.maxHp - target.hp)
    const damage = { sourceId: game.state.players[2].id, targetId: owner.id, amount: owner.hp,
      nature: 'normal' as const, cardId: null, cardName: '杀', chainTransfer: false }
    expect(runtime.preventsDamage?.(game.state, owner.id, 'target', damage)).toBe(true)
    game.state.players[2].marks.anGuo = 1
    expect(runtime.preventsDamage?.(game.state, owner.id, 'target', { ...damage, sourceId: game.state.players[2].id })).toBe(false)
  })

  it('谋貂蝉离间按逆时针最近座次发起首个虚拟决斗，代价按目标数减一', () => {
    const { game, owner } = gameFixture()
    game.state.status = 'playing'
    const diaochan = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·貂蝉')!
    const runtime = getSkillRuntime(diaochan.skills.find(({ name }) => name === '离间')!.id)!
    const first = game.state.players[1]
    const second = game.state.players[2]
    const costCard = game.state.zones.drawPile[0] as CardId
    moveCard(game.state, costCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })

    runtime.resume!(game, owner.id, { step: 'choose-duel-targets', data: {} } as never,
      { payload: { targetIds: [first.id, second.id] } } as never)
    const costRequest = game.state.pendingRequests.find((request) => request.kind === 'choose-cards')
    expect(costRequest?.kind === 'choose-cards' ? costRequest.min : undefined).toBe(1)
    runtime.resume!(game, owner.id, { step: 'discard-cost', data: { targetIds: [first.id, second.id] } } as never,
      { payload: { cardIds: [costCard] } } as never)
    runtime.startQueued!(game, owner.id, { step: 'next-duel', data: {} } as never)

    expect(game.state.cardResolution?.kind).toBe('trick')
    expect(game.state.cardResolution?.sourceId).toBe(first.id)
    expect(game.state.cardResolution?.targetIds).toEqual([second.id])
    expect(game.state.zones.discardPile).toContain(costCard)

    game.state.cardResolution = null
    owner.alive = false
    runtime.triggers?.find(({ event }) => event === 'AfterCardUse')?.handle(game, owner.id,
      { event: { payload: { sourceSkillId: diaochan.skills.find(({ name }) => name === '离间')!.id } } } as never)
    expect(game.state.skillQueue.at(-1)?.allowDeadOwner).toBe(true)
    runtime.startQueued!(game, owner.id, { step: 'next-duel', data: {} } as never)
    expect(game.state.cardResolution?.sourceId).toBe(second.id)
    expect(game.state.cardResolution?.targetIds).toEqual([first.id])
  })

  it('界朱治安国濒死救援恢复至1点并按选项支付体力代价与授予护甲', () => {
    const { game, owner, target } = gameFixture()
    game.state.status = 'playing'
    target.hp = 0
    target.marks.anGuo = 1
    game.state.dying = { playerId: target.id, sourceId: null, damageNature: 'normal', responderOrder: [],
      responderIndex: 0, assistIndex: 0, requestId: null } as never
    const runtime = getSkillRuntime(HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '界·朱治')!.skills[0].id)!
    const state = game.state as typeof game.state & {
      b51AnGuo?: Record<string, { targetId: string | null; everMarkedIds: string[] }>
    }
    state.b51AnGuo = { [owner.id]: { targetId: target.id, everMarkedIds: [target.id] } }

    expect(runtime.dyingAssist?.(game, owner.id, target.id, null)).toBe('pending')
    expect(target.marks.anGuo).toBeUndefined()
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'dying-choice', data: { targetId: target.id } } as never,
      { payload: { optionId: 'lose-hp' } } as never)

    expect(target.hp).toBe(1)
    expect(target.armorPoints).toBe(1)
    expect(owner.hp).toBe(1)
    expect(game.state.dying).toBeNull()
  })

  it('谋曹仁解围在查看手牌之前先失去护甲', () => {
    const { game, owner, target } = gameFixture()
    game.state.status = 'playing'
    owner.armorPoints = 1
    const cardId = game.state.zones.drawPile[0] as CardId
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const caoren = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·曹仁')!
    const runtime = getSkillRuntime(caoren.skills.find(({ name }) => name === '解围')!.id)!

    runtime.resume!(game, owner.id, { step: 'choose-target', data: {} } as never,
      { payload: { targetIds: [target.id] } } as never)

    expect(owner.armorPoints).toBe(0)
    expect(game.state.pendingRequests.some((request) => request.kind === 'choose-cards')).toBe(true)
    expect(game.state.skillResolution?.data.armorPaid).toBe(true)
  })

  it('谋曹仁据守允许零弃牌翻面；背面受伤后可选择护甲或按现有护甲翻回摸牌', () => {
    const { game, owner } = gameFixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = 'mou-caoren-b51'
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·曹仁')!
      .skills.find(({ name }) => name === '据守')!
    const runtime = getSkillRuntime(skill.id)!
    runtime.invokeActive!(game, owner.id, `skill:${skill.id}`)
    const costRequest = game.state.pendingRequests.at(-1)!
    expect(costRequest).toMatchObject({ kind: 'choose-cards', min: 0, max: 0 })
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'discard-for-armor', data: {} } as never,
      { payload: { cardIds: [] } } as never)
    expect(owner.faceDown).toBe(true)
    expect(owner.armorPoints ?? 0).toBe(0)

    owner.armorPoints = 2
    const damage = game.dispatch('AfterDamage', { amount: 1 }, { targetId: owner.id })
    runtime.triggers?.[0].handle(game, owner.id, damage)
    runtime.startQueued!(game, owner.id, game.state.skillQueue.at(-1)!)
    const before = owner.zones.hand.length
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'damage-option', data: {} } as never,
      { payload: { optionId: 'flip' } } as never)
    expect(owner.faceDown).toBe(false)
    expect(owner.zones.hand).toHaveLength(before + 2)
  })

  it('谋貂蝉闭月按本回合受伤角色去重计数且最多摸四张', () => {
    const { game, owner } = gameFixture()
    const diaochan = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·貂蝉')!
    const runtime = getSkillRuntime(diaochan.skills.find(({ name }) => name === '闭月')!.id)!
    const [first, second, third, fourth] = game.state.players.slice(1)
    runtime.triggers?.find(({ event }) => event === 'TurnStart')?.handle(game, owner.id, { event: { payload: {} } } as never)
    const settled = runtime.triggers?.find(({ event }) => event === 'DamageSettled')!
    for (const target of [first, first, second, third, fourth])
      settled.handle(game, owner.id, { event: { targetId: target.id, payload: { finalAmount: 1 } } } as never)
    const before = owner.zones.hand.length
    runtime.triggers?.find(({ event }) => event === 'PhaseEnd')?.handle(game, owner.id,
      { event: { payload: { playerId: owner.id, phase: 'finish' } } } as never)
    expect(owner.zones.hand.length - before).toBe(4)
  })

  it('界吴懿奔袭的合法动作枚举0至X个距离1额外目标组合', () => {
    const { game, owner } = gameFixture(7)
    owner.characterId = 'wuyi-expansion-test'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const skillId = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '界·吴懿')!.skills[0].id
    const runtime = getSkillRuntime(skillId)!
    const state = game.state as typeof game.state & {
      b51Wuyi?: Record<string, { turn: number; distanceReduction: number; pendingExtraTarget: boolean; watchedCardId: CardId | null; cardDealtDamage: boolean }>
    }
    state.b51Wuyi = { [owner.id]: { turn: game.state.turnNumber, distanceReduction: 2,
      pendingExtraTarget: true, watchedCardId: null, cardDealtDamage: false } }
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀') as CardId
    const baseTarget = game.state.players[3].id
    const action = { id: 'wuyi-base-slash', kind: 'use-card' as const, playerId: owner.id,
      cardIds: [cardId], targetIds: [baseTarget], targetMin: 1, targetMax: 1, asCardName: '杀', label: '使用【杀】' }
    const variants = withNextCardTargetChoices(game.state, owner.id, [action], (characterId) =>
      characterId === 'wuyi-expansion-test' ? [skillId] : [])
      .filter((candidate) => candidate.kind === 'use-card' && candidate.id.includes(':target-plus:'))
    expect(variants).toHaveLength(3)
    expect(variants.some((variant) => variant.kind === 'use-card' && variant.targetIds.length === 3)).toBe(true)
    expect(runtime.distanceModifier?.toOthers?.(game.state, owner.id)).toBe(-2)
  })

  it('界吴懿奔袭只在下一张合格牌造成伤害后摸五张', () => {
    const { game, owner, target } = gameFixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '界·吴懿')!.skills[0].id)!
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic') as CardId
    const state = game.state as typeof game.state & {
      b51Wuyi?: Record<string, { turn: number; distanceReduction: number; pendingExtraTarget: boolean; watchedCardId: CardId | null; cardDealtDamage: boolean }>
    }
    state.b51Wuyi = { [owner.id]: { turn: game.state.turnNumber, distanceReduction: 1,
      pendingExtraTarget: true, watchedCardId: null, cardDealtDamage: false } }
    const cardUsed = runtime.triggers?.find(({ event }) => event === 'CardUsed')!
    const damageSettled = runtime.triggers?.find(({ event }) => event === 'DamageSettled')!
    const afterUse = runtime.triggers?.find(({ event }) => event === 'AfterCardUse')!
    cardUsed.handle(game, owner.id, { event: { sourceId: owner.id,
      payload: { cardId, cardName: game.state.cards[cardId].name } } } as never)
    damageSettled.handle(game, owner.id, { event: { payload: { cardId, finalAmount: 1 }, targetId: target.id } } as never)
    const before = owner.zones.hand.length
    afterUse.handle(game, owner.id, { event: { sourceId: owner.id, payload: { cardId } } } as never)
    expect(owner.zones.hand.length - before).toBe(5)
    expect(state.b51Wuyi?.[owner.id].pendingExtraTarget).toBe(false)
    expect(state.b51Wuyi?.[owner.id].watchedCardId).toBeNull()
  })

  it('谋姜维挑衅开局4点蓄力、逐人询问并消耗所选人数的蓄力点', () => {
    const { game, owner, target } = gameFixture()
    owner.characterId = 'mou-jiangwei-b51'
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·姜维')!
      .skills.find(({ name }) => name === '挑衅')!
    const runtime = getSkillRuntime(skill.id)!
    runtime.onGameStart?.(game, owner.id)
    expect(owner.marks.mouJiangweiTiaoxinCharge).toBe(4)

    runtime.invokeActive?.(game, owner.id, `skill:${skill.id}`)
    runtime.resume!(game, owner.id, { step: 'select-targets', data: {} } as never,
      { payload: { targetIds: [target.id, game.state.players[2].id] } } as never)
    expect(owner.marks.mouJiangweiTiaoxinCharge).toBe(2)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.startQueued!(game, owner.id, { step: 'choose-response', data: { targetId: target.id } } as never)
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-option', playerId: target.id })
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-response', data: { targetId: target.id } } as never,
      { payload: { optionId: 'slash' } } as never)
    expect(game.state.cardResolution?.kind).toBe('slash')
    expect(game.state.cardResolution?.sourceId).toBe(target.id)
    expect(game.state.cardResolution?.targetId).toBe(owner.id)
  })

  it('谋曹操奸雄按治世标记计算摸牌，并在获得伤害牌后另行询问移除标记', () => {
    const { game, owner } = gameFixture()
    game.state.status = 'playing'
    owner.characterId = 'mou-caocao-b51'
    owner.marks.mouCaoCaoZhishi = 1
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·曹操')!
      .skills.find(({ name }) => name === '奸雄')!
    const runtime = getSkillRuntime(skill.id)!
    const damageCard = game.state.zones.drawPile[0]!
    const cardsBefore = game.state.zones.drawPile.length
    moveCard(game.state, damageCard, { kind: 'drawPile' }, { kind: 'processingArea' })
    runtime.resume!(game, owner.id, { step: 'damage-choice', data: { cardId: damageCard } } as never,
      { payload: { optionId: 'gain' } } as never)
    expect(owner.zones.hand).toContain(damageCard)
    expect(game.state.zones.drawPile).toHaveLength(cardsBefore - 2)
    expect(game.state.skillResolution).toMatchObject({ step: 'remove-mark' })
    runtime.resume!(game, owner.id, { step: 'remove-mark', data: {} } as never,
      { payload: { optionId: 'remove' } } as never)
    expect(owner.marks.mouCaoCaoZhishi).toBe(0)
  })

  it('谋刘备仁德发放阶段初始仁望、转移手牌并限制同阶段重复受赠目标', () => {
    const { game, owner, target } = gameFixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = 'mou-liubei-b51'
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·刘备')!
      .skills.find(({ name }) => name === '仁德')!
    const runtime = getSkillRuntime(skill.id)!
    game.dispatch('PhaseStart', { playerId: owner.id, phase: 'play' })
    expect(owner.marks.mouLiubeiRenwang).toBe(2)
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    runtime.invokeActive!(game, owner.id, `skill:${skill.id}`)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-recipient', data: {} } as never,
      { payload: { targetIds: [target.id] } } as never)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'give-cards', data: { targetId: target.id } } as never,
      { payload: { cardIds: [cardId] } } as never)
    expect(owner.zones.hand).not.toContain(cardId)
    expect(target.zones.hand).toContain(cardId)
    expect(owner.marks.mouLiubeiRenwang).toBe(3)
    const secondCard = game.state.zones.drawPile[0]!
    moveCard(game.state, secondCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.invokeActive!(game, owner.id, `skill:${skill.id}`)
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ candidateIds: expect.not.arrayContaining([target.id]) })
    expect((game.state as typeof game.state & { b51RendeRecipients?: Record<string, { targetIds: string[] }> }).b51RendeRecipients?.[owner.id]?.targetIds).toContain(target.id)
  })

  it('谋刘备仁德允许无实体牌响应杀，并统一支付仁望且每回合仅一次', () => {
    const { game, owner, target } = gameFixture()
    const attacker = game.state.players[2]!
    game.state.status = 'playing'
    owner.characterId = 'mou-liubei-b51'
    owner.marks.mouLiubeiRenwang = 2
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·刘备')!
      .skills.find(({ name }) => name === '仁德')!
    owner.grantedSkills = [skill.id]
    game.state.status = 'playing'
    game.beginVirtualSlash({ sourceId: target.id, targetId: owner.id, sourceSkillId: 'batch51-rende-response' })
    const request = game.state.pendingRequests.find((entry) => entry.kind === 'respond-card' && entry.playerId === owner.id)!
    expect(request.actionIds).toContain(`virtual-basic:${skill.id}:闪`)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { actionId: `virtual-basic:${skill.id}:闪` } })
    expect(owner.marks.mouLiubeiRenwang).toBeUndefined()
    expect(owner.turnUsedSkills).toContain(`${skill.id}:basic-use`)
    expect(owner.hp).toBe(target.hp)
  })

  it('谋刘备仁德虚拟杀可在决斗响应中使用，响应后转到另一方', () => {
    const { game, owner } = gameFixture()
    const attacker = game.state.players[1]!
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = attacker.id
    owner.characterId = 'mou-liubei-b51'
    owner.marks.mouLiubeiRenwang = 2
    const skillId = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·刘备')!
      .skills.find(({ name }) => name === '仁德')!.id
    owner.grantedSkills = [skillId]
    const duel = createVirtualTrick(game.state, attacker.id, '决斗', 'batch51-test')
    const action = instantTrickActions(game.state, attacker.id, duel, '决斗')
      .find((candidate) => candidate.kind === 'use-card' && candidate.targetIds.includes(owner.id))
    expect(action).toBeDefined()
    executeUseCardAction(game as never, attacker.id, action as never)
    const request = game.state.pendingRequests.find((entry) => entry.kind === 'respond-card' && entry.playerId === owner.id)!
    expect(request.actionIds).toContain(`virtual-basic:${skillId}:杀`)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { actionId: `virtual-basic:${skillId}:杀` } })
    expect(owner.marks.mouLiubeiRenwang).toBeUndefined()
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(attacker.id)
  })

  it('谋刘备仁德在出牌阶段提供不消耗手牌的合法基本牌使用，并支付两枚仁望', () => {
    const { game, owner } = gameFixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    game.state.turnUsage.slashUses = 0
    owner.characterId = 'mou-liubei-b51'
    owner.marks.mouLiubeiRenwang = 2
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·刘备')!
      .skills.find(({ name }) => name === '仁德')!
    owner.grantedSkills = [skill.id]
    const runtime = getSkillRuntime(skill.id)!
    expect(runtime.activeActions?.(game.state, owner.id).map(({ id }) => id)).toContain(`skill:${skill.id}:basic-use`)
    runtime.invokeActive!(game, owner.id, `skill:${skill.id}:basic-use`)
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    const actionId = request.kind === 'choose-option'
      ? request.options.find(({ label }) => label.includes('【杀】'))?.id
      : undefined
    expect(actionId).toBeDefined()
    runtime.resume!(game, owner.id, { step: 'choose-virtual-basic', data: {} } as never,
      { payload: { optionId: actionId } } as never)
    expect(owner.marks.mouLiubeiRenwang).toBeUndefined()
    expect(owner.turnUsedSkills).toContain(`${skill.id}:basic-use`)
    expect(owner.zones.hand.every((cardId) => !game.state.cards[cardId]?.virtual)).toBe(true)
  })

  it('谋刘备仁德可在濒死响应中支付仁望虚拟使用桃', () => {
    const { game, owner, target } = gameFixture()
    owner.characterId = 'mou-liubei-b51'
    owner.marks.mouLiubeiRenwang = 2
    owner.grantedSkills = [HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·刘备')!
      .skills.find(({ name }) => name === '仁德')!.id]
    target.hp = 0
    const skillId = owner.grantedSkills[0]!
    const runtime = getSkillRuntime(skillId)!
    const action = runtime.rescueActions?.(game.state, owner.id, target.id)[0]
    expect(action).toBeDefined()
    expect(runtime.invokeRescueAction?.(game, owner.id, action!.id, target.id)).toBe(true)
    expect(target.hp).toBe(1)
    expect(owner.marks.mouLiubeiRenwang).toBeUndefined()
    expect(owner.turnUsedSkills).toContain(`${skillId}:basic-use`)
  })

  it('谋刘备章武按轮数逐人收取已受仁德者手牌、回复并永久失去仁德', () => {
    const { game, owner, target } = gameFixture()
    const nextTarget = game.state.players[2]!
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    game.state.roundNumber = 2
    owner.characterId = 'mou-liubei-b51'
    owner.hp = 2
    for (const recipient of [target, nextTarget]) {
      const cardId = game.state.zones.drawPile[0]!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: recipient.id })
    }
    ;(game.state as typeof game.state & { b51RendeRecipientsEver?: Record<string, string[]> }).b51RendeRecipientsEver = {
      [owner.id]: [target.id, nextTarget.id],
    }
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·刘备')!
      .skills.find(({ name }) => name === '章武')!
    const runtime = getSkillRuntime(skill.id)!
    runtime.invokeActive!(game, owner.id, `skill:${skill.id}`)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'invoke-zhangwu', data: {} } as never,
      { payload: { optionId: 'invoke' } } as never)
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(target.id)
    const firstCard = target.zones.hand[0]!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'give-zhangwu-cards', data: { targetIds: [target.id, nextTarget.id], index: 0, amount: 1, targetId: target.id } } as never,
      { payload: { cardIds: [firstCard] } } as never)
    expect(owner.zones.hand).toContain(firstCard)
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(nextTarget.id)
    const secondCard = nextTarget.zones.hand[0]!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'give-zhangwu-cards', data: { targetIds: [target.id, nextTarget.id], index: 1, amount: 1, targetId: nextTarget.id } } as never,
      { payload: { cardIds: [secondCard] } } as never)
    expect(owner.zones.hand).toContain(secondCard)
    expect(owner.hp).toBe(4)
    expect(owner.permanentlyLostSkills).toContain('rende-mou-liubei:b51')
    expect(owner.usedLimitedSkills).toContain(skill.id)
  })

  it('谋刘备激将仅提供攻击范围与体力条件均合法的蜀势力角色，并能排定跳过下个出牌阶段', () => {
    const { game, owner, target } = gameFixture()
    const attacker = game.state.players[2]!
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = 'mou-liubei-b51'
    owner.identity = 'lord'
    owner.hp = 3
    target.characterId = 'caocao'
    attacker.characterId = 'zhaoyun'
    attacker.hp = 4
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·刘备')!
      .skills.find(({ name }) => name === '激将')!
    const runtime = getSkillRuntime(skill.id)!
    const end = game.dispatch('PhaseEnd', { playerId: owner.id, phase: 'play' })
    runtime.triggers?.[0].handle(game, owner.id, end)
    runtime.startQueued!(game, owner.id, { step: 'offer', data: {} } as never)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-target', data: {} } as never,
      { payload: { targetIds: [target.id] } } as never)
    expect(game.state.pendingRequests.at(-1)?.candidateIds).toContain(attacker.id)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-attacker', data: { targetId: target.id } } as never,
      { payload: { targetIds: [attacker.id] } } as never)
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(attacker.id)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'attacker-choice', data: { targetId: target.id, attackerId: attacker.id } } as never,
      { payload: { optionId: 'skip' } } as never)
    expect(game.state.scheduledSkippedPhasesByPlayer?.[attacker.id]).toContain('play')
  })

  it('谋庞统寅谋校验阴阳选择、顶牌赠予、状态转换，并在赠牌离手后执行阳效果', () => {
    const { game, owner, target } = gameFixture()
    game.state.status = 'playing'
    owner.characterId = 'mou-pangtong-b51'
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·庞统')!
      .skills.find(({ name }) => name === '寅谋')!
    const runtime = getSkillRuntime(skill.id)!
    runtime.onGameStart!(game, owner.id)
    const startupPrompt = game.state.skillQueue.at(-1)!
    expect(startupPrompt.step).toBe('choose-mode')
    runtime.startQueued!(game, owner.id, startupPrompt)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-mode', data: {} } as never,
      { payload: { optionId: 'yang' } } as never)
    expect(owner.marks.b51PangtongModeYang).toBe(1)
    const [lostCard, remainingHandCard] = game.state.zones.drawPile
    moveCard(game.state, lostCard!, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, remainingHandCard!, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, lostCard!, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
    game.state.handCardLossThisTurn = { turnNumber: game.state.turnNumber, counts: { [target.id]: 1 } }
    const turnEnd = game.dispatch('TurnEnd', { playerId: target.id, turnNumber: game.state.turnNumber })
    runtime.triggers?.find(({ event }) => event === 'TurnEnd')?.handle(game, owner.id, turnEnd)
    runtime.startQueued!(game, owner.id, { step: 'offer', data: {} } as never)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'offer', data: {} } as never,
      { payload: { optionId: 'invoke' } } as never)
    const giftCard = game.state.zones.drawPile[0]!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-top-card', data: { cardIds: [giftCard] } } as never,
      { payload: { cardIds: [giftCard] } } as never)
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-gift-recipient', data: { cardId: giftCard } } as never,
      { payload: { targetIds: [target.id] } } as never)
    expect(target.zones.hand).toContain(giftCard)
    expect(owner.marks.b51PangtongModeYin).toBe(1)
    const handBefore = target.zones.hand.length
    moveCard(game.state, giftCard, { kind: 'hand', playerId: target.id }, { kind: 'processingArea' })
    const leftEvent = game.dispatch('HandCardLeft', { cardId: giftCard, playerId: target.id, destination: { kind: 'processingArea' } })
    runtime.triggers?.find(({ event }) => event === 'HandCardLeft')?.handle(game, owner.id, leftEvent)
    const queued = game.state.skillQueue.at(-1)!
    const deckBefore = game.state.zones.drawPile.length
    runtime.startQueued!(game, owner.id, queued)
    expect(target.zones.hand).toHaveLength(handBefore - 1 + Math.min(5, target.hp))
    expect(game.state.zones.drawPile.length).toBe(deckBefore - Math.min(5, target.hp))
  })

  it('谋庞统宏策第三项的三张牌仅在留于目标手牌时豁免手牌上限', () => {
    const { game, owner, target } = gameFixture()
    owner.characterId = 'mou-pangtong-b51'
    game.state.status = 'playing'
    const runtime = getSkillRuntime(HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·庞统')!
      .skills.find(({ name }) => name === '宏策')!.id)!
    const before = new Set(target.zones.hand)
    runtime.resume!(game, owner.id, { step: 'choose-initial-mode', data: { targetId: target.id } } as never,
      { payload: { optionId: '3' } } as never)
    const drawn = target.zones.hand.filter((cardId) => !before.has(cardId))
    expect(drawn).toHaveLength(3)
    for (const cardId of drawn) expect(runtime.handLimitExempt?.(game.state, owner.id, cardId)).toBe(true)
    const cardId = drawn[0]!
    moveCard(game.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
    const event = game.dispatch('HandCardLeft', { cardId, playerId: target.id, destination: { kind: 'discardPile' } })
    runtime.triggers?.find(({ event: eventName }) => eventName === 'HandCardLeft')?.handle(game, owner.id, event)
    expect(runtime.handLimitExempt?.(game.state, owner.id, cardId)).toBe(false)
  })

  it('谋庞统宏策第一项等量替换为随机伤害牌并进入无次数限制杀目标选择', () => {
    const { game, owner, target } = gameFixture()
    game.state.status = 'playing'
    owner.characterId = 'mou-pangtong-b51'
    target.characterId = 'caocao'
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·庞统')!
      .skills.find(({ name }) => name === '宏策')!
    const runtime = getSkillRuntime(skill.id)!
    while (target.zones.hand.length < 2) {
      const cardId = game.state.zones.drawPile[0]!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    }
    const damageCard = game.state.zones.drawPile.find((cardId) => {
      const name = game.state.cards[cardId]?.name ?? ''
      return name.includes('杀') || ['南蛮入侵', '万箭齐发', '决斗', '火攻', '闪电'].includes(name)
    })
    expect(damageCard).toBeDefined()
    const beforeHand = [...target.zones.hand]
    const payment = target.zones.hand[0]!
    runtime.resume!(game, owner.id, { step: 'replace-half-hand', data: { targetId: target.id, mode: 1, initial: false, count: 1 } } as never,
      { payload: { cardIds: [payment] } } as never)
    expect(target.zones.hand).not.toContain(payment)
    const replacement = target.zones.hand.find((cardId) => !beforeHand.includes(cardId))
    expect(replacement).toBeDefined()
    expect((game.state.cards[replacement!]?.name ?? '').includes('杀')
      || ['南蛮入侵', '万箭齐发', '决斗', '火攻', '闪电'].includes(game.state.cards[replacement!]?.name ?? '')).toBe(true)
    expect(game.state.zones.discardPile).toContain(payment)
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-targets', playerId: target.id })
    const targetRequest = game.state.pendingRequests.at(-1)!
    const legalTarget = targetRequest.kind === 'choose-targets' ? targetRequest.candidateIds[0] : undefined
    expect(legalTarget).toBeDefined()
    const slashUsesBefore = game.state.turnUsage.slashUses
    runtime.resume!(game, owner.id, { step: 'slash-target', data: { targetId: target.id, candidates: [legalTarget] } } as never,
      { payload: { targetIds: [legalTarget] } } as never)
    expect(game.state.turnUsage.slashUses).toBe(slashUsesBefore)
    expect(game.state.cardResolution?.kind).toBe('slash')
  })

  it('谋庞统宏策第二项重铸后可选择并正常结算单目标普通锦囊', () => {
    const { game, owner, target } = gameFixture()
    game.state.status = 'playing'
    owner.characterId = 'mou-pangtong-b51'
    target.characterId = 'caocao'
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·庞统')!
      .skills.find(({ name }) => name === '宏策')!
    const runtime = getSkillRuntime(skill.id)!
    const recastCard = game.state.zones.drawPile[0]!
    moveCard(game.state, recastCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const cardId = target.zones.hand[0]!
    const oldHandCount = target.zones.hand.length
    runtime.resume!(game, owner.id, { step: 'recast-for-trick', data: { targetId: target.id, mode: 2, initial: false } } as never,
      { payload: { cardIds: [cardId] } } as never)
    expect(game.state.zones.discardPile).toContain(cardId)
    const trickMenu = game.state.pendingRequests.at(-1)!
    expect(trickMenu.kind).toBe('choose-option')
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'choose-trick-name', data: { targetId: target.id, mode: 2, initial: false } } as never,
      { payload: { optionId: '无中生有' } } as never)
    const actionMenu = game.state.pendingRequests.at(-1)!
    expect(actionMenu.kind).toBe('choose-option')
    const actionId = actionMenu.kind === 'choose-option' ? actionMenu.options[0]?.id : undefined
    expect(actionId).toBeDefined()
    game.state.pendingRequests = []
    game.state.skillResolution = null
    runtime.resume!(game, owner.id, { step: 'use-single-target-trick', data: {} } as never,
      { payload: { optionId: actionId } } as never)
    expect(target.zones.hand.length).toBe(oldHandCount + 2)
    expect(game.state.cardResolution).toBeNull()
  })

  it('谋姜维志继强制觉醒后施加北伐目标限制，并在下回合开始清除', () => {
    const { game, owner, target } = gameFixture()
    owner.characterId = 'mou-jiangwei-b51'
    owner.marks.mouJiangweiTiaoxinSelected = 4
    const skill = HISTORICAL_BATCH51_CHARACTERS.find(({ name }) => name === '谋·姜维')!
      .skills.find(({ name }) => name === '志继')!
    const runtime = getSkillRuntime(skill.id)!
    expect(runtime.awakening?.ready(game.state, owner.id)).toBe(true)
    runtime.resume!(game, owner.id, { step: 'select-beifa-targets', data: {} } as never,
      { payload: { targetIds: [target.id, owner.id] } } as never)

    expect(target.marks.mouJiangweiBeifa).toBe(1)
    expect(owner.marks.mouJiangweiBeifa).toBe(1)
    expect(runtime.globalProhibitsSourceTarget?.(game.state, owner.id, target.id, game.state.players[2].id, '杀')).toBe(true)
    expect(runtime.globalProhibitsSourceTarget?.(game.state, owner.id, target.id, owner.id, '杀')).toBe(false)
    expect(runtime.globalProhibitsSourceTarget?.(game.state, owner.id, target.id, target.id, '杀')).toBe(false)
    expect(runtime.globalProhibitsSourceTarget?.(game.state, owner.id, owner.id, target.id, '杀')).toBe(true)
    expect(runtime.globalProhibitsSourceTarget?.(game.state, owner.id, owner.id, owner.id, '杀')).toBe(false)
    runtime.triggers?.find(({ event }) => event === 'TurnStart')?.handle(game, owner.id,
      { event: { payload: { playerId: owner.id } } } as never)
    expect(target.marks.mouJiangweiBeifa).toBeUndefined()
    expect(owner.marks.mouJiangweiBeifa).toBeUndefined()
  })
})
