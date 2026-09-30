import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import {
  BIAN_YUE_B89, BIAN_YUE_BI_ZU, BIAN_YUE_WU_XIE, HISTORICAL_BATCH89_CHARACTERS,
  LIU_YANG_B89, LIU_YANG_CHI_XING, MOU_CAO_ANG_B89, MOU_CAO_ANG_ZHI_WANG,
  MOU_DIANWEI_B89, MOU_DIANWEI_KANGYONG, MOU_DIANWEI_KUANGZHAN, MOU_JUSHOU_B89, MOU_JUSHOU_MUWANG, XU_KUN_B89, XU_KUN_FA_ZHU,
  XING_SUN_SHANGXIANG_B89, XING_SUN_SHANGXIANG_JIAOHAO, XING_SUN_SHANGXIANG_SA_YING,
  MOU_CHENLIN_B89, MOU_CHENLIN_YAOZUO, MOU_CHENLIN_ZHUANWEN,
  MOU_HUCHEER_B89, MOU_HUCHEER_KONGWU, HUANG_WUDIE_B89, HUANG_WUDIE_FUXIE,
  HUANG_WUDIE_SHOUXING, HUANG_WUDIE_SHAXUE, HUANG_WUDIE_SHUANGRUI,
} from '@/sanguosha/data/characters/historical-batch89'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { effectiveCardName, moveCard } from '@/sanguosha/engine/zones'
import { startPindian } from '@/sanguosha/engine/pindian'
import { suppressEquipmentEffectsUntilTurnEnd, equipmentEffectsSuppressed } from '@/sanguosha/engine/equipment-suppression'
import { hasArmor } from '@/sanguosha/engine/equipment'
import { getCharacter } from '@/sanguosha/data/characters/standard'

