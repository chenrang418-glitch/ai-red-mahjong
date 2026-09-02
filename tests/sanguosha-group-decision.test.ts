import { afterEach, describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import {
  forceCompleteGroupDecision, dropDeadParticipants, playersWhoChose,
  registerGroupDecision, startGroupDecision,
} from '@/sanguosha/engine/group-decision'
import type { GameSetup, GroupDecisionState, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 多人同时决定。
 *
 * 隐私是这套机制存在的全部理由：每人各挂一个请求，而 PlayerView 只下发
 * 「发给我的那一个」，`responses` 根本不进视图——所以在收齐之前，
 * 谁也拿不到别人的选择。这里把这一点单独钉住。
 */

const YES = 'yes'
const NO = 'no'
const OPTIONS = [{ id: YES, label: '质疑' }, { id: NO, label: '不质疑' }]

/** 每个用例注册一个独立 tag，避免互相干扰。 */
let tagSeq = 0
const results: GroupDecisionState[] = []

function freshTag(): string {
  const tag = `test-group-${tagSeq += 1}`
  registerGroupDecision(tag, (_host, decision) => { results.push(decision) })
  return tag
}

afterEach(() => { results.length = 0 })

function gameWith(count = 5, seed = 'group'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index < 2 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade', 'rebel', 'loyalist', 'rebel']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = 'zhangfei'
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

function begin(game: SanguoshaGame, playerIds: PlayerId[], tag = freshTag()): string {
  startGroupDecision(game, {
    id: `decision-${tagSeq}`,
    tag,
    playerIds,
    prompt: '是否质疑',
    options: OPTIONS,
    defaultOptionId: NO,
    timeoutMs: 5_000,
  })
  return tag
}

function answer(game: SanguoshaGame, playerId: PlayerId, optionId: string): void {
  const requestId = game.state.groupDecision!.requestIds[playerId]
  game.respond({ requestId, playerId, payload: { optionId } })
}

describe('多人决定的基本流程', () => {
  it('两个人：各挂一个请求，收齐才跑续接', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2'])

    expect(game.state.pendingRequests).toHaveLength(2)
    expect(results, '还没收齐就不该结束').toHaveLength(0)

    answer(game, 'p1', YES)
    expect(results, '只回了一个也不该结束').toHaveLength(0)
    expect(game.state.pendingRequests, '另一个请求还挂着').toHaveLength(1)

    answer(game, 'p2', NO)
    expect(results).toHaveLength(1)
    expect(playersWhoChose(results[0], YES)).toEqual(['p1'])
    expect(game.state.groupDecision, '结束后要清干净').toBeNull()
    assertGameInvariants(game.state)
  })

  it('五个人全部不质疑', () => {
    const game = gameWith()
    begin(game, ['p0', 'p1', 'p2', 'p3', 'p4'])
    for (const playerId of ['p0', 'p1', 'p2', 'p3', 'p4']) answer(game, playerId, NO)
    expect(playersWhoChose(results[0], YES)).toEqual([])
    expect(playersWhoChose(results[0], NO)).toHaveLength(5)
  })

  it('多人质疑时按参与者顺序返回，不看谁先点', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2', 'p3'])
    // 故意倒着回答
    answer(game, 'p3', YES)
    answer(game, 'p2', NO)
    answer(game, 'p1', YES)
    expect(playersWhoChose(results[0], YES), '顺序按参与者列表，不按提交先后').toEqual(['p1', 'p3'])
  })

  it('一个参与者都没有时直接跑续接，不留空决定', () => {
    const game = gameWith()
    begin(game, [])
    expect(results).toHaveLength(1)
    expect(game.state.groupDecision).toBeNull()
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('死人不会成为参与者', () => {
    const game = gameWith()
    game.state.players[2].alive = false
    game.state.players[2].identityRevealed = true
    begin(game, ['p1', 'p2', 'p3'])
    expect(game.state.groupDecision!.playerIds).toEqual(['p1', 'p3'])
  })
})

describe('多人决定的隐私', () => {
  it('每个人的视图里只有发给自己的那个请求', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2', 'p3'])
    for (const viewerId of ['p1', 'p2', 'p3']) {
      const view = game.viewFor(viewerId)
      expect(view.pendingRequest?.playerId, `${viewerId} 只该看到自己的请求`).toBe(viewerId)
    }
    // 没参与的人根本没有请求
    expect(game.viewFor('p4').pendingRequest).toBeNull()
  })

  it('已经提交的选择不会出现在别人的视图里', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2', 'p3'])
    answer(game, 'p1', YES)

    /*
     * 结构化地查，不做字符串包含判断：'yes' 本来就会作为**自己请求的选项 id**
     * 合法地出现在视图里，按字符串搜只会误报。
     * 真正要守的是「视图里根本没有别人选择的载体」。
     */
    for (const viewerId of ['p2', 'p3', 'p4']) {
      const view = game.viewFor(viewerId) as unknown as Record<string, unknown>
      expect(view.groupDecision, `${viewerId} 视图里不该有多人决定的状态`).toBeUndefined()
      expect(view.responses, `${viewerId} 视图里不该有别人的回答`).toBeUndefined()
      expect(view.decisions, `${viewerId} 视图里不该有回答历史`).toBeUndefined()
      // 自己的请求可以在，但里面只有选项，没有别人的结果
      const request = game.viewFor(viewerId).pendingRequest
      expect(JSON.stringify(request ?? {}), `${viewerId} 的请求里不该提到 p1`).not.toContain('p1')
    }
  })

  it('已经提交的人自己刷新，知道自己交过了，但看不到别人', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2'])
    answer(game, 'p1', YES)

    // 断线重连＝重新取一次视图
    const view = game.viewFor('p1')
    expect(view.pendingRequest, '交过之后自己的请求就没了').toBeNull()
    expect((view as unknown as Record<string, unknown>).groupDecision, '也不该看到别人的选择').toBeUndefined()
    // 服务端仍然记着，重连之后不会被要求再选一次
    expect(game.state.groupDecision!.responses.p1).toBe(YES)
  })
})

