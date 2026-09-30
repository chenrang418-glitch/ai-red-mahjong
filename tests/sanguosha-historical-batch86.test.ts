import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { getDistance } from '@/sanguosha/engine/distance'
import { ruleCardNumber } from '@/sanguosha/engine/deck'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { allCharacterIds, getCharacter } from '@/sanguosha/data/characters/standard'
import '@/sanguosha/data/characters/historical-batch86'

const xunshi = getSkillRuntime('xunshi-zhangren-b86')!
const shedao = getSkillRuntime('shedao-zhangren-b86')!
const shibian = getSkillRuntime('shibian-wuyi-b86')!
const zhuguo = getSkillRuntime('zhuguo-weifeng-b86')!
const bibu = getSkillRuntime('bibu-wuyi-b86')!
const wangzi = getSkillRuntime('wangzi-houzhaoning-b86')!
const herong = getSkillRuntime('herong-houzhaoning-b86')!
const huozhong = getSkillRuntime('huozhong-weifeng-b86')!
const yuyi = getSkillRuntime('yuyi-wangping-b86')!
const fangong = getSkillRuntime('fangong-wangping-b86')!
const juxi = getSkillRuntime('juxi-gongsunzan-b86')!
const zhutao = getSkillRuntime('zhutao-gongsunzan-b86')!
const xianlue = getSkillRuntime('xianlue-zhangfei-b86')!

function gameForTest(seed: string) {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 6 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  return game
}

describe('第86批武将注册', () => {
  it('十名角色均进入正式选将注册表，且每个登记技能都有实际运行时', () => {
    const ids = ['liu-yijun-b86', 'mou-wuyi-b86', 'xing-zhangsong-b86', 'mou-zhangren-b86',
      'hou-zhaoning-b86', 'wei-gongsunzan-b86', 'weifeng-b86', 'mou-liuzhang-b86', 'wu-zhangfei-b86', 'mou-wangping-b86']
    expect(ids.every((id) => allCharacterIds().includes(id))).toBe(true)
    for (const id of ids) {
      const character = getCharacter(id)!
      expect(character.skills.length).toBeGreaterThan(0)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeTruthy()
    }
  })
})

describe('魏讽【蛀国】牌堆变化入口', () => {
  it('牌堆增加时每回合至多触发三次，并从牌堆底摸两张', () => {
    const game = gameForTest('b86-huozhong-bottom')
    const owner = game.state.players[0]!
    owner.grantedSkills.push(zhuguo.id)
    const pileBefore = [...game.state.zones.drawPile]
    const trigger = zhuguo.triggers!.find((entry) => entry.event === 'CardZoneMoved')!
    for (let index = 0; index < 3; index += 1) {
      trigger.handle(game as never, owner.id as never, { event: { name: 'CardZoneMoved', payload: { fromKind: 'discardPile', toKind: 'drawPile' } } } as never)
      const queued = game.state.skillQueue.at(-1)
      expect(queued?.step).toBe('draw-bottom')
      game.state.pendingRequests = []
      zhuguo.startQueued!(game as never, owner.id as never, queued as never)
      game.state.skillResolution = null
      game.state.pendingRequests = []
    }
    expect(owner.zones.hand).toEqual(pileBefore.slice(-6).reverse())
    const queuedCount = game.state.skillQueue.length
    trigger.handle(game as never, owner.id as never, { event: { name: 'CardZoneMoved', payload: { fromKind: 'discardPile', toKind: 'drawPile' } } } as never)
    expect(game.state.skillQueue.length).toBe(queuedCount)
  })
})

