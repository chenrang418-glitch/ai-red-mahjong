import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { B49_JIE_CAIFUREN, B49_JIE_SUNLUBAN, B49_MOU_XUHUANG, B49_XING_HUANGZHONG } from '@/sanguosha/data/characters/historical-batch49'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'

function fixture() {
  const game = new SanguoshaGame({ seed: 'b49-qieting', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const [owner, target] = game.state.players
  owner.characterId = B49_JIE_CAIFUREN.id
  return { game, owner, target, runtime: getSkillRuntime(B49_JIE_CAIFUREN.skills[0].id)! }
}

describe('第49批 界·蔡夫人【窃听】', () => {
  it('仅在目标回合未对其他角色造成伤害后排队；自伤不算对其他角色造成伤害', () => {
    const { game, owner, target, runtime } = fixture()
    const turnNumber = game.state.turnNumber
    runtime.triggers?.find((trigger) => trigger.event === 'TurnEnd')?.handle(game, owner.id, {
      event: { payload: { playerId: target.id, turnNumber } },
    } as never)
    expect(game.state.skillQueue).toHaveLength(1)

    game.state.skillQueue.length = 0
    game.state.damageHistory = [{ sourceId: target.id, targetId: target.id, turnNumber }]
    runtime.triggers?.find((trigger) => trigger.event === 'TurnEnd')?.handle(game, owner.id, {
      event: { payload: { playerId: target.id, turnNumber } },
    } as never)
    expect(game.state.skillQueue).toHaveLength(1)

    game.state.skillQueue.length = 0
    game.state.damageHistory.push({ sourceId: target.id, targetId: owner.id, turnNumber })
    runtime.triggers?.find((trigger) => trigger.event === 'TurnEnd')?.handle(game, owner.id, {
      event: { payload: { playerId: target.id, turnNumber } },
    } as never)
    expect(game.state.skillQueue).toHaveLength(0)
  })

  it('目标已死亡仍可触发回合结束效果，且无可选牌时仍保留摸牌选项', () => {
    const { game, owner, target, runtime } = fixture()
    target.alive = false
    const turnNumber = game.state.turnNumber
    runtime.triggers?.find((trigger) => trigger.event === 'TurnEnd')?.handle(game, owner.id, {
      event: { payload: { playerId: target.id, turnNumber } },
    } as never)
    const queued = game.state.skillQueue[0]
    expect(queued).toMatchObject({ skillId: B49_JIE_CAIFUREN.skills[0].id, ownerId: owner.id, step: 'choose' })

    const requests: unknown[] = []
    runtime.startQueued?.({ ...game, askSkill: (options: { build: (id: string) => unknown }) => requests.push(options.build('qieting-test')) } as never,
      owner.id, queued)
    const request = requests.at(-1)
    expect(request).toMatchObject({ kind: 'choose-option', playerId: owner.id, options: [{ id: 'draw' }] })
  })

  it('从目标装备区移入同槽位时替换原装备并保留完整牌区归属', () => {
    const { game, owner, target, runtime } = fixture()
    const weapon = game.state.zones.drawPile.find((id) => game.state.cards[id]?.equipmentSlot === 'weapon')!
    moveCard(game.state, weapon, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot: 'weapon' })
    runtime.resume?.(game, owner.id, { step: 'take-equipment', data: { targetId: target.id } } as never,
      { payload: { cardIds: [weapon] } } as never)
    expect(owner.zones.equipment.weapon).toBe(weapon)
    expect(target.zones.equipment.weapon).toBeNull()
    expect(game.state.zones.drawPile).not.toContain(weapon)
  })

  it('作为正式角色登记且技能描述与两项技能唯一对应', () => {
    expect(ALL_CHARACTERS.find((character) => character.id === B49_JIE_CAIFUREN.id)).toMatchObject({
      name: '界·蔡夫人', skills: [{ name: '窃听' }, { name: '献州' }],
    })
  })
})

describe('第49批 星·黄忠', () => {
  function starFixture() {
    const game = new SanguoshaGame({ seed: 'b49-star-huangzhong', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, target] = game.state.players
    owner.characterId = B49_XING_HUANGZHONG.id
    const skill = (name: string) => getSkillRuntime(B49_XING_HUANGZHONG.skills.find((entry) => entry.name === name)!.id)!
    return { game, owner, target, shidi: skill('势敌'), yishi: skill('义释'), qishe: skill('骑射') }
  }

  it('势敌初始为阳，阶段切换正确影响距离与杀的响应', () => {
    const { game, owner, target, shidi } = starFixture()
    expect(shidi.distanceModifier?.toOthers).toBeTypeOf('function')
    expect((shidi.distanceModifier!.toOthers as Function)(game.state, owner.id)).toBe(-1)
    owner.marks['b49-xing-huangzhong-yang'] = 0
    expect((shidi.distanceModifier!.fromOthers as Function)(game.state, owner.id)).toBe(1)

    const redSlash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀' && game.state.cards[id]?.color === 'red')!
    game.state.cardResolution = { kind: 'slash', cardId: redSlash, sourceId: target.id, targetId: owner.id,
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-dodge', interceptsDone: [], extraCardIds: [],
      remainingTargetIds: [], requestId: null, dodgeRemaining: 1, surrogate: null }
    expect(shidi.prohibitsCardResponse?.(game.state, owner.id, owner.id, '闪')).toBe(true)
    game.state.cardResolution = null
    owner.marks['b49-xing-huangzhong-yang'] = 1
    const blackSlash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀' && game.state.cards[id]?.color === 'black')!
    game.state.cardResolution = { kind: 'slash', cardId: blackSlash, sourceId: owner.id, targetId: target.id,
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-dodge', interceptsDone: [], extraCardIds: [],
      remainingTargetIds: [], requestId: null, dodgeRemaining: 1, surrogate: null }
    expect(shidi.prohibitsCardResponse?.(game.state, owner.id, target.id, '闪')).toBe(true)
  })

  it('义释获得装备，并在完整伤害流程中只减少1点伤害', () => {
    const { game, owner, target, yishi } = starFixture()
    game.state.status = 'playing'
    const equipment = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    const slot = game.state.cards[equipment]!.equipmentSlot!
    moveCard(game.state, equipment, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot })

    resolveDamage(game, { sourceId: owner.id, targetId: target.id, amount: 2, nature: 'normal' })
    expect(game.state.pendingDamageModifier?.skillId).toBe(B49_XING_HUANGZHONG.skills[1].id)
    const invokeRequest = game.state.skillResolution!
    game.state.skillResolution = null
    yishi.resume?.(game, owner.id, invokeRequest, { payload: { optionId: 'yes' } } as never)
    const equipmentRequest = game.state.skillResolution!
    expect(equipmentRequest.step).toBe('take-equipment')
    yishi.resume?.(game, owner.id, equipmentRequest, { payload: { cardIds: [equipment] } } as never)

    expect(target.hp).toBe(3)
    expect(owner.zones.hand).toContain(equipment)
    expect(Object.values(target.zones.equipment)).not.toContain(equipment)
    expect(game.state.pendingDamageModifier).toBeUndefined()
  })

  it('骑射能把装备区实体牌当酒使用，且手牌上限加成等于装备数', () => {
    const { game, owner, qishe } = starFixture()
    const equipment = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    const slot = game.state.cards[equipment]!.equipmentSlot!
    moveCard(game.state, equipment, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot })
    expect(qishe.viewAs?.(game.state, owner.id)).toContainEqual(expect.objectContaining({ cardId: equipment, asCardName: '酒' }))
    expect(qishe.maxCardsBonus?.(game.state, owner.id)).toBe(1)

    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    qishe.resume?.(game, owner.id, { step: 'use-equipment', data: {} } as never, { payload: { cardIds: [equipment] } } as never)
    expect(owner.zones.equipment[slot]).toBeNull()
    expect(game.state.zones.discardPile).toContain(equipment)
    expect(game.state.turnUsage.wineUses).toBe(1)
    expect(qishe.activeActions?.(game.state, owner.id)).toEqual([])
  })
})

