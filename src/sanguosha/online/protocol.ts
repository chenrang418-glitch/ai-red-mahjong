import type { AIDifficulty } from '../ai'
import type { PlayerView } from '../engine/view'
import type { PresentationEvent } from '../engine/presentation'

export interface SgsRoomSettings {
  playerCount: number
  difficulty: AIDifficulty
  turnSeconds: number
}

export interface SgsChatMessage {
  id: number
  userId: string
  /**
   * 说话人的座位号。
   *
   * 房间视图里的座位是按观看者脱敏过的，不带 userId，客户端没法自己反查是谁说的。
   * 靠昵称匹配不严谨，所以由服务端直接带上——牌桌上的气泡要挂到具体座位。
   * 旧的持久化消息没有这个字段，但气泡只在实时帧上冒，取不到就不冒。
   */
  seatId?: number
  nickname: string
  text: string
  at: number
}

/**
 * 快捷短语。和麻将同一套思路：牌局中打字来不及，常用的几句直接一点就发。
 * 表情单独一行，按钮做得方一点，手机上才点得准。
 */
export const SGS_QUICK_CHAT_MESSAGES = [
  '快点快点', '你会不会玩？', '666', '乐乐', '我是良民', '相信我',
] as const

export const SGS_QUICK_CHAT_EMOJIS = ['😂', '👍', '😅', '😎', '😡', '😭', '⚔️', '🎉'] as const

export interface SgsActionMetadata {
  actionId?: string
  baseSeq?: number
}

export type SgsRoomCommand =
  | ({ type: 'toggle-ready' } & SgsActionMetadata)
  | ({ type: 'add-ai' } & SgsActionMetadata)
  | ({ type: 'remove-ai'; seatId: number } & SgsActionMetadata)
  | ({ type: 'start-game' } & SgsActionMetadata)
  | ({ type: 'respond'; requestId: string; payload: unknown } & SgsActionMetadata)
  | ({ type: 'act'; legalActionId: string } & SgsActionMetadata)
  | ({ type: 'advance' } & SgsActionMetadata)
  | ({ type: 'chat'; text: string } & SgsActionMetadata)
  | ({ type: 'trustee'; enabled: boolean } & SgsActionMetadata)
  | ({ type: 'next-round' } & SgsActionMetadata)
  | ({ type: 'leave-room' } & SgsActionMetadata)

type WithoutActionMetadata<T> = T extends SgsActionMetadata ? Omit<T, 'actionId' | 'baseSeq'> : never
export type SgsCommandDraft = WithoutActionMetadata<SgsRoomCommand>

export interface SgsRoomView {
  code: string
  version: number
  phase: 'lobby' | 'playing' | 'finished'
  hostUserId: string
  settings: SgsRoomSettings
  seats: Array<{
    seatId: number
    kind: 'empty' | 'human' | 'ai'
    name: string
    connected: boolean
    ready: boolean
    trustee: boolean
    leftRoom: boolean
    nextRoundReady: boolean
    isSelf: boolean
  }>
  playerView: PlayerView | null
  chat: SgsChatMessage[]
  log: string[]
  presentationEvents: PresentationEvent[]
  deadlineAt: number | null
  aiThinking: boolean
}

export interface SgsRoomDirectoryEntry {
  code: string
  phase: SgsRoomView['phase']
  hostNickname: string
  players: Array<{ nickname: string; connected: boolean; isHost: boolean; kind: 'human' | 'ai'; trustee: boolean }>
  occupiedSeats: number
  availableSeats: number
  settings: SgsRoomSettings
  rejoinable: boolean
  joinable: boolean
  updatedAt: number
}

export type SgsRoomServerMessage =
  | { type: 'room-state'; room: SgsRoomView }
  | { type: 'chat'; message: SgsChatMessage }
  | { type: 'error'; message: string }
  | { type: 'pong'; at: number }

export const DEFAULT_SGS_ROOM_SETTINGS: SgsRoomSettings = {
  playerCount: 5,
  difficulty: 'normal',
  turnSeconds: 30,
}
