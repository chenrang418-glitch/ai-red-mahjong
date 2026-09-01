import type { AIDifficulty } from '../ai'
import type { PlayerView } from '../engine/view'

export interface SgsRoomSettings {
  playerCount: number
  difficulty: AIDifficulty
  turnSeconds: number
}

export interface SgsChatMessage {
  id: number
  userId: string
  nickname: string
  text: string
  at: number
}

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
