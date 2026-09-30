import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { B48_CAI_ZHENJI, B48_CUI_YAN, B48_JIE_GUYONG, B48_JIE_ZHOUCANG, B48_JIANGWAN_GAI, B48_MAO_JIE, B48_MOU_HUAXIONG, B48_MOU_LVMENG, B48_MOU_YUJIN, B48_ZHANGREN, B48_ZHANG_ZHONGJING } from '@/sanguosha/data/characters/historical-batch48'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { isInFactionEncirclement } from '@/sanguosha/engine/formation'
import { moveCard } from '@/sanguosha/engine/zones'
import { cardPlayable, isCardUseLocked, lockCardUseUntilTurnEnd } from '@/sanguosha/engine/card-play-lock'
import { adjustDamageAmount } from '@/sanguosha/engine/equipment'
import { isArmorSuppressed } from '@/sanguosha/engine/armor-suppression'
import { beginVirtualSlash } from '@/sanguosha/engine/cards/basic'
import { performJudgment } from '@/sanguosha/engine/judgment'
import { recordTurnCardCategory } from '@/sanguosha/engine/turn-card-categories'

const REN_PILE = 'ren-zhangzhongjing-b48'

describe('第48批角色注册', () => {
  it('恰好注册十名身份局武将，国战专属张任不混入本批', () => {
    const batchIds = ['caizhenji-b48', 'zhangzhongjing-b48', 'cuiyan-b48', 'maojie-b48', 'mou-yujin-b48',
      'mou-huaxiong-b48', 'mou-lvmeng-b48', 'jie-zhoucang-b48', 'jiangwan-gai-b48', 'jie-guyong-b48']
    expect(ALL_CHARACTERS.filter((character) => batchIds.includes(character.id)).map((character) => character.id)).toEqual(batchIds)
    expect(ALL_CHARACTERS.some((character) => character.id === B48_ZHANGREN.id)).toBe(false)
  })
})

describe('第48批 蔡贞姬【舍裔】【天音】', () => {
  it('天音按本回合未使用的牌类别各取得一张，并排除已使用类别', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-tianyin', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]
    owner.characterId = B48_CAI_ZHENJI.id
    recordTurnCardCategory(game.state, owner.id, 'basic', 'used', null)
    const before = new Set(owner.zones.hand)
    const runtime = getSkillRuntime(B48_CAI_ZHENJI.skills[1].id)!
    runtime.triggers?.find((trigger) => trigger.event === 'PhaseEnd')?.handle(
      { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game) } as never,
      owner.id, { event: { payload: { playerId: owner.id, phase: 'finish' } } } as never)
    const gained = owner.zones.hand.filter((id) => !before.has(id)).map((id) => game.state.cards[id]!.category)
    expect(gained).not.toContain('basic')
    expect(gained).toEqual(expect.arrayContaining(['trick', 'equipment']))
  })
})

function gameFixture() {
  const game = new SanguoshaGame({ seed: 'historical-b48-ren-pile', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const owner = game.state.players[0]
  owner.characterId = B48_ZHANG_ZHONGJING.id
  owner.characterPiles[REN_PILE] = []
  const observed: Array<Record<string, unknown>> = []
  game.events.on('CharacterPileMoved', (context) => {
    const payload = context.event.payload as Record<string, unknown>
    observed.push(payload)
  })
  return { game, owner, observed }
}

describe('第48批 张仲景【济世】牌堆移动规则', () => {
  it('任何通用牌区移动令“仁”牌离堆都会摸一张，事件不泄露牌面 ID', () => {
    const { game, owner, observed } = gameFixture()
    const renCard = game.state.zones.drawPile[0]
    const handBeforeStore = owner.zones.hand.length
    const drawBeforeStore = game.state.zones.drawPile.length
    moveCard(game.state, renCard, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: REN_PILE })
    expect(owner.zones.hand).toHaveLength(handBeforeStore)
    expect(game.state.zones.drawPile).toHaveLength(drawBeforeStore - 1)
    const handBefore = owner.zones.hand.length
    const drawBefore = game.state.zones.drawPile.length
    moveCard(game.state, renCard, { kind: 'characterPile', playerId: owner.id, pile: REN_PILE }, { kind: 'discardPile' })
    expect(owner.zones.hand).toHaveLength(handBefore + 1)
    expect(game.state.zones.drawPile).toHaveLength(drawBefore - 1)
    expect(observed.at(-1)).toMatchObject({ ownerId: owner.id, pile: REN_PILE, direction: 'leave', overflow: false })
    expect(observed.at(-1)).not.toHaveProperty('cardId')
  })

  it('牌堆容量溢出移出的牌不触发摸牌', () => {
    const { game, owner } = gameFixture()
    const renCard = game.state.zones.drawPile[0]
    moveCard(game.state, renCard, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: REN_PILE })
    const handBefore = owner.zones.hand.length
    const drawBefore = game.state.zones.drawPile.length
    moveCard(game.state, renCard, { kind: 'characterPile', playerId: owner.id, pile: REN_PILE }, { kind: 'discardPile' },
      { characterPileMoveReason: 'overflow', discardReason: 'other' })
    expect(owner.zones.hand).toHaveLength(handBefore)
    expect(game.state.zones.drawPile).toHaveLength(drawBefore)
  })
})

