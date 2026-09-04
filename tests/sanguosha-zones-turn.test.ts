import { describe, expect, it } from 'vitest'
import { findLegalAction, type LegalAction } from '@/sanguosha/engine/actions'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { advancePhase, skipPhase, startPlaying } from '@/sanguosha/engine/turn'
import type { GameSetup } from '@/sanguosha/engine/types'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 3,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

describe('牌区域、合法操作与可中断阶段', () => {
  it('卡牌经手牌→处理区→弃牌堆移动后仍守恒', () => {
    const game = new SanguoshaGame({ seed: 'move', setup: setup() })
    game.start()
    const owner = game.state.players[0]
    const cardId = owner.zones.hand[0]
    moveCard(game.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'processingArea' })
    moveCard(game.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    expect(game.state.zones.discardPile).toContain(cardId)
    assertCardConservation(game.state)
  })

  it('替换装备时旧装备自动进入弃牌堆', () => {
    const game = new SanguoshaGame({ seed: 'equipment', setup: setup() })
    game.start()
    const owner = game.state.players[0]
    const weapons = Object.values(game.state.cards).filter((card) => card.equipmentSlot === 'weapon').slice(0, 2)
    for (const weapon of weapons) {
      const source = game.state.zones.drawPile.includes(weapon.id)
        ? { kind: 'drawPile' as const }
        : { kind: 'hand' as const, playerId: game.state.players.find((player) => player.zones.hand.includes(weapon.id))!.id }
      moveCard(game.state, weapon.id, source, { kind: 'equipment', playerId: owner.id, slot: 'weapon' })
    }
    expect(owner.zones.equipment.weapon).toBe(weapons[1].id)
    expect(game.state.zones.discardPile).toContain(weapons[0].id)
    assertCardConservation(game.state)
  })

  it('六阶段可跳过，结束后切到下一名存活玩家', () => {
    const game = new SanguoshaGame({ seed: 'turn', setup: setup() })
    const seen: string[] = []
    const emit = (name: Parameters<typeof game.emit>[0], payload: Record<string, unknown>) => {
      seen.push(`${name}:${payload.phase ?? payload.playerId}`)
      game.emit(name, payload)
    }
    startPlaying(game.state, emit)
    skipPhase(game.state, 'judge')
    advancePhase(game.state, emit)
    expect(game.state.phase).toBe('draw')
    while (game.state.phase !== 'finish') advancePhase(game.state, emit)
    const previous = game.state.currentPlayerId
    game.state.players[(game.state.players.find((player) => player.id === previous)!.seat + 1) % 5].alive = false
    advancePhase(game.state, emit)
    expect(game.state.currentPlayerId).not.toBe(previous)
    expect(game.state.turnNumber).toBe(2)
    // 被跳过的判定阶段自始至终没有开始过。
    // `PhaseStart` 不再由 advancePhase 发——阶段真正开始之前还有一个
    // 「付代价跳过这个阶段」的公共窗口，发出权在 phase.ts 的 beginPhaseEntry，
    // 见 tests/sanguosha-phase-skip.test.ts。这里只守 advancePhase 自己的职责：
    // 跳过的阶段被越过、回合正常交接。
    expect(seen).not.toContain('PhaseStart:judge')
    expect(seen.filter((entry) => entry.startsWith('PhaseEnd:'))).not.toContain('PhaseEnd:judge')
  })

  it('存在待处理 Request 时阶段不能推进', () => {
    const game = new SanguoshaGame({ seed: 'pause', setup: setup() })
    startPlaying(game.state, (name, payload) => { game.emit(name, payload) })
    game.state.pendingRequests.push({
      id: 'r1', kind: 'choose-option', playerId: game.state.currentPlayerId, prompt: '是否发动',
      timeoutMs: 30_000, optional: true, options: [{ id: 'yes', label: '发动' }],
    })
    expect(() => advancePhase(game.state, () => undefined)).toThrow('Request')
    expect(JSON.parse(JSON.stringify(game.state)).pendingRequests[0].kind).toBe('choose-option')
  })

  it('Engine 进入摸牌阶段实际摸两张，并在弃牌阶段生成强制选择', () => {
    const game = new SanguoshaGame({ seed: 'phase-behavior', setup: setup() })
    game.start()
    const current = game.state.players.find((player) => player.id === game.state.currentPlayerId)!
    const initialHand = current.zones.hand.length
    game.advancePhase()
    expect(game.state.phase).toBe('judge')
    game.advancePhase()
    expect(game.state.phase).toBe('draw')
    expect(current.zones.hand).toHaveLength(initialHand + 2)
    game.advancePhase()
    expect(game.state.phase).toBe('play')
    game.advancePhase()
    expect(game.state.phase).toBe('discard')
    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-cards', purpose: 'discard-phase', min: 2, max: 2, optional: false })
    expect(() => game.advancePhase()).toThrow('Request')
    const selected = current.zones.hand.slice(0, 2)
    game.respond({ requestId: request.id, playerId: current.id, payload: { cardIds: selected } })
    expect(current.zones.hand).toHaveLength(current.hp)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining(selected))
    expect(game.state.decisions.at(-1)).toMatchObject({ requestId: request.id, kind: 'choose-cards' })
    game.advancePhase()
    expect(game.state.phase).toBe('finish')
    assertCardConservation(game.state)
  })

  it('合法操作按 playerId 与 actionId 双重验证', () => {
    const actions: LegalAction[] = [
      { id: 'a1', kind: 'pass', playerId: 'p0', label: '取消', requestId: 'r1' },
      { id: 'a2', kind: 'pass', playerId: 'p1', label: '取消', requestId: 'r2' },
    ]
    expect(findLegalAction(actions, 'p0', 'a1').id).toBe('a1')
    expect(() => findLegalAction(actions, 'p0', 'a2')).toThrow('不属于')
  })
})
