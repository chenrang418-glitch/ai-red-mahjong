import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { isCardUseProhibited } from '@/sanguosha/engine/skills/runtime'
import { slashUseOptions } from '@/sanguosha/engine/ask-use-slash'
import { CHUN_PILE, chunOf } from '@/sanguosha/data/characters/yjcm2012-chengpu'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 「视为使用」同样受封牌规则约束。
 *
 * 这条通则原本有**三个漏口**，三个都在这里钉住：
 *
 * 1. `legalPlayActions` 末尾那道封牌过滤只筛 `use-card` 动作，
 *    筛不到主动技按钮 → 靠 `activeActionUsesCard` 声明；
 * 2. `useVirtualWine` 自己不查禁令 → 现在查，并返回 false；
 * 3. `beginVirtualSlash` 和 `slashUseOptions` 同样不查 → 现在都查。
 *
 * 每条「被挡住」的断言旁边都有一条**不封牌时正常成立**的反证，
 * 否则断言可能是空的。
 */

const YIXING_BLOCK = (ownerId: string) => `ligui:play-blocked:${ownerId}`

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function drain(game: SanguoshaGame): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const pick = request as unknown as {
      cardIds?: string[]; hiddenCardSlots?: string[]; candidateIds?: string[]
      options?: { id: string }[]; min?: number
    }
    const payload: Record<string, unknown> = request.kind === 'choose-cards'
      ? { cardIds: [...(pick.cardIds ?? []), ...(pick.hiddenCardSlots ?? [])].slice(0, pick.min ?? 0) }
      : request.kind === 'choose-targets'
        ? { targetIds: (pick.candidateIds ?? []).slice(0, pick.min ?? 0) }
        : request.kind === 'choose-option'
          ? { optionId: pick.options![pick.options!.length - 1].id }
          : request.kind === 'rescue' ? { actionId: 'rescue-pass' } : { actionId: 'respond-pass' }
    game.respond({ requestId: request.id, playerId: request.playerId, payload })
  }
  throw new Error('结算没有收敛')
}

