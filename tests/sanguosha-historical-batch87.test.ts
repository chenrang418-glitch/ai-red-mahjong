import { describe, expect, it, vi } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getAttackRange } from '@/sanguosha/engine/distance'
import { hasWeapon } from '@/sanguosha/engine/equipment'
import { isArmorSuppressed } from '@/sanguosha/engine/armor-suppression'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { isCardUseUnresponsiveToTarget } from '@/sanguosha/engine/skills/runtime'
import { isCardUseProhibited, isResponseCardProhibited } from '@/sanguosha/engine/skills/runtime'
import { advancePhase, resumeTurnTransition } from '@/sanguosha/engine/turn'
import { queueExtraPhaseAfterTurnEnd } from '@/sanguosha/engine/extra-phase'
import { isSkillSuppressed } from '@/sanguosha/engine/skill-suppression'
import {
  HUAN_HUAIJIN_CILI, HUAN_HUAIJIN_LIANYOU,
  LI_ZHAOYI_MINGJIE, LI_ZHAOYI_XIANFU,
  LIU_ZHEN_WUJUE, LIU_ZHEN_ZHENGU,
  XING_DONGYUN_BISHI,
  XING_DONGYUN_B87,
  XING_DONGYUN_ZHENGTING,
  XIAHOU_EN_CHIJIAN, XIAHOU_EN_SHIWU,
  WEI_ZHANG_XINGCAI_HUANGNU, WEI_ZHANG_XINGCAI_XIANKUANG,
  WEI_ZHANG_XINGCAI_B87,
  XING_XIAHOU_BA_WEIGU, XING_XIAHOU_BA_JUEFA, XING_XIAHOU_BA_B87,
  SHEN_CAO_PI_YINZHI,
  SHEN_CAO_PI_KEMING,
  LE_CAO_ZHI_FULE, LE_CAO_ZHI_WENLAN, LE_CAO_ZHI_B87,
  WEI_MA_TENG_HEQI, WEI_MA_TENG_HUIRUI, WEI_MA_TENG_XIAOBEN, WEI_MA_TENG_B87,
  HISTORICAL_BATCH87_CHARACTERS,
} from '@/sanguosha/data/characters/historical-batch87'
import { moveCard } from '@/sanguosha/engine/zones'
import { abolishSlot } from '@/sanguosha/engine/equipment-slots'
import { legalPlayActions } from '@/sanguosha/engine/cards/basic'
import { getCharacter } from '@/sanguosha/data/characters/standard'

const chijian = getSkillRuntime(XIAHOU_EN_CHIJIAN)!
const shiwu = getSkillRuntime(XIAHOU_EN_SHIWU)!
const cili = getSkillRuntime(HUAN_HUAIJIN_CILI)!
const lianyou = getSkillRuntime(HUAN_HUAIJIN_LIANYOU)!
const wujue = getSkillRuntime(LIU_ZHEN_WUJUE)!
const zhengu = getSkillRuntime(LIU_ZHEN_ZHENGU)!
const mingjie = getSkillRuntime(LI_ZHAOYI_MINGJIE)!
const xianfu = getSkillRuntime(LI_ZHAOYI_XIANFU)!
const zhengting = getSkillRuntime(XING_DONGYUN_ZHENGTING)!
const bishi = getSkillRuntime(XING_DONGYUN_BISHI)!
const huangnu = getSkillRuntime(WEI_ZHANG_XINGCAI_HUANGNU)!
const xiankuang = getSkillRuntime(WEI_ZHANG_XINGCAI_XIANKUANG)!
const weigu = getSkillRuntime(XING_XIAHOU_BA_WEIGU)!
const juefa = getSkillRuntime(XING_XIAHOU_BA_JUEFA)!
const yinZhi = getSkillRuntime(SHEN_CAO_PI_YINZHI)!
const keMing = getSkillRuntime(SHEN_CAO_PI_KEMING)!
const fuLe = getSkillRuntime(LE_CAO_ZHI_FULE)!
const wenLan = getSkillRuntime(LE_CAO_ZHI_WENLAN)!
const heQi = getSkillRuntime(WEI_MA_TENG_HEQI)!
const huiRui = getSkillRuntime(WEI_MA_TENG_HUIRUI)!
const xiaoBen = getSkillRuntime(WEI_MA_TENG_XIAOBEN)!

function gameForTest(seed: string) {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.turnNumber = 7
  return game
}