describe('魏讽【惑众】', () => {
  function beginHuoZhong(game: SanguoshaGame, shownCard: string, targetId: string) {
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    owner.attackRangeBonus = 10
    owner.grantedSkills.push(huozhong.id)
    huozhong.invokeActive!(game as never, owner.id as never, `${huozhong.id}:activate`)
    const showRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    huozhong.resume!(game as never, owner.id as never, { kind: 'skill', skillId: huozhong.id, ownerId: owner.id,
      step: 'choose-shown-card', requestId: showRequest.id, data: {}, announced: false },
    { requestId: showRequest.id, playerId: owner.id, payload: { cardIds: [shownCard] } } as never)
    const targetsRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    const candidates = (targetsRequest as { candidateIds: string[] }).candidateIds
    const actualTargetId = candidates.includes(targetId) ? targetId : candidates[0]!
    huozhong.resume!(game as never, owner.id as never, { kind: 'skill', skillId: huozhong.id, ownerId: owner.id,
      step: 'choose-targets', requestId: targetsRequest.id, data: { shownCardId: shownCard }, announced: false },
    { requestId: targetsRequest.id, playerId: owner.id, payload: { targetIds: [actualTargetId] } } as never)
    const queued = game.state.skillQueue.at(-1)!
    huozhong.startQueued!(game as never, owner.id as never, queued as never)
    return { owner, actor: game.state.players.find((entry) => entry.id === actualTargetId)! }
  }

  it('逐人允许被选角色从第三名角色处获得牌，并将最多手牌角色的同类别牌置于牌堆顶', () => {
    const game = gameForTest('b86-huozhong-obtain-and-top')
    const [owner, actor, , leader] = game.state.players
    const shown = game.state.zones.drawPile[0]!
    const obtained = game.state.zones.drawPile[1]!
    const matching = game.state.zones.drawPile.find((id, index) => index > 1 && game.state.cards[id]?.category === game.state.cards[shown]?.category)!
    const nonmatching = game.state.zones.drawPile.find((id, index) => index > 1 && game.state.cards[id]?.category !== game.state.cards[shown]?.category)!
    moveCard(game.state, shown, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, obtained, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, matching, { kind: 'drawPile' }, { kind: 'hand', playerId: leader.id })
    moveCard(game.state, nonmatching, { kind: 'drawPile' }, { kind: 'hand', playerId: leader.id })
    const { owner: skillOwner, actor: selectedActor } = beginHuoZhong(game, shown, actor.id)
    const modeRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    huozhong.resume!(game as never, skillOwner.id as never, { kind: 'skill', skillId: huozhong.id, ownerId: skillOwner.id,
      step: 'choose-mode', requestId: modeRequest.id, data: { flow: { shownCardId: shown, targetIds: [selectedActor.id], index: 0, turnNumber: game.state.turnNumber }, actorId: selectedActor.id }, announced: false },
    { requestId: modeRequest.id, playerId: selectedActor.id, payload: { optionId: 'obtain' } } as never)
    const sourceRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    huozhong.resume!(game as never, skillOwner.id as never, { kind: 'skill', skillId: huozhong.id, ownerId: skillOwner.id,
      step: 'choose-source', requestId: sourceRequest.id, data: { flow: { shownCardId: shown, targetIds: [selectedActor.id], index: 0, turnNumber: game.state.turnNumber }, actorId: selectedActor.id }, announced: false },
    { requestId: sourceRequest.id, playerId: selectedActor.id, payload: { targetIds: [skillOwner.id] } } as never)
    const cardRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    huozhong.resume!(game as never, skillOwner.id as never, { kind: 'skill', skillId: huozhong.id, ownerId: skillOwner.id,
      step: 'choose-obtained-card', requestId: cardRequest.id, data: { flow: { shownCardId: shown, targetIds: [selectedActor.id], index: 0, turnNumber: game.state.turnNumber }, actorId: selectedActor.id, sourceId: skillOwner.id }, announced: false },
    { requestId: cardRequest.id, playerId: selectedActor.id, payload: { cardIds: [obtained] } } as never)
    const finalQueued = game.state.skillQueue.at(-1)!
    huozhong.startQueued!(game as never, skillOwner.id as never, finalQueued as never)
    expect(selectedActor.zones.hand).toContain(obtained)
    expect(skillOwner.zones.hand).not.toContain(obtained)
    expect(game.state.zones.drawPile[0]).toBe(matching)
    expect(leader.zones.hand).toContain(nonmatching)
    expect(leader.zones.hand).not.toContain(matching)
  })

  it('被选角色可以交手牌，发动次数每出牌阶段最多两次', () => {
    const game = gameForTest('b86-huozhong-give-limit')
    const [owner, actor] = game.state.players
    const shown = game.state.zones.drawPile[0]!
    const gift = game.state.zones.drawPile[1]!
    moveCard(game.state, shown, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, gift, { kind: 'drawPile' }, { kind: 'hand', playerId: actor.id })
    const { owner: skillOwner, actor: selectedActor } = beginHuoZhong(game, shown, actor.id)
    const modeRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    const flow = { shownCardId: shown, targetIds: [selectedActor.id], index: 0, turnNumber: game.state.turnNumber }
    huozhong.resume!(game as never, skillOwner.id as never, { kind: 'skill', skillId: huozhong.id, ownerId: skillOwner.id,
      step: 'choose-mode', requestId: modeRequest.id, data: { flow, actorId: selectedActor.id }, announced: false },
    { requestId: modeRequest.id, playerId: selectedActor.id, payload: { optionId: 'give' } } as never)
    const giveRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    huozhong.resume!(game as never, skillOwner.id as never, { kind: 'skill', skillId: huozhong.id, ownerId: skillOwner.id,
      step: 'choose-give-card', requestId: giveRequest.id, data: { flow, actorId: selectedActor.id }, announced: false },
    { requestId: giveRequest.id, playerId: selectedActor.id, payload: { cardIds: [gift] } } as never)
    const finish = game.state.skillQueue.at(-1)!
    huozhong.startQueued!(game as never, skillOwner.id as never, finish as never)
    game.state.skillResolution = null; game.state.pendingRequests = []
    expect(skillOwner.zones.hand).toContain(gift)
    expect(huozhong.activeActions!(game.state, owner.id as never)).toHaveLength(1)
    const thirdPartyCard = game.state.zones.drawPile[0]!
    moveCard(game.state, thirdPartyCard, { kind: 'drawPile' }, { kind: 'hand', playerId: game.state.players[2]!.id })
    const secondShown = skillOwner.zones.hand.find((id) => id !== gift)!
    beginHuoZhong(game, secondShown, actor.id)
    const secondMode = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    huozhong.resume!(game as never, skillOwner.id as never, { kind: 'skill', skillId: huozhong.id, ownerId: skillOwner.id,
      step: 'choose-mode', requestId: secondMode.id, data: { flow, actorId: actor.id }, announced: false },
    { requestId: secondMode.id, playerId: selectedActor.id, payload: { optionId: 'give' } } as never)
    expect(huozhong.activeActions!(game.state, owner.id as never)).toHaveLength(0)
  })
})

