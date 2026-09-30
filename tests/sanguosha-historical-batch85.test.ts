import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { ruleCardNumber } from '@/sanguosha/engine/deck'
import { delayedTrickHitsForPlayer } from '@/sanguosha/engine/delayed-trick-rules'
import { registerPindianContinuation, type PindianResult } from '@/sanguosha/engine/pindian'
import { pushCardUseTargets } from '@/sanguosha/engine/card-use-targets'
import { getDistance } from '@/sanguosha/engine/distance'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import '@/sanguosha/data/characters/historical-batch85'

const hidden = getSkillRuntime('yinbi-hansong-b85')!
const luyan = getSkillRuntime('luyan-hansong-b85')!
const cuxia = getSkillRuntime('cuxia-xingyanliang-b85')!
const jizhan = getSkillRuntime('jizhan-xingyanliang-b85')!
const gongtu = getSkillRuntime('gongtu-suyue-b85')!
const hangzhu = getSkillRuntime('hangzhu-suyue-b85')!
const zhe = getSkillRuntime('zhe-e-guotiying-b85')!
const kanyu = getSkillRuntime('kanyu-guotiying-b85')!
const jianli = getSkillRuntime('jianli-huanjie-b85')!
const qingzheng = getSkillRuntime('qingzheng-huanjie-b85')!
const zijue = getSkillRuntime('zijue-cuilie-b85')!
const duoyue = getSkillRuntime('duoyue-weicao-b85')!
const junhe = getSkillRuntime('junhe-weicao-b85')!
const xiongwei = getSkillRuntime('xiongwei-weicao-b85')!
const jibian = getSkillRuntime('jibian-mojianggan-b85')!
const mingfang = getSkillRuntime('mingfang-mojianggan-b85')!
const chibi = getSkillRuntime('chibi-cuilie-b85')!
const lingshu = getSkillRuntime('lingshu-chunyukiong-b85')!
const kangkang = getSkillRuntime('kang-kang-chunyukiong-b85')!
const liexiang = getSkillRuntime('liexiang-weiliubei-b85')!
const rengou = getSkillRuntime('rengou-weiliubei-b85')!