describe('第48批 张仲景【疗疫】', () => {
  it('仁区牌由张仲景选择；目标手牌差值准确补足且剩余仁牌保留', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-liaoyi-select', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, target] = game.state.players
    owner.characterId = B48_ZHANG_ZHONGJING.id
    const ren = game.state.zones.drawPile.slice(0, 3)
    for (const cardId of ren) moveCard(game.state, cardId, { kind: 'drawPile' },
      { kind: 'characterPile', playerId: owner.id, pile: REN_PILE })
    const targetCard = game.state.zones.drawPile[0]
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    target.hp = 3
    const requests: any[] = []
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game),
      askSkill: (request: any) => requests.push(request) }
    const runtime = getSkillRuntime(B48_ZHANG_ZHONGJING.skills[1].id)!
    runtime.resume?.(host, owner.id, { step: 'gain-choice', data: { targetId: target.id, amount: 2 } } as any,
      { payload: { optionId: 'yes' } } as any)
    expect(requests[0].build('liaoyi-select').cardIds).toEqual(ren)
    expect(requests[0].build('liaoyi-select')).toMatchObject({ playerId: owner.id, min: 2, max: 2 })
    runtime.resume?.(host, owner.id, { step: 'gain-cards', data: { targetId: target.id, amount: 2 } } as any,
      { payload: { cardIds: [ren[2], ren[0]] } } as any)
    expect(target.zones.hand).toEqual(expect.arrayContaining([ren[0], ren[2]]))
    expect(owner.characterPiles[REN_PILE]).toEqual([ren[1]])
  })
})

describe('第48批 张仲景【病论】', () => {
  it('经独立技能请求续接，可弃仁后由目标执行选择', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-binglun-alias', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, target] = game.state.players
    owner.characterId = B48_ZHANG_ZHONGJING.id
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const ren = game.state.zones.drawPile[0]
    moveCard(game.state, ren, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: REN_PILE })
    const requests: any[] = []
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game),
      askSkill: (request: any) => requests.push(request) }
    const skill = B48_ZHANG_ZHONGJING.skills[2]
    const runtime = getSkillRuntime(B48_ZHANG_ZHONGJING.skills[0].id)!
    expect(runtime.activeActions?.(game.state, owner.id).some((action) => action.id === skill.id)).toBe(true)
    runtime.invokeActive?.(host, owner.id, skill.id)
    const alias = getSkillRuntime(skill.id)!
    alias.resume?.(host, owner.id, { step: 'cost', data: {} } as any, { payload: { cardIds: [ren] } } as any)
    alias.resume?.(host, owner.id, { step: 'target', data: {} } as any, { payload: { targetIds: [target.id] } } as any)
    expect(requests.at(-1).build('binglun-choice')).toMatchObject({ kind: 'choose-option', playerId: target.id })
    const handBefore = target.zones.hand.length
    alias.resume?.(host, owner.id, { step: 'choice', data: { targetId: target.id } } as any,
      { payload: { optionId: 'draw' } } as any)
    expect(target.zones.hand).toHaveLength(handBefore + 1)
  })
})

describe('国战围攻关系', () => {
  it('以目标两侧存活角色的明置武将势力判定，不使用身份队伍', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-formation', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [left, target, right, extra] = game.state.players
    left.characterId = 'caocao'
    target.characterId = 'liubei'
    right.characterId = 'xunyu'
    extra.characterId = 'sunquan'
    left.identity = 'rebel'
    right.identity = 'rebel'
    expect(isInFactionEncirclement(game.state, left.id, right.id, target.id)).toBe(true)
    expect(isInFactionEncirclement(game.state, left.id, left.id, target.id)).toBe(true)
    target.characterId = 'caocao'
    expect(isInFactionEncirclement(game.state, left.id, right.id, target.id)).toBe(false)
    target.characterId = 'liubei'
    right.primaryGeneralRevealed = false
    expect(isInFactionEncirclement(game.state, left.id, right.id, target.id)).toBe(false)
  })

  it('围攻位置按当前存活座次计算，阵亡角色不再占位', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-formation-dead', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [dead, target, right, mid, left] = game.state.players
    dead.alive = false
    target.characterId = 'liubei'
    right.characterId = 'caocao'
    mid.characterId = 'sunquan'
    left.characterId = 'xunyu'
    expect(isInFactionEncirclement(game.state, right.id, left.id, target.id)).toBe(true)
  })
})

describe('第48批 张任【锋矢】', () => {
  it('同围攻关系内任一围攻者使用杀后，由被围攻者选择并弃置装备', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-fengshi', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    game.state.status = 'playing'
    const [owner, target, source, fourth, fifth] = game.state.players
    owner.characterId = 'lvbu'
    target.characterId = 'caocao'
    source.characterId = 'lvbu'
    fourth.characterId = 'liubei'
    fifth.characterId = 'sunquan'
    game.state.currentPlayerId = owner.id
    const equipmentCard = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    const slot = game.state.cards[equipmentCard].equipmentSlot!
    moveCard(game.state, equipmentCard, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot })

    const pending: Array<{ skillId: string; ownerId: string; step: string; data: Record<string, unknown>; build(id: string): any }> = []
    let resumed = 0
    const gameHost = game as any
    gameHost.askSkill = (request: typeof pending[number]) => pending.push(request)
    gameHost.resumeCardTarget = () => { resumed += 1 }
    const runtime = getSkillRuntime('fengshi-zhangren-b48')!
    expect(runtime.interceptBystanderTarget?.(gameHost, owner.id, {
      sourceId: source.id, targetId: target.id, cardId: 'slash', cardName: '杀', category: 'basic',
    })).toBe(true)
    expect(pending[0].build('fengshi-ask').kind).toBe('choose-option')
    runtime.resume?.(gameHost, owner.id, { step: 'invoke', data: { targetId: target.id, sourceId: source.id } } as any,
      { payload: { optionId: 'yes' } } as any)
    expect(pending[1].build('fengshi-discard').playerId).toBe(target.id)
    runtime.resume?.(gameHost, owner.id, { step: 'discard', data: { targetId: target.id } } as any,
      { payload: { cardIds: [equipmentCard] } } as any)
    expect(game.state.zones.discardPile).toContain(equipmentCard)
    expect(target.zones.equipment[slot]).toBeNull()
    expect(resumed).toBe(1)
  })
})

