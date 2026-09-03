import type { GameId } from './gameManifest'

export type AppRoute =
  | { kind: 'portal' }
  | { kind: 'game'; gameId: GameId }

const GAME_IDS = new Set<GameId>(['mahjong', 'sanguosha'])

/**
 * 这是不是管理页。
 *
 * 全站停服时**必须放行管理页**，否则开关一旦打开就再也关不掉了——
 * 管理面板本身挂在麻将 App 的 `#admin` 下面，所以停服拦截不能只看 route.kind。
 */
export function isAdminRoute(url: URL): boolean {
  return url.hash === '#admin'
}

export function resolveAppRoute(url: URL): AppRoute {
  if (isAdminRoute(url)) return { kind: 'game', gameId: 'mahjong' }

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
