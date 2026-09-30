import { describe, expect, it } from 'vitest'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { wineUseAllowed } from '@/sanguosha/engine/cards/basic'
import { hasUnlimitedSlash } from '@/sanguosha/engine/equipment'
import { drawCards } from '@/sanguosha/engine/draw'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { hiddenHandSlot } from '@/sanguosha/engine/cards/host'
import { moveCard } from '@/sanguosha/engine/zones'
import { abolishedSlotsOf } from '@/sanguosha/engine/equipment-slots'
import { canTarget } from '@/sanguosha/engine/distance'
import { adjustOutgoingDamage } from '@/sanguosha/engine/damage-modifiers'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import type { SanguoshaState } from '@/sanguosha/engine/types'

const XINYING_SKILL = 'jiejie-shi-xinxianying:b57'
const CUI_XISHANG_SKILL = 'xishang-cui-fu:b57'
const CUI_CAIQIU_SKILL = 'caiqiu-cui-fu:b57'
const CHEN_QUANCHONG_SKILL = 'quanchong-shi-chenzhi:b57'
const CHEN_RENXING_SKILL = 'renxing-shi-chenzhi:b57'
const HUAN_GONGMOU_SKILL = 'gongmou-shi-huanjie:b57'
const HUAN_ZHENGSHUO_SKILL = 'zhengshuo-shi-huanjie:b57'
const WANG_KAIJI_SKILL = 'kaiji-shi-wangchang:b57'
const WANG_SHEPAN_SKILL = 'shepan-shi-wangchang:b57'
const MAO_CUIZHEN_SKILL = 'cuizhen-xuan-maoqiujian:b57'
const MAO_KUILI_SKILL = 'kuili-xuan-maoqiujian:b57'
const LUSU_DIMENG_SKILL = 'dimeng-shi-lusu:b57'
const LUSU_HAOSHI_SKILL = 'haoshi-shi-lusu:b57'
const YUJIN_ZHENJUN_SKILL = 'zhenjun-sp-yujin:b57'
const ZH_SIZI_SKILL = 'sizi-shi-zhonghui:b57'
const ZH_XIEZHI_SKILL = 'xiezhi-shi-zhonghui:b57'
const ZH_YUNAN_SKILL = 'yunan-shi-zhonghui:b57'
const ZH_KECHANG_SKILL = 'kechang-shi-zhonghui:b57'
const DA_TUNTIAN_SKILL = 'tuntian-shi-dengai:b57'
const DA_JIXI_SKILL = 'jixi-shi-dengai:b57'

describe('第57批武将册注册', () => {
  it('编号681至690的十名武将及其技能均在正式角色池中注册', () => {
    const expected: Array<[string, string, string[]]> = [
      ['shi-xinxianying-b57', '势·辛宪英', ['jiejie-shi-xinxianying:b57', 'qingshi-shi-xinxianying:b57']],
      ['xuan-maoqiujian-b57', '玄·毌丘俭', ['cuizhen-xuan-maoqiujian:b57', 'kuili-xuan-maoqiujian:b57']],
      ['cui-fu-b57', '崔芙', ['caiqiu-cui-fu:b57', 'xishang-cui-fu:b57']],
      ['shi-lusu-b57', '势·鲁肃', ['haoshi-shi-lusu:b57', 'dimeng-shi-lusu:b57']],
      ['shi-chenzhi-b57', '势·陈祗', ['quanchong-shi-chenzhi:b57', 'renxing-shi-chenzhi:b57']],
      ['shi-zhonghui-b57', '势·钟会', ['sizi-shi-zhonghui:b57', 'xiezhi-shi-zhonghui:b57', 'yunan-shi-zhonghui:b57', 'kechang-shi-zhonghui:b57']],
      ['shi-wangchang-b57', '势·王昶', ['kaiji-shi-wangchang:b57', 'shepan-shi-wangchang:b57']],
      ['sp-yujin-b57', 'SP·于禁', ['zhenjun-sp-yujin:b57']],
      ['shi-dengai-b57', '势·邓艾', ['tuntian-shi-dengai:b57', 'zaoxian-shi-dengai:b57', 'jixi-shi-dengai:b57']],
      ['shi-huanjie-b57', '势·桓阶', ['gongmou-shi-huanjie:b57', 'zhengshuo-shi-huanjie:b57']],
    ]
    for (const [id, name, skillIds] of expected) {
      const character = getCharacter(id)
      expect(character?.name).toBe(name)
      expect(character?.skills.map(({ id: skillId }) => skillId)).toEqual(skillIds)
      for (const skillId of skillIds) expect(getSkillRuntime(skillId)).toBeDefined()
    }
  })
})

function fixture() {
  const game = new SanguoshaGame({ seed: 'batch57-xinying-quota', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `b57p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const actor = game.state.players[0]!
  actor.grantedSkills.push(XINYING_SKILL)
  game.state.turnNumber = 7
  game.state.turnUsage.wineUses = 1
  const matchingCardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === 'heart')!
  const otherCardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit !== 'heart')!
  const state = game.state as SanguoshaState & {
    b57Xinying: { phaseTurnByPlayer: Record<string, number>; roundCounts: Record<string, { roundNumber: number; count: number }>; suitCounts: Record<string, { roundNumber: number; count: number }>; unlimitedSuit: Record<string, Array<{ sourceOwnerId: string; turnNumber: number; suit: 'heart' }>> }
  }
  state.b57Xinying = { phaseTurnByPlayer: {}, roundCounts: {}, suitCounts: {}, unlimitedSuit: { [actor.id]: [{ sourceOwnerId: 'xinying', turnNumber: 7, suit: 'heart' }] } }
  return { game, actor, matchingCardId, otherCardId }
}

describe('第57批定向验证：诫节花色次数豁免', () => {
  it('只豁免本回合所选花色的杀和酒，不解除其他牌的通常限制', () => {
    const { game, actor, matchingCardId, otherCardId } = fixture()
    expect(hasUnlimitedSlash(game.state, actor.id, matchingCardId)).toBe(true)
    expect(hasUnlimitedSlash(game.state, actor.id, otherCardId)).toBe(false)
    expect(wineUseAllowed(game.state, actor.id, matchingCardId)).toBe(true)
    expect(wineUseAllowed(game.state, actor.id, otherCardId)).toBe(false)
  })

  it('回合结束后，上一回合的花色效果不再生效', () => {
    const { game, actor, matchingCardId } = fixture()
    game.state.turnNumber += 1
    expect(hasUnlimitedSlash(game.state, actor.id, matchingCardId)).toBe(false)
    expect(wineUseAllowed(game.state, actor.id, matchingCardId)).toBe(false)
  })

  it('清识在身份局按主忠阵营而非武将势力判断', () => {
    const game = new SanguoshaGame({ seed: 'batch57-qingshi-camp', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `qingshicamp${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'shi-xinxianying-b57'
    owner.grantedSkills.push('qingshi-shi-xinxianying:b57')
    owner.kingdomOverride = 'wei'
    target.kingdomOverride = 'shu'
    const ownerHand = owner.zones.hand.length
    const targetHand = target.zones.hand.length
    const runtime = getSkillRuntime('qingshi-shi-xinxianying:b57')!
    runtime.resume!(game as never, owner.id, { step: 'target', data: {} } as never,
      { payload: { targetIds: [target.id] } } as never)
    expect(owner.zones.hand).toHaveLength(ownerHand + 1)
    expect(target.zones.hand).toHaveLength(targetHand + 1)
  })
})