function game() {
  return new SanguoshaGame({ seed: 'batch89-focused', setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `b89-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
}

describe('第89批当前已实现角色', () => {
  it('已实现的四名角色定义对应武将册文本', () => {
    expect(HISTORICAL_BATCH89_CHARACTERS.map(({ name }) => name)).toEqual(['徐琨', '谋·曹昂', '柳婒', '谋·典韦', '谋·胡车儿', '卞玥', '星·孙尚香', '谋·沮授', '谋·陈琳', '黄舞蝶'])
    expect(XU_KUN_B89.skills[0]?.description).toContain('至多等量名角色')
    expect(MOU_CAO_ANG_B89.skills[1]?.description).toContain('视为无来源')
    expect(LIU_YANG_B89.skills[1]?.description).toContain('一名角色出牌阶段结束时')
    expect(BIAN_YUE_B89.skills.map(({ id }) => id)).toEqual([BIAN_YUE_BI_ZU, BIAN_YUE_WU_XIE])
    expect(MOU_HUCHEER_B89.skills[0]?.id).toBe(MOU_HUCHEER_KONGWU)
    expect(HUANG_WUDIE_B89.skills.map(({ id }) => id)).toEqual([HUANG_WUDIE_SHUANGRUI, HUANG_WUDIE_FUXIE, HUANG_WUDIE_SHOUXING, HUANG_WUDIE_SHAXUE])
    expect(HISTORICAL_BATCH89_CHARACTERS.every(({ id }) => getCharacter(id)?.id === id)).toBe(true)
  })

  it('筏铸在准备阶段触发；受赠者顺序选择合法目标且不受距离限制', () => {
    const runtime = getSkillRuntime(XU_KUN_FA_ZHU)!
    expect(runtime.triggers?.some((trigger) => trigger.event === 'PhaseStart')).toBe(true)
    expect(runtime.startQueued).toBeTypeOf('function')
    expect(runtime.resume).toBeTypeOf('function')
  })

  it('质亡锁定技在结束阶段触发，伤害来源改写只针对质亡选出的牌打向曹昂', () => {
    const runtime = getSkillRuntime(MOU_CAO_ANG_ZHI_WANG)!
    expect(runtime.triggers?.some((trigger) => trigger.event === 'PhaseStart')).toBe(true)
    const current = game()
    const ownerId = current.state.players[0]!.id
    const actorId = current.state.players[1]!.id
    const cardId = current.state.zones.drawPile[0]!
    const state = current.state as typeof current.state & { paperSanguoshaB89?: { caoangZhiWangUse?: Record<string, { actorId: string; cardId: string }> } }
    state.paperSanguoshaB89 = { caoangZhiWangUse: { [ownerId]: { actorId, cardId } } }
    expect(runtime.modifyDamageSource?.(current.state, ownerId, { sourceId: actorId, targetId: ownerId, cardId, cardName: '杀', chainTransfer: false })).toBeNull()
    expect(runtime.modifyDamageSource?.(current.state, ownerId, { sourceId: actorId, targetId: current.state.players[2]!.id, cardId, cardName: '杀', chainTransfer: false })).toBeUndefined()
  })

  it('迟行跟踪任意角色出牌阶段进入弃牌堆的杀，并提供可选摸牌流程', () => {
    const runtime = getSkillRuntime(LIU_YANG_CHI_XING)!
    expect(runtime.startQueued).toBeTypeOf('function')
    expect(runtime.resume).toBeTypeOf('function')
    expect(runtime.triggers?.some((trigger) => trigger.event === 'PhaseEnd')).toBe(true)
    expect(runtime.triggers?.some((trigger) => trigger.event === 'CardEnteredDiscardByMove')).toBe(true)
    const current = game()
    const ownerId = current.state.players[0]!.id
    const phasePlayerId = current.state.players[2]!.id
    const slashId = current.state.zones.drawPile.find((id) => current.state.cards[id]?.name === '杀')!
    const movement = runtime.triggers!.find((trigger) => trigger.event === 'CardEnteredDiscardByMove')!
    current.state.phase = 'play'
    current.state.currentPlayerId = phasePlayerId
    movement.handle(current as never, ownerId, { event: { name: 'CardEnteredDiscardByMove', payload: {
      cardId: slashId, fromPlayerId: phasePlayerId, fromKind: 'processingArea', reason: 'other',
    } } } as never)
    const phaseEnd = runtime.triggers!.find((trigger) => trigger.event === 'PhaseEnd')!
    phaseEnd.handle(current as never, ownerId, { event: { name: 'PhaseEnd', payload: { playerId: phasePlayerId, phase: 'play' } } } as never)
    expect(current.state.skillQueue).toContainEqual(expect.objectContaining({ skillId: LIU_YANG_CHI_XING,
      step: 'resolve-phase-slashes', data: { cards: [slashId] } }))
  })

  it('庇族记录全场技能目标集合并在本回合出现重复时锁住后续发动', () => {
    const runtime = getSkillRuntime(BIAN_YUE_BI_ZU)!
    const current = game()
    const owner = current.state.players[0]!
    owner.hp = owner.maxHp - 1
    current.state.phase = 'play'
    current.state.currentPlayerId = owner.id
    const trigger = runtime.triggers!.find((entry) => entry.event === 'SkillActivated')!
    const context = { event: { name: 'SkillActivated', payload: { targetIds: [owner.id, current.state.players[1]!.id] } } } as never
    trigger.handle(current as never, owner.id, context)
    trigger.handle(current as never, owner.id, context)
    expect(owner.hp).toBe(owner.maxHp)
    expect(runtime.activeActions?.(current.state, owner.id)).toEqual([])
  })

  it('无胁在回合结束触发并通过公共手牌交换、牌堆底移动', () => {
    const runtime = getSkillRuntime(BIAN_YUE_WU_XIE)!
    expect(runtime.triggers?.some((trigger) => trigger.event === 'TurnEnd')).toBe(true)
    expect(runtime.startQueued).toBeTypeOf('function')
    expect(runtime.resume).toBeTypeOf('function')
    const current = game()
    const owner = current.state.players[0]!
    const target = current.state.players[1]!
    const peach = current.state.zones.drawPile.find((id) => current.state.cards[id]?.name === '桃')!
    const slash = current.state.zones.drawPile.find((id) => current.state.cards[id]?.name === '杀')!
    moveCard(current.state, peach, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(current.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    runtime.resume!(current as never, owner.id, { step: 'swap-hands', data: {} } as never,
      { payload: { targetIds: [target.id] } } as never)
    expect(owner.zones.hand).toHaveLength(0)
    expect(owner.zones.hand).not.toContain(slash)
    expect(target.zones.hand).toContain(peach)
    expect(target.zones.hand).not.toContain(slash)
    expect(current.state.zones.drawPile.at(-1)).toBe(slash)
  })

  it('亢勇回合开始回满体力，回合结束失去所回复的体力但至少保留一点', () => {
    expect(MOU_DIANWEI_B89).toMatchObject({ maxHp: 5, initialHp: 4 })
    const runtime = getSkillRuntime(MOU_DIANWEI_KANGYONG)!
    const current = game()
    const owner = current.state.players[0]!
    owner.maxHp = 5
    owner.hp = 2
    const start = runtime.triggers!.find((entry) => entry.event === 'TurnStart')!
    const end = runtime.triggers!.find((entry) => entry.event === 'TurnEnd')!
    const turnNumber = current.state.turnNumber
    start.handle(current as never, owner.id, { event: { name: 'TurnStart', payload: { playerId: owner.id, turnNumber } } } as never)
    expect(owner.hp).toBe(5)
    owner.hp = 2
    end.handle(current as never, owner.id, { event: { name: 'TurnEnd', payload: { playerId: owner.id, turnNumber } } } as never)
    expect(owner.hp).toBe(1)
  })

  it('狂战以实际摸牌数决定拼点次数，胜后对本回合未赢过的所有合法角色用多目标杀', () => {
    const runtime = getSkillRuntime(MOU_DIANWEI_KUANGZHAN)!
    const current = game()
    const owner = current.state.players[0]!
    const opponent = current.state.players[1]!
    owner.maxHp = 5
    owner.attackRangeBonus = 5
    current.state.phase = 'play'
    current.state.currentPlayerId = owner.id
    const cards = current.state.zones.drawPile.slice(0, 5)
    for (const cardId of cards.slice(0, 4)) moveCard(current.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(current.state, cards[4]!, { kind: 'drawPile' }, { kind: 'hand', playerId: opponent.id })
    runtime.invokeActive!(current as never, owner.id, `skill:${MOU_DIANWEI_KUANGZHAN}`)
    expect(owner.zones.hand).toHaveLength(5)
    const flow = (current.state as typeof current.state & { paperSanguoshaB89: { mouDianweiFlow: Record<string, { remaining: number }> } })
      .paperSanguoshaB89.mouDianweiFlow[owner.id]
    expect(flow.remaining).toBe(1)

    const ownCard = owner.zones.hand.find((id) => !cards.slice(0, 4).includes(id))!
    const targetCard = opponent.zones.hand[0]!
    current.state.cards[ownCard]!.rank = 13
    current.state.cards[targetCard]!.rank = 1
    const slashTargets: string[][] = []
    const originalDispatch = current.dispatch.bind(current)
    current.dispatch = ((name, payload, metadata) => {
      const cardEvent = payload as { cardName?: string; targetIds?: string[] } | undefined
      if (name === 'CardUsed' && metadata?.sourceId === owner.id && cardEvent?.cardName === '杀') slashTargets.push(cardEvent.targetIds ?? [])
      return originalDispatch(name, payload, metadata)
    })
    startPindian(current as never, { id: 'b89-kuangzhan-pindian', initiatorId: owner.id, opponentId: opponent.id,
      reason: MOU_DIANWEI_KUANGZHAN, continuationTag: `${MOU_DIANWEI_KUANGZHAN}:pindian` })
    const requests = current.state.pendingRequests.filter((request) => request.purpose === 'pindian')
    for (const request of requests) current.respond({ requestId: request.id, playerId: request.playerId,
      payload: { cardIds: [request.playerId === owner.id ? ownCard : targetCard] } })
    expect(current.state.cardUseHistory?.some((entry) => entry.sourceId === owner.id && entry.cardName === '杀'),
      JSON.stringify({ uses: current.state.cardUseHistory, hp: current.state.players.map((player) => [player.id, player.hp]) })).toBe(true)
    expect(slashTargets).toEqual([[current.state.players[2]!.id, current.state.players[3]!.id, current.state.players[4]!.id]])
  })

  it('暮往只收回本回合首次失去的基本牌/普通锦囊，同牌再次进入弃牌堆后要求弃牌', () => {
    const runtime = getSkillRuntime(MOU_JUSHOU_MUWANG)!
    const trigger = runtime.triggers!.find((entry) => entry.event === 'CardEnteredDiscardByMove')!
    const current = game()
    const owner = current.state.players[0]!
    const cardId = current.state.zones.drawPile.find((id) => current.state.cards[id]?.category === 'basic')!
    moveCard(current.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(current.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    trigger.handle(current as never, owner.id, { event: { name: 'CardEnteredDiscardByMove', payload: { cardId, fromPlayerId: owner.id } } } as never)
    expect(owner.zones.hand).toContain(cardId)
    expect(MOU_JUSHOU_B89.skills[1]?.id).toBe(MOU_JUSHOU_MUWANG)

    moveCard(current.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    trigger.handle(current as never, owner.id, { event: { name: 'CardEnteredDiscardByMove', payload: { cardId, fromPlayerId: owner.id } } } as never)
    expect(current.state.skillQueue.some((prompt) => prompt.skillId === MOU_JUSHOU_MUWANG && prompt.step === 'discard-one')).toBe(true)
  })

  it('飒影将装备区牌用于四种基本牌，并按轮次逐牌名限一次', () => {
    const runtime = getSkillRuntime(XING_SUN_SHANGXIANG_SA_YING)!
    const current = game()
    const owner = current.state.players[0]!
    const equipmentId = current.state.zones.drawPile.find((id) => current.state.cards[id]?.category === 'equipment')!
    const slot = current.state.cards[equipmentId]!.equipmentSlot!
    moveCard(current.state, equipmentId, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot })
    expect(runtime.viewAs!(current.state, owner.id).map((option) => option.asCardName)).toEqual(['杀', '闪', '桃', '酒'])
    const used = runtime.triggers!.find((entry) => entry.event === 'CardUsed')!
    used.handle(current as never, owner.id, { event: { name: 'CardUsed', sourceId: owner.id,
      payload: { cardName: '杀', fromKind: 'equipment' } } } as never)
    expect(runtime.viewAs!(current.state, owner.id).map((option) => option.asCardName)).toEqual(['闪', '桃', '酒'])
    expect(XING_SUN_SHANGXIANG_B89.skills[0]?.id).toBe(XING_SUN_SHANGXIANG_SA_YING)
  })

  it('佐军封存分支的三张牌不计手牌上限、不可使用或响应，并在目标下回合结束解封', () => {
    const runtime = getSkillRuntime('zuo-jun-mou-jushou-b89')!
    const current = game()
    const owner = current.state.players[0]!
    const target = current.state.players[1]!
    const cardId = current.state.zones.drawPile.find((id) => current.state.cards[id]?.category === 'basic')!
    moveCard(current.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    runtime.resume!(current as never, owner.id, { step: 'mode', data: { targetId: target.id, drawn: [cardId] } } as never,
      { payload: { optionId: 'seal' } } as never)
    expect(runtime.handLimitExempt?.(current.state, target.id, cardId)).toBe(true)
    expect(runtime.prohibitsCardUse?.(current.state, target.id, { userId: target.id, cardName: '杀', dyingPlayerId: null, cardIds: [cardId] })).toBe(true)
    expect(runtime.prohibitsResponseCard?.(current.state, target.id, target.id, cardId, '闪')).toBe(true)
    const turnEnd = runtime.triggers!.find((entry) => entry.event === 'TurnEnd')!
    turnEnd.handle(current as never, owner.id, { event: { name: 'TurnEnd', payload: { playerId: target.id, turnNumber: current.state.turnNumber } } } as never)
    expect(runtime.handLimitExempt?.(current.state, target.id, cardId)).toBe(true)
    turnEnd.handle(current as never, owner.id, { event: { name: 'TurnEnd', payload: { playerId: target.id, turnNumber: current.state.turnNumber + 1 } } } as never)
    expect(runtime.handLimitExempt?.(current.state, target.id, cardId)).toBe(false)
  })

  it('骄豪让拼点赢家获得两张拼点牌，并在技能选择完成后结束拼点牌结算', () => {
    const runtime = getSkillRuntime(XING_SUN_SHANGXIANG_JIAOHAO)!
    const current = game()
    const owner = current.state.players[0]!
    const opponent = current.state.players[1]!
    const cards = current.state.zones.drawPile.slice(0, 2)
    moveCard(current.state, cards[0]!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(current.state, cards[1]!, { kind: 'drawPile' }, { kind: 'hand', playerId: opponent.id })
    current.state.cards[cards[0]!]!.rank = 13
    current.state.cards[cards[1]!]!.rank = 1
    current.state.status = 'playing'
    current.state.phase = 'play'
    current.state.currentPlayerId = owner.id
    expect(runtime.activeActions?.(current.state, owner.id)).toHaveLength(1)

    startPindian(current as never, { id: 'b89-jiaohao-pindian', initiatorId: owner.id, opponentId: opponent.id,
      reason: XING_SUN_SHANGXIANG_JIAOHAO, continuationTag: 'jiao-hao-star-sunshangxiang-b89:pindian' })
    const requests = current.state.pendingRequests.filter((request) => request.purpose === 'pindian')
    for (const request of requests) current.respond({ requestId: request.id, playerId: request.playerId,
      payload: { cardIds: [request.playerId === owner.id ? cards[0]! : cards[1]!] } })
    expect(current.state.pindianSettlement?.cardIds).toEqual(cards)
    const effectRequest = current.state.pendingRequests.find((request) => request.skillId === XING_SUN_SHANGXIANG_JIAOHAO)!
    current.respond({ requestId: effectRequest.id, playerId: owner.id, payload: { optionId: 'gain' } })
    expect(owner.zones.hand).toEqual(expect.arrayContaining(cards))
    expect(current.state.pindianSettlement).toBeNull()
  })

  it('撰文可在结束阶段独立发动，并按手牌数至多展示五张牌进入正常处理区', () => {
    const runtime = getSkillRuntime(MOU_CHENLIN_YAOZUO)!
    const current = game()
    const owner = current.state.players[0]!
    current.state.status = 'playing'
    for (const cardId of current.state.zones.drawPile.slice(0, 6)) {
      const player = current.state.cards[cardId]?.name === '杀' ? owner.id : undefined
      if (player) moveCard(current.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: player })
    }
    const trigger = runtime.triggers!.find((entry) => entry.event === 'PhaseStart')!
    trigger.handle(current as never, owner.id, { event: { name: 'PhaseStart', payload: { playerId: owner.id, phase: 'finish' } } } as never)
    const request = current.state.pendingRequests.find((entry) => entry.kind === 'choose-targets')!
    expect(request.skillId).toBe(MOU_CHENLIN_YAOZUO)
    expect(runtime.resume).toBeTypeOf('function')
    expect(MOU_CHENLIN_B89.skills.map(({ id }) => id)).toEqual([MOU_CHENLIN_YAOZUO, MOU_CHENLIN_ZHUANWEN])
  })

  it('孔武展示同花色手牌、弃置后按类别计数并建立连续杀流程', () => {
    const runtime = getSkillRuntime(MOU_HUCHEER_KONGWU)!
    const current = game()
    const owner = current.state.players[0]!
    const target = current.state.players[1]!
    const shown = current.state.zones.drawPile.find((id) => current.state.cards[id]?.category === 'basic')!
    const matching = current.state.zones.drawPile.find((id) => id !== shown && current.state.cards[id]?.suit === current.state.cards[shown]?.suit)!
    const remainingBasic = current.state.zones.drawPile.find((id) => id !== shown && id !== matching
      && current.state.cards[id]?.category === 'basic' && current.state.cards[id]?.suit !== current.state.cards[shown]?.suit)!
    const equipment = current.state.zones.drawPile.find((id) => current.state.cards[id]?.category === 'equipment')!
    moveCard(current.state, shown, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(current.state, matching, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(current.state, remainingBasic, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(current.state, equipment, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot: current.state.cards[equipment]!.equipmentSlot! })
    runtime.resume!(current as never, owner.id, { step: 'show-card', data: { targetId: target.id } } as never,
      { payload: { cardIds: [shown] } } as never)
    expect(current.state.zones.discardPile).toContain(matching)
    const flow = (current.state as typeof current.state & { paperSanguoshaB89?: { mouHucheerFlow?: Record<string, { remaining: number }> } })
      .paperSanguoshaB89?.mouHucheerFlow?.[owner.id]
    expect(flow?.remaining).toBe(1)
    current.state.status = 'playing'
    current.state.phase = 'play'
    current.state.currentPlayerId = owner.id
    runtime.startQueued!(current as never, owner.id, { step: 'next-slash', data: {} } as never)
    expect(current.state.cardUseHistory?.filter((entry) => entry.sourceId === owner.id && entry.cardName === '杀')).toHaveLength(1)
  })

  it('双锐按范围选择对应的临时技能；装备压制状态在目标下回合结束后解除', () => {
    const runtime = getSkillRuntime(HUANG_WUDIE_SHUANGRUI)!
    const current = game()
    const owner = current.state.players[0]!
    const target = current.state.players[1]!
    current.state.status = 'playing'
    runtime.resume!(current as never, owner.id, { step: 'target', data: {} } as never,
      { payload: { targetIds: [target.id] } } as never)
    expect(owner.temporaryGrantedSkills).toContainEqual({ source: `${HUANG_WUDIE_SHUANGRUI}:turn`, skillId: HUANG_WUDIE_SHAXUE })

    const armor = current.state.zones.drawPile.find((id) => current.state.cards[id]?.equipmentSlot === 'armor')!
    moveCard(current.state, armor, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot: 'armor' })
    expect(hasArmor(current.state, target.id, current.state.cards[armor]!.name)).toBe(true)
    suppressEquipmentEffectsUntilTurnEnd(current.state, target.id, current.state.turnNumber, 1)
    expect(equipmentEffectsSuppressed(current.state, target.id)).toBe(true)
    expect(hasArmor(current.state, target.id, current.state.cards[armor]!.name)).toBe(false)
    const draw = current.dispatch('DrawPhase', { playerId: target.id, count: 2 }, { sourceId: target.id, phase: 'draw' })
    expect((draw.event.payload as { count?: number }).count).toBe(1)
    expect(equipmentEffectsSuppressed(current.state, target.id)).toBe(true)
    current.dispatch('TurnEnd', { playerId: target.id, turnNumber: current.state.turnNumber + 1 }, { sourceId: target.id, phase: 'finish' })
    expect(equipmentEffectsSuppressed(current.state, target.id)).toBe(false)
  })

  it('狩星按实时距离收取材料：一张保留为杀，其余材料正常弃置且不计杀次数', () => {
    const runtime = getSkillRuntime(HUANG_WUDIE_SHOUXING)!
    const current = game()
    const owner = current.state.players[0]!
    const target = current.state.players[2]!
    current.state.status = 'playing'
    current.state.phase = 'play'
    current.state.currentPlayerId = owner.id
    grantHuangSkillForTest(current, owner.id, HUANG_WUDIE_SHOUXING)
    const materials = current.state.zones.drawPile.slice(0, 2)
    for (const id of materials) moveCard(current.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    expect(runtime.activeActions?.(current.state, owner.id)).toHaveLength(1)
    runtime.invokeActive!(current as never, owner.id, `skill:${HUANG_WUDIE_SHOUXING}`)
    let request = current.state.pendingRequests.at(-1)!
    current.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } })
    request = current.state.pendingRequests.at(-1)!
    expect(current.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-cards', min: 2, max: 2 })
    current.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: materials } })
    expect(current.state.zones.discardPile).toContain(materials[1])
    expect(effectiveCardName(current.state, materials[0]!)).toBe('杀')
    expect(current.state.cardUseHistory?.at(-1)).toMatchObject({ sourceId: owner.id, cardName: '杀' })
  })

  it('铩雪在真实造成伤害后可选择摸二并按伤害目标当前距离弃牌', () => {
    const runtime = getSkillRuntime(HUANG_WUDIE_SHAXUE)!
    const current = game()
    const owner = current.state.players[0]!
    const target = current.state.players[1]!
    current.state.status = 'playing'
    grantHuangSkillForTest(current, owner.id, HUANG_WUDIE_SHAXUE)
    runtime.triggers!.find((trigger) => trigger.event === 'DamageSettled')!.handle(current as never, owner.id,
      { event: { name: 'DamageSettled', sourceId: owner.id, targetId: target.id, payload: { finalAmount: 1 } } } as never)
    runtime.startQueued!(current as never, owner.id, current.state.skillQueue.at(-1)! as never)
    expect(current.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-option', skillId: HUANG_WUDIE_SHAXUE })
    const before = owner.zones.hand.length
    let request = current.state.pendingRequests.at(-1)!
    current.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'yes' } })
    expect(owner.zones.hand.length).toBe(before + 2)
    request = current.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-cards', min: 1, max: 1 })
  })

  it('伏械可选择失去已有技能并请求另一角色选择弃牌', () => {
    const runtime = getSkillRuntime(HUANG_WUDIE_FUXIE)!
    const current = game()
    const owner = current.state.players[0]!
    const target = current.state.players[1]!
    owner.characterId = HUANG_WUDIE_B89.id
    current.state.status = 'playing'
    current.state.phase = 'play'
    current.state.currentPlayerId = owner.id
    const targetCard = current.state.zones.drawPile[0]!
    moveCard(current.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    runtime.invokeActive!(current as never, owner.id, `skill:${HUANG_WUDIE_FUXIE}`)
    let request = current.state.pendingRequests.at(-1)!
    current.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'skill' } })
    request = current.state.pendingRequests.at(-1)!
    current.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: HUANG_WUDIE_SHUANGRUI } })
    expect(owner.permanentlyLostSkills).toContain(HUANG_WUDIE_SHUANGRUI)
    request = current.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-targets', skillId: HUANG_WUDIE_FUXIE })
    current.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } })
    expect(current.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-cards', playerId: target.id, min: 1, max: 1 })
  })
})

function grantHuangSkillForTest(current: SanguoshaGame, ownerId: string, skillId: string): void {
  const owner = current.state.players.find((player) => player.id === ownerId)!
  owner.temporaryGrantedSkills ??= []
  owner.temporaryGrantedSkills.push({ source: `${HUANG_WUDIE_SHUANGRUI}:turn`, skillId })
  const state = current.state as typeof current.state & { paperSanguoshaB89?: { huangWudieTemporarySkills?: Record<string, { turnNumber: number; ids: string[] }> } }
  state.paperSanguoshaB89 ??= {}
  state.paperSanguoshaB89.huangWudieTemporarySkills ??= {}
  state.paperSanguoshaB89.huangWudieTemporarySkills[ownerId] = { turnNumber: current.state.turnNumber, ids: [skillId] }
}