describe('谋·王平【诱夷】【返攻】', () => {
  it('两项诱夷在同一回合分别发动时，出杀次数加成按各自的用牌者累积', () => {
    const game = gameForTest('b86-yuyi-multi-actor-slash-bonus')
    const owner = game.state.players[0]!
    const firstActor = game.state.players[1]!
    const secondActor = game.state.players[2]!
    owner.grantedSkills.push(yuyi.id)
    game.state.phase = 'play'
    const trigger = (actor: typeof firstActor, optionId: string) => {
      game.state.currentPlayerId = actor.id
      expect(yuyi.interceptTarget!(game as never, owner.id as never, {
        sourceId: actor.id, targetId: owner.id, cardId: `card:${actor.id}`, cardName: '杀', category: 'basic',
      } as never)).toBe(true)
      const request = game.state.pendingRequests.at(-1)!
      game.state.skillResolution = null
      game.state.pendingRequests = []
      yuyi.resume!(game as never, owner.id as never, { kind: 'skill', skillId: yuyi.id, ownerId: owner.id,
        step: 'choose-effect', requestId: request.id, data: { actorId: actor.id, turnNumber: game.state.turnNumber }, announced: false },
      { requestId: request.id, playerId: owner.id, payload: { optionId } } as never)
      game.state.skillResolution = null
      game.state.pendingRequests = []
    }
    trigger(firstActor, 'discard-draw')
    trigger(secondActor, 'hp-gift')
    expect(yuyi.globalSlashUses!(game.state, owner.id as never, firstActor.id as never)).toBe(0)
    game.state.currentPlayerId = firstActor.id
    expect(yuyi.globalSlashUses!(game.state, owner.id as never, firstActor.id as never)).toBe(1)
    game.state.currentPlayerId = secondActor.id
    expect(yuyi.globalSlashUses!(game.state, owner.id as never, secondActor.id as never)).toBe(1)
  })

  it('目标交互增加当前用牌者本阶段杀次数；弃牌效果即时摸1并于该回合结束摸等量', () => {
    const game = gameForTest('b86-yuyi-discard')
    const owner = game.state.players[0]!
    const actor = game.state.players[1]!
    owner.grantedSkills.push(yuyi.id)
    game.state.currentPlayerId = actor.id
    game.state.phase = 'play'
    const cost = game.state.zones.drawPile[0]!
    moveCard(game.state, cost, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const intercepted = yuyi.interceptTarget!(game as never, owner.id as never, {
      sourceId: actor.id, targetId: owner.id, cardId: 'fixture-card', cardName: '杀', category: 'basic',
    } as never)
    expect(intercepted).toBe(true)
    const choose = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    const before = owner.zones.hand.length
    yuyi.resume!(game as never, owner.id as never, { kind: 'skill', skillId: yuyi.id, ownerId: owner.id,
      step: 'choose-effect', requestId: choose.id, data: { actorId: actor.id, turnNumber: game.state.turnNumber }, announced: false },
    { requestId: choose.id, playerId: owner.id, payload: { optionId: 'discard-draw' } } as never)
    const discardRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    yuyi.resume!(game as never, owner.id as never, { kind: 'skill', skillId: yuyi.id, ownerId: owner.id,
      step: 'discard-for-draw', requestId: discardRequest.id, data: { turnNumber: game.state.turnNumber }, announced: false },
    { requestId: discardRequest.id, playerId: owner.id, payload: { cardIds: [cost] } } as never)
    expect(yuyi.globalSlashUses!(game.state, owner.id as never, actor.id as never)).toBe(1)
    expect(owner.zones.hand).toHaveLength(before)
    const end = yuyi.triggers!.find((entry) => entry.event === 'TurnEnd')!
    end.handle(game as never, owner.id as never, { event: { name: 'TurnEnd', payload: { turnNumber: game.state.turnNumber } } } as never)
    const queued = game.state.skillQueue.at(-1)!
    yuyi.startQueued!(game as never, owner.id as never, queued)
    expect(owner.zones.hand).toHaveLength(before + 1)
  })

  it('诱夷累计失去体力与弃牌每满7重置【返攻】限定技', () => {
    const game = gameForTest('b86-fangong-reset')
    const owner = game.state.players[0]!
    owner.usedLimitedSkills.push(fangong.id)
    ;(game.state as unknown as { paperSanguoB86: { fangongProgress: Record<string, number> } }).paperSanguoB86 = {
      fangongProgress: { [owner.id]: 6 },
    }
    const liveRecipient = game.state.players[1]!
    yuyi.resume!(game as never, owner.id as never, { kind: 'skill', skillId: yuyi.id, ownerId: owner.id,
      step: 'choose-effect', requestId: 'choice', data: { actorId: game.state.players[1]!.id, turnNumber: game.state.turnNumber }, announced: false },
    { requestId: 'choice', playerId: owner.id, payload: { optionId: 'hp-gift' } } as never)
    const targetRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    yuyi.resume!(game as never, owner.id as never, { kind: 'skill', skillId: yuyi.id, ownerId: owner.id,
      step: 'choose-draw-recipient', requestId: targetRequest.id, data: { actorId: game.state.players[1]!.id, turnNumber: game.state.turnNumber }, announced: false },
    { requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [liveRecipient.id] } } as never)
    const numberRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    yuyi.resume!(game as never, owner.id as never, { kind: 'skill', skillId: yuyi.id, ownerId: owner.id,
      step: 'choose-hp-loss', requestId: numberRequest.id, data: { targetId: liveRecipient.id, turnNumber: game.state.turnNumber }, announced: false },
    { requestId: numberRequest.id, playerId: owner.id, payload: { number: 1 } } as never)
    expect(owner.usedLimitedSkills).not.toContain(fangong.id)
  })
})