describe('第57批定向验证：袭裳明置手牌的公共规则', () => {
  it('非摸牌获得的手牌公开、摸牌不公开，且离开手牌区后清除明置状态', () => {
    const game = new SanguoshaGame({ seed: 'batch57-xichang-faceup', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `facep${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[1]!
    const viewer = game.state.players[0]!
    owner.characterId = 'cui-fu-b57'
    owner.grantedSkills.push('xishang-cui-fu:b57')
    const obtained = game.state.zones.drawPile[0]!
    moveCard(game.state, obtained, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const gainHandler = getSkillRuntime(CUI_XISHANG_SKILL)!.triggers!.find(({ event }) => event === 'GainCard')!.handle
    const gainEvent = game.dispatch('GainCard', { playerId: owner.id, cardIds: [obtained], reason: 'test-steal' }, { targetId: owner.id, cardIds: [obtained] })
    gainHandler(game as never, owner.id, gainEvent)
    expect(game.viewFor(viewer.id).players.find(({ id }) => id === owner.id)?.faceUpHand.map(({ id }) => id)).toContain(obtained)
    expect(game.viewFor(owner.id).players.find(({ id }) => id === owner.id)?.faceUpHand).toEqual([])

    game.state.pendingRequests.push({
      id: 'faceup-hidden-choice', kind: 'choose-cards', playerId: viewer.id, prompt: '选择牌', timeoutMs: 1000,
      optional: false, cardIds: [], hiddenCardSlots: [hiddenHandSlot(owner.id, 0)], min: 1, max: 1,
    })
    expect(game.viewFor(viewer.id).players.find(({ id }) => id === owner.id)?.faceUpHand).toEqual([])
    game.state.pendingRequests = []

    moveCard(game.state, obtained, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    const drawn = drawCards(game.state, game.rng, owner.id, 1, (name, payload) => {
      const context = game.dispatch(name, payload, { targetId: owner.id, cardIds: payload.cardIds as string[] })
      if (name === 'GainCard') gainHandler(game as never, owner.id, context)
    })
    expect(game.state.faceUpHandCards?.[owner.id]).toBeUndefined()
    expect(drawn).toHaveLength(1)
  })

  it('裁裘每轮亮出游戏人数张牌，只获得所选牌；他人本轮使用同名牌后失去体力', () => {
    const game = new SanguoshaGame({ seed: 'batch57-caiqiu-round', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `caiqiu${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[1]!
    const other = game.state.players[2]!
    const hpBeforeMatchingUse = owner.hp
    for (const player of game.state.players) player.characterId = null
    owner.characterId = 'cui-fu-b57'
    owner.grantedSkills.push(CUI_CAIQIU_SKILL, CUI_XISHANG_SKILL)
    game.state.b57CuiFu = { shape: { [owner.id]: 1 }, recordedNames: {} } as never
    game.state.status = 'playing'
    game.state.roundNumber = 1
    game.state.turnNumber = 1
    game.state.pendingRequests = []
    game.state.skillResolution = null
    const runtime = getSkillRuntime(CUI_CAIQIU_SKILL)!
    const roundStart = runtime.triggers!.find(({ event }) => event === 'RoundStart')!
    const startContext = { event: { id: 'round-start-test', seq: 1, name: 'RoundStart', payload: { roundNumber: 1 } }, cancelled: false, cancel() {} } as never
    roundStart.handle(game as never, owner.id, startContext)
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    if (request.kind !== 'choose-cards') throw new Error('裁裘没有展示轮初选牌请求')
    expect(request.cardIds).toHaveLength(5)
    const chosen = request.cardIds[0]!
    const chosenName = game.state.cards[chosen]!.name
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [chosen] } })
    expect(owner.zones.hand).toContain(chosen)
    expect(game.state.b57CuiFu?.recordedNames[owner.id]).toEqual({ roundNumber: 1, names: [chosenName] })

    const afterUse = runtime.triggers!.find(({ event }) => event === 'AfterCardUse')!
    expect(afterUse).toBeDefined()
    game.dispatch('AfterCardUse', { cardName: chosenName }, { sourceId: other.id })
    expect(owner.hp).toBe(hpBeforeMatchingUse - 1)
  })
})