describe('第48批 崔琰【尊嫡】', () => {
  it('红色判定时由所选目标角色选择场上牌并决定移动目的地', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-zundi-controller', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, target, cardOwner, destination] = game.state.players
    game.state.status = 'playing'
    owner.characterId = B48_CUI_YAN.id
    const redCard = game.state.zones.drawPile.find((id) => ['heart', 'diamond'].includes(game.state.cards[id]?.suit ?? ''))!
    game.state.zones.drawPile.splice(game.state.zones.drawPile.indexOf(redCard), 1)
    game.state.zones.drawPile.unshift(redCard)
    const equipmentId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment'
      && game.state.cards[id]?.equipmentSlot === 'armor')!
    moveCard(game.state, equipmentId, { kind: 'drawPile' }, { kind: 'equipment', playerId: cardOwner.id, slot: 'armor' })
    performJudgment(game as any, target.id, B48_CUI_YAN.skills[1].name,
      { tag: `${B48_CUI_YAN.skills[1].id}:judge`, data: { ownerId: owner.id, targetId: target.id } })
    expect(game.state.pendingRequests[0]).toMatchObject({ kind: 'choose-cards', playerId: target.id })
    const cardRequest = game.state.pendingRequests[0]
    game.respond({ requestId: cardRequest.id, playerId: target.id, payload: { cardIds: [equipmentId] } })
    const destinationRequest = game.state.pendingRequests[0]
    expect(destinationRequest).toMatchObject({ kind: 'choose-targets', playerId: target.id })
    game.respond({ requestId: destinationRequest.id, playerId: target.id, payload: { targetIds: [destination.id] } })
    expect(destination.zones.equipment.armor).toBe(equipmentId)
    expect(cardOwner.zones.equipment.armor).toBeNull()
  })
})

describe('第48批 张任【穿心】', () => {
  function setupChuanxin() {
    const game = new SanguoshaGame({ seed: 'historical-b48-chuanxin', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    game.state.status = 'playing'
    const [owner, target] = game.state.players
    owner.characterId = 'caocao'
    target.characterId = 'liubei'
    target.deputyCharacterId = 'xushu'
    target.deputyGeneralRevealed = true
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const pending: Array<{ skillId: string; ownerId: string; step: string; data: Record<string, unknown>; build(id: string): any }> = []
    const gameHost = game as any
    gameHost.askSkill = (request: typeof pending[number]) => pending.push(request)
    const runtime = getSkillRuntime(B48_ZHANGREN.skills[0].id)!
    return { game, owner, target, pending, gameHost, runtime }
  }

  it('成功发动后先防止伤害，再由目标弃置全部装备并失去1点体力', () => {
    const { game, owner, target, pending, gameHost, runtime } = setupChuanxin()
    const equipment = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.category === 'equipment').slice(0, 2)
    for (const cardId of equipment) {
      const slot = game.state.cards[cardId].equipmentSlot!
      if (target.zones.equipment[slot]) continue
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot })
    }
    const equippedIds = Object.values(target.zones.equipment).filter((id): id is string => Boolean(id))
    expect(equippedIds.length).toBeGreaterThan(0)
    game.state.pendingTargetDamage = { skillId: B48_ZHANGREN.skills[0].id, options: {
      sourceId: owner.id, targetId: target.id, amount: 1, nature: 'normal', cardId: 'slash', cardName: '杀',
    } } as any
    expect(runtime.offersGlobalDamagePreventionAsk?.(gameHost, owner.id, {
      sourceId: owner.id, targetId: target.id, amount: 1, nature: 'normal', cardId: 'slash', cardName: '杀', chainTransfer: false,
    })).toBe(true)
    const invoke = game.state.skillQueue.shift()!
    runtime.startQueued?.(gameHost, owner.id, invoke)
    expect(pending[0].build('chuanxin-invoke').kind).toBe('choose-option')
    runtime.resume?.(gameHost, owner.id, { step: 'invoke', data: { targetId: target.id } } as any,
      { payload: { optionId: 'yes' } } as any)
    expect(game.state.pendingTargetDamage).toBeUndefined()
    expect(game.state.skillQueue[0]).toMatchObject({ ownerId: target.id, step: 'choice' })
    const choice = game.state.skillQueue.shift()!
    runtime.startQueued?.(gameHost, target.id, choice)
    expect(pending[1].ownerId).toBe(target.id)
    expect(pending[1].build('chuanxin-choice').playerId).toBe(target.id)
    const hpBefore = target.hp
    runtime.resume?.(gameHost, target.id, { step: 'choice', data: { targetId: target.id, attackerId: owner.id } } as any,
      { payload: { optionId: 'discard-equipment' } } as any)
    expect(equippedIds.every((id) => game.state.zones.discardPile.includes(id))).toBe(true)
    expect(target.hp).toBe(hpBefore - 1)
  })

  it('无装备时只能移除副将，且移除后不再提供副将技能', () => {
    const { game, owner, target, pending, gameHost, runtime } = setupChuanxin()
    game.state.pendingTargetDamage = { skillId: B48_ZHANGREN.skills[0].id, options: {
      sourceId: owner.id, targetId: target.id, amount: 1, nature: 'normal', cardId: 'duel', cardName: '决斗',
    } } as any
    runtime.offersGlobalDamagePreventionAsk?.(gameHost, owner.id, {
      sourceId: owner.id, targetId: target.id, amount: 1, nature: 'normal', cardId: 'duel', cardName: '决斗', chainTransfer: false,
    })
    const invoke = game.state.skillQueue.shift()!
    runtime.startQueued?.(gameHost, owner.id, invoke)
    runtime.resume?.(gameHost, owner.id, { step: 'invoke', data: { targetId: target.id } } as any,
      { payload: { optionId: 'yes' } } as any)
    const choice = game.state.skillQueue.shift()!
    runtime.startQueued?.(gameHost, target.id, choice)
    const options = pending[1].build('chuanxin-choice').options.map((option: { id: string }) => option.id)
    expect(options).toEqual(['remove-deputy'])
    runtime.resume?.(gameHost, target.id, { step: 'choice', data: { targetId: target.id, attackerId: owner.id } } as any,
      { payload: { optionId: 'remove-deputy' } } as any)
    expect(target.deputyCharacterId).toBeNull()
    expect(target.deputyGeneralRevealed).toBe(false)
    expect(pending).toHaveLength(2)
  })

  it('不发动时原伤害仅恢复结算一次', () => {
    const { game, owner, target, pending, gameHost, runtime } = setupChuanxin()
    const hpBefore = target.hp
    game.state.pendingTargetDamage = { skillId: B48_ZHANGREN.skills[0].id, options: {
      sourceId: owner.id, targetId: target.id, amount: 1, nature: 'normal', cardId: 'slash', cardName: '杀',
    } } as any
    runtime.offersGlobalDamagePreventionAsk?.(gameHost, owner.id, {
      sourceId: owner.id, targetId: target.id, amount: 1, nature: 'normal', cardId: 'slash', cardName: '杀', chainTransfer: false,
    })
    const invoke = game.state.skillQueue.shift()!
    runtime.startQueued?.(gameHost, owner.id, invoke)
    runtime.resume?.(gameHost, owner.id, { step: 'invoke', data: { targetId: target.id } } as any,
      { payload: { optionId: 'no' } } as any)
    expect(target.hp).toBe(hpBefore - 1)
    expect(game.state.pendingTargetDamage).toBeUndefined()
    expect(game.state.skillQueue).toHaveLength(0)
    expect(pending).toHaveLength(1)
  })
})

