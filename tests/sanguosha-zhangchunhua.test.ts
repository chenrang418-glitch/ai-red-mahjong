import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { lostHpOf } from '@/sanguosha/engine/hand-state-trigger'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 张春华（一将成名 2011 经典）。
 *
 * 四条主张，逐条有断言：
 *
 * - 【绝情】是把伤害**换成**失去体力，不是「先打再补」也不是「防止后另扣」；
 * - 换掉之后「受到伤害后」那批时机一个都不跑，连环也不传导；
 * - 因绝情而死**没有击杀者**，不触发身份局的击杀奖惩；
 * - 【伤逝】按 `maxHp - hp` 现算，放弃一次之后状态再变还能再问。
 */

const CAST = ['zhangchunhua', 'guojia', 'xiahoudun', 'zhaoyun', 'huangzhong']

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

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 张春华（p0）对某人造成一次伤害，返回观察到的事件。 */
function hit(game: SanguoshaGame, targetId: string, amount: number, nature: 'normal' | 'fire' | 'thunder' = 'normal') {
  const damaged: number[] = []
  const lost: number[] = []
  const off1 = game.events.on('Damaged', (handled) => { damaged.push(Number(handled.event.payload.amount)) })
  const off2 = game.events.on('LoseHp', (handled) => {
    if (handled.event.targetId === targetId) lost.push(Number(handled.event.payload.amount))
  })
  const before = playerOf(game, targetId).hp
  resolveDamage(game as never, { sourceId: 'p0', targetId, amount, nature })
  game.settle()
  settle(game)
  off1?.()
  off2?.()
  return { damaged, lost, delta: before - playerOf(game, targetId).hp }
}

describe('张春华：绝情', () => {
  it('造成的伤害改为等量失去体力，一点都不多一点都不少', () => {
    const game = gameAt('zch-jueqing')
    const target = playerOf(game, 'p3')
    target.hp = target.maxHp
    const result = hit(game, 'p3', 2)
    expect(result.delta, '掉了 2 点').toBe(2)
    expect(result.damaged, '一次伤害事件都没有').toEqual([])
    expect(result.lost, '换成了等量的失去体力').toEqual([2])
  })

  it('属性伤害同样被换掉，也就不传导连环', () => {
    const game = gameAt('zch-nature')
    for (const id of ['p2', 'p3']) {
      const player = playerOf(game, id)
      player.hp = player.maxHp
      player.chained = true
    }
    const result = hit(game, 'p3', 1, 'fire')
    expect(result.lost, '火焰伤害也变成失去体力').toEqual([1])
    expect(playerOf(game, 'p2').hp, '连环上的另一个人没有被传导').toBe(playerOf(game, 'p2').maxHp)
    expect(playerOf(game, 'p3').chained, '连环状态也没被解除——根本没有属性伤害发生').toBe(true)
  })

  it('对面的「受到伤害后」技能不会被触发', () => {
    const game = gameAt('zch-no-trigger')
    // p1 是郭嘉（遗计），p2 是夏侯惇（刚烈）：两个都靠「受到伤害后」吃饭
    const target = playerOf(game, 'p2')
    target.hp = target.maxHp
    const skills: string[] = []
    game.events.on('SkillActivated', (handled) => {
      const skillId = (handled.event.payload as { skillId?: string }).skillId
      if (skillId) skills.push(skillId)
    })
    hit(game, 'p2', 1)
    expect(skills, '刚烈不该被触发').not.toContain('ganglie')
    expect(playerOf(game, 'p2').hp, '血照掉').toBe(target.maxHp - 1)
  })

  it('因绝情而死：照常进入濒死，但没有击杀者', () => {
    const game = gameAt('zch-death')
    const target = playerOf(game, 'p3')
    target.hp = 1
    let dyingSeen = false
    game.events.on('EnterDying', (handled) => {
      if (handled.event.payload.playerId === 'p3') dyingSeen = true
    })
    const deaths: Array<string | undefined> = []
    game.events.on('Death', (handled) => { deaths.push(handled.event.sourceId) })

    hit(game, 'p3', 1)
    expect(dyingSeen, '失去体力到 0 照常进濒死').toBe(true)
    expect(playerOf(game, 'p3').alive, '没人救就死了').toBe(false)
    /*
     * **没有击杀者**：失去体力不是伤害，也就没有伤害来源可言。
     * 身份局的击杀奖惩（反贼被杀摸三张、主公杀忠臣弃牌）都挂在击杀者上，
     * 所以这里一个都不该发生。
     */
    expect(deaths, '死亡事件里没有来源').toEqual([undefined])
    assertGameInvariants(game.state)
  })

  it('张春华杀掉反贼不摸三张牌：那是击杀奖励，而绝情没有击杀者', () => {
    const game = gameAt('zch-reward')
    const target = playerOf(game, 'p3') // p3 是反贼
    target.hp = 1
    trimHand(game, 'p0', 0)
    hit(game, 'p3', 1)
    expect(playerOf(game, 'p3').alive).toBe(false)
    expect(playerOf(game, 'p0').zones.hand, '没有击杀奖励').toHaveLength(0)
  })
})

