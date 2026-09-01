import { describe, expect, it } from 'vitest'
import { InvalidSgsWireCommandError, parseSgsRoomCommand } from '../server/sanguosha-command-parser'

const meta = { actionId: 'action-1', baseSeq: 3 }

describe('三国杀联机指令运行时校验', () => {
  it('收窄所有指令并丢弃额外字段', () => {
    expect(parseSgsRoomCommand({ type: 'toggle-ready', ...meta, injected: true })).toEqual({ type: 'toggle-ready', ...meta })
    expect(parseSgsRoomCommand({ type: 'remove-ai', seatId: 4, ...meta })).toEqual({ type: 'remove-ai', seatId: 4, ...meta })
    expect(parseSgsRoomCommand({ type: 'respond', requestId: 'request-1', payload: { cardIds: ['c1'] }, ...meta }))
      .toEqual({ type: 'respond', requestId: 'request-1', payload: { cardIds: ['c1'] }, ...meta })
    expect(parseSgsRoomCommand({ type: 'act', legalActionId: 'legal-1', ...meta })).toEqual({ type: 'act', legalActionId: 'legal-1', ...meta })
    expect(parseSgsRoomCommand({ type: 'trustee', enabled: true, ...meta })).toEqual({ type: 'trustee', enabled: true, ...meta })
  })

  it('拒绝缺失或伪造的 actionId/baseSeq', () => {
    for (const input of [
      { type: 'advance' },
      { type: 'advance', actionId: '', baseSeq: 3 },
      { type: 'advance', actionId: 'a', baseSeq: '3' },
      { type: 'advance', actionId: 'a', baseSeq: -1 },
    ]) expect(() => parseSgsRoomCommand(input)).toThrow(InvalidSgsWireCommandError)
  })

  it('拒绝越界座位、错误布尔值和过深 payload', () => {
    expect(() => parseSgsRoomCommand({ type: 'remove-ai', seatId: 8, ...meta })).toThrow()
    expect(() => parseSgsRoomCommand({ type: 'trustee', enabled: 1, ...meta })).toThrow()
    let payload: unknown = 'leaf'
    for (let index = 0; index < 10; index += 1) payload = { nested: payload }
    expect(() => parseSgsRoomCommand({ type: 'respond', requestId: 'r', payload, ...meta })).toThrow()
  })

  it('拒绝未知指令和超长正文', () => {
    expect(() => parseSgsRoomCommand({ type: 'win-now', ...meta })).toThrow()
    expect(() => parseSgsRoomCommand({ type: 'chat', text: 'x'.repeat(2001), ...meta })).toThrow()
  })
})