describe('威·公孙瓒【举袭】【追讨】', () => {
  it('举袭只在没有可使用伤害手牌时显示，选择后走虚拟杀正常结算入口', () => {
    const game = gameForTest('b86-juxi-use')
    const owner = game.state.players[0]!
    owner.grantedSkills.push(juxi.id)
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    for (const id of [...owner.zones.hand]) {
      if (['杀', '火杀', '雷杀', '南蛮入侵', '万箭齐发', '决斗', '火攻'].includes(game.state.cards[id]?.name ?? ''))
        moveCard(game.state, id, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    }
    const actions = juxi.activeActions!(game.state, owner.id as never)
    const action = actions.find((entry) => entry.id === `${juxi.id}:use:${encodeURIComponent('杀')}`)!
    expect(action).toBeDefined()
    juxi.invokeActive!(game as never, owner.id as never, action.id)
    const request = game.state.pendingRequests.at(-1)!
    const resolution = game.state.skillResolution!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    juxi.resume!(game as never, owner.id as never, resolution as never,
    { requestId: request.id, playerId: owner.id, payload: { optionId: '0' } } as never)
    expect(game.state.cardResolution?.kind).toBe('slash')

    const duel = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '决斗')!
    moveCard(game.state, duel, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    expect(juxi.activeActions!(game.state, owner.id as never)).toHaveLength(0)
  })

  it('追讨按黑色牌后紧接伤害牌触发，仅选择一次目标并令距离双向为1', () => {
    const game = gameForTest('b86-zhutao-combo')
    const owner = game.state.players[0]!
    const target = game.state.players[3]!
    owner.grantedSkills.push(zhutao.id)
    game.state.currentPlayerId = owner.id
    const black = game.state.zones.drawPile.find((id) => game.state.cards[id]?.color === 'black')!
    moveCard(game.state, black, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const use = zhutao.triggers!.find((entry) => entry.event === 'CardUsed')!
    use.handle(game as never, owner.id as never, { event: { name: 'CardUsed', sourceId: owner.id,
      payload: { cardId: black, cardName: '过河拆桥' } } } as never)
    use.handle(game as never, owner.id as never, { event: { name: 'CardUsed', sourceId: owner.id,
      payload: { cardId: black, cardName: '决斗' } } } as never)
    const queued = game.state.skillQueue.at(-1)!
    zhutao.startQueued!(game as never, owner.id as never, queued)
    const request = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    const before = owner.zones.hand.length
    zhutao.resume!(game as never, owner.id as never, { kind: 'skill', skillId: zhutao.id, ownerId: owner.id,
      step: 'select-target', requestId: request.id, data: { turnNumber: game.state.turnNumber }, announced: false },
    { requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    expect(owner.zones.hand).toHaveLength(before + 2)
    expect(getDistance(game.state, owner.id as never, target.id as never)).toBe(1)
    expect(getDistance(game.state, target.id as never, owner.id as never)).toBe(1)
    expect((game.state.paperSanguoB86 as { zhutaoTurn: Record<string, { selectedTargets: string[] }> }).zhutaoTurn[owner.id]!.selectedTargets).toContain(target.id)
  })
})

describe('谋·张任【迅矢】', () => {
  it('只令雷【杀】无距离及次数限制', () => {
    const game = gameForTest('b86-xunshi-legality')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const thunderSlash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀' && game.state.cards[id]?.damageNature === 'thunder')!
    const normalSlash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    expect(xunshi.unlimitedCardUses!(game.state, owner.id as never, thunderSlash)).toBe(true)
    expect(xunshi.ignoresDistanceTo!(game.state, owner.id as never, target.id as never, thunderSlash)).toBe(true)
    expect(xunshi.unlimitedCardUses!(game.state, owner.id as never, normalSlash)).toBe(false)
    expect(xunshi.ignoresDistanceTo!(game.state, owner.id as never, target.id as never, normalSlash)).toBe(false)
  })

  it('雷【杀】实际造成伤害后随机弃置受伤角色一张牌并摸两张；伤害被防止时不触发', () => {
    const game = gameForTest('b86-xunshi-damage')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const cards = [...game.state.zones.drawPile]
    moveCard(game.state, cards[0]!, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, cards[1]!, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const trigger = xunshi.triggers!.find((entry) => entry.event === 'DamageSettled')!
    const beforeOwnerHand = owner.zones.hand.length
    trigger.handle(game as never, owner.id as never, { event: { name: 'DamageSettled', sourceId: owner.id, targetId: target.id,
      payload: { cardId: thunderSlashId(game), cardName: '杀', finalAmount: 1 } } } as never)
    expect(target.zones.hand).toHaveLength(1)
    expect(owner.zones.hand).toHaveLength(beforeOwnerHand + 2)

    const untouched = target.zones.hand.length
    const ownerHand = owner.zones.hand.length
    trigger.handle(game as never, owner.id as never, { event: { name: 'DamageSettled', sourceId: owner.id, targetId: target.id,
      payload: { cardId: thunderSlashId(game), cardName: '杀', finalAmount: 0 } } } as never)
    expect(target.zones.hand).toHaveLength(untouched)
    expect(owner.zones.hand).toHaveLength(ownerHand)
  })
})

describe('谋·张任【慑道】', () => {
  it('获得红牌须弃黑牌，且仅这些牌于本回合不计手牌上限', () => {
    const game = gameForTest('b86-shedao-red')
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id
    const red = game.state.zones.drawPile.find((id) => ['heart', 'diamond'].includes(game.state.cards[id]!.suit))!
    const black = game.state.zones.drawPile.find((id) => ['spade', 'club'].includes(game.state.cards[id]!.suit))!
    moveCard(game.state, red, { kind: 'drawPile' }, { kind: 'discardPile' })
    moveCard(game.state, black, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    shedao.startQueued!(game as never, owner.id as never, { skillId: shedao.id, ownerId: owner.id, step: 'offer',
      data: { turnNumber: game.state.turnNumber, cardIds: [red] } } as never)
    const modeRequest = game.state.pendingRequests.at(-1)!
    expect(modeRequest.kind).toBe('choose-option')
    game.state.skillResolution = null
    game.state.pendingRequests = []
    shedao.resume!(game as never, owner.id as never, { kind: 'skill', skillId: shedao.id, ownerId: owner.id,
      step: 'choose-mode', requestId: modeRequest.id, data: { turnNumber: game.state.turnNumber, cardIds: [red] }, announced: false },
    { requestId: modeRequest.id, playerId: owner.id, payload: { optionId: 'red' } } as never)
    const redRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    shedao.resume!(game as never, owner.id as never, { kind: 'skill', skillId: shedao.id, ownerId: owner.id,
      step: 'choose-red', requestId: redRequest!.id, data: { turnNumber: game.state.turnNumber, redIds: [red] }, announced: false },
    { requestId: redRequest!.id, playerId: owner.id, payload: { cardIds: [red] } } as never)
    const costRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    shedao.resume!(game as never, owner.id as never, { kind: 'skill', skillId: shedao.id, ownerId: owner.id,
      step: 'discard-black', requestId: costRequest!.id, data: { turnNumber: game.state.turnNumber, selectedIds: [red] }, announced: false },
    { requestId: costRequest!.id, playerId: owner.id, payload: { cardIds: [black] } } as never)
    expect(owner.zones.hand).toContain(red)
    expect(owner.zones.hand).not.toContain(black)
    expect(shedao.handLimitExempt!(game.state, owner.id as never, red)).toBe(true)
    expect(shedao.handLimitExempt!(game.state, owner.id as never, black)).toBe(false)
    game.state.turnNumber += 1
    expect(shedao.handLimitExempt!(game.state, owner.id as never, red)).toBe(false)
  })

  it('取得的【杀】永久获得雷属性', () => {
    const game = gameForTest('b86-shedao-thunder')
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'discardPile' })
    shedao.startQueued!(game as never, owner.id as never, { skillId: shedao.id, ownerId: owner.id, step: 'offer',
      data: { turnNumber: game.state.turnNumber, cardIds: [slash] } } as never)
    const modeRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    shedao.resume!(game as never, owner.id as never, { kind: 'skill', skillId: shedao.id, ownerId: owner.id,
      step: 'choose-mode', requestId: modeRequest.id, data: { turnNumber: game.state.turnNumber, cardIds: [slash] }, announced: false },
    { requestId: modeRequest.id, playerId: owner.id, payload: { optionId: 'thunder-slash' } } as never)
    const slashRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    shedao.resume!(game as never, owner.id as never, { kind: 'skill', skillId: shedao.id, ownerId: owner.id,
      step: 'choose-slash', requestId: slashRequest!.id, data: { turnNumber: game.state.turnNumber, slashIds: [slash] }, announced: false },
    { requestId: slashRequest!.id, playerId: owner.id, payload: { cardIds: [slash] } } as never)
    expect(owner.zones.hand).toContain(slash)
    expect(game.state.cards[slash]!.damageNature).toBe('thunder')
  })
})

describe('谋·吴懿【识变】', () => {
  it('每轮选择一名标记角色，并将其攻击范围用于距离合法性与额外目标候选', () => {
    const game = gameForTest('b86-shibian-range')
    const [owner, marked, inRange] = game.state.players
    const outside = game.state.players[4]
    expect(owner && marked && inRange && outside).toBeTruthy()
    marked!.attackRangeBonus = 1
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    shibian.startQueued!(game as never, owner!.id as never, { skillId: shibian.id, ownerId: owner!.id,
      step: 'choose-marked', data: { roundNumber: game.state.roundNumber } } as never)
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    game.state.skillResolution = null
    game.state.pendingRequests = []
    shibian.resume!(game as never, owner!.id as never, { kind: 'skill', skillId: shibian.id, ownerId: owner!.id,
      step: 'mark-target', requestId: request.id, data: { roundNumber: game.state.roundNumber }, announced: false },
    { requestId: request.id, playerId: owner!.id, payload: { targetIds: [marked!.id] } } as never)
    expect(shibian.ignoresDistanceTo!(game.state, owner!.id as never, inRange!.id as never)).toBe(true)
    expect(shibian.ignoresDistanceTo!(game.state, owner!.id as never, outside!.id as never)).toBe(false)
    const expansion = shibian.nextCardTargetExpansion!(game.state, owner!.id as never, slash, '杀')
    expect(expansion?.maxAdditionalTargets).toBe(1)
    expect(expansion?.candidateIds).toContain(inRange!.id)
    expect(expansion?.candidateIds).not.toContain(marked!.id)
    game.state.roundNumber += 1
    expect(shibian.ignoresDistanceTo!(game.state, owner!.id as never, inRange!.id as never)).toBe(false)
  })
})

describe('魏讽【蛀国】', () => {
  it('每回合最多触发三次，且每次确实从牌堆底摸两张', () => {
    const game = gameForTest('b86-zhuguo')
    const owner = game.state.players[0]!
    owner.grantedSkills.push(zhuguo.id)
    const initialHand = [...owner.zones.hand]
    const initialBottom = [...game.state.zones.drawPile].slice(-6)
    const trigger = zhuguo.triggers!.find((entry) => entry.event === 'DeckReshuffled')!
    const fire = () => trigger.handle(game as never, owner.id as never,
      { event: { name: 'DeckReshuffled', payload: { count: 1, turnNumber: game.state.turnNumber } } } as never)
    fire()
    expect(owner.zones.hand.slice(initialHand.length)).toEqual(initialBottom.slice(-2).reverse())
    fire()
    fire()
    expect(owner.zones.hand).toHaveLength(6)
    const afterThree = [...owner.zones.hand]
    fire()
    expect(owner.zones.hand).toEqual(afterThree)
  })
})

describe('谋·吴懿【庇部】', () => {
  it('只询问本回合首次成为唯一目标的上家/下家，不影响多目标牌', () => {
    const game = gameForTest('b86-bibu-intercept')
    const owner = game.state.players[0]!
    const neighbor = game.state.players[1]!
    const source = game.state.players[2]!
    const trickId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '过河拆桥')!
    game.state.cardResolution = { kind: 'trick', cardId: trickId, cardName: '过河拆桥', sourceId: source.id,
      targetIds: [neighbor.id], targetIndex: 0 } as never
    const context = { sourceId: source.id, targetId: neighbor.id, cardId: trickId, cardName: '过河拆桥', category: 'trick' }
    expect(bibu.interceptTarget!(game as never, owner.id as never, context as never)).toBe(true)
    expect(game.state.pendingRequests.at(-1)?.kind).toBe('choose-option')

    const another = gameForTest('b86-bibu-multitarget')
    const [o, n, s, extra] = another.state.players
    const aoeId = another.state.zones.drawPile.find((id) => another.state.cards[id]?.name === '万箭齐发')!
    another.state.cardResolution = { kind: 'trick', cardId: aoeId, cardName: '万箭齐发', sourceId: s!.id,
      targetIds: [n!.id, extra!.id], targetIndex: 0 } as never
    expect(bibu.interceptTarget!(another as never, o!.id as never,
      { sourceId: s!.id, targetId: n!.id, cardId: aoeId, cardName: '万箭齐发', category: 'trick' } as never)).toBe(false)
  })

  it('相邻角色每回合首次结算杀/普通锦囊后摸一张，并排队可选复用', () => {
    const game = gameForTest('b86-bibu-reuse')
    const owner = game.state.players[0]!
    const neighbor = game.state.players[1]!
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'discardPile' })
    const trigger = bibu.triggers!.find((entry) => entry.event === 'AfterCardUse')!
    const fire = () => trigger.handle(game as never, owner.id as never, { event: { name: 'AfterCardUse', sourceId: neighbor.id,
      payload: { cardId: slash, cardName: '杀' } } } as never)
    const initial = owner.zones.hand.length
    fire()
    expect(owner.zones.hand).toHaveLength(initial + 1)
    expect(game.state.skillQueue.some((entry) => entry.skillId === bibu.id && entry.step === 'offer-reuse')).toBe(true)
    fire()
    expect(owner.zones.hand).toHaveLength(initial + 1)
  })

  it('发动后摸牌，并把唯一锦囊目标替换为吴懿再恢复结算', () => {
    const game = gameForTest('b86-bibu-redirect')
    const [owner, neighbor, source] = game.state.players
    const trickId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '过河拆桥')!
    const initialHand = owner!.zones.hand.length
    game.state.cardResolution = { kind: 'trick', cardId: trickId, cardName: '过河拆桥', sourceId: source!.id,
      targetIds: [neighbor!.id], targetIndex: 0 } as never
    let resumed = false
    game.resumeCardTarget = () => { resumed = true }
    bibu.resume!(game as never, owner!.id as never, { kind: 'skill', skillId: bibu.id, ownerId: owner!.id,
      step: 'redirect-target', requestId: 'b86-bibu-redirect', data: { turnNumber: game.state.turnNumber,
        cardId: trickId, cardName: '过河拆桥', sourceId: source!.id, targetId: neighbor!.id, category: 'trick' }, announced: false },
    { requestId: 'b86-bibu-redirect', playerId: owner!.id, payload: { optionId: 'yes' } } as never)
    expect(game.state.cardResolution?.kind).toBe('trick')
    expect((game.state.cardResolution as { targetIds: string[] }).targetIds).toEqual([owner!.id])
    expect(owner!.zones.hand).toHaveLength(initialHand + 1)
    expect(resumed).toBe(true)
  })
})

