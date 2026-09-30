import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { buildSpectatorView } from '@/sanguosha/engine/view'
import type { GameSetup } from '@/sanguosha/engine/types'
import { InvalidSgsCommandError, SanguoshaRoomCoordinator, TEST_SGS_ROOM_TIMING, normalizeSettings } from '../server/sanguosha-room-core'

const setup: GameSetup = {
  mode: 'identity',
  generalChoices: 1,
  players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: true })),
}

describe('纸上三国旁观视角', () => {
  it('逐个座位裁掉手牌、未公开身份、私有区和 pendingRequest', () => {
    const game = new SanguoshaGame({ seed: 'spectator-redaction', setup })
    game.state.players.forEach((player) => { player.characterId = 'caocao' })
    game.dealGenerals()

    const hiddenHandIds = game.state.players.flatMap((player) => player.zones.hand)
    const nonLord = game.state.players.find((player) => player.identity !== 'lord')!
    const privateCardId = game.state.zones.drawPile.pop()!
    game.state.privateZones = [{ id: 'secret-zone', ownerId: nonLord.id, cards: [privateCardId], visibility: 'owner' }]
    game.state.pendingRequests = [{
      id: 'secret-request',
      kind: 'choose-cards',
      playerId: nonLord.id,
      prompt: '私密选择',
      cardIds: [nonLord.zones.hand[0]],
      min: 1,
      max: 1,
    }]

    const view = buildSpectatorView(game.state)
    const json = JSON.stringify(view)
    expect(view.spectator).toBe(true)
    expect(view.pendingRequest).toBeNull()
    expect(view.requestCards).toEqual([])
    expect(view.legalActions).toEqual([])
    for (const player of view.players) {
      expect(player.hand).toBeNull()
      expect(player.privateCards).toBeNull()
      if (player.id === nonLord.id) expect(player.identity).toBeNull()
    }
    for (const cardId of [...hiddenHandIds, privateCardId]) expect(json).not.toContain(cardId)
    expect(json).not.toContain('secret-request')
    expect(json).not.toContain('私密选择')
  })

  it('旁观者进出十次不占座、不改变牌局进度，且操作与聊天都被拒绝', () => {
    const host = { userId: 'host', nickname: '房主' }
    const room = SanguoshaRoomCoordinator.create('WATCH1', host, normalizeSettings({ playerCount: 5 }), 1_000, TEST_SGS_ROOM_TIMING)
    room.handle(host.userId, { type: 'toggle-ready' }, 1_001)
    room.handle(host.userId, { type: 'start-game' }, 1_002)
    const progress = () => {
      const game = room.snapshot().game!
      return {
        seq: game.seq,
        status: game.status,
        currentPlayerId: game.currentPlayerId,
        turnNumber: game.turnNumber,
        phase: game.phase,
        requestIds: game.pendingRequests.map((request) => request.id),
        decisions: game.decisions.length,
      }
    }
    const gameBefore = progress()
    const jobsBefore = JSON.stringify(room.snapshot().jobs)

    for (let index = 0; index < 10; index += 1) {
      const watcher = { userId: `watcher-${index}`, nickname: `观众${index}` }
      expect(room.connect(watcher, 2_000 + index * 2, true)).toBeNull()
      const view = room.view(watcher.userId)
      expect(view.isSpectator).toBe(true)
      expect(view.playerView?.spectator).toBe(true)
      expect(view.seats.some((seat) => seat.isSelf)).toBe(false)
      expect(() => room.handle(watcher.userId, { type: 'act', legalActionId: 'fake' }, 2_001 + index * 2)).toThrowError(InvalidSgsCommandError)
      expect(() => room.handle(watcher.userId, { type: 'respond', requestId: 'fake', payload: {} }, 2_001 + index * 2)).toThrow('旁观者只能观看')
      expect(() => room.handle(watcher.userId, { type: 'chat', text: '不能发言' }, 2_001 + index * 2)).toThrow('旁观者只能观看')
      room.disconnect(watcher.userId, 2_002 + index * 2)
    }

    expect(progress()).toEqual(gameBefore)
    expect(JSON.stringify(room.snapshot().jobs)).toBe(jobsBefore)
    expect(room.snapshot().spectators).toEqual([])
  })
})