describe('第48批 界周仓【忠勇】公共规则', () => {
  it('通过忠勇获得的实体牌只禁止本回合使用，回合推进后自动失效', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-zhongyong-lock', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    lockCardUseUntilTurnEnd(game.state, { targetId: owner.id, cardId: slashId, sourceId: owner.id, skillId: B48_JIE_ZHOUCANG.skills[0].id })
    expect(isCardUseLocked(game.state, owner.id, slashId)).toBe(true)
    expect(cardPlayable(game.state, owner.id, slashId)).toBe(false)
    expect(cardPlayable(game.state, owner.id, slashId, { forResponse: true })).toBe(true)
    expect(owner.zones.hand).toContain(slashId)
    expect(beginVirtualSlash(game as any, { sourceId: owner.id, targetId: game.state.players[1].id,
      sourceSkillId: 'test-locked-zhuanyong', cardId: slashId })).toBe(false)
    game.state.turnNumber += 1
    expect(isCardUseLocked(game.state, owner.id, slashId)).toBe(false)
  })

  it('“下一张杀伤害+1”绑定具体杀牌，并仍遵守白银狮子的受伤上限', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-zhongyong-damage', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [source, target] = game.state.players
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    game.state.slashDamageBonusCards = { [slashId]: { sourceId: source.id, amount: 1, turnNumber: game.state.turnNumber } }
    expect(adjustDamageAmount(game.state, source.id, target.id, 1, 'normal', '杀', slashId)).toBe(2)
    expect(adjustDamageAmount(game.state, source.id, target.id, 1, 'normal', '杀')).toBe(1)
    expect(adjustDamageAmount(game.state, source.id, target.id, 1, 'normal', '决斗', slashId)).toBe(1)
  })
})

describe('第48批 谋·吕蒙【克己】【渡江】', () => {
  it('觉醒前两种代价各限一次；觉醒后合并为出牌阶段限一次', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-kexi-limits', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]
    owner.characterId = B48_MOU_LVMENG.id
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const runtime = getSkillRuntime(B48_MOU_LVMENG.skills[0].id)!
    const requests: any[] = []
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game), askSkill: (item: any) => requests.push(item) }
    const costCard = game.state.zones.drawPile[0]
    moveCard(game.state, costCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    runtime.invokeActive?.(host, owner.id, B48_MOU_LVMENG.skills[0].id)
    runtime.resume?.(host, owner.id, { step: 'mode', data: {} } as any, { payload: { optionId: 'discard' } } as any)
    runtime.resume?.(host, owner.id, { step: 'discard', data: {} } as any, { payload: { cardIds: [costCard] } } as any)
    expect(owner.armorPoints).toBe(1)
    expect(runtime.activeActions?.(game.state, owner.id)).toHaveLength(1)
    runtime.invokeActive?.(host, owner.id, B48_MOU_LVMENG.skills[0].id)
    runtime.resume?.(host, owner.id, { step: 'mode', data: {} } as any, { payload: { optionId: 'health' } } as any)
    expect(owner.hp).toBe(3)
    expect(owner.armorPoints).toBe(3)
    owner.awakenedSkills = [B48_MOU_LVMENG.skills[1].id]
    expect(runtime.activeActions?.(game.state, owner.id)).toHaveLength(1)
    runtime.invokeActive?.(host, owner.id, B48_MOU_LVMENG.skills[0].id)
    runtime.resume?.(host, owner.id, { step: 'mode', data: {} } as any, { payload: { optionId: 'health' } } as any)
    expect(owner.armorPoints).toBe(5)
    expect(runtime.activeActions?.(game.state, owner.id)).toHaveLength(0)
  })
})

