import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '../src/sanguosha/engine/game'
import type { SanguoshaState } from '../src/sanguosha/engine/types'
import { getSkillRuntime } from '../src/sanguosha/engine/skills/runtime'
import { CHUANXIE_MAJUN_CHUANXIE, LE_DIAOCHAN_DIYOU, LE_DIAOCHAN_TANBAN, MOU_GUOJIA_LUNSHI, MOU_GUOJIA_XIANMOU, PANGFENGYI_PEINIANG, PANGFENGYI_YITONG, QIQIAO_MAJUN_QIQIAO, QIQIAO_MAJUN_YANXIE, QIQIAO_MAJUN_YULIAO, WU_HUANGFUSONG_CHAOZHEN, WU_HUANGFUSONG_JIANGXIAN, WU_HUANGFUSONG_LIANJIE, XING_XUNYU_ANSHU, XING_XUNYU_CHENGFENG, XING_XUNYU_KUANGZUO, XING_XUNYU_TONGYIN, YUANYIN_MOSHOU, ZHUGEJING_BIJIAN, ZHUGEJING_YANZUO, ZHUGEJING_ZUYIN } from '../src/sanguosha/data/characters/historical-batch90'
import { moveCard } from '../src/sanguosha/engine/zones'
import { getCharacter } from '../src/sanguosha/data/characters/standard'