describe('神·曹丕【阴鸷】（第87批未登记逻辑）', () => {
  it('按目标累计发动次数抽牌（至多3），并压制其非锁定技至其下次回合开始', () => {
    const game = gameForTest('b87-yinzhi-active')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(SHEN_CAO_PI_YINZHI)
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const initialHandCount = owner.zones.hand.length
    const state = game.state as unknown as { paperSanguoshaB87?: { shenCaopiYinzhiCount: Record<string, number> } }
    state.paperSanguoshaB87 = { shenCaopiYinzhiCount: { [`${owner.id}:${target.id}`]: 3 } }
    yinZhi.resume!(game as never, owner.id as never,
      { step: 'target', data: {} } as never,
      { payload: { targetIds: [target.id] } } as never)
    expect(game.state.players.find((player) => player.id === owner.id)!.zones.hand).toHaveLength(initialHandCount + 3)
    expect(game.state.skillSuppressions).toContainEqual(expect.objectContaining({
      targetId: target.id, sourceId: owner.id, sourceSkillId: SHEN_CAO_PI_YINZHI, scope: 'non-locked', expiresAt: 'turn-start',
    }))
    expect(getSkillRuntime(SHEN_CAO_PI_YINZHI)!.prohibitsCardUse).toBeTypeOf('function')
  })

  it('目标回合仅可使用本回合获得的实体牌，并限制实体响应牌；限定不外溢到其他回合', () => {
    const game = gameForTest('b87-yinzhi-lock')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const physicalIds = game.state.zones.drawPile.slice(0, 2)
    const gained = physicalIds[0]!
    const oldCard = physicalIds[1]!
    moveCard(game.state, gained, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, oldCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const runtime = getSkillRuntime(SHEN_CAO_PI_YINZHI)!
    owner.characterId = 'shen-caopi-b87' as never
    owner.grantedSkills.push(SHEN_CAO_PI_YINZHI)
    const root = game.state as unknown as Record<string, unknown>
    root.paperSanguoshaB87 = { shenCaopiYinzhi: {
      [`${owner.id}:${target.id}`]: { targetId: target.id, uses: 1, gainedCardIds: [], restrictionTurn: game.state.turnNumber, drawUntilTurnStart: true },
    } }
    game.state.currentPlayerId = target.id
    const gainTrigger = runtime.triggers!.find((entry) => entry.event === 'GainCard')!
    gainTrigger.handle(game as never, owner.id as never, { event: {
      name: 'GainCard', payload: { playerId: target.id, cardIds: [gained] },
    } } as never)
    expect(runtime.prohibitsCardUse!(game.state, owner.id as never, {
      userId: target.id, cardName: '杀', dyingPlayerId: null, cardIds: [oldCard],
    })).toBe(true)
    expect(runtime.prohibitsCardUse!(game.state, owner.id as never, {
      userId: target.id, cardName: '杀', dyingPlayerId: null, cardIds: [gained],
    })).toBe(false)
    expect(runtime.prohibitsResponseCard!(game.state, owner.id as never, target.id as never, oldCard, '闪')).toBe(true)
    expect(runtime.prohibitsResponseCard!(game.state, owner.id as never, target.id as never, gained, '闪')).toBe(false)
    expect(isCardUseProhibited(game.state, target.id as never, '杀', { dyingPlayerId: null, cardIds: [oldCard] })).toBe(true)
    expect(isResponseCardProhibited(game.state, target.id as never, oldCard, '闪')).toBe(true)
    game.state.currentPlayerId = owner.id
    expect(runtime.prohibitsResponseCard!(game.state, owner.id as never, target.id as never, oldCard, '闪')).toBe(false)
  })

  it('受术目标以手牌使用/响应后，曹丕按X摸牌', () => {
    const game = gameForTest('b87-yinzhi-draw-after-hand-card')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(SHEN_CAO_PI_YINZHI)
    const root = game.state as unknown as Record<string, unknown>
    root.paperSanguoshaB87 = { shenCaopiYinzhi: {
      [`${owner.id}:${target.id}`]: { targetId: target.id, uses: 1, gainedCardIds: [], restrictionTurn: game.state.turnNumber, drawUntilTurnStart: true },
    } }
    const before = owner.zones.hand.length
    const trigger = yinZhi.triggers!.find((entry) => entry.event === 'CardResponded')!
    trigger.handle(game as never, owner.id as never, { event: {
      name: 'CardResponded', sourceId: target.id, payload: { fromKind: 'hand', cardName: '闪' },
    } } as never)
    expect(owner.zones.hand).toHaveLength(before + 1)
  })

  it('目标回合开始后停止阴鸷摸牌并启用本回合获得牌限制', () => {
    const game = gameForTest('b87-yinzhi-turn-transition')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const root = game.state as unknown as Record<string, unknown>
    root.paperSanguoshaB87 = { shenCaopiYinzhi: {
      [`${owner.id}:${target.id}`]: { targetId: target.id, uses: 1, gainedCardIds: [], drawUntilTurnStart: true },
    } }
    game.state.currentPlayerId = target.id
    const start = yinZhi.triggers!.find((entry) => entry.event === 'TurnStart')!
    start.handle(game as never, owner.id as never, { event: {
      name: 'TurnStart', payload: { playerId: target.id, turnNumber: game.state.turnNumber },
    } } as never)
    const before = owner.zones.hand.length
    const response = yinZhi.triggers!.find((entry) => entry.event === 'CardResponded')!
    response.handle(game as never, owner.id as never, { event: {
      name: 'CardResponded', payload: { playerId: target.id, fromKind: 'hand', cardName: '闪' },
    } } as never)
    expect(owner.zones.hand).toHaveLength(before)
    expect(yinZhi.prohibitsCardUse!(game.state, owner.id as never, {
      userId: target.id, cardName: '杀', dyingPlayerId: null,
    })).toBe(true)
  })
})

describe('神·曹丕【刻名】（第87批未登记逻辑）', () => {
  it('公共技能续接事件能精确记录该次效果摸入与使用的牌名', () => {
    const game = gameForTest('b87-skill-effect-metrics')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(SHEN_CAO_PI_YINZHI)
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    let resolved: Record<string, unknown> | undefined
    game.events.on('SkillEffectResolved', (context) => { resolved = context.event.payload })
    yinZhi.startQueued!(game as never, owner.id as never, { skillId: SHEN_CAO_PI_YINZHI, ownerId: owner.id,
      step: 'choose-target', data: {} } as never)
    const request = game.state.pendingRequests.find((entry) => entry.skillId === SHEN_CAO_PI_YINZHI)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    expect(resolved).toMatchObject({ skillId: SHEN_CAO_PI_YINZHI, drawnCardNames: expect.any(Array), usedCardNames: [] })
    expect((resolved?.drawnCardNames as string[]).length).toBe(1)
  })

  it('受伤来源有同一时机技能时，提供逐项触发选择并以曹丕为技能执行者接入其原续接', () => {
    const game = gameForTest('b87-keming-source-skill')
    const owner = game.state.players[0]!
    const source = game.state.players[1]!
    owner.characterId = 'shen-caopi-b87' as never
    owner.grantedSkills.push(SHEN_CAO_PI_KEMING)
    source.characterId = 'xunyu' as never
    const skillId = 'jieming'
    game.dispatch('Damaged', { playerId: owner.id, amount: 1 }, { sourceId: source.id, targetId: owner.id })
    const queued = game.state.skillQueue[0]!
    expect(queued.skillId).toBe(SHEN_CAO_PI_KEMING)
    keMing.startQueued!(game as never, owner.id as never, queued)
    keMing.resume!(game as never, owner.id as never, game.state.skillResolution as never,
      { payload: { optionId: `source:${skillId}` } } as never)
    expect(game.state.skillQueue.some((prompt) => prompt.skillId === skillId && prompt.ownerId === owner.id)).toBe(true)
  })

  it('伤害来源没有此时机技能时，改为提供曹姓武将技能的随机触发分支', () => {
    const game = gameForTest('b87-keming-cao-random')
    const owner = game.state.players[0]!
    const source = game.state.players[1]!
    owner.characterId = 'shen-caopi-b87' as never
    owner.grantedSkills.push(SHEN_CAO_PI_KEMING)
    source.characterId = 'guanyu' as never
    game.dispatch('Damaged', { playerId: owner.id, amount: 1 }, { sourceId: source.id, targetId: owner.id })
    const queued = game.state.skillQueue[0]!
    expect(queued.data.fallbackSkillIds).toEqual(expect.arrayContaining(['fangzhu']))
    owner.hp = owner.maxHp - 1
    vi.spyOn(game.rng, 'shuffle').mockReturnValue(['fangzhu'])
    keMing.startQueued!(game as never, owner.id as never, queued)
    const request = game.state.pendingRequests.find((entry) => entry.playerId === owner.id)
    expect(request && 'options' in request ? request.options.some((option) => option.id === 'fallback-random') : false).toBe(true)
    keMing.resume!(game as never, owner.id as never, game.state.skillResolution as never,
      { payload: { optionId: 'fallback-random' } } as never)
    expect(game.state.skillQueue.some((prompt) => prompt.skillId === 'fangzhu' && prompt.ownerId === owner.id)).toBe(true)
  })

  it('曹丕造成伤害后，目标下一次合规技能效果摸牌/用牌时可摸至多五张同名牌', () => {
    const game = gameForTest('b87-keming-copy-names')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'shen-caopi-b87' as never
    owner.grantedSkills.push(SHEN_CAO_PI_KEMING)
    game.state.currentPlayerId = target.id
    game.state.phase = 'play'
    game.dispatch('DamageSettled', { finalAmount: 1 }, { sourceId: owner.id, targetId: target.id })
    game.dispatch('SkillEffectResolved', { skillId: 'some-skill', drawnCardNames: ['杀', '桃'], usedCardNames: ['闪'] },
      { sourceId: target.id })
    const queued = game.state.skillQueue.find((prompt) => prompt.step === 'offer-copy')!
    expect(queued.data.names).toEqual(['杀', '桃', '闪'])
    keMing.startQueued!(game as never, owner.id as never, queued)
    keMing.resume!(game as never, owner.id as never, game.state.skillResolution as never,
      { payload: { optionId: 'yes' } } as never)
    const gainedNames = game.state.players.find((player) => player.id === owner.id)!.zones.hand
      .map((id) => game.state.cards[id]?.name)
    expect(gainedNames).toEqual(expect.arrayContaining(['杀', '桃', '闪']))
  })
})

describe('夏侯恩【持剑】（第87批未登记逻辑）', () => {
  it('每个回合增加一次出杀额度，不因同一回合额外出牌阶段重复叠加', () => {
    const game = gameForTest('b87-chijian-quota')
    const owner = game.state.players[0]!
    owner.grantedSkills.push(XIAHOU_EN_CHIJIAN)
    const trigger = chijian.triggers!.find((entry) => entry.event === 'PhaseStart')!
    const context = { event: { name: 'PhaseStart', payload: { playerId: owner.id, phase: 'play' } } } as never
    trigger.handle(game as never, owner.id as never, context)
    trigger.handle(game as never, owner.id as never, context)
    expect(owner.marks['slash-extra-uses']).toBe(1)
  })

  it('没有武器时提供青釭剑、范围2，并只压制此【杀】目标的防具', () => {
    const game = gameForTest('b87-chijian-qinggang')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(XIAHOU_EN_CHIJIAN)
    expect(hasWeapon(game.state, owner.id, '青釭剑')).toBe(true)
    expect(getAttackRange(game.state, owner.id)).toBe(2)

    const trigger = chijian.triggers!.find((entry) => entry.event === 'TargetSpecified')!
    trigger.handle(game as never, owner.id as never, { event: {
      name: 'TargetSpecified', sourceId: owner.id,
      payload: { cardId: 'b87-test-slash', cardName: '杀', targetIds: [target.id] },
    } } as never)
    expect(isArmorSuppressed(game.state, target.id, owner.id, 'b87-test-slash')).toBe(true)
    expect(isArmorSuppressed(game.state, target.id, owner.id, 'another-card')).toBe(false)
    expect(isArmorSuppressed(game.state, target.id, owner.id)).toBe(false)
    expect(game.state.armorSuppressions?.[0]).toMatchObject({ cardId: 'b87-test-slash', expiry: 'card-use-end', skillId: XIAHOU_EN_CHIJIAN })
  })

  it('装备区已有任意武器后不再视为青釭剑，也不再压制目标防具', () => {
    const game = gameForTest('b87-chijian-real-weapon')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(XIAHOU_EN_CHIJIAN)
    const weaponId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '青龙偃月刀')!
    moveCard(game.state, weaponId, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot: 'weapon' })
    expect(hasWeapon(game.state, owner.id, '青釭剑')).toBe(false)
    expect(getAttackRange(game.state, owner.id)).toBe(3)

    const trigger = chijian.triggers!.find((entry) => entry.event === 'TargetSpecified')!
    trigger.handle(game as never, owner.id as never, { event: {
      name: 'TargetSpecified', sourceId: owner.id,
      payload: { cardId: 'b87-test-slash-real-weapon', cardName: '杀', targetIds: [target.id] },
    } } as never)
    expect(game.state.armorSuppressions ?? []).toHaveLength(0)
  })
})