describe('第48批 谋·华雄【耀武】', () => {
  it('受到黑色【杀】伤害时摸牌；红色【杀】由伤害来源选择回复或摸牌', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-mou-huaxiong-yaowu', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, source] = game.state.players
    owner.characterId = B48_MOU_HUAXIONG.id
    source.hp -= 1
    const runtime = getSkillRuntime(B48_MOU_HUAXIONG.skills[0].id)!
    const queued: any[] = []
    const requests: any[] = []
    const host: any = { state: game.state, rng: game.rng, queueSkill: (item: any) => queued.push(item),
      askSkill: (item: any) => requests.push(item), dispatch: game.dispatch.bind(game) }
    const handle = runtime.triggers?.find((trigger) => trigger.event === 'Damaged')?.handle!
    const blackSlash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀'
      && game.state.cards[id]?.suit !== 'heart' && game.state.cards[id]?.suit !== 'diamond')!
    const handBefore = owner.zones.hand.length
    handle(host, owner.id, { event: { targetId: owner.id, sourceId: source.id,
      payload: { cardName: '杀', cardId: blackSlash } } } as any)
    expect(queued).toHaveLength(1)
    runtime.startQueued?.(host, owner.id, queued[0])
    expect(owner.zones.hand).toHaveLength(handBefore + 1)

    const redSlash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀'
      && ['heart', 'diamond'].includes(game.state.cards[id]?.suit ?? ''))!
    handle(host, owner.id, { event: { targetId: owner.id, sourceId: source.id,
      payload: { cardName: '杀', cardId: redSlash } } } as any)
    expect(queued).toHaveLength(2)
    runtime.startQueued?.(host, owner.id, queued[1])
    expect(requests[0].build('yaowu-choice')).toMatchObject({ kind: 'choose-option', playerId: source.id,
      options: [{ id: 'recover' }, { id: 'draw' }] })
    runtime.resume?.(host, owner.id, { step: 'red-choice', data: { sourceId: source.id } } as any,
      { payload: { optionId: 'recover' } } as any)
    expect(source.hp).toBe(source.maxHp)
  })
})

describe('第48批 谋·华雄【扬威】', () => {
  it('威标记期间提供额外出杀次数、无距离限制，并只在【杀】结算期间压制目标防具', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-mou-huaxiong-yangwei', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]
    owner.characterId = B48_MOU_HUAXIONG.id
    owner.marks['yangwei-b48:mark'] = 1
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const runtime = getSkillRuntime(B48_MOU_HUAXIONG.skills[1].id)!
    expect(runtime.globalSlashUses?.(game.state, owner.id, owner.id)).toBe(1)
    expect(runtime.slashIgnoresDistance?.(game.state, owner.id)).toBe(true)
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const target = game.state.players[1]
    const usedTrigger = runtime.triggers?.find((trigger) => trigger.event === 'CardUsed')!
    usedTrigger.handle({ state: game.state } as any, owner.id, { event: { sourceId: owner.id,
      payload: { cardName: '杀', cardId: slashId, targetIds: [target.id] } } } as any)
    expect(isArmorSuppressed(game.state, target.id, owner.id, slashId)).toBe(true)
    expect(isArmorSuppressed(game.state, target.id, owner.id, 'another-card')).toBe(false)
    expect(isArmorSuppressed(game.state, target.id, owner.id)).toBe(false)
    expect(isArmorSuppressed(game.state, game.state.players[2].id, owner.id, slashId)).toBe(false)
    runtime.triggers?.find((trigger) => trigger.event === 'AfterCardUse')!.handle({ state: game.state } as any,
      owner.id, { event: { sourceId: owner.id, payload: { cardId: slashId } } } as any)
    expect(isArmorSuppressed(game.state, target.id, owner.id, slashId)).toBe(false)
    game.state.phase = 'draw'
    expect(runtime.slashIgnoresDistance?.(game.state, owner.id)).toBe(false)
  })
})

describe('第48批 谋·于禁【狭援】【节钺】', () => {
  it('狭援只在伤害耗尽护甲后支付两张手牌并返还本次失去的护甲', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-xiayuan', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, target] = game.state.players
    owner.characterId = B48_MOU_YUJIN.id
    target.armorPoints = 0
    const costs = game.state.zones.drawPile.slice(0, 2)
    for (const cardId of costs) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const queued: any[] = []
    const requests: any[] = []
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game),
      queueSkill: (item: any) => queued.push(item), askSkill: (item: any) => requests.push(item) }
    const runtime = getSkillRuntime(B48_MOU_YUJIN.skills[0].id)!
    runtime.triggers?.[0].handle(host, owner.id, { event: { targetId: target.id,
      payload: { armorLost: 2, armorAfter: 0 } } } as any)
    runtime.startQueued?.(host, owner.id, queued[0])
    expect(requests[0].build('xiayuan-cost')).toMatchObject({ playerId: owner.id, min: 0, max: 2 })
    runtime.resume?.(host, owner.id, { step: 'cost', data: queued[0].data } as any,
      { payload: { cardIds: costs } } as any)
    expect(target.armorPoints).toBe(2)
    expect(costs.every((cardId) => game.state.zones.discardPile.includes(cardId))).toBe(true)
  })

  it('节钺先给目标护甲，再由目标自己决定是否交牌', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-jieyue', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, target] = game.state.players
    owner.characterId = B48_MOU_YUJIN.id
    const givenCard = game.state.zones.drawPile[0]
    moveCard(game.state, givenCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const queued: any[] = []
    const requests: any[] = []
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game),
      queueSkill: (item: any) => queued.push(item), askSkill: (item: any) => requests.push(item) }
    const runtime = getSkillRuntime(B48_MOU_YUJIN.skills[1].id)!
    runtime.triggers?.[0].handle(host, owner.id, { event: { payload: { playerId: owner.id, phase: 'finish' } } } as any)
    runtime.startQueued?.(host, owner.id, queued[0])
    runtime.resume?.(host, owner.id, { step: 'target', data: {} } as any,
      { payload: { targetIds: [target.id] } } as any)
    expect(target.armorPoints).toBe(1)
    expect(requests.at(-1).build('jieyue-give')).toMatchObject({ playerId: target.id, optional: true, min: 0, max: 1 })
    runtime.resume?.(host, owner.id, { step: 'give', data: { targetId: target.id } } as any,
      { payload: { cardIds: [givenCard] } } as any)
    expect(target.zones.hand).not.toContain(givenCard)
    expect(owner.zones.hand).toContain(givenCard)
  })
})