describe('张春华：伤逝', () => {
  /** 让她掉到指定体力，并把手牌裁到指定张数，然后答一次伤逝。 */
  function arrange(game: SanguoshaGame, hp: number, hand: number): void {
    const owner = playerOf(game, 'p0')
    owner.hp = hp
    trimHand(game, 'p0', hand)
  }

  function askShangshi(game: SanguoshaGame, answer: 'draw' | 'cancel'): { asked: boolean; prompt: string } {
    let asked = false
    let prompt = ''
    // 用一次「失去体力」把状态触发点撞出来
    game.dispatch('LoseHp', { playerId: 'p0', amount: 0, reason: 'test' }, { targetId: 'p0' })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('伤逝')) {
        asked = true
        prompt = request.prompt
        return { optionId: answer }
      }
      return null
    })
    return { asked, prompt }
  }

  it('手牌少于已损失体力值时可以补齐；已损失体力按 maxHp - hp 现算', () => {
    const game = gameAt('zch-shangshi-draw')
    /*
     * **不要按「3 血」写死期望值**：身份局主公的体力上限有 +1，
     * 坐主公位的张春华是 4 血。已损失体力一律从 `lostHpOf` 现取。
     */
    arrange(game, 1, 0)
    const lost = lostHpOf(game.state, 'p0')
    expect(lost, '掉到 1 点时确实损失了好几点').toBeGreaterThan(0)
    const result = askShangshi(game, 'draw')
    expect(result.asked, '条件成立就问').toBe(true)
    expect(playerOf(game, 'p0').zones.hand, '补到已损失体力值那么多张').toHaveLength(lost)
  })

  it('手牌等于或多于已损失体力值时不触发', () => {
    for (const [seed, extra] of [['zch-eq', 0], ['zch-more', 2]] as const) {
      const game = gameAt(seed)
      const owner = playerOf(game, 'p0')
      owner.hp = owner.maxHp - 1
      // 手牌正好等于（或多于）已损失体力值
      trimHand(game, 'p0', lostHpOf(game.state, 'p0') + extra)
      const result = askShangshi(game, 'draw')
      expect(result.asked, `手牌比已损失体力多 ${extra} 张时不该问`).toBe(false)
    }
  })

  it('体力上限变了，已损失体力跟着变——不能写死成「3 - hp」', () => {
    const game = gameAt('zch-dynamic')
    const owner = playerOf(game, 'p0')
    owner.maxHp = 5
    arrange(game, 2, 0)
    expect(lostHpOf(game.state, 'p0'), '上限改成 5 之后已损失是 3').toBe(3)
    askShangshi(game, 'draw')
    expect(playerOf(game, 'p0').zones.hand, '补到 3 张').toHaveLength(3)
  })

  it('放弃一次之后，状态再变还能再问', () => {
    const game = gameAt('zch-again')
    arrange(game, 1, 0)
    expect(askShangshi(game, 'cancel').asked, '第一次问了').toBe(true)
    expect(playerOf(game, 'p0').zones.hand, '放弃了就没摸').toHaveLength(0)

    // 同一个状态不再重复问
    expect(askShangshi(game, 'draw').asked, '状态没变就不再问').toBe(false)

    /*
     * 状态变了（又掉一点体力）就该重新问——
     * 「放弃过一次就整局不能再发动」是错的。
     */
    playerOf(game, 'p0').maxHp += 1
    expect(askShangshi(game, 'draw').asked, '状态变了可以再问').toBe(true)
    expect(playerOf(game, 'p0').zones.hand.length, '这次补上了').toBeGreaterThan(0)
  })

  it('一次被拿走多张手牌只问一次', () => {
    const game = gameAt('zch-atomic')
    arrange(game, 1, 3)
    const owner = playerOf(game, 'p0')
    const taken = [...owner.zones.hand]
    let asks = 0
    // 一次原子移动带走全部手牌
    for (const cardId of taken) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'hand', playerId: 'p1' })
    }
    game.dispatch('LoseCard', { playerId: 'p0', cardIds: taken, reason: 'test' }, { sourceId: 'p0', cardIds: taken })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('伤逝')) {
        asks += 1
        return { optionId: 'draw' }
      }
      return null
    })
    expect(asks, '三张一次拿走只问一次').toBe(1)
    expect(playerOf(game, 'p0').zones.hand, '补到已损失体力值').toHaveLength(lostHpOf(game.state, 'p0'))
    assertCardConservation(game.state)
  })
})
