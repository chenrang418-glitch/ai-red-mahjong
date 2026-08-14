export type Suit = 'wan' | 'dot' | 'bamboo' | 'zhong'

export interface Tile {
  id: string
  suit: Suit
  rank: number | null
}

export type MeldType = 'peng' | 'ming-gang' | 'an-gang' | 'bu-gang'

export interface Meld {
  id: string
  type: MeldType
  tiles: Tile[]
  fromPlayer?: number
}

export type Personality = 'fast' | 'balanced' | 'closed' | 'no-zhong' | 'humanlike'
export type Difficulty = 'beginner' | 'standard' | 'expert'
export type ThinkingSpeed = 'fast' | 'normal' | 'slow' | 'dreamy'

export interface AIProfile {
  personality: Personality
  difficulty: Difficulty
  speed: ThinkingSpeed
}

export interface PlayerStats {
  wins: number
  sevenPairsWins: number
  gangCount: number
  maCount: number
  netPoints: number
}

export interface PlayerState {
  id: number
  name: string
  isHuman: boolean
  hand: Tile[]
  melds: Meld[]
  discards: Tile[]
  points: number | null
  ai: AIProfile | null
  stats: PlayerStats
}

export type MatchMode = 'finite' | 'unlimited'
export type GamePhase = 'setup' | 'rolling' | 'playing' | 'claiming' | 'settlement' | 'match-over'
export type TurnStage = 'after-draw' | 'must-discard'
export type ClaimAction = 'peng' | 'ming-gang'

export interface PlayerSetup {
  name: string
  isHuman: boolean
  initialPoints: number
  ai: AIProfile | null
}

export interface MatchConfig {
  mode: MatchMode
  players: PlayerSetup[]
  seed?: number
  claimWindowMs: number
}

export interface DiceRoll {
  playerId: number
  dice: [number, number]
  total: number
}

export interface ClaimOption {
  playerId: number
  actions: ClaimAction[]
}

export interface LastDiscard {
  playerId: number
  tile: Tile
}

export interface PointTransfer {
  id: string
  round: number
  reason: 'self-draw' | 'ma' | 'an-gang' | 'bu-gang' | 'ming-gang'
  fromPlayer: number
  toPlayer: number
  requested: number
  paid: number
}

export interface GameEvent {
  id: string
  round: number
  type:
    | 'match-start'
    | 'dice'
    | 'round-start'
    | 'draw'
    | 'discard'
    | 'peng'
    | 'ming-gang'
    | 'an-gang'
    | 'bu-gang'
    | 'claim-pass'
    | 'win'
    | 'draw-game'
    | 'match-over'
    | 'ai-change'
  playerId?: number
  tile?: Tile
  detail: string
  at: number
}

export interface RoundResult {
  type: 'win' | 'draw' | 'bankruptcy' | 'manual'
  winnerId?: number
  winKind?: 'normal' | 'seven-pairs'
  hasRedZhong?: boolean
  maTiles: Tile[]
  maCount: number
  detail: string
}

export interface GameState {
  schemaVersion: 1
  matchId: string
  config: MatchConfig
  phase: GamePhase
  turnStage: TurnStage
  round: number
  dealer: number
  currentPlayer: number
  diceRolls: DiceRoll[]
  players: PlayerState[]
  wall: Tile[]
  maReserve: Tile[]
  lastDiscard: LastDiscard | null
  claimOptions: ClaimOption[]
  transfers: PointTransfer[]
  events: GameEvent[]
  result: RoundResult | null
  seed: number
  rngState: number
}

export interface WinResult {
  won: boolean
  kind: 'normal' | 'seven-pairs' | null
}

export interface PublicPlayerView {
  id: number
  name: string
  handCount: number
  melds: Meld[]
  discards: Tile[]
  points: number | null
  stats: PlayerStats
}

export interface AIObservation {
  playerId: number
  hand: Tile[]
  melds: Meld[]
  players: PublicPlayerView[]
  wallCount: number
  maReserveCount: number
  dealer: number
  round: number
  lastDiscard: LastDiscard | null
  legalDiscards: string[]
  legalClaims: ClaimAction[]
  canWin: boolean
  anGangFaces: string[]
  buGangFaces: string[]
}