describe('第48批 谋·吕蒙【克己】【渡江】【夺荆】', () => {
  it('夺荆支付护甲、绑定本次杀的防具压制、取得目标手牌并增加本阶段出杀次数', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-duojing', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, target] = game.state.players
    owner.characterId = B48_MOU_LVMENG.id
    owner.armorPoints = 2
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const stolen = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name !== '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'processingArea' })
    moveCard(game.state, stolen, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const requests: any[] = []
    let resumed = 0
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game),
      askSkill: (request: any) => requests.push(request), resumeCardTarget: () => { resumed += 1 } }
    const runtime = getSkillRuntime(B48_MOU_LVMENG.skills[2].id)!
    expect(runtime.interceptSourceTargetEach?.(host, owner.id, { sourceId: owner.id, targetId: target.id,
      cardId: slash, cardName: '杀', category: 'basic' })).toBe(true)
    runtime.resume?.(host, owner.id, { step: 'activate', data: { cardId: slash, targetId: target.id } } as any,
      { payload: { optionId: 'yes' } } as any)
    runtime.resume?.(host, owner.id, { step: 'take-card', data: { cardId: slash, targetId: target.id } } as any,
      { payload: { cardIds: [stolen] } } as any)
    expect(owner.armorPoints).toBe(1)
    expect(owner.zones.hand).toContain(stolen)
    expect(target.zones.hand).not.toContain(stolen)
    expect(runtime.globalSlashUses?.(game.state, owner.id, owner.id)).toBe(1)
    expect(resumed).toBe(1)
  })
})

describe('第48批 界·顾雍【慎行】【秉壹】', () => {
  it('慎行真实弃置两张牌，异色摸两张，并按当前体力值限制本阶段次数', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-guyong-shenxing', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]
    owner.characterId = B48_JIE_GUYONG.id
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const firstCost = game.state.zones.drawPile[0]
    const secondCost = game.state.zones.drawPile.find((id) => game.state.cards[id]?.color !== game.state.cards[firstCost]?.color)!
    const costs = [firstCost, secondCost]
    for (const cardId of costs) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const queued: any[] = []
    const requests: any[] = []
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game),
      queueSkill: (item: any) => queued.push(item), askSkill: (item: any) => requests.push(item) }
    const runtime = getSkillRuntime(B48_JIE_GUYONG.skills[0].id)!
    expect(runtime.activeActions?.(game.state, owner.id)).toHaveLength(1)
    runtime.invokeActive?.(host, owner.id, B48_JIE_GUYONG.skills[0].id)
    const request = requests[0].build('shenxing-discard')
    expect(request).toMatchObject({ kind: 'choose-cards', optional: false, min: 2, max: 2 })
    expect(request.hiddenCardSlots).toHaveLength(owner.zones.hand.length)
    const handBefore = owner.zones.hand.length
    const drawBefore = game.state.zones.drawPile.length
    runtime.resume?.(host, owner.id, { step: 'discard', data: { count: 0 } } as any,
      { payload: { cardIds: request.hiddenCardSlots.slice(0, 2) } } as any)
    expect(costs.every((cardId) => game.state.zones.discardPile.includes(cardId))).toBe(true)
    expect(owner.marks['shenxing-jie-guyong-b48:uses']).toBe(1)
    expect(owner.zones.hand).toHaveLength(handBefore)
    expect(game.state.zones.drawPile).toHaveLength(drawBefore - 2)
    expect(runtime.activeActions?.(game.state, owner.id)).toHaveLength(1)
  })

  it('秉壹先选择发动并公开展示手牌，再按手牌数上限令自选存活角色各摸一张', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-guyong-bingyi', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, target] = game.state.players
    owner.characterId = B48_JIE_GUYONG.id
    const revealCards = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.color === 'red').slice(0, 2)
    for (const cardId of revealCards) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const queued: any[] = []
    const requests: any[] = []
    const publicEvents: any[] = []
    const host: any = { state: game.state, rng: game.rng,
      dispatch: (name: string, payload: any, metadata?: any) => {
        publicEvents.push({ name, payload, metadata })
        return game.dispatch(name, payload, metadata)
      },
      queueSkill: (item: any) => queued.push(item), askSkill: (item: any) => requests.push(item) }
    const runtime = getSkillRuntime(B48_JIE_GUYONG.skills[1].id)!
    runtime.triggers?.find((trigger) => trigger.event === 'PhaseStart')!.handle(host, owner.id,
      { event: { payload: { playerId: owner.id, phase: 'finish' } } } as any)
    expect(queued[0]).toMatchObject({ step: 'invoke' })
    runtime.startQueued?.(host, owner.id, queued[0])
    expect(requests[0].build('bingyi-invoke')).toMatchObject({ kind: 'choose-option', optional: false })
    runtime.resume?.(host, owner.id, { step: 'invoke', data: {} } as any,
      { payload: { optionId: 'yes' } } as any)
    expect(queued.at(-1)).toMatchObject({ step: 'targets', data: { maxTargets: owner.zones.hand.length } })
    expect(publicEvents.some(({ name, payload }) => name === 'SkillActivated'
      && payload.skillId === B48_JIE_GUYONG.skills[1].id
      && payload.shownCardIds.length === revealCards.length)).toBe(true)
    runtime.startQueued?.(host, owner.id, queued.at(-1))
    const drawBefore = game.state.zones.drawPile.length
    const targetHandBefore = target.zones.hand.length
    runtime.resume?.(host, owner.id, { step: 'targets', data: { maxTargets: revealCards.length } } as any,
      { payload: { targetIds: [target.id] } } as any)
    expect(game.state.zones.drawPile).toHaveLength(drawBefore - 1)
    expect(target.zones.hand).toHaveLength(targetHandBefore + 1)
  })
})

