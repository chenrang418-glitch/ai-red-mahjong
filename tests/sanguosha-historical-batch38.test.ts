import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH38_CHARACTERS } from '@/sanguosha/data/characters/historical-batch38'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { movePickedCard } from '@/sanguosha/engine/card-pick'
import { isCardProtectedFromDiscard, ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-b40-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 2
  state.players.forEach((entry: any, index: number) => {
    entry.characterId = index === 0 ? 'jie-lvbu-b40' : index === 1 ? 'caocao' : 'zhangfei'
    entry.hp = 3; entry.maxHp = 4
  })
  const requests: any[] = [], queue: any[] = [], events: any[] = []
  const host = {
    state, rng: game.rng,
    dispatch(name: string, payload: any, metadata: any) { events.push({ name, payload, metadata }); return game.dispatch(name as any, payload, metadata) },
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b40-${requests.length}`) }) },
    queueSkill(prompt: any) { queue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget: game.resumeCardTarget.bind(game), enterDying: game.enterDying.bind(game),
  } as any as SkillHost
  return { game, state, host, requests, queue, events }
}

describe('武将册第40批注册及定向玩法', () => {
  it('注册序号516–525共十将，原生技能均有运行时且武将 ID 无重复', () => {
    expect(HISTORICAL_BATCH38_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH38_CHARACTERS) {
      expect(getCharacter(character.id)).toBe(character)
      expect(skillIdsOf(character.id)).toEqual(character.skills.filter(skill => !skill.granted).map(skill => skill.id))
      for (const skill of character.skills.filter(skill => !skill.granted)) expect(getSkillRuntime(skill.id), `${character.name}/${skill.id}`).toBeDefined()
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('界吕布利驭可取得判定区牌；此牌按非装备分支令原角色摸一张', () => {
    const { state, host, requests } = fixture()
    const victim = state.players[1]
    const delayedTrick = state.zones.drawPile[0]
    state.cards[delayedTrick].name = '乐不思蜀'; state.cards[delayedTrick].category = 'trick'
    moveCard(state, delayedTrick, { kind: 'drawPile' }, { kind: 'judgingArea', playerId: victim.id })

    const runtime = getSkillRuntime('jie-liyu-b40')!
    runtime.startQueued!(host, 'p0', { step: 'ask', data: { targetId: victim.id } } as any)
    expect(requests.at(-1).request.cardIds).toContain(delayedTrick)
    const handBefore = victim.zones.hand.length
    runtime.resume!(host, 'p0', requests.at(-1), { playerId: 'p0', payload: { cardIds: [delayedTrick] } } as any)
    expect(victim.zones.judgingArea).not.toContain(delayedTrick)
    expect(state.players[0].zones.hand).toContain(delayedTrick)
    expect(victim.zones.hand).toHaveLength(handBefore + 1)
    expect(requests.at(-1).step).not.toBe('duel-target')
  })

  it('利驭暗选手牌仍提交隐藏槽，不向吕布泄露牌面', () => {
    const { state, host, requests } = fixture()
    const victim = state.players[1]
    const hiddenCard = state.zones.drawPile[0]
    moveCard(state, hiddenCard, { kind: 'drawPile' }, { kind: 'hand', playerId: victim.id })
    getSkillRuntime('jie-liyu-b40')!.startQueued!(host, 'p0', { step: 'ask', data: { targetId: victim.id } } as any)
    const request = requests.at(-1).request
    expect(request.cardIds).not.toContain(hiddenCard)
    expect(request.hiddenCardSlots).toHaveLength(1)
  })

  it('界张辽突袭按玩家选定数量，从等量不同角色各取一张手牌', () => {
    const { state, host, requests } = fixture()
    const stolen: string[] = []
    for (const targetId of ['p1', 'p2']) {
      const cardId = state.zones.drawPile[0]
      moveCard(state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
      stolen.push(cardId)
    }
    const runtime = getSkillRuntime('jie-tuxi-b40')!
    runtime.resume!(host, 'p0', { step: 'invoke', data: {} } as any, { payload: { optionId: 'yes' } } as any)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { number: 2 } } as any)
    const targetRequest = requests.at(-1)
    expect(targetRequest.request).toMatchObject({ kind: 'choose-targets', min: 2, max: 2 })
    runtime.resume!(host, 'p0', targetRequest, { payload: { targetIds: ['p1', 'p2'] } } as any)
    expect(state.players[0].zones.hand).toEqual(expect.arrayContaining(stolen))
    expect(state.players[1].zones.hand).not.toContain(stolen[0])
    expect(state.players[2].zones.hand).not.toContain(stolen[1])
  })

  it('SP黄月英玲珑只在缺少防具时提供八卦阵，奇才只保护对手弃置', () => {
    const { state, host } = fixture()
    state.players[0].characterId = 'sp-huangyueying-b40'
    const runtime = getSkillRuntime('sp-linglong-b40')!
    expect(runtime.virtualArmor?.(state, 'p0')).toBe('八卦阵')
    const armor = state.zones.drawPile[0]
    state.cards[armor].name = '八卦阵'; state.cards[armor].category = 'equipment'; state.cards[armor].equipmentSlot = 'armor'
    state.players[0].zones.equipment.armor = armor
    expect(runtime.virtualArmor?.(state, 'p0')).toBeNull()
    state.players[0].characterId = 'jie-huangyueying-b40'
    expect(isCardProtectedFromDiscard(state, 'p0', armor, 'p1')).toBe(true)
    expect(isCardProtectedFromDiscard(state, 'p0', armor, 'p0')).toBe(false)
    state.currentPlayerId = 'p1'
    expect(movePickedCard(host, 'p0', armor, { kind: 'discardPile' })).toBe(false)
    expect(state.players[0].zones.equipment.armor).toBe(armor)
  })

  it('SP黄月英机巧公开记录翻开的牌，并取得其中全部锦囊牌', () => {
    const { state, host, requests, events } = fixture()
    state.players[0].characterId = 'sp-huangyueying-b40'
    const equipment = state.zones.drawPile[0]
    state.cards[equipment].name = '诸葛连弩'; state.cards[equipment].category = 'equipment'; state.cards[equipment].equipmentSlot = 'weapon'
    moveCard(state, equipment, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    const revealed = state.zones.drawPile.slice(0, 2)
    state.cards[revealed[0]].name = '无中生有'; state.cards[revealed[0]].category = 'trick'
    state.cards[revealed[1]].name = '杀'; state.cards[revealed[1]].category = 'basic'
    const runtime = getSkillRuntime('sp-jiqiao-b40')!
    runtime.resume!(host, 'p0', { step: 'invoke', data: { candidates: [equipment] } } as any, { payload: { optionId: 'yes' } } as any)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { cardIds: [equipment] } } as any)
    const revealEvent = events.findLast(event => event.name === 'SkillActivated' && event.payload.skillId === 'sp-jiqiao-b40')
    expect(revealEvent.payload.cardIds).toEqual(revealed)
    expect(revealEvent.payload.logText).toContain('无中生有')
    expect(state.players[0].zones.hand).toContain(revealed[0])
    expect(state.players[0].zones.hand).not.toContain(revealed[1])
  })

  it('界孙权救援可改写吴角色对自己的桃目标，并在主公实际回复后令其摸牌', () => {
    const { game, state, host, requests, events } = fixture()
    state.currentPlayerId = 'p1'; state.normalTurnPlayerId = 'p1'
    state.players[0].identity = 'lord'; state.players[0].characterId = 'jie-sunquan-b40'; state.players[0].hp = 1
    state.players[1].characterId = 'sunquan'; state.players[1].hp = 2
    expect(ownedSkillIds(state, 'p0', skillIdsOf)).toContain('jie-jiuyuan-b40')
    const peach = state.zones.drawPile[0]
    state.cards[peach].name = '桃'; state.cards[peach].category = 'basic'
    moveCard(state, peach, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    const action = game.legalActions('p1').find((candidate: any) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(peach) && candidate.targetIds.includes('p1')) as any
    expect(action).toBeDefined()
    const runtime = getSkillRuntime('jie-jiuyuan-b40')!
    expect(runtime.interceptPlayAction!(host, 'p0', action)).toBe(true)
    const resolution = requests.at(-1)
    expect(resolution.request).toMatchObject({ kind: 'choose-option', playerId: 'p1' })
    const handBefore = state.players[1].zones.hand.length
    runtime.resume!(host, 'p0', { step: 'redirect', data: { action } } as any, { payload: { optionId: 'yes' } } as any)
    expect(state.players[0].hp).toBe(2)
    expect(state.players[1].hp).toBe(2)
    expect(events.find(event => event.name === 'Recover')?.metadata.cardIds).toEqual([peach])
    expect(state.jiuyuanRedirectCards?.p1).not.toContain(peach)
    expect(state.players[1].zones.hand).toHaveLength(handBefore)
  })

  it('界许褚裸衣只在实际获得合规牌时跳过摸牌并建立加伤标记', () => {
    const { state, host, requests } = fixture()
    const top = state.zones.drawPile.slice(0, 3)
    state.cards[top[0]].name = '杀'; state.cards[top[0]].category = 'basic'
    state.cards[top[1]].name = '诸葛连弩'; state.cards[top[1]].category = 'equipment'; state.cards[top[1]].equipmentSlot = 'weapon'
    state.cards[top[2]].name = '无中生有'; state.cards[top[2]].category = 'trick'
    const runtime = getSkillRuntime('jie-luoyi-b40')!
    let cancelled = false
    runtime.triggers![0].handle(host, 'p0', { event: { payload: { playerId: 'p0' } } as any, cancel() { cancelled = true } } as any)
    expect(cancelled).toBe(true)
    const choose = requests.at(-1)
    expect(choose.request.cardIds).toEqual(top.slice(0, 2))
    runtime.resume!(host, 'p0', { step: 'choose', data: { top, legal: top.slice(0, 2) } } as any, { payload: { cardIds: [top[0]] } } as any)
    expect(state.players[0].zones.hand).toContain(top[0])
    expect(state.zones.discardPile).toContain(top[1])
    expect(state.zones.discardPile).toContain(top[2])
    expect(state.players[0].marks.luoyi).toBe(1)
  })

  it('界华佗回合外红色装备可急救；青囊红牌可再发动但本回合不重复目标', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-huatuo-b40'; state.players[0].hp = 2
    state.players[1].hp = 3; state.players[2].hp = 2
    const redEquipment = state.zones.drawPile[0]
    state.cards[redEquipment].name = '赤兔'; state.cards[redEquipment].category = 'equipment'; state.cards[redEquipment].equipmentSlot = 'offensiveHorse'; state.cards[redEquipment].suit = 'heart'; state.cards[redEquipment].color = 'red'
    moveCard(state, redEquipment, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'offensiveHorse' })
    state.currentPlayerId = 'p1'
    expect(getSkillRuntime('jie-jijiu-b40')!.viewAs!(state, 'p0')).toContainEqual(expect.objectContaining({ asCardName: '桃', cardId: redEquipment }))
    state.currentPlayerId = 'p0'; state.phase = 'play'
    const red = state.zones.drawPile[0], black = state.zones.drawPile[1]
    state.cards[red].name = '闪'; state.cards[red].color = 'red'
    state.cards[black].name = '杀'; state.cards[black].color = 'black'
    moveCard(state, red, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    moveCard(state, black, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    const qingnang = getSkillRuntime('jie-qingnang-b40')!
    qingnang.invokeActive!(host, 'p0', 'skill:jie-qingnang-b40')
    qingnang.resume!(host, 'p0', { step: 'cost', data: {} } as any, { payload: { cardIds: [red] } } as any)
    qingnang.resume!(host, 'p0', requests.at(-1), { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].hp).toBe(4)
    expect(requests.at(-1).step).toBe('repeat')
    qingnang.resume!(host, 'p0', requests.at(-1), { payload: { optionId: 'yes' } } as any)
    qingnang.resume!(host, 'p0', requests.at(-1), { payload: { cardIds: [black] } } as any)
    expect(requests.at(-1).request.candidateIds).not.toContain('p1')
    qingnang.resume!(host, 'p0', requests.at(-1), { payload: { targetIds: ['p2'] } } as any)
    expect(state.players[2].hp).toBe(3)
    expect(qingnang.activeActions!(state, 'p0')).toHaveLength(0)
  })

  it('界诸葛亮观星按存活人数取三张并在全置底后开放结束阶段再次观星', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-zhugeliang-b40'
    state.players[3].alive = false; state.players[4].alive = false
    const runtime = getSkillRuntime('jie-guanxing-b40')!
    runtime.resume!(host, 'p0', { step: 'prepare-invoke', data: {} } as any, { payload: { optionId: 'yes' } } as any)
    const arrange = requests.at(-1)
    expect(arrange.request.cardIds).toHaveLength(3)
    runtime.resume!(host, 'p0', arrange, { payload: { top: [], bottom: arrange.data.cardIds } } as any)
    expect(state.players[0].marks.jieGuanxingRepeatB40).toBe(1)
    runtime.triggers![1].handle(host, 'p0', { event: { payload: { playerId: 'p0', phase: 'finish' } } as any } as any)
    expect(requests.at(-1).step).toBe('finish-invoke')
  })

  it('界孙尚香结姻交付手牌后按体力高低分别摸牌与回复，并消耗出牌阶段次数', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-sunshangxiang-b40'; state.players[0].hp = 3
    state.players[1].characterId = 'caocao'; state.players[1].hp = 2
    const payment = state.zones.drawPile[0]
    moveCard(state, payment, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    const jieyin = getSkillRuntime('jie-jieyin-b40')!
    jieyin.invokeActive!(host, 'p0', 'skill:jie-jieyin-b40')
    jieyin.resume!(host, 'p0', requests.at(-1), { payload: { targetIds: ['p1'] } } as any)
    jieyin.resume!(host, 'p0', requests.at(-1), { payload: { optionId: 'discard' } } as any)
    jieyin.resume!(host, 'p0', requests.at(-1), { payload: { cardIds: [payment] } } as any)
    expect(state.zones.discardPile).toContain(payment)
    expect(state.players[0].zones.hand).toHaveLength(1)
    expect(state.players[0].hp).toBe(3)
    expect(state.players[1].hp).toBe(3)
    expect(jieyin.activeActions!(state, 'p0')).toHaveLength(0)
  })

  it('界孙权制衡弃尽全部手牌时额外摸一张，界黄月英集智可弃基本牌加手牌上限', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-sunquan-b40'
    const handCards = state.zones.drawPile.slice(0, 2)
    for (const id of handCards) moveCard(state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    const before = state.players[0].zones.hand.length
    const zhiheng = getSkillRuntime('jie-zhiheng-b40')!
    zhiheng.invokeActive!(host, 'p0', 'skill:jie-zhiheng-b40')
    zhiheng.resume!(host, 'p0', { step: 'discard', data: {} } as any, { payload: { cardIds: handCards } } as any)
    expect(state.players[0].zones.hand).toHaveLength(before + 1)

    state.players[0].characterId = 'jie-huangyueying-b40'; state.players[0].marks.jieJizhiHandLimit = 0
    const jizhi = getSkillRuntime('jie-jizhi-b40')!
    const nextTop = state.zones.drawPile[0]
    state.cards[nextTop].name = '闪'; state.cards[nextTop].category = 'basic'
    jizhi.resume!(host, 'p0', { step: 'draw', data: {} } as any, { payload: { optionId: 'yes' } } as any)
    const basic = state.players[0].zones.hand.at(-1)!
    jizhi.resume!(host, 'p0', requests.at(-1), { payload: { optionId: 'yes' } } as any)
    expect(state.zones.discardPile).toContain(basic)
    expect(maxCardsOf(state, 'p0')).toBe(4)
  })
})
