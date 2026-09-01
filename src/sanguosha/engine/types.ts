import type { GameRequest } from './requests'

export const RULESET_VERSION = 'ruleset-v1' as const

export type RulesetVersion = typeof RULESET_VERSION
export type PlayerId = string
export type CardId = string
export type CharacterId = string
export type Identity = 'lord' | 'loyalist' | 'rebel' | 'renegade'
export type Kingdom = 'wei' | 'shu' | 'wu' | 'qun'
export type Suit = 'spade' | 'heart' | 'club' | 'diamond'
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13
export type CardColor = 'red' | 'black'
export type DamageNature = 'normal' | 'fire' | 'thunder'
export type CardCategory = 'basic' | 'trick' | 'equipment'
export type EquipmentSlot = 'weapon' | 'armor' | 'offensiveHorse' | 'defensiveHorse'
export type TurnPhase = 'prepare' | 'judge' | 'draw' | 'play' | 'discard' | 'finish'
export type GameStatus = 'setup' | 'choosing-general' | 'playing' | 'game-over'

export interface PhysicalCard {
  id: CardId
  ruleset: RulesetVersion
  expansion: 'standard' | 'maneuvering'
  name: string
  suit: Suit
  rank: Rank
  color: CardColor
  category: CardCategory
  damageNature?: DamageNature
  equipmentSlot?: EquipmentSlot
  attackRange?: number
}

export interface EquipmentZone {
  weapon: CardId | null
  armor: CardId | null
  offensiveHorse: CardId | null
  defensiveHorse: CardId | null
}

export interface PlayerZones {
  hand: CardId[]
  equipment: EquipmentZone
  judgingArea: CardId[]
}

export interface PlayerState {
  id: PlayerId
  seat: number
  nickname: string
  isHuman: boolean
  alive: boolean
  identity: Identity
  identityRevealed: boolean
  characterId: CharacterId | null
  hp: number
  maxHp: number
  chained: boolean
  faceDown: boolean
  zones: PlayerZones
  marks: Record<string, number>
  usedLimitedSkills: string[]
  distanceFromOthers: number
  distanceToOthers: number
  attackRangeBonus: number
}

export interface GameZones {
  drawPile: CardId[]
  discardPile: CardId[]
  processingArea: CardId[]
}

export interface GameResult {
  winningCamp: 'lord' | 'rebel' | 'renegade'
  winnerIds: PlayerId[]
  reason: string
}

export interface GameSetupPlayer {
  id: PlayerId
  nickname: string
  isHuman: boolean
}

export interface GameSetup {
  mode: 'identity'
  players: GameSetupPlayer[]
  generalChoices: number
}

export interface GameDecision {
  index: number
  requestId: string
  playerId: PlayerId
  kind: string
  payload: unknown
}

export interface DyingState {
  playerId: PlayerId
  sourceId: PlayerId | null
  damageNature: DamageNature
  responderOrder: PlayerId[]
  responderIndex: number
  requestId: string | null
}

/** 主公技代打的询问进度。完全可序列化。 */
export interface SurrogateProgress {
  skillId: string
  order: PlayerId[]
  index: number
}

export interface SlashResolutionState {
  kind: 'slash'
  cardId: CardId
  sourceId: PlayerId
  targetId: PlayerId
  damageNature: DamageNature
  damageAmount: number
  stage: 'awaiting-dodge' | 'awaiting-dying'
  requestId: string | null
  /**
   * 主公技代打（护驾）的询问进度。
   * 目标自己放弃之后才开始，`null` 表示还没开始或这局用不到。
   */
  surrogate: SurrogateProgress | null
}

/**
 * 锦囊在效果阶段自己要等的东西。
 * 全部是可序列化的纯数据：Durable Object 随时可能休眠，
 * 不能把「等某人出杀」挂在一个 await 上。
 */
