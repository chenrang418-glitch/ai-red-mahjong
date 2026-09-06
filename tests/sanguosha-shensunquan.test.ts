import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { GameRng } from '@/sanguosha/engine/rng'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { randomSkillPoolOf, sampleSkills, skillIsRandomlyGrantable } from '@/sanguosha/engine/random-skill-pool'
import { conversionStateOf } from '@/sanguosha/engine/conversion'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·孙权。
 *
 * 四条主张，逐条有断言：
 *
 * - 【驭衡】的「任意张」包含**零张**，花色必须互不相同，技能池现算不写死；
 * - 【帝力】按失去的技能个数**依次**给前 X 个衍生技能；
 * - 【圣质】武装的是**下一张牌**，用掉就收，回合结束作废；
 * - 【持纲】是把判定阶段**改成**摸牌 / 出牌阶段——真阶段、真事件，
 *   而且不会把本来的摸牌阶段顶掉。
 */

const CAST = ['shensunquan', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong']

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
      }
      case 'choose-options': {
        const pick = request as unknown as { options: { id: string }[]; min: number }
        return { optionIds: pick.options.slice(0, pick.min ?? 0).map((option) => option.id) }
      }
      case 'choose-cards': {
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
        return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
      }
      case 'choose-targets': {
        const pick = request as unknown as { candidateIds: string[]; min: number }
        return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
      }
      case 'arrange-cards': {
        const pick = request as unknown as { cardIds: string[] }
        return { top: [...pick.cardIds], bottom: [] }
      }
      case 'rescue': return { actionId: 'rescue-pass' }
      default: return { actionId: 'respond-pass' }
    }
  })()
  return { requestId: request.id, playerId: request.playerId, payload }
}

function settle(
  game: SanguoshaGame,
  choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const custom = choose(request)
    game.respond(custom
      ? { requestId: request.id, playerId: request.playerId, payload: custom }
      : defaultResponse(request))
  }
  throw new Error('结算没有收敛')
}

function gameAt(seed: string, characterIds: string[] = CAST): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  settle(game)
  while (game.state.phase !== 'play') game.advancePhase()
  return game
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as never }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

