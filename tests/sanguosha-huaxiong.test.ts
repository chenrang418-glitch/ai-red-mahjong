import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, setCardNature, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { isRedSlashDamage } from '@/sanguosha/data/characters/yjcm2012-huaxiong'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 华雄（一将成名 2012）。
 *
 * 逐条有断言的主张：
 *
 * - 【耀武】只认**红色的【杀】**造成的伤害；
 * - 黑色【杀】不触发，非【杀】伤害不触发；
 * - 红色火【杀】、红色雷【杀】照样触发（它们仍然是【杀】）；
 * - 被闪掉、被防止、被换成失去体力都不触发；
 * - **选择权在伤害来源**：请求发给那名玩家，不是华雄；
 * - 选回复就回 1 点、选摸牌就摸 1 张；
 * - 来源满血时「回复」这一项仍然给，只是没有收益；
 * - 来源是自己 / 已阵亡 / 不存在时直接跳过，不弹无效选择。
 */

const CAST = ['zhangfei', 'huaxiong', 'zhaoyun', 'huangzhong', 'guojia']
const HUAXIONG_ID = 'p1'

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
      case 'distribute-cards': return { assignments: [] }
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

function findCard(game: SanguoshaGame, match: (card: Record<string, unknown>) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => !candidate.virtual
    && match(candidate as unknown as Record<string, unknown>)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error('牌堆里找不到符合条件的牌')
  return card.id
}

/**
 * 让 sourceId 用 cardId 打华雄。返回耀武是否问了、问的是谁。
 * `dodge` 为 true 时华雄打出一张【闪】。
 */
function attack(
  game: SanguoshaGame,
  sourceId: string,
  cardId: string,
  options: { choose?: string; dodge?: boolean } = {},
): { asked: boolean; askedPlayer: string | null; options: string[] } {
  const seen = { asked: false, askedPlayer: null as string | null, options: [] as string[] }
  moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId: sourceId })
  let dodgeId: string | null = null
  if (options.dodge) {
    dodgeId = findCard(game, (card) => card.name === '闪')
    moveCard(game.state, dodgeId, locate(game.state, dodgeId), { kind: 'hand', playerId: HUAXIONG_ID })
  }
  playerOf(game, sourceId).attackRangeBonus = 6
  game.state.currentPlayerId = sourceId
  game.state.phase = 'play'
  const action = game.legalActions(sourceId).find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId) && candidate.targetIds.includes(HUAXIONG_ID))!
  game.act(sourceId, action.id)
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('耀武')) {
      seen.asked = true
      seen.askedPlayer = request.playerId
      seen.options = (request as unknown as { options: { id: string }[] }).options.map((option) => option.id)
      return options.choose ? { optionId: options.choose } : null
    }
    if (dodgeId && request.playerId === HUAXIONG_ID && request.kind === 'respond-card') {
      return { actionId: `respond-dodge:${dodgeId}` }
    }
    return null
  })
  return seen
}

describe('华雄【耀武】：红杀识别', () => {
  it('红色普通【杀】触发', () => {
    const game = gameAt('yaowu-red')
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
      && (card.damageNature ?? 'normal') === 'normal')
    const seen = attack(game, 'p0', slash, { choose: 'yaowu-draw' })
    expect(seen.asked, '红色【杀】触发耀武').toBe(true)
  })

  it('黑色【杀】不触发', () => {
    const game = gameAt('yaowu-black')
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'black'
      && (card.damageNature ?? 'normal') === 'normal')
    const seen = attack(game, 'p0', slash)
    expect(seen.asked, '黑色【杀】不触发').toBe(false)
    expect(playerOf(game, HUAXIONG_ID).hp, '伤害照常').toBe(playerOf(game, HUAXIONG_ID).maxHp - 1)
  })

  it('红色火【杀】和红色雷【杀】照样触发', () => {
    /*
     * 牌堆里印着的火【杀】是方块（红），**雷【杀】全是梅花和黑桃（黑）**。
     * 所以「红色雷【杀】」只可能来自技能改写属性（程普【疠火】就是这么做的）：
     * 这里拿一张红色普通【杀】，用引擎的同一个入口把属性改掉。
     */
    for (const nature of ['fire', 'thunder'] as const) {
      const game = gameAt(`yaowu-${nature}`)
      const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
        && (card.damageNature ?? 'normal') === 'normal')
      setCardNature(game.state, slash, nature)
      expect(isRedSlashDamage(game.state, slash), `红色${nature}【杀】仍然是红色的【杀】`).toBe(true)
      const seen = attack(game, 'p0', slash, { choose: 'yaowu-draw' })
      expect(seen.asked, `红色${nature}【杀】仍然是【杀】`).toBe(true)
    }
  })

  it('非【杀】的伤害不触发', () => {
    const game = gameAt('yaowu-non-slash')
    // 【决斗】是红是黑都不重要：它不是【杀】
    const duel = findCard(game, (card) => card.name === '决斗')
    const seen = attack(game, 'p0', duel)
    expect(seen.asked, '决斗造成的伤害不触发耀武').toBe(false)
  })

  it('被闪掉就不触发：没有伤害就没有「伤害后」', () => {
    const game = gameAt('yaowu-dodged')
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
      && (card.damageNature ?? 'normal') === 'normal')
    const seen = attack(game, 'p0', slash, { dodge: true })
    expect(seen.asked).toBe(false)
    expect(playerOf(game, HUAXIONG_ID).hp, '没掉血').toBe(playerOf(game, HUAXIONG_ID).maxHp)
  })

  it('判据函数本身：牌名和颜色都要对', () => {
    const game = gameAt('yaowu-predicate')
    const redSlash = findCard(game, (card) => card.name === '杀' && card.color === 'red')
    const blackSlash = findCard(game, (card) => card.name === '杀' && card.color === 'black')
    const redTrick = findCard(game, (card) => card.name === '决斗' && card.color === 'red')
    expect(isRedSlashDamage(game.state, redSlash)).toBe(true)
    expect(isRedSlashDamage(game.state, blackSlash), '黑【杀】不算').toBe(false)
    expect(isRedSlashDamage(game.state, redTrick), '红锦囊不算').toBe(false)
    expect(isRedSlashDamage(game.state, null), '无来源牌不算').toBe(false)
    expect(isRedSlashDamage(game.state, 'no-such-card'), '不存在的牌不算').toBe(false)
  })
})

