import type { SgsRoomCommand } from './sanguosha-room-core'

const MAX_ID_LENGTH = 128
const MAX_CHAT_LENGTH = 2000
const MAX_PAYLOAD_DEPTH = 8
const MAX_PAYLOAD_ITEMS = 128

export class InvalidSgsWireCommandError extends Error {
  constructor() {
    super('请求格式不正确')
    this.name = 'InvalidSgsWireCommandError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new InvalidSgsWireCommandError()
  }
  return value
}

function requireBaseSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidSgsWireCommandError()
  }
  return value
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new InvalidSgsWireCommandError()
  return value
}

function requireSeatId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 7) {
    throw new InvalidSgsWireCommandError()
  }
  return value
}

/**
 * Request payload 的具体合法性由同一套规则引擎验证；入口这里只允许有界 JSON，
 * 防止超深或超大的对象进入房间状态和错误路径。
 */
function requireBoundedJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_PAYLOAD_DEPTH) throw new InvalidSgsWireCommandError()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (value.length > MAX_PAYLOAD_ITEMS) throw new InvalidSgsWireCommandError()
    return value.map((item) => requireBoundedJson(item, depth + 1))
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_PAYLOAD_ITEMS) throw new InvalidSgsWireCommandError()
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key.length > MAX_ID_LENGTH) throw new InvalidSgsWireCommandError()
    return [key, requireBoundedJson(item, depth + 1)]
  }))
}

function metadata(input: Record<string, unknown>) {
  return { actionId: requireId(input.actionId), baseSeq: requireBaseSeq(input.baseSeq) }
}

/** 将不可信 WebSocket JSON 收窄成全新的 SgsRoomCommand。 */
export function parseSgsRoomCommand(input: unknown): SgsRoomCommand {
  if (!isRecord(input) || typeof input.type !== 'string') throw new InvalidSgsWireCommandError()
  const meta = metadata(input)

  switch (input.type) {
    case 'toggle-ready':
    case 'add-ai':
    case 'start-game':
    case 'advance':
    case 'next-round':
    case 'leave-room':
      return { type: input.type, ...meta }
    case 'remove-ai':
      return { type: input.type, seatId: requireSeatId(input.seatId), ...meta }
    case 'respond':
      return { type: input.type, requestId: requireId(input.requestId), payload: requireBoundedJson(input.payload), ...meta }
    case 'act':
      return { type: input.type, legalActionId: requireId(input.legalActionId), ...meta }
    case 'chat': {
      if (typeof input.text !== 'string' || input.text.length > MAX_CHAT_LENGTH) throw new InvalidSgsWireCommandError()
      return { type: input.type, text: input.text, ...meta }
    }
    case 'trustee':
      return { type: input.type, enabled: requireBoolean(input.enabled), ...meta }
    default:
      throw new InvalidSgsWireCommandError()
  }
}