/** 塞一张指定花色（可再指定牌名）的牌。 */
function giveSuit(game: SanguoshaGame, playerId: string, suit: string, cardName?: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.suit === suit
    && !candidate.virtual
    && (cardName === undefined || candidate.name === cardName)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的 ${suit} ${cardName ?? ''}`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 推进到 p0 的下一个回合开始，并在回合真正开始那一刻布置局面。 */
function atNextTurn(
  game: SanguoshaGame,
  arrange: () => void,
  choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
): void {
  /*
   * 局面必须在 p0 的回合**开始之前**摆好。
   *
   * 摆在 `TurnStart` 上就晚了：【驭衡】也挂在这个时机，它的发问在那一刻
   * 就已经把手牌快照进请求里了，之后再塞牌，那几张不在候选里，答上去就是非法。
   * 所以挂在上家（p4）的回合结束上。
   */
  let armed = false
  game.events.on('TurnEnd', (handled) => {
    if (armed || (handled.event.payload as { playerId?: string }).playerId !== 'p4') return
    armed = true
    arrange()
  })
  for (let guard = 0; guard < 60; guard += 1) {
    game.advancePhase()
    settle(game, choose)
    if (armed && game.state.currentPlayerId === 'p0' && game.state.phase !== 'prepare') return
    if (game.state.status !== 'playing') break
  }
  throw new Error('没能回到神孙权的回合')
}

describe('公共机制：随机技能池', () => {
  it('池子从武将表现算，而且排除限定/觉醒/主公/衍生技', () => {
    const pool = randomSkillPoolOf('wu')
    expect(pool.length, '吴势力技能不止一两个').toBeGreaterThan(5)
    for (const skill of pool) {
      expect(skill.kingdom).toBe('wu')
    }
    // 资格只看结构化标志
    expect(skillIsRandomlyGrantable('jijiang'), '主公技不进池').toBe(false)
    expect(skillIsRandomlyGrantable('niepan'), '限定技不进池').toBe(false)
    expect(skillIsRandomlyGrantable('wusheng'), '普通技能可以').toBe(true)
    expect(skillIsRandomlyGrantable('wusheng', true), '衍生技不进池').toBe(false)
  })

  it('抽样互不重复、可复现，而且不会抽到已经拥有的', () => {
    const first = sampleSkills(new GameRng('pool'), 'wu', 3)
    const again = sampleSkills(new GameRng('pool'), 'wu', 3)
    expect(first.map((skill) => skill.id)).toEqual(again.map((skill) => skill.id))
    expect(new Set(first.map((skill) => skill.id)).size).toBe(first.length)

    const excluded = first[0].id
    const filtered = sampleSkills(new GameRng('pool'), 'wu', 3, [excluded])
    expect(filtered.map((skill) => skill.id), '排除项不会被抽到').not.toContain(excluded)
  })
})

describe('神·孙权：驭衡', () => {
  it('弃零张也合法：不强迫他至少弃一张', () => {
    const game = gameAt('sq-yuheng-zero')
    let asked = false
    atNextTurn(game, () => {}, (request) => {
      if (request.kind === 'choose-cards' && request.prompt?.includes('驭衡')) {
        asked = true
        expect((request as unknown as { min: number }).min, '下限是 0').toBe(0)
        return { cardIds: [] }
      }
      return null
    })
    expect(asked, '回合开始时问了').toBe(true)
    expect(playerOf(game, 'p0').temporaryGrantedSkills ?? [], '一张都没弃就没有技能').toHaveLength(0)
  })

  it('弃 N 张不同花色的牌，获得 N 个吴势力技能；回合结束失去并摸 N 张', () => {
    const game = gameAt('sq-yuheng-grant')
    let picked: string[] = []
    atNextTurn(game, () => {
      trimHand(game, 'p0', 0)
      giveSuit(game, 'p0', 'heart')
      giveSuit(game, 'p0', 'spade')
    }, (request) => {
      if (request.kind === 'choose-cards' && request.prompt?.includes('驭衡')) {
        picked = [...playerOf(game, 'p0').zones.hand]
        return { cardIds: picked }
      }
      return null
    })

    const owner = playerOf(game, 'p0')
    const temporary = (owner.temporaryGrantedSkills ?? []).filter((entry) => entry.source === 'yuheng')
    expect(temporary, '弃两张就拿两个技能').toHaveLength(2)
    expect(owner.marks['yuheng-count'], '记下了这次拿了几个').toBe(2)
    const owned = ownedSkillIds(game.state, 'p0', skillIdsOf)
    for (const entry of temporary) expect(owned, '临时技能确实生效').toContain(entry.skillId)

    /*
     * 「回合结束前」的手牌数要在**结束阶段开始**时量。
     *
     * 量在 `TurnEnd` 上就晚了：驭衡的收尾也挂在同一个时机，
     * 它先跑的话量到的已经是摸完之后的数了，差值恒为 0。
     */
    let before = -1
    game.events.on('PhaseStart', (handled) => {
      const payload = handled.event.payload as { playerId?: string; phase?: string }
      if (payload.playerId === 'p0' && payload.phase === 'finish' && before < 0) {
        before = playerOf(game, 'p0').zones.hand.length
      }
    })
    for (let guard = 0; guard < 10 && game.state.currentPlayerId === 'p0'; guard += 1) {
      game.advancePhase()
      settle(game)
    }
    const after = playerOf(game, 'p0')
    expect((after.temporaryGrantedSkills ?? []).filter((entry) => entry.source === 'yuheng'), '回合结束失去').toHaveLength(0)
    expect(after.marks['yuheng-count'], '记账也清掉').toBeUndefined()
    expect(after.zones.hand.length - before, '摸等量的牌').toBe(2)
    assertCardConservation(game.state)
  })

  it('花色重复的一组不生效：不替玩家挑一个合法子集', () => {
    const game = gameAt('sq-yuheng-suits')
    atNextTurn(game, () => {
      trimHand(game, 'p0', 0)
      giveSuit(game, 'p0', 'heart')
      giveSuit(game, 'p0', 'heart')
    }, (request) => {
      if (request.kind === 'choose-cards' && request.prompt?.includes('驭衡')) {
        return { cardIds: [...playerOf(game, 'p0').zones.hand] }
      }
      return null
    })
    const owner = playerOf(game, 'p0')
    expect(owner.zones.hand, '两张同花色，一张都没弃').toHaveLength(2)
    expect((owner.temporaryGrantedSkills ?? []).filter((entry) => entry.source === 'yuheng')).toHaveLength(0)
  })
})

describe('神·孙权：帝力', () => {
  it('技能数超过体力上限才觉醒，失去几个就依次拿前几个衍生技能', () => {
    const game = gameAt('sq-dili')
    const owner = playerOf(game, 'p0')
    /*
     * 造一个「技能数 > 体力上限」的局面：上限压到 2，
     * 他本来就有驭衡和帝力两个，再授一个就是 3 > 2。
     */
    owner.maxHp = 2
    owner.hp = 2
    owner.grantedSkills.push('wusheng')

    atNextTurn(game, () => {}, (request) => {
      if (request.kind === 'choose-options' && request.prompt?.includes('帝力')) {
        // 失去两个技能 → 拿到圣质 + 权道
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionIds: options.slice(0, 2).map((option) => option.id) }
      }
      return null
    })

    const after = playerOf(game, 'p0')
    expect(after.awakenedSkills, '觉醒记账').toContain('dili')
    expect(after.maxHp, '减 1 点体力上限').toBe(1)
    expect(after.grantedSkills, '失去两个 → 圣质').toContain('shengzhi')
    expect(after.grantedSkills, '失去两个 → 权道').toContain('quandao')
    expect(after.grantedSkills, '只失去两个就还没有持纲').not.toContain('chigang')
    assertGameInvariants(game.state)
  })
})

describe('神·孙权：圣质', () => {
  it('发动非锁定技后武装，用掉一张牌就收；锁定技不武装', () => {
    const game = gameAt('sq-shengzhi')
    const owner = playerOf(game, 'p0')
    owner.grantedSkills.push('shengzhi')

    // 锁定技不武装：直接派发一条锁定技的横幅
    game.dispatch('SkillActivated', { skillId: 'paoxiao', skillName: '咆哮', playerId: 'p0' }, { sourceId: 'p0' })
    expect(owner.marks['shengzhi-armed'], '锁定技不武装').toBeUndefined()

    // 非锁定技武装
    game.dispatch('SkillActivated', { skillId: 'wusheng', skillName: '武圣', playerId: 'p0' }, { sourceId: 'p0' })
    expect(owner.marks['shengzhi-armed'], '非锁定技武装').toBe(1)

    // 再发动一个非锁定技不会叠成两次
    game.dispatch('SkillActivated', { skillId: 'longdan', skillName: '龙胆', playerId: 'p0' }, { sourceId: 'p0' })
    expect(owner.marks['shengzhi-armed'], '只武装一次').toBe(1)

    // 用一张牌就消耗掉
    trimHand(game, 'p0', 0)
    const peach = giveSuit(game, 'p0', 'heart', '桃')
    owner.hp = Math.max(1, owner.maxHp - 1)
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(peach))!
    game.act('p0', action.id)
    settle(game)
    expect(playerOf(game, 'p0').marks['shengzhi-armed'], '用掉就收').toBeUndefined()
  })
})

describe('神·孙权：持纲', () => {
  it('阳：判定阶段改为摸牌阶段，而且不吃掉本来的摸牌阶段', () => {
    const game = gameAt('sq-chigang-yang')
    playerOf(game, 'p0').grantedSkills.push('chigang')
    expect(conversionStateOf(game.state, 'p0', 'chigang'), '初始为阳').toBe('yang')

    const phases: string[] = []
    game.events.on('PhaseStart', (handled) => {
      const payload = handled.event.payload as { playerId?: string; phase?: string }
      if (payload.playerId === 'p0') phases.push(String(payload.phase))
    })
    atNextTurn(game, () => {}, () => null)
    // 走完他这一整个回合
    for (let guard = 0; guard < 12 && game.state.currentPlayerId === 'p0'; guard += 1) {
      game.advancePhase()
      settle(game)
    }
    /*
     * 判定位跑成了摸牌阶段，所以这一回合有**两个**摸牌阶段：
     * 一个是判定位换来的，一个是本来的摸牌阶段。
     * 判定阶段自己一次都没有跑——这正是「改为」的分量。
     */
    expect(phases, '判定阶段不执行').not.toContain('judge')
    expect(phases.filter((phase) => phase === 'draw'), '换来的 + 本来的').toHaveLength(2)
    expect(conversionStateOf(game.state, 'p0', 'chigang'), '发动之后切到阴').toBe('yin')
  })

  it('阴：判定阶段改为出牌阶段', () => {
    const game = gameAt('sq-chigang-yin')
    playerOf(game, 'p0').grantedSkills.push('chigang')
    // 先手动切到阴
    game.state.conversionStates = { 'p0:chigang': 'yin' }

    const phases: string[] = []
    game.events.on('PhaseStart', (handled) => {
      const payload = handled.event.payload as { playerId?: string; phase?: string }
      if (payload.playerId === 'p0') phases.push(String(payload.phase))
    })
    atNextTurn(game, () => {}, () => null)
    for (let guard = 0; guard < 12 && game.state.currentPlayerId === 'p0'; guard += 1) {
      game.advancePhase()
      settle(game)
    }
    expect(phases, '判定阶段不执行').not.toContain('judge')
    expect(phases.filter((phase) => phase === 'play'), '换来的 + 本来的').toHaveLength(2)
  })
})