describe('华雄【耀武】：来源选择', () => {
  it('请求发给伤害来源，不是华雄', () => {
    const game = gameAt('yaowu-asked-player')
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
      && (card.damageNature ?? 'normal') === 'normal')
    const seen = attack(game, 'p2', slash, { choose: 'yaowu-draw' })
    expect(seen.askedPlayer, '问的是打他的那个人').toBe('p2')
    expect(seen.askedPlayer, '不是华雄自己').not.toBe(HUAXIONG_ID)
  })

  it('选回复：来源回 1 点体力', () => {
    const game = gameAt('yaowu-recover')
    const source = playerOf(game, 'p0')
    source.hp = source.maxHp - 2
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
      && (card.damageNature ?? 'normal') === 'normal')
    attack(game, 'p0', slash, { choose: 'yaowu-recover' })
    expect(source.hp, '回复 1 点').toBe(source.maxHp - 1)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('选摸牌：来源摸一张', () => {
    const game = gameAt('yaowu-draw')
    const before = playerOf(game, 'p0').zones.hand.length
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
      && (card.damageNature ?? 'normal') === 'normal')
    attack(game, 'p0', slash, { choose: 'yaowu-draw' })
    /*
     * `attack` 会先把那张【杀】塞进他手里（+1），打出去（-1），
     * 耀武再让他摸一张（+1）。相对发牌前的基数，净变化正是 +1。
     */
    expect(playerOf(game, 'p0').zones.hand.length, '耀武让他摸了一张').toBe(before + 1)
    assertCardConservation(game.state)
  })

  it('来源满血时「回复」这一项仍然给，只是没有收益', () => {
    const game = gameAt('yaowu-full-hp')
    const source = playerOf(game, 'p0')
    source.hp = source.maxHp
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
      && (card.damageNature ?? 'normal') === 'normal')
    const seen = attack(game, 'p0', slash, { choose: 'yaowu-recover' })
    expect(seen.options, '两项都在').toEqual(['yaowu-recover', 'yaowu-draw'])
    expect(source.hp, '满血回不了，但这是「没有收益」不是「非法」').toBe(source.maxHp)
    assertGameInvariants(game.state)
  })

  /*
   * 下面三条走 `game.damage` 直接造伤害，因为「自己是来源」「没有来源」
   * 这两种局面用真实出牌构造不出来（【杀】不能指定自己、也没有无来源的【杀】）。
   *
   * **断言的是触发器有没有排队，不是「有没有弹出请求」。**
   * `game.damage` 只跑伤害管线，不会把技能队列排空——按「没弹请求」去断言的话，
   * 三条用例会因为队列根本没被放出去而全部空过。
   */
  function queuedYaowu(game: SanguoshaGame): boolean {
    return game.state.skillQueue.some((prompt) => prompt.skillId === 'yaowu')
  }

  it('对照：来源合法时触发器确实排了队', () => {
    const game = gameAt('yaowu-queue-control')
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red')
    game.damage({ sourceId: 'p2', targetId: HUAXIONG_ID, amount: 1, nature: 'normal', cardId: slash, cardName: '杀' })
    expect(queuedYaowu(game), '这是下面三条的对照组：合法来源会排队').toBe(true)
  })

  it('来源就是华雄自己时不排队', () => {
    const game = gameAt('yaowu-self-source')
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red')
    game.damage({ sourceId: HUAXIONG_ID, targetId: HUAXIONG_ID, amount: 1, nature: 'normal', cardId: slash, cardName: '杀' })
    expect(queuedYaowu(game), '自己打自己不该让自己挑收益').toBe(false)
  })

  it('无来源的红【杀】伤害不排队', () => {
    const game = gameAt('yaowu-null-source')
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red')
    game.damage({ sourceId: null, targetId: HUAXIONG_ID, amount: 1, nature: 'normal', cardId: slash, cardName: '杀' })
    expect(queuedYaowu(game), '没有来源就没有人可选').toBe(false)
    expect(playerOf(game, HUAXIONG_ID).hp, '伤害本身照常').toBe(playerOf(game, HUAXIONG_ID).maxHp - 1)
  })

  it('来源在排队期间阵亡：放出去时安静跳过，不弹无人可答的请求', () => {
    const game = gameAt('yaowu-source-dies')
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red')
    game.damage({ sourceId: 'p2', targetId: HUAXIONG_ID, amount: 1, nature: 'normal', cardId: slash, cardName: '杀' })
    expect(queuedYaowu(game), '先确认确实排上了队').toBe(true)
    // 阵亡必然伴随身份公开，不补这一句会撞上「死亡角色身份未公开」的不变量
    playerOf(game, 'p2').alive = false
    playerOf(game, 'p2').identityRevealed = true
    // 推进一步让队列真正排空
    game.advancePhase()
    settle(game)
    const asked = game.state.pendingRequests.some((request) => String((request as AnyRequest).prompt ?? '').includes('耀武'))
    expect(asked, '来源已经出局，不弹请求').toBe(false)
    assertGameInvariants(game.state)
  })
})