describe('多人决定的边界', () => {
  it('同一个人不能提交两次', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2'])
    const requestId = game.state.groupDecision!.requestIds.p1
    answer(game, 'p1', YES)
    expect(() => game.respond({ requestId, playerId: 'p1', payload: { optionId: NO } })).toThrow()
    expect(game.state.groupDecision!.responses.p1, '第二次提交不能改掉第一次').toBe(YES)
  })

  it('非参与者提交会被拒绝，且不破坏状态', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2'])
    const requestId = game.state.groupDecision!.requestIds.p1
    expect(() => game.respond({ requestId, playerId: 'p4', payload: { optionId: YES } })).toThrow()

    // 状态没坏：两个人照样能正常回答
    answer(game, 'p1', NO)
    answer(game, 'p2', NO)
    expect(results).toHaveLength(1)
    assertGameInvariants(game.state)
  })

  it('非法 payload 被拒绝，请求还在', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2'])
    const requestId = game.state.groupDecision!.requestIds.p1
    expect(() => game.respond({ requestId, playerId: 'p1', payload: { optionId: '不存在的选项' } })).toThrow()
    expect(game.state.pendingRequests.some((request) => request.id === requestId), '请求要留着').toBe(true)
  })

  it('结束之后再提交会被拒绝', () => {
    const game = gameWith()
    begin(game, ['p1'])
    const requestId = game.state.groupDecision!.requestIds.p1
    answer(game, 'p1', YES)
    expect(() => game.respond({ requestId, playerId: 'p1', payload: { optionId: NO } })).toThrow()
  })

  it('超时：没回答的按默认值补齐并收尾', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2', 'p3'])
    answer(game, 'p2', YES)

    forceCompleteGroupDecision(game)

    expect(results).toHaveLength(1)
    expect(playersWhoChose(results[0], YES), '只有真答了的算质疑').toEqual(['p2'])
    expect(playersWhoChose(results[0], NO)).toEqual(['p1', 'p3'])
    expect(game.state.pendingRequests, '请求要清干净').toHaveLength(0)
    assertGameInvariants(game.state)
  })

  it('参与者中途死亡按默认值算，不会一直等他', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2'])
    answer(game, 'p1', YES)
    game.state.players[2].alive = false
    game.state.players[2].identityRevealed = true

    dropDeadParticipants(game)

    expect(results, '死者按默认值补上，决定就收齐了').toHaveLength(1)
    expect(playersWhoChose(results[0], YES)).toEqual(['p1'])
    assertGameInvariants(game.state)
  })

  it('过一遍 JSON 之后能接着答——Durable Object 休眠要靠它', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2'])
    answer(game, 'p1', YES)

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.state)))
    expect(restored.state.groupDecision!.responses.p1, '交过的答案要留着').toBe(YES)
    const requestId = restored.state.groupDecision!.requestIds.p2
    restored.respond({ requestId, playerId: 'p2', payload: { optionId: NO } })
    expect(results, '恢复之后照样能收齐').toHaveLength(1)
  })

  it('收齐却没结束是坏状态，不变量会抓出来', () => {
    const game = gameWith()
    begin(game, ['p1', 'p2'])
    // 手工伪造一个「都答了但还挂着」的状态
    game.state.groupDecision!.responses.p1 = YES
    game.state.groupDecision!.responses.p2 = NO
    expect(() => assertGameInvariants(game.state)).toThrow(/收齐/)
  })
})