describe('夏侯恩【恃武】（第87批未登记逻辑）', () => {
  it('其他角色回合开始时向夏侯恩发起可选【决斗】请求', () => {
    const game = gameForTest('b87-shiwu-offer')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(XIAHOU_EN_SHIWU)
    shiwu.triggers!.find((entry) => entry.event === 'TurnStart')!.handle(game as never, owner.id as never,
      { event: { name: 'TurnStart', payload: { playerId: target.id } } } as never)
    const queued = game.state.skillQueue.at(-1)!
    expect(queued?.step).toBe('offer-duel')
    shiwu.startQueued!(game as never, owner.id as never, queued as never)
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-option', playerId: owner.id, optional: true })
  })

  it('选择发动后通过公共虚拟锦囊入口建立真实【决斗】结算', () => {
    const game = gameForTest('b87-shiwu-real-duel')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(XIAHOU_EN_SHIWU)
    shiwu.triggers!.find((entry) => entry.event === 'TurnStart')!.handle(game as never, owner.id as never,
      { event: { name: 'TurnStart', payload: { playerId: target.id } } } as never)
    const queued = game.state.skillQueue.at(-1)!
    shiwu.startQueued!(game as never, owner.id as never, queued as never)
    const request = game.state.pendingRequests.at(-1)!
    game.state.pendingRequests = []
    shiwu.resume!(game as never, owner.id as never,
      { step: 'duel-choice', data: { targetId: target.id }, requestId: request.id } as never,
      { requestId: request.id, playerId: owner.id, payload: { optionId: 'yes' } } as never)
    expect(game.state.cardResolution).toMatchObject({ kind: 'trick', cardName: '决斗', sourceId: owner.id, targetIds: [target.id] })
    expect((game.state as never as { paperSanguoshaB87: { xiahouDuel: Record<string, { targetId: string }> } })
      .paperSanguoshaB87.xiahouDuel[owner.id]).toMatchObject({ targetId: target.id })
  })

  it('夏侯恩对其造成决斗伤害后，可从牌堆选择一张伤害牌获得', () => {
    const game = gameForTest('b87-shiwu-damage-reward')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(XIAHOU_EN_SHIWU)
    const duelId = `b87-duel-${game.state.seq}`
    ;(game.state as never as { paperSanguoshaB87: { xiahouDuel: Record<string, { targetId: string; cardId: string }> } }).paperSanguoshaB87 = {
      xiahouDuel: { [owner.id]: { targetId: target.id, cardId: duelId } },
    }
    const damageCards = game.state.zones.drawPile.filter((id) => ['杀', '火杀', '雷杀'].includes(game.state.cards[id]?.name ?? '')
      || ['南蛮入侵', '万箭齐发', '决斗', '火攻'].includes(game.state.cards[id]?.name ?? ''))
    shiwu.triggers!.find((entry) => entry.event === 'DamageSettled')!.handle(game as never, owner.id as never, { event: {
      name: 'DamageSettled', sourceId: owner.id, targetId: target.id,
      payload: { cardId: duelId, cardName: '决斗', finalAmount: 1 },
    } } as never)
    const queued = game.state.skillQueue.at(-1)!
    expect(queued?.step).toBe('gain-damage-card')
    shiwu.startQueued!(game as never, owner.id as never, queued as never)
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-cards', playerId: owner.id, min: 1, max: 1 })
    const selected = damageCards[0]!
    shiwu.resume!(game as never, owner.id as never,
      { step: 'take-damage-card', data: { candidates: damageCards } } as never,
      { payload: { cardIds: [selected] } } as never)
    expect(owner.zones.hand).toContain(selected)
  })

  it('对方造成决斗伤害后临时获得持剑，且夏侯恩仅失去持剑至该回合结束', () => {
    const game = gameForTest('b87-shiwu-transfer')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(XIAHOU_EN_CHIJIAN, XIAHOU_EN_SHIWU)
    const duelId = `b87-duel-${game.state.seq}`
    ;(game.state as never as { paperSanguoshaB87: { xiahouDuel: Record<string, { targetId: string; cardId: string }> } }).paperSanguoshaB87 = {
      xiahouDuel: { [owner.id]: { targetId: target.id, cardId: duelId } },
    }
    shiwu.triggers!.find((entry) => entry.event === 'DamageSettled')!.handle(game as never, owner.id as never, { event: {
      name: 'DamageSettled', sourceId: target.id, targetId: owner.id,
      payload: { cardId: duelId, cardName: '决斗', finalAmount: 1 },
    } } as never)
    expect(target.temporaryGrantedSkills).toContainEqual({ source: `b87-xiahou-en-shiwu:${owner.id}`, skillId: XIAHOU_EN_CHIJIAN })
    expect(isSkillSuppressed(game.state, owner.id, XIAHOU_EN_CHIJIAN)).toBe(true)

    shiwu.triggers!.find((entry) => entry.event === 'TurnEnd')!.handle(game as never, owner.id as never,
      { event: { name: 'TurnEnd', payload: { playerId: target.id } } } as never)
    expect(target.temporaryGrantedSkills).not.toContainEqual({ source: `b87-xiahou-en-shiwu:${owner.id}`, skillId: XIAHOU_EN_CHIJIAN })
    expect(isSkillSuppressed(game.state, owner.id, XIAHOU_EN_CHIJIAN)).toBe(false)
  })

  it('夏侯恩阵亡时由杀死他的存活角色永久获得持剑', () => {
    const game = gameForTest('b87-shiwu-death')
    const owner = game.state.players[0]!
    const killer = game.state.players[1]!
    shiwu.triggers!.find((entry) => entry.event === 'Death')!.handle(game as never, owner.id as never, { event: {
      name: 'Death', sourceId: killer.id, targetId: owner.id, payload: { playerId: owner.id, sourceId: killer.id },
    } } as never)
    expect(killer.grantedSkills).toContain(XIAHOU_EN_CHIJIAN)
  })
})

describe('环怀瑾【慈厉】（第87批未登记逻辑）', () => {
  it('跨轮记录目标下一回合的牌数，并在其回合结束提供正确分支的发动选择', () => {
    const game = gameForTest('b87-cili-cross-round')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(HUAN_HUAIJIN_CILI)
    game.state.roundNumber = 2
    const trigger = cili.triggers!.find((entry) => entry.event === 'RoundStart')!
    trigger.handle(game as never, owner.id as never, { event: { name: 'RoundStart', payload: { roundNumber: 2 } } } as never)
    const queued = game.state.skillQueue.at(-1)!
    cili.startQueued!(game as never, owner.id as never, queued as never)
    const request = game.state.pendingRequests.at(-1)!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    cili.resume!(game as never, owner.id as never, { step: 'record-target', data: { roundNumber: 2 } } as never,
      { requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)

    game.state.roundNumber = 3
    game.state.turnNumber = 8
    cili.triggers!.find((entry) => entry.event === 'TurnStart')!.handle(game as never, owner.id as never,
      { event: { name: 'TurnStart', payload: { playerId: target.id, turnNumber: 8 } } } as never)
    game.state.zones.drawPile.slice(0, 2).forEach((cardId) => moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id }))
    cili.triggers!.find((entry) => entry.event === 'AfterCardUse')!.handle(game as never, owner.id as never,
      { event: { name: 'AfterCardUse', sourceId: target.id, payload: { cardId: 'cili-use-1' } } } as never)
    cili.triggers!.find((entry) => entry.event === 'AfterCardUse')!.handle(game as never, owner.id as never,
      { event: { name: 'AfterCardUse', sourceId: target.id, payload: { cardId: 'cili-use-2' } } } as never)
    const countBefore = target.zones.hand.length
    cili.triggers!.find((entry) => entry.event === 'TurnEnd')!.handle(game as never, owner.id as never,
      { event: { name: 'TurnEnd', payload: { playerId: target.id, turnNumber: 8 } } } as never)
    const result = game.state.skillQueue.at(-1)!
    expect(result?.step).toBe('offer-result')
    cili.startQueued!(game as never, owner.id as never, result as never)
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-option', playerId: owner.id, optional: true })
    const resultRequest = game.state.pendingRequests.at(-1)!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    cili.resume!(game as never, owner.id as never, { step: 'apply-result', data: result.data } as never,
      { requestId: resultRequest.id, playerId: owner.id, payload: { optionId: 'yes' } } as never)
    expect(target.zones.hand.length).toBe(countBefore - 2)
  })
})