describe('第57批定向验证：势·陈祗回合技能', () => {
  it('权宠弃置手牌与装备并排入一个额外回合', () => {
    const game = new SanguoshaGame({ seed: 'batch57-quanchong', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `quan${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    owner.characterId = 'shi-chenzhi-b57'
    owner.grantedSkills.push(CHEN_QUANCHONG_SKILL)
    game.state.roundNumber = 2
    const runtime = getSkillRuntime(CHEN_QUANCHONG_SKILL)!
    runtime.resume!(game as never, owner.id, {
      kind: 'skill', skillId: CHEN_QUANCHONG_SKILL, ownerId: owner.id, step: 'invoke', requestId: 'test', data: {}, announced: true,
    }, { requestId: 'test', playerId: owner.id, payload: { optionId: 'invoke' } })
    expect(owner.zones.hand).toEqual([])
    expect(Object.values(owner.zones.equipment).every((cardId) => cardId === null)).toBe(true)
    expect(game.state.extraTurns).toContainEqual(expect.objectContaining({ playerId: owner.id, sourceSkillId: CHEN_QUANCHONG_SKILL }))
    expect(game.state.b57ChenZhi?.quanChongRoundUses[owner.id]).toEqual({ roundNumber: 2, count: 1 })
  })

  it('任行只对弃牌阶段外的首次弃牌排队，且排除本回合已使用【杀】的角色', () => {
    const game = new SanguoshaGame({ seed: 'batch57-renxing', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `ren${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const slashUser = game.state.players[1]!
    const other = game.state.players[2]!
    owner.characterId = 'shi-chenzhi-b57'
    owner.grantedSkills.push(CHEN_RENXING_SKILL)
    game.state.roundNumber = 1
    game.state.phase = 'play'
    game.state.status = 'playing'
    const targetHandCard = game.state.zones.drawPile[0]!
    moveCard(game.state, targetHandCard, { kind: 'drawPile' }, { kind: 'hand', playerId: other.id })
    const state = game.state as SanguoshaState & { b57ChenZhi?: { quanChongRoundUses: Record<string, { roundNumber: number; count: number }>; renXingRoundUses: Record<string, { roundNumber: number; count: number }>; renXingTurnPrompted: Record<string, number>; slashUsersByTurn: Record<number, string[]> } }
    state.b57ChenZhi = { quanChongRoundUses: {}, renXingRoundUses: {}, renXingTurnPrompted: {}, slashUsersByTurn: { [game.state.turnNumber]: [slashUser.id] } }
    const trigger = getSkillRuntime(CHEN_RENXING_SKILL)!.triggers!.find(({ event }) => event === 'CardEnteredDiscardByMove')!
    trigger.handle(game as never, owner.id, { event: { id: 'discard', seq: 1, name: 'CardEnteredDiscardByMove', payload: { fromPlayerId: other.id, reason: 'discard' } }, cancelled: false, cancel() {} } as never)
    expect(game.state.skillQueue).toContainEqual(expect.objectContaining({ skillId: CHEN_RENXING_SKILL, step: 'invoke' }))
    trigger.handle(game as never, owner.id, { event: { id: 'discard-2', seq: 2, name: 'CardEnteredDiscardByMove', payload: { fromPlayerId: other.id, reason: 'discard' } }, cancelled: false, cancel() {} } as never)
    expect(game.state.skillQueue).toHaveLength(1)
    const runtime = getSkillRuntime(CHEN_RENXING_SKILL)!
    runtime.startQueued!(game as never, owner.id, game.state.skillQueue[0]!)
    const invokeResolution = game.state.skillResolution!
    expect(invokeResolution.step).toBe('invoke')
    expect(invokeResolution.data.discardCandidates).not.toContain(slashUser.id)
    expect(invokeResolution.data.discardCandidates).toContain(other.id)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, invokeResolution, {
      requestId: invokeResolution.requestId, playerId: owner.id, payload: { optionId: 'discard' },
    })
    const targetRequest = game.state.pendingRequests.at(-1)!
    expect(targetRequest.kind).toBe('choose-targets')
    if (targetRequest.kind !== 'choose-targets') throw new Error('任行未进入弃置目标选择')
    expect(targetRequest.candidateIds).not.toContain(slashUser.id)
    game.state.phase = 'discard'
    game.state.turnNumber += 1
    trigger.handle(game as never, owner.id, { event: { id: 'discard-3', seq: 3, name: 'CardEnteredDiscardByMove', payload: { fromPlayerId: other.id, reason: 'discard' } }, cancelled: false, cancel() {} } as never)
    expect(game.state.skillQueue).toHaveLength(1)
  })
})

describe('第57批定向验证：势·桓阶手牌规则', () => {
  it('共谋真实交换全部手牌，且奇策与看破只保留到当前回合结束', () => {
    const game = new SanguoshaGame({ seed: 'batch57-gongmou', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `gong${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'shi-huanjie-b57'
    owner.grantedSkills.push(HUAN_GONGMOU_SKILL)
    const ownerCard = game.state.zones.drawPile[0]!
    const targetCard = game.state.zones.drawPile[1]!
    moveCard(game.state, ownerCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const runtime = getSkillRuntime(HUAN_GONGMOU_SKILL)!
    runtime.resume!(game as never, owner.id, {
      kind: 'skill', skillId: HUAN_GONGMOU_SKILL, ownerId: owner.id, step: 'target', requestId: 'target',
      data: { candidates: [target.id] }, announced: true,
    }, { requestId: 'target', playerId: owner.id, payload: { targetIds: [target.id] } })
    expect(owner.zones.hand).toContain(targetCard)
    expect(target.zones.hand).toContain(ownerCard)
    expect(owner.temporaryGrantedSkills).toContainEqual({ source: `b57-huanjie:${owner.id}`, skillId: 'qice' })
    expect(target.temporaryGrantedSkills).toContainEqual({ source: `b57-huanjie:${owner.id}`, skillId: 'kanpo' })

    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    expect(getSkillRuntime('qice')!.activeActions!(game.state, owner.id)).toContainEqual(expect.objectContaining({
      id: 'qice-invoke',
    }))

    const turnEnd = runtime.triggers!.find(({ event }) => event === 'TurnEnd')!
    turnEnd.handle(game as never, owner.id, { event: { id: 'turn-end', seq: 1, name: 'TurnEnd', payload: { playerId: owner.id, turnNumber: game.state.turnNumber } }, cancelled: false, cancel() {} } as never)
    expect(owner.temporaryGrantedSkills).not.toContainEqual(expect.objectContaining({ source: `b57-huanjie:${owner.id}` }))
    expect(target.temporaryGrantedSkills).not.toContainEqual(expect.objectContaining({ source: `b57-huanjie:${owner.id}` }))
  })

  it('正朔弃置全场手牌、整体洗牌后所有存活角色各摸四张', () => {
    const game = new SanguoshaGame({ seed: 'batch57-zhengshuo', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `zheng${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    owner.characterId = 'shi-huanjie-b57'
    owner.grantedSkills.push(HUAN_ZHENGSHUO_SKILL)
    game.state.status = 'playing'
    const beforeCount = game.state.zones.drawPile.length + game.state.zones.discardPile.length
    const beforeHandCount = game.state.players.reduce((count, player) => count + player.zones.hand.length, 0)
    getSkillRuntime(HUAN_ZHENGSHUO_SKILL)!.resume!(game as never, owner.id, {
      kind: 'skill', skillId: HUAN_ZHENGSHUO_SKILL, ownerId: owner.id, step: 'invoke', requestId: 'invoke', data: {}, announced: true,
    }, { requestId: 'invoke', playerId: owner.id, payload: { optionId: 'invoke' } })
    expect(game.state.players.filter((player) => player.alive).every((player) => player.zones.hand.length === 4)).toBe(true)
    expect(owner.usedLimitedSkills).toContain(HUAN_ZHENGSHUO_SKILL)
    expect(game.state.deckReshuffle?.count).toBe(1)
    expect(game.state.zones.drawPile.length + game.state.zones.discardPile.length).toBe(beforeCount + beforeHandCount - 20)
  })
})

describe('第57批定向验证：势·王昶濒死计数与慑叛次数', () => {
  it('开济按曾进入濒死且仍存活的人数设置目标上限，并对非基本牌获得触发额外摸牌', () => {
    const game = new SanguoshaGame({ seed: 'batch57-kaiji', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `kaiji${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const firstTarget = game.state.players[1]!
    const secondTarget = game.state.players[2]!
    owner.characterId = 'shi-wangchang-b57'
    owner.grantedSkills.push(WANG_KAIJI_SKILL)
    game.state.status = 'playing'
    const runtime = getSkillRuntime(WANG_KAIJI_SKILL)!
    const enterDying = runtime.triggers!.find(({ event }) => event === 'EnterDying')!
    for (const player of [firstTarget, secondTarget])
      enterDying.handle(game as never, owner.id, { event: { id: `dying-${player.id}`, seq: 1, name: 'EnterDying', targetId: player.id, payload: { playerId: player.id } }, cancelled: false, cancel() {} } as never)

    const phaseStart = runtime.triggers!.find(({ event }) => event === 'PhaseStart')!
    phaseStart.handle(game as never, owner.id, { event: { id: 'prepare', seq: 3, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'prepare' } }, cancelled: false, cancel() {} } as never)
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    if (request.kind !== 'choose-targets') throw new Error('开济未请求目标选择')
    expect(request.max).toBe(2)

    const nonBasic = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.category !== 'basic')!
    game.state.zones.drawPile.splice(game.state.zones.drawPile.indexOf(nonBasic), 1)
    game.state.zones.drawPile.unshift(nonBasic)
    const targetHandBefore = firstTarget.zones.hand.length
    const ownerHandBefore = owner.zones.hand.length
    const resolution = game.state.skillResolution!
    runtime.resume!(game as never, owner.id, resolution, {
      requestId: request.id, playerId: owner.id, payload: { targetIds: [firstTarget.id] },
    })
    expect(firstTarget.zones.hand).toHaveLength(targetHandBefore + 1)
    expect(owner.zones.hand).toHaveLength(ownerHandBefore + 1)
  })

  it('慑叛同回合只能发动一次，同轮对已选牌名不再提供第二次目标拦截', () => {
    const game = new SanguoshaGame({ seed: 'batch57-shepan', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `shepan${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const source = game.state.players[1]!
    owner.characterId = 'shi-wangchang-b57'
    owner.grantedSkills.push(WANG_SHEPAN_SKILL)
    game.state.status = 'playing'
    const runtime = getSkillRuntime(WANG_SHEPAN_SKILL)!
    const intercept = (cardName: string) => runtime.interceptTarget!(game as never, owner.id, {
      sourceId: source.id, targetId: owner.id, cardId: game.state.zones.drawPile[0]!, cardName,
      category: cardName === '杀' ? 'basic' : 'trick',
    } as never)
    expect(intercept('杀')).toBe(true)
    const request = game.state.pendingRequests.at(-1)!
    const ownerHandBefore = owner.zones.hand.length
    runtime.resume!(game as never, owner.id, game.state.skillResolution!, {
      requestId: request.id, playerId: owner.id, payload: { optionId: 'draw' },
    })
    game.state.skillResolution = null
    game.state.pendingRequests = []
    expect(owner.zones.hand).toHaveLength(ownerHandBefore + 1)
    expect(intercept('火攻')).toBe(false)
    game.state.turnNumber += 1
    expect(intercept('杀')).toBe(false)
    expect(intercept('火攻')).toBe(true)
  })
})

describe('第57批定向验证：玄·毌丘俭开局废武器与摧阵', () => {
  it('开局目标请求由摧阵运行时结算，之后仅对满足手牌条件的伤害牌目标提供废武器选择', () => {
    const game = new SanguoshaGame({ seed: 'batch57-cuizhen', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `cuizhen${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const firstTarget = game.state.players[1]!
    const secondTarget = game.state.players[2]!
    const laterTarget = game.state.players[3]!
    owner.characterId = 'xuan-maoqiujian-b57'
    owner.grantedSkills.push(MAO_CUIZHEN_SKILL, MAO_KUILI_SKILL)
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    while (laterTarget.zones.hand.length < laterTarget.hp) {
      const cardId = game.state.zones.drawPile[0]!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: laterTarget.id })
    }
    const runtime = getSkillRuntime(MAO_CUIZHEN_SKILL)!
    runtime.onGameStart!(game as never, owner.id)
    const openingRequest = game.state.pendingRequests.at(-1)!
    expect(openingRequest.kind).toBe('choose-targets')
    if (openingRequest.kind !== 'choose-targets') throw new Error('摧阵未发出开局目标请求')
    expect(openingRequest.max).toBe(3)
    game.respond({ requestId: openingRequest.id, playerId: owner.id, payload: { targetIds: [firstTarget.id, secondTarget.id] } })
    expect(abolishedSlotsOf(game.state, firstTarget.id)).toContain('weapon')
    expect(abolishedSlotsOf(game.state, secondTarget.id)).toContain('weapon')

    const targetSpecified = runtime.triggers!.find(({ event }) => event === 'TargetSpecified')!
    targetSpecified.handle(game as never, owner.id, { event: {
      id: 'target-specified', seq: 1, name: 'TargetSpecified', sourceId: owner.id,
      payload: { cardName: '杀', targetIds: [laterTarget.id] },
    }, cancelled: false, cancel() {} } as never)
    const queued = game.state.skillQueue.find(({ skillId }) => skillId === MAO_CUIZHEN_SKILL)
    expect(queued?.step).toBe('target')
    runtime.startQueued!(game as never, owner.id, queued!)
    const targetRequest = game.state.pendingRequests.at(-1)!
    expect(targetRequest.kind).toBe('choose-targets')
    if (targetRequest.kind !== 'choose-targets') throw new Error('摧阵未请求废除目标武器栏')
    expect(targetRequest.candidateIds).toEqual([laterTarget.id])
    game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [laterTarget.id] } })
    expect(abolishedSlotsOf(game.state, laterTarget.id)).toContain('weapon')

    const drawPhase = runtime.triggers!.find(({ event }) => event === 'DrawPhase')!
    const drawPayload: { playerId: string; count: number } = { playerId: owner.id, count: 2 }
    drawPhase.handle(game as never, owner.id, { event: { id: 'draw-phase', seq: 2, name: 'DrawPhase', payload: drawPayload }, cancelled: false, cancel() {} } as never)
    expect(drawPayload.count).toBe(5)
  })
})

describe('第57批定向验证：崔芙形象技能分支选择', () => {
  it('开局选择东郊后启用东郊分支，但通用裁裘仍于每轮开始触发', () => {
    const game = new SanguoshaGame({ seed: 'batch57-cui-shape', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `cuifu${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    owner.characterId = 'cui-fu-b57'
    owner.grantedSkills.push(CUI_XISHANG_SKILL, CUI_CAIQIU_SKILL)
    game.state.status = 'playing'
    const runtime = getSkillRuntime(CUI_XISHANG_SKILL)!
    runtime.onGameStart!(game as never, owner.id)
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    if (request.kind !== 'choose-option') throw new Error('袭裳未请求选择形象')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'shape-2' } })
    expect(game.state.b57CuiFu?.shape[owner.id]).toBe(2)

    const caiqiu = getSkillRuntime(CUI_CAIQIU_SKILL)!
    const roundStart = caiqiu.triggers!.find(({ event }) => event === 'RoundStart')!
    roundStart.handle(game as never, owner.id, { event: { id: 'round-start', seq: 2, name: 'RoundStart', payload: { roundNumber: 1 } }, cancelled: false, cancel() {} } as never)
    const caiqiuRequest = game.state.pendingRequests.at(-1)!
    expect(caiqiuRequest.kind).toBe('choose-cards')
    if (caiqiuRequest.kind !== 'choose-cards') throw new Error('通用裁裘没有在轮开始触发')
    expect(caiqiuRequest.cardIds).toHaveLength(game.state.players.length)
  })

  it('桂殿对有明置牌角色的结束阶段执行减益并发动裁裘，明置满X张牌后可永久提升数值', () => {
    const game = new SanguoshaGame({ seed: 'batch57-cui-guiguan', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `guiguan${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const current = game.state.players[1]!
    owner.characterId = 'cui-fu-b57'
    owner.grantedSkills.push(CUI_XISHANG_SKILL, CUI_CAIQIU_SKILL)
    game.state.status = 'playing'
    const initialFaceUp = game.state.zones.drawPile[0]!
    moveCard(game.state, initialFaceUp, { kind: 'drawPile' }, { kind: 'hand', playerId: current.id })
    game.state.faceUpHandCards = { [current.id]: [initialFaceUp] }
    const state = game.state as SanguoshaState & { b57CuiFu: {
      shape: Record<string, 1 | 2 | 3>
      recordedNames: Record<string, { roundNumber: number; names: string[] }>
      shape1Uses: Record<string, number>
      statChange: Record<string, { draw: number; slash: number; hand: number }>
      faceUpProgress: Record<string, number>
    } }
    state.b57CuiFu = {
      shape: { [owner.id]: 1 }, recordedNames: {}, shape1Uses: { [owner.id]: 0 },
      statChange: { [owner.id]: { draw: 0, slash: 0, hand: 0 } }, faceUpProgress: { [owner.id]: 0 },
    }
    const runtime = getSkillRuntime(CUI_XISHANG_SKILL)!
    const phaseStart = runtime.triggers!.find(({ event }) => event === 'PhaseStart')!
    phaseStart.handle(game as never, owner.id, { event: { id: 'finish-start', seq: 1, name: 'PhaseStart', payload: { playerId: current.id, phase: 'finish' } }, cancelled: false, cancel() {} } as never)
    const queued = game.state.skillQueue.find(({ skillId, step }) => skillId === CUI_XISHANG_SKILL && step === 'shape1-decrease')!
    expect(queued).toBeDefined()
    game.state.skillQueue.splice(game.state.skillQueue.indexOf(queued), 1)
    runtime.startQueued!(game as never, owner.id, queued)
    const decrease = game.state.pendingRequests.at(-1)!
    expect(decrease.kind).toBe('choose-option')
    if (decrease.kind !== 'choose-option') throw new Error('桂殿未请求降低一项数值')
    game.respond({ requestId: decrease.id, playerId: owner.id, payload: { optionId: 'slash' } })
    expect(state.b57CuiFu.statChange[owner.id]!.slash).toBe(-1)
    expect(state.b57CuiFu.shape1Uses[owner.id]).toBe(1)
    const caiqiuRequest = game.state.pendingRequests.at(-1)!
    expect(caiqiuRequest.kind).toBe('choose-cards')
    if (caiqiuRequest.kind !== 'choose-cards') throw new Error('桂殿减少数值后没有发动裁裘')
    game.respond({ requestId: caiqiuRequest.id, playerId: owner.id, payload: { cardIds: [] } })
    const gained = game.state.zones.drawPile.slice(0, game.state.players.length + 1)
    for (const cardId of gained) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    runtime.triggers!.find(({ event }) => event === 'GainCard')!.handle(game as never, owner.id, { event: {
      id: 'cui-gain', seq: 5, name: 'GainCard', payload: { playerId: owner.id, cardIds: gained, reason: 'cui-test' },
    } } as never)
    expect(game.state.faceUpHandCards?.[owner.id]).toEqual(gained)
    const increase = game.state.skillQueue.find(({ skillId, step }) => skillId === CUI_XISHANG_SKILL && step === 'shape1-increase')!
    expect(increase).toBeDefined()
    game.state.skillQueue.splice(game.state.skillQueue.indexOf(increase), 1)
    runtime.startQueued!(game as never, owner.id, increase)
    const increaseRequest = game.state.pendingRequests.at(-1)!
    expect(increaseRequest.kind).toBe('choose-option')
    if (increaseRequest.kind !== 'choose-option') throw new Error('桂殿未请求增加一项数值')
    game.respond({ requestId: increaseRequest.id, playerId: owner.id, payload: { optionId: 'hand' } })
    expect(runtime.maxCardsBonus!(game.state, owner.id)).toBe(1)
    expect(runtime.globalSlashUses!(game.state, owner.id, owner.id)).toBe(-1)
    runtime.resume!(game as never, owner.id, { step: 'shape1-increase', data: {} } as never,
      { payload: { optionId: 'slash' } } as never)
    expect(runtime.globalSlashUses!(game.state, owner.id, owner.id)).toBe(0)
  })
})

describe('第57批定向验证：崔芙褽装装备转基本牌', () => {
  it('防御坐骑当桃正常消耗装备、每回合该项限一次并按原花色选择牌', () => {
    const game = new SanguoshaGame({ seed: 'batch57-cui-shape3-peach', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `cuishape3-${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    owner.characterId = 'cui-fu-b57'
    owner.grantedSkills.push(CUI_XISHANG_SKILL)
    owner.hp = owner.maxHp - 1
    const horse = game.state.zones.drawPile.find((id) => game.state.cards[id]?.equipmentSlot === 'defensiveHorse')!
    const suit = game.state.cards[horse]!.suit
    moveCard(game.state, horse, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot: 'defensiveHorse' })
    game.state.b57CuiFu = { shape: { [owner.id]: 3 }, recordedNames: {} } as never
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    game.state.turnNumber = 12

    const action = game.legalActions(owner.id).find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(horse))
    expect(action).toMatchObject({ kind: 'use-card', asCardName: '桃', sourceSkillId: CUI_XISHANG_SKILL })
    if (!action || action.kind !== 'use-card') throw new Error('褽装未生成防御坐骑转桃动作')
    game.act(owner.id, action.id)
    expect(owner.zones.equipment.defensiveHorse).toBeNull()
    expect(owner.hp).toBe(owner.maxHp)
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-cards', prompt: expect.stringContaining('褽装') })
    expect(getSkillRuntime(CUI_XISHANG_SKILL)!.viewAs!(game.state, owner.id).some((option) => option.cardId === horse)).toBe(false)
    const gain = game.state.pendingRequests.at(-1)!
    if (gain.kind !== 'choose-cards') throw new Error('褽装未请求选择同花色牌')
    const selected = gain.cardIds.find((id) => game.state.cards[id]?.suit === suit)
    expect(selected).toBeDefined()
    game.respond({ requestId: gain.id, playerId: owner.id, payload: { cardIds: [selected] } })
    expect(owner.zones.hand).toContain(selected)
  })

  it('明置手牌包含四种花色时，以防具转闪保留装备；标准响应也识别该转化', () => {
    const game = new SanguoshaGame({ seed: 'batch57-cui-shape3-retain-dodge', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `cuikeep-${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const attacker = game.state.players[1]!
    owner.characterId = 'cui-fu-b57'
    owner.grantedSkills.push(CUI_XISHANG_SKILL)
    const armor = game.state.zones.drawPile.find((id) => game.state.cards[id]?.equipmentSlot === 'armor')!
    moveCard(game.state, armor, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot: 'armor' })
    const faceUp: string[] = []
    for (const suit of ['spade', 'heart', 'club', 'diamond'] as const) {
      const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === suit)!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
      faceUp.push(cardId)
    }
    game.state.faceUpHandCards = { [owner.id]: faceUp }
    game.state.b57CuiFu = { shape: { [owner.id]: 3 }, recordedNames: {} } as never
    game.state.status = 'playing'

    const options = getSkillRuntime(CUI_XISHANG_SKILL)!.viewAs!(game.state, owner.id)
    expect(options.find((option) => option.cardId === armor)).toMatchObject({ asCardName: '闪', retainCard: true })
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'processingArea' })
    const requestId = 'batch57-retained-response'
    game.state.cardResolution = {
      kind: 'slash', cardId: slash, sourceId: attacker.id, targetId: owner.id, damageNature: 'normal', damageAmount: 1,
      stage: 'awaiting-dodge', requestId, interceptsDone: [], extraCardIds: [], remainingTargetIds: [], dodgeRemaining: 1,
    } as never
    game.state.pendingRequests.push({ id: requestId, kind: 'respond-card', playerId: owner.id, prompt: '出闪', timeoutMs: 1000,
      optional: true, actionIds: [`respond-dodge:${armor}`, 'respond-pass'], requiredCardName: '闪' })
    game.respond({ requestId, playerId: owner.id, payload: { actionId: `respond-dodge:${armor}` } })
    expect(owner.zones.equipment.armor).toBe(armor)
    const gain = game.state.pendingRequests.at(-1)
    expect(gain).toMatchObject({ kind: 'choose-cards', prompt: expect.stringContaining('褽装') })
    if (gain?.kind !== 'choose-cards') throw new Error('褽装响应结算后未请求选择同花色牌')
    const sameSuit = gain.cardIds.find((cardId) => game.state.cards[cardId]?.suit === game.state.cards[armor]?.suit)
    expect(sameSuit).toBeDefined()
    game.respond({ requestId: gain.id, playerId: owner.id, payload: { cardIds: [sameSuit] } })
    expect(owner.zones.hand).toContain(sameSuit)
  })
})

describe('第57批定向验证：崔芙东郊基本牌数值', () => {
  it('明置装备满足类别条件，桃的回复值+1且本回合只强化一张基本牌', () => {
    const game = new SanguoshaGame({ seed: 'batch57-cui-basic-value', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `cuivalue-${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    owner.characterId = 'cui-fu-b57'
    owner.grantedSkills.push(CUI_XISHANG_SKILL)
    owner.hp = owner.maxHp - 3
    const weapon = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.equipmentSlot === 'weapon')!
    const peaches = game.state.zones.drawPile.filter((cardId) => game.state.cards[cardId]?.name === '桃').slice(0, 2)
    expect(peaches).toHaveLength(2)
    moveCard(game.state, weapon, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot: 'weapon' })
    for (const peach of peaches) moveCard(game.state, peach, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.b57CuiFu = { shape: { [owner.id]: 2 }, recordedNames: {} } as never
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    game.state.turnNumber = 23

    const usePeach = (cardId: string) => {
      const action = game.legalActions(owner.id).find((candidate) => candidate.kind === 'use-card'
        && candidate.asCardName === '桃' && candidate.cardIds.includes(cardId))
      if (!action || action.kind !== 'use-card') throw new Error('桃没有生成合法使用动作')
      game.act(owner.id, action.id)
    }
    usePeach(peaches[0]!)
    expect(owner.hp).toBe(Math.min(owner.maxHp, owner.maxHp - 1))
    usePeach(peaches[1]!)
    expect(owner.hp).toBe(owner.maxHp)
  })
})

describe('第57批定向验证：势·鲁肃好施共享使用与响应', () => {
  it('借来的【桃】作为使用者的手牌使用；鲁肃失去最后一张时前两次补至三张', () => {
    const game = new SanguoshaGame({ seed: 'batch57-lusu-haoshi-use', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `lusuhaoshi-${index}`, nickname: `玩家${index}`, isHuman: index < 2 })),
    } })
    const owner = game.state.players[0]!
    const borrower = game.state.players[1]!
    owner.characterId = 'shi-lusu-b57'
    owner.grantedSkills.push(LUSU_HAOSHI_SKILL)
    borrower.hp = borrower.maxHp - 1
    const peach = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃')!
    moveCard(game.state, peach, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.b57ShiLuSuHaoshi = { [owner.id]: { borrowerId: borrower.id } } as never
    game.state.b57ShiLuSuHaoshiRefills = { [owner.id]: 0 } as never
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = borrower.id
    game.state.turnNumber = 16

    const action = game.legalActions(borrower.id).find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(peach))
    expect(action).toMatchObject({ kind: 'use-card', asCardName: '桃', cardOwnerId: owner.id })
    if (!action || action.kind !== 'use-card') throw new Error('好施共享手牌没有生成桃的正常使用动作')
    game.act(borrower.id, action.id)
    expect(owner.zones.hand).toHaveLength(3)
    expect(borrower.hp).toBe(borrower.maxHp)
    expect(game.state.zones.discardPile).toContain(peach)
    expect(game.state.b57ShiLuSuHaoshiRefills?.[owner.id]).toBe(1)
  })

  it('借来的【闪】进入真实响应并从鲁肃手牌消耗，随后触发补牌', () => {
    const game = new SanguoshaGame({ seed: 'batch57-lusu-haoshi-response', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `lusuresponse-${index}`, nickname: `玩家${index}`, isHuman: index < 2 })),
    } })
    const owner = game.state.players[0]!
    const borrower = game.state.players[1]!
    const attacker = game.state.players[2]!
    owner.characterId = 'shi-lusu-b57'
    owner.grantedSkills.push(LUSU_HAOSHI_SKILL)
    const dodge = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '闪')!
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, dodge, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'processingArea' })
    game.state.b57ShiLuSuHaoshi = { [owner.id]: { borrowerId: borrower.id } } as never
    game.state.b57ShiLuSuHaoshiRefills = { [owner.id]: 0 } as never
    game.state.status = 'playing'
    const requestId = 'batch57-haoshi-dodge'
    game.state.cardResolution = {
      kind: 'slash', cardId: slash, sourceId: attacker.id, targetId: borrower.id, damageNature: 'normal', damageAmount: 1,
      stage: 'awaiting-dodge', requestId, interceptsDone: [], extraCardIds: [], remainingTargetIds: [], dodgeRemaining: 1,
    } as never
    game.state.pendingRequests.push({ id: requestId, kind: 'respond-card', playerId: borrower.id, prompt: '出闪', timeoutMs: 1000,
      optional: true, actionIds: [`respond-dodge:${dodge}`, 'respond-pass'], requiredCardName: '闪' })

    game.respond({ requestId, playerId: borrower.id, payload: { actionId: `respond-dodge:${dodge}` } })
    expect(owner.zones.hand).toHaveLength(3)
    expect(game.state.zones.discardPile).toContain(dodge)
    expect(game.state.b57ShiLuSuHaoshiRefills?.[owner.id]).toBe(1)
  })
})