export type TrickEffectState =
  /** 南蛮入侵：当前目标要打出【杀】，否则受伤 */
  | { kind: 'ask-slash'; targetId: PlayerId; requestId: string }
  /** 万箭齐发：当前目标要打出【闪】，否则受伤 */
  | { kind: 'ask-dodge'; targetId: PlayerId; requestId: string }
  /** 决斗：轮流出【杀】，先出不出来的一方受伤。responderId 是当前该出杀的人 */
  | { kind: 'duel'; responderId: PlayerId; otherId: PlayerId; requestId: string }
  /** 过河拆桥 / 顺手牵羊：由使用者从目标区域里挑一张 */
  | { kind: 'pick-card'; targetId: PlayerId; mode: 'discard' | 'steal'; requestId: string }
  /** 五谷丰登：亮出的牌摆在处理区，逐个目标挑走一张 */
  | { kind: 'harvest'; targetId: PlayerId; revealedCardIds: CardId[]; requestId: string }
  /** 火攻第一步：目标展示一张手牌 */
  | { kind: 'fire-reveal'; targetId: PlayerId; requestId: string }
  /** 火攻第二步：使用者弃一张同花色的牌才能造成火焰伤害 */
  | { kind: 'fire-discard'; targetId: PlayerId; revealedCardId: CardId; suit: Suit; requestId: string }
  /** 借刀杀人：目标要对第三人出杀，否则把武器交给使用者 */
  | { kind: 'borrowed-knife'; targetId: PlayerId; victimId: PlayerId; weaponCardId: CardId; requestId: string }
  /** 借刀杀人：目标真的出了杀，轮到受害者出闪 */
  | { kind: 'knife-dodge'; attackerId: PlayerId; victimId: PlayerId; requestId: string }

export interface TrickResolutionState {
  kind: 'trick'
  cardId: CardId
  cardName: string
  sourceId: PlayerId
  /**
   * 全部目标，按结算顺序。单目标锦囊只有一个元素。
   * 多目标锦囊每个目标各问一次无懈——无懈取消的是「对某一个目标的效果」，不是整张牌。
   */
  targetIds: PlayerId[]
  /** 正在为第几个目标问无懈 / 结算效果 */
  targetIndex: number
  /** 已经被无懈掉的目标，最终 CardResolved 要报告 */
  nullifiedTargetIds: PlayerId[]
  stage: 'awaiting-nullification' | 'awaiting-effect'
  responderOrder: PlayerId[]
  responderIndex: number
  nullificationCount: number
  requestId: string | null
  effect: TrickEffectState | null
  /** 五谷丰登亮出的牌：整张牌结算期间共用一批，中途不重新亮 */
  harvestPool?: CardId[]
}

export type CardResolutionState = SlashResolutionState | TrickResolutionState

export interface TurnUsageState {
  slashUses: number
  wineUses: number
  wineDamageBonus: number
}

export interface DamageChainState {
  sourceId: PlayerId | null
  nature: Exclude<DamageNature, 'normal'>
  amount: number
  remainingTargetIds: PlayerId[]
}

export interface JudgmentNullificationState {
  playerId: PlayerId
  delayedCardId: CardId
  stage: 'awaiting-nullification'
  responderOrder: PlayerId[]
  responderIndex: number
  nullificationCount: number
  requestId: string
}

export interface JudgmentDamageState {
  playerId: PlayerId
  delayedCardId: CardId
  stage: 'awaiting-damage'
}

export type JudgmentState = JudgmentNullificationState | JudgmentDamageState

/**
 * 技能发起 Request 之后的等待状态。
 *
 * 必须完全可序列化——Durable Object 随时可能休眠，
 * 技能不能靠闭包记住「我问到哪一步了」。
 * `data` 只放技能自己的可序列化局部变量。
 */
export interface SkillResolutionState {
  kind: 'skill'
  skillId: string
  ownerId: PlayerId
  /** 技能自定义的步骤名，恢复时靠它分支 */
  step: string
  requestId: string
  data: Record<string, unknown>
}

/**
 * 排队等待发问的技能。
 *
 * 「受到伤害后」这类时机不能当场发问：伤害结算还没走完，
 * 等玩家回答时牌可能已经移动，濒死救援也可能正插在中间。
 * 所以技能在触发时先把需要的事实抓下来放进队列，
 * 等牌局回到干净的状态再问。整条都是可序列化的。
 */
export interface QueuedSkillPrompt {
  skillId: string
  ownerId: PlayerId
  step: string
  data: Record<string, unknown>
}

export interface SanguoshaState {
  rulesetVersion: RulesetVersion
  seed: string
  setup: GameSetup
  seq: number
  status: GameStatus
  players: PlayerState[]
  cards: Record<CardId, PhysicalCard>
  zones: GameZones
  currentPlayerId: PlayerId
  turnNumber: number
  phase: TurnPhase
  skippedPhases: TurnPhase[]
  turnUsage: TurnUsageState
  pendingRequests: GameRequest[]
  dying: DyingState | null
  damageChain: DamageChainState | null
  judgment: JudgmentState | null
  cardResolution: CardResolutionState | null
  skillResolution: SkillResolutionState | null
  skillQueue: QueuedSkillPrompt[]
  decisions: GameDecision[]
  result: GameResult | null
}

export function emptyEquipment(): EquipmentZone {
  return { weapon: null, armor: null, offensiveHorse: null, defensiveHorse: null }
}
