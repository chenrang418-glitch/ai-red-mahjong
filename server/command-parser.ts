import type { RoomCommand } from '../src/online/types'

/**
 * WebSocket 上收到的指令的运行时校验。
 *
 * TypeScript 的 RoomCommand 只在编译我们自己的前端时有效，线上任何人都能直接连
 * WebSocket 发任意 JSON。`JSON.parse(text) as RoomCommand` 是一句谎话：
 * { type:'trustee', enabled:{} } 会一路走到 seat.trustee = {}，把房间状态写坏。
 * 所以在进 RoomCoordinator 之前先把形状验干净。
 *
 * 这里刻意手写而不是引第三方 schema 库：要校验的就这十来条命令，
 * 为它引一个运行时依赖不划算，Worker 的包体也会变大。
 */

/** actionId / tileId / face 这类字符串给个上限，避免被塞超长内容撑爆状态。 */
const MAX_ID_LENGTH = 128
/** 聊天正文长度由 RoomCoordinator 按业务规则再截，这里只挡住明显异常的体积。 */
const MAX_CHAT_LENGTH = 2000

const GANG_TYPES = new Set(['an-gang', 'bu-gang'])
const CLAIM_ACTIONS = new Set(['peng', 'ming-gang'])
const SUITS = new Set(['wan', 'dot', 'bamboo'])

export class InvalidRoomCommandError extends Error {
  constructor() {
    // 对外只说格式不对：具体哪个字段不合法属于内部信息，没必要告诉调用方。
    super('请求格式不正确')
    this.name = 'InvalidRoomCommandError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new InvalidRoomCommandError()
  return value
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new InvalidRoomCommandError()
  }
  return value
}

/** version 用来挡住陈旧操作，必须是真正的非负整数，NaN / 字符串 / 负数一律不认。 */
function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidRoomCommandError()
  }
  return value
}

/**
 * 合法的牌面标识：万／筒／条 1-9。
 * 红中不在其中——红中是万能牌，本玩法不允许碰和杠，放行就等于开一个规则后门。
 */
function requireFace(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH) throw new InvalidRoomCommandError()
  const [suit, rankText, ...rest] = value.split('-')
  if (rest.length > 0 || !SUITS.has(suit)) throw new InvalidRoomCommandError()
  const rank = Number(rankText)
  if (!Number.isInteger(rank) || rank < 1 || rank > 9) throw new InvalidRoomCommandError()
  return value
}

/**
 * 把任意输入收成一条合法的 RoomCommand，形状不对就抛 InvalidRoomCommandError。
 * 返回的是新建对象，不会把请求里多带的字段透传进房间状态。
 */
export function parseRoomCommand(input: unknown): RoomCommand {
  if (!isRecord(input)) throw new InvalidRoomCommandError()
  const type = input.type
  if (typeof type !== 'string') throw new InvalidRoomCommandError()

  switch (type) {
    case 'ready':
      return { type, ready: requireBoolean(input.ready) }
    case 'trustee':
      return { type, enabled: requireBoolean(input.enabled) }
    case 'start-game':
    case 'leave-room':
    case 'next-round':
    case 'return-to-lobby':
      return { type }
    case 'chat': {
      if (typeof input.text !== 'string' || input.text.length > MAX_CHAT_LENGTH) {
        throw new InvalidRoomCommandError()
      }
      return { type, text: input.text, quick: requireBoolean(input.quick) }
    }
    case 'discard':
      return {
        type,
        tileId: requireId(input.tileId),
        actionId: requireId(input.actionId),
        version: requireVersion(input.version),
      }
    case 'win':
    case 'pass-claim':
      return { type, actionId: requireId(input.actionId), version: requireVersion(input.version) }
    case 'gang': {
      if (typeof input.gangType !== 'string' || !GANG_TYPES.has(input.gangType)) {
        throw new InvalidRoomCommandError()
      }
      return {
        type,
        gangType: input.gangType as 'an-gang' | 'bu-gang',
        face: requireFace(input.face),
        actionId: requireId(input.actionId),
        version: requireVersion(input.version),
      }
    }
    case 'claim': {
      if (typeof input.action !== 'string' || !CLAIM_ACTIONS.has(input.action)) {
        throw new InvalidRoomCommandError()
      }
      return {
        type,
        action: input.action as 'peng' | 'ming-gang',
        actionId: requireId(input.actionId),
        version: requireVersion(input.version),
      }
    }
    default:
      throw new InvalidRoomCommandError()
  }
}
