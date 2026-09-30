import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { getAttackRange, getDistance } from '@/sanguosha/engine/distance'
import type { GameResponse } from '@/sanguosha/engine/requests'

const batch = ALL_CHARACTERS.filter(({ id }) => id.endsWith('-b54'))
const byName = (name: string) => batch.find((entry) => entry.name === name)!
const skillId = (characterName: string, name: string) => byName(characterName).skills.find((entry) => entry.name === name)!.id

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-batch54-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `b54p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  return { game, owner: game.state.players[0]!, target: game.state.players[2]! }
}

describe('第54批武将：批次定向验证', () => {
  it('按武将册651—660顺序注册十名角色，且每项技能均有运行时', () => {
    expect(batch.map(({ name }) => name)).toEqual([
      '谋·曹丕', '谋·黄月英', '谋·小乔', '木鹿大王', '谋·夏侯惇',
      '谋·韩当', '谋·陆逊', 'SP·甄姬', '谋·贾诩', '谋·诸葛瑾',
    ])
    for (const character of batch)
      for (const skill of character.skills)
        expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
  })

  it('【解烦】由被指定角色选择摸牌分支，并按发动时的攻击范围人数摸牌', () => {
    const { game, owner, target } = fixture()
    owner.characterId = byName('谋·韩当').id
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const runtime = getSkillRuntime(skillId('谋·韩当', '解烦'))!
    const action = runtime.activeActions?.(game.state, owner.id)[0]!
    runtime.invokeActive?.(game, owner.id, action.id)
    const targetRequest = game.state.pendingRequests.find((request) => request.kind === 'choose-targets')!
    game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } } as GameResponse)
    const holders = game.state.players.filter((player) => player.alive && player.id !== target.id
      && getDistance(game.state, player.id, target.id) <= getAttackRange(game.state, player.id)).length
    const modeRequest = game.state.pendingRequests.find((request) => request.kind === 'choose-option')!
    expect(modeRequest.playerId).toBe(target.id)
    const before = target.zones.hand.length
    game.respond({ requestId: modeRequest.id, playerId: target.id, payload: { optionId: 'draw' } } as GameResponse)
    expect(target.zones.hand.length).toBe(before + holders)
  })

  it('【缓释】将牌堆顶牌纳入真实改判候选，蓄力技判定能识别已注册角色', () => {
    const { game, owner, target } = fixture()
    owner.characterId = byName('谋·诸葛瑾').id
    const huanshi = getSkillRuntime(skillId('谋·诸葛瑾', '缓释'))!
    expect(huanshi.retrialDrawPileTop?.(game.state, owner.id, target.id)).toBe(true)
    const chargeCharacter = ALL_CHARACTERS.find((character) => character.skills.some((entry) => entry.description.includes('蓄力技')))
    expect(chargeCharacter).toBeDefined()
    expect(getCharacter(chargeCharacter!.id)).toBe(chargeCharacter)
  })

  it('【完杀】在贾诩回合阻止非濒死他人救援，但保留濒死自救和贾诩救援', () => {
    const { game, owner, target } = fixture()
    owner.characterId = byName('谋·贾诩').id
    game.state.currentPlayerId = owner.id
    const wansha = getSkillRuntime(skillId('谋·贾诩', '完杀'))!
    const context = { cardName: '桃', userId: target.id, dyingPlayerId: game.state.players[3]!.id }
    expect(wansha.prohibitsCardUse?.(game.state, owner.id, context as never)).toBe(true)
    expect(wansha.prohibitsCardUse?.(game.state, owner.id, { ...context, userId: context.dyingPlayerId } as never)).toBe(false)
    expect(wansha.prohibitsCardUse?.(game.state, owner.id, { ...context, userId: owner.id } as never)).toBe(false)
  })
})