describe('第57批定向验证：势·鲁肃缔盟交换与后续选择', () => {
  it('交换手牌后令手牌较少者摸已损失体力张数，并按新手牌数限定候选', () => {
    const game = new SanguoshaGame({ seed: 'batch57-dimeng-draw', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `dimeng${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const first = game.state.players[1]!
    const second = game.state.players[2]!
    owner.characterId = 'shi-lusu-b57'
    owner.grantedSkills.push(LUSU_DIMENG_SKILL)
    owner.hp = Math.max(1, owner.maxHp - 2)
    game.state.status = 'playing'
    const giveHandCards = (playerId: string, count: number) => {
      for (let index = 0; index < count; index += 1) {
        const cardId = game.state.zones.drawPile[0]!
        moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
      }
    }
    giveHandCards(first.id, 1)
    giveHandCards(second.id, 3)
    const runtime = getSkillRuntime(LUSU_DIMENG_SKILL)!
    const phaseStart = runtime.triggers!.find(({ event }) => event === 'PhaseStart')!
    phaseStart.handle(game as never, owner.id, { event: { id: 'play-start', seq: 1, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'play' } }, cancelled: false, cancel() {} } as never)
    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    if (request.kind !== 'choose-targets') throw new Error('缔盟未请求第一名角色')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [first.id] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    if (request.kind !== 'choose-targets') throw new Error('缔盟未请求第二名角色')
    expect(request.candidateIds).toContain(second.id)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [second.id] } })
    expect(first.zones.hand).toHaveLength(3)
    expect(second.zones.hand).toHaveLength(1)

    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    if (request.kind !== 'choose-option') throw new Error('缔盟未请求交换后的效果选择')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'draw' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    if (request.kind !== 'choose-targets') throw new Error('缔盟未请求摸牌目标')
    expect(request.candidateIds).toEqual([second.id])
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [second.id] } })
    expect(second.zones.hand).toHaveLength(3)
    expect((game.state as SanguoshaState & { b57ShiLuSuDimengUsedTurn?: Record<string, number> }).b57ShiLuSuDimengUsedTurn?.[owner.id]).toBe(game.state.turnNumber)
  })

  it('弃牌选项按已损失体力弃牌；手牌不足时弃置全部手牌', () => {
    const game = new SanguoshaGame({ seed: 'batch57-dimeng-discard', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `dimeng-discard${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const first = game.state.players[1]!
    const second = game.state.players[2]!
    owner.characterId = 'shi-lusu-b57'
    owner.grantedSkills.push(LUSU_DIMENG_SKILL)
    owner.hp = Math.max(1, owner.maxHp - 2)
    game.state.status = 'playing'
    for (let index = 0; index < 2; index += 1) {
      const cardId = game.state.zones.drawPile[0]!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    }
    const runtime = getSkillRuntime(LUSU_DIMENG_SKILL)!
    runtime.resume!(game as never, owner.id, {
      kind: 'skill', skillId: LUSU_DIMENG_SKILL, ownerId: owner.id, step: 'second-target', requestId: 'second',
      data: { firstId: first.id, candidates: [second.id] }, announced: true,
    }, { requestId: 'second', playerId: owner.id, payload: { targetIds: [second.id] } })
    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    if (request.kind !== 'choose-option') throw new Error('缔盟未请求后续选项')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'discard' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    if (request.kind !== 'choose-cards') throw new Error('缔盟未请求弃牌')
    expect(request.min).toBe(2)
    expect(request.max).toBe(2)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [...owner.zones.hand] } })
    expect(owner.zones.hand).toHaveLength(0)
  })
})

