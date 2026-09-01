import type { Component } from 'vue'

export type GameId = 'mahjong' | 'sanguosha'
export type GameStatus = '可游玩' | '开发中' | '敬请期待'

export interface GameDefinition {
  id: GameId | 'more'
  name: string
  subtitle: string
  status: GameStatus
  cover: string
  accent: string
  enabled: boolean
  loadApp?: () => Promise<{ default: Component }>
}

export const gameManifest: readonly GameDefinition[] = [
  {
    id: 'mahjong',
    name: '红中麻将',
    subtitle: '四人红中 · 单机与好友联机',
    status: '可游玩',
    cover: '中',
    accent: '#ce594f',
    enabled: true,
    loadApp: () => import('../App.vue'),
  },
  {
    id: 'sanguosha',
    name: '三国杀',
    subtitle: '经典身份局 · 单机与好友联机',
    status: '可游玩',
    cover: '杀',
    accent: '#d6aa55',
    enabled: true,
    loadApp: () => import('../sanguosha/SanguoshaApp.vue'),
  },
  {
    id: 'more',
    name: '更多游戏',
    subtitle: '斗地主、狼人杀等',
    status: '敬请期待',
    cover: '＋',
    accent: '#718079',
    enabled: false,
  },
] as const

export const playableGames = new Map(
  gameManifest
    .filter((game): game is GameDefinition & { id: GameId; loadApp: NonNullable<GameDefinition['loadApp']> } => Boolean(game.loadApp))
    .map((game) => [game.id, game]),
)
