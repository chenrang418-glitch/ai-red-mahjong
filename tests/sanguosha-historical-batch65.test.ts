import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { executeUseCardAction, legalPlayActions, skillHandCardUseActions } from '@/sanguosha/engine/cards/basic'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import type { PlayerId } from '@/sanguosha/engine/types'

const names = ['界·夏侯氏', '界·郭皇后', '界·张松', '谋·太史慈', '谋·董卓', '谋·孙坚', '谋·孔融', '谋·袁术', '谋·张绣', '谋·文丑']
const LIWEN = 'liwen-mou-kongrong-b65'
const ZHENGYI = 'zhengyi-mou-kongrong-b65'
const XIAN = 'mou-kongrong-xian'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第65批', () => {
  it('十名武将及其每项技能均有运行时', () => {
    const characters = names.map((name) => ALL_CHARACTERS.find((character) => character.name === name))
    expect(characters.every(Boolean)).toBe(true)
    expect(new Set(characters.map((character) => character!.id)).size).toBe(10)
    for (const character of characters) {
      for (const skill of character!.skills) expect(getSkillRuntime(skill.id), `${character!.name}【${skill.name}】`).toBeDefined()
    }
  })

  it('立文开局得三贤，牌外仍按正常合法性提供实体手牌用法', () => {
    const game = gameFor('b65-liwen-actions')
    const [owner, holder, victim] = game.state.players
    owner!.characterId = 'mou-kongrong-b65'
    holder!.characterId = 'taishici'
    victim!.characterId = 'caocao'
    getSkillRuntime(LIWEN)!.onGameStart?.(game as never, owner!.id as PlayerId)
    expect(owner!.marks[XIAN]).toBe(3)

    const slash = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: holder!.id })
    game.state.phase = 'finish'
    game.state.currentPlayerId = owner!.id
    const beforePhase = game.state.phase
    const actions = skillHandCardUseActions(game.state, holder!.id, slash)
    expect(actions.some((action) => action.cardIds[0] === slash && action.targetIds.includes(victim!.id))).toBe(true)
    expect(game.state.phase).toBe(beforePhase)
    expect(game.state.currentPlayerId).toBe(owner!.id)
  })

  it('立文回合结束无人分配且贤角色没有可用手牌时，移去其贤并按数摸牌', () => {
    const game = gameFor('b65-liwen-no-legal-card')
    const owner = game.state.players[0]!
    owner.characterId = 'mou-kongrong-b65'
    getSkillRuntime(LIWEN)!.onGameStart?.(game as never, owner.id as PlayerId)
    getSkillRuntime(LIWEN)!.startQueued?.(game as never, owner.id as PlayerId, {
      skillId: LIWEN, ownerId: owner.id, step: 'distribute', data: { selected: [] },
    } as never)
    const request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-targets', playerId: owner.id, optional: true })
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [] } })
    expect(owner.marks[XIAN]).toBeUndefined()
    expect(owner.zones.hand).toHaveLength(3)
  })

  it('争义同时收取其他贤角色的选择；有人同意则防止伤害并由最高体力同意者失去体力', () => {
    const game = gameFor('b65-zhengyi-yes')
    const [kongrong, source, target, voter] = game.state.players
    kongrong!.characterId = 'mou-kongrong-b65'
    source!.characterId = 'caocao'
    target!.characterId = 'taishici'
    voter!.characterId = 'caocao'
    target!.marks[XIAN] = 1
    voter!.marks[XIAN] = 2
    target!.hp = 4
    voter!.hp = 4

    game.damage({ sourceId: source!.id, targetId: target!.id, amount: 1, nature: 'normal' })
    expect(game.state.pendingRequests).toHaveLength(1)
    expect(game.state.pendingRequests[0]!.playerId).toBe(voter!.id)
    game.respond({ requestId: game.state.pendingRequests[0]!.id, playerId: voter!.id, payload: { optionId: 'yes' } })
    expect(target!.hp).toBe(4)
    expect(voter!.hp).toBe(3)
  })

  it('争义无人同意时原伤害继续结算', () => {
    const game = gameFor('b65-zhengyi-no')
    const [kongrong, source, target, voter] = game.state.players
    kongrong!.characterId = 'mou-kongrong-b65'
    source!.characterId = 'caocao'
    target!.characterId = 'taishici'
    voter!.characterId = 'caocao'
    target!.marks[XIAN] = 1
    voter!.marks[XIAN] = 1
    target!.hp = 4
    game.damage({ sourceId: source!.id, targetId: target!.id, amount: 1, nature: 'normal' })
    const request = game.state.pendingRequests[0]!
    game.respond({ requestId: request.id, playerId: voter!.id, payload: { optionId: 'no' } })
    expect(target!.hp).toBe(3)
  })

  it('笃烈令唯一目标的同一张杀效果结算两次，但使用时机只记录一次', () => {
    const game = gameFor('b65-dulie-repeat')
    const [source, taishici] = game.state.players
    source!.characterId = 'caocao'
    taishici!.characterId = 'mou-taishici-b65'
    taishici!.hp = 4
    const slash = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: source!.id })
    game.state.currentPlayerId = source!.id
    game.state.phase = 'play'
    const action = legalPlayActions(game.state, source!.id).find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds[0] === slash && candidate.targetIds.length === 1 && candidate.targetIds[0] === taishici!.id)
    if (!action || action.kind !== 'use-card') throw new Error('测试未生成对谋太史慈使用的合法【杀】动作')
    executeUseCardAction(game as never, source!.id, action)

    const invoke = game.state.pendingRequests.at(-1)!
    expect(invoke).toMatchObject({ kind: 'choose-option', skillId: 'dulie-mou-taishici-b65', playerId: taishici!.id })
    game.respond({ requestId: invoke.id, playerId: taishici!.id, payload: { optionId: 'yes' } })
    for (let pass = 0; pass < 2; pass += 1) {
      const dodge = game.state.pendingRequests.find((request) => request.kind === 'respond-card' && request.playerId === taishici!.id)
      expect(dodge, `第${pass + 1}次结算应各自询问【闪】`).toBeDefined()
      expect(game.state.cardResolution?.requestId, `第${pass + 1}次响应要绑定到当前牌结算`).toBe(dodge!.id)
      game.respond({ requestId: dodge!.id, playerId: taishici!.id, payload: { actionId: 'respond-pass' } })
    }
    expect(taishici!.hp).toBe(2)
    expect(taishici!.zones.hand).toHaveLength(1)
    expect(game.state.cardUseHistory?.filter((entry) => entry.sourceId === source!.id && entry.cardName === '杀')).toHaveLength(1)
  })
})