describe('第49批 界·孙鲁班', () => {
  function sunlubanFixture() {
    const game = new SanguoshaGame({ seed: 'b49-jie-sunluban', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const [owner, target, , , candidate] = game.state.players
    owner.characterId = B49_JIE_SUNLUBAN.id
    target.characterId = 'caocao'
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const runtime = (name: string) => getSkillRuntime(B49_JIE_SUNLUBAN.skills.find((skill) => skill.name === name)!.id)!
    return { game, owner, target, candidate, zanhui: runtime('谮毁'), jiaojin: runtime('骄矜') }
  }

  it('谮毁可由其获得被选角色的牌，并由该角色接续使用原实体牌', () => {
    const { game, owner, target, candidate, zanhui } = sunlubanFixture()
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const gift = game.state.zones.drawPile.find((id) => id !== slash && game.state.cards[id]?.category !== 'equipment')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, gift, { kind: 'drawPile' }, { kind: 'hand', playerId: candidate.id })
    const action = { id: 'play:test-slash', kind: 'use-card', playerId: owner.id, cardIds: [slash],
      targetIds: [target.id], targetMin: 1, targetMax: 1, asCardName: '杀', label: '测试【杀】' } as const

    expect(zanhui.interceptPlayAction?.(game, owner.id, action as never)).toBe(true)
    let pending = game.state.skillResolution!
    game.state.skillResolution = null
    zanhui.resume?.(game, owner.id, pending, { payload: { optionId: 'yes' } } as never)
    pending = game.state.skillResolution!
    expect(pending.step).toBe('choose-c')
    game.state.skillResolution = null
    zanhui.resume?.(game, owner.id, pending, { payload: { targetIds: [candidate.id] } } as never)
    pending = game.state.skillResolution!
    expect(pending.step).toBe('c-choice')
    game.state.skillResolution = null
    zanhui.resume?.(game, owner.id, pending, { payload: { optionId: 'replace' } } as never)
    pending = game.state.skillResolution!
    const pickRequest = game.state.pendingRequests.find((request) => request.id === pending.requestId)
    const hidden = pickRequest?.kind === 'choose-cards' ? pickRequest.hiddenCardSlots[0] : undefined
    expect(hidden).toBeTruthy()
    game.state.skillResolution = null
    zanhui.resume?.(game, owner.id, pending, { payload: { cardIds: [hidden] } } as never)

    expect(owner.zones.hand).toContain(gift)
    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', cardId: slash, sourceId: candidate.id, targetId: target.id })
  })

  it('谮毁的另一选项把所选角色加入目标，而由孙鲁班继续使用原牌', () => {
    const { game, owner, target, candidate, zanhui } = sunlubanFixture()
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const action = { id: 'play:test-slash-target', kind: 'use-card', playerId: owner.id, cardIds: [slash],
      targetIds: [target.id], targetMin: 1, targetMax: 1, asCardName: '杀', label: '测试【杀】' } as const

    expect(zanhui.interceptPlayAction?.(game, owner.id, action as never)).toBe(true)
    let pending = game.state.skillResolution!
    game.state.skillResolution = null
    zanhui.resume?.(game, owner.id, pending, { payload: { optionId: 'yes' } } as never)
    pending = game.state.skillResolution!
    game.state.skillResolution = null
    zanhui.resume?.(game, owner.id, pending, { payload: { targetIds: [candidate.id] } } as never)
    pending = game.state.skillResolution!
    game.state.skillResolution = null
    zanhui.resume?.(game, owner.id, pending, { payload: { optionId: 'target' } } as never)

    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', cardId: slash, sourceId: owner.id, targetId: target.id })
    expect(game.state.cardResolution?.remainingTargetIds).toContain(candidate.id)
  })

  it('骄矜弃置装备后防止完整伤害值，而非仅减少1点', () => {
    const { game, owner, target, jiaojin } = sunlubanFixture()
    const equipment = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    moveCard(game.state, equipment, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const hp = owner.hp
    resolveDamage(game, { sourceId: target.id, targetId: owner.id, amount: 2, nature: 'normal' })
    expect(game.state.pendingTargetDamage?.skillId).toBe(B49_JIE_SUNLUBAN.skills[1].id)
    let pending = game.state.skillResolution!
    game.state.skillResolution = null
    jiaojin.resume?.(game, owner.id, pending, { payload: { optionId: 'yes' } } as never)
    pending = game.state.skillResolution!
    expect(pending.step).toBe('discard')
    game.state.skillResolution = null
    jiaojin.resume?.(game, owner.id, pending, { payload: { cardIds: [equipment] } } as never)
    expect(owner.hp).toBe(hp)
    expect(game.state.zones.discardPile).toContain(equipment)
    expect(game.state.pendingTargetDamage).toBeUndefined()
  })

  it('正式登记为界版角色且技能运行时与基础版隔离', () => {
    expect(ALL_CHARACTERS.find((character) => character.id === B49_JIE_SUNLUBAN.id)).toMatchObject({
      name: '界·孙鲁班', skills: [{ name: '谮毁' }, { name: '骄矜' }],
    })
    expect(B49_JIE_SUNLUBAN.skills.every((skill) => getSkillRuntime(skill.id))).toBe(true)
  })
})

describe('第49批 谋·徐晃', () => {
  function fixture() {
    const game = new SanguoshaGame({ seed: 'b49-mou-xuhuang', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index < 2 })),
    } })
    const [owner, target] = game.state.players
    owner.characterId = B49_MOU_XUHUANG.id
    target.characterId = 'caocao'
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const runtime = (name: string) => getSkillRuntime(B49_MOU_XUHUANG.skills.find((skill) => skill.name === name)!.id)!
    return { game, owner, target, duanliang: runtime('断粮'), shipo: runtime('势迫') }
  }

  function resolveMouyi(game: SanguoshaGame, ownerId: string, targetId: string, ownerChoice: string, targetChoice: string) {
    const ownerRequest = game.state.pendingRequests.find((request) => request.playerId === ownerId)!
    const targetRequest = game.state.pendingRequests.find((request) => request.playerId === targetId)!
    game.respond({ requestId: ownerRequest.id, playerId: ownerId, payload: { optionId: ownerChoice } } as never)
    game.respond({ requestId: targetRequest.id, playerId: targetId, payload: { optionId: targetChoice } } as never)
  }

  it('断粮以双方同时秘密提交的不同选项判定谋弈成功，并把牌堆顶牌无距离当兵粮寸断使用', () => {
    const { game, owner, target, duanliang } = fixture()
    const topCard = game.state.zones.drawPile[0]
    const actionId = `skill:${B49_MOU_XUHUANG.skills[0].id}`
    expect(duanliang.activeActions?.(game.state, owner.id)).toContainEqual(expect.objectContaining({ id: actionId }))
    duanliang.invokeActive?.(game as never, owner.id, actionId)
    const chooseTarget = game.state.pendingRequests.find((request) => request.kind === 'choose-targets')!
    game.respond({ requestId: chooseTarget.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    expect(game.state.groupDecision?.playerIds).toEqual([owner.id, target.id])
    expect(game.state.pendingRequests.filter((request) => request.kind === 'choose-option')).toHaveLength(2)

    resolveMouyi(game, owner.id, target.id, 'siege', 'advance')

    expect(target.zones.judgingArea).toContain(topCard)
    expect(owner.zones.hand).not.toContain(topCard)
  })

  it('断粮双方选择相同策略时谋弈失败且不移动牌堆顶牌', () => {
    const { game, owner, target, duanliang } = fixture()
    const topCard = game.state.zones.drawPile[0]
    duanliang.invokeActive?.(game as never, owner.id, `skill:${B49_MOU_XUHUANG.skills[0].id}`)
    const chooseTarget = game.state.pendingRequests.find((request) => request.kind === 'choose-targets')!
    game.respond({ requestId: chooseTarget.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    resolveMouyi(game, owner.id, target.id, 'siege', 'siege')
    expect(game.state.zones.drawPile[0]).toBe(topCard)
    expect(target.zones.judgingArea).not.toContain(topCard)
  })

  it('断粮的擂鼓进军分支通过标准虚拟【决斗】结算流程发动', () => {
    const { game, owner, target, duanliang } = fixture()
    duanliang.invokeActive?.(game as never, owner.id, `skill:${B49_MOU_XUHUANG.skills[0].id}`)
    const chooseTarget = game.state.pendingRequests.find((request) => request.kind === 'choose-targets')!
    game.respond({ requestId: chooseTarget.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    resolveMouyi(game, owner.id, target.id, 'advance', 'siege')
    expect(game.state.cardResolution).toMatchObject({ kind: 'trick', sourceId: owner.id, targetIds: [target.id] })
  })

  it('断粮围城时目标已有兵粮寸断则从其手牌中秘密选择获得一张', () => {
    const { game, owner, target, duanliang } = fixture()
    const supply = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '兵粮寸断')!
    const gift = game.state.zones.drawPile.find((id) => id !== supply)!
    moveCard(game.state, supply, { kind: 'drawPile' }, { kind: 'judgingArea', playerId: target.id })
    moveCard(game.state, gift, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    duanliang.invokeActive?.(game as never, owner.id, `skill:${B49_MOU_XUHUANG.skills[0].id}`)
    const chooseTarget = game.state.pendingRequests.find((request) => request.kind === 'choose-targets')!
    game.respond({ requestId: chooseTarget.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    resolveMouyi(game, owner.id, target.id, 'siege', 'advance')
    const steal = game.state.pendingRequests.find((request) => request.kind === 'choose-cards')!
    const hidden = (steal as { hiddenCardSlots: string[] }).hiddenCardSlots[0]
    game.respond({ requestId: steal.id, playerId: owner.id, payload: { cardIds: [hidden] } } as never)
    expect(owner.zones.hand).toContain(gift)
    expect(target.zones.judgingArea).toContain(supply)
  })

  it('势迫令有兵粮寸断者秘密选择，选择伤害后只结算1点伤害', () => {
    const { game, owner, target, shipo } = fixture()
    const supply = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '兵粮寸断')!
    moveCard(game.state, supply, { kind: 'drawPile' }, { kind: 'judgingArea', playerId: target.id })
    const hp = target.hp
    shipo.startQueued?.(game as never, owner.id, { skillId: B49_MOU_XUHUANG.skills[1].id, ownerId: owner.id, step: 'invoke', data: {} } as never)
    const invoke = game.state.pendingRequests.find((request) => request.kind === 'choose-option')!
    game.respond({ requestId: invoke.id, playerId: owner.id, payload: { optionId: 'yes' } } as never)
    const scope = game.state.pendingRequests.find((request) => request.kind === 'choose-option')!
    game.respond({ requestId: scope.id, playerId: owner.id, payload: { optionId: 'all-grain' } } as never)
    expect(game.state.groupDecision).toBeNull()
    const choice = game.state.pendingRequests.find((request) => request.playerId === target.id && request.kind === 'choose-option')!
    game.respond({ requestId: choice.id, playerId: target.id, payload: { optionId: 'damage' } } as never)
    expect(target.hp).toBe(hp - 1)
  })

  it('势迫令角色按顺序选择；交手牌后徐晃可把所获牌交给一名其他角色', () => {
    const { game, owner, target, shipo } = fixture()
    const recipient = game.state.players[2]
    target.hp = owner.hp - 1
    const gift = game.state.zones.drawPile[0]
    moveCard(game.state, gift, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    shipo.startQueued?.(game as never, owner.id, { skillId: B49_MOU_XUHUANG.skills[1].id, ownerId: owner.id, step: 'invoke', data: {} } as never)
    const invoke = game.state.pendingRequests.find((request) => request.kind === 'choose-option')!
    game.respond({ requestId: invoke.id, playerId: owner.id, payload: { optionId: 'yes' } } as never)
    const scope = game.state.pendingRequests.find((request) => request.kind === 'choose-option')!
    game.respond({ requestId: scope.id, playerId: owner.id, payload: { optionId: 'weak' } } as never)
    const chooseWeak = game.state.pendingRequests.find((request) => request.kind === 'choose-targets')!
    game.respond({ requestId: chooseWeak.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    const response = game.state.pendingRequests.find((request) => request.playerId === target.id && request.kind === 'choose-option')!
    game.respond({ requestId: response.id, playerId: target.id, payload: { optionId: 'give' } } as never)
    const give = game.state.pendingRequests.find((request) => request.playerId === target.id && request.kind === 'choose-cards')!
    game.respond({ requestId: give.id, playerId: target.id, payload: { cardIds: [gift] } } as never)
    expect(owner.zones.hand).toContain(gift)
    const redistribute = game.state.pendingRequests.find((request) => request.playerId === owner.id && request.kind === 'choose-cards')!
    game.respond({ requestId: redistribute.id, playerId: owner.id, payload: { cardIds: [gift] } } as never)
    const destination = game.state.pendingRequests.find((request) => request.playerId === owner.id && request.kind === 'choose-targets')!
    game.respond({ requestId: destination.id, playerId: owner.id, payload: { targetIds: [recipient.id] } } as never)

    expect(recipient.zones.hand).toContain(gift)
    expect(owner.zones.hand).not.toContain(gift)
  })

  it('正式登记并且两个技能均有独立运行时', () => {
    expect(ALL_CHARACTERS.find((character) => character.id === B49_MOU_XUHUANG.id)).toMatchObject({
      name: '谋·徐晃', skills: [{ name: '断粮' }, { name: '势迫' }],
    })
    expect(B49_MOU_XUHUANG.skills.every((skill) => getSkillRuntime(skill.id))).toBe(true)
  })
})