describe('第90批武将定向规则', () => {
  it('十名武将均进入正式注册表且技能完整登记', () => {
    const characters = [
      'wenyuan-b90', 'zhugejing-b90', 'mou-guojia-b90', 'xing-xunyu-b90', 'qiqiao-majun-b90',
      'chuanxie-majun-b90', 'le-diaochan-b90', 'yuanyin-b90', 'wu-huangfusong-b90', 'pang-fengyi-b90',
    ].map((id) => getCharacter(id))

    expect(characters.every(Boolean)).toBe(true)
    expect(new Set(characters.map((character) => character!.id)).size).toBe(10)
    expect(characters.every((character) => character!.skills.length > 0)).toBe(true)
  })

  it('诸葛京【祖荫】同名牌再次出现时仅取消对自己的目标并弃置堆中同名牌', () => {
    const state = {
      turnNumber: 1,
      cardAliases: {},
      cardNatures: {},
      equipmentTransformations: {},
      cards: {
        storedSlashA: { id: 'storedSlashA', name: '杀', suit: 'spade', rank: 7, color: 'black', category: 'basic' },
        storedSlashB: { id: 'storedSlashB', name: '杀', suit: 'heart', rank: 8, color: 'red', category: 'basic' },
        storedDodge: { id: 'storedDodge', name: '闪', suit: 'club', rank: 2, color: 'black', category: 'basic' },
        playedSlash: { id: 'playedSlash', name: '杀', suit: 'diamond', rank: 9, color: 'red', category: 'basic' },
      },
      players: [{ id: 'zhugejing', alive: true, characterPiles: { yanzuo: ['storedSlashA', 'storedSlashB', 'storedDodge'] }, zones: { hand: [], equipment: {}, judgingArea: [] } }],
      zones: { drawPile: [], discardPile: [], processingArea: [] },
      cardResolution: { kind: 'slash', targetId: 'zhugejing', targetCancelled: false },
    } as unknown as SanguoshaState
    const runtime = getSkillRuntime(ZHUGEJING_ZUYIN)
    expect(runtime?.interceptTarget).toBeDefined()

    const suspended = runtime!.interceptTarget!({ state } as never, 'zhugejing', {
      sourceId: 'attacker', targetId: 'zhugejing', cardId: 'playedSlash', cardName: '杀', category: 'basic',
    })

    expect(suspended).toBe(false)
    expect((state.cardResolution as { targetCancelled: boolean }).targetCancelled).toBe(true)
    expect(state.players[0]!.characterPiles.yanzuo).toEqual(['storedDodge'])
    expect(state.zones.discardPile).toEqual(['storedSlashA', 'storedSlashB'])
  })

  it('诸葛京【祖荫】同名牌判定只针对杀与普通锦囊', () => {
    const runtime = getSkillRuntime(ZHUGEJING_ZUYIN)
    const host = { state: { players: [], cards: {}, zones: { drawPile: [], discardPile: [], processingArea: [] } } } as never
    expect(runtime?.cancelsBecomingTarget!(host, 'zhugejing', {
      sourceId: 'attacker', targetId: 'zhugejing', cardId: 'x', cardName: '闪', category: 'basic',
    })).toBe(false)
  })

  it('诸葛京【祖荫】无同名牌时增加研作次数并优先从弃牌堆置入同名牌', () => {
    const state = {
      turnNumber: 1,
      cardAliases: {},
      cardNatures: {},
      equipmentTransformations: {},
      cards: {
        storedDodge: { id: 'storedDodge', name: '闪', suit: 'club', rank: 2, color: 'black', category: 'basic' },
        discardDuel: { id: 'discardDuel', name: '决斗', suit: 'spade', rank: 1, color: 'black', category: 'trick' },
        deckDuel: { id: 'deckDuel', name: '决斗', suit: 'heart', rank: 1, color: 'red', category: 'trick' },
        playedDuel: { id: 'playedDuel', name: '决斗', suit: 'diamond', rank: 2, color: 'red', category: 'trick' },
      },
      players: [{ id: 'zhugejing', alive: true, characterPiles: { yanzuo: ['storedDodge'] }, zones: { hand: [], equipment: {}, judgingArea: [] } }],
      zones: { drawPile: ['deckDuel'], discardPile: ['discardDuel'], processingArea: [] },
    } as unknown as SanguoshaState
    const runtime = getSkillRuntime(ZHUGEJING_ZUYIN)!

    expect(runtime.cancelsBecomingTarget!({ state } as never, 'zhugejing', {
      sourceId: 'attacker', targetId: 'zhugejing', cardId: 'playedDuel', cardName: '决斗', category: 'trick',
    })).toBe(false)
    expect(state.players[0]!.characterPiles.yanzuo).toEqual(['storedDodge', 'discardDuel'])
    expect(state.zones.discardPile).toEqual([])
    expect((state as unknown as { paperSanguoshaB90: { zhugejing: Record<string, { maxUses: number }> } })
      .paperSanguoshaB90.zhugejing.zhugejing!.maxUses).toBe(2)
  })

  it('诸葛京【辟剑】仅在结束阶段且堆牌达到存活人数时排入强制选择', () => {
    const runtime = getSkillRuntime(ZHUGEJING_BIJIAN)!
    const trigger = runtime.triggers?.find((entry) => entry.event === 'PhaseStart')!
    const queued: unknown[] = []
    const host = {
      state: { players: [
        { id: 'zhugejing', alive: true, characterPiles: { yanzuo: ['one', 'two'] } },
        { id: 'other', alive: true, characterPiles: {} },
      ] },
      queueSkill: (prompt: unknown) => queued.push(prompt),
    }
    trigger.handle(host as never, 'zhugejing', { event: { payload: { playerId: 'zhugejing', phase: 'finish' } } } as never)
    expect(queued).toHaveLength(1)

    trigger.handle(host as never, 'zhugejing', { event: { payload: { playerId: 'zhugejing', phase: 'play' } } } as never)
    expect(queued).toHaveLength(1)
  })

  it('庞凤衣【醅酿】濒死救援只列出异瞳所选花色的实体手牌', () => {
    const state = {
      cards: {
        spadeCard: { id: 'spadeCard', name: '杀', suit: 'spade', rank: 4, color: 'black', category: 'basic' },
        heartCard: { id: 'heartCard', name: '闪', suit: 'heart', rank: 5, color: 'red', category: 'basic' },
      },
      players: [
        { id: 'pangfengyi', alive: true, zones: { hand: ['spadeCard', 'heartCard'] } },
        { id: 'dying', alive: true, zones: { hand: [] } },
      ],
      paperSanguoshaB90: { pangfengyi: { pangfengyi: { suit: 'spade', turn: 1 } } },
    } as unknown as SanguoshaState
    const actions = getSkillRuntime(PANGFENGYI_PEINIANG)!.rescueActions!(state, 'pangfengyi', 'dying')
    expect(actions.map((action) => action.id)).toEqual(['peiniang-rescue:spadeCard'])
  })

  it('庞凤衣【醅酿】救援响应消耗所选花色牌并回复濒死角色', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-peiniang-rescue',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const card = Object.values(game.state.cards).find((candidate) => candidate.suit === 'spade' && candidate.name !== '酒')!
    moveCard(game.state, card.id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    target.hp = 0
    game.state.dying = { playerId: target.id, sourceId: owner.id, responderOrder: [owner.id], responderIndex: 0, requestId: null } as never
    ;(game.state as unknown as { paperSanguoshaB90: { pangfengyi: Record<string, { suit: string; turn: number }> } }).paperSanguoshaB90 = {
      pangfengyi: { [owner.id]: { suit: 'spade', turn: game.state.turnNumber } },
    }
    const runtime = getSkillRuntime(PANGFENGYI_PEINIANG)!

    expect(runtime.invokeRescueAction!(game as never, owner.id, `peiniang-rescue:${card.id}`, target.id)).toBe(true)
    expect(game.state.players[1]!.hp).toBe(1)
    expect(game.state.zones.discardPile).toContain(card.id)
    expect(game.state.turnUsage.wineUses).toBe(1)
  })

  it('袁胤【墨守】成为自己使用的黑色牌目标时也可触发', () => {
    const runtime = getSkillRuntime(YUANYIN_MOSHOU)!
    const trigger = runtime.triggers?.find((entry) => entry.event === 'TargetConfirmed')!
    const queued: unknown[] = []
    const host = {
      state: {
        cards: { blackCard: { id: 'blackCard', name: '铁索连环', color: 'black' } },
        players: [{ id: 'yuanyin', alive: true }],
      },
      queueSkill: (prompt: unknown) => queued.push(prompt),
    }
    trigger.handle(host as never, 'yuanyin', { event: {
      name: 'TargetConfirmed', sourceId: 'yuanyin', targetId: 'yuanyin', payload: { cardId: 'blackCard' },
    } } as never)
    expect(queued).toHaveLength(1)
  })

  it('传械马钧【传械】记录花色前进两格，获得牌取前进一格花色', () => {
    const state = {
      turnNumber: 1,
      roundNumber: 1,
      cardAliases: {},
      cardNatures: {},
      equipmentTransformations: {},
      cardColorOverrides: {},
      cards: {
        triggerCard: { id: 'triggerCard', name: '杀', suit: 'spade', rank: 1, color: 'black', category: 'basic' },
        gainedCard: { id: 'gainedCard', name: '闪', suit: 'heart', rank: 2, color: 'red', category: 'basic' },
      },
      players: [{ id: 'majun', alive: true, zones: { hand: [], equipment: {}, judgingArea: [] }, characterPiles: {} }],
      zones: { drawPile: ['gainedCard'], discardPile: [], processingArea: [] },
      paperSanguoshaB90: { chuanshe: { majun: { suit: 'spade' } } },
    } as unknown as SanguoshaState
    const trigger = getSkillRuntime(CHUANXIE_MAJUN_CHUANXIE)!.triggers!.find((entry) => entry.event === 'CardUsed')!
    trigger.handle({ state, rng: { pick: (items: string[]) => items[0] }, dispatch: () => undefined } as never,
      'majun', { event: { payload: { cardId: 'triggerCard' } } } as never)

    expect((state as unknown as { paperSanguoshaB90: { chuanshe: Record<string, { suit: string }> } })
      .paperSanguoshaB90.chuanshe.majun!.suit).toBe('club')
    expect(state.players[0]!.zones.hand).toEqual(['gainedCard'])
    expect(state.zones.drawPile).toEqual([])
  })

  it('庞凤衣【异瞳】不把判定区离场误认成使用牌进入弃牌堆', () => {
    const state = {
      cards: { usedDelayed: { id: 'usedDelayed', name: '乐不思蜀', suit: 'spade', color: 'black', category: 'trick' } },
      players: [{ id: 'pangfengyi', alive: true, zones: { hand: [], equipment: {}, judgingArea: [] } }],
      zones: { drawPile: [], discardPile: ['usedDelayed'], processingArea: [] },
      paperSanguoshaB90: {
        pangfengyi: { pangfengyi: { suit: 'spade', turn: 1, used: false } },
        pangfengyiUsedCards: { pangfengyi: ['usedDelayed'] },
      },
    } as unknown as SanguoshaState
    const trigger = getSkillRuntime(PANGFENGYI_YITONG)!.triggers!.find((entry) => entry.event === 'CardEnteredDiscardByMove')!
    trigger.handle({ state } as never, 'pangfengyi', { event: { payload: { cardId: 'usedDelayed', fromKind: 'judgingArea' } } } as never)
    expect((state as unknown as { paperSanguoshaB90: { pangfengyi: Record<string, { used?: boolean }> } })
      .paperSanguoshaB90.pangfengyi.pangfengyi!.used).toBe(false)
  })

  it('奇巧马钧【余料】把同一弃置批次的可选牌合并为一次阶段发动', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-yuliao-batch',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    game.state.phase = 'discard'
    game.state.status = 'playing'
    const discarded = Object.values(game.state.cards).slice(0, 2)
    for (const card of discarded) moveCard(game.state, card.id, { kind: 'drawPile' }, { kind: 'discardPile' }, { discardReason: 'discard' })
    const trigger = getSkillRuntime(QIQIAO_MAJUN_YULIAO)!.triggers!.find((entry) => entry.event === 'CardEnteredDiscardByMove')!
    for (const card of discarded) trigger.handle(game as never, owner.id, { event: { payload: { cardId: card.id, reason: 'discard' } } } as never)
    expect(game.state.skillQueue.filter((prompt) => prompt.skillId === QIQIAO_MAJUN_YULIAO)).toHaveLength(1)
    expect((game.state as unknown as { paperSanguoshaB90: { qiqiaoYuliao: Record<string, { pendingCardIds: string[] }> } })
      .paperSanguoshaB90.qiqiaoYuliao[owner.id]!.pendingCardIds).toEqual(discarded.map((card) => card.id))
  })

  it('奇巧马钧【余料】濒死发动会重铸全部“材”并继续濒死流程', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-yuliao-recast',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    owner.hp = 1
    game.state.status = 'playing'
    const materials = Object.values(game.state.cards).slice(0, 2)
    for (const card of materials)
      moveCard(game.state, card.id, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: 'cai' })
    game.state.dying = { playerId: owner.id, sourceId: null, responderOrder: [owner.id], responderIndex: 0, requestId: null } as never
    const runtime = getSkillRuntime(QIQIAO_MAJUN_YULIAO)!
    expect(runtime.dyingIntercept!(game as never, owner.id)).toBe('pending')
    runtime.resume!(game as never, owner.id, { step: 'recast', data: { cardIds: materials.map((card) => card.id) } } as never,
      { payload: { optionId: 'yes' } } as never)

    expect(materials.every((card) => game.state.zones.discardPile.includes(card.id))).toBe(true)
    expect(owner.zones.hand).toHaveLength(2)
    expect(game.state.dying).toBeNull()
  })

  it('奇巧马钧【研械】完整选择同类别“材”重铸并从牌堆获得装备牌', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-yanxie',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    owner.characterId = 'qiqiao-majun-b90'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    game.state.status = 'playing'
    const materials = Object.values(game.state.cards).filter((card) => card.category === 'basic').slice(0, 2)
    const equipment = Object.values(game.state.cards).find((card) => card.category === 'equipment' && game.state.zones.drawPile.includes(card.id))!
    for (const card of materials)
      moveCard(game.state, card.id, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: 'cai' })
    const runtime = getSkillRuntime(QIQIAO_MAJUN_YANXIE)!

    expect(runtime.activeActions!(game.state, owner.id)).toEqual([{ id: QIQIAO_MAJUN_YANXIE, label: '研械：重铸两张同类别“材”' }])
    runtime.invokeActive!(game as never, owner.id, QIQIAO_MAJUN_YANXIE)
    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: 'basic' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: materials.map((card) => card.id) } })

    expect(materials.every((card) => game.state.zones.discardPile.includes(card.id))).toBe(true)
    expect(owner.zones.hand).toContain(equipment.id)
    expect(game.state.zones.drawPile).not.toContain(equipment.id)
  })

  it('奇巧马钧【奇巧】把两种材效果附着到装备，离开装备区后清除', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-qiqiao',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'qiqiao-majun-b90'
    owner.grantedSkills.push(QIQIAO_MAJUN_QIQIAO)
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    game.state.status = 'playing'
    const basic = Object.values(game.state.cards).find((card) => card.category === 'basic' && game.state.zones.drawPile.includes(card.id))!
    const trick = Object.values(game.state.cards).find((card) => card.category === 'trick' && game.state.zones.drawPile.includes(card.id))!
    const equipment = Object.values(game.state.cards).find((card) => card.category === 'equipment' && card.equipmentSlot
      && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, basic.id, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: 'cai' })
    moveCard(game.state, trick.id, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: 'cai' })
    moveCard(game.state, equipment.id, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot: equipment.equipmentSlot! })
    const runtime = getSkillRuntime(QIQIAO_MAJUN_QIQIAO)!

    runtime.invokeActive!(game as never, owner.id, QIQIAO_MAJUN_QIQIAO)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [basic.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [trick.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [equipment.id] } })

    expect(owner.characterPiles.cai).toEqual([])
    expect(target.grantedSkills).toContain(QIQIAO_MAJUN_QIQIAO)
    expect(runtime.globalSlashUses!(game.state, target.id, target.id)).toBe(1)
    expect(runtime.trickUnresponsive!(game.state, target.id, target.id, '过河拆桥')).toBe(true)
    moveCard(game.state, equipment.id, { kind: 'equipment', playerId: target.id, slot: equipment.equipmentSlot! }, { kind: 'discardPile' })
    expect(target.grantedSkills).not.toContain(QIQIAO_MAJUN_QIQIAO)
    expect(runtime.globalSlashUses!(game.state, target.id, target.id)).toBe(0)
  })

  it('奇巧马钧【奇巧】装备类别效果在强化装备离区时令原持有者摸两张牌', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-qiqiao-equipment-effect',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'qiqiao-majun-b90'
    owner.grantedSkills.push(QIQIAO_MAJUN_QIQIAO)
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    game.state.status = 'playing'
    const basic = Object.values(game.state.cards).find((card) => card.category === 'basic' && game.state.zones.drawPile.includes(card.id))!
    const materialEquipment = Object.values(game.state.cards).find((card) => card.category === 'equipment' && game.state.zones.drawPile.includes(card.id))!
    const selectedEquipment = Object.values(game.state.cards).find((card) => card.category === 'equipment' && card.equipmentSlot
      && card.id !== materialEquipment.id && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, basic.id, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: 'cai' })
    moveCard(game.state, materialEquipment.id, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: 'cai' })
    moveCard(game.state, selectedEquipment.id, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot: selectedEquipment.equipmentSlot! })
    const runtime = getSkillRuntime(QIQIAO_MAJUN_QIQIAO)!
    runtime.invokeActive!(game as never, owner.id, QIQIAO_MAJUN_QIQIAO)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [basic.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [materialEquipment.id] } })
    request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [selectedEquipment.id] } })
    const handBefore = target.zones.hand.length

    moveCard(game.state, selectedEquipment.id, { kind: 'equipment', playerId: target.id, slot: selectedEquipment.equipmentSlot! }, { kind: 'discardPile' })

    expect(target.zones.hand).toHaveLength(handBefore + 2)
    expect(target.grantedSkills).not.toContain(QIQIAO_MAJUN_QIQIAO)
  })

  it('乐貂蝉【檀板】标记起始手牌、排除手牌上限并交换一对手牌标记', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-tanban',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    owner.characterId = 'le-diaochan-b90'
    game.state.status = 'playing'
    const cards = Object.values(game.state.cards).slice(0, 2)
    moveCard(game.state, cards[0]!.id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime(LE_DIAOCHAN_TANBAN)!
    runtime.onGameStart!(game as never, owner.id)
    moveCard(game.state, cards[1]!.id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const markedId = cards[0]!.id
    const unmarkedId = cards[1]!.id
    expect(runtime.handLimitExempt!(game.state, owner.id, markedId)).toBe(true)
    expect(runtime.handLimitExempt!(game.state, owner.id, unmarkedId)).toBe(false)

    runtime.resume!(game as never, owner.id, { step: 'exchange-marked', data: {} } as never,
      { payload: { cardIds: [markedId] } } as never)
    const request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [unmarkedId] } })

    expect(runtime.handLimitExempt!(game.state, owner.id, markedId)).toBe(false)
    expect(runtime.handLimitExempt!(game.state, owner.id, unmarkedId)).toBe(true)
  })

  it('乐貂蝉【低讴】结算檀板牌后展示同名非檀板牌、摸两张并走正常使用流程', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-diyou',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    owner.characterId = 'le-diaochan-b90'
    owner.grantedSkills.push(LE_DIAOCHAN_TANBAN, LE_DIAOCHAN_DIYOU)
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    game.state.status = 'playing'
    game.state.pendingRequests = []
    const slashes = Object.values(game.state.cards).filter((card) => card.name === '杀').slice(0, 2)
    const sourceCard = slashes[0]!
    const shownCard = slashes[1]!
    moveCard(game.state, sourceCard.id, { kind: 'drawPile' }, { kind: 'discardPile' })
    moveCard(game.state, shownCard.id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    ;(game.state as unknown as { paperSanguoshaB90: { diaochan: Record<string, { marked: string[]; seenNames: string[]; seenTurn: number }> } }).paperSanguoshaB90 = {
      diaochan: { [owner.id]: { marked: [sourceCard.id], seenNames: [], seenTurn: game.state.turnNumber } },
    }
    const runtime = getSkillRuntime(LE_DIAOCHAN_DIYOU)!
    const trigger = runtime.triggers!.find((entry) => entry.event === 'AfterCardUse')!
    trigger.handle(game as never, owner.id, { event: { sourceId: owner.id, payload: { cardId: sourceCard.id, cardName: '杀' } } } as never)
    const prompt = game.state.skillQueue.find((entry) => entry.skillId === LE_DIAOCHAN_DIYOU)!
    runtime.startQueued!(game as never, owner.id, prompt)
    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [shownCard.id] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    const action = request.options[0]!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: action.id } })

    expect(owner.zones.hand).toHaveLength(2)
    expect(game.state.cardResolution?.kind).toBe('slash')
    expect(game.state.pendingRequests.some((pending) => pending.kind === 'respond-card')).toBe(true)
    expect((game.state as unknown as { paperSanguoshaB90: { diaochan: Record<string, { seenNames: string[] }> } })
      .paperSanguoshaB90.diaochan[owner.id]!.seenNames).toEqual(['杀'])
  })

  it('谋郭嘉【论势】仅在两色手牌数相同且锦囊使用者和目标均非本人时提供不可响应无懈', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-lunshi',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    const source = game.state.players[1]!
    const target = game.state.players[2]!
    owner.characterId = 'mou-guojia-b90'
    owner.grantedSkills.push(MOU_GUOJIA_LUNSHI)
    const [red, black] = Object.values(game.state.cards).slice(0, 2)
    red!.suit = 'heart'
    red!.color = 'red'
    black!.suit = 'spade'
    black!.color = 'black'
    moveCard(game.state, red.id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, black.id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.cardResolution = {
      kind: 'trick', cardId: 'test-trick', cardName: '顺手牵羊', sourceId: source.id,
      targetIds: [target.id], targetIndex: 0, nullifiedTargetIds: [], stage: 'awaiting-nullification',
      interceptsDone: [], cancelledTargetIds: [], unresponsiveTargetIds: [], responderOrder: [],
      responderIndex: 0, nullificationCount: 0, effect: null, requestId: null,
    } as never
    const runtime = getSkillRuntime(MOU_GUOJIA_LUNSHI)!
    const options = runtime.globalResponseViewAs!(game.state, owner.id, owner.id, '无懈可击')
    expect(options.map((option) => option.cardId)).toEqual([red.id, black.id])
    expect(runtime.globalUnanswerableResponses).toContain('无懈可击')

    game.state.cardResolution.targetIds = [owner.id]
    expect(runtime.globalResponseViewAs!(game.state, owner.id, owner.id, '无懈可击')).toEqual([])
    game.state.cardResolution.targetIds = [target.id]
    moveCard(game.state, black.id, { kind: 'hand', playerId: owner.id }, { kind: 'drawPile' })
    expect(runtime.globalResponseViewAs!(game.state, owner.id, owner.id, '无懈可击')).toEqual([])
  })

  it('谋郭嘉【先谋】阴状态弃满X张后执行完整闪电判定和雷电伤害', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-xianmou-yin',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    game.state.status = 'playing'
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'mou-guojia-b90'
    owner.grantedSkills.push(MOU_GUOJIA_XIANMOU)
    const runtime = getSkillRuntime(MOU_GUOJIA_XIANMOU)!
    const host = Object.create(game) as SanguoshaGame & { askSkill: (options: unknown) => void }
    host.askSkill = () => undefined
    runtime.resume!(host as never, owner.id, { step: 'initial-mode', data: {} } as never,
      { payload: { optionId: 'yin' } } as never)
    const cards = game.state.zones.drawPile.slice(0, 5)
    for (const cardId of cards.slice(0, 2)) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    for (const cardId of cards.slice(2, 4)) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const lightning = cards[4]!
    Object.assign(game.state.cards[lightning], { suit: 'spade', rank: 5, color: 'black' })
    game.state.handCardLossThisTurn = { turnNumber: game.state.turnNumber, counts: { [owner.id]: 2 } }
    runtime.triggers!.find((trigger) => trigger.event === 'TurnEnd')!.handle(host as never, owner.id, { event: { payload: {} } } as never)
    runtime.resume!(host as never, owner.id, { step: 'invoke', data: { count: 2, mode: 'yin' } } as never,
      { payload: { optionId: 'yes' } } as never)
    runtime.resume!(host as never, owner.id, { step: 'yin-target', data: { count: 2 } } as never,
      { payload: { targetIds: [target.id] } } as never)
    runtime.resume!(host as never, owner.id, { step: 'yin-discard', data: { count: 2, targetId: target.id } } as never,
      { payload: { cardIds: cards.slice(2, 4) } } as never)

    expect(target.zones.hand).toHaveLength(0)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining(cards.slice(2, 4)))
    expect(owner.hp).toBe(owner.maxHp - 3)
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.retrial).toBeNull()
    expect(game.state.conversionStates?.[`${owner.id}:${MOU_GUOJIA_XIANMOU}`]).toBe('yang')
  })

  it('谋郭嘉【先谋】阳状态获得不足X张时临时获得遗计并切换至阴', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-xianmou-yang',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    game.state.status = 'playing'
    const owner = game.state.players[0]!
    owner.characterId = 'mou-guojia-b90'
    owner.grantedSkills.push(MOU_GUOJIA_XIANMOU)
    const runtime = getSkillRuntime(MOU_GUOJIA_XIANMOU)!
    let asked: { step: string; data: Record<string, unknown> } | undefined
    const host = Object.create(game) as SanguoshaGame & { askSkill: (options: { step: string; data?: Record<string, unknown> }) => void }
    host.askSkill = (options) => { asked = { step: options.step, data: options.data ?? {} } }
    runtime.resume!(host as never, owner.id, { step: 'initial-mode', data: {} } as never,
      { payload: { optionId: 'yang' } } as never)
    const chosen = game.state.zones.drawPile[0]!
    const handBefore = owner.zones.hand.length
    runtime.resume!(host as never, owner.id, { step: 'invoke', data: { count: 2, mode: 'yang' } } as never,
      { payload: { optionId: 'yes' } } as never)
    expect(asked?.step).toBe('yang-select')
    runtime.resume!(host as never, owner.id, { step: 'yang-select', data: { count: 2, cardIds: [chosen] } } as never,
      { payload: { cardIds: [chosen] } } as never)

    expect(owner.zones.hand).toHaveLength(handBefore + 1)
    expect(owner.temporaryGrantedSkills).toContainEqual({ source: `${MOU_GUOJIA_XIANMOU}:yiji`, skillId: 'yiji' })
    expect(game.state.conversionStates?.[`${owner.id}:${MOU_GUOJIA_XIANMOU}`]).toBe('yin')
  })

  it('星荀彧【安庶】将不同牌名基本牌置顶，按所选起始角色结算五谷并追踪后续失牌补牌', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-anshu',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    game.state.status = 'playing'
    game.state.roundNumber = 1
    const owner = game.state.players[0]!
    const target = game.state.players[2]!
    owner.characterId = 'xing-xunyu-b90'
    owner.grantedSkills.push(XING_XUNYU_ANSHU)
    target.hp = target.maxHp - 1
    const selected = game.state.zones.drawPile.slice(0, 2)
    Object.assign(game.state.cards[selected[0]!], { name: '杀', category: 'basic' })
    Object.assign(game.state.cards[selected[1]!], { name: '闪', category: 'basic' })
    for (const cardId of selected) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    const runtime = getSkillRuntime(XING_XUNYU_ANSHU)!
    const host = Object.create(game) as SanguoshaGame & { askSkill: (options: unknown) => void }
    host.askSkill = () => undefined
    runtime.triggers!.find((trigger) => trigger.event === 'RoundEnd')!.handle(host as never, owner.id, { event: { payload: {} } } as never)
    runtime.resume!(host as never, owner.id, { step: 'choose-cards', data: {} } as never,
      { payload: { cardIds: selected } } as never)
    runtime.resume!(host as never, owner.id, { step: 'choose-start', data: { selected } } as never,
      { payload: { targetIds: [target.id] } } as never)

    expect(game.state.cardResolution).toMatchObject({ kind: 'trick', cardName: '五谷丰登' })
    expect(game.state.cardResolution?.kind === 'trick' && game.state.cardResolution.targetIds[0]).toBe(target.id)
    expect(game.state.zones.processingArea).toEqual(expect.arrayContaining(selected))
    expect((game.state as unknown as { paperSanguoshaB90: { xunyuAnshu: Record<string, { cardIds: string[] }> } })
      .paperSanguoshaB90.xunyuAnshu[owner.id]!.cardIds).toEqual(selected)

    const chosen = selected[0]!
    moveCard(game.state, chosen, { kind: 'processingArea' }, { kind: 'hand', playerId: target.id })
    game.state.cardResolution = null
    game.state.pendingRequests = []
    moveCard(game.state, chosen, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' }, { discardReason: 'discard' })
    runtime.triggers!.find((trigger) => trigger.event === 'TurnEnd')!.handle(host as never, owner.id, { event: { payload: {} } } as never)
    expect(game.state.skillQueue.some((prompt) => prompt.skillId === XING_XUNYU_ANSHU
      && prompt.step === 'draw-after-loss' && prompt.data.targetId === target.id)).toBe(true)
    const handBefore = target.zones.hand.length
    runtime.resume!(host as never, owner.id, { step: 'draw-after-loss', data: { targetId: target.id } } as never,
      { payload: { optionId: 'yes' } } as never)
    expect(target.zones.hand.length).toBe(Math.min(5, target.maxHp))
    expect(target.zones.hand.length).toBeGreaterThan(handBefore)
  })

  it('诸葛京【研作】仅在出牌阶段且存在可合法使用的牌时显示主动项', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-yanzuo-active',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    owner.characterId = 'zhugejing-b90'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    game.state.status = 'playing'
    const slash = Object.values(game.state.cards).find((card) => card.name === '杀')!
    moveCard(game.state, slash.id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime(ZHUGEJING_YANZUO)!
    expect(runtime.activeActions!(game.state, owner.id).map((action) => action.id)).toEqual([`skill:${ZHUGEJING_YANZUO}`])
    game.state.phase = 'draw'
    expect(runtime.activeActions!(game.state, owner.id)).toEqual([])
  })

  it('诸葛京【研作】完整走置牌、选牌和标准杀结算入口', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-yanzuo-resolution',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    owner.characterId = 'zhugejing-b90'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    game.state.status = 'playing'
    const slashes = Object.values(game.state.cards).filter((card) => card.name === '杀').slice(0, 2)
    moveCard(game.state, slashes[0]!.id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, slashes[1]!.id, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: 'yanzuo' })

    const runtime = getSkillRuntime(ZHUGEJING_YANZUO)!
    runtime.invokeActive!(game as never, owner.id, `skill:${ZHUGEJING_YANZUO}`)
    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [slashes[0]!.id] } })

    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: slashes[1]!.id } })
    request = game.state.pendingRequests.at(-1)!
    if (request?.kind === 'choose-option') {
      const requestOptions = request.options
      const action = requestOptions.find((option) => option.id.includes('p1')) ?? requestOptions[0]!
      game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: action.id } })
    }
    expect(game.state.cardResolution?.kind).toBe('slash')
    expect(game.state.cardResolution?.cardId).toBe(slashes[1]!.id)
  })

  it('星荀彧【匡祚】由受赠者逐花色选择手牌，并同时授予承奉和主公统荫', () => {
    const owner = { id: 'xunyu', alive: true, usedLimitedSkills: [], zones: { hand: [], equipment: {}, judgingArea: [] }, characterPiles: {} }
    const recipient = { id: 'lord', alive: true, identity: 'lord', kingdom: 'wei', grantedSkills: [], zones: { hand: [], equipment: {}, judgingArea: [] }, characterPiles: {} }
    const donor = { id: 'donor', alive: true, zones: { hand: [], equipment: {}, judgingArea: [] }, characterPiles: {} }
    const suits = ['spade', 'heart', 'club', 'diamond']
    const cards = Object.fromEntries(suits.map((suit, index) => {
      const id = `gift-${suit}`
      donor.zones.hand.push(id)
      return [id, { id, name: '杀', suit, rank: index + 1, color: index % 2 ? 'red' : 'black', category: 'basic' }]
    }))
    const state = { phase: 'play', turnNumber: 1, players: [owner, recipient, donor], cards,
      cardAliases: {}, cardNatures: {}, cardColorOverrides: {}, equipmentTransformations: {},
      zones: { drawPile: [], discardPile: [], processingArea: [] } } as unknown as SanguoshaState
    const asks: Array<{ skillId: string; ownerId: string; step: string; data?: Record<string, unknown>; build(id: string): unknown }> = []
    const queued: Array<{ skillId: string; ownerId: string; step: string; data: Record<string, unknown> }> = []
    const host = { state, askSkill: (ask: (typeof asks)[number]) => asks.push(ask), queueSkill: (prompt: (typeof queued)[number]) => queued.push(prompt),
      dispatch() { return { event: { payload: {} }, cancelled: false, cancel() {} } } }
    const runtime = getSkillRuntime(XING_XUNYU_KUANGZUO)!
    runtime.invokeActive!(host as never, owner.id, `skill:${XING_XUNYU_KUANGZUO}`)
    runtime.resume!(host as never, owner.id, { step: 'beneficiary', data: { } } as never, { payload: { targetIds: [recipient.id] } } as never)
    runtime.resume!(host as never, owner.id, { step: 'donor', data: { targetId: recipient.id } } as never, { payload: { targetIds: [donor.id] } } as never)
    let prompt = queued.shift()!
    for (const suit of suits) {
      runtime.startQueued!(host as never, owner.id, prompt as never)
      const ask = asks.pop()!
      const request = ask.build('req') as { playerId: string; cardIds: string[] }
      expect(request.playerId).toBe(donor.id)
      const cardId = donor.zones.hand.find((id) => cards[id]!.suit === suit)!
      expect(request.cardIds).toContain(cardId)
      runtime.resume!(host as never, owner.id, { step: 'donor-card', data: prompt.data } as never, { payload: { cardIds: [cardId] } } as never)
      if (suit !== suits[suits.length - 1]) prompt = queued.shift()!
    }
    expect(recipient.characterPiles.kuangzuo).toHaveLength(4)
    expect(recipient.grantedSkills).toEqual(expect.arrayContaining([XING_XUNYU_CHENGFENG, XING_XUNYU_TONGYIN]))
    expect(owner.usedLimitedSkills).toContain(XING_XUNYU_KUANGZUO)
  })

  it('星荀彧【统荫】同势力取伤害牌，异势力从伤害来源区域选择牌', () => {
    const damageCard = { id: 'damage-card', name: '杀', suit: 'spade', rank: 7, color: 'black', category: 'basic' }
    const sourceCard = { id: 'source-equip', name: '诸葛连弩', suit: 'club', rank: 1, color: 'black', category: 'equipment', equipmentSlot: 'weapon' }
    const target = { id: 'target', alive: true, nationalWarFaction: 'wei', zones: { hand: [], equipment: {}, judgingArea: [] }, characterPiles: { kuangzuo: [] } }
    const source = { id: 'source', alive: true, nickname: '伤害来源', nationalWarFaction: 'wei', zones: { hand: [], equipment: { weapon: sourceCard.id }, judgingArea: [] }, characterPiles: {} }
    const state = { players: [target, source], cards: { [damageCard.id]: damageCard, [sourceCard.id]: sourceCard },
      cardAliases: {}, cardNatures: {}, cardColorOverrides: {}, equipmentTransformations: {},
      zones: { drawPile: [], discardPile: [], processingArea: [damageCard.id] } } as unknown as SanguoshaState
    const queued: Array<{ step: string; data: Record<string, unknown> }> = []
    const asks: Array<{ step: string; build(id: string): unknown }> = []
    const host = { state, queueSkill: (prompt: (typeof queued)[number]) => queued.push(prompt),
      askSkill: (ask: (typeof asks)[number]) => asks.push(ask), dispatch() { return { event: { payload: {} }, cancelled: false, cancel() {} } } }
    const runtime = getSkillRuntime(XING_XUNYU_TONGYIN)!
    target.nationalWarFaction = 'wei'
    source.nationalWarFaction = 'wei'
    const trigger = runtime.triggers!.find((entry) => entry.event === 'DamageSettled')!
    trigger.handle(host as never, target.id, { event: { sourceId: source.id, payload: { cardId: damageCard.id, finalAmount: 1 } } } as never)
    expect(queued.shift()?.step).toBe('take-damage-card')
    runtime.startQueued!(host as never, target.id, { skillId: XING_XUNYU_TONGYIN, ownerId: target.id,
      step: 'take-damage-card', data: { cardId: damageCard.id } } as never)
    runtime.resume!(host as never, target.id, { step: 'take-damage-card', data: { cardId: damageCard.id } } as never,
      { payload: { optionId: 'yes' } } as never)
    expect(target.characterPiles.kuangzuo).toEqual([damageCard.id])
    expect(state.zones.processingArea).toEqual([])

    target.nationalWarFaction = 'wei'
    source.nationalWarFaction = 'qun'
    trigger.handle(host as never, target.id, { event: { sourceId: source.id, payload: { cardId: damageCard.id, finalAmount: 1 } } } as never)
    expect(queued.shift()?.step).toBe('choose-source-card')
    runtime.startQueued!(host as never, target.id, { skillId: XING_XUNYU_TONGYIN, ownerId: target.id,
      step: 'choose-source-card', data: { sourceId: source.id } } as never)
    const request = asks.pop()!.build('select') as { cardIds: string[] }
    expect(request.cardIds).toContain(sourceCard.id)
    runtime.resume!(host as never, target.id, { step: 'choose-source-card', data: { sourceId: source.id } } as never,
      { payload: { cardIds: [sourceCard.id] } } as never)
    expect(target.characterPiles.kuangzuo).toEqual([damageCard.id, sourceCard.id])
    expect(source.zones.equipment.weapon).toBeNull()
  })

  it('武皇甫嵩【朝镇】从所选区域随机取得最小点数牌，获得A后本回合失效', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-chaozhen',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `c${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const owner = game.state.players[0]!
    owner.hp = owner.maxHp - 1
    const candidates = game.state.zones.drawPile.slice(0, 3)
    candidates.forEach((cardId, index) => { game.state.cards[cardId]!.rank = index === 2 ? 1 : 8 + index })
    const runtime = getSkillRuntime(WU_HUANGFUSONG_CHAOZHEN)!
    runtime.startQueued!(game as never, owner.id, { skillId: WU_HUANGFUSONG_CHAOZHEN, ownerId: owner.id,
      step: 'gain', data: { source: 'draw' } } as never)
    const gained = owner.zones.hand.at(-1)!
    expect(game.state.cards[gained]!.rank).toBe(1)
    expect(owner.hp).toBe(owner.maxHp)
    expect((game.state as unknown as { paperSanguoshaB90: { huangfusongChaozhenDisabled: Record<string, number> } })
      .paperSanguoshaB90.huangfusongChaozhenDisabled[owner.id]).toBe(game.state.turnNumber)
    const pendingCount = game.state.pendingRequests.length
    runtime.startQueued!(game as never, owner.id, { skillId: WU_HUANGFUSONG_CHAOZHEN, ownerId: owner.id,
      step: 'invoke', data: {} } as never)
    expect(game.state.pendingRequests).toHaveLength(pendingCount)
  })

  it('武皇甫嵩【连捷】【将贤】限点数及目标、摸牌标记、增伤并于回合后失去所选技能', () => {
    const game = new SanguoshaGame({
      seed: 'historical-batch90-lianjie-jiangxian',
      setup: { mode: 'identity', generalChoices: 3, players: Array.from({ length: 5 }, (_, index) => ({
        id: `l${index}`, nickname: `玩家${index}`, isHuman: index === 0,
      })) },
    })
    const [owner, target] = game.state.players
    const [usedCard, ownCard, targetMin, targetSameMin, drawA, drawB, drawC] = game.state.zones.drawPile.slice(0, 7)
    game.state.cards[usedCard!]!.rank = 5
    game.state.cards[ownCard!]!.rank = 8
    game.state.cards[targetMin!]!.rank = 1
    game.state.cards[targetSameMin!]!.rank = 1
    moveCard(game.state, usedCard!, { kind: 'drawPile' }, { kind: 'processingArea' })
    moveCard(game.state, ownCard!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, targetMin!, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    moveCard(game.state, targetSameMin!, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    owner!.maxHp = owner!.zones.hand.length + 3
    owner!.hp = owner!.maxHp
    owner!.grantedSkills = [WU_HUANGFUSONG_CHAOZHEN, WU_HUANGFUSONG_LIANJIE]
    const runtime = getSkillRuntime(WU_HUANGFUSONG_LIANJIE)!
    runtime.resume!(game as never, owner!.id, { step: 'lowest-card', data: { targetId: target!.id, rank: 5 } } as never,
      { payload: { cardIds: [targetMin!] } } as never)
    expect(game.state.zones.drawPile.at(-1)).toBe(targetMin)
    const record = (game.state as unknown as { paperSanguoshaB90: { huangfusong: Record<string, { empoweredIds: string[]; usedTargets: string[] }> } })
      .paperSanguoshaB90.huangfusong[owner!.id]!
    expect(record.usedTargets).toContain(target!.id)
    expect(record.empoweredIds).toHaveLength(3)
    expect(runtime.globalUnlimitedCardUses!(game.state, owner!.id, owner!.id, drawA!)).toBe(true)
    expect(runtime.globalIgnoresDistanceToCard!(game.state, owner!.id, owner!.id, target!.id, drawA!)).toBe(true)
    const damageRuntime = getSkillRuntime(WU_HUANGFUSONG_LIANJIE)!
    const damageState = game.state as unknown as { paperSanguoshaB90: { huangfusong: Record<string, { turn: number; empoweredIds: string[]; extraDamage: number; limited: boolean }> } }
    damageState.paperSanguoshaB90.huangfusong[owner!.id]!.limited = true
    damageState.paperSanguoshaB90.huangfusong[owner!.id]!.extraDamage = 2
    const damagePayload = { cardId: drawA, amount: 1 }
    damageRuntime.triggers!.find((entry) => entry.event === 'DamageCaused')!.handle(game as never, owner!.id,
      { event: { sourceId: owner!.id, payload: damagePayload } } as never)
    expect(damagePayload.amount).toBe(3)

    const jiangxian = getSkillRuntime(WU_HUANGFUSONG_JIANGXIAN)!
    game.state.phase = 'play'
    owner!.usedLimitedSkills = []
    expect(jiangxian.activeActions!(game.state, owner!.id).map((action) => action.id)).toEqual([`skill:${WU_HUANGFUSONG_JIANGXIAN}`])
    jiangxian.invokeActive!(game as never, owner!.id, `skill:${WU_HUANGFUSONG_JIANGXIAN}`)
    game.state.phase = 'finish'
    const turnEnd = damageRuntime.triggers!.find((entry) => entry.event === 'TurnEnd')!
    turnEnd.handle(game as never, owner!.id, { event: { payload: { playerId: owner!.id } } } as never)
    expect(game.state.skillQueue.at(-1)?.skillId).toBe(WU_HUANGFUSONG_JIANGXIAN)
    jiangxian.resume!(game as never, owner!.id, { step: 'lose-skill', data: {
      candidates: [WU_HUANGFUSONG_CHAOZHEN, WU_HUANGFUSONG_LIANJIE],
    } } as never, { payload: { optionId: WU_HUANGFUSONG_LIANJIE } } as never)
    expect(owner!.permanentlyLostSkills).toContain(WU_HUANGFUSONG_LIANJIE)
  })
})
