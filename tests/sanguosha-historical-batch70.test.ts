import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { beginVirtualDelayedTrick } from '@/sanguosha/engine/cards/basic'
import { effectiveCardColor, getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { effectiveCardName, moveCard } from '@/sanguosha/engine/zones'
import { HISTORICAL_BATCH70_CHARACTERS } from '@/sanguosha/data/characters/historical-batch70'

const SHEN_ZHANGFEI_XUNSHI = 'xunshi-shenzhangfei-b70'
const SHEN_DENGAI_XIANJIN = 'xianjin-shendengai-b70'
const SHEN_DENGAI_ZONES = ['丰田', '清渠', '峻山']
const MO_SIMAYI_GUIFU = 'guifu-mosimayi-b70'
const MO_DIAOCHAN_HUANHUO = 'huanhuo-modiaochan-b70'
const MO_ZHANGFEI = HISTORICAL_BATCH70_CHARACTERS.find(({ name }) => name === '魔·张飞')!

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第70批未发布武将', () => {
  it('包含武将册序号779–788中的10名角色，顺序与武将册一致且无重复', () => {
    expect(HISTORICAL_BATCH70_CHARACTERS.map(({ name }) => name)).toEqual([
      '魔·司马懿', '魔·吕布', '魔·貂蝉', '魔·曹操', '魔·孙权', '魔·张飞', '神·张飞', '神·邓艾', '武诸葛亮', '张虎',
    ])
    expect(new Set(HISTORICAL_BATCH70_CHARACTERS.map(({ id }) => id)).size).toBe(10)
  })

  it('神·邓艾【险进】只在累计两次受伤/造成伤害后请求开发区域', () => {
    const game = gameFor('b70-xianjin-threshold')
    const owner = game.state.players[0]!
    const runtime = getSkillRuntime(SHEN_DENGAI_XIANJIN)!
    const trigger = runtime.triggers!.find(({ event }) => event === 'DamageSettled')!
    const invoke = (id: string) => trigger.handle(game, owner.id, {
      event: { id, seq: game.state.seq++, name: 'DamageSettled', sourceId: owner.id,
        payload: { sourceId: owner.id, targetId: game.state.players[1]!.id, finalAmount: 1 } },
      cancelled: false, cancel() { this.cancelled = true },
    })
    invoke('b70-xianjin-1')
    expect(game.state.skillQueue).toHaveLength(0)
    invoke('b70-xianjin-2')
    expect(game.state.skillQueue.at(-1)).toMatchObject({ skillId: SHEN_DENGAI_XIANJIN, step: 'develop' })
  })

  it('神·邓艾初始化时将尚未开发的三个手牌副区域隐藏', () => {
    const game = gameFor('b70-tuoyu-hidden-piles')
    const owner = game.state.players[0]!
    getSkillRuntime(SHEN_DENGAI_XIANJIN)!.onGameStart!(game, owner.id)
    expect(owner.hiddenCharacterPiles).toEqual(expect.arrayContaining(SHEN_DENGAI_ZONES))
  })

  it('神·张飞【巡使】仅为规定的多目标锦囊提供转化动作', () => {
    const game = gameFor('b70-xunshi-card-gate')
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime(SHEN_ZHANGFEI_XUNSHI)!
    const multiTargetTrick = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '南蛮入侵')!
    const singleTargetTrick = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '顺手牵羊')!
    moveCard(game.state, multiTargetTrick, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, singleTargetTrick, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    expect(runtime.activeActions!(game.state, owner.id).map(({ id }) => id)).toContain(`skill:${SHEN_ZHANGFEI_XUNSHI}:slash:${multiTargetTrick}`)
    expect(runtime.activeActions!(game.state, owner.id).map(({ id }) => id)).not.toContain(`skill:${SHEN_ZHANGFEI_XUNSHI}:slash:${singleTargetTrick}`)
    runtime.resume!(game, owner.id, { step: 'slash-targets', data: { cardId: multiTargetTrick,
      candidateIds: [game.state.players[1]!.id, game.state.players[2]!.id] } } as never,
    { payload: { targetIds: [game.state.players[1]!.id, game.state.players[2]!.id] } } as never)
    expect(effectiveCardName(game.state, multiTargetTrick)).toBe('杀')
    expect(effectiveCardColor(game.state, owner.id, multiTargetTrick)).toBeNull()
    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', cardId: multiTargetTrick })
  })

  it('魔·张飞【瞋视】独立处理目标颜色分支与三点伤害入魔', () => {
    const game = gameFor('b70-chenshi')
    const owner = game.state.players[0]!
    const different = game.state.players[1]!
    const same = game.state.players[2]!
    const secondDifferent = game.state.players[3]!
    owner.characterId = MO_ZHANGFEI.id
    owner.hp = 3; owner.maxHp = 4
    different.hp = 1; different.maxHp = 4
    same.hp = 3; same.maxHp = 4
    secondDifferent.hp = 1; secondDifferent.maxHp = 4
    const [jiaohun, chenshi] = MO_ZHANGFEI.skills.map(({ id }) => getSkillRuntime(id))
    expect(jiaohun).toBeDefined()
    expect(chenshi).toBeDefined()
    const slashId = owner.zones.hand[0] ?? game.state.zones.drawPile[0]!
    if (!owner.zones.hand.includes(slashId)) moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.cards[slashId] = { ...game.state.cards[slashId]!, name: '杀', category: 'basic', color: 'black', suit: 'spade' }
    expect(chenshi!.slashTargetExpansionForAction?.(game.state, owner.id, slashId, [different.id])?.candidateIds)
      .toContain(secondDifferent.id)
    expect(chenshi!.slashTargetExpansionForAction?.(game.state, owner.id, slashId, [same.id])).toBeNull()
    expect(chenshi!.useCardNameOverride?.(game.state, owner.id, same.id, slashId, '杀', [owner.id])).toBe('决斗')
    expect(chenshi!.useCardNameOverride?.(game.state, owner.id, different.id, slashId, '杀', [owner.id])).toBeNull()

    owner.hp = 2
    const damageTrigger = chenshi!.triggers!.find(({ event }) => event === 'DamageSettled')!
    damageTrigger.handle(game, owner.id, { event: { sourceId: owner.id, targetId: different.id,
      payload: { cardName: '决斗', finalAmount: 3 } } } as any)
    expect(owner.hp).toBe(3)
    expect((game.state as any).b70.moZhangfei[owner.id].transformed).toBe(true)
  })

  it('魔·司马懿【诡伏】记录造成伤害的牌名，并将实际伤害来源记录为【骤袭】目标', () => {
    const game = gameFor('b70-guifu-damage-sources')
    const owner = game.state.players[0]!
    const attacker = game.state.players[1]!
    const victim = game.state.players[2]!
    const runtime = getSkillRuntime(MO_SIMAYI_GUIFU)!
    const trigger = runtime.triggers!.find(({ event }) => event === 'DamageSettled')!
    const invoke = (id: string, sourceId: string, targetId: string, cardName: string, sourceSkillId?: string) => trigger.handle(game, owner.id, {
      event: { id, seq: game.state.seq++, name: 'DamageSettled', sourceId, targetId, sourceSkillId,
        payload: { sourceId, targetId, cardName, finalAmount: 1 } }, cancelled: false, cancel() { this.cancelled = true },
    })
    invoke('b70-guifu-incoming', attacker.id, owner.id, '火攻')
    invoke('b70-guifu-outgoing', owner.id, victim.id, '杀')
    invoke('b70-guifu-direct-skill', attacker.id, victim.id, '技能伤害', 'direct-damage-skill')
    const record = (game.state as typeof game.state & { b70: { simayi: Record<string, { recordedNames: string[]; damagedThisRound: string[]; dealtDamageThisRound: boolean }> } }).b70.simayi[owner.id]!
    expect(record.recordedNames).toEqual(['火攻', '杀', 'direct-damage-skill'])
    expect(record.damagedThisRound).toEqual([attacker.id])
    expect(record.dealtDamageThisRound).toBe(true)
    const flashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '闪')!
    moveCard(game.state, flashId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    ;(record as typeof record & { flashIds: string[] }).flashIds = [flashId]
    expect(runtime.viewAs!(game.state, owner.id).map(({ asCardName }) => asCardName)).toEqual(expect.arrayContaining(['火攻', '杀']))
    expect(runtime.viewAs!(game.state, owner.id).map(({ asCardName }) => asCardName)).not.toContain('direct-damage-skill')
  })

  it('魔·貂蝉【幻惑】不附加官方描述中没有的未造成伤害扣体力效果', () => {
    const runtime = getSkillRuntime(MO_DIAOCHAN_HUANHUO)!
    expect(runtime.triggers?.some(({ event }) => event === 'RoundEnd')).toBe(false)
  })

  it('神·张飞【神裁】的“杖”只阻止响应【杀】，不拦截其他【闪】响应', () => {
    const game = gameFor('b70-zhang-mark')
    const [source, target] = game.state.players
    source!.characterId = 'zhangfei'
    target!.marks['杖'] = 1
    game.state.currentPlayerId = source!.id
    game.state.phase = 'play'
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: source!.id })
    const action = game.legalActions(source!.id).find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slashId) && candidate.targetIds.includes(target!.id))!
    game.act(source!.id, action.id)
    expect(game.state.pendingRequests.some((request) => request.playerId === target!.id && request.kind === 'respond-card')).toBe(false)
    expect(target!.hp).toBe(target!.maxHp - 1)
  })

  it('技能生成的延时锦囊可留在判定区，并在离开时销毁虚拟牌而不污染弃牌堆', () => {
    const game = gameFor('b70-virtual-delayed-trick-lifecycle')
    const [owner, target] = game.state.players
    expect(beginVirtualDelayedTrick(game, { sourceId: owner!.id, targetId: target!.id,
      cardName: '乐不思蜀', sourceSkillId: 'test-virtual-delayed' })).toBe(true)
    const cardId = target!.zones.judgingArea[0]!
    expect(game.state.cards[cardId]?.virtual).toBe(true)
    moveCard(game.state, cardId, { kind: 'judgingArea', playerId: target!.id }, { kind: 'discardPile' })
    expect(game.state.cards[cardId]).toBeUndefined()
    expect(game.state.zones.discardPile).not.toContain(cardId)
  })
})