describe('第85批角色登记', () => {
  it('十名武将按武将册顺序进入正式角色池，且每项技能都有运行时', () => {
    const expected = ['桓阶', '星·颜良', '崔烈', '苏越', '郭缇萦', '威·曹操', '谋·淳于琼', '谋·蒋干', '威·刘备', '韩嵩']
    const characters = ALL_CHARACTERS.filter((character) => character.id.endsWith('-b85'))
    expect(characters.map((character) => character.name)).toEqual(expected)
    for (const character of characters)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】 runtime`).toBeTruthy()
  })
})

function gameForTest(seed: string) {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 6 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  return game
}

function trigger(runtime: NonNullable<typeof luyan>, game: SanguoshaGame, ownerId: string, phase: string, playerId: string) {
  runtime.triggers!.find((item) => item.event === 'PhaseEnd')!.handle(game as never, ownerId as never, {
    event: { name: 'PhaseEnd', payload: { playerId, phase } },
  } as never)
}

describe('韩嵩【隐避】', () => {
  it('手牌上限不低于自身正常上限，并等于其他角色中最高的上限', () => {
    const game = gameForTest('b85-hansong-limit')
    const [owner, first, second] = game.state.players
    expect(owner && first && second).toBeTruthy()
    for (const player of game.state.players) player.hp = 1
    owner!.hp = 2
    first!.hp = 4
    second!.hp = 3
    expect(hidden.fixedMaxCards!(game.state, owner!.id as never)).toBe(4)
    first!.hp = 1
    second!.hp = 1
    expect(hidden.fixedMaxCards!(game.state, owner!.id as never)).toBe(2)
    expect(maxCardsOf(game.state, owner!.id as never)).toBe(2)
  })

  it('仅当所有其他角色的手牌数都不同时，才同时获得无距离和无次数限制', () => {
    const game = gameForTest('b85-hansong-unlimited')
    const [owner, first, second] = game.state.players
    expect(owner && first && second).toBeTruthy()
    const [a, b] = game.state.zones.drawPile
    moveCard(game.state, a!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    expect(hidden.unlimitedCardUses!(game.state, owner!.id as never)).toBe(true)
    expect(hidden.ignoresDistanceTo!(game.state, owner!.id as never, first!.id as never)).toBe(true)
    moveCard(game.state, b!, { kind: 'drawPile' }, { kind: 'hand', playerId: first!.id })
    expect(hidden.unlimitedCardUses!(game.state, owner!.id as never)).toBe(false)
    expect(hidden.ignoresDistanceTo!(game.state, owner!.id as never, second!.id as never)).toBe(false)
  })
})

describe('韩嵩【率言】', () => {
  it('自己的摸牌/弃牌阶段结束时按当时相同手牌数的角色总数提供可选摸牌', () => {
    const game = gameForTest('b85-hansong-own-phase')
    const owner = game.state.players[0]!
    trigger(luyan, game, owner.id, 'draw', owner.id)
    const request = game.state.pendingRequests.at(-1)
    expect(request?.kind).toBe('choose-option')
    expect(request?.prompt).toContain('摸6张牌')
    luyan.resume!(game as never, owner.id as never, {
      kind: 'skill', skillId: luyan.id, ownerId: owner.id, step: 'choose-own-draw', requestId: request!.id,
      data: { count: 6 }, announced: false,
    }, { requestId: request!.id, playerId: owner.id, payload: { optionId: 'draw' } } as never)
    expect(owner.zones.hand).toHaveLength(6)
  })

  it('其他角色阶段结束时，手牌数相等才询问；手牌变化后拒绝过期效果', () => {
    const game = gameForTest('b85-hansong-other-phase')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    trigger(luyan, game, owner!.id, 'discard', target!.id)
    expect(game.state.pendingRequests.at(-1)?.kind).toBe('choose-option')
    const request = game.state.pendingRequests.at(-1)!
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    const before = owner!.zones.hand.length
    luyan.resume!(game as never, owner!.id as never, {
      kind: 'skill', skillId: luyan.id, ownerId: owner!.id, step: 'choose-effect', requestId: request.id,
      data: { targetId: target!.id }, announced: false,
    }, { requestId: request.id, playerId: owner!.id, payload: { optionId: 'draw' } } as never)
    expect(owner!.zones.hand).toHaveLength(before)
  })

  it('选择弃牌时可弃装备区牌，并通过装备离场公共结算', () => {
    const game = gameForTest('b85-hansong-equipment-discard')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    const equipmentId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')
    expect(equipmentId).toBeDefined()
    moveCard(game.state, equipmentId!, { kind: 'drawPile' }, { kind: 'equipment', playerId: target!.id, slot: 'weapon' })
    trigger(luyan, game, owner!.id, 'discard', target!.id)
    const offer = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: offer.id, playerId: owner!.id, payload: { optionId: 'discard' } })
    const chooseCard = game.state.pendingRequests.at(-1)!
    expect(chooseCard.cardIds).toContain(equipmentId)
    game.respond({ requestId: chooseCard.id, playerId: owner!.id, payload: { cardIds: [equipmentId] } })
    expect(target!.zones.equipment.weapon).toBeNull()
    expect(game.state.zones.discardPile).toContain(equipmentId)
  })
})

describe('星·颜良【促狭】', () => {
  it('体力值更高或本轮伤害过你的角色对你用牌时随机弃其手牌；两项皆满足时再摸牌', () => {
    const game = gameForTest('b85-xingyanliang-cuxia')
    const [owner, source] = game.state.players
    expect(owner && source).toBeTruthy()
    owner!.hp = 2
    source!.hp = 3
    const sourceCard = game.state.zones.drawPile[0]!
    moveCard(game.state, sourceCard, { kind: 'drawPile' }, { kind: 'hand', playerId: source!.id })
    const trigger = (name: string, payload: Record<string, unknown> = {}, sourceId?: string, targetId?: string) =>
      cuxia.triggers!.find((item) => item.event === name)!.handle(game as never, owner!.id as never, {
        event: { name, payload, sourceId: sourceId as never, targetId: targetId as never },
      } as never)
    trigger('DamageSettled', { finalAmount: 1 }, source!.id, owner!.id)
    trigger('CardUsed', { targetIds: [owner!.id] }, source!.id)
    expect(source!.zones.hand).toHaveLength(0)
    expect(game.state.zones.discardPile).toContain(sourceCard)
    expect(owner!.zones.hand).toHaveLength(1)
  })

  it('本轮伤害来源记录在新轮次清零', () => {
    const game = gameForTest('b85-xingyanliang-round')
    const [owner, source] = game.state.players
    expect(owner && source).toBeTruthy()
    owner!.hp = 3
    source!.hp = 3
    const trigger = (name: string, payload: Record<string, unknown> = {}, sourceId?: string, targetId?: string) =>
      cuxia.triggers!.find((item) => item.event === name)!.handle(game as never, owner!.id as never, {
        event: { name, payload, sourceId: sourceId as never, targetId: targetId as never },
      } as never)
    trigger('DamageSettled', { finalAmount: 1 }, source!.id, owner!.id)
    game.state.roundNumber += 1
    const sourceCard = game.state.zones.drawPile[0]!
    moveCard(game.state, sourceCard, { kind: 'drawPile' }, { kind: 'hand', playerId: source!.id })
    trigger('CardUsed', { targetIds: [owner!.id] }, source!.id)
    expect(source!.zones.hand).toHaveLength(1)
    expect(owner!.zones.hand).toHaveLength(0)
  })
})

describe('星·颜良【急战】', () => {
  it('第一张伤害牌只触发一次，按本回合此前使用的非伤害牌数递减加伤', () => {
    const game = gameForTest('b85-xingyanliang-jizhan')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    const cardId = game.state.zones.drawPile[0]!
    const trigger = (payload: Record<string, unknown>) => jizhan.triggers!.find((item) => item.event === 'CardUsed')!
      .handle(game as never, owner!.id as never, { event: { name: 'CardUsed', sourceId: owner!.id, payload } } as never)
    trigger({ cardName: '无中生有', cardId, targetIds: [owner!.id] })
    trigger({ cardName: '杀', cardId, targetIds: [target!.id] })
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    expect(request.prompt).toContain('增加1点')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    expect(jizhan.outgoingDamage!(game.state, owner!.id as never, {
      targetId: target!.id, amount: 1, nature: 'normal', cardId, cardName: '杀', chainTransfer: false,
    })).toEqual({ amount: 2 })
  })

  it('所选目标未因该牌受伤时，由该目标对颜良造成1点伤害', () => {
    const game = gameForTest('b85-xingyanliang-jizhan-recoil')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    const cardId = game.state.zones.drawPile[0]!
    const resolution = {
      kind: 'skill' as const, skillId: jizhan.id, ownerId: owner!.id, step: 'choose-target', requestId: 'jizhan-test',
      data: { cardId, targetIds: [target!.id], bonus: 2 }, announced: false,
    }
    jizhan.resume!(game as never, owner!.id as never, resolution as never,
      { requestId: 'jizhan-test', playerId: owner!.id, payload: { targetIds: [target!.id] } } as never)
    const hp = owner!.hp
    const targetHp = target!.hp
    jizhan.triggers!.find((item) => item.event === 'AfterCardUse')!.handle(game as never, owner!.id as never, {
      event: { name: 'AfterCardUse', sourceId: owner!.id, payload: { cardId, targetIds: [target!.id] } },
    } as never)
    expect(owner!.hp).toBe(hp - 1)
    expect(target!.hp).toBe(targetHp)
  })
})

describe('苏越【宫图】', () => {
  it('仅对全场连续使用且顺序匹配所选类别的两张牌发动，并取得两个不同点数的牌', () => {
    const game = gameForTest('b85-suyue-gongtu')
    const owner = game.state.players[0]!
    ;(game.state as never as { b85?: { gongtu?: Record<string, { categories: ['basic', 'trick']; previousCategory?: 'basic' | 'trick' | 'equipment' }> } })
      .b85 = { gongtu: { [owner.id]: { categories: ['basic', 'trick'] } } }
    const first = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic')!
    const second = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'trick')!
    const trigger = (cardId: string) => gongtu.triggers!.find((item) => item.event === 'CardUsed')!.handle(game as never, owner.id as never, {
      event: { name: 'CardUsed', payload: { cardId }, sourceId: game.state.players[1]!.id },
    } as never)
    trigger(first)
    expect(game.state.pendingRequests).toHaveLength(0)
    trigger(second)
    let request = game.state.pendingRequests.at(-1)!
    expect(request.prompt).toContain('第一张牌的点数')
    const ranks = game.state.zones.drawPile.map((id) => ruleCardNumber(game.state, id)).filter((rank): rank is number => rank !== null)
    const [firstRank, secondRank] = [...new Set(ranks)]
    expect(secondRank).toBeDefined()
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: String(firstRank) } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.prompt).toContain('另一种点数')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: String(secondRank) } })
    expect(owner.zones.hand).toHaveLength(2)
    expect(new Set(owner.zones.hand.map((id) => ruleCardNumber(game.state, id))).size).toBe(2)
  })
})

describe('苏越【夯筑】', () => {
  it('发动时可将手牌置为“基”，并禁止目标使用或打出相同点数的实体牌', () => {
    const game = gameForTest('b85-suyue-hangzhu')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const materialId = game.state.zones.drawPile[0]!
    moveCard(game.state, materialId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    const active = hangzhu.activeActions!(game.state, owner!.id as never)[0]!
    hangzhu.invokeActive!(game as never, owner!.id as never, active.id)
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: [materialId] } })
    expect(owner!.characterPiles[`${hangzhu.id}:${owner!.id}`]).toContain(materialId)
    const targetRequest = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: targetRequest.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    expect(hangzhu.globallyProhibitsCardUse!(game.state, owner!.id as never, target!.id as never, materialId)).toBe(true)
    expect(hangzhu.prohibitsResponseCard!(game.state, owner!.id as never, target!.id as never, materialId, '杀')).toBe(true)
    expect(hangzhu.globallyProhibitsCardUse!(game.state, owner!.id as never, owner!.id as never, materialId)).toBe(false)
  })
})

describe('郭缇萦【谪厄】', () => {
  it('开局把牌堆中的闪电置入判定区，并在后续回合结束时从弃牌堆补入', () => {
    const game = gameForTest('b85-guotiying-zhee')
    const owner = game.state.players[0]!
    const lightningId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '闪电')
    expect(lightningId).toBeDefined()
    zhe.onGameStart!(game as never, owner.id as never)
    expect(owner.zones.judgingArea).toContain(lightningId)
    moveCard(game.state, lightningId!, { kind: 'judgingArea', playerId: owner.id }, { kind: 'discardPile' })
    zhe.triggers!.find((item) => item.event === 'TurnEnd')!.handle(game as never, owner.id as never, {
      event: { name: 'TurnEnd', payload: { playerId: game.state.players[1]!.id } },
    } as never)
    expect(owner.zones.judgingArea).toContain(lightningId)
    expect(game.state.zones.discardPile).not.toContain(lightningId)
  })
})

describe('郭缇萦【堪舆】', () => {
  it('判定开始时可获得顶/底牌之一，并把其余牌按选择顺序放回牌堆顶', () => {
    const game = gameForTest('b85-guotiying-kanyu')
    const owner = game.state.players[0]!
    const gainedCard = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === 'heart')!
    moveCard(game.state, gainedCard, { kind: 'drawPile' }, { kind: 'drawPile' }, { toTop: true })
    const before = [...game.state.zones.drawPile]
    kanyu.triggers!.find((item) => item.event === 'JudgeStart')!.handle(game as never, owner.id as never, {
      event: { name: 'JudgeStart', payload: { playerId: game.state.players[2]!.id } },
    } as never)
    const request = game.state.pendingRequests.at(-1)!
    const exposed = [...request.cardIds]
    expect(exposed).toEqual([before[0], before.at(-1)])
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [gainedCard] } })
    expect(owner.zones.hand).toContain(gainedCard)
    const printedCard = game.state.cards[gainedCard]!
    expect(delayedTrickHitsForPlayer(game.state, owner.id as never, '闪电', printedCard.suit, printedCard.rank)).toBe(true)
    expect(delayedTrickHitsForPlayer(game.state, game.state.players[1]!.id as never, '闪电', printedCard.suit, printedCard.rank)).toBe(false)
    const arrange = game.state.pendingRequests.at(-1)!
    expect(arrange.kind).toBe('arrange-cards')
    game.respond({ requestId: arrange.id, playerId: owner.id, payload: { top: [exposed[1]], bottom: [] } })
    expect(game.state.zones.drawPile[0]).toBe(exposed[1])
  })

  it('受到实际伤害后触发；不获得牌时仍将两张牌依序放回牌堆顶', () => {
    const game = gameForTest('b85-guotiying-kanyu-damage')
    const owner = game.state.players[0]!
    const before = [...game.state.zones.drawPile]
    kanyu.triggers!.find((item) => item.event === 'DamageSettled')!.handle(game as never, owner.id as never, {
      event: { name: 'DamageSettled', payload: { finalAmount: 1 }, targetId: owner.id },
    } as never)
    const request = game.state.pendingRequests.at(-1)!
    const exposed = [...request.cardIds]
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [] } })
    const arrange = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: arrange.id, playerId: owner.id, payload: { top: [...exposed].reverse(), bottom: [] } })
    expect(game.state.zones.drawPile.slice(0, 2)).toEqual([...exposed].reverse())
    expect(owner.zones.hand).toHaveLength(0)
    expect(before.length).toBeGreaterThan(2)
  })
})

describe('桓阶【谏立】', () => {
  it('同一出牌阶段最多发动两次；受令角色放弃使用后承受其造成的1点伤害', () => {
    const game = gameForTest('b85-huanjie-jianli-decline')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const slash = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    jianli.invokeActive!(game as never, owner!.id as never, `${jianli.id}:activate`)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: [slash] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('use-card')
    const hp = owner!.hp
    game.respond({ requestId: request.id, playerId: target!.id, payload: { actionId: 'respond-pass' } })
    expect(owner!.hp).toBe(hp - 1)
  })

  it('受令角色用牌造成伤害时不会受到反噬', () => {
    const game = gameForTest('b85-huanjie-jianli-damage')
    const [owner, target, victim] = game.state.players
    expect(owner && target && victim).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const slash = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    jianli.invokeActive!(game as never, owner!.id as never, `${jianli.id}:activate`)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: [slash] } })
    request = game.state.pendingRequests.at(-1)!
    const actionIds = (request as Extract<typeof request, { kind: 'use-card' }>).actionIds
    const actionId = actionIds.find((id) => id.endsWith(victim!.id))
    expect(actionId).toBeDefined()
    const ownerHp = owner!.hp
    game.respond({ requestId: request.id, playerId: target!.id, payload: { actionId } })
    const dodgeRequest = game.state.pendingRequests.at(-1)!
    expect(dodgeRequest.kind).toBe('respond-card')
    game.respond({ requestId: dodgeRequest.id, playerId: victim!.id, payload: { actionId: 'respond-pass' } })
    expect(victim!.hp).toBe(victim!.maxHp - 1)
    expect(owner!.hp).toBe(ownerHp)
  })
})

describe('桓阶【清政】', () => {
  it('体力/手牌/装备数量变化后按当前X提供选项，并正确摸牌', () => {
    const game = gameForTest('b85-huanjie-qingzheng-draw')
    const owner = game.state.players[0]!
    owner.hp = 1
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    qingzheng.triggers!.find((item) => item.event === 'CardZoneMoved')!.handle(game as never, owner.id as never, {
      event: { name: 'CardZoneMoved', id: 'qz-hand-change', payload: { fromKind: 'drawPile', fromPlayerId: null, toKind: 'hand', toPlayerId: owner.id } },
    } as never)
    const queued = game.state.skillQueue.at(-1)!
    expect(queued.data.count).toBe(2)
    game.state.skillQueue.pop()
    qingzheng.startQueued!(game as never, owner.id as never, queued)
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    const handBefore = owner.zones.hand.length
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'draw' } })
    expect(owner.zones.hand).toHaveLength(handBefore + 2)
  })

  it('X大于2时不记技能次数，并仅令触发时手中的牌无次数限制', () => {
    const game = gameForTest('b85-huanjie-qingzheng-unlimited')
    const owner = game.state.players[0]!
    owner.hp = 1
    const handId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic')!
    const equipmentId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    moveCard(game.state, handId!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, equipmentId!, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot: 'weapon' })
    const queued = { skillId: qingzheng.id, ownerId: owner.id, step: 'offer', data: { count: 3, options: ['draw', 'recover', 'equip'], eventId: 'qz-three' } }
    qingzheng.startQueued!(game as never, owner.id as never, queued as never)
    const request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'draw' } })
    expect(qingzheng.unlimitedCardUses!(game.state, owner.id as never, handId as never)).toBe(true)
    const later = game.state.zones.drawPile.find((id) => id !== handId && id !== equipmentId)!
    expect(qingzheng.unlimitedCardUses!(game.state, owner.id as never, later as never)).toBe(false)
  })
})

describe('崔烈【赀爵】', () => {
  it('声明数字后选择摸牌，距离增量持续至崔烈自己的下回合开始', () => {
    const game = gameForTest('b85-cuilie-draw')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    zijue.invokeActive!(game as never, owner!.id as never, `${zijue.id}:activate`)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: target!.id, payload: { optionId: '3' } })
    request = game.state.pendingRequests.at(-1)!
    const handBefore = owner!.zones.hand.length
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: 'draw' } })
    expect(owner!.zones.hand).toHaveLength(handBefore + 3)
    expect(zijue.distanceModifier!.toOthers!(game.state, owner!.id as never)).toBe(3)
    expect(zijue.distanceModifier!.fromOthers!(game.state, owner!.id as never)).toBe(3)
    zijue.triggers!.find((item) => item.event === 'TurnStart')!.handle(game as never, owner!.id as never, {
      event: { name: 'TurnStart', payload: { playerId: owner!.id } },
    } as never)
    expect(zijue.distanceModifier!.toOthers!(game.state, owner!.id as never)).toBe(0)
  })

  it('交足声明数量时转移手牌并回复1点体力', () => {
    const game = gameForTest('b85-cuilie-give')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    owner!.hp = owner!.maxHp - 1
    const gifts = game.state.zones.drawPile.slice(0, 2)
    for (const cardId of gifts) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    zijue.invokeActive!(game as never, owner!.id as never, `${zijue.id}:activate`)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: target!.id, payload: { optionId: '2' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: 'give' } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: gifts } })
    expect(gifts.every((cardId) => target!.zones.hand.includes(cardId))).toBe(true)
    expect(owner!.hp).toBe(owner!.maxHp)
  })
})

describe('威·曹操【掇月】', () => {
  it('出牌阶段开始时可连续选择多次拼点，回合中的第二次拼点数额按当前次数计', () => {
    const game = gameForTest('b85-weicao-duoyue')
    const [owner, target, nextTarget] = game.state.players
    expect(owner && target && nextTarget).toBeTruthy()
    const ownerCard = game.state.zones.drawPile.find((id) => ruleCardNumber(game.state, id) === 1)!
    const targetCard = game.state.zones.drawPile.find((id) => ruleCardNumber(game.state, id) === 13)!
    const ownerCard2 = game.state.zones.drawPile.find((id) => id !== ownerCard && ruleCardNumber(game.state, id) === 2)!
    const targetCard2 = game.state.zones.drawPile.find((id) => id !== targetCard && ruleCardNumber(game.state, id) === 12)!
    const nextTargetCard = game.state.zones.drawPile.find((id) => id !== ownerCard2 && id !== targetCard2)!
    moveCard(game.state, ownerCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    moveCard(game.state, ownerCard2, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, targetCard2, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    moveCard(game.state, nextTargetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: nextTarget!.id })
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    duoyue.triggers!.find((item) => item.event === 'PhaseStart')!.handle(game as never, owner!.id as never, {
      event: { name: 'PhaseStart', payload: { playerId: owner!.id, phase: 'play' } },
    } as never)
    const queued = game.state.skillQueue.at(-1)!
    duoyue.startQueued!(game as never, owner!.id as never, queued)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    const pindianRequests = game.state.pendingRequests.filter((item) => item.purpose === 'pindian')
    expect(pindianRequests).toHaveLength(2)
    game.respond({ requestId: pindianRequests.find((item) => item.playerId === owner!.id)!.id, playerId: owner!.id, payload: { cardIds: [ownerCard] } })
    game.respond({ requestId: pindianRequests.find((item) => item.playerId === target!.id)!.id, playerId: target!.id, payload: { cardIds: [targetCard] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: 'draw' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    expect(request.prompt).toContain('第2次')
    expect(request.candidateIds).toContain(nextTarget!.id)
  })
})

describe('威·曹操【军合】', () => {
  it('展示同色手牌建立X次标记；符合条件的手牌可弃置以增加伤害', () => {
    const game = gameForTest('b85-weicao-junhe')
    const owner = game.state.players[0]!
    const reds = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.color === 'red').slice(0, 2)
    expect(reds).toHaveLength(2)
    for (const cardId of reds) moveCard(game.state, cardId!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })

    junhe.startQueued!(game as never, owner.id as never, { skillId: junhe.id, ownerId: owner.id, step: 'choose-group', data: {} } as never)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'color:red' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [reds[0]] } })
    expect((game.state as typeof game.state & { b85: { junhe: Record<string, Array<{ remaining: number }>> } }).b85.junhe[owner.id]?.[0]?.remaining).toBe(2)

    expect(junhe.offersDamageModifierAsk!(game as never, owner.id as never, 'source', {
      sourceId: owner.id, targetId: game.state.players[1]!.id, amount: 1, nature: 'normal', cardId: null, cardName: '杀', chainTransfer: false,
    } as never)).toBe(true)
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    expect((request as Extract<typeof request, { kind: 'choose-cards' }>).cardIds).toContain(reds[1])
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [reds[1]] } })
    expect(game.state.zones.discardPile).toContain(reds[1])
  })

  it('受伤后摸两张，且本次实际伤害消耗一次剩余效果', () => {
    const game = gameForTest('b85-weicao-junhe-damaged')
    const owner = game.state.players[0]!
    ;(game.state as typeof game.state & { b85: { junhe: Record<string, Array<{ remaining: number; criterion: 'color'; value: string }>> } }).b85 = {
      junhe: { [owner.id]: [{ remaining: 2, criterion: 'color', value: 'red' }] },
    }
    const before = owner.zones.hand.length
    junhe.triggers!.find((trigger) => trigger.event === 'Damaged')!.handle(game as never, owner.id as never,
      { event: { name: 'Damaged', targetId: owner.id, payload: { amount: 1 } } } as never)
    junhe.triggers!.find((trigger) => trigger.event === 'DamageSettled')!.handle(game as never, owner.id as never,
      { event: { name: 'DamageSettled', sourceId: game.state.players[1]!.id, targetId: owner.id, payload: { finalAmount: 1 } } } as never)
    expect(owner.zones.hand).toHaveLength(before + 2)
    expect((game.state as typeof game.state & { b85: { junhe: Record<string, Array<{ remaining: number }>> } }).b85.junhe[owner.id]?.[0]?.remaining).toBe(1)
  })

  it('【雄威】拼点后获得魏角色的拼点牌，并可转移指定次数的军合效果', () => {
    const game = gameForTest('b85-weicao-xiongwei')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    target!.characterId = 'caocao' as never
    const targetCard = game.state.zones.drawPile[0]!
    const ownerCard = game.state.zones.drawPile[1]!
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'processingArea' })
    moveCard(game.state, ownerCard, { kind: 'drawPile' }, { kind: 'processingArea' })
    game.state.pindianSettlement = { id: 'b85-xiongwei-pindian', cardIds: [targetCard, ownerCard] }
    ;(game.state as typeof game.state & { b85: { junhe: Record<string, Array<{ remaining: number; criterion: 'color'; value: string }>> } }).b85 = {
      junhe: { [owner!.id]: [{ remaining: 3, criterion: 'color', value: 'red' }] },
    }
    junhe.triggers!.find((trigger) => trigger.event === 'PindianEnd')!.handle(game as never, owner!.id as never, {
      event: { name: 'PindianEnd', payload: { initiatorId: owner!.id, opponentId: target!.id, initiatorCardId: ownerCard, opponentCardId: targetCard } },
    } as never)
    expect(owner!.zones.hand).toContain(targetCard)
    const queued = game.state.skillQueue.at(-1)!
    expect(queued.skillId).toBe('xiongwei-weicao-b85')
    xiongwei.startQueued!(game as never, owner!.id as never, queued)
    const request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: '2' } })
    const records = (game.state as typeof game.state & { b85: { junhe: Record<string, Array<{ remaining: number }>> } }).b85.junhe
    expect(records[owner!.id]?.[0]?.remaining).toBe(1)
    expect(records[target!.id]?.[0]?.remaining).toBe(2)
    expect(target!.temporaryGrantedSkills).toContainEqual({ source: junhe.id, skillId: junhe.id })
  })
})

describe('谋·蒋干【急辩】', () => {
  it('拼点选牌前摸牌，并将本次实际摸牌数从点数中扣除', () => {
    const game = gameForTest('b85-mojianggan-jibian')
    const [owner, opponent] = game.state.players
    expect(owner && opponent).toBeTruthy()
    const high = game.state.zones.drawPile.find((id) => game.state.cards[id]?.rank === 10)!
    const nine = game.state.zones.drawPile.find((id) => game.state.cards[id]?.rank === 9)!
    moveCard(game.state, high, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, nine, { kind: 'drawPile' }, { kind: 'hand', playerId: opponent!.id })
    const pindianId = 'b85-mojianggan-jibian-pindian'
    game.state.pindian = {
      id: pindianId, initiatorId: owner!.id, opponentId: opponent!.id, initiatorCardId: null, opponentCardId: null,
      reason: 'test', continuationTag: 'b85-mojianggan-jibian-result', data: {}, requestIds: {},
      selectionState: {}, rankAdjustments: {}, stage: 'selecting',
    }
    let result: PindianResult | undefined
    registerPindianContinuation('b85-mojianggan-jibian-result', (_host, value) => { result = value })
    expect(jibian.offersPindianSelectionAsk!(game as never, owner!.id as never, pindianId)).toBe(true)
    game.state.pindian.selectionState[owner!.id] = 'waiting-skill'
    let request = game.state.pendingRequests.at(-1)!
    const handBefore = owner!.zones.hand.length
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: '2' } })
    expect(owner!.zones.hand).toHaveLength(handBefore + 2)
    expect(game.state.pindian?.rankAdjustments[owner!.id]).toBe(2)
    const [ownerRequest, opponentRequest] = game.state.pendingRequests.filter((item) => item.purpose === 'pindian')
    request = ownerRequest!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: [high] } })
    game.respond({ requestId: opponentRequest!.id, playerId: opponent!.id, payload: { cardIds: [nine] } })
    expect(result?.initiatorRank).toBe(8)
    expect(result?.opponentRank).toBe(9)
    expect(result?.outcome).toBe('opponent-win')
  })
})

describe('谋·蒋干【明访】', () => {
  it('被展示的牌留在目标手牌时使其受到的伤害+1，离手后立即失效', () => {
    const game = gameForTest('b85-mojianggan-mingfang')
    const [owner, target, attacker] = game.state.players
    expect(owner && target && attacker).toBeTruthy()
    const shown = game.state.zones.drawPile[0]!
    moveCard(game.state, shown, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    mingfang.triggers!.find((trigger) => trigger.event === 'TurnStart')!.handle(game as never, owner!.id as never,
      { event: { name: 'TurnStart', payload: { playerId: owner!.id } } } as never)
    mingfang.startQueued!(game as never, owner!.id as never,
      { skillId: mingfang.id, ownerId: owner!.id, step: 'choose-target', data: {} } as never)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: target!.id, payload: { cardIds: [shown] } })

    expect(mingfang.globalIncomingDamage!(game.state, owner!.id as never, target!.id as never,
      { sourceId: attacker!.id, amount: 1, nature: 'normal', cardId: null, cardName: '杀', chainTransfer: false } as never)?.amount).toBe(2)
    moveCard(game.state, shown, { kind: 'hand', playerId: target!.id }, { kind: 'discardPile' })
    mingfang.triggers!.find((trigger) => trigger.event === 'CardZoneMoved')!.handle(game as never, owner!.id as never,
      { event: { name: 'CardZoneMoved', payload: { cardId: shown, fromKind: 'hand', fromPlayerId: target!.id, toKind: 'discardPile', toPlayerId: null } } } as never)
    expect(mingfang.globalIncomingDamage!(game.state, owner!.id as never, target!.id as never,
      { sourceId: attacker!.id, amount: 1, nature: 'normal', cardId: null, cardName: '杀', chainTransfer: false } as never)).toBeNull()
  })
})

describe('崔烈【斥避】', () => {
  it('仅在他人以单一目标牌指定距离大于1的角色时提供拼点交互', () => {
    const game = gameForTest('b85-cuilie-chibi')
    const [source, , , target, owner] = game.state.players
    expect(source && target && owner).toBeTruthy()
    const handCards = game.state.zones.drawPile.slice(0, 2)
    const usedCard = game.state.zones.drawPile[2]!
    moveCard(game.state, handCards[0]!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, handCards[1]!, { kind: 'drawPile' }, { kind: 'hand', playerId: source!.id })
    moveCard(game.state, usedCard, { kind: 'drawPile' }, { kind: 'processingArea' })
    pushCardUseTargets(game.state, { cardId: usedCard, sourceId: source!.id, targetIds: [target!.id] })
    game.state.cardResolution = {
      kind: 'slash', cardId: usedCard, sourceId: source!.id, targetId: target!.id, damageNature: 'normal', damageAmount: 1,
      usageCounted: false, stage: 'awaiting-intercept', interceptsDone: [], extraCardIds: [], remainingTargetIds: [],
    } as never
    expect(getDistance(game.state, source!.id as never, target!.id as never)).toBeGreaterThan(1)
    expect(chibi.interceptBystanderTarget!(game as never, owner!.id as never, {
      sourceId: source!.id, targetId: target!.id, cardId: usedCard, cardName: '杀', category: 'basic',
    })).toBe(true)
    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: 'yes' } })
    const pindianRequests = game.state.pendingRequests.filter((item) => item.purpose === 'pindian')
    expect(pindianRequests).toHaveLength(2)
    expect(game.state.pindian?.initiatorId).toBe(owner!.id)
    expect(game.state.pindian?.opponentId).toBe(source!.id)
  })

  it('目标不满足距离或非唯一目标时不打断原牌结算', () => {
    const game = gameForTest('b85-cuilie-chibi-gates')
    const [source, target, owner] = game.state.players
    expect(source && target && owner).toBeTruthy()
    const [ownerCard, sourceCard, usedCard] = game.state.zones.drawPile
    moveCard(game.state, ownerCard!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, sourceCard!, { kind: 'drawPile' }, { kind: 'hand', playerId: source!.id })
    pushCardUseTargets(game.state, { cardId: usedCard!, sourceId: source!.id, targetIds: [target!.id] })
    game.state.cardResolution = {
      kind: 'slash', cardId: usedCard!, sourceId: source!.id, targetId: target!.id, damageNature: 'normal', damageAmount: 1,
      usageCounted: false, stage: 'awaiting-intercept', interceptsDone: [], extraCardIds: [], remainingTargetIds: [],
    } as never
    expect(chibi.interceptBystanderTarget!(game as never, owner!.id as never, {
      sourceId: source!.id, targetId: target!.id, cardId: usedCard!, cardName: '杀', category: 'basic',
    })).toBe(false)
    const multi = gameForTest('b85-cuilie-chibi-multi')
    const farSource = multi.state.players[0]!
    const farTarget = multi.state.players[3]!
    const farOwner = multi.state.players[4]!
    const farCard = multi.state.zones.drawPile[0]!
    const multiTarget = multi.state.players[2]!
    moveCard(multi.state, multi.state.zones.drawPile[1]!, { kind: 'drawPile' }, { kind: 'hand', playerId: farOwner.id })
    moveCard(multi.state, multi.state.zones.drawPile[2]!, { kind: 'drawPile' }, { kind: 'hand', playerId: farSource.id })
    pushCardUseTargets(multi.state, { cardId: farCard, sourceId: farSource.id, targetIds: [farTarget.id, multiTarget.id] })
    multi.state.cardResolution = {
      kind: 'slash', cardId: farCard, sourceId: farSource.id, targetId: farTarget.id, damageNature: 'normal', damageAmount: 1,
      usageCounted: false, stage: 'awaiting-intercept', interceptsDone: [], extraCardIds: [], remainingTargetIds: [multiTarget.id],
    } as never
    expect(chibi.interceptBystanderTarget!(multi as never, farOwner.id as never, {
      sourceId: farSource.id, targetId: farTarget.id, cardId: farCard, cardName: '杀', category: 'basic',
    })).toBe(false)
  })
})

describe('谋·淳于琼技能引擎', () => {
  it('领戍只在本回合伤害前提供非基本牌转基本牌，首次实际伤害后关闭', () => {
    const game = gameForTest('b85-chunyu-lingshu')
    const owner = game.state.players[0]!
    const trick = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'trick')!
    moveCard(game.state, trick, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    expect(lingshu.viewAs!(game.state, owner.id as never)).toEqual(expect.arrayContaining([
      expect.objectContaining({ cardId: trick, asCardName: '杀' }),
      expect.objectContaining({ cardId: trick, asCardName: '闪' }),
      expect.objectContaining({ cardId: trick, asCardName: '桃' }),
    ]))
    const discarded = game.state.zones.drawPile[0]!
    moveCard(game.state, discarded, { kind: 'drawPile' }, { kind: 'discardPile' })
    lingshu.triggers!.find((entry) => entry.event === 'CardEnteredDiscardByMove')!.handle(game as never, owner.id as never,
      { event: { name: 'CardEnteredDiscardByMove', payload: { cardId: discarded } } } as never)
    const runtime = lingshu.triggers!.find((entry) => entry.event === 'DamageSettled')!
    runtime.handle(game as never, owner.id as never, { event: { name: 'DamageSettled', sourceId: owner.id,
      payload: { finalAmount: 1 } } } as never)
    expect(lingshu.viewAs!(game.state, owner.id as never)).toEqual([])
    expect(game.state.skillQueue.some((prompt) => prompt.skillId === lingshu.id && prompt.step === 'gain-random-discard')).toBe(true)
    const queued = game.state.skillQueue.find((prompt) => prompt.skillId === lingshu.id && prompt.step === 'gain-random-discard')!
    lingshu.startQueued!(game as never, owner.id as never, queued)
    const request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'yes' } })
    expect(owner.zones.hand).toContain(discarded)
    expect(game.state.zones.discardPile).not.toContain(discarded)
  })

  it('顽抗接受濒死介入后回复、摸两张并记录抗数', () => {
    const game = gameForTest('b85-chunyu-kangkang')
    const [owner, source] = game.state.players
    expect(owner && source).toBeTruthy()
    owner!.hp = 0
    game.state.dying = { playerId: owner!.id, sourceId: source!.id, damageNature: 'normal',
      responderOrder: game.state.players.map((player) => player.id), responderIndex: 0, requestId: null }
    expect(kangkang.dyingIntercept!(game as never, owner!.id as never)).toBe('pending')
    const request = game.state.pendingRequests.at(-1)!
    const before = owner!.zones.hand.length
    kangkang.resume!(game as never, owner!.id as never, { kind: 'skill', skillId: kangkang.id, ownerId: owner!.id,
      step: 'dying-offer', requestId: request.id, data: { sourceId: source!.id }, announced: false } as never,
    { requestId: request.id, playerId: owner!.id, payload: { optionId: 'yes' } } as never)
    expect(owner!.hp).toBe(1)
    expect(owner!.zones.hand.length).toBe(before + 2)
    expect((game.state as typeof game.state & { b85: { kangKang: Record<string, { count: number; sourceId: string }> } }).b85.kangKang[owner!.id])
      .toMatchObject({ count: 1, sourceId: source!.id })
    expect(game.state.dying).toBeNull()
  })

  it('顽抗在回合结束时无可用杀便直接阵亡；伤害来源已死则清除抗而不误杀', () => {
    const game = gameForTest('b85-chunyu-kangkang-end')
    const [owner, source, other] = game.state.players
    expect(owner && source && other).toBeTruthy()
    for (const player of game.state.players) player.characterId = null
    ;(game.state as typeof game.state & { b85: { kangKang: Record<string, { turnNumber: number; sourceId: string | null; count: number }> } }).b85 = {
      kangKang: { [owner!.id]: { turnNumber: game.state.turnNumber, sourceId: source!.id, count: 1 } },
    }
    kangkang.triggers!.find((entry) => entry.event === 'TurnEnd')!.handle(game as never, owner!.id as never,
      { event: { name: 'TurnEnd', payload: { playerId: owner!.id, turnNumber: game.state.turnNumber } } } as never)
    expect(owner!.alive).toBe(false)

    const second = gameForTest('b85-chunyu-kangkang-source-dead')
    const [survivor, deadSource] = second.state.players
    expect(survivor && deadSource).toBeTruthy()
    for (const player of second.state.players) player.characterId = null
    deadSource!.alive = false
    ;(second.state as typeof second.state & { b85: { kangKang: Record<string, { turnNumber: number; sourceId: string | null; count: number }> } }).b85 = {
      kangKang: { [survivor!.id]: { turnNumber: second.state.turnNumber, sourceId: deadSource!.id, count: 2 } },
    }
    kangkang.triggers!.find((entry) => entry.event === 'TurnEnd')!.handle(second as never, survivor!.id as never,
      { event: { name: 'TurnEnd', payload: { playerId: survivor!.id, turnNumber: second.state.turnNumber } } } as never)
    expect(survivor!.alive).toBe(true)
    expect((second.state as typeof second.state & { b85: { kangKang: Record<string, unknown> } }).b85.kangKang[survivor!.id]).toBeUndefined()
  })
})

describe('威·刘备【烈骧】【仁彀】运行入口', () => {
  it('烈骧在出牌阶段提供主动动作，且按本阶段用量限制动作数', () => {
    const game = gameForTest('b85-weiliubei-liexiang-actions')
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    expect(liexiang.activeActions!(game.state, owner.id as never)).toHaveLength(1)
    const action = liexiang.activeActions!(game.state, owner.id as never)[0]!
    liexiang.invokeActive!(game as never, owner.id as never, action.id)
    expect(game.state.pendingRequests.at(-1)?.kind).toBe('choose-targets')
  })

  it('摸牌数X驱动大于分支的出杀次数加成，且结算后可选交牌', () => {
    const game = gameForTest('b85-weiliubei-liexiang-high')
    const [owner, target, recipient] = game.state.players
    expect(owner && target && recipient).toBeTruthy()
    for (const player of game.state.players) player.characterId = null
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    for (const cardId of game.state.zones.drawPile.slice(0, 2))
      moveCard(game.state, cardId!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    for (const cardId of [...target!.zones.hand])
      moveCard(game.state, cardId, { kind: 'hand', playerId: target!.id }, { kind: 'discardPile' })
    liexiang.invokeActive!(game as never, owner!.id as never, `${liexiang.id}:activate`)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: '1' } })
    liexiang.triggers!.find((item) => item.event === 'DamageSequenceResolved')!.handle(game as never, owner!.id as never,
      { event: { name: 'DamageSequenceResolved', payload: { sourceSkillId: liexiang.id } } } as never)
    expect(target!.hp).toBeLessThan(target!.maxHp)
    expect(liexiang.globalSlashUses!(game.state, owner!.id as never, owner!.id as never)).toBe(1)
    expect(game.state.pendingRequests.at(-1)?.prompt).toContain('交给一名其他角色')
  })

  it('相同手牌数时取得目标牌，并在其下回合按使用顺序无效前X张牌', () => {
    const game = gameForTest('b85-weiliubei-liexiang-equal')
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    for (const player of game.state.players) player.characterId = null
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    for (const cardId of [...owner!.zones.hand])
      moveCard(game.state, cardId, { kind: 'hand', playerId: owner!.id }, { kind: 'discardPile' })
    for (const cardId of [...target!.zones.hand])
      moveCard(game.state, cardId, { kind: 'hand', playerId: target!.id }, { kind: 'discardPile' })
    const targetCardInHand = game.state.zones.drawPile[0]!
    moveCard(game.state, targetCardInHand, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    liexiang.invokeActive!(game as never, owner!.id as never, `${liexiang.id}:activate`)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: '1' } })
    expect(owner!.zones.hand).toHaveLength(1)
    expect(target!.zones.hand).toHaveLength(1)
    expect((game.state as typeof game.state & { b85: { liexiangFlows: Record<string, unknown> } }).b85.liexiangFlows[owner!.id]).toBeTruthy()
    liexiang.triggers!.find((item) => item.event === 'DamageSequenceResolved')!.handle(game as never, owner!.id as never,
      { event: { name: 'DamageSequenceResolved', payload: { sourceSkillId: liexiang.id } } } as never)
    expect((game.state as typeof game.state & { b85: { liexiangLocks?: Record<string, { remaining: number }> } }).b85.liexiangLocks?.[target!.id])
      .toMatchObject({ remaining: 1 })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    if (request.kind !== 'choose-cards') throw new Error('expected a private card-selection request')
    const targetCard = target!.zones.hand[0]!
    const selected = request.hiddenCardSlots[0]!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: [selected] } })
    expect(owner!.zones.hand).toContain(targetCard)
    const turnStart = liexiang.triggers!.find((item) => item.event === 'TurnStart')!
    game.state.turnNumber += 1
    turnStart.handle(game as never, owner!.id as never, { event: { name: 'TurnStart', payload: { playerId: target!.id } } } as never)
    let cancelled = false
    liexiang.triggers!.find((item) => item.event === 'BeforeCardUse')!.handle(game as never, owner!.id as never, {
      event: { name: 'BeforeCardUse', sourceId: target!.id, payload: { cardName: '桃' } },
      cancel() { cancelled = true },
    } as never)
    expect(cancelled).toBe(true)
    expect((game.state as typeof game.state & { b85: { liexiangLocks?: Record<string, unknown> } }).b85.liexiangLocks?.[target!.id]).toBeUndefined()
  })

  it('小于分支失去X点体力、伤害所选额外角色，并解锁本阶段第二次发动', () => {
    const game = gameForTest('b85-weiliubei-liexiang-low')
    const [owner, target, extraTarget] = game.state.players
    expect(owner && target && extraTarget).toBeTruthy()
    for (const player of game.state.players) player.characterId = null
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    for (const player of [owner!, target!, extraTarget!])
      for (const cardId of [...player.zones.hand]) moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
    for (const cardId of game.state.zones.drawPile.slice(0, 3))
      moveCard(game.state, cardId!, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    liexiang.invokeActive!(game as never, owner!.id as never, `${liexiang.id}:activate`)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: '1' } })
    expect(owner!.zones.hand).toHaveLength(1)
    expect(target!.zones.hand).toHaveLength(3)
    liexiang.triggers!.find((item) => item.event === 'DamageSequenceResolved')!.handle(game as never, owner!.id as never,
      { event: { name: 'DamageSequenceResolved', payload: { sourceSkillId: liexiang.id } } } as never)
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    const ownerHp = owner!.hp
    const targetHp = extraTarget!.hp
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [extraTarget!.id] } })
    expect(owner!.hp).toBe(ownerHp - 1)
    expect(extraTarget!.hp).toBe(targetHp - 1)
    expect(liexiang.activeActions!(game.state, owner!.id as never)).toHaveLength(1)
  })

  it('仁彀作为蜀势力角色的出牌阶段授权动作，弃牌后回复并由威·刘备决定是否授权烈骧', () => {
    const game = gameForTest('b85-weiliubei-rengou')
    const [owner, actor] = game.state.players
    expect(owner && actor).toBeTruthy()
    owner!.hp = owner!.maxHp - 1
    actor!.characterId = 'liubei' as never
    game.state.currentPlayerId = actor!.id
    game.state.phase = 'play'
    const cost = game.state.zones.drawPile[0]!
    moveCard(game.state, cost, { kind: 'drawPile' }, { kind: 'hand', playerId: actor!.id })
    const actions = rengou.grantsPlayActions!(game.state, owner!.id as never, actor!.id as never)
    expect(actions).toHaveLength(1)
    rengou.invokeGrantedAction!(game as never, owner!.id as never, actor!.id as never, actions[0]!.id)
    const request = game.state.pendingRequests.at(-1)!
    expect(request.playerId).toBe(actor!.id)
    game.respond({ requestId: request.id, playerId: actor!.id, payload: { cardIds: [cost] } })
    expect(owner!.hp).toBe(owner!.maxHp)
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(owner!.id)
    expect(game.state.pendingRequests.at(-1)?.prompt).toContain('至多摸两张牌')
  })
})