describe('第48批 毛玠【秉清】', () => {
  it('记录本阶段每种花色一次；第三种花色只允许选择有可弃区域牌的目标', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-maojie-bingqing', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, , cardTarget] = game.state.players
    owner.characterId = B48_MAO_JIE.id
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    for (const player of game.state.players.filter((candidate) => candidate.id !== cardTarget.id)) {
      for (const cardId of [...player.zones.hand])
        moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
      for (const [slot, cardId] of Object.entries(player.zones.equipment))
        if (cardId) moveCard(game.state, cardId, { kind: 'equipment', playerId: player.id, slot }, { kind: 'discardPile' })
      for (const cardId of [...player.zones.judgingArea])
        moveCard(game.state, cardId, { kind: 'judgingArea', playerId: player.id }, { kind: 'discardPile' })
    }
    const suits = new Set<string>()
    const recordCards = game.state.zones.drawPile.filter((id) => {
      const suit = game.state.cards[id]?.suit
      if (!suit || suits.has(suit)) return false
      suits.add(suit)
      return true
    }).slice(0, 3)
    const targetCard = game.state.zones.drawPile.find((id) => !recordCards.includes(id))!
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: cardTarget.id })
    const requests: any[] = []
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game),
      askSkill: (item: any) => requests.push(item) }
    const runtime = getSkillRuntime(B48_MAO_JIE.skills[0].id)!
    const afterUse = runtime.triggers?.find((trigger) => trigger.event === 'AfterCardUse')!
    for (const cardId of recordCards) afterUse.handle(host, owner.id,
      { event: { sourceId: owner.id, payload: { cardId } } } as any)
    const targetRequest = requests.at(-1).build('mao-jie-target')
    expect(targetRequest).toMatchObject({ kind: 'choose-targets', max: 1 })
    expect(targetRequest.candidateIds).toEqual([cardTarget.id])
    runtime.resume?.(host, owner.id, { step: 'effect', data: { count: 3 } } as any,
      { payload: { targetIds: [cardTarget.id] } } as any)
    const discardRequest = requests.at(-1).build('mao-jie-discard')
    expect(discardRequest).toMatchObject({ kind: 'choose-cards', playerId: owner.id, min: 0, max: 1 })
    expect(discardRequest.hiddenCardSlots).toHaveLength(1)
    runtime.resume?.(host, owner.id, { step: 'discard', data: { targetId: cardTarget.id } } as any,
      { payload: { cardIds: discardRequest.hiddenCardSlots } } as any)
    expect(game.state.zones.discardPile).toContain(targetCard)
    expect(cardTarget.zones.hand).not.toContain(targetCard)
    const expectedMask = recordCards.reduce((mask, id) => mask | ({ spade: 1, heart: 2, club: 4, diamond: 8 } as Record<string, number>)[game.state.cards[id]!.suit!] , 0)
    expect(owner.marks['bingqing-maojie-b48:suits']).toBe(expectedMask)
  })
})

