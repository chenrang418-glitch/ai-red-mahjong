import type { GameId } from './gameManifest'

export type AppRoute =
  | { kind: 'portal' }
  | { kind: 'game'; gameId: GameId }

const GAME_IDS = new Set<GameId>(['mahjong', 'sanguosha'])

export function resolveAppRoute(url: URL): AppRoute {
  if (url.hash === '#admin') return { kind: 'game', gameId: 'mahjong' }

  const game = url.searchParams.get('game')
  if (game && GAME_IDS.has(game as GameId)) return { kind: 'game', gameId: game as GameId }

  // 旧麻将分享链接没有 game 参数，必须继续直接进入麻将联机大厅。
  if (!game && url.searchParams.has('room')) return { kind: 'game', gameId: 'mahjong' }
  return { kind: 'portal' }
}

export function buildGameUrl(current: URL, gameId: GameId): URL {
  const next = new URL(current)
  next.searchParams.set('game', gameId)
  next.searchParams.delete('room')
  next.hash = ''
  return next
}

export function buildPortalUrl(current: URL): URL {
  const next = new URL(current)
  next.searchParams.delete('game')
  next.searchParams.delete('room')
  next.hash = ''
  return next
}