describe('第57批定向验证：SP·于禁镇军交牌、强制出杀与伤害结算', () => {
  function zhenjunGame(seed: string) {
    const game = new SanguoshaGame({ seed, setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const user = game.state.players[1]!
    const victim = game.state.players[2]!
    owner.characterId = 'sp-yujin-b57'
    owner.grantedSkills.push(YUJIN_ZHENJUN_SKILL)
    game.state.status = 'playing'
    return { game, owner, user, victim }
  }

  it('受令角色拒绝或无法使用非黑色杀时，镇军可对其本人造成1点伤害', () => {
    const { game, owner, user } = zhenjunGame('batch57-yujin-decline')
    const gift = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name !== '杀')!
    moveCard(game.state, gift, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const beforeHp = user.hp
    const runtime = getSkillRuntime(YUJIN_ZHENJUN_SKILL)!
    const phaseStart = runtime.triggers!.find(({ event }) => event === 'PhaseStart')!
    phaseStart.handle(game as never, owner.id, { event: { id: 'play-start', seq: 1, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'play' } }, cancelled: false, cancel() {} } as never)
    let request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-targets') throw new Error('镇军未请求受令角色')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [user.id] } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-cards') throw new Error('镇军未请求交牌')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [gift] } })
    expect(user.zones.hand).toContain(gift)
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-option') throw new Error('镇军未询问是否造成伤害')
    expect(request.options.map(({ id }) => id)).toEqual(['damage', 'pass'])
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'damage' } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-targets') throw new Error('镇军未请求伤害目标')
    expect(request.candidateIds).toContain(user.id)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [user.id] } })
    expect(user.hp).toBe(beforeHp - 1)
  })

  it('受令角色使用合法红色杀造成1点伤害后，于杀完整结算后摸2张牌', () => {
    const { game, owner, user, victim } = zhenjunGame('batch57-yujin-slash')
    const gift = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name !== '杀')!
    const slash = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '杀'
      && ['heart', 'diamond'].includes(game.state.cards[cardId]!.suit))!
    moveCard(game.state, gift, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: user.id })
    const beforeHp = victim.hp
    const runtime = getSkillRuntime(YUJIN_ZHENJUN_SKILL)!
    const phaseStart = runtime.triggers!.find(({ event }) => event === 'PhaseStart')!
    phaseStart.handle(game as never, owner.id, { event: { id: 'play-start-slash', seq: 1, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'play' } }, cancelled: false, cancel() {} } as never)
    let request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-targets') throw new Error('镇军未请求受令角色')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [user.id] } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-cards') throw new Error('镇军未请求交牌')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [gift] } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-option') throw new Error('镇军未询问出杀')
    game.respond({ requestId: request.id, playerId: user.id, payload: { optionId: 'use' } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-cards') throw new Error('镇军未请求选择非黑色杀')
    expect(request.cardIds).toContain(slash)
    game.respond({ requestId: request.id, playerId: user.id, payload: { cardIds: [slash] } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-targets') throw new Error('镇军未请求杀目标')
    expect(request.candidateIds).toContain(victim.id)
    game.respond({ requestId: request.id, playerId: user.id, payload: { targetIds: [victim.id] } })
    const responseRequest = game.state.pendingRequests.at(-1)
    if (responseRequest?.kind === 'respond-card')
      game.respond({ requestId: responseRequest.id, playerId: victim.id, payload: { actionId: 'respond-pass' } })
    expect(victim.hp).toBe(beforeHp - 1)
    expect(owner.zones.hand).toHaveLength(2)
  })

  it('受令角色可以用红色转换牌当非黑色杀，并按该转换牌正常结算', () => {
    const { game, owner, user, victim } = zhenjunGame('batch57-yujin-view-as')
    user.characterId = 'guanyu-jie-b36'
    const gift = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name !== '杀')!
    const converted = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '桃'
      && ['heart', 'diamond'].includes(game.state.cards[cardId]!.suit))!
    moveCard(game.state, gift, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, converted, { kind: 'drawPile' }, { kind: 'hand', playerId: user.id })
    const beforeHp = victim.hp
    const runtime = getSkillRuntime(YUJIN_ZHENJUN_SKILL)!
    runtime.triggers!.find(({ event }) => event === 'PhaseStart')!.handle(game as never, owner.id, { event: {
      id: 'play-start-view-as', seq: 1, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'play' },
    }, cancelled: false, cancel() {} } as never)
    let request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-targets') throw new Error('镇军未请求受令角色')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [user.id] } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-cards') throw new Error('镇军未请求交牌')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [gift] } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-option') throw new Error('镇军未询问出杀')
    game.respond({ requestId: request.id, playerId: user.id, payload: { optionId: 'use' } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-cards') throw new Error('镇军未列出转换杀载体')
    expect(request.cardIds).toContain(converted)
    game.respond({ requestId: request.id, playerId: user.id, payload: { cardIds: [converted] } })
    request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-targets') throw new Error('镇军未请求杀目标')
    expect(request.candidateIds).toContain(victim.id)
    game.respond({ requestId: request.id, playerId: user.id, payload: { targetIds: [victim.id] } })
    const response = game.state.pendingRequests.at(-1)
    if (response?.kind === 'respond-card') game.respond({ requestId: response.id, playerId: victim.id, payload: { actionId: 'respond-pass' } })
    expect(victim.hp).toBe(beforeHp - 1)
    expect(owner.zones.hand).toHaveLength(2)
  })
})

