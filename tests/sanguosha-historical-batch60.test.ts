import { describe, expect, it } from 'vitest'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH60_CHARACTERS } from '@/sanguosha/data/characters/historical-batch60'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { abolishSlot } from '@/sanguosha/engine/equipment-slots'
import { moveCard } from '@/sanguosha/engine/zones'
import { pushCardUseTargets } from '@/sanguosha/engine/card-use-targets'

const YOULONG = 'youlong-wolong-fengchu:b60'
const LUANFENG = 'luanfeng-wolong-fengchu:b60'
const QIGONG = 'qigong-lvkuang-lvxiang:b60'
const ZIQU = 'ziqu-sp-zhangliao:b60'

function gameFor(seed: string) {
  const game = new SanguoshaGame({ seed, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  game.state.status = 'playing'
  game.state.currentPlayerId = game.state.players[0]!.id
  game.state.phase = 'play'
  game.state.roundNumber = 1
  return game
}

describe('武将册续开发第60批', () => {
  it('十名武将按武将册顺序注册，所有技能都有运行时', () => {
    const expected = [
      '界·王基', '将华雄', '左棻', 'SP·张郃', '吕旷吕翔',
      'SP·张辽', '卧龙凤雏', '黄承彦', '高干', '范疆张达',
    ]
    expect(HISTORICAL_BATCH60_CHARACTERS.map(({ name }) => name)).toEqual(expected)
    expect(HISTORICAL_BATCH60_CHARACTERS.map(({ id }) => getCharacter(id)?.id)).toEqual(HISTORICAL_BATCH60_CHARACTERS.map(({ id }) => id))
    for (const character of HISTORICAL_BATCH60_CHARACTERS) {
      expect(character.skills.length, `${character.name}没有技能`).toBeGreaterThan(0)
      for (const skill of character.skills)
        expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】缺少运行时`).toBeDefined()
    }
  })

  it('游龙阳面废除实际装备栏，并把普通锦囊送入正式使用结算', () => {
    const game = gameFor('b60-youlong-yang')
    const owner = game.state.players[0]!
    owner.characterId = 'wolong-fengchu-b60'
    const runtime = getSkillRuntime(YOULONG)!
    runtime.invokeActive?.(game as never, owner.id)
    const slotRequest = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: slotRequest.id, playerId: owner.id, payload: { optionId: 'weapon' } })
    const useRequest = game.state.pendingRequests.at(-1)!
    if (useRequest.kind !== 'choose-option') throw new Error('游龙没有提供可用的普通锦囊选择')
    const use = useRequest.options.find(({ label }) => label.includes('无中生有'))
    if (!use) throw new Error('游龙没有开放合法的【无中生有】')
    game.respond({ requestId: useRequest.id, playerId: owner.id, payload: { optionId: use.id } })
    expect(game.state.abolishedSlots?.[owner.id]).toContain('weapon')
    expect(game.state.cardUseHistory?.some(({ sourceId, cardName }) => sourceId === owner.id && cardName === '无中生有')).toBe(true)
  })

  it('游龙阴面用普通基本牌结算并按同一转换技轮次记牌名', () => {
    const game = gameFor('b60-youlong-yin')
    const owner = game.state.players[0]!
    owner.characterId = 'wolong-fengchu-b60'
    owner.hp -= 1
    ;(game.state as typeof game.state & { b60Youlong: Record<string, unknown> }).b60Youlong = {
      [owner.id]: { roundNumber: 1, side: 'yin', usedSides: [], usedCardNames: [] },
    }
    getSkillRuntime(YOULONG)!.invokeActive?.(game as never, owner.id)
    const slotRequest = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: slotRequest.id, playerId: owner.id, payload: { optionId: 'armor' } })
    const useRequest = game.state.pendingRequests.at(-1)!
    if (useRequest.kind !== 'choose-option') throw new Error('游龙没有提供可用的基本牌选择')
    const use = useRequest.options.find(({ label }) => label.includes('【桃】'))
    if (!use) throw new Error('游龙没有开放合法的【桃】')
    const hp = owner.hp
    game.respond({ requestId: useRequest.id, playerId: owner.id, payload: { optionId: use.id } })
    expect(owner.hp).toBe(hp + 1)
    expect(game.state.abolishedSlots?.[owner.id]).toContain('armor')
    expect((game.state as typeof game.state & { b60Youlong: Record<string, { usedCardNames: string[] }> }).b60Youlong[owner.id]?.usedCardNames).toContain('桃')
  })

  it('鸾凤在濒死时按复原装备栏数量摸牌，并恢复至3点体力', () => {
    const game = gameFor('b60-luanfeng')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'wolong-fengchu-b60'
    owner.maxHp = 4
    target.maxHp = 4
    target.hp = 0
    abolishSlot(game.state, target.id, 'weapon')
    abolishSlot(game.state, target.id, 'armor')
    ;(game.state as typeof game.state & { dying: { playerId: string } }).dying = { playerId: target.id }
    const runtime = getSkillRuntime(LUANFENG)!
    const trigger = runtime.triggers?.find(({ event }) => event === 'EnterDying')
    if (!trigger) throw new Error('鸾凤没有濒死触发器')
    trigger.handle(game as never, owner.id, {
      event: { id: 'b60-enter-dying', seq: game.state.seq + 1, name: 'EnterDying', sourceId: owner.id, targetId: target.id, payload: {} },
      cancelled: false, cancel() {},
    } as never)
    runtime.startQueued?.(game as never, owner.id, { skillId: LUANFENG, ownerId: owner.id, step: 'offer', data: { targetId: target.id } })
    const request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'yes' } })
    expect(target.hp).toBe(3)
    expect(game.state.abolishedSlots?.[target.id] ?? []).toEqual([])
    expect(target.zones.hand).toHaveLength(4)
    expect(owner.usedLimitedSkills).toContain(LUANFENG)
  })

  it('齐攻只在单目标杀被闪抵消后发动，并实际结算不可响应的无距离杀', () => {
    const game = gameFor('b60-qigong')
    const [owner, target] = game.state.players
    if (!owner || !target) throw new Error('fixture players missing')
    owner.characterId = 'lvkuang-lvxiang-b60'
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    for (const player of game.state.players) if (player.id !== target.id) {
      const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: player.id })
    }
    pushCardUseTargets(game.state, { cardId: slashId, sourceId: owner.id, targetIds: [target.id] })
    const runtime = getSkillRuntime(QIGONG)!
    const trigger = runtime.triggers?.find(({ event }) => event === 'CardResponded')!
    trigger.handle(game as never, owner.id, {
      event: { id: 'b60-qigong-dodge', seq: game.state.seq + 1, name: 'CardResponded', sourceId: target.id,
        targetId: owner.id, payload: { cardName: '闪', slashCardId: slashId } },
      cancelled: false, cancel() {},
    } as never)
    const offerPrompt = game.state.skillQueue.shift()
    if (!offerPrompt) throw new Error('齐攻没有排入发动询问')
    runtime.startQueued?.(game as never, owner.id, offerPrompt)
    const offer = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: offer.id, playerId: owner.id, payload: { optionId: 'yes' } })
    const chooseActor = game.state.pendingRequests.at(-1)!
    if (chooseActor.kind !== 'choose-targets') throw new Error(`齐攻没有提供使用杀的角色选择：${JSON.stringify(chooseActor)}`)
    const actorId = chooseActor.candidateIds[0]!
    const actor = game.state.players.find((player) => player.id === actorId)!
    const actorSlashId = actor.zones.hand.find((id) => game.state.cards[id]?.name === '杀')!
    game.respond({ requestId: chooseActor.id, playerId: owner.id, payload: { targetIds: [actorId] } })
    const chooseSlash = game.state.pendingRequests.at(-1)!
    const beforeHp = target.hp
    game.respond({ requestId: chooseSlash.id, playerId: actorId, payload: { cardIds: [actorSlashId] } })
    expect(target.hp).toBe(beforeHp - 1)
    expect(game.state.pendingRequests.some((request) => request.playerId === target.id && request.kind === 'respond-card')).toBe(false)
  })

  it('资取拒绝无牌目标的免费防止，并在发动后只让目标交最大点数牌', () => {
    const game = gameFor('b60-ziqu')
    const [owner, target] = game.state.players
    if (!owner || !target) throw new Error('fixture players missing')
    owner.characterId = 'sp-zhangliao-b60'
    const ranks = [...game.state.zones.drawPile].sort((left, right) => game.state.cards[right]!.rank - game.state.cards[left]!.rank)
    const highest = ranks[0]!
    const low = ranks.at(-1)!
    moveCard(game.state, low, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, highest, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const beforeHp = target.hp
    game.damage({ sourceId: owner.id, targetId: target.id, amount: 1 })
    const queued = game.state.skillQueue.shift()
    if (!queued) throw new Error('资取没有进入来源伤害防止窗口')
    getSkillRuntime(ZIQU)!.startQueued?.(game as never, owner.id, queued)
    const prevention = game.state.pendingRequests.at(-1)!
    expect(prevention?.kind).toBe('choose-option')
    game.respond({ requestId: prevention.id, playerId: owner.id, payload: { optionId: 'yes' } })
    const give = game.state.pendingRequests.at(-1)!
    if (give.kind !== 'choose-cards') throw new Error('资取没有请求目标交牌')
    expect(give.playerId).toBe(target.id)
    expect(give.cardIds).toEqual([])
    expect(give.hiddenCardSlots).toEqual([`hidden:${target.id}:1`])
    game.respond({ requestId: give.id, playerId: target.id, payload: { cardIds: [`hidden:${target.id}:1`] } })
    expect(target.hp).toBe(beforeHp)
    expect(owner.zones.hand).toContain(highest)
    expect(target.zones.hand).not.toContain(highest)
  })
})
