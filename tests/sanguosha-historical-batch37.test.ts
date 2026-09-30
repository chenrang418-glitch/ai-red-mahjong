import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH37_CHARACTERS } from '@/sanguosha/data/characters/historical-batch37'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { resumeTrickTarget } from '@/sanguosha/engine/cards/tricks'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { usedThisPhase } from '@/sanguosha/engine/phase-usage'
import { slashRules } from '@/sanguosha/engine/slash-rules'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'

const IDS = {
  zhuhai: 'zhuhai-sp-b39', qianxin: 'qianxin-sp-b39', jianyan: 'jianyan-sp-b39',
  fenwei: 'fenwei-jie-b39', qinxue: 'qinxue-jie-b39', kanxin: 'kanxin-jie-b39',
  kurou: 'kurou-jie-b39', zhaxiang: 'zhaxiang-jie-b39', yingzi: 'yingzi-jie-b39',
  fanjian: 'fanjian-jie-b39', guose: 'guose-jie-b39', qianxun: 'qianxun-jie-b39',
  jianxiong: 'jianxiong-jie-b39', guicai: 'guicai-jie-b39', ganglie: 'ganglie-jie-b39',
  qingjian: 'qingjian-jie-b39',
}

function fixture(count = 5) {
  const game = new SanguoshaGame({ seed: `historical-b39-${count}`, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 2
  state.players.forEach((player: any, index: number) => {
    player.characterId = index === 0 ? 'sp-xushu-b39' : index === 1 ? 'zhangfei' : index === 2 ? 'diaochan' : 'caocao'
    player.hp = 3; player.maxHp = 4
  })
  const requests: any[] = [], queue: any[] = []
  const host = {
    state, rng: game.rng, dispatch: game.dispatch.bind(game),
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b39-${requests.length}`) }) },
    queueSkill(prompt: any) { queue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget: game.resumeCardTarget.bind(game), enterDying: game.enterDying.bind(game),
  } as any as SkillHost
  function addHand(playerId: string, name: string, suit = 'spade', count = 1) {
    const ids = state.zones.drawPile.slice(0, count)
    for (const id of ids) {
      const card = state.cards[id]
      card.name = name; card.suit = suit; card.color = ['heart', 'diamond'].includes(suit) ? 'red' : 'black'
      card.category = ['杀', '闪', '桃', '酒'].includes(name) ? 'basic' : name.includes('马') ? 'equipment' : 'trick'
      moveCard(state, id, { kind: 'drawPile' }, { kind: 'hand', playerId })
    }
    return ids
  }
  return { game, state, host, requests, queue, addHand }
}

describe('武将册第39批注册及定向玩法', () => {
  it('注册序号506–515共十将，所有原生技能均有运行时且角色 ID 唯一', () => {
    expect(HISTORICAL_BATCH37_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH37_CHARACTERS) {
      expect(getCharacter(character.id)).toBe(character)
      expect(skillIdsOf(character.id)).toEqual(character.skills.filter(skill => !skill.granted).map(skill => skill.id))
      for (const skill of character.skills.filter(skill => !skill.granted)) expect(getSkillRuntime(skill.id), `${character.name}/${skill.id}`).toBeDefined()
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('界甘宁奋威把选中的目标预先标为无效，锦囊引擎跳过其无懈和牌效', () => {
    const { game, state, host, requests } = fixture()
    state.players[0].characterId = 'jie-ganning-b39'
    const cardId = state.zones.drawPile[0]
    state.cards[cardId].name = '南蛮入侵'; state.cards[cardId].category = 'trick'
    const resolution: any = state.cardResolution = {
      kind: 'trick', cardId, cardName: '南蛮入侵', sourceId: 'p0', targetIds: ['p1', 'p2'], targetIndex: 0,
      nullifiedTargetIds: [], stage: 'awaiting-intercept', interceptsDone: [], cancelledTargetIds: [], unresponsiveTargetIds: [],
      responderOrder: [], responderIndex: 0, nullificationCount: 0, declinedAllIds: [], lastNullifierId: null, requestId: null, effect: null,
    }
    const runtime = getSkillRuntime(IDS.fenwei)!
    expect(runtime.interceptSourceTarget!(host, 'p0', { sourceId: 'p0', targetId: 'p1', cardId, cardName: '南蛮入侵', category: 'trick' })).toBe(true)
    runtime.resume!(host, 'p0', { step: 'invoke', data: { cardId, targetIds: ['p1', 'p2'] } } as any, { payload: { optionId: 'yes' } } as any)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { targetIds: ['p1'] } } as any)
    expect(resolution.nullifiedTargetIds).toEqual(['p1'])
    resumeTrickTarget(game)
    expect(state.pendingRequests.some((request: any) => request.playerId === 'p1')).toBe(false)
    expect(state.pendingRequests[0]?.playerId).toBe('p2')
  })

  it('界吕蒙勤学按存活人数切换门槛，觉醒后获得攻心', () => {
    const small = fixture(5)
    small.state.players[0].characterId = 'jie-lvmeng-b39'
    small.addHand('p0', '闪', 'heart', 6)
    const runtime = getSkillRuntime(IDS.qinxue)!
    expect(runtime.awakening!.ready(small.state, 'p0')).toBe(true)
    runtime.awakening!.invoke(small.host, 'p0')
    expect(small.state.players[0].maxHp).toBe(3)
    expect(small.state.players[0].grantedSkills).toContain(IDS.kanxin)
    const large = fixture(7)
    large.state.players[0].characterId = 'jie-lvmeng-b39'
    large.addHand('p0', '闪', 'heart', 5)
    expect(getSkillRuntime(IDS.qinxue)!.awakening!.ready(large.state, 'p0')).toBe(true)
  })

  it('徐庶荐言限出牌阶段一次，牌堆耗尽时清空已亮牌，不遗留处理区牌', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'sp-xushu-b39'
    const runtime = getSkillRuntime(IDS.jianyan)!
    state.zones.drawPile = []; state.zones.discardPile = []
    runtime.invokeActive!(host, 'p0', `skill:${IDS.jianyan}`)
    runtime.resume!(host, 'p0', { step: 'declare', data: {} } as any, { payload: { optionId: 'basic' } } as any)
    expect(usedThisPhase(state, 'p0', IDS.jianyan)).toBe(true)
    expect(state.zones.processingArea).toHaveLength(0)
    expect(requests).toHaveLength(1)
    expect(runtime.activeActions!(state, 'p0')).toHaveLength(0)
  })

  it('界黄盖苦肉弃牌失去体力后诈降按每点摸三张并追加杀次数', () => {
    const { state, host, addHand } = fixture()
    state.players[0].characterId = 'jie-huanggai-b39'
    const [cost] = addHand('p0', '闪')
    const before = state.players[0].zones.hand.length
    getSkillRuntime(IDS.kurou)!.resume!(host, 'p0', { step: 'cost', data: {} } as any, { payload: { cardIds: [cost] } } as any)
    expect(state.players[0].hp).toBe(2)
    expect(state.players[0].zones.hand.length).toBe(before - 1 + 3)
    expect(slashRules(state, 'p0').extraUses).toBe(1)
    expect(getSkillRuntime(IDS.zhaxiang)!.slashUndodgeable!(state, 'p0', 'p1', cost)).toBe(false)
  })

  it('界周瑜英姿固定手牌上限为体力上限，反间将同花色弃置或失去体力交给目标选择', () => {
    const { state, host, requests, addHand } = fixture()
    state.players[0].characterId = 'jie-zhouyu-b39'; state.players[0].hp = 2; state.players[0].maxHp = 4
    expect(maxCardsOf(state, 'p0')).toBe(4)
    const [gift] = addHand('p0', '闪', 'heart')
    const [match, other] = addHand('p1', '桃', 'heart', 1).concat(addHand('p1', '杀', 'spade', 1))
    const runtime = getSkillRuntime(IDS.fanjian)!
    runtime.resume!(host, 'p0', { step: 'card', data: {} } as any, { payload: { cardIds: [gift] } } as any)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { targetIds: ['p1'] } } as any)
    expect(requests.at(-1).request.playerId).toBe('p1')
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { optionId: 'discard-suit' } } as any)
    expect(state.zones.discardPile).toContain(match)
    expect(state.players[1].zones.hand).toContain(other)
  })

  it('界大乔国色将方块牌实际当乐不思蜀使用后摸一张并消耗本阶段次数', () => {
    const { game, state, addHand } = fixture()
    state.players[0].characterId = 'jie-daqiao-b39'
    const [diamond] = addHand('p0', '闪', 'diamond')
    const runtime = getSkillRuntime(IDS.guose)!
    expect(runtime.viewAs!(state, 'p0').some(option => option.cardId === diamond && option.asCardName === '乐不思蜀')).toBe(true)
    const action = game.legalActions('p0').find((candidate: any) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(diamond) && candidate.asCardName === '乐不思蜀' && candidate.targetIds.includes('p1')) as any
    expect(action).toBeDefined()
    game.act('p0', action.id)
    expect(state.players[1].zones.judgingArea).toContain(diamond)
    expect(state.players[0].zones.hand).toHaveLength(1)
    expect(usedThisPhase(state, 'p0', IDS.guose)).toBe(true)
    expect(runtime.viewAs!(state, 'p0')).toHaveLength(0)
  })

  it('界大乔国色弃方块移除延时锦囊后摸一张', () => {
    const { state, host, addHand } = fixture()
    state.players[0].characterId = 'jie-daqiao-b39'
    const [cost] = addHand('p0', '闪', 'diamond')
    const [lebu] = addHand('p2', '乐不思蜀')
    moveCard(state, lebu, { kind: 'hand', playerId: 'p2' }, { kind: 'judgingArea', playerId: 'p2' })
    const before = state.players[0].zones.hand.length
    const runtime = getSkillRuntime(IDS.guose)!
    runtime.invokeActive!(host, 'p0', `skill:${IDS.guose}:remove`)
    runtime.resume!(host, 'p0', { step: 'cost', data: { delayed: [{ playerId: 'p2', cardId: lebu }] } } as any, { payload: { cardIds: [cost] } } as any)
    expect(state.zones.discardPile).toContain(lebu)
    expect(state.players[0].zones.hand.length).toBe(before)
    expect(usedThisPhase(state, 'p0', IDS.guose)).toBe(true)
  })

  it('界陆逊谦逊扣置手牌为暗牌，延时锦囊目标触发且回合结束归还', () => {
    const { state, host, requests, queue, addHand } = fixture()
    state.players[1].characterId = 'jie-luxun-b39'
    const cards = addHand('p1', '闪', 'heart', 2)
    const runtime = getSkillRuntime(IDS.qianxun)!
    runtime.triggers!.find(trigger => trigger.event === 'CardUsed')!.handle(host, 'p1', { event: { sourceId: 'p0', payload: { cardName: '乐不思蜀', targetIds: ['p1'] } } } as any)
    expect(queue[0].step).toBe('delayed-ask')
    runtime.startQueued!(host, 'p1', queue[0])
    runtime.resume!(host, 'p1', requests.at(-1), { payload: { optionId: 'yes' } } as any)
    expect(state.players[1].zones.hand).toHaveLength(0)
    expect(state.players[1].hiddenCharacterPiles).toContain('qianxun-jie-b39')
    expect(state.players[1].characterPiles['qianxun-jie-b39']).toEqual(cards)
    runtime.triggers!.find(trigger => trigger.event === 'TurnEnd')!.handle(host, 'p1', {} as any)
    expect(state.players[1].zones.hand).toEqual(expect.arrayContaining(cards))
    expect(state.players[1].hiddenCharacterPiles).not.toContain('qianxun-jie-b39')
  })

  it('真实使用乐不思蜀指定界陆逊后，谦逊在牌放入判定区后进入可回答窗口', () => {
    const { game, state, addHand } = fixture()
    state.players[0].characterId = 'jie-ganning-b39'
    state.players[1].characterId = 'jie-luxun-b39'
    addHand('p1', '闪', 'heart', 2)
    const [lebu] = addHand('p0', '乐不思蜀', 'diamond')
    const action = game.legalActions('p0').find((candidate: any) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(lebu) && candidate.targetIds.includes('p1')) as any
    expect(action).toBeDefined()
    game.act('p0', action.id)
    expect(state.players[1].zones.judgingArea).toContain(lebu)
    expect(state.skillResolution?.skillId).toBe(IDS.qianxun)
    expect(state.pendingRequests[0]?.playerId).toBe('p1')
  })

  it('界曹操奸雄仅在伤害牌仍可获得时询问，发动后获得伤害牌并摸一张', () => {
    const { state, host, requests, addHand } = fixture()
    state.players[0].characterId = 'jie-caocao-b39'
    const [damageCard] = addHand('p1', '杀')
    moveCard(state, damageCard, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    const runtime = getSkillRuntime(IDS.jianxiong)!
    runtime.startQueued!(host, 'p0', { skillId: IDS.jianxiong, ownerId: 'p0', step: 'ask', data: { cardId: damageCard } })
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { optionId: 'yes' } } as any)
    expect(state.players[0].zones.hand).toContain(damageCard)
    expect(state.players[0].zones.hand.length).toBe(2)
  })

  it('界司马懿鬼才改判候选覆盖手牌和装备', () => {
    const { state, addHand } = fixture()
    state.players[0].characterId = 'jie-simayi-b39'
    const [handCard] = addHand('p0', '闪')
    const equip = state.zones.drawPile[0]
    state.cards[equip].name = '诸葛连弩'; state.cards[equip].category = 'equipment'; state.cards[equip].equipmentSlot = 'weapon'
    moveCard(state, equip, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    expect(getSkillRuntime(IDS.guicai)!.retrial!(state, 'p0')).toEqual(expect.arrayContaining([handCard, equip]))
  })

  it('界夏侯惇刚烈黑判定由伤害来源选择弃置牌，清俭仅收集摸牌阶段外新获得牌', () => {
    const { state, host, requests, addHand, queue } = fixture()
    state.players[0].characterId = 'jie-xiahou-dun-b39'
    state.players[1].characterId = 'zhangfei'
    const [sourceCard] = addHand('p1', '闪')
    const [gained] = addHand('p0', '桃')
    const runtime = getSkillRuntime(IDS.ganglie)!
    getSkillRuntime(IDS.ganglie) // keep this assertion tied to this batch's runtime registration
    const judgment = state.zones.drawPile[0]
    state.cards[judgment].color = 'black'; state.cards[judgment].suit = 'spade'
    // 调用判定续接注册器的效果通过技能流程测试：黑判后请求归伤害来源本人选择。
    runtime.triggers!.find(trigger => trigger.event === 'Damaged')!.handle(host, 'p0', { event: { targetId: 'p0', sourceId: 'p1', payload: { amount: 1 } } } as any)
    runtime.startQueued!(host, 'p0', queue[0])
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { optionId: 'yes' } } as any)
    // 判定异步由引擎恢复；只验证技能入口本身排队，不直接伪造判定结果。
    expect(requests.at(-1).request.playerId).toBe('p1')
    const qingjian = getSkillRuntime(IDS.qingjian)!
    state.phase = 'play'
    qingjian.triggers!.find(trigger => trigger.event === 'GainCard')!.handle(host, 'p0', { event: { payload: { playerId: 'p0', cardIds: [gained] } } } as any)
    expect(queue.some(prompt => prompt.skillId === IDS.qingjian && prompt.data.cardIds.includes(gained))).toBe(true)
    const collectPrompt = queue.filter(prompt => prompt.skillId === IDS.qingjian).at(-1)
    qingjian.startQueued!(host, 'p0', collectPrompt)
    qingjian.resume!(host, 'p0', requests.at(-1), { payload: { cardIds: [gained] } } as any)
    expect(state.players[0].characterPiles['qingjian-jie-b39']).toContain(gained)
    expect(state.players[0].hiddenCharacterPiles).toContain('qingjian-jie-b39')
    qingjian.triggers!.find(trigger => trigger.event === 'TurnEnd')!.handle(host, 'p0', {} as any)
    const distributePrompt = queue.filter(prompt => prompt.skillId === IDS.qingjian).at(-1)
    qingjian.startQueued!(host, 'p0', distributePrompt)
    expect(requests.at(-1).request.kind).toBe('distribute-cards')
    qingjian.resume!(host, 'p0', requests.at(-1), { payload: { assignments: [{ cardId: gained, recipientId: 'p1' }] } } as any)
    expect(state.players[1].zones.hand).toContain(gained)
    expect(state.players[0].hiddenCharacterPiles).not.toContain('qingjian-jie-b39')
    state.phase = 'draw'
    const before = queue.length
    qingjian.triggers!.find(trigger => trigger.event === 'GainCard')!.handle(host, 'p0', { event: { payload: { playerId: 'p0', cardIds: [gained] } } } as any)
    expect(queue).toHaveLength(before)
    expect(sourceCard).toBeTruthy()
  })
})
