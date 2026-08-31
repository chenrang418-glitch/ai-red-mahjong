import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from '../server/room-core'
import { isSeedBearingMatchId } from '@/game/rng'
import type { GameState } from '@/game/types'
import type { OnlineRoomSettings } from '@/online/types'

const settings: OnlineRoomSettings = {
  mode: 'finite',
  initialPoints: 30,
  claimWindowMs: 4000,
  turnWindowMs: 30_000,
}

/** 开一局四个真人的牌局，方便逐个视角检查下发内容。 */
function startedRoom(): RoomCoordinator {
  const room = RoomCoordinator.create('ABC234', { userId: 'u0', nickname: '玩家零' }, settings, 1000)
  for (const id of [1, 2, 3]) {
    room.connect({ userId: `u${id}`, nickname: `玩家${id}` }, 1000 + id)
    room.handle(`u${id}`, { type: 'ready', ready: true }, 1010 + id)
  }
  room.handle('u0', { type: 'start-game' }, 1100)
  return room
}

/**
 * 让庄家打一张、抢牌窗口走完，下家真正摸到一张牌。
 * 开局发牌不走 drawTile，所以 lastDrawn 一开始是空的，得先推进一步。
 */
function playUntilSomeoneDraws(room: RoomCoordinator, at = 2000): void {
  const game = room.state.game!
  const dealerId = game.dealer
  const tile = game.players[dealerId].hand[0]
  room.handle(`u${dealerId}`, {
    type: 'discard',
    tileId: tile.id,
    actionId: 'redaction-discard',
    version: room.view(`u${dealerId}`).version,
  }, at)
  // 没人碰杠时也要等掩护时间走完才轮到下家摸牌
  room.runDueJobs(at + 60_000)
}

function gameFor(room: RoomCoordinator, userId: string): GameState {
  const game = room.view(userId).game
  if (!game) throw new Error('房间还没开局')
  return game
}

describe('下发给客户端的牌局视图不得泄露暗信息', () => {
  it('别人刚摸的牌不下发，自己的可以看到', () => {
    const room = startedRoom()
    playUntilSomeoneDraws(room)
    const server = room.state.game!
    const drawer = server.lastDrawn?.playerId
    expect(drawer).toBeTypeOf('number')
    const realTileId = server.lastDrawn!.tile.id

    // 摸牌的人自己看得到真牌
    const own = gameFor(room, `u${drawer}`)
    expect(own.lastDrawn?.tile.id).toBe(realTileId)

    // 其他三家一律看不到
    for (let seat = 0; seat < 4; seat += 1) {
      if (seat === drawer) continue
      const view = gameFor(room, `u${seat}`)
      expect(view.lastDrawn, `座位 ${seat} 不该看到别人摸的牌`).toBeNull()
      expect(JSON.stringify(view)).not.toContain(realTileId)
    }
  })

  it('别人的手牌一律是占位牌，自己的是真牌', () => {
    const room = startedRoom()
    for (let self = 0; self < 4; self += 1) {
      const view = gameFor(room, `u${self}`)
      for (const player of view.players) {
        const realHand = room.state.game!.players[player.id].hand
        if (player.id === self) {
          expect(player.hand.map((tile) => tile.id)).toEqual(realHand.map((tile) => tile.id))
        } else {
          expect(player.hand).toHaveLength(realHand.length)
          expect(player.hand.every((tile) => tile.id.startsWith('hidden-'))).toBe(true)
        }
      }
    }
  })

  it('牌墙和码区只留张数，牌面全是占位', () => {
    const room = startedRoom()
    const server = room.state.game!
    const view = gameFor(room, 'u0')
    expect(view.wall).toHaveLength(server.wall.length)
    expect(view.maReserve).toHaveLength(server.maReserve.length)
    expect(view.wall.every((tile) => tile.id.startsWith('hidden-'))).toBe(true)
    expect(view.maReserve.every((tile) => tile.id.startsWith('hidden-'))).toBe(true)
    // 真实牌墙里任意一张的 id 都不该出现在下发内容里
    const serialized = JSON.stringify(view)
    for (const tile of server.wall.slice(0, 12)) expect(serialized).not.toContain(tile.id)
  })

  it('随机源三处全部清空，matchId 也不带种子', () => {
    const room = startedRoom()
    const view = gameFor(room, 'u0')
    expect(view.seed).toBe(0)
    expect(view.rngState).toBe(0)
    expect(view.config.seed).toBeUndefined()
    expect(isSeedBearingMatchId(view.matchId)).toBe(false)
  })

  it('抢牌选项只下发自己的那一份', () => {
    const room = startedRoom()
    for (let self = 0; self < 4; self += 1) {
      const view = gameFor(room, `u${self}`)
      expect(view.claimOptions.every((option) => option.playerId === self)).toBe(true)
    }
  })

  it('别人的摸牌事件不带牌面', () => {
    const room = startedRoom()
    for (let self = 0; self < 4; self += 1) {
      const view = gameFor(room, `u${self}`)
      for (const event of view.events) {
        if (event.type !== 'draw' || event.playerId === self) continue
        expect(event.tile).toBeUndefined()
      }
    }
  })

  it('历史牌局的旧 matchId 会被换成不透明替身，事件 id 前缀同步替换', () => {
    const room = startedRoom()
    // 模拟升级前就存在的房间：那时的 matchId 直接把洗牌种子写在里面
    const legacyId = 'match-1788000000000-987654321'
    const original = room.state.game!.matchId
    room.state.game!.matchId = legacyId
    room.state.game!.events = room.state.game!.events.map((event) => ({
      ...event,
      id: event.id.replace(original, legacyId),
    }))

    const view = gameFor(room, 'u0')
    expect(isSeedBearingMatchId(view.matchId)).toBe(false)
    expect(view.matchId).not.toBe(legacyId)
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(legacyId)
    expect(serialized).not.toContain('987654321')
    // 替身要稳定：同一个房间反复下发得到同一个 id，否则客户端会当成新的一场
    expect(gameFor(room, 'u0').matchId).toBe(view.matchId)
    expect(gameFor(room, 'u1').matchId).toBe(view.matchId)
  })
})