describe('环怀瑾【怜幼】（第87批未登记逻辑）', () => {
  it('不同发动时机共享每项限一次账本，且摸三张后可选择角色并交出三张手牌', () => {
    const game = gameForTest('b87-lianyou-round-use')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(HUAN_HUAIJIN_LIANYOU)
    lianyou.triggers!.find((entry) => entry.event === 'TurnStart')!.handle(game as never, owner.id as never,
      { event: { name: 'TurnStart', payload: { playerId: owner.id } } } as never)
    let queued = game.state.skillQueue.at(-1)!
    lianyou.startQueued!(game as never, owner.id as never, queued as never)
    let request = game.state.pendingRequests.at(-1)!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    lianyou.resume!(game as never, owner.id as never, { step: 'choose-mode', data: { roundNumber: game.state.roundNumber } } as never,
      { requestId: request.id, playerId: owner.id, payload: { optionId: 'draw' } } as never)
    queued = game.state.skillQueue.at(-1)!
    lianyou.startQueued!(game as never, owner.id as never, queued as never)
    request = game.state.pendingRequests.at(-1)!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    expect(owner.zones.hand.length).toBeGreaterThanOrEqual(3)
    lianyou.resume!(game as never, owner.id as never, { step: 'give-target', data: { roundNumber: game.state.roundNumber } } as never,
      { requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    request = game.state.pendingRequests.at(-1)!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    const chosen = owner.zones.hand.slice(0, 3)
    lianyou.resume!(game as never, owner.id as never, { step: 'give-cards', data: { targetId: target.id, roundNumber: game.state.roundNumber } } as never,
      { requestId: request.id, playerId: owner.id, payload: { cardIds: chosen } } as never)
    expect(target.zones.hand).toEqual(expect.arrayContaining(chosen))

    lianyou.triggers!.find((entry) => entry.event === 'DamageSettled')!.handle(game as never, owner.id as never,
      { event: { name: 'DamageSettled', targetId: owner.id, payload: { finalAmount: 1 } } } as never)
    queued = game.state.skillQueue.at(-1)!
    lianyou.startQueued!(game as never, owner.id as never, queued as never)
    request = game.state.pendingRequests.at(-1)!
    expect((request as { options: Array<{ id: string }> }).options.map(({ id }) => id)).not.toContain('draw')
  })
})

describe('刘桢【五绝／贞骨】（第87批未登记逻辑）', () => {
  it('手牌结算后的牌名字符计数满五时亮牌，并只允许字符数之和为五的组合', () => {
    const game = gameForTest('b87-wujue-mark')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(LIU_ZHEN_WUJUE)
    const handUse = wujue.triggers!.find((entry) => entry.event === 'CardUsed')!
    const afterUse = wujue.triggers!.find((entry) => entry.event === 'AfterCardUse')!
    const cardId = 'wujue-use-five'
    handUse.handle(game as never, owner.id as never, { event: { name: 'CardUsed', sourceId: owner.id,
      payload: { cardId, cardName: '甲乙丙丁戊', fromKind: 'hand' } } } as never)
    afterUse.handle(game as never, owner.id as never, { event: { name: 'AfterCardUse', sourceId: owner.id,
      cardIds: [cardId], payload: { cardId } } } as never)
    expect(owner.marks['绝']).toBeUndefined()
    const queued = game.state.skillQueue.at(-1)!
    const top = game.state.zones.drawPile.slice(0, 3)
    game.state.cards[top[0]!]!.name = '甲乙'
    game.state.cards[top[1]!]!.name = '丙丁戊'
    game.state.cards[top[2]!]!.name = '己'
    wujue.startQueued!(game as never, owner.id as never, queued as never)
    const request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', options: expect.arrayContaining([{ id: 'set-0', label: '甲乙、丙丁戊' }]) })
    game.state.pendingRequests = []
    game.state.skillResolution = null
    wujue.resume!(game as never, owner.id as never,
      { step: 'choose-five-jue-set', data: { roundNumber: game.state.roundNumber, revealed: top,
        subsets: [[top[0]!, top[1]!]] } } as never,
      { requestId: request.id, playerId: owner.id, payload: { optionId: 'set-0' } } as never)
    const recipientQueue = game.state.skillQueue.at(-1)!
    wujue.startQueued!(game as never, owner.id as never, recipientQueue as never)
    const targetRequest = game.state.pendingRequests.at(-1)!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    wujue.resume!(game as never, owner.id as never,
      { step: 'give-five-jue-set', data: recipientQueue.data } as never,
      { requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    expect(target.zones.hand).toEqual(expect.arrayContaining([top[0]!, top[1]!]))
    expect(game.state.zones.discardPile).toContain(top[2])
  })

  it('贞骨随机给出名字长度不同的两张牌、翻面，并按翻面比较设置响应限制', () => {
    const game = gameForTest('b87-zhengu-flip-lock')
    const owner = game.state.players[0]!
    const source = game.state.players[1]!
    const recipient = game.state.players[2]!
    owner.grantedSkills.push(LIU_ZHEN_ZHENGU)
    source.faceDown = true
    const top = game.state.zones.drawPile.slice(0, 2)
    for (const cardId of game.state.zones.drawPile.slice(2))
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    game.state.cards[top[0]!]!.name = '甲'
    game.state.cards[top[1]!]!.name = '乙丙'
    zhengu.triggers!.find((entry) => entry.event === 'DamageSettled')!.handle(game as never, owner.id as never,
      { event: { name: 'DamageSettled', sourceId: source.id, targetId: owner.id, payload: { finalAmount: 1 } } } as never)
    const queued = game.state.skillQueue.at(-1)!
    zhengu.startQueued!(game as never, owner.id as never, queued as never)
    const request = game.state.pendingRequests.at(-1)!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    game.state.turnNumber = Number(queued.data.turnNumber)
    zhengu.resume!(game as never, owner.id as never, { step: 'give-zhengu-cards', data: queued.data } as never,
      { requestId: request.id, playerId: owner.id, payload: { targetIds: [recipient.id] } } as never)
    expect(recipient.zones.hand).toEqual(expect.arrayContaining(top))
    expect(owner.faceDown).toBe(true)
    game.state.cardResolution = { sourceId: source.id } as never
    expect(zhengu.prohibitsCardResponse!(game.state, owner.id as never, owner.id as never, '闪')).toBe(true)
    expect(zhengu.prohibitsCardResponse!(game.state, owner.id as never, recipient.id as never, '闪')).toBe(false)
    game.state.cardResolution = { sourceId: owner.id } as never
    expect(zhengu.prohibitsCardResponse!(game.state, owner.id as never, owner.id as never, '闪')).toBe(false)
  })
})

describe('李昭仪【明节／娴辅】（第87批未登记逻辑）', () => {
  it('明节只转移链接双方弃牌阶段实际进入弃牌堆的牌，并在阶段被跳过时为双方摸牌', () => {
    const game = gameForTest('b87-mingjie-discard')
    const owner = game.state.players[0]!
    const partner = game.state.players[1]!
    const other = game.state.players[2]!
    owner.grantedSkills.push(LI_ZHAOYI_MINGJIE)
    ;(game.state as unknown as { paperSanguoshaB87: { partner: Record<string, string> } }).paperSanguoshaB87 = { partner: { [owner.id]: partner.id } }
    const id = game.state.zones.drawPile[0]!
    moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, id, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    const phaseInstanceId = 'discard-b87-test'
    game.state.discardPhaseLedger = { phaseInstanceId, ownerPlayerId: owner.id,
      records: [{ cardId: id, sourcePlayerId: owner.id, originalZone: 'hand', moveReason: 'discard', enteredDiscardAt: game.state.seq }] }
    mingjie.triggers!.find((entry) => entry.event === 'CardMove')!.handle(game as never, owner.id as never,
      { event: { name: 'CardMove', payload: { cardIds: [id], sourcePlayerId: owner.id, destinationZone: 'discardPile', reason: 'discard', phaseInstanceId } } } as never)
    expect(partner.zones.hand).toContain(id)
    const beforeOwner = owner.zones.hand.length
    const beforePartner = partner.zones.hand.length
    mingjie.triggers!.find((entry) => entry.event === 'PhaseSkipped')!.handle(game as never, owner.id as never,
      { event: { name: 'PhaseSkipped', payload: { playerId: partner.id, phase: 'draw' } } } as never)
    expect(owner.zones.hand.length).toBe(beforeOwner + 2)
    expect(partner.zones.hand.length).toBe(beforePartner + 2)
    expect(game.state.skillQueue.at(-1)?.step).toBe('offer-shield')
    expect(other.alive).toBe(true)
    game.state.skillQueue = []
    mingjie.resume!(game as never, owner.id as never, { step: 'shield', data: { otherId: owner.id } } as never,
      { requestId: 'b87-shield', playerId: owner.id, payload: { optionId: 'yes' } } as never)
    expect(mingjie.offersGlobalDamagePreventionAsk!(game as never, owner.id as never,
      { targetId: owner.id, sourceId: other.id, amount: 1, nature: 'normal', cardId: null, cardName: '杀', chainTransfer: false } as never)).toBe(true)
    const shieldQueue = game.state.skillQueue.at(-1)!
    game.state.pendingTargetDamage = { options: { targetId: owner.id, sourceId: other.id, amount: 1, nature: 'normal' }, skillId: LI_ZHAOYI_MINGJIE } as never
    mingjie.startQueued!(game as never, owner.id as never, shieldQueue as never)
    expect(game.state.pendingTargetDamage).toBeUndefined()
    expect((game.state as unknown as { paperSanguoshaB87: { shield: Record<string, boolean> } }).paperSanguoshaB87.shield[owner.id]).toBeUndefined()
  })

  it('娴辅跳过阶段只排到本人下回合，并取消当前单一目标后让双方分别看到对方手牌', () => {
    const game = gameForTest('b87-xianfu-cancel')
    const owner = game.state.players[0]!
    const partner = game.state.players[1]!
    owner.grantedSkills.push(LI_ZHAOYI_XIANFU)
    for (const player of [owner, partner]) {
      const cardId = game.state.zones.drawPile[0]!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: player.id })
    }
    ;(game.state as unknown as { paperSanguoshaB87: { partner: Record<string, string> } }).paperSanguoshaB87 = { partner: { [owner.id]: partner.id } }
    game.state.cardResolution = { kind: 'slash', sourceId: partner.id, targetId: owner.id, stage: 'awaiting-intercept', interceptsDone: [], targetCancelled: false } as never
    expect(xianfu.interceptTarget!(game as never, owner.id as never, {} as never)).toBe(true)
    const request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option' })
    expect((request as { options: Array<{ id: string }> }).options.map(({ id }) => id)).toEqual(expect.arrayContaining(['no', 'draw', 'play', 'discard']))
    game.state.pendingRequests = []
    game.state.skillResolution = null
    xianfu.resume!(game as never, owner.id as never, { step: 'choose-skip', data: { partnerId: partner.id, turnNumber: game.state.turnNumber } } as never,
      { requestId: request.id, playerId: owner.id, payload: { optionId: 'play' } } as never)
    expect(game.state.scheduledSkippedPhasesByPlayer?.[owner.id]).toContain('play')
    expect(game.state.cardResolution).toMatchObject({ targetCancelled: true })
    const viewRequest = game.state.pendingRequests.at(-1)!
    expect(viewRequest).toMatchObject({ kind: 'choose-cards', playerId: owner.id, viewOnlyCardIds: owner.zones.hand, max: 1 })
    const partnerCard = partner.zones.hand[0]!
    game.state.pendingRequests = []
    game.state.skillResolution = null
    game.resumeCardTarget = (() => {}) as never
    xianfu.resume!(game as never, owner.id as never,
      { step: 'take-partner-cards', data: { partnerId: partner.id, selectable: [partnerCard] } } as never,
      { requestId: viewRequest.id, playerId: owner.id, payload: { cardIds: [partnerCard] } } as never)
    expect(owner.zones.hand).toContain(partnerCard)
    const reverseView = game.state.pendingRequests.at(-1)!
    expect(reverseView).toMatchObject({ kind: 'choose-cards', playerId: partner.id, cardIds: [], viewOnlyCardIds: owner.zones.hand, max: 0 })
    expect(xianfu).toBeDefined()
  })
})

describe('星·董允【正听】（第87批未登记逻辑）', () => {
  it('只在本人出牌阶段提供一次主动动作，并让双方分别私下查看对方手牌后选择摸缺失花色', () => {
    const game = gameForTest('b87-zhengting-draw')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const ownerCard = game.state.zones.drawPile[0]!
    const targetCard = game.state.zones.drawPile[1]!
    game.state.cards[ownerCard]!.suit = 'heart'
    game.state.cards[targetCard]!.suit = 'spade'
    moveCard(game.state, ownerCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    expect(zhengting.activeActions!(game.state, owner.id)).toEqual([{ id: `${XING_DONGYUN_ZHENGTING}:activate`, label: '正听' }])
    expect(zhengting.activeActions!(game.state, target.id)).toEqual([])

    zhengting.invokeActive!(game as never, owner.id as never, `${XING_DONGYUN_ZHENGTING}:activate`)
    const chooseTarget = game.state.skillQueue.pop()!
    zhengting.startQueued!(game as never, owner.id as never, chooseTarget as never)
    let request = game.state.pendingRequests.pop()!
    game.state.skillResolution = null
    zhengting.resume!(game as never, owner.id as never, { step: 'target', data: {} } as never,
      { requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    const revealOwner = game.state.skillQueue.pop()!
    zhengting.startQueued!(game as never, owner.id as never, revealOwner as never)
    request = game.state.pendingRequests.pop()!
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: owner.id, cardIds: [], viewOnlyCardIds: target.zones.hand, max: 0 })
    game.state.skillResolution = null
    zhengting.resume!(game as never, owner.id as never, { step: 'view-target-hand', data: { targetId: target.id } } as never,
      { requestId: request.id, playerId: owner.id, payload: { cardIds: [] } } as never)
    const revealTarget = game.state.skillQueue.pop()!
    zhengting.startQueued!(game as never, owner.id as never, revealTarget as never)
    request = game.state.pendingRequests.pop()!
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: target.id, cardIds: [], viewOnlyCardIds: owner.zones.hand, max: 0 })
    game.state.skillResolution = null
    zhengting.resume!(game as never, owner.id as never, { step: 'view-owner-hand', data: { targetId: target.id } } as never,
      { requestId: request.id, playerId: target.id, payload: { cardIds: [] } } as never)
    const modeQueue = game.state.skillQueue.pop()!
    zhengting.startQueued!(game as never, owner.id as never, modeQueue as never)
    request = game.state.pendingRequests.pop()!
    game.state.skillResolution = null
    zhengting.resume!(game as never, owner.id as never, { step: 'mode', data: { targetId: target.id } } as never,
      { requestId: request.id, playerId: owner.id, payload: { optionId: 'draw' } } as never)
    for (const player of [owner, target])
      expect(new Set(player.zones.hand.map((id) => game.state.cards[id]?.suit))).toEqual(new Set(['spade', 'heart', 'club', 'diamond']))
    expect(zhengting.activeActions!(game.state, owner.id)).toEqual([])
  })

  it('双方分别选择重复花色中保留的手牌，其余手牌实际弃置', () => {
    const game = gameForTest('b87-zhengting-discard')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const cards = game.state.zones.drawPile.slice(0, 4)
    for (const id of cards) game.state.cards[id]!.suit = cards.indexOf(id) < 2 ? 'heart' : 'diamond'
    for (const [index, id] of cards.entries())
      moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: index < 2 ? owner.id : target.id })
    const start = { targetId: target.id, actorIndex: 0, suitIndex: 0, kept: { [owner.id]: [], [target.id]: [] } }
    zhengting.startQueued!(game as never, owner.id as never,
      { skillId: XING_DONGYUN_ZHENGTING, ownerId: owner.id, step: 'discard-choice', data: start } as never)
    let request = game.state.pendingRequests.pop()!
    expect(request).toMatchObject({ playerId: owner.id, cardIds: owner.zones.hand, max: 1 })
    const keepOwner = owner.zones.hand[0]!
    game.state.skillResolution = null
    zhengting.resume!(game as never, owner.id as never, { step: 'choose-kept-card', data: start } as never,
      { requestId: request.id, playerId: owner.id, payload: { cardIds: [keepOwner] } } as never)
    const ownerContinue = game.state.skillQueue.pop()!
    zhengting.startQueued!(game as never, owner.id as never, ownerContinue as never)
    request = game.state.pendingRequests.pop()!
    expect(request).toMatchObject({ playerId: target.id, cardIds: target.zones.hand, max: 1, viewOnlyCardIds: owner.zones.hand })
    const keepTarget = target.zones.hand[0]!
    game.state.skillResolution = null
    zhengting.resume!(game as never, owner.id as never,
      { step: 'choose-kept-card', data: ownerContinue.data } as never,
      { requestId: request.id, playerId: target.id, payload: { cardIds: [keepTarget] } } as never)
    const finalQueue = game.state.skillQueue.pop()!
    zhengting.startQueued!(game as never, owner.id as never, finalQueue as never)
    expect(owner.zones.hand).toEqual([keepOwner])
    expect(target.zones.hand).toEqual([keepTarget])
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining(cards.filter((id) => id !== keepOwner && id !== keepTarget)))
  })
})

