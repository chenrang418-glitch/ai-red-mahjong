import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { HISTORICAL_BATCH79_CHARACTERS } from '@/sanguosha/data/characters/historical-batch79'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { moveCard } from '@/sanguosha/engine/zones'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((entry) => { entry.characterId = null })
  return game
}

describe('武将册第79批运行时', () => {
  it('按册中顺序注册十名武将，所有技能均连接到运行时', () => {
    expect(HISTORICAL_BATCH79_CHARACTERS.map(({ name }) => name)).toEqual([
      '谋·王凌', '谋·司马师', '谋·曹爽', '武关羽', '星·孙坚', '吴普', '关樾', '朱佩兰', '谋·关平', '乐邹氏',
    ])
    expect(new Set(HISTORICAL_BATCH79_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    for (const character of HISTORICAL_BATCH79_CHARACTERS) expect(ALL_CHARACTERS.some(({ id }) => id === character.id)).toBe(true)
    for (const skill of HISTORICAL_BATCH79_CHARACTERS.flatMap(({ skills }) => skills)) {
      expect(getSkillRuntime(skill.id), `${skill.name}/${skill.id}`).toBeDefined()
    }
  })

  it('【锻体】每五次使用或打出结算只成长一次，并受开局体力上限+5限制', () => {
    const game = gameFor('b79-duanti')
    const owner = game.state.players[0]!
    owner.characterId = 'wupu-b79'
    owner.hp = 1
    owner.maxHp = 3
    const runtime = getSkillRuntime('duanti-wupu-b79')!
    runtime.onGameStart?.(game as never, owner.id)
    const resolved = runtime.triggers!.find(({ event }) => event === 'CardResolved')!
    for (let index = 0; index < 5; index += 1) resolved.handle(game as never, owner.id,
      { event: { name: 'CardResolved', sourceId: owner.id, payload: {} } } as never)
    expect(owner.maxHp).toBe(4)
    expect(owner.hp).toBe(2)
  })

  it('【武威】只允许同色材料；【绝武】只为二点或获得牌生成伤害牌转化', () => {
    const game = gameFor('b79-viewas')
    const owner = game.state.players[0]!
    owner.characterId = 'mou-guanping-b79'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const two = game.state.zones.drawPile.find((id) => game.state.cards[id]?.rank === 2)!
    const other = game.state.zones.drawPile.find((id) => game.state.cards[id]?.rank !== 2)!
    moveCard(game.state, two, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, other, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const actions = getSkillRuntime('wuwei-mou-guanping-b79')!.activeActions!(game.state, owner.id)
    expect(actions.some(({ id }) => id === 'wuwei:activate')).toBe(true)
    owner.characterId = 'wu-guanyu-b79'
    const conversions = getSkillRuntime('juewu-wu-guanyu-b79')!.viewAs!(game.state, owner.id)
    expect(conversions.some((entry) => entry.cardId === two && entry.asCardName === '杀')).toBe(true)
    expect(conversions.some((entry) => entry.cardId === other)).toBe(false)
  })

  it('【锐军】从本阶段首次使用牌指定目标后触发，而不是额外主动按钮', () => {
    const game = gameFor('b79-ruijun')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'star-sunjian-b79'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('ruijun-star-sunjian-b79')!
    const trigger = runtime.triggers!.find(({ event }) => event === 'CardUsed')!
    trigger.handle(game as never, owner.id, { event: { name: 'CardUsed', sourceId: owner.id,
      payload: { cardId: game.state.zones.drawPile[0], targetIds: [target.id] } } } as never)
    expect(owner.turnUsedSkills.some((entry) => entry.startsWith('ruijun-star-sunjian-b79@'))).toBe(true)
    expect(game.state.skillQueue.some((entry) => entry.skillId === 'ruijun-star-sunjian-b79' && entry.step === 'offer')).toBe(true)
  })

  it('【武威】真实消耗所选颜色的全部手牌并以不限距离/次数的杀进入正常结算', () => {
    const game = gameFor('b79-wuwei-use')
    const owner = game.state.players[0]!
    owner.characterId = 'mou-guanping-b79'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    game.state.turnUsage.slashUses = 1
    const redCards = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.color === 'red')
    const first = redCards.find((id) => game.state.cards[id]?.category === 'basic')!
    const second = redCards.find((id) => game.state.cards[id]?.category === 'trick')!
    moveCard(game.state, first, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, second, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime('wuwei-mou-guanping-b79')!
    runtime.invokeActive!(game as never, owner.id, 'wuwei:activate')
    const colorRequest = game.state.pendingRequests[0]!
    game.respond({ requestId: colorRequest.id, playerId: owner.id, payload: { optionId: 'red' } })
    const target = game.state.players[3]!
    const targetRequest = game.state.pendingRequests[0]!
    game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } })
    expect(game.state.cardResolution?.kind).toBe('slash')
    expect(game.state.cardResolution?.targetId).toBe(target.id)
    expect(owner.zones.hand).not.toContain(first)
    expect(owner.zones.hand).not.toContain(second)
    expect(game.state.zones.processingArea.some((id) => id === first || id === second)).toBe(true)
    expect(game.state.turnUsage.slashUses).toBe(1)
  })
})