describe('第57批定向验证：势·钟会蓄力、持续效果与克昌', () => {
  it('体力变化按变化量补充蓄力，超出4点部分永久增加手牌上限与出杀次数', () => {
    const game = new SanguoshaGame({ seed: 'batch57-zhonghui-charge', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `zhcharge${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    owner.characterId = 'shi-zhonghui-b57'
    owner.grantedSkills.push(ZH_SIZI_SKILL, ZH_XIEZHI_SKILL, ZH_YUNAN_SKILL, ZH_KECHANG_SKILL)
    owner.marks['肆恣蓄力'] = 3
    game.state.b57ZhongHui = { kechangLevel: { [owner.id]: 1 } } as never
    const xiezhi = getSkillRuntime(ZH_XIEZHI_SKILL)!
    const recover = xiezhi.triggers!.find(({ event }) => event === 'Recover')!
    recover.handle(game as never, owner.id, { event: { id: 'recover', seq: 1, name: 'Recover', targetId: owner.id, payload: { playerId: owner.id, amount: 3 } }, cancelled: false, cancel() {} } as never)
    expect(owner.marks['肆恣蓄力']).toBe(4)
    expect(owner.marks['肆恣手牌上限']).toBe(2)
    expect(owner.marks['肆恣杀次数']).toBe(2)
    expect(xiezhi.maxCardsBonus!(game.state, owner.id)).toBe(2)
    expect(xiezhi.globalSlashUses!(game.state, owner.id, owner.id)).toBe(2)
  })

  it('主动消耗所选蓄力点，持续效果期间全场杀伤害增加，并按已用杀角色结算回合惩罚', () => {
    const game = new SanguoshaGame({ seed: 'batch57-zhonghui-burst', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `zhburst${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const actor = game.state.players[1]!
    owner.characterId = 'shi-zhonghui-b57'
    owner.grantedSkills.push(ZH_SIZI_SKILL, ZH_XIEZHI_SKILL, ZH_YUNAN_SKILL, ZH_KECHANG_SKILL)
    owner.marks['肆恣蓄力'] = 3
    owner.hp = 1
    game.state.b57ZhongHui = { kechangLevel: { [owner.id]: 1 } } as never
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    game.state.turnNumber = 8
    const runtime = getSkillRuntime(ZH_SIZI_SKILL)!
    expect(runtime.activeActions!(game.state, owner.id)).toHaveLength(1)
    runtime.invokeActive!(game as never, owner.id, `${ZH_SIZI_SKILL}:activate`)
    const spend = game.state.pendingRequests.at(-1)!
    expect(spend.kind).toBe('choose-option')
    if (spend.kind !== 'choose-option') throw new Error('肆恣未请求消耗蓄力点数')
    game.respond({ requestId: spend.id, playerId: owner.id, payload: { optionId: 'spend-2' } })
    expect(owner.marks['肆恣蓄力']).toBe(1)
    expect(game.state.b57ZhongHui?.active?.[owner.id]).toEqual({ remainingTurns: 2, noSlashPenalty: true })
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const adjustment = adjustOutgoingDamage(game.state, actor.id, {
      targetId: game.state.players[2]!.id, amount: 1, nature: 'normal', cardId: slash, cardName: '杀', chainTransfer: false,
    })
    expect(adjustment.amount).toBe(2)

    actor.hp = 3
    const used = runtime.triggers!.find(({ event }) => event === 'CardUsed')!
    used.handle(game as never, owner.id, { event: { id: 'used-slash', seq: 2, name: 'CardUsed', sourceId: actor.id, payload: { cardName: '杀' } }, cancelled: false, cancel() {} } as never)
    const turnEnd = runtime.triggers!.find(({ event }) => event === 'TurnEnd')!
    turnEnd.handle(game as never, owner.id, { event: { id: 'turn-end', seq: 3, name: 'TurnEnd', payload: { playerId: actor.id, turnNumber: 8 } }, cancelled: false, cancel() {} } as never)
    expect(actor.hp).toBe(2)
    expect(game.state.b57ZhongHui?.active?.[owner.id]?.remainingTurns).toBe(1)
  })

  it('克昌一级只给群势力【杀】无距离限制，迂难觉醒后升至二级且自身杀不可闪避', () => {
    const game = new SanguoshaGame({ seed: 'batch57-kechang', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `zhlord${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const attacker = game.state.players[1]!
    const target = game.state.players[3]!
    owner.characterId = 'shi-zhonghui-b57'
    owner.grantedSkills.push(ZH_KECHANG_SKILL, ZH_YUNAN_SKILL)
    attacker.kingdomOverride = 'qun'
    game.state.b57ZhongHui = { deathRoundByPlayer: { [game.state.players[4]!.id]: 1 }, kechangLevel: { [owner.id]: 1 } } as never
    game.state.roundNumber = 1
    const kechang = getSkillRuntime(ZH_KECHANG_SKILL)!
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const peach = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃')!
    expect(canTarget(game.state, attacker.id, target.id, 0, slash)).toBe(true)
    expect(canTarget(game.state, attacker.id, target.id, 0, peach)).toBe(false)
    owner.identity = 'loyalist'
    expect(canTarget(game.state, attacker.id, target.id, 0, slash)).toBe(false)
    owner.identity = 'lord'

    const yunan = getSkillRuntime(ZH_YUNAN_SKILL)!
    yunan.triggers!.find(({ event }) => event === 'EnterDying')!.handle(game as never, owner.id, { event: {
      id: 'entered-dying', seq: 4, name: 'EnterDying', sourceId: owner.id, targetId: target.id, payload: { playerId: target.id },
    }, cancelled: false, cancel() {} } as never)
    expect(owner.kingdomOverride).toBe('qun')
    expect(game.state.b57ZhongHui?.kechangLevel?.[owner.id]).toBe(2)
    expect(kechang.slashUndodgeable!(game.state, owner.id, target.id)).toBe(true)
    owner.identity = 'loyalist'
    expect(kechang.slashUndodgeable!(game.state, owner.id, target.id)).toBe(false)
  })
})

describe('第57批定向验证：势·邓艾蓄力与急袭多目标', () => {
  it('屯田从0/0起始，非伤害牌损失充能；蓄满时任意角色回合开始摸牌并扩容', () => {
    const game = new SanguoshaGame({ seed: 'batch57-dengai-charge', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `dengcharge${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    owner.characterId = 'shi-dengai-b57'
    owner.grantedSkills.push(DA_TUNTIAN_SKILL)
    const runtime = getSkillRuntime(DA_TUNTIAN_SKILL)!
    runtime.onGameStart!(game as never, owner.id)
    expect(owner.marks['势邓艾蓄力点']).toBe(0)
    expect(owner.marks['势邓艾蓄力上限']).toBe(0)
    runtime.triggers!.find(({ event }) => event === 'TurnStart')!.handle(game as never, owner.id, { event: {
      id: 'first-turn-start', seq: 1, name: 'TurnStart', payload: { playerId: game.state.players[1]!.id, turnNumber: 1 },
    }, cancelled: false, cancel() {} } as never)
    expect(owner.marks['势邓艾蓄力上限']).toBe(1)
    expect(owner.zones.hand).toHaveLength(1)

    const nonDamage = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃')!
    moveCard(game.state, nonDamage, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    runtime.triggers!.find(({ event }) => event === 'LoseCard')!.handle(game as never, owner.id, { event: {
      id: 'lose-nondamage', seq: 2, name: 'LoseCard', payload: { playerId: owner.id, cardIds: [nonDamage] },
    } } as never)
    expect(owner.marks['势邓艾蓄力点']).toBe(1)
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    runtime.triggers!.find(({ event }) => event === 'LoseCard')!.handle(game as never, owner.id, { event: {
      id: 'lose-damage-card', seq: 3, name: 'LoseCard', payload: { playerId: owner.id, cardIds: [slash] },
    } } as never)
    expect(owner.marks['势邓艾蓄力点']).toBe(1)
  })

  it('屯田消耗的单次蓄力点数达到3时从弃牌堆取【无中生有】，并按目标分配红桃牌', () => {
    const game = new SanguoshaGame({ seed: 'batch57-dengai-zaoxian', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `denggain${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const first = game.state.players[1]!
    const second = game.state.players[2]!
    owner.characterId = 'shi-dengai-b57'
    owner.grantedSkills.push(DA_TUNTIAN_SKILL)
    owner.marks['势邓艾蓄力点'] = 3
    owner.marks['势邓艾蓄力上限'] = 3
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    game.state.turnNumber = 4
    const extra = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '无中生有')!
    moveCard(game.state, extra, { kind: 'drawPile' }, { kind: 'discardPile' })
    const runtime = getSkillRuntime(DA_TUNTIAN_SKILL)!
    runtime.invokeActive!(game as never, owner.id, `${DA_TUNTIAN_SKILL}:activate`)
    const spend = game.state.pendingRequests.at(-1)!
    if (spend.kind !== 'choose-option') throw new Error('屯田未请求蓄力点数')
    game.respond({ requestId: spend.id, playerId: owner.id, payload: { optionId: 'spend-3' } })
    const targets = game.state.pendingRequests.at(-1)!
    if (targets.kind !== 'choose-targets') throw new Error('屯田未请求分配红桃牌目标')
    game.respond({ requestId: targets.id, playerId: owner.id, payload: { targetIds: [first.id, second.id] } })
    expect(owner.zones.hand).toContain(extra)
    expect(first.zones.hand.some((id) => game.state.cards[id]?.suit === 'heart')).toBe(true)
    expect(second.zones.hand.some((id) => game.state.cards[id]?.suit === 'heart')).toBe(true)
    expect(owner.marks['势邓艾蓄力点']).toBe(0)
  })

  it('急袭消耗当前回合角色一张牌后，真实使用可指定多个既往牌目标的【顺手牵羊】', () => {
    const game = new SanguoshaGame({ seed: 'batch57-dengai-jixi', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `dengjixi${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    const first = game.state.players[1]!
    const second = game.state.players[2]!
    const current = game.state.players[4]!
    owner.characterId = 'shi-dengai-b57'
    owner.grantedSkills.push(DA_JIXI_SKILL)
    game.state.status = 'playing'
    game.state.turnNumber = 9
    game.state.roundNumber = 2
    game.state.currentPlayerId = current.id
    for (const target of [first, second, current]) {
      const cardId = game.state.zones.drawPile[0]!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    }
    game.state.b57DengAi = { targetsByTurn: { [owner.id]: { turnNumber: 9, targetIds: [first.id, second.id] } } } as never
    const runtime = getSkillRuntime(DA_JIXI_SKILL)!
    runtime.triggers!.find(({ event }) => event === 'TurnEnd')!.handle(game as never, owner.id, { event: {
      id: 'dengai-turn-end', seq: 1, name: 'TurnEnd', payload: { playerId: current.id, turnNumber: 9 },
    }, cancelled: false, cancel() {} } as never)
    const queued = game.state.skillQueue.find(({ step }) => step === 'invoke')!
    expect(queued).toBeDefined()
    game.state.skillQueue.splice(game.state.skillQueue.indexOf(queued), 1)
    runtime.startQueued!(game as never, owner.id, queued)
    const invoke = game.state.pendingRequests.at(-1)!
    if (invoke.kind !== 'choose-option') throw new Error('急袭未询问是否发动')
    game.respond({ requestId: invoke.id, playerId: owner.id, payload: { optionId: 'yes' } })
    const discard = game.state.pendingRequests.at(-1)!
    if (discard.kind !== 'choose-cards') throw new Error('急袭未请求弃置当前回合角色的牌')
    const actorHandSlot = discard.hiddenCardSlots.find((slot) => slot.startsWith(`hidden:${current.id}:`))!
    game.respond({ requestId: discard.id, playerId: owner.id, payload: { cardIds: [actorHandSlot] } })
    const targets = game.state.pendingRequests.at(-1)!
    if (targets.kind !== 'choose-targets') throw new Error('急袭未请求选择顺手牵羊目标')
    expect(targets.candidateIds).toEqual([first.id, second.id])
    game.respond({ requestId: targets.id, playerId: owner.id, payload: { targetIds: [first.id, second.id] } })
    const trick = game.state.cardResolution
    expect(trick?.kind).toBe('trick')
    if (trick?.kind !== 'trick') throw new Error('急袭没有进入顺手牵羊结算')
    expect(trick.targetIds).toEqual([first.id, second.id])
    expect(trick.cardName).toBe('顺手牵羊')
  })
})