describe('星·董允【弼士】额外出牌阶段（第87批未登记逻辑）', () => {
  it('按官网资料使用蜀势力男性4体力设定', () => {
    expect(XING_DONGYUN_B87).toMatchObject({ kingdom: 'shu', gender: 'male', maxHp: 4 })
  })

  it('仅在一轮一次地交牌后按当前手牌数与体力值判断，并建立真实额外出牌阶段', () => {
    const game = gameForTest('b87-bishi-phase')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(XING_DONGYUN_BISHI)
    owner.characterId = 'xing-dongyun-b87' as never
    for (const id of game.state.zones.drawPile.slice(0, target.hp))
      moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const trigger = bishi.triggers!.find((entry) => entry.event === 'TurnEnd')!
    trigger.handle(game as never, owner.id as never,
      { event: { name: 'TurnEnd', payload: { playerId: target.id, turnNumber: game.state.turnNumber } } } as never)
    const queued = game.state.skillQueue.pop()!
    bishi.startQueued!(game as never, owner.id as never, queued as never)
    const request = game.state.pendingRequests.pop()!
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: owner.id, min: 0, max: 0, optional: true })
    game.state.skillResolution = null
    bishi.resume!(game as never, owner.id as never,
      { step: 'give-cards', data: { targetId: target.id, roundNumber: game.state.roundNumber } } as never,
      { requestId: request.id, playerId: owner.id, payload: { cardIds: [] } } as never)
    expect(game.state.postTurnExtraPhases).toHaveLength(1)
    expect(game.state.postTurnExtraPhases![0]).toMatchObject({ playerId: target.id, phase: 'play', skillId: XING_DONGYUN_BISHI, endsTurnAfter: true })
    game.state.turnTransitionPending = true
    expect(resumeTurnTransition(game.state, () => {})).toBe(true)
    expect(game.state).toMatchObject({ currentPlayerId: target.id, phase: 'play', extraPhase: { phase: 'play', playerId: target.id, endsTurnAfter: true } })
    expect(bishi.activeActions?.(game.state, target.id) ?? []).toEqual([])
  })

  it('额外阶段第一张牌对其目标不可响应，使用伤害牌时董允摸牌，阶段结束后正常续接下回合', () => {
    const game = gameForTest('b87-bishi-response')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(XING_DONGYUN_BISHI)
    owner.characterId = 'xing-dongyun-b87' as never
    const cardIds = game.state.zones.drawPile.slice(0, 2)
    for (const [index, id] of cardIds.entries()) {
      game.state.cards[id]!.name = index === 0 ? '杀' : '南蛮入侵'
      moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    }
    game.state.currentPlayerId = target.id
    game.state.phase = 'play'
    game.state.extraPhase = { phase: 'play', resumeSlot: 'finish', playerId: target.id,
      skillId: XING_DONGYUN_BISHI, instanceId: 8701, preSkipped: false, endsTurnAfter: true }
    const record = { ownerId: owner.id, targetId: target.id, roundNumber: game.state.roundNumber, usedCount: 0 }
    ;(game.state as unknown as { paperSanguoshaB87: { bishiExtraPhases: Record<string, typeof record> } }).paperSanguoshaB87 = { bishiExtraPhases: { '8701': record } }
    const usedTrigger = bishi.triggers!.find((entry) => entry.event === 'CardUsed')!
    usedTrigger.handle(game as never, owner.id as never,
      { event: { name: 'CardUsed', sourceId: target.id, payload: { cardId: cardIds[0], cardName: '杀' }, cardIds: [cardIds[0]] } } as never)
    expect(isCardUseUnresponsiveToTarget(game.state, target.id, cardIds[0]!, owner.id, '杀', (id) => id === 'xing-dongyun-b87' ? [XING_DONGYUN_BISHI] : [])).toBe(true)
    expect(isCardUseUnresponsiveToTarget(game.state, target.id, cardIds[1]!, owner.id, '南蛮入侵', (id) => id === 'xing-dongyun-b87' ? [XING_DONGYUN_BISHI] : [])).toBe(false)

    const ownerHandCount = owner.zones.hand.length
    usedTrigger.handle(game as never, owner.id as never,
      { event: { name: 'CardUsed', sourceId: target.id, payload: { cardId: cardIds[1], cardName: '南蛮入侵' }, cardIds: [cardIds[1]] } } as never)
    expect(owner.zones.hand.length).toBe(ownerHandCount + 1)
    const events: string[] = []
    const end = advancePhase(game.state, (name) => { events.push(name) })
    expect(end).toBe(false)
    expect(events).toEqual(['PhaseEnd'])
    expect(game.state.turnTransitionPending).toBe(true)
    const transitionEvents: string[] = []
    expect(resumeTurnTransition(game.state, (name) => { transitionEvents.push(name) })).toBe(true)
    expect(transitionEvents).toContain('TurnStart')
    expect(transitionEvents).not.toContain('TurnEnd')
    expect(game.state.phase).toBe('prepare')
    expect(game.state.currentPlayerId).not.toBe(target.id)
  })
})

