import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH42_CHARACTERS } from '@/sanguosha/data/characters/historical-batch42'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { performJudgment, registerJudgmentContinuation } from '@/sanguosha/engine/judgment'

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-b44-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 1
  state.players.forEach((entry: any, index: number) => {
    entry.characterId = index === 0 ? 'jia-kui-b44' : 'caocao'
    entry.kingdom = index === 1 ? 'qun' : 'wei'
    entry.hp = 3; entry.maxHp = 4
  })
  const requests: any[] = [], queue: any[] = []
  const host = {
    state, rng: game.rng,
    dispatch: game.dispatch.bind(game),
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b44-${requests.length}`) }) },
    queueSkill(prompt: any) { queue.push(prompt) },
    enterDying: game.enterDying.bind(game),
    resumePhaseEntry() {},
  } as any
  return { game, state, host, requests, queue }
}

describe('武将册第44批注册与定向规则', () => {
  it('登记十名角色且每个非赠予技能均存在运行时', () => {
    expect(HISTORICAL_BATCH42_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH42_CHARACTERS) {
      expect(ALL_CHARACTERS).toContain(character)
      expect(skillIdsOf(character.id)).toEqual(character.skills.filter(skill => !skill.granted).map(skill => skill.id))
      for (const skill of character.skills.filter(skill => !skill.granted)) expect(getSkillRuntime(skill.id), `${character.name}/${skill.name}`).toBeDefined()
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('贾逵【通渠】开局标记、摸牌阶段加摸并在进入濒死时移除渠标记', () => {
    const { state, host, requests } = fixture()
    const runtime = getSkillRuntime('tongqu-b44')!
    runtime.onGameStart?.(host, 'p0')
    expect(state.players[0].marks['tongqu-b44:canal']).toBe(1)
    state.players[1].marks['tongqu-b44:canal'] = 1
    state.players[1].zones.hand.push(state.zones.drawPile.pop())
    const draw = { event: { payload: { playerId: 'p1', count: 2 } } } as any
    runtime.triggers?.find(trigger => trigger.event === 'DrawPhase')?.handle(host, 'p0', draw)
    expect(draw.event.payload.count).toBe(3)
    const phaseEnd = { event: { payload: { playerId: 'p1', phase: 'draw' } } } as any
    runtime.triggers?.find(trigger => trigger.event === 'PhaseEnd')?.handle(host, 'p0', phaseEnd)
    expect(requests.at(-1)?.request.playerId).toBe('p1')
    runtime.triggers?.find(trigger => trigger.event === 'EnterDying')?.handle(host, 'p0', { event: { payload: { playerId: 'p1' } } } as any)
    expect(state.players[1].marks['tongqu-b44:canal']).toBeUndefined()
  })

  it('贾逵【挽澜】只在伤害將使目标进入濒死且确有装备可弃时排入防止窗口', () => {
    const { state, host, queue } = fixture()
    state.players[0].zones.equipment.armor = state.zones.drawPile.pop()
    state.players[1].hp = 1
    const runtime = getSkillRuntime('wanlan-b44')!
    expect(runtime.offersGlobalDamagePreventionAsk?.(host, 'p0', {
      sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal', cardId: null, cardName: '杀', chainTransfer: false,
    } as any)).toBe(true)
    expect(queue).toHaveLength(1)
    queue.length = 0
    state.players[1].hp = 2
    expect(runtime.offersGlobalDamagePreventionAsk?.(host, 'p0', {
      sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal', cardId: null, cardName: '杀', chainTransfer: false,
    } as any)).toBe(false)
    expect(queue).toHaveLength(0)
  })

  it('贾逵【挽澜】实际弃置全部装备并防止将使目标濒死的伤害', () => {
    const { game, state } = fixture()
    state.players[0].characterId = 'jia-kui-b44'
    state.players[1].hp = 1
    const armor = state.zones.drawPile.find((id: string) => state.cards[id].equipmentSlot === 'armor')
    state.zones.drawPile = state.zones.drawPile.filter((id: string) => id !== armor)
    state.players[0].zones.equipment.armor = armor
    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal', cardName: '杀' })
    state.phase = 'prepare'
    game.advancePhase()
    const request = state.pendingRequests[0]
    expect(request.prompt).toContain('挽澜')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } } as any)
    expect(state.players[1].hp).toBe(1)
    expect(state.players[0].zones.equipment.armor).toBeNull()
    expect(state.zones.discardPile).toContain(armor)
    expect(state.pendingRequests).toHaveLength(0)
  })

  it('贾逵【挽澜】也允许以自己的装备防止自身将进入濒死的伤害', () => {
    const { game, state } = fixture()
    state.players[0].characterId = 'jia-kui-b44'
    state.players[0].hp = 1
    const armor = state.zones.drawPile.find((id: string) => state.cards[id].equipmentSlot === 'armor')
    state.zones.drawPile = state.zones.drawPile.filter((id: string) => id !== armor)
    state.players[0].zones.equipment.armor = armor
    game.damage({ sourceId: 'p2', targetId: 'p0', amount: 1, nature: 'normal', cardName: '杀' })
    state.phase = 'prepare'
    game.advancePhase()
    const request = state.pendingRequests[0]
    expect(request.prompt).toContain('挽澜')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } } as any)
    expect(state.players[0].hp).toBe(2) // 防止伤害后，白银狮子离场的恢复仍应结算
    expect(state.zones.discardPile).toContain(armor)
  })

  it('界·小乔【红颜】可改写其他角色的红桃判定结果', () => {
    const { game, state } = fixture()
    state.players[0].characterId = 'jie-xiaoqiao-b44'
    state.players[1].characterId = 'caocao'
    const heart = state.zones.drawPile.find((id: string) => state.cards[id].suit === 'heart')
    state.zones.drawPile = [heart, ...state.zones.drawPile.filter((id: string) => id !== heart)]
    const result: any[] = []
    const tag = 'test:b44-hongyan-other-player'
    registerJudgmentContinuation(tag, (_host, outcome) => result.push(outcome))
    performJudgment(game, 'p1', '批次44测试', { tag })
    const request = state.pendingRequests[0]
    expect(request.playerId).toBe('p0')
    expect(request.prompt).toContain('红颜')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'spade' } })
    expect(result).toHaveLength(1)
    expect(result[0].suit).toBe('spade')
  })

  it('界·小乔【天香】两种后续效果均在原伤害链收束后完成', () => {
    for (const choice of ['damage', 'lose-hp']) {
      const { game, state } = fixture()
      state.players[0].characterId = 'jie-xiaoqiao-b44'
      state.players[2].hp = 3
      const heart = state.zones.drawPile.find((id: string) => state.cards[id].suit === 'heart')
      state.zones.drawPile = state.zones.drawPile.filter((id: string) => id !== heart)
      state.players[0].zones.hand.push(heart)
      game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'normal', cardName: '杀' })
      state.phase = 'prepare'
      game.advancePhase()
      const answer = (payload: unknown) => {
        const request = state.pendingRequests[0]
        expect(request, '天香流程应有待回应请求').toBeTruthy()
        game.respond({ requestId: request.id, playerId: request.playerId, payload } as any)
      }
      answer({ optionId: 'yes' })
      answer({ cardIds: [heart] })
      answer({ targetIds: ['p2'] })
      answer({ optionId: choice })
      expect(state.pendingRequests).toHaveLength(0)
      expect(state.players[0].hp).toBe(3)
      expect(state.players[2].hp).toBe(choice === 'damage' ? 2 : 2)
      if (choice === 'damage') expect(state.players[0].zones.hand.length).toBe(2)
      else expect(state.players[2].zones.hand).toContain(heart)
    }
  })

  it('仲帝袁术【伪帝】把弃牌阶段选牌交给不重复的群雄目标，其余仍进入弃牌堆', () => {
    const { game, state } = fixture()
    state.phase = 'discard'; state.currentPlayerId = 'p0'
    state.players[0].identity = 'lord'; state.players[0].characterId = 'zhongdi-yuanshu-b44'
    state.players[1].kingdomOverride = 'qun'; state.players[2].kingdomOverride = 'qun'
    const selected = state.zones.drawPile.splice(-2)
    state.players[0].zones.hand.push(...selected)
    state.discardPhaseLedger = { phaseInstanceId: 'b44-discard', ownerPlayerId: 'p0', records: [] }
    const request = { id: 'discard-b44', kind: 'choose-cards', playerId: 'p0', prompt: '弃置', timeoutMs: 20_000,
      optional: false, purpose: 'discard-phase', cardIds: selected, hiddenCardSlots: [], min: 2, max: 2 } as any
    state.pendingRequests.push(request)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: selected } })
    const transfer = state.pendingRequests[0]
    expect(transfer.kind).toBe('choose-targets')
    expect(transfer.candidateIds).toContain('p1')
    game.respond({ requestId: transfer.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(state.players[1].zones.hand).toContain(selected[0])
    expect(state.zones.discardPile).toContain(selected[1])
  })
})