describe('第48批 蒋琬·改【镇庭】【尽瘁】', () => {
  it('镇庭非背水分支摸牌，并按整局每回合一次记录发动次数', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-jiangwan-zhenting-draw', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [source, target, owner] = game.state.players
    owner.characterId = B48_JIANGWAN_GAI.id
    game.state.turnNumber = 3
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    game.state.cardResolution = { kind: 'slash', cardId, sourceId: source.id, targetId: target.id,
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-intercept', requestId: null,
      surrogate: null, interceptsDone: [], extraCardIds: [], remainingTargetIds: [], dodgeRemaining: 1 } as any
    const requests: any[] = []
    let resumed = 0
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game),
      askSkill: (item: any) => requests.push(item), resumeCardTarget: () => { resumed += 1 } }
    const runtime = getSkillRuntime(B48_JIANGWAN_GAI.skills[0].id)!
    expect(runtime.interceptBystanderTarget?.(host, owner.id, { sourceId: source.id, targetId: target.id,
      cardId, cardName: '杀', category: 'basic' })).toBe(true)
    expect(requests[0].build('zhenting-mode')).toMatchObject({ kind: 'choose-option', optional: false })
    const drawBefore = game.state.zones.drawPile.length
    runtime.resume?.(host, owner.id, { step: 'mode', data: requests[0].data } as any,
      { payload: { optionId: 'draw' } } as any)
    expect(requests.at(-1).build('zhenting-backwater')).toMatchObject({ kind: 'choose-option', optional: true })
    runtime.resume?.(host, owner.id, { step: 'backwater', data: requests.at(-1).data } as any,
      { payload: { optionId: 'no' } } as any)
    expect(owner.zones.hand).toHaveLength(1)
    expect(game.state.zones.drawPile).toHaveLength(drawBefore - 1)
    expect(owner.marks['zhenting-jiangwan-revised-b48:turn']).toBe(3)
    expect(owner.marks['zhenting-jiangwan-revised-b48:count']).toBe(1)
    expect(resumed).toBe(1)
  })

  it('镇庭背水把当前锦囊目标替换为蒋琬，并从新目标重新进入结算', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-jiangwan-zhenting-backwater', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [source, target, owner] = game.state.players
    owner.characterId = B48_JIANGWAN_GAI.id
    game.state.turnNumber = 4
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '闪电')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    game.state.cardResolution = { kind: 'trick', cardId, cardName: '闪电', sourceId: source.id,
      targetIds: [target.id], targetIndex: 0, nullifiedTargetIds: [], cancelledTargetIds: [],
      unresponsiveTargetIds: [], interceptsDone: [], stage: 'awaiting-intercept', responderOrder: [],
      responderIndex: 0, nullificationCount: 0, declinedAllIds: [], lastNullifierId: null,
      requestId: null, effect: null }
    const requests: any[] = []
    let resumed = 0
    const host: any = { state: game.state, rng: game.rng, dispatch: game.dispatch.bind(game),
      askSkill: (item: any) => requests.push(item), resumeCardTarget: () => { resumed += 1 } }
    const runtime = getSkillRuntime(B48_JIANGWAN_GAI.skills[0].id)!
    expect(runtime.interceptBystanderTarget?.(host, owner.id, { sourceId: source.id, targetId: target.id,
      cardId, cardName: '闪电', category: 'trick' })).toBe(true)
    runtime.resume?.(host, owner.id, { step: 'mode', data: requests[0].data } as any,
      { payload: { optionId: 'draw' } } as any)
    runtime.resume?.(host, owner.id, { step: 'backwater', data: requests.at(-1).data } as any,
      { payload: { optionId: 'yes' } } as any)
    expect((game.state.cardResolution as any).targetIds).toEqual([owner.id])
    expect((game.state.cardResolution as any).interceptsDone).toEqual([])
    expect(resumed).toBe(1)
  })

  it('镇庭背水改写真实杀结算目标，并重新向蒋琬请求闪', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-jiangwan-slash-backwater', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [source, target, owner] = game.state.players
    owner.characterId = B48_JIANGWAN_GAI.id
    game.state.status = 'playing'
    game.state.turnNumber = 5
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    game.state.cardResolution = { kind: 'slash', cardId, sourceId: source.id, targetId: target.id,
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-intercept', requestId: null,
      surrogate: null, interceptsDone: [], extraCardIds: [], remainingTargetIds: [], dodgeRemaining: 1 } as any
    const confirmedTargetIds: string[] = []
    game.events.on('TargetConfirmed', ({ event }) => {
      const payload = event.payload as { targetId?: string }
      if (event.sourceId === source.id) confirmedTargetIds.push(payload.targetId ?? '')
    })
    const runtime = getSkillRuntime(B48_JIANGWAN_GAI.skills[0].id)!
    expect(runtime.interceptBystanderTarget?.(game as any, owner.id, { sourceId: source.id, targetId: target.id,
      cardId, cardName: '杀', category: 'basic' })).toBe(true)
    let request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'draw' } })
    request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'yes' } })
    expect((game.state.cardResolution as any).targetId).toBe(owner.id)
    expect(game.state.pendingRequests[0]).toMatchObject({ kind: 'respond-card', playerId: owner.id })
    expect(confirmedTargetIds).toContain(owner.id)
  })

  it('镇庭拦截延时锦囊目标流程，背水后实体牌实际进入蒋琬判定区', () => {
    const game = new SanguoshaGame({ seed: 'historical-b48-jiangwan-delayed-trick', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [source, target, owner] = game.state.players
    owner.characterId = B48_JIANGWAN_GAI.id
    game.state.status = 'playing'
    game.state.currentPlayerId = source.id
    game.state.phase = 'play'
    game.state.turnNumber = 2
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '乐不思蜀')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: source.id })
    const action = game.legalActions(source.id).find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(cardId) && candidate.targetIds.includes(target.id))
    expect(action?.kind).toBe('use-card')
    const runtime = getSkillRuntime(B48_JIANGWAN_GAI.skills[0].id)!
    expect(runtime.interceptPlayAction?.(game as any, owner.id, action as any)).toBe(true)
    let request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-option', playerId: owner.id })
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'draw' } })
    request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-option', playerId: owner.id })
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'yes' } })
    expect(owner.zones.judgingArea).toContain(cardId)
    expect(target.zones.judgingArea).not.toContain(cardId)
    expect(owner.marks['zhenting-jiangwan-revised-b48:count']).toBe(1)
  })

  it('尽瘁完整交换座位并失去体力；失去体力数不为正时增加体力上限并永久失去背水选项', () => {
    const makeGame = () => new SanguoshaGame({ seed: 'historical-b48-jiangwan-jincui', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const runtime = getSkillRuntime(B48_JIANGWAN_GAI.skills[1].id)!
    const first = makeGame()
    const [owner, target] = first.state.players
    owner.characterId = B48_JIANGWAN_GAI.id
    owner.hp = 3
    owner.maxHp = 3
    first.state.phase = 'play'
    first.state.currentPlayerId = owner.id
    owner.marks['zhenting-jiangwan-revised-b48:count'] = 1
    const firstRequests: any[] = []
    const firstHost: any = { state: first.state, rng: first.rng, dispatch: first.dispatch.bind(first),
      askSkill: (item: any) => firstRequests.push(item) }
    runtime.invokeActive?.(firstHost, owner.id, B48_JIANGWAN_GAI.skills[1].id)
    runtime.resume?.(firstHost, owner.id, { step: 'target', data: {} } as any,
      { payload: { targetIds: [target.id] } } as any)
    expect(first.state.players.map((player) => player.id).slice(0, 2)).toEqual([target.id, owner.id])
    expect(owner.hp).toBe(1)
    expect(owner.usedLimitedSkills).toContain(B48_JIANGWAN_GAI.skills[1].id)

    const second = makeGame()
    const secondOwner = second.state.players[0]
    const secondTarget = second.state.players[1]
    secondOwner.characterId = B48_JIANGWAN_GAI.id
    secondOwner.hp = 3
    secondOwner.maxHp = 3
    second.state.phase = 'play'
    second.state.currentPlayerId = secondOwner.id
    secondOwner.marks['zhenting-jiangwan-revised-b48:count'] = secondOwner.hp
    const secondHost: any = { state: second.state, rng: second.rng, dispatch: second.dispatch.bind(second),
      askSkill: () => undefined }
    runtime.invokeActive?.(secondHost, secondOwner.id, B48_JIANGWAN_GAI.skills[1].id)
    runtime.resume?.(secondHost, secondOwner.id, { step: 'target', data: {} } as any,
      { payload: { targetIds: [secondTarget.id] } } as any)
    expect(secondOwner.maxHp).toBe(4)
    expect(secondOwner.hp).toBe(3)
    expect(secondOwner.marks['zhenting-jiangwan-revised-b48:no-backwater']).toBe(1)
  })
})
