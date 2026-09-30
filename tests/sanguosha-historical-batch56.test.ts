import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH56_CHARACTERS } from '@/sanguosha/data/characters/historical-batch56'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'

const batch = HISTORICAL_BATCH56_CHARACTERS
const names = [
  '谋·吕布', '势·魏延', '孙韶', '势·陈到', '势·陆郁生',
  '势·张燕', '势·田丰', '乐就', '势·国渊', 'SP·曹操',
]

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-batch56-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `b56p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const caocao = game.state.players[0]!
  const actor = game.state.players[1]!
  const target = game.state.players[2]!
  caocao.characterId = batch.find(({ name }) => name === 'SP·曹操')!.id
  actor.hp = 4
  game.state.status = 'playing'
  game.state.phase = 'play'
  game.state.turnNumber = 1
  game.state.roundNumber = 1
  game.state.currentPlayerId = actor.id
  return { game, caocao, actor, target }
}

describe('第56批武将：批次定向验证', () => {
  it('按武将册671—680顺序登记，且每个技能都有独立运行时', () => {
    expect(batch.map(({ name }) => name)).toEqual(names)
    expect(ALL_CHARACTERS.filter(({ id }) => id.endsWith('-b56')).map(({ name }) => name)).toEqual(names)
    for (const character of batch) for (const skill of character.skills)
      expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
  })

  it('令法拦截技能生成的杀；拒绝弃牌会先承受曹操伤害，再续接原虚拟杀', () => {
    const { game, caocao, actor, target } = fixture()
    const costCardId = game.state.zones.drawPile[0]!
    moveCard(game.state, costCardId, { kind: 'drawPile' }, { kind: 'hand', playerId: actor.id })
    ;(game.state as typeof game.state & { b56Caocao: { roundEffect: 'slash'; roundEffectRound: number; turns: Record<string, number> } })
      .b56Caocao = { roundEffect: 'slash', roundEffectRound: 1, turns: {} }

    expect(game.beginVirtualSlash({ sourceId: actor.id, targetId: target.id, sourceSkillId: 'batch56-test' })).toBe(true)
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    if (request.kind !== 'choose-option') throw new Error('令法未向杀的使用者询问')
    expect(request.playerId).toBe(actor.id)
    expect(request.options.map(({ id }) => id)).toContain('refuse')
    game.respond({ requestId: request.id, playerId: actor.id, payload: { optionId: 'refuse' } })

    expect(actor.hp).toBe(3)
    expect(game.state.cardResolution?.kind).toBe('slash')
    expect(game.state.cardResolution?.sourceId).toBe(actor.id)
    expect(game.state.cardResolution?.targetId).toBe(target.id)
  })

  it('第三轮令法转为治暗和奸雄，并永久失去令法', () => {
    const { game, caocao } = fixture()
    game.state.roundNumber = 3
    game.emit('RoundStart', { roundNumber: 3 })

    expect(caocao.permanentlyLostSkills).toContain(batch.find(({ name }) => name === 'SP·曹操')!.skills[0]!.id)
    expect(caocao.grantedSkills).toEqual(expect.arrayContaining(
      batch.find(({ name }) => name === 'SP·曹操')!.skills.filter(({ granted }) => granted).map(({ id }) => id),
    ))
  })

  it('骁戈只对飞径追加目标防止伤害，并回复且收回该角色路径上弃置的牌', () => {
    const { game, caocao: zhangyan, actor, target } = fixture()
    zhangyan.characterId = batch.find(({ name }) => name === '势·张燕')!.id
    zhangyan.hp = zhangyan.maxHp - 1
    const slashCardId = game.state.zones.drawPile[0]!
    const pathCardId = game.state.zones.drawPile[1]!
    moveCard(game.state, pathCardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    const state = game.state as typeof game.state & { b56Zhangyan: Record<string, { ownerId: string; extras: Record<string, string>; initialTargetId: string }> }
    state.b56Zhangyan = { [slashCardId]: { ownerId: zhangyan.id, extras: { [target.id]: pathCardId }, initialTargetId: actor.id } }
    const runtime = getSkillRuntime(batch.find(({ name }) => name === '势·张燕')!.skills.find(({ name }) => name === '骁戈')!.id)!

    expect(runtime.preventsDamage?.(game.state, zhangyan.id, 'source', {
      sourceId: zhangyan.id, targetId: target.id, amount: 1, nature: 'normal', cardId: slashCardId,
      cardName: '杀', chainTransfer: false,
    })).toBe(true)
    game.dispatch('DamageSettled', { cardId: slashCardId, finalAmount: 0 }, {
      sourceId: zhangyan.id, targetId: target.id, cardIds: [slashCardId],
    })

    expect(zhangyan.hp).toBe(zhangyan.maxHp)
    expect(zhangyan.zones.hand).toContain(pathCardId)
    expect(game.state.zones.discardPile).not.toContain(pathCardId)
  })

  it('骁戈的单目标杀后续决斗排队到原杀结束后才启动', () => {
    const { game, caocao: zhangyan, actor: target } = fixture()
    zhangyan.characterId = batch.find(({ name }) => name === '势·张燕')!.id
    const slashCardId = game.state.zones.drawPile[0]!
    game.state.cardUseTargets = [{ cardId: slashCardId, sourceId: zhangyan.id, targetIds: [target.id] }]
    game.dispatch('AfterCardUse', { cardId: slashCardId, cardName: '杀', targetIds: [target.id] }, {
      sourceId: zhangyan.id, targetId: target.id, cardIds: [slashCardId],
    })

    expect(game.state.cardResolution).toBeNull()
    expect(game.state.skillQueue.some(({ skillId, step }) => skillId.endsWith('xiaoge-shi-zhangyan:b56') && step === 'duel')).toBe(true)
    const skill = batch.find(({ name }) => name === '势·张燕')!.skills.find(({ name }) => name === '骁戈')!
    getSkillRuntime(skill.id)!.startQueued?.(game as never, zhangyan.id, {
      skillId: skill.id, ownerId: zhangyan.id, step: 'duel', data: { targetId: target.id },
    })
    expect(game.state.cardResolution?.kind).toBe('trick')
    expect(game.state.cardResolution?.sourceId).toBe(zhangyan.id)
    expect(game.state.cardResolution?.kind === 'trick' ? game.state.cardResolution.targetIds : []).toContain(target.id)
  })
})
