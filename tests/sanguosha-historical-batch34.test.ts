import { describe, expect, it, vi } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { HISTORICAL_BATCH34_CHARACTERS } from '@/sanguosha/data/characters/historical-batch34'
import '@/sanguosha/engine/game'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'

function fixture(characterId = 'sunhanhua-b36') {
  const game = new SanguoshaGame({
    seed: 'batch36-targeted',
    setup: { mode: 'identity', generalChoices: 1, players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })) },
  })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 1
  state.players.forEach((p: any, index: number) => { p.characterId = index === 0 ? characterId : 'zhangfei'; p.hp = 3; p.maxHp = 4 })
  const requests: any[] = []
  const host = {
    state, rng: game.rng, dispatch: game.dispatch.bind(game),
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b36-${requests.length}`) }) },
    queueSkill(prompt: any) { requests.push({ queued: prompt }) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget: game.resumeCardTarget.bind(game), enterDying: game.enterDying.bind(game),
  } as any as SkillHost
  return { game, state, host, requests }
}

describe('武将册第36批注册与技能挂载', () => {
  it('登记十名角色且每项非授予技能都有运行时', () => {
    expect(HISTORICAL_BATCH34_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH34_CHARACTERS) {
      expect(getCharacter(character.id)).toBe(character)
      expect(skillIdsOf(character.id)).toEqual(character.skills.filter(skill => !skill.granted).map(skill => skill.id))
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}:${skill.id}`).toBeDefined()
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('孙寒华三技能均提供对应实际交互/触发入口', () => {
    for (const id of ['chongxu-b36', 'miaojian-b36', 'lianhua-b36']) {
      const runtime = getSkillRuntime(id)
      expect(runtime).toBeDefined()
    }
    expect(getSkillRuntime('miaojian-b36')?.activeActions).toBeTypeOf('function')
    expect(getSkillRuntime('lianhua-b36')?.interceptTarget).toBeTypeOf('function')
    expect(getSkillRuntime('chongxu-b36')?.resume).toBeTypeOf('function')
  })

  it('核心被动/觉醒技能没有只登记描述', () => {
    for (const id of ['fenyin-b36', 'mingcha-b36', 'jingzhong-b36', 'zhenfeng-jie-b36', 'yijue-jie-b36',
      'jieyuan-b36', 'fenxin-b36', 'yongsi-jie-b36', 'jixi-b36', 'wangzun-b36', 'liangzhu-sp-b36',
      'fanxiang-sp-b36', 'xiaoji-sp-b36', 'mashu-sp-pande-b36', 'juesi-sp-pande-b36', 'danqi-sp-guanyu-b36', 'nuzhan-sp-guanyu-b36']) {
      expect(getSkillRuntime(id), id).toBeDefined()
    }
  })

  it('留赞【奋音】只在同一回合的连续有色牌变色时摸牌', () => {
    const { state, host } = fixture('liuzan-b36')
    const runtime = getSkillRuntime('fenyin-b36')!
    const cards = state.zones.drawPile.splice(0, 3)
    state.players[0].zones.hand.push(...cards)
    state.cards[cards[0]].color = 'red'; state.cards[cards[1]].color = 'red'; state.cards[cards[2]].color = 'black'
    const before = state.players[0].zones.hand.length
    const trigger = runtime.triggers!.find(entry => entry.event === 'CardUsed')!
    for (const cardId of cards) trigger.handle(host, 'p0', { event: { sourceId: 'p0', payload: { cardId } } } as any)
    expect(state.players[0].zones.hand).toHaveLength(before + 1)
  })

  it('阮慧【明察】按新版从牌堆顶翻三张并获得点数不大于8的牌', () => {
    const { state, host, requests } = fixture('ruanhui-b36')
    const top = state.zones.drawPile.slice(0, 3)
    state.cards[top[0]].rank = 4; state.cards[top[1]].rank = 10; state.cards[top[2]].rank = 8
    const runtime = getSkillRuntime('mingcha-b36')!
    const context = { event: { payload: { playerId: 'p0' } }, cancel() { this.cancelled = true } } as any
    runtime.triggers!.find(entry => entry.event === 'DrawPhase')!.handle(host, 'p0', context)
    expect(requests.at(-1).request).toMatchObject({ kind: 'choose-cards', cardIds: [top[0], top[2]], min: 0, max: 2 })
    expect(state.zones.processingArea).toEqual(expect.arrayContaining(top))
    const stolenCard = state.zones.drawPile.pop()
    state.players[1].zones.hand.push(stolenCard)
    const takeRequest = requests.at(-1)
    runtime.resume?.(host, 'p0', takeRequest as any, { payload: { cardIds: [top[0], top[2]] } } as any)
    expect(state.players[0].zones.hand).toEqual(expect.arrayContaining([top[0], top[2]]))
    expect(state.zones.drawPile.slice(0, 1)).toEqual([top[1]])
    expect(requests.at(-1).request).toMatchObject({ kind: 'choose-targets', candidateIds: ['p1'] })
  })

  it('阮慧【明察】的随机夺牌涵盖装备区并触发失去装备流程', () => {
    const { state, host, requests } = fixture('ruanhui-b36')
    const equipmentId = state.zones.drawPile.shift()
    state.cards[equipmentId].category = 'equipment'; state.cards[equipmentId].name = '诸葛连弩'
    state.players[1].zones.equipment.weapon = equipmentId
    vi.spyOn(host.rng, 'nextInt').mockReturnValue(0)
    const runtime = getSkillRuntime('mingcha-b36')!
    runtime.resume?.(host, 'p0', { step: 'rob', data: {} } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[0].zones.hand).toContain(equipmentId)
    expect(state.players[1].zones.equipment.weapon).toBeNull()
    expect(state.zones.discardPile).not.toContain(equipmentId)
  })

  it('阮慧【敬重】在目标下回合出牌后逐张追还仍在弃牌堆的牌', () => {
    const { state, host, requests } = fixture('ruanhui-b36')
    const runtime = getSkillRuntime('jingzhong-b36')!
    const cardId = state.zones.drawPile.shift()
    state.zones.discardPile.push(cardId)
    runtime.resume?.(host, 'p0', { step: 'target', data: {} } as any, { payload: { targetIds: ['p1'] } } as any)
    state.currentPlayerId = 'p1'; state.phase = 'play'; state.turnNumber = 2
    runtime.triggers!.find(entry => entry.event === 'AfterCardUse')!.handle(host, 'p0', { event: { payload: { cardId, cardName: '桃' } } } as any)
    const queued = requests.at(-1).queued
    runtime.startQueued?.(host, 'p0', queued)
    runtime.resume?.(host, 'p0', requests.at(-1) as any, { payload: { optionId: 'yes' } } as any)
    expect(state.players[0].zones.hand).toContain(cardId)
    expect(state.zones.discardPile).not.toContain(cardId)
  })

  it('界袁术【庸肆】弃牌阶段可弃置装备，装备离区流程照常触发', () => {
    const { state, host, requests } = fixture('yuanshu-jie-b36')
    const equipmentId = state.zones.drawPile.shift()
    state.cards[equipmentId].category = 'equipment'; state.cards[equipmentId].name = '诸葛连弩'
    state.players[0].zones.equipment.weapon = equipmentId
    const runtime = getSkillRuntime('yongsi-jie-b36')!
    runtime.triggers!.find(entry => entry.event === 'DiscardPhase')!.handle(host, 'p0', { event: { payload: { playerId: 'p0' } } } as any)
    runtime.resume?.(host, 'p0', requests.at(-1) as any, { payload: { optionId: 'discard' } } as any)
    expect(requests.at(-1).request.cardIds).toContain(equipmentId)
    runtime.resume?.(host, 'p0', requests.at(-1) as any, { payload: { cardIds: [equipmentId] } } as any)
    expect(state.players[0].zones.equipment.weapon).toBeNull()
    expect(state.zones.discardPile).toContain(equipmentId)
  })

  it('SP庞德【决死】只能选择有可弃牌的攻击范围内角色', () => {
    const { state, host, requests } = fixture('pande-sp-b36')
    for (const p of state.players) { p.zones.hand = []; p.zones.judgingArea = []; p.zones.equipment = { weapon: null, armor: null, mountPlus: null, mountMinus: null, treasure: null } }
    const slashId = state.zones.drawPile.shift()
    state.cards[slashId].name = '杀'; state.cards[slashId].category = 'basic'; state.players[0].zones.hand.push(slashId)
    const cardId = state.zones.drawPile.shift(); state.players[2].zones.hand.push(cardId)
    const runtime = getSkillRuntime('juesi-sp-pande-b36')!
    runtime.resume?.(host, 'p0', { step: 'cost', data: {} } as any, { payload: { cardIds: [slashId] } } as any)
    expect(requests.at(-1).request).toMatchObject({ kind: 'choose-targets', candidateIds: ['p2'] })
  })

  it('SP庞德【决死】弃牌后确实开始公共【决斗】结算', () => {
    const { state, host } = fixture('pande-sp-b36')
    const targetCard = state.zones.drawPile.shift()
    state.cards[targetCard].name = '闪'; state.cards[targetCard].category = 'basic'
    state.players[1].zones.hand.push(targetCard)
    const runtime = getSkillRuntime('juesi-sp-pande-b36')!
    runtime.resume?.(host, 'p0', { step: 'victim-discard', data: { targetId: 'p1' } } as any, { payload: { cardIds: [targetCard] } } as any)
    expect(state.cardResolution).toMatchObject({ kind: 'trick', cardName: '决斗', sourceId: 'p0' })
  })

  it('孙寒华【冲虚】逐步接受方向输入，服务端以当前落点计算莲花得分', () => {
    const { host, requests } = fixture()
    vi.spyOn(host.rng, 'nextInt').mockReturnValue(1)
    const runtime = getSkillRuntime('chongxu-b36')!
    runtime.invokeActive?.(host, 'p0', 'skill:chongxu-b36')
    expect(requests.at(-1).request.interaction).toMatchObject({ kind: 'spirit-gathering', lane: 1, fallingLane: 1, falling: 'lotus-red' })
    runtime.resume?.(host, 'p0', { step: 'collect', data: requests.at(-1).data } as any, { payload: { optionId: 'stay' } } as any)
    expect(requests.at(-1).request.interaction).toMatchObject({ kind: 'spirit-gathering', index: 1, score: 1 })
  })

  it('孙寒华【冲虚】低于2分判定失败，不把分数带到下一次飞升', () => {
    const { state, host, requests } = fixture()
    vi.spyOn(host.rng, 'nextInt').mockImplementation((max: number) => max === 3 ? 2 : 1)
    const runtime = getSkillRuntime('chongxu-b36')!
    runtime.invokeActive?.(host, 'p0', 'skill:chongxu-b36')
    for (let index = 0; index < 15; index += 1) {
      const request = requests.at(-1)
      runtime.resume?.(host, 'p0', request as any, { payload: { optionId: 'stay' } } as any)
    }
    expect(requests.at(-1).request.interaction.index).toBe(14)
    expect(requests.at(-1).request.interaction.score).toBe(0)
    expect(state.players[0].marks['miaojian-b36'] ?? 1).toBe(1)
    expect(state.b36?.['chongxu-b36:points:p0']).toBeUndefined()
  })

  it('孙寒华【冲虚】本次获得5分可连续升级或摸牌，分数只在本次消费', () => {
    const { state, host, requests } = fixture()
    vi.spyOn(host.rng, 'nextInt').mockReturnValue(1)
    const runtime = getSkillRuntime('chongxu-b36')!
    runtime.invokeActive?.(host, 'p0', 'skill:chongxu-b36')
    for (let index = 0; index < 15 && requests.at(-1).request.interaction?.kind === 'spirit-gathering'; index += 1) {
      const request = requests.at(-1)
      runtime.resume?.(host, 'p0', request as any, { payload: { optionId: 'stay' } } as any)
    }
    let request = requests.at(-1)
    expect(request.request.options.map((option: any) => option.id)).toEqual(['miaojian', 'lianhua', 'draw', 'done'])
    runtime.resume?.(host, 'p0', request as any, { payload: { optionId: 'miaojian' } } as any)
    request = requests.at(-1)
    expect(request.data.remainingPoints).toBe(2)
    expect(request.request.options.map((option: any) => option.id)).toEqual(['draw', 'done'])
    const before = state.players[0].zones.hand.length
    runtime.resume?.(host, 'p0', request as any, { payload: { optionId: 'draw' } } as any)
    expect(state.players[0].zones.hand).toHaveLength(before + 1)
    expect(state.b36?.['chongxu-b36:points:p0']).toBeUndefined()
  })

  it('孙寒华【妙剑】的实体【刺杀】按出杀次数结算，并要求目标响应前额外弃牌', () => {
    const { game, state, host, requests } = fixture()
    const cardId = state.zones.drawPile.shift()
    state.cards[cardId].name = '杀'; state.cards[cardId].category = 'basic'
    state.players[0].zones.hand.push(cardId)
    const runtime = getSkillRuntime('miaojian-b36')!
    runtime.resume?.(host, 'p0', { step: 'choose', data: { level: 1 } } as any, { payload: { optionId: 'assassinate' } } as any)
    expect(requests.at(-1).request).toMatchObject({ kind: 'choose-cards', cardIds: [cardId] })
    runtime.resume?.(host, 'p0', requests.at(-1) as any, { payload: { cardIds: [cardId] } } as any)
    const targetRequest = requests.at(-1)
    runtime.resume?.(host, 'p0', targetRequest as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.cardResolution).toMatchObject({ kind: 'slash', sourceId: 'p0', targetId: 'p1', responseDiscardCostTargetIds: ['p1'] })
    expect(state.turnUsage.slashUses).toBe(1)
  })

  it('孙寒华二级【莲华】使用公共判定流程，黑桃判定取消当前杀目标', () => {
    const { game, state } = fixture()
    state.players[0].marks['lianhua-b36'] = 2
    const topCardId = state.zones.drawPile[1]
    state.cards[topCardId].suit = 'spade'; state.cards[topCardId].color = 'black'
    const beforeHp = state.players[0].hp
    game.beginVirtualSlash({ sourceId: 'p1', targetId: 'p0', sourceSkillId: 'batch36-test' })
    expect(state.players[0].hp).toBe(beforeHp)
    expect(state.cardResolution).toBeNull()
    expect(state.zones.discardPile).toContain(topCardId)
  })

  it('灵雎【焚心】只在杀死角色后询问，确认后交换身份及主公体力上限加成', () => {
    const { state, host, requests } = fixture('lingju-b36')
    state.players[0].identity = 'loyalist'; state.players[1].identity = 'rebel'
    state.players[1].alive = false
    const runtime = getSkillRuntime('fenxin-b36')!
    runtime.triggers!.find(entry => entry.event === 'Death')!.handle(host, 'p0', { event: { sourceId: 'p0', payload: { playerId: 'p1' } } } as any)
    const queued = requests[0].queued
    runtime.startQueued?.(host, 'p0', queued)
    runtime.resume?.(host, 'p0', requests.at(-1) as any, { payload: { optionId: 'yes' } } as any)
    expect(state.players[0].identity).toBe('rebel')
    expect(state.players[1].identity).toBe('loyalist')
  })

  it('界袁术【妄尊】的跨角色手牌上限修正只结算一次', () => {
    const { state } = fixture('yuanshu-jie-b36')
    state.players[1].grantedSkills.push('wangzun-b36')
    state.b36 = { 'wangzun-b36:target:p1': { targetId: 'p0', turnNumber: 1 } }
    expect(maxCardsOf(state, 'p0')).toBe(state.players[0].hp - 1)
  })

  it('界袁术【觊玺】只按连续三个自身无失去体力的回合觉醒', () => {
    const { state, host, requests } = fixture('yuanshu-jie-b36')
    const runtime = getSkillRuntime('jixi-b36')!
    const turnEnd = runtime.triggers!.find(entry => entry.event === 'TurnEnd')!
    for (const turnNumber of [1, 2]) {
      state.turnNumber = turnNumber
      turnEnd.handle(host, 'p0', { event: { payload: { playerId: 'p0' } } } as any)
    }
    state.turnNumber = 3
    runtime.triggers!.find(entry => entry.event === 'LoseHp')!.handle(host, 'p0', { event: { payload: { playerId: 'p0', amount: 1 } } } as any)
    turnEnd.handle(host, 'p0', { event: { payload: { playerId: 'p0' } } } as any)
    expect(state.players[0].awakenedSkills).not.toContain('jixi-b36')
    for (const turnNumber of [4, 5, 6]) {
      state.turnNumber = turnNumber
      turnEnd.handle(host, 'p0', { event: { payload: { playerId: 'p0' } } } as any)
    }
    expect(state.players[0].awakenedSkills).toContain('jixi-b36')
    expect(state.players[0].maxHp).toBe(5)
    expect(requests.at(-1).request.options.map((option: any) => option.id)).toEqual(['wangzun'])
  })

  it('SP孙尚香【良助】可令回复者摸两张，并据此满足【返乡】觉醒条件', () => {
    const { state, host, requests } = fixture('sunshangxiang-sp-b36')
    state.currentPlayerId = 'p1'; state.phase = 'play'; state.players[1].hp = 2
    const runtime = getSkillRuntime('liangzhu-sp-b36')!
    runtime.triggers!.find(entry => entry.event === 'Recover')!.handle(host, 'p0', { event: { payload: { playerId: 'p1', amount: 1 } } } as any)
    runtime.startQueued?.(host, 'p0', requests.at(-1).queued)
    const before = state.players[1].zones.hand.length
    runtime.resume?.(host, 'p0', requests.at(-1) as any, { payload: { optionId: 'healed' } } as any)
    expect(state.players[1].zones.hand).toHaveLength(before + 2)
    expect(getSkillRuntime('fanxiang-sp-b36')?.awakening?.ready(state, 'p0')).toBe(true)
  })

  it('SP关羽【单骑】觉醒后授予马术与怒斩，怒斩的锦囊牌杀不限次数', () => {
    const { state, host } = fixture('guanyu-sp-b36')
    const hand = state.zones.drawPile.splice(0, 4)
    state.players[0].zones.hand.push(...hand)
    const runtime = getSkillRuntime('danqi-sp-guanyu-b36')!
    expect(runtime.awakening?.ready(state, 'p0')).toBe(true)
    runtime.awakening?.invoke(host, 'p0')
    expect(state.players[0].maxHp).toBe(3)
    expect(state.players[0].grantedSkills).toEqual(expect.arrayContaining(['mashu-sp-pande-b36', 'nuzhan-sp-guanyu-b36']))
    state.cards[hand[0]].category = 'trick'
    expect(getSkillRuntime('nuzhan-sp-guanyu-b36')?.unlimitedSlashFor?.(state, 'p0', hand[0])).toBe(true)
  })

  it('灵雎【竭缘】通过真实伤害流程弃牌并分别加伤或减伤', () => {
    const { game, state } = fixture('lingju-b36')
    const blackId = state.zones.drawPile.shift(), redId = state.zones.drawPile.shift()
    state.cards[blackId].color = 'black'; state.cards[redId].color = 'red'
    state.players[0].zones.hand.push(blackId, redId)
    const targetHp = state.players[1].hp
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 1 })
    let request = state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } } as any)
    request = state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [blackId] } } as any)
    expect(state.players[1].hp).toBe(targetHp - 2)
    const ownerHp = state.players[0].hp
    state.players[1].hp = ownerHp
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1 })
    request = state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } } as any)
    request = state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [redId] } } as any)
    expect(state.players[0].hp).toBe(ownerHp)
  })

  it('界关羽【义绝】黑牌展示同时阻断目标本回合的手牌使用与响应', () => {
    const { game, state, host, requests } = fixture('guanyu-jie-b36')
    const costId = state.zones.drawPile.shift(), revealId = state.zones.drawPile.shift()
    state.cards[costId].color = 'red'; state.players[0].zones.hand.push(costId)
    state.cards[revealId].name = '闪'; state.cards[revealId].category = 'basic'; state.cards[revealId].suit = 'spade'; state.cards[revealId].color = 'black'
    state.players[1].zones.hand.push(revealId)
    const runtime = getSkillRuntime('yijue-jie-b36')!
    runtime.invokeActive?.(host, 'p0', 'skill:yijue-jie-b36')
    runtime.resume?.(host, 'p0', requests.at(-1) as any, { payload: { cardIds: [costId] } } as any)
    runtime.resume?.(host, 'p0', requests.at(-1) as any, { payload: { targetIds: ['p1'] } } as any)
    runtime.resume?.(host, 'p0', requests.at(-1) as any, { payload: { cardIds: [revealId] } } as any)
    expect(state.handUseBlockedUntilTurnEnd?.p1).toBe(state.turnNumber)
    expect(state.handResponseBlockedUntilTurnEnd?.p1).toBe(state.turnNumber)
    state.cards[costId].suit = 'heart'
    expect(runtime.outgoingDamage?.(state, 'p0', { cardName: '杀', cardId: costId, targetId: 'p1', amount: 1 } as any)).toEqual({ amount: 2 })
    game.beginVirtualSlash({ sourceId: 'p0', targetId: 'p1', sourceSkillId: 'batch36-yijue-lock-test' })
    const response = state.pendingRequests.at(-1)
    expect(response).toMatchObject({ kind: 'respond-card', playerId: 'p1' })
    expect((response as any).actionIds.some((actionId: string) => actionId.startsWith('respond-dodge:'))).toBe(false)
  })
})