function gameAt(seed: string, characterIds: string[]): SanguoshaGame {
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
  drain(game)
  return game
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

/** 让 p0（一行）把 targetId 的用牌封住。 */
function blockCardUse(game: SanguoshaGame, targetId: string): void {
  playerOf(game, targetId).marks[YIXING_BLOCK('p0')] = game.state.turnNumber
  game.state.currentPlayerId = targetId
  game.state.phase = 'play'
}

function jiushiAction(game: SanguoshaGame, playerId: string) {
  return game.legalActions(playerId).find((action) => action.kind === 'invoke-skill'
    && String(action.label).includes('酒诗'))
}

describe('封牌规则 × 曹植【酒诗】', () => {
  it('被封牌时按钮不出现，而且用不出【酒】', () => {
    const game = gameAt('prohibit-jiushi', ['yixing', 'caozhi', 'zhaoyun', 'huangzhong', 'guojia'])
    blockCardUse(game, 'p1')
    expect(isCardUseProhibited(game.state, 'p1', '酒', { dyingPlayerId: null }), '前提：他确实被封牌了').toBe(true)

    expect(jiushiAction(game, 'p1'), '按钮不该出现').toBeUndefined()
    expect(game.state.turnUsage.wineUses, '酒没有生效').toBe(0)
    expect(playerOf(game, 'p1').faceDown, '也没有白翻一次面').toBe(false)
  })

  it('反证：不封牌时按钮出现、酒生效、武将牌翻面', () => {
    const game = gameAt('prohibit-jiushi-control', ['yixing', 'caozhi', 'zhaoyun', 'huangzhong', 'guojia'])
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    expect(isCardUseProhibited(game.state, 'p1', '酒', { dyingPlayerId: null }), '前提：没有封牌').toBe(false)

    const action = jiushiAction(game, 'p1')
    expect(action, '不封牌时按钮该出现').toBeDefined()
    game.act('p1', action!.id)
    drain(game)
    expect(game.state.turnUsage.wineUses, '酒真的用出去了').toBe(1)
    expect(playerOf(game, 'p1').faceDown, '武将牌翻面了').toBe(true)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('封牌规则 × 程普【醇醪】', () => {
  /** 摆一张「醇」，把 victim 打进濒死，返回醇醪是否被提供 / 生效。 */
  function rescueScene(seed: string, blockVictim: boolean) {
    const game = gameAt(seed, ['yixing', 'chengpu', 'zhaoyun', 'huangzhong', 'guojia'])
    // 程普武将牌上放一张「醇」
    const chun = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '杀')!
    moveCard(game.state, chun, { kind: 'drawPile' }, { kind: 'characterPile', playerId: 'p1', pile: CHUN_PILE })

    const victim = playerOf(game, 'p2')
    victim.hp = 1
    if (blockVictim) victim.marks[YIXING_BLOCK('p0')] = game.state.turnNumber

    const slash = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p3' })
    playerOf(game, 'p3').attackRangeBonus = 6
    game.state.currentPlayerId = 'p3'
    game.state.phase = 'play'
    const action = game.legalActions('p3').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes('p2'))!
    game.act('p3', action.id)

    /*
     * **逐条应答**，不能碰到第一条不匹配的请求就 `drain` 掉全部——
     * 那样会把程普自己那条救援请求也用默认答案答掉，
     * 「有没有给出醇醪」永远读不到。
     */
    let offered = false
    for (let guard = 0; guard < 80; guard += 1) {
      const request = game.state.pendingRequests[0] as (AnyRequest & {
        actionIds?: string[]; cardIds?: string[]; hiddenCardSlots?: string[]
        candidateIds?: string[]; options?: { id: string }[]; min?: number
      }) | undefined
      if (!request) break
      if (request.kind === 'rescue' && request.playerId === 'p1') {
        offered = (request.actionIds ?? []).includes('chunlao-rescue')
        game.respond({
          requestId: request.id, playerId: 'p1',
          payload: { actionId: offered ? 'chunlao-rescue' : 'rescue-pass' },
        })
        continue
      }
      const payload: Record<string, unknown> = request.kind === 'choose-cards'
        ? { cardIds: [...(request.cardIds ?? []), ...(request.hiddenCardSlots ?? [])].slice(0, request.min ?? 0) }
        : request.kind === 'choose-targets'
          ? { targetIds: (request.candidateIds ?? []).slice(0, request.min ?? 0) }
          : request.kind === 'choose-option'
            ? { optionId: request.options![request.options!.length - 1].id }
            : request.kind === 'rescue' ? { actionId: 'rescue-pass' } : { actionId: 'respond-pass' }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
    }
    return { game, offered, chunLeft: chunOf(game.state, 'p1').length, victimAlive: playerOf(game, 'p2').alive }
  }

  it('反证：濒死者没被封牌时，醇醪救得起来而且醇被移去', () => {
    const scene = rescueScene('prohibit-chunlao-control', false)
    expect(scene.offered, '救援面板给出了醇醪').toBe(true)
    expect(scene.victimAlive, '被救活了').toBe(true)
    expect(scene.chunLeft, '醇被移去一张').toBe(0)
    assertCardConservation(scene.game.state)
  })

  it('濒死者被封牌时，醇不会白白花掉', () => {
    const scene = rescueScene('prohibit-chunlao', true)
    /*
     * 关键是**代价不能白付**：无论救援面板给不给这一项，
     * 只要那个人用不出【酒】，武将牌上的「醇」就必须原封不动。
     */
    if (!scene.victimAlive) expect(scene.chunLeft, '没救成就不该扣掉醇').toBe(1)
    assertCardConservation(scene.game.state)
    assertGameInvariants(scene.game.state)
  })
})

describe('封牌规则 × 「令某角色使用一张【杀】」', () => {
  it('被封牌的人不进候选（挑衅、明策、眩惑、耍剑、乱武共用这一份）', () => {
    const game = gameAt('prohibit-slashuse', ['yixing', 'jiangwei', 'zhaoyun', 'huangzhong', 'guojia'])
    const slash = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p2' })
    playerOf(game, 'p2').attackRangeBonus = 6

    // 反证先行：不封牌时他确实使得出【杀】
    expect(slashUseOptions(game.state, 'p2', 'p1').length, '前提：不封牌时有得用').toBeGreaterThan(0)

    playerOf(game, 'p2').marks[YIXING_BLOCK('p0')] = game.state.turnNumber
    game.state.currentPlayerId = 'p2'
    game.state.phase = 'play'
    expect(isCardUseProhibited(game.state, 'p2', '杀', { dyingPlayerId: null }), '前提：他被封牌了').toBe(true)
    expect(slashUseOptions(game.state, 'p2', 'p1'), '被封牌的人一张都拿不出来').toHaveLength(0)
  })

  it('beginVirtualSlash 自己也挡得住，而且不留下半场结算', () => {
    const game = gameAt('prohibit-virtual-slash', ['yixing', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    playerOf(game, 'p1').marks[YIXING_BLOCK('p0')] = game.state.turnNumber
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'

    const hpBefore = playerOf(game, 'p2').hp
    const used = game.beginVirtualSlash({ sourceId: 'p1', targetId: 'p2', sourceSkillId: 'audit' })
    expect(used, '返回 false：这次没用出去').toBe(false)
    expect(game.state.cardResolution, '不能留下一个半场的结算').toBeNull()
    expect(playerOf(game, 'p2').hp, '目标没掉血').toBe(hpBefore)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('反证：不封牌时同一次调用真的打出去了', () => {
    const game = gameAt('prohibit-virtual-slash-control', ['yixing', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const hpBefore = playerOf(game, 'p2').hp
    const used = game.beginVirtualSlash({ sourceId: 'p1', targetId: 'p2', sourceSkillId: 'audit' })
    expect(used, '返回 true').toBe(true)
    drain(game)
    expect(playerOf(game, 'p2').hp, '目标掉了血').toBe(hpBefore - 1)
    assertCardConservation(game.state)
  })
})