describe('威·张星彩【煌怒／贤贶】（第87批未登记逻辑）', () => {
  it('官网技能效果与武将资料一致；受伤后提供三个完整效果分支', () => {
    expect(WEI_ZHANG_XINGCAI_B87).toMatchObject({ kingdom: 'shu', gender: 'female', maxHp: 3 })
    const game = gameForTest('b87-huangnu-options')
    const owner = game.state.players[0]!
    owner.grantedSkills.push(WEI_ZHANG_XINGCAI_HUANGNU)
    huangnu.triggers!.find((entry) => entry.event === 'DamageSettled')!.handle(game as never, owner.id as never,
      { event: { name: 'DamageSettled', targetId: owner.id, payload: { finalAmount: 1 } } } as never)
    const queued = game.state.skillQueue.pop()!
    huangnu.startQueued!(game as never, owner.id as never, queued as never)
    expect(game.state.pendingRequests.pop()).toMatchObject({
      kind: 'choose-option', optional: true,
      options: expect.arrayContaining([
        expect.objectContaining({ id: 'discard' }),
        expect.objectContaining({ id: 'slash' }),
        expect.objectContaining({ id: 'invalidate' }),
      ]),
    })
  })

  it('【贤贶】只响应非因使用而弃置的实体基本牌，并提供获取或按废除栏数摸牌', () => {
    const game = gameForTest('b87-xiankuang-discard')
    const owner = game.state.players[0]!
    const victim = game.state.players[1]!
    owner.grantedSkills.push(WEI_ZHANG_XINGCAI_XIANKUANG)
    const basicId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic')!
    const trigger = xiankuang.triggers!.find((entry) => entry.event === 'CardEnteredDiscardByMove')!
    const event = (reason: string, fromKind = 'hand') => ({ event: { name: 'CardEnteredDiscardByMove', payload: {
      cardId: basicId, fromKind, fromPlayerId: victim.id, reason,
    } } }) as never
    trigger.handle(game as never, owner.id as never, event('use'))
    expect(game.state.skillQueue).toHaveLength(0)
    trigger.handle(game as never, owner.id as never, event('discard', 'judgingArea'))
    const queued = game.state.skillQueue.pop()!
    xiankuang.startQueued!(game as never, owner.id as never, queued as never)
    expect(game.state.pendingRequests.pop()).toMatchObject({ kind: 'choose-option', optional: true })
    game.state.skillResolution = null

    moveCard(game.state, basicId, { kind: 'drawPile' }, { kind: 'discardPile' })
    abolishSlot(game.state, owner.id, 'weapon')
    xiankuang.startQueued!(game as never, owner.id as never, {
      skillId: WEI_ZHANG_XINGCAI_XIANKUANG, ownerId: owner.id, step: 'choose-mode',
      data: { cardId: basicId, targetId: victim.id, turnNumber: game.state.turnNumber },
    } as never)
    expect(game.state.pendingRequests.pop()).toMatchObject({
      kind: 'choose-option', options: expect.arrayContaining([
        expect.objectContaining({ id: 'gain' }),
        expect.objectContaining({ id: 'draw', label: expect.stringContaining('1') }),
      ]),
    })
  })
})