describe('侯昭宁【望资】', () => {
  it('其他角色出牌阶段开始时弃牌换等量黑牌，阶段内使用这些牌后双方摸牌且不可重复计数', () => {
    const game = gameForTest('b86-wangzi')
    const owner = game.state.players[0]!
    const actor = game.state.players[1]!
    game.state.currentPlayerId = actor.id
    game.state.phase = 'play'
    const costs = game.state.zones.drawPile.slice(0, 2)
    for (const id of costs) moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const phaseStart = wangzi.triggers!.find((entry) => entry.event === 'PhaseStart')!
    phaseStart.handle(game as never, owner.id as never, { event: { name: 'PhaseStart', payload: {
      playerId: actor.id, phase: 'play',
    } } } as never)
    const offer = game.state.skillQueue.pop()!
    wangzi.startQueued!(game as never, owner.id as never, offer)
    const offerRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    wangzi.resume!(game as never, owner.id as never, { kind: 'skill', skillId: wangzi.id, ownerId: owner.id,
      step: 'invoke', requestId: offerRequest.id, data: { actorId: actor.id, roundNumber: game.state.roundNumber,
        phaseTurnNumber: game.state.turnNumber, maximum: 2 }, announced: false },
    { requestId: offerRequest.id, playerId: owner.id, payload: { optionId: 'yes' } } as never)
    const chooseCost = game.state.skillQueue.pop()!
    wangzi.startQueued!(game as never, owner.id as never, chooseCost)
    const costRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    wangzi.resume!(game as never, owner.id as never, { kind: 'skill', skillId: wangzi.id, ownerId: owner.id,
      step: 'discard-cost', requestId: costRequest.id, data: { actorId: actor.id, roundNumber: game.state.roundNumber,
        phaseTurnNumber: game.state.turnNumber, maximum: 2 }, announced: false },
    { requestId: costRequest.id, playerId: owner.id, payload: { cardIds: costs } } as never)
    const record = (game.state as unknown as { paperSanguoB86: { wangziGains: Record<string, { cardIds: string[] }> } })
      .paperSanguoB86.wangziGains[owner.id]!
    expect(owner.zones.hand).toHaveLength(0)
    expect(actor.zones.hand).toEqual(record.cardIds)
    expect(record.cardIds).toHaveLength(2)
    expect(record.cardIds.every((id) => ['spade', 'club'].includes(game.state.cards[id]!.suit))).toBe(true)
    const firstUsedCard = record.cardIds[0]!
    const ownerBefore = owner.zones.hand.length, actorBefore = actor.zones.hand.length
    const afterUse = wangzi.triggers!.find((entry) => entry.event === 'AfterCardUse')!
    afterUse.handle(game as never, owner.id as never, { event: { name: 'AfterCardUse', sourceId: actor.id,
      payload: { cardIds: [firstUsedCard] } } } as never)
    expect(owner.zones.hand).toHaveLength(ownerBefore + 1)
    expect(actor.zones.hand).toHaveLength(actorBefore + 1)
    afterUse.handle(game as never, owner.id as never, { event: { name: 'AfterCardUse', sourceId: actor.id,
      payload: { cardIds: [firstUsedCard] } } } as never)
    expect(owner.zones.hand).toHaveLength(ownerBefore + 1)
    expect(actor.zones.hand).toHaveLength(actorBefore + 1)
  })
})

