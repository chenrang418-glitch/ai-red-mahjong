import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH43_CHARACTERS } from '@/sanguosha/data/characters/historical-batch43'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { hasArmor } from '@/sanguosha/engine/equipment'
import { markUsedThisPhase } from '@/sanguosha/engine/phase-usage'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-b45-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 2
  state.players.forEach((entry: any, index: number) => {
    entry.characterId = index === 0 ? 'jie-gaoshun-b45' : index === 1 ? 'jie-caozhang-b45' : 'caocao'
    entry.hp = 3; entry.maxHp = 4
    entry.zones.hand = state.zones.drawPile.splice(0, 4)
  })
  const requests: any[] = []
  const host = {
    state, rng: game.rng,
    dispatch: game.dispatch.bind(game),
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b45-${requests.length}`) }) },
    queueSkill(prompt: any) { state.skillQueue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget: game.resumeCardTarget.bind(game), enterDying: game.enterDying.bind(game),
    resumePhaseEntry() {},
  } as any
  return { game, state, host, requests }
}

describe('武将册第45批定向规则（开发中）', () => {
  it('当前接入角色都有唯一注册，且已接入的技能均有运行时', () => {
    expect(HISTORICAL_BATCH43_CHARACTERS).toHaveLength(4)
    for (const character of HISTORICAL_BATCH43_CHARACTERS) {
      expect(ALL_CHARACTERS).toContain(character)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}/${skill.name}`).toBeDefined()
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('界高顺陷阵的无距离、次数和防具豁免只对拼点胜者且限当前阶段', () => {
    const { state } = fixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH43_CHARACTERS[0].skills[0].id)!
    const armorId = state.zones.drawPile[0]
    state.cards[armorId].name = '藤甲'; state.cards[armorId].category = 'equipment'; state.cards[armorId].equipmentSlot = 'armor'
    state.players[1].zones.equipment.armor = armorId
    state.zones.drawPile.shift()
    markUsedThisPhase(state, 'p0', `${runtime.id}:won:p1`)
    expect(runtime.ignoresDistanceTo?.(state, 'p0', 'p1')).toBe(true)
    expect(runtime.ignoresSlashUsesTo?.(state, 'p0', 'p1')).toBe(true)
    expect(hasArmor(state, 'p1', '藤甲', 'p0')).toBe(false)
    expect(hasArmor(state, 'p1', '藤甲', 'p2')).toBe(true)
    state.phase = 'discard'
    expect(runtime.ignoresDistanceTo?.(state, 'p0', 'p1')).toBe(false)
    expect(hasArmor(state, 'p1', '藤甲', 'p0')).toBe(true)
  })

  it('界高顺禁酒强制把酒转为杀、限制他人本回合用酒并减去酒伤加成', () => {
    const { state } = fixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH43_CHARACTERS[0].skills[1].id)!
    const wineId = state.zones.drawPile[0]
    state.cards[wineId].name = '酒'
    expect(runtime.forcedCardIdentity?.(state, 'p0', wineId)).toEqual({ asCardName: '杀', nature: 'normal' })
    expect(runtime.prohibitsCardUse?.(state, 'p0', { userId: 'p2', cardName: '酒', dyingPlayerId: null })).toBe(true)
    const slashId = state.zones.drawPile[1]
    state.wineBoostedSlashCardIds = [slashId]
    expect(runtime.incomingDamage?.(state, 'p0', { sourceId: 'p2', amount: 2, nature: 'normal', cardId: slashId, cardName: '杀', chainTransfer: false })).toEqual({ amount: 1 })
  })

  it('界曹彰将驰摸牌分支仅封住本阶段的杀，弃牌分支给本阶段额外距离与次数', () => {
    const { state, host, requests } = fixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH43_CHARACTERS[1].skills[0].id)!
    const handBefore = state.players[1].zones.hand.length
    runtime.triggers?.find(trigger => trigger.event === 'PhaseStart')?.handle(host, 'p1', {
      event: { payload: { playerId: 'p1', phase: 'play' } },
    } as any)
    expect(requests.at(-1)?.request.options).toHaveLength(2)
    runtime.resume?.(host, 'p1', { step: 'choice', data: {} } as any, { payload: { optionId: 'draw' } } as any)
    expect(state.players[1].zones.hand).toHaveLength(handBefore + 1)
    expect(runtime.prohibitsCardUse?.(state, 'p1', { userId: 'p1', cardName: '杀', dyingPlayerId: null })).toBe(true)
    expect(runtime.prohibitsCardUse?.(state, 'p1', { userId: 'p1', cardName: '闪', dyingPlayerId: null })).toBe(false)
  })

  it('界曹植酒诗一级翻面用酒、受伤后可翻回并随机获得锦囊；成章按累计造成与受到伤害觉醒', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-caozhi-b45'
    const jiushi = getSkillRuntime(HISTORICAL_BATCH43_CHARACTERS[2].skills[1].id)!
    const chengzhang = getSkillRuntime(HISTORICAL_BATCH43_CHARACTERS[2].skills[2].id)!
    const trickIds = state.zones.drawPile.filter((id: string) => state.cards[id].category === 'trick')
    const trickId = trickIds[0]
    expect(trickId).toBeTruthy()
    for (const id of trickIds.slice(1)) state.cards[id].category = 'basic'
    jiushi.invokeActive?.(host, 'p0', jiushi.id)
    expect(state.players[0].faceDown).toBe(true)
    expect(state.turnUsage.wineUses).toBe(1)
    jiushi.triggers?.find(trigger => trigger.event === 'AfterDamage')?.handle(host, 'p0', { event: { targetId: 'p0', payload: {} } } as any)
    jiushi.startQueued?.(host, 'p0', { skillId: jiushi.id, ownerId: 'p0', step: 'restore', data: {} } as any)
    expect(requests.at(-1)?.request.options).toHaveLength(2)
    jiushi.resume?.(host, 'p0', { step: 'restore-choice', data: {} } as any, { payload: { optionId: 'yes' } } as any)
    expect(state.players[0].faceDown).toBe(false)
    expect(state.players[0].zones.hand).toContain(trickId)

    chengzhang.triggers?.find(trigger => trigger.event === 'DamageSettled')?.handle(host, 'p0', {
      event: { sourceId: 'p0', payload: { finalAmount: 4 } },
    } as any)
    chengzhang.triggers?.find(trigger => trigger.event === 'DamageSettled')?.handle(host, 'p0', {
      event: { targetId: 'p0', payload: { finalAmount: 3 } },
    } as any)
    expect(chengzhang.awakening?.ready(state, 'p0')).toBe(true)
    chengzhang.awakening?.invoke(host, 'p0')
    expect(state.players[0].marks[`${jiushi.id}:level`]).toBe(2)
  })
})