describe('星·夏侯霸【维谷／绝伐】（第87批未登记逻辑）', () => {
  it('仅在单目标伤害牌结算时询问，并把真正能指定自己为目标的手牌作为弃置代价', () => {
    const game = gameForTest('b87-xiahouba-cost')
    const owner = game.state.players[0]!
    const source = game.state.players[1]!
    owner.grantedSkills.push(XING_XIAHOU_BA_WEIGU, XING_XIAHOU_BA_JUEFA)
    owner.hp = 2
    const [payment, useCard] = game.state.zones.drawPile.slice(0, 2)
    game.state.cards[payment!]!.name = '桃'
    game.state.cards[payment!]!.category = 'basic'
    moveCard(game.state, payment!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.cardResolution = { kind: 'trick', cardId: useCard!, cardName: '决斗', sourceId: source.id,
      targetIds: [owner.id], targetIndex: 0, nullifiedTargetIds: [], stage: 'awaiting-intercept', interceptsDone: [],
      cancelledTargetIds: [], unresponsiveTargetIds: [], responderOrder: [], responderIndex: 0,
      nullificationCount: 0, declinedAllIds: [], lastNullifierId: null, requestId: null, effect: null } as never
    expect(weigu.interceptTarget!(game as never, owner.id as never, {
      sourceId: source.id, targetId: owner.id, cardId: useCard!, cardName: '决斗', category: 'trick',
    })).toBe(true)
    expect(game.state.pendingRequests.pop()).toMatchObject({ kind: 'choose-cards', optional: true, min: 0, max: 1, cardIds: [payment] })

    game.state.skillResolution = null
    game.state.pendingRequests = []
    delete (game.state as unknown as { paperSanguoshaB87?: { xiahoubaPrompted?: Record<string, string> } }).paperSanguoshaB87?.xiahoubaPrompted?.[useCard!]
    game.state.cardResolution = { ...(game.state.cardResolution as never), targetIds: [owner.id, game.state.players[2]!.id] } as never
    expect(weigu.interceptTarget!(game as never, owner.id as never, {
      sourceId: source.id, targetId: owner.id, cardId: useCard!, cardName: '决斗', category: 'trick',
    })).toBe(false)
  })

  it('绝伐限定技只能发动一次，并替换维谷移动分支为真实两点伤害选项', () => {
    const game = gameForTest('b87-xiahouba-juefa')
    const owner = game.state.players[0]!
    owner.grantedSkills.push(XING_XIAHOU_BA_JUEFA)
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    expect(juefa.activeActions!(game.state, owner.id as never)).toHaveLength(1)
    juefa.invokeActive!(game as never, owner.id as never, `${XING_XIAHOU_BA_JUEFA}:activate`)
    expect(juefa.activeActions!(game.state, owner.id as never)).toHaveLength(0)
    expect((game.state as never as { paperSanguoshaB87: { xiahoubaJuefa: Record<string, unknown> } }).paperSanguoshaB87.xiahoubaJuefa[owner.id]).toMatchObject({ used: true, active: true, killed: false })

    const source = game.state.players[1]!
    const cardId = game.state.zones.drawPile[0]!
    game.state.cardResolution = { kind: 'trick', cardId, cardName: '决斗', sourceId: source.id,
      targetIds: [source.id], targetIndex: 0, nullifiedTargetIds: [], stage: 'awaiting-intercept', interceptsDone: [],
      cancelledTargetIds: [], unresponsiveTargetIds: [], responderOrder: [], responderIndex: 0,
      nullificationCount: 0, declinedAllIds: [], lastNullifierId: null, requestId: null, effect: null } as never
    weigu.startQueued!(game as never, owner.id as never, { skillId: XING_XIAHOU_BA_WEIGU, ownerId: owner.id,
      step: 'effect', data: { cardId, sourceId: owner.id } } as never)
    const effectRequest = game.state.pendingRequests.pop() as { kind: string; options?: Array<{ id: string }> }
    expect(effectRequest.kind).toBe('choose-option')
    expect(effectRequest.options?.map(({ id }) => id)).toContain('juefa-damage')
    expect(effectRequest.options?.map(({ id }) => id)).not.toContain('move-field')
  })

  it('维谷扩展目标按夏侯霸当前攻击范围加入全体合法角色，整张牌未造成伤害才执行惩罚', () => {
    const game = gameForTest('b87-xiahouba-expand')
    const owner = game.state.players[0]!
    const originalTarget = game.state.players[1]!
    const payment = game.state.zones.drawPile[0]!
    const cardId = game.state.zones.drawPile[1]!
    owner.grantedSkills.push(XING_XIAHOU_BA_WEIGU)
    owner.hp = 2
    game.state.cards[payment]!.name = '桃'
    game.state.cards[payment]!.category = 'basic'
    moveCard(game.state, payment, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.cardResolution = { kind: 'trick', cardId, cardName: '决斗', sourceId: owner.id,
      targetIds: [originalTarget.id], targetIndex: 0, nullifiedTargetIds: [], stage: 'awaiting-intercept', interceptsDone: [],
      cancelledTargetIds: [], unresponsiveTargetIds: [], responderOrder: [], responderIndex: 0,
      nullificationCount: 0, declinedAllIds: [], lastNullifierId: null, requestId: null, effect: null } as never
    game.resumeCardTarget = () => {}
    weigu.interceptSourceTargetEach!(game as never, owner.id as never, {
      sourceId: owner.id, targetId: originalTarget.id, cardId, cardName: '决斗', category: 'trick',
    })
    game.state.pendingRequests.pop()
    game.state.skillResolution = null
    weigu.resume!(game as never, owner.id as never, { step: 'cost', data: { cardId, sourceId: owner.id, cardName: '决斗' } } as never,
      { requestId: 'b87-cost', playerId: owner.id, payload: { cardIds: [payment] } } as never)
    const effect = game.state.skillQueue.pop()!
    weigu.startQueued!(game as never, owner.id as never, effect as never)
    game.state.pendingRequests.pop()
    game.state.skillResolution = null
    weigu.resume!(game as never, owner.id as never, { step: 'effect-choice', data: effect.data } as never,
      { requestId: 'b87-expand', playerId: owner.id, payload: { optionId: 'expand-targets' } } as never)
    expect((game.state.cardResolution as never as { targetIds: string[] }).targetIds).toContain(game.state.players[4]!.id)

    const ownerHand = owner.zones.hand.length
    owner.hp = 3
    ;(game.state as unknown as { paperSanguoshaB87: { xiahoubaCardResolution: Record<string, { ownerId: string; damaged: boolean }> } })
      .paperSanguoshaB87.xiahoubaCardResolution[cardId] = { ownerId: owner.id, damaged: false }
    const afterUse = weigu.triggers!.find((entry) => entry.event === 'AfterCardUse')!
    afterUse.handle(game as never, owner.id as never, { event: { name: 'AfterCardUse', cardIds: [cardId], payload: { cardId } } } as never)
    expect(owner.hp).toBe(2)
    expect(owner.zones.hand.length).toBe(ownerHand + 2)
  })

  it('绝伐伤害经过公共伤害管线；伤害结束后再续接被维谷挂起的原牌', () => {
    const game = gameForTest('b87-xiahouba-juefa-damage')
    const owner = game.state.players[0]!
    const victim = game.state.players[1]!
    const cardId = game.state.zones.drawPile[0]!
    owner.grantedSkills.push(XING_XIAHOU_BA_WEIGU, XING_XIAHOU_BA_JUEFA)
    owner.characterId = 'xing-xiahouba-b87' as never
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    juefa.invokeActive!(game as never, owner.id as never, `${XING_XIAHOU_BA_JUEFA}:activate`)
    game.state.cardResolution = { kind: 'trick', cardId, cardName: '决斗', sourceId: owner.id,
      targetIds: [victim.id], targetIndex: 0, nullifiedTargetIds: [], stage: 'awaiting-intercept', interceptsDone: [],
      cancelledTargetIds: [], unresponsiveTargetIds: [], responderOrder: [], responderIndex: 0,
      nullificationCount: 0, declinedAllIds: [], lastNullifierId: null, requestId: null, effect: null } as never
    game.resumeCardTarget = () => {}
    weigu.startQueued!(game as never, owner.id as never, { skillId: XING_XIAHOU_BA_WEIGU, ownerId: owner.id,
      step: 'effect', data: { cardId, sourceId: owner.id } } as never)
    game.state.pendingRequests.pop()
    game.state.skillResolution = null
    weigu.resume!(game as never, owner.id as never, { step: 'effect-choice', data: { cardId, sourceId: owner.id } } as never,
      { requestId: 'b87-juefa-mode', playerId: owner.id, payload: { optionId: 'juefa-damage' } } as never)
    const targetQueue = game.state.skillQueue.pop()!
    weigu.startQueued!(game as never, owner.id as never, targetQueue as never)
    game.state.pendingRequests.pop()
    game.state.skillResolution = null
    const beforeHp = victim.hp
    weigu.resume!(game as never, owner.id as never, { step: 'juefa-target', data: targetQueue.data } as never,
      { requestId: 'b87-juefa-target', playerId: owner.id, payload: { targetIds: [victim.id] } } as never)
    expect(victim.hp).toBe(beforeHp - 2)
    expect(game.state.skillQueue.pop()).toMatchObject({ step: 'resume-after-juefa-damage', data: { cardId } })
  })
})

describe('乐曹植【赋乐／文澜】（第87批）', () => {
  it('开局为初始手牌随机赋予非装备异名、转化选项和手牌上限豁免', () => {
    const game = gameForTest('b87-le-caozhi-fule')
    const owner = game.state.players[0]!
    owner.characterId = LE_CAO_ZHI_B87.id as never
    owner.zones.hand.push(...game.state.zones.drawPile.splice(0, 4))
    fuLe.onGameStart!(game as never, owner.id as never)
    const fuCards = (game.state as never as { paperSanguoshaB87: { leCaozhiFuCards: Record<string, { alternateName: string }> } })
      .paperSanguoshaB87.leCaozhiFuCards
    for (const cardId of owner.zones.hand) {
      expect(fuCards[cardId]).toBeDefined()
      expect(game.state.cards[cardId]!.category).not.toBe('equipment')
      expect(fuLe.handLimitExempt!(game.state, owner.id as never, cardId as never)).toBe(true)
    }
    expect(fuLe.viewAs!(game.state, owner.id as never)).toHaveLength(owner.zones.hand.length)
    expect(Object.values(fuCards).every(({ alternateName }) => Object.values(game.state.cards)
      .some((card) => card.name === alternateName && card.category !== 'equipment'))).toBe(true)
    const convertedCardId = owner.zones.hand.find((id) => game.state.cards[id]!.name !== '杀')!
    fuCards[convertedCardId] = { alternateName: '杀' }
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    expect(legalPlayActions(game.state, owner.id).some((action) => action.kind === 'use-card'
      && action.cardIds.includes(convertedCardId) && action.asCardName === '杀')).toBe(true)
  })

  it('连续结算的两张赋共享牌名时从牌堆取得两张对应牌并继续标记为赋', () => {
    const game = gameForTest('b87-le-caozhi-wenlan-match')
    const owner = game.state.players[0]!
    owner.characterId = LE_CAO_ZHI_B87.id as never
    const nameGroup = Object.entries(game.state.zones.drawPile.reduce<Record<string, string[]>>((groups, id) => {
      const name = game.state.cards[id]!.name
      ;(groups[name] ??= []).push(id)
      return groups
    }, {})).find(([, ids]) => ids.length >= 4)
    const repeatedName = nameGroup?.[0]
    expect(repeatedName).toBeDefined()
    const cardIds = game.state.zones.drawPile.splice(0, 0)
    const selectedCopies = nameGroup![1].slice(0, 2)
    for (const id of selectedCopies) game.state.zones.drawPile.splice(game.state.zones.drawPile.indexOf(id), 1)
    owner.zones.hand.push(...selectedCopies)
    cardIds.push(...selectedCopies)
    const cardMap = (game.state as never as { paperSanguoshaB87?: { leCaozhiFuCards?: Record<string, { alternateName: string }> } })
    cardMap.paperSanguoshaB87 = { leCaozhiFuCards: Object.fromEntries(cardIds.map((id) => [id, { alternateName: '闪' }])) }
    const resolved = wenLan.triggers!.find((trigger) => trigger.event === 'CardResolved')!
    const initialHandSize = owner.zones.hand.length
    cardIds.forEach((cardId) => resolved.handle(game as never, owner.id as never, { event: {
      name: 'CardResolved', sourceId: owner.id, payload: { cardId, cardName: repeatedName, cancelled: false },
    } } as never))
    const queuedGain = game.state.skillQueue.at(-1)!
    expect(queuedGain).toMatchObject({ skillId: LE_CAO_ZHI_WENLAN, step: 'gain-matching-fu' })
    wenLan.startQueued!(game as never, owner.id as never, queuedGain as never)
    expect(owner.zones.hand).toHaveLength(initialHandSize + 2)
    expect(owner.zones.hand.slice(-2).every((id) => cardMap.paperSanguoshaB87!.leCaozhiFuCards![id])).toBe(true)
  })

  it('不满足同名赋配对时进入可选择任意手牌标记或重赋牌名的流程', () => {
    const game = gameForTest('b87-le-caozhi-wenlan-other')
    const owner = game.state.players[0]!
    const ids = game.state.zones.drawPile.splice(0, 2)
    owner.zones.hand.push(...ids)
    ;(game.state as never as { paperSanguoshaB87?: { leCaozhiFuCards?: Record<string, { alternateName: string }> } })
      .paperSanguoshaB87 = { leCaozhiFuCards: { [ids[0]!]: { alternateName: '闪' }, [ids[1]!]: { alternateName: '桃' } } }
    const trigger = wenLan.triggers!.find((entry) => entry.event === 'CardResolved')!
    trigger.handle(game as never, owner.id as never, { event: { name: 'CardResolved', sourceId: owner.id,
      payload: { cardId: ids[0], cardName: game.state.cards[ids[0]!]!.name } } } as never)
    trigger.handle(game as never, owner.id as never, { event: { name: 'CardResolved', sourceId: owner.id,
      payload: { cardId: ids[1], cardName: game.state.cards[ids[1]!]!.name } } } as never)
    expect(game.state.skillQueue.at(-1)).toMatchObject({ skillId: LE_CAO_ZHI_WENLAN, step: 'choose-fu-cards' })
    wenLan.startQueued!(game as never, owner.id as never, { skillId: LE_CAO_ZHI_WENLAN, ownerId: owner.id,
      step: 'choose-fu-cards', data: {} } as never)
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-cards', min: 0, max: owner.zones.hand.length })
  })
})

describe('威·马腾【合骑／挥锐／骁贲】（第87批）', () => {
  it('两名新将均已注册，整批第1120至1129名连续对应武将册顺序', () => {
    expect(HISTORICAL_BATCH87_CHARACTERS).toHaveLength(10)
    expect(getCharacter(LE_CAO_ZHI_B87.id)).toBe(LE_CAO_ZHI_B87)
    expect(getCharacter(WEI_MA_TENG_B87.id)).toBe(WEI_MA_TENG_B87)
    expect(LE_CAO_ZHI_B87.name).toBe('乐曹植')
    expect(WEI_MA_TENG_B87.name).toBe('威·马腾')
  })

  it('开局获得3个公开“骑”，且对有“骑”的角色使用牌无距离限制', () => {
    const game = gameForTest('b87-wei-mateng-heqi')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = WEI_MA_TENG_B87.id as never
    heQi.onGameStart!(game as never, owner.id as never)
    expect(owner.marks['骑']).toBe(3)
    expect(heQi.ignoresDistanceTo!(game.state, owner.id as never, owner.id as never)).toBe(false)
    ;(game.state as never as { paperSanguoshaB87: { weiMaTengRides: Record<string, number> } }).paperSanguoshaB87.weiMaTengRides[target.id] = 1
    expect(heQi.ignoresDistanceTo!(game.state, owner.id as never, target.id as never)).toBe(true)
  })

  it('回合出牌階段开始时提供挥锐选择，完成伤害牌+非基本牌后提供骁贲选择', () => {
    const game = gameForTest('b87-wei-mateng-trigger')
    const owner = game.state.players[0]!
    const playStart = huiRui.triggers!.find((trigger) => trigger.event === 'PlayPhase')!
    playStart.handle(game as never, owner.id as never, { event: { name: 'PlayPhase', payload: { playerId: owner.id } } } as never)
    expect(game.state.skillQueue.at(-1)).toMatchObject({ skillId: WEI_MA_TENG_HUIRUI, step: 'choose-mode' })
    const state = game.state as never as { paperSanguoshaB87?: { weiMaTengLastCard?: Record<string, { turnNumber: number; damage: boolean; nonBasic: boolean }> } }
    state.paperSanguoshaB87 = { weiMaTengLastCard: { [owner.id]: { turnNumber: game.state.turnNumber, damage: true, nonBasic: false } } }
    const nonBasicCardId = Object.keys(game.state.cards).find((id) => game.state.cards[id]!.category === 'trick')!
    const comboTrigger = xiaoBen.triggers!.find((trigger) => trigger.event === 'CardResolved')!
    comboTrigger.handle(game as never, owner.id as never, { event: { name: 'CardResolved', sourceId: owner.id,
      payload: { cardId: nonBasicCardId, cardName: game.state.cards[nonBasicCardId]!.name } } } as never)
    expect(game.state.skillQueue.at(-1)).toMatchObject({ skillId: WEI_MA_TENG_XIAOBEN, step: 'activate' })
  })

  it('骁贲移动骑后可清除其余角色骑标记，并按每枚标记造成无来源伤害', () => {
    const game = gameForTest('b87-wei-mateng-xiaoben-resolution')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = WEI_MA_TENG_B87.id as never
    heQi.onGameStart!(game as never, owner.id as never)
    const rides = (game.state as never as { paperSanguoshaB87: { weiMaTengRides: Record<string, number> } })
      .paperSanguoshaB87.weiMaTengRides
    rides[target.id] = 2
    target.marks['骑'] = 2
    const initialHp = target.hp
    xiaoBen.resume!(game as never, owner.id as never, { step: 'activate', data: {} } as never,
      { payload: { optionId: 'yes' } } as never)
    game.state.skillResolution = null
    game.state.pendingRequests.pop()
    xiaoBen.resume!(game as never, owner.id as never, { step: 'choose-source', data: {} } as never,
      { payload: { targetIds: [target.id] } } as never)
    game.state.skillResolution = null
    game.state.pendingRequests.pop()
    xiaoBen.resume!(game as never, owner.id as never, { step: 'choose-destination', data: { sourceId: target.id } } as never,
      { payload: { targetIds: [owner.id] } } as never)
    expect(rides[target.id]).toBe(1)
    game.state.skillResolution = null
    game.state.pendingRequests.pop()
    xiaoBen.resume!(game as never, owner.id as never, { step: 'choose-purge', data: {} } as never,
      { payload: { optionId: 'purge' } } as never)
    expect(target.hp).toBe(initialHp - 1)
    expect(rides[target.id]).toBeUndefined()
    expect(owner.marks['骑']).toBe(4)
  })
})