describe('侯昭宁【和戎】', () => {
  it('同类别交换真实手牌，双方各获得装备牌，并自动防止下一次伤害', () => {
    const game = gameForTest('b86-herong-same-type')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const targetCard = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic')!
    const ownCard = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic' && id !== targetCard)!
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, ownCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const action = herong.activeActions!(game.state, owner.id as never)[0]!
    herong.invokeActive!(game as never, owner.id as never, action.id)
    const targetRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    herong.resume!(game as never, owner.id as never, { kind: 'skill', skillId: herong.id, ownerId: owner.id,
      step: 'choose-target', requestId: targetRequest.id, data: {}, announced: false },
    { requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    const revealRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    herong.resume!(game as never, owner.id as never, { kind: 'skill', skillId: herong.id, ownerId: owner.id,
      step: 'choose-revealed-card', requestId: revealRequest.id, data: { targetId: target.id }, announced: false },
    { requestId: revealRequest.id, playerId: owner.id, payload: { cardIds: [`hidden:${target.id}:0`] } } as never)
    const ownRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    herong.resume!(game as never, owner.id as never, { kind: 'skill', skillId: herong.id, ownerId: owner.id,
      step: 'choose-own-card', requestId: ownRequest.id, data: { targetId: target.id, revealedId: targetCard }, announced: false },
    { requestId: ownRequest.id, playerId: owner.id, payload: { cardIds: [ownCard] } } as never)
    expect(owner.zones.hand).toContain(targetCard)
    expect(target.zones.hand).toContain(ownCard)
    expect((game.state as unknown as { paperSanguoB86: { heRongPrevention: Record<string, { pending: boolean }> } })
      .paperSanguoB86.heRongPrevention[owner.id]?.pending).toBe(true)
    expect(herong.incomingDamage!(game.state, owner.id as never, { sourceId: target.id, amount: 1, nature: 'normal',
      cardId: null, cardName: '杀', chainTransfer: false })).toEqual({ amount: 0 })
    expect(herong.incomingDamage!(game.state, owner.id as never, { sourceId: target.id, amount: 1, nature: 'normal',
      cardId: null, cardName: '杀', chainTransfer: false })).toBeNull()
  })

  it('异类别交换后选择弃置目标牌并造成1点真实伤害', () => {
    const game = gameForTest('b86-herong-different-type')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const targetCard = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'trick')!
    const ownCard = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic')!
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, ownCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const action = herong.activeActions!(game.state, owner.id as never)[0]!
    herong.invokeActive!(game as never, owner.id as never, action.id)
    const targetRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    herong.resume!(game as never, owner.id as never, { kind: 'skill', skillId: herong.id, ownerId: owner.id,
      step: 'choose-target', requestId: targetRequest.id, data: {}, announced: false },
    { requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    const revealRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    herong.resume!(game as never, owner.id as never, { kind: 'skill', skillId: herong.id, ownerId: owner.id,
      step: 'choose-revealed-card', requestId: revealRequest.id, data: { targetId: target.id }, announced: false },
    { requestId: revealRequest.id, playerId: owner.id, payload: { cardIds: [`hidden:${target.id}:0`] } } as never)
    const ownRequest = game.state.pendingRequests.at(-1)!
    game.state.skillResolution = null; game.state.pendingRequests = []
    herong.resume!(game as never, owner.id as never, { kind: 'skill', skillId: herong.id, ownerId: owner.id,
      step: 'choose-own-card', requestId: ownRequest.id, data: { targetId: target.id, revealedId: targetCard }, announced: false },
    { requestId: ownRequest.id, playerId: owner.id, payload: { cardIds: [ownCard] } } as never)
    expect(game.state.pendingRequests.at(-1)?.kind).toBe('choose-cards')
    game.state.skillResolution = null; game.state.pendingRequests = []
    herong.resume!(game as never, owner.id as never, { kind: 'skill', skillId: herong.id, ownerId: owner.id,
      step: 'discard-two', requestId: 'b86-herong-discard', data: { targetId: target.id, max: 1 }, announced: false },
    { requestId: 'b86-herong-discard', playerId: owner.id, payload: { cardIds: [`hidden:${target.id}:0`] } } as never)
    expect(target.hp).toBe(3)
    expect(game.state.zones.discardPile).toContain(ownCard)
  })
})

describe('武张飞【显略】', () => {
  it('保留跨回合已记录点数，并在新回合重置目标选择次数', () => {
    const game = gameForTest('b86-xianlue-next-turn')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.grantedSkills.push(xianlue.id)
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const pointCard = game.state.zones.drawPile.find((id) => ruleCardNumber(game.state, id) !== null)!
    moveCard(game.state, pointCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const lost = (game.state as unknown as { paperSanguoB86: { zhangfeiLostThisTurn: Record<string, number> } }).paperSanguoB86
      = { zhangfeiLostThisTurn: { [target.id]: game.state.turnNumber } }
    expect(lost.zhangfeiLostThisTurn[target.id]).toBe(game.state.turnNumber)
    const chooseTarget = () => {
      xianlue.invokeActive!(game as never, owner.id as never, `${xianlue.id}:record`)
      const request = game.state.pendingRequests.at(-1)!
      game.state.skillResolution = null
      game.state.pendingRequests = []
      xianlue.resume!(game as never, owner.id as never, { kind: 'skill', skillId: xianlue.id, ownerId: owner.id,
        step: 'choose-target', requestId: request.id, data: { turnNumber: game.state.turnNumber }, announced: false },
      { requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as never)
      const view = game.state.pendingRequests.at(-1)!
      game.state.skillResolution = null
      game.state.pendingRequests = []
      xianlue.resume!(game as never, owner.id as never, { kind: 'skill', skillId: xianlue.id, ownerId: owner.id,
        step: 'view-hand', requestId: view.id, data: { turnNumber: game.state.turnNumber,
          ranks: [ruleCardNumber(game.state, pointCard)!] }, announced: false },
      { requestId: view.id, playerId: owner.id, payload: { cardIds: [] } } as never)
    }
    expect(xianlue.activeActions!(game.state, owner.id as never)).toHaveLength(1)
    chooseTarget()
    const record = () => (game.state as unknown as { paperSanguoB86: { xianlueRecord: Record<string, { ranks: number[]; targetUses: string[] }> } })
      .paperSanguoB86.xianlueRecord[owner.id]!
    expect(record().targetUses).toContain(target.id)
    const originalRanks = [...record().ranks]
    game.state.turnNumber += 1
    ;(game.state as unknown as { paperSanguoB86: { zhangfeiLostThisTurn: Record<string, number> } }).paperSanguoB86
      .zhangfeiLostThisTurn[target.id] = game.state.turnNumber
    expect(xianlue.activeActions!(game.state, owner.id as never)).toHaveLength(1)
    chooseTarget()
    expect(record().targetUses).toContain(target.id)
    expect(record().ranks).toEqual(originalRanks)
  })
})

function thunderSlashId(game: SanguoshaGame) {
  return game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀' && game.state.cards[id]?.damageNature === 'thunder')!
}
