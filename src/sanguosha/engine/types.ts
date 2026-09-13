import type { GameRequest } from './requests'
import type { JudgmentRetentionState } from './judgment-retention'
import type { ForcedAwakening } from './forced-awakening'
import type { SkillGrantSource } from './skill-grant-source'
import type { CardNameHistory } from './card-name-history'
import type { Faction } from '../shared/factions'

export const RULESET_VERSION = 'ruleset-v1' as const

export type RulesetVersion = typeof RULESET_VERSION
export type PlayerId = string
export type CardId = string
export type CharacterId = string
export type Identity = 'lord' | 'loyalist' | 'rebel' | 'renegade'
export type Kingdom = Faction
export type Suit = 'spade' | 'heart' | 'club' | 'diamond'
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13
export type CardColor = 'red' | 'black'
export type DamageNature = 'normal' | 'fire' | 'thunder'
export type CardCategory = 'basic' | 'trick' | 'equipment'
/**
 * 装备栏。
 *
 * `weapon2` 是**第二武器栏**，不是所有人都有：只有拿到额外武器栏的角色
 * （神典韦【捐甲】）才存在这一栏，见 `engine/equipment-slots.ts`。
 * 没有这一栏的人，它既不出现在合法装备目标里，也不参与攻击范围计算。
 */
export type EquipmentSlot = 'weapon' | 'weapon2' | 'armor' | 'offensiveHorse' | 'defensiveHorse'
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
  /** 技能生成的临时牌。结算结束后销毁，不进入弃牌堆，也不计入牌堆组成。 */
  virtual?: boolean
  /**
   * 这张「牌」其实是一张武将牌（神典韦【挈挟】把武将牌当武器用）。
   *
   * 它没有花色、没有点数、不属于牌堆构成，**离开装备区就销毁**，
   * 不会进手牌、弃牌堆或牌堆。详见 `engine/character-equipment.ts`。
   */
  characterId?: CharacterId
  /** 谁生成了这张非牌堆牌，用于生命周期管理。 */
  generatedBy?: 'character-equipment'
  /** 生成这张虚拟牌的技能，用于结算完成后的技能奖励。 */
  sourceSkillId?: string
}

export interface EquipmentZone {
  weapon: CardId | null
  /** 第二武器栏。没有这一栏的角色恒为 null，见 `EquipmentSlot`。 */
  weapon2: CardId | null
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
  /**
   * 武将专属牌堆：置于武将牌上的牌，按技能 id 分组。
   *
   * 周泰的「创」是第一个用户，之后的「田」「权」「忍」都放这里，
   * **不允许给某个武将单开一个 `buquCards` 字段**——那样牌张守恒、
   * 序列化、断线重连就要各写一遍。
   *
   * 这里放的是真实的 CardId，牌是从牌堆真移动过来的，不是复制出来的牌面。
   */
  characterPiles: Record<string, CardId[]>
  /**
   * 哪些专属牌堆是**扣置**的（只有主人看得到牌面，别人只看得到数量）。
   *
   * 周泰的「创」是亮出来的，所以默认公开；神诸葛亮的「星」是扣置的，
   * 必须登记在这里，`buildPlayerView` 才知道要对别人裁掉牌面。
   * **不要靠「牌堆名叫什么」去猜可见性**——那样加一个新堆就得改 view.ts。
   */
  hiddenCharacterPiles?: string[]
  marks: Record<string, number>
  /** 限定技：**一局一次**，永不重置。 */
  usedLimitedSkills: string[]
  /**
   * 本局进入过几次濒死状态。
   *
   * 一次完整的濒死流程只算一次，不管中间问了多少人要桃。只增不减。
   */
  dyingEntryCount?: number
  /**
   * 本回合已经用过的技能（「出牌阶段限一次」这类）。
   *
   * 和 `usedLimitedSkills` 分开是因为两者的生命周期完全不同，混用过一次就出过 bug：
   * 华佗【青囊】原来记在 usedLimitedSkills 里而没人清，「限一次」变成了「一局一次」。
   * 这个列表由 `turn.ts` 在回合结束时统一清空，技能不需要各自注册重置。
   */
  turnUsedSkills: string[]
  /**
   * 运行中获得的技能（觉醒后拿到的【急袭】【观星】【激将】这类）。
   *
   * **不能直接改 `CharacterDefinition`**：那个对象是所有对局共享的模块级常量，
   * 改它会让同一进程里别的房间、甚至下一局的同名武将也跟着有这个技能。
   * 技能归属统一由 `ownedSkillIds` 取「武将自带 + 这里」的并集。
   */
  grantedSkills: string[]
  /** 可替换的来源绑定临时技能（左慈化身）；同一来源原子替换。 */
  temporaryGrantedSkills: Array<{ source: string; skillId: string }>
  /** 断肠等效果永久令该角色失去全部武将技能；装备效果不受影响。 */
  characterSkillsDisabled: boolean
  /**
   * 已经发动过的觉醒技。觉醒技一局只发动一次，**永不重置**。
   *
   * 和 `usedLimitedSkills` 分开：限定技是玩家自己选择发动的，
   * 觉醒技是条件满足即强制发动，两者的判定时机和 UI 呈现都不一样。
   */
  awakenedSkills: string[]
  /**
   * 本局是否真正受到过伤害。一次成立终局有效，死亡也不清除。
   *
   * 失去体力不算，伤害被防止也不算——见 engine/damage.ts 的写入点。
   * 神郭嘉【天翊】要判断「所有存活角色均受到过伤害」，扫战报字符串既不可靠
   * 也扛不住重连，所以落成可序列化的状态位。
   */
  hasTakenDamage?: boolean
  distanceFromOthers: number
  distanceToOthers: number
  attackRangeBonus: number
  /** 孟达【苟得】：永久变更后的势力，覆盖武将牌本身的势力。不改身份牌。 */
  kingdomOverride?: Kingdom
}

export interface GameZones {
  drawPile: CardId[]
  discardPile: CardId[]
  processingArea: CardId[]
}

/**
 * 私有暂存牌区。
 *
 * 处理区（`processingArea`）是**完全公开**的：任何进去的牌，全场都能在
 * PlayerView 里看到牌名花色点数。所以「先扣一张牌、稍后才揭示」这种效果
 * 不能借道处理区——把牌塞进去再让前端别显示，网络包里照样是明文。
 *
 * 这里是真正的服务端私有区：牌仍然是一张真实的 CardId（计入牌张守恒），
 * 但 `buildPlayerView` **只把 owner 自己的那些区下发给他**，其他人连区的
 * 存在都不需要知道。
 *
 * 于吉【蛊惑】是第一个用户；以后的拼点、伏兵一类也走这里，
 * 不要给某个武将单开一个 `state.xxxHiddenCardId`。
 */
export interface PrivateCardZone {
  /** 区的唯一 id，技能用它取回自己的牌。 */
  id: string
  /** 谁能看见这个区。 */
  ownerId: PlayerId
  /** 建区的原因（技能 id），便于战报和排查。 */
  reason: string
  cards: CardId[]
}

/**
 * 多人同时决定。
 *
 * 每个参与者各挂一个 pendingRequest，`buildPlayerView` 只下发发给自己的那一个，
 * 所以谁也看不到别人的请求。**`responses` 不进 PlayerView**，
 * 在收齐之前谁也看不到别人选了什么。
 *
 * 收齐之后由 `tag` 指向的续接统一处理——用字符串而不是闭包，
 * 因为 Durable Object 在等回答的时候会休眠。
 */
export interface GroupDecisionState {
  id: string
  tag: string
  /** 参与者，**按稳定顺序**（调用方按座次生成）。结算顺序要照它来。 */
  playerIds: PlayerId[]
  /** 已经交上来的选择。没交的人这里没有键。 */
  responses: Record<PlayerId, string | undefined>
  /** 超时、掉线、中途死亡时替玩家填的默认选项。 */
  defaultOptionId: string
  /** 每个参与者对应的请求 id，用于校验和收尾清理。 */
  requestIds: Record<PlayerId, string>
  /** 续接需要的上下文，必须可序列化。 */
  data: Record<string, unknown>
}

/**
 * 于吉【蛊惑】的「打出」模式。
 *
 * 求牌请求被临时收走、原样存在 `request` 里；质疑结束之后把它放回去
 * 再重放一次回答，于是后续结算走的仍然是原来那条路。
 *
 * `stage` 为 'granted' 的那一瞬间，`cardId` 会被当作 `requiredCardName`
 * 报进求牌路径原有的 viewAs 校验里——这样五条求牌路径一处都不用改。
 */
export interface GuhuoResponseState {
  ownerId: PlayerId
  requiredCardName: string
  /** 扣置的实体牌；还没选牌时为 null。**其他人的视图里看不到它。** */
  cardId: CardId | null
  stage: 'declaring' | 'penalizing' | 'granted' | 'declined'
  /** 质疑者按座次等待结算；可能被其中一人的濒死流程暂时打断。 */
  penaltyPlayerIds?: PlayerId[]
  /** 所有质疑惩罚完成后，这次声明是否仍然成立。 */
  grantedAfterPenalties?: boolean
  /** 以蛊惑响应求桃时，原濒死流程在这里挂起，质疑者濒死结束后再恢复。 */
  suspendedDying?: DyingState | null
  /**
   * 存下来待重放的原请求。
   *
   * 类型故意用 unknown：`types.ts` 不能 import `requests.ts`（那会成环），
   * 而这里只需要「原样存、原样放回去」，具体形状由消费方断言。
   */
  request: unknown
}

/**
 * 进行中的拼点；同一时刻最多一次。
 *
 * 双方暗选的牌不在这里存明文——牌本身移进各自的私有区，这里只记 cardId，
 * 而私有区在 `buildPlayerView` 里只发给它的主人。
 */
export interface PindianState {
  id: string
  initiatorId: PlayerId
  opponentId: PlayerId
  initiatorCardId: CardId | null
  opponentCardId: CardId | null
  /** 发起技能的 id，用于战报。 */
  reason: string
  /** 结束后交给哪个技能续接。 */
  continuationTag: string
  /** 技能自带的上下文，原样还给续接。 */
  data: Record<string, unknown>
  requestIds: Record<PlayerId, string>
  stage: 'selecting' | 'revealing'
}

/**
 * 拼点结果已经公开、但实体牌的最终去向仍待技能决定。
 *
 * 默认拼点不会留下这个状态；只有续接明确要求延后结算时，两张牌才继续留在
 * 公开处理区。这样【制霸】获得的是两张真实拼点牌，而不是先弃置再捡回来。
 */
export interface PindianSettlementState {
  id: string
  cardIds: CardId[]
}

import type { ArmorSuppression } from './armor-suppression'
import type { MultiCardViewAsState } from './multi-card-viewas'
import type { ForcedCardIdentity } from './forced-identity'
import type { GlobalToken } from './global-token'
import type { AttackRangeOverride } from './attack-range-override'
import type { DistanceOverride } from './distance-override'
import type { CardUseTargets } from './card-use-targets'
import type { CyclicStatus } from './cyclic-status'
import type { MissionStatus } from './mission-skill'
import type { MovableToken } from './movable-tokens'
import type { SkillSuppression } from './skill-suppression'
import type { TurnKillRecord } from './turn-kills'

export interface DiscardPhaseRecord {
  cardId: CardId
  sourcePlayerId: PlayerId
  originalZone: 'hand' | 'equipment'
  moveReason: 'discard'
  enteredDiscardAt: number
}

/** 当前唯一弃牌阶段的来源账本；阶段结束触发排队后立即清空。 */
export interface DiscardPhaseLedgerState {
  phaseInstanceId: string
  ownerPlayerId: PlayerId
  records: DiscardPhaseRecord[]
}

export interface HuashenOwnerState {
  characterIds: CharacterId[]
  activeCharacterId: CharacterId | null
  activeSkillId: string | null
}

export interface HuashenGameState {
  remainingCharacterIds: CharacterId[]
  owners: Record<PlayerId, HuashenOwnerState>
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
  /** 单机真人可从完整武将池自选；联机默认不开放。 */
  allowHumanGeneralSelection?: boolean
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
  /**
   * `awaiting-intercept` 是「成为目标时」插进来的一步：
   * 雌雄双股剑问目标选一项，大乔【流离】把这张【杀】转给别人。
   * 这一步挂的是技能 Request 而不是求闪 Request，所以 invariants 单独放行。
   */
  stage: 'awaiting-dodge' | 'awaiting-intercept' | 'awaiting-dying'
  /**
   * 当前目标已经问过哪些插入点。
   *
   * 没有这个记录的话，插入点结算完回到 `askSlashInterceptors` 会把自己再问一遍，
   * 而雌雄双股剑的「让对方摸一张」不消耗任何东西——于是死循环。
   * 流离换目标时清空：新目标该重新过一遍。
   */
  interceptsDone: string[]
  /**
   * 一起打出来的额外实体牌（丈八蛇矛把两张手牌当一张【杀】）。
   * 它们和主牌同进同出，结算结束时一起进弃牌堆。
   */
  extraCardIds: CardId[]
  /**
   * 还没结算的其余目标（方天画戟可以指定至多三名角色）。
   *
   * 一个人只能装一把武器，所以多目标（方天画戟）和青龙偃月刀 / 贯石斧 /
   * 寒冰剑 / 麒麟弓不会同时出现——这条互斥让多目标的实现不必和它们纠缠。
   */
  remainingTargetIds: PlayerId[]
  requestId: string | null
  /** 当前目标还需要打出几张【闪】；无双为 2，普通杀为 1。 */
  dodgeRemaining: number
  /**
   * 本次目标是否完全不能用【闪】响应（马超【铁骑】判定为红）。
   *
   * 和 `dodgeRemaining` 是两回事：那个是「要打出几张闪」，这个是「一张都不许打」。
   * 每换一个目标都要重置——铁骑是逐个目标判定的。
   */
  noDodge?: boolean
  /** “成为目标后”的技能只取消当前目标，不影响这张【杀】的其他目标。 */
  targetCancelled?: boolean
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
  | { kind: 'duel'; responderId: PlayerId; otherId: PlayerId; requestId: string; slashRemaining: number }
  /** 过河拆桥 / 顺手牵羊：由使用者从目标区域里挑一张 */
  | { kind: 'pick-card'; targetId: PlayerId; mode: 'discard' | 'steal'; requestId: string }
  /** 五谷丰登：亮出的牌摆在处理区，逐个目标挑走一张 */
  | { kind: 'harvest'; targetId: PlayerId; revealedCardIds: CardId[]; requestId: string }
  /** 火攻第一步：目标展示一张手牌 */
  | { kind: 'fire-reveal'; targetId: PlayerId; requestId: string }
  /**
   * 奇正相生第一步：使用者秘密选「奇兵」还是「正兵」。
   *
   * 这一步的请求只发给使用者本人，别人看不到；`PlayerView` 只下发
   * 观看者自己的那一条 pendingRequest。
   */
  | { kind: 'qizheng-mode'; targetId: PlayerId; requestId: string }
  /**
   * 奇正相生第二步：目标打出【杀】或【闪】。
   *
   * **`mode` 是这一局里唯一记着秘密选择的地方，绝不能下发给目标。**
   * `PlayerView.cardResolution` 是白名单投影（只给 kind / card / sourceId /
   * targetIds / currentTargetId / stage），`effect` 整个不在里面，所以
   * 把秘密放在这里是安全的——但任何时候往视图里加字段都要重新确认这一条。
   */
  | { kind: 'qizheng'; targetId: PlayerId; mode: 'qi' | 'zheng'; requestId: string }
  /** 火攻第二步：使用者弃一张同花色的牌才能造成火焰伤害 */
  | { kind: 'fire-discard'; targetId: PlayerId; revealedCardId: CardId; suit: Suit; requestId: string }
  /** 借刀杀人：目标要对第三人出杀，否则把武器交给使用者 */
  | { kind: 'borrowed-knife'; targetId: PlayerId; victimId: PlayerId; weaponCardId: CardId; requestId: string }
  /** 借刀杀人：目标真的出了杀，轮到受害者出闪 */

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
  /**
   * 一起打出的其余底牌（袁绍【乱击】的第二张）。
   *
   * 转化技可能用不止一张实体牌换一张锦囊。主牌走正常的使用流程，其余底牌
   * 跟着一起进处理区、结算完一起进弃牌堆——【杀】那边的 `extraCardIds`
   * 是同一件事，这里补上锦囊的那一半。
   */
  extraCardIds?: CardId[]
  stage: 'awaiting-intercept' | 'awaiting-nullification' | 'awaiting-effect'
  /** 当前目标已经处理过的“成为目标后”技能，避免恢复时重复发问。 */
  interceptsDone: string[]
  /** 被技能取消的目标。多目标牌只跳过对应角色。 */
  cancelledTargetIds: PlayerId[]
  /** 不能响应本次牌的角色；只在这张牌的结算状态中生效。 */
  unresponsiveTargetIds: PlayerId[]
  responderOrder: PlayerId[]
  responderIndex: number
  nullificationCount: number
  /**
   * 本次结算里选了「本轮均不使用」的人。
   *
   * 五谷丰登这类多目标锦囊，每个目标都要问一轮无懈；一路点「不使用」
   * 会被问五六次。声明一次之后这张牌剩下的目标就不再打扰他。
   */
  declinedAllIds: PlayerId[]
  /**
   * 最后打出无懈的人。换人之后要从头再问一轮，但**不问他自己**——
   * 对自己刚打出的无懈再打一张，效果等于两张都没打，只是白白多问一次。
   */
  lastNullifierId: PlayerId | null
  requestId: string | null
  effect: TrickEffectState | null
  /** 五谷丰登亮出的牌：整张牌结算期间共用一批，中途不重新亮 */
  harvestPool?: CardId[]
}

export type CardResolutionState = SlashResolutionState | TrickResolutionState

export interface TurnUsageState {
  /**
   * 本**出牌阶段实例**内使用【杀】的次数。
   *
   * 按阶段而不是按回合记：廖化【当先】让一个回合里出现两个出牌阶段，
   * 每个阶段各有自己的一次。进入每个出牌阶段时归零（见 `phase.ts`）。
   */
  slashUses: number
  /**
   * 本**回合**内使用【杀】的次数，中途不归零。
   *
   * 「本回合是否使用过【杀】」这类判据（吴国太之外还有陆逊【克己】）读的是它——
   * 读 `slashUses` 的话，当先的第二个出牌阶段一开始就把前面那张杀忘了。
   * 旧存档里没有这个字段，读取方一律 `?? slashUses` 兜底。
   */
  slashUsesThisTurn?: number
  wineUses: number
  wineDamageBonus: number
}

export interface DamageChainState {
  sourceId: PlayerId | null
  nature: Exclude<DamageNature, 'normal'>
  amount: number
  cardId: CardId | null
  cardName: string | null
  redirectedBy: string | null
  remainingTargetIds: PlayerId[]
}

export interface JudgmentNullificationState {
  playerId: PlayerId
  delayedCardId: CardId
  stage: 'awaiting-nullification'
  responderOrder: PlayerId[]
  responderIndex: number
  nullificationCount: number
  /** 见 TrickResolutionState 上的同名字段。 */
  declinedAllIds: PlayerId[]
  lastNullifierId: PlayerId | null
  requestId: string
}

export interface JudgmentDamageState {
  playerId: PlayerId
  delayedCardId: CardId
  stage: 'awaiting-damage'
}

export type JudgmentState = JudgmentNullificationState | JudgmentDamageState

/**
 * 判定牌翻开之后、生效之前的改判窗口（鬼才、鬼道）。
 *
 * 判定原本是一次同步翻牌，没有任何插入点。改判技能必须能让玩家看到牌面之后
 * 再决定，所以判定被拆成「翻牌 → 逐人询问改判 → 结算」三段，中间这一段
 * 要能跨 Durable Object 休眠恢复，因此这里**只放可序列化数据**：
 * 判定结束之后该做什么，用 `tag` 指向注册表里的续接函数，不存闭包。
 */
export interface JudgmentRetrialState {
  /** 被判定的角色。改判技能的拥有者不一定是他。 */
  playerId: PlayerId
  reason: string
  /** 判定结束后走哪个续接，见 engine/judgment.ts 的 registerJudgmentContinuation。 */
  tag: string
  /** 续接需要的上下文，必须可序列化。 */
  data: Record<string, unknown>
  /** 当前的判定牌。改判成功后会换成新的那张。 */
  judgeCardId: CardId
  responderOrder: PlayerId[]
  responderIndex: number
  requestId: string
  /**
   * 当前这一轮询问：换牌用的是谁的手牌。默认就是被问的那个人自己
   * （`responderOrder` 当前这一位）；诸葛瑾【缓释】要的是「诸葛瑾出牌，
   * 被判定角色替他挑」，这两个人不是同一个，所以要单独记一笔，
   * 不能假设「回答的人」和「出牌的人」永远相同。
   */
  sourceId?: PlayerId
}

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
  /**
   * 这次发动是否已经播过技能横幅。
   *
   * 一个技能问好几步是常态（选牌 → 选目标 → 选选项），而引擎在**每一步**
   * 得到肯定回答时都会补一条 SkillActivated 兜底。不记这个标记的话，
   * 一次发动会在牌桌中央连播好几遍同一个技能名——用户报的「重复显示两次」。
   *
   * 必须跟着挂起状态一起序列化：多步技能会跨多次 respond，中间 Durable Object
   * 可能已经休眠过一轮。
   */
  announced: boolean
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
  /**
   * 拥有者已经阵亡时也要放行。
   *
   * 队列默认把死人的排队丢掉：技能触发之后武将可能已经死了或被换掉，
   * 那时前提通常已经不成立。但**「当你死亡时」这一类技能本身就是死后才跑的**
   * （步练师【追忆】），不声明这一条它一次也不会响。
   *
   * 和触发器上的 `allowDeadOwner` 是配套的两半：那个管「事件要不要派给死人」，
   * 这个管「排队的发问要不要为死人放出去」。只声明其中一个仍然跑不通。
   */
  allowDeadOwner?: boolean
}

export interface DeathClaimState {
  deadId: PlayerId
  claimantId: PlayerId
  skillId: string
  cardIds: CardId[]
}

/**
 * 阶段进入窗口。**只放可序列化数据**——窗口中途 Durable Object 可能休眠。
 *
 * `askedSkillIds` 记的是「这个阶段已经问过哪些技能要不要跳过」，
 * 少了它，技能回答完再回到窗口时会把自己重新问一遍，问成死循环。
 */
export interface PhaseEntryState {
  phase: TurnPhase
  askedSkillIds: string[]
  /**
   * `ask-skip`：还在问「要不要跳过这个阶段」。
   * `await-content`：`PhaseStart` 已经发出去了，但它触发的技能还没结算完
   * （发了 Request、或者把拥有者打进濒死），阶段内容要等场面干净了再跑。
   */
  stage?: 'ask-skip' | 'await-content'
}

/**
 * 正在执行的额外阶段（廖化【当先】）。
 *
 * 它是一个**阶段**而不是额外回合：不新建回合实例、不推进轮次、
 * 不进 `extraTurns` 队列，回合级的状态两边共享。走完之后回到 `resumeSlot`
 * 这个阶段位继续跑这个回合的其余部分。
 *
 * `instanceId` 让「出牌阶段限一次」分得清这是哪一个出牌阶段——
 * 额外出牌阶段和随后的正常出牌阶段占的阶段位相同，只靠阶段位区分不开。
 */
export interface ExtraPhaseState {
  phase: TurnPhase
  resumeSlot: TurnPhase
  playerId: PlayerId
  skillId: string
  instanceId: number
  /**
   * 这个额外阶段开始时，它跑的那个阶段**已经**被标记为跳过了吗。
   *
   * 用来分辨「跳过标记是冲着这个额外阶段来的」还是本来就有。
   * 冲着它来的（张郃【巧变】弃一张牌跳掉这个额外出牌阶段）在额外阶段结束时
   * 随它一起消失，不能牵连这个回合里正常的出牌阶段位——
   * 一次巧变只跳一个阶段。
   */
  preSkipped: boolean
}

/**
 * 排队中的额外回合（刘禅【放权】）。
 *
 * `sourceSkillId` / `sourcePlayerId` 只用于战报和界面，**规则层不读它们**。
 */
export interface ExtraTurnEntry {
  playerId: PlayerId
  sourceSkillId?: string
  sourcePlayerId?: PlayerId
}

/** 见 `engine/target-state.ts`。放在这里是为了让 SanguoshaState 不反向依赖那个模块。 */
export interface TargetState {
  name: string
  ownerId: PlayerId
  /**
   * 失效时机。
   *
   * `source-next-turn-start`：持续到**施加者**的下一个回合开始前
   * （狂风、大雾都是这一种）。判据是施加者的回合又开始了一次，
   * 所以必须记住施加者是谁、以及施加时的回合数。
   */
  /**
   * 什么时候失效。
   *
   * - `source-next-turn-start`：到施加者的下一个回合开始前（狂风、大雾）。
   * - `owner-turn-end`：到**被施加者自己**的回合结束（神黄忠【裂穹】的几处击伤）。
   *   在他自己的回合里被施加的，就到这一个回合结束；回合外施加的，
   *   到他下一个实际回合结束——额外回合也算，认的是回合实例不是轮次。
   */
  expiry: 'source-next-turn-start' | 'owner-turn-end'
  appliedTurn: number
  /** 施加者。`source-next-turn-start` 靠它判断什么时候到期，规则层要读。 */
  sourceId: PlayerId
  skillId?: string
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
  /**
   * 正常座次游标。**额外回合不会推进它。**
   *
   * 和 `currentPlayerId` 分开是整套回合调度最要紧的一条不变量：
   * 额外回合期间 `currentPlayerId` 指向插队的那个人，但下一个正常回合
   * 仍然要从这里继续往后数。合成一个字段的话，被插队角色的正常回合
   * 会被直接吃掉。
   */
  normalTurnPlayerId: PlayerId
  /** 排队中的额外回合，先进先出。轮到时已经死亡的直接丢弃。 */
  extraTurns: ExtraTurnEntry[]
  /**
   * 临时角色状态（狂风、大雾）。见 `engine/target-state.ts`。
   *
   * 和 `player.marks` 分开：marks 是计数，这里是**带失效时机的具名状态**，
   * 而且会参与伤害结算。放在牌局状态里而不是玩家身上，
   * 是因为失效判定要看全局回合数。
   */
  targetStates: TargetState[]
  /** 当前回合是正常回合还是插队的额外回合。决定下一个正常回合从哪里数起。 */
  currentTurnKind: 'normal' | 'extra'
  turnNumber: number
  /**
   * 第几轮。从 1 开始。
   *
   * **轮次不等于回合。** 一轮是「正常座次绕场一周」，而额外回合是插队，
   * 不推进轮次也不占用别人的正常回合。有技能的代价是「下一轮开始时死亡」，
   * 拿回合数去凑会让它在插队之后立刻结算。
   */
  roundNumber: number
  /**
   * 弃牌堆里每张牌**为什么**在那儿。见 `engine/discard-provenance.ts`。
   *
   * 「用过的【杀】」和「被弃置的【杀】」都躺在弃牌堆里，但规则上不是一回事。
   */
  discardProvenance?: Record<string, import('./discard-provenance').DiscardEntry>
  /**
   * 手牌来源：每张手牌**从谁那里**来的，见 `engine/card-gain-provenance.ts`。
   *
   * 「获得其他角色的两张牌」和「摸两张牌」在牌面上看不出区别，
   * 只有在牌移动的那一刻才分得清。
   */
  gainProvenance?: Record<string, import('./card-gain-provenance').GainEntry>
  /**
   * 暂时扣置、当前回合结束后归还的牌，见 `engine/turn-bound-pile.ts`。
   * 绑定的是「这一个回合」，不是轮次。
   */
  detainedCards?: import('./turn-bound-pile').DetainedCardEntry[]
  /**
   * 牌的**有效颜色改写**，见 `engine/card-color.ts`。
   * 多张子牌合成的虚拟牌（荀攸【奇策】）靠它表达「全红 / 全黑 / 无色」。
   */
  cardColorOverrides?: Record<string, 'red' | 'black' | null>
  /**
   * 当前这个阶段是**从哪个阶段位替换来的**（神孙权【持纲】把判定位跑成摸牌阶段）。
   *
   * 只有正在发生替换时才有值，平时不存在。回合往前走时看的是「位置」——
   * 有替换就是这个字段，没有就是 `phase` 本身。
   *
   * **不存成一个恒有的 `phaseSlot`**：那样任何一处直接给 `state.phase` 赋值的
   * 代码都会让位置和内容悄悄错开，而这种赋值在引擎和测试里到处都是。
   * 只在替换期间存在的标记没有这个问题——没有替换时它压根不参与计算。
   */
  phaseReplacedFrom?: TurnPhase
  /**
   * 拿到了额外武器栏的角色（神典韦【捐甲】）。
   *
   * 和「废除栏」是同一类记账，方向相反：那个是少一栏，这个是多一栏。
   */
  extraWeaponSlots?: PlayerId[]
  /**
   * 牌堆重洗的痕迹。见 `engine/deck.ts`。
   *
   * 「这个回合牌堆洗过牌吗」是一条真事实，不是从牌堆剩几张推出来的猜测。
   */
  deckReshuffle?: import('./deck').DeckReshuffleState
  phase: TurnPhase
  skippedPhases: TurnPhase[]
  /**
   * 阶段还没正式开始，正在走「付代价跳过这个阶段」的公共窗口。
   *
   * 只在窗口挂起等玩家回答时非空；阶段一旦真正开始（发出 `PhaseStart`）
   * 或被跳过就清成 null。见 `phase.ts` 的 `beginPhaseEntry`。
   */
  phaseEntry: PhaseEntryState | null
  /**
   * 「不能使用或打出某种颜色的手牌」的在场禁令（马岱【潜袭】）。
   *
   * 绑定回合序号，回合结束由 `turn.ts` 统一清。见 `card-play-lock.ts`。
   */
  /**
   * 这一次使用的牌造成过多少伤害，按牌 id 记；随这次使用结算收束一起销毁。
   * 见 `card-damage-ledger.ts`（程普【疠火】读它）。
   */
  cardDamageLedger?: Record<string, number>
  /**
   * 这一次使用的属性**被技能改写过**的那几张牌。
   *
   * 「改写属性要付代价」的技能（程普【疠火】把普通【杀】改成火【杀】）
   * 靠它区分「这一张是我改的」和「本来就是这个属性的」——
   * 代价只属于前者。标记落在**牌**上而不是回合上，结算收束时由技能自己摘掉。
   */
  natureConvertedCardIds?: string[]
  /** 某次【杀】结算中，目标实际打出的【闪】——键是这张杀的来源。周仓【忠勇】用。 */
  lastSlashDodgeCard?: Record<PlayerId, CardId>
  /**
   * 正在追踪的虚拟【决斗】：谁真正因此受到过伤害。
   * 键是虚拟牌 id，用于结算完毕时判断该不该让受伤者额外摸牌。刘谌【战绝】用。
   */
  trackedDuelVictim?: Record<CardId, PlayerId>
  cardColorLocks?: Array<{
    targetId: PlayerId
    color: 'red' | 'black'
    sourceId: PlayerId
    skillId: string
    turnNumber: number
  }>
  /** 同 `cardColorLocks`，按牌类别（基本/锦囊/装备）禁用。杨修【鸡肋】用。 */
  cardCategoryLocks?: Array<{
    targetId: PlayerId
    category: CardCategory
    sourceId: PlayerId
    skillId: string
    turnNumber: number
  }>
  /**
   * 按具体 Card ID 禁用（董白【黠慧】）。不按回合过期，技能自己在
   * 正确的时机（目标体力值下降后）调用 `clearCardIdLocksOf` 解锁。
   */
  cardIdLocks?: Array<{ targetId: PlayerId; cardId: CardId; sourceId: PlayerId; skillId: string }>
  /**
   * 陈琳【笔伐】暗置在目标武将牌上、等目标下一次回合开始才结算的牌。
   * 键是目标 `playerId`；同一目标同一时刻只保留最新的一份。
   */
  pendingBifa?: Record<PlayerId, { cardId: CardId; ownerId: PlayerId; category: CardCategory }>
  /**
   * 马云騄【凤魄】选择「伤害 +X」分支后，绑定在某一张具体牌上的伤害加成。
   * 键是拥有者 `playerId`；`BeforeDamage` 命中这张 `cardId` 时加上 `amount`
   * 并立即消费掉，不建立本回合常驻加成。
   */
  pendingFengpoBonus?: Record<PlayerId, { cardId: CardId; amount: number }>
  /** 戏志才【先辅】选定的先辅目标。键是戏志才的 `playerId`，本局固定不变。 */
  xianfuTarget?: Record<PlayerId, PlayerId>
  /**
   * 田豫【追讨】当前生效的定向距离 -1。造成伤害后移除对应记录，
   * 该目标就重新变回「可以被追讨选择」——不建永久黑名单。
   */
  zhuitaoDistance?: Array<{ ownerId: PlayerId; targetId: PlayerId }>
  /**
   * 郝昭【镇骨】跨两次回合结束的调整。键是目标 `playerId`；
   * `stage: 'first'` 等郝昭当前回合真正结束时执行第一次调整，之后转
   * `'second'` 等目标自己下一次回合真正结束时执行第二次调整并清除。
   */
  pendingZhengu?: Record<PlayerId, { haozhaoId: PlayerId; stage: 'first' | 'second' }>
  /** 正在执行的额外阶段；没有额外阶段时不存在这个字段。 */
  extraPhase?: ExtraPhaseState
  /** 还没轮到的额外阶段（同一个回合开始时排了不止一个）。 */
  pendingExtraPhases?: ExtraPhaseState[]
  /**
   * TurnEnd 已发出，但其触发的技能尚未结算完；结算干净后才开始下一回合。
   *
   * 这是可持久化的断点，避免“回合结束后”技能在 Durable Object 休眠或
   * 断线重连后越过下一名角色的 TurnStart。
   */
  turnTransitionPending: boolean
  turnUsage: TurnUsageState
  pendingRequests: GameRequest[]
  dying: DyingState | null
  damageChain: DamageChainState | null
  judgment: JudgmentState | null
  /** 私有暂存牌区。见 PrivateCardZone 的说明——**不要用处理区代替它**。 */
  privateZones: PrivateCardZone[]
  /** 进行中的多人同时决定；同一时刻最多一个。 */
  groupDecision: GroupDecisionState | null
  /** 进行中的拼点；同一时刻最多一次。 */
  pindian: PindianState | null
  /** 已揭示、等待消费者决定实体牌去向的拼点结算。 */
  pindianSettlement: PindianSettlementState | null
  /** 当前弃牌阶段中，因“弃置”进入弃牌堆的实体牌来源。 */
  discardPhaseLedger: DiscardPhaseLedgerState | null
  /** 来源绑定的临时防具失效（神吕布【无前】）。见 engine/armor-suppression.ts。 */
  armorSuppressions: ArmorSuppression[]
  /** 服务端权威化身牌库；PlayerView 会按观察者裁剪。 */
  huashen: HuashenGameState | null
  /** 进行中的「蛊惑打出」；同一时刻最多一次，嵌套会把恢复逻辑绕死。 */
  guhuoResponse: GuhuoResponseState | null
  /** 多牌同花色转化的挂起流程（神赵云【龙魂】）。见 engine/multi-card-viewas.ts。 */
  multiCardViewAs: MultiCardViewAsState | null
  /** 回合内击杀账本（神司马懿【连破】）。见 engine/turn-kills.ts。 */
  turnKills: TurnKillRecord[]
  /** 转换技的阴阳状态（神刘备【龙怒】）。见 engine/conversion.ts。 */
  conversionStates: Record<string, 'yang' | 'yin'>
  /** 本回合被强制改写身份的手牌类别（神刘备【龙怒】）。见 engine/forced-identity.ts。 */
  forcedIdentities: ForcedCardIdentity[]
  /** 被废除的装备栏（神张辽【夺锐】）。见 engine/equipment-slots.ts。 */
  abolishedSlots: Record<PlayerId, EquipmentSlot[]>
  /** 单个技能的临时失效（神张辽【夺锐】）。见 engine/skill-suppression.ts。 */
  skillSuppressions: SkillSuppression[]
  /** 带归属的全局唯一 Token（神甘宁的「营」）。见 engine/global-token.ts。 */
  globalTokens: GlobalToken[]
  /**
   * 牛来【麻麻】的认亲关系：牛来的 playerId → 麻麻的 playerId。
   *
   * 放在牌局状态里而不是 `player.marks`，因为 marks 只存数字，存不下 playerId；
   * 也不能只存在牛来一侧的内存里——这是**公开信息**，服务端权威，
   * 断线重连和多客户端都要看到同一份。一局里可以有多个牛来，
   * 各自维护自己的一条，允许指向同一个人。
   */
  mamaBonds: Record<PlayerId, PlayerId>
  /** 判定牌的改判窗口；没有改判技能在场时始终为 null，判定仍然一步走完。 */
  retrial: JudgmentRetrialState | null
  /**
   * 连续判定的暂存堆；见 engine/judgment-retention.ts。
   *
   * 暂存期间判定牌留在处理区（公开），结束时统一交给某人或进弃牌堆。
   * 没有技能在用时始终为 null。
   */
  judgmentRetention?: JudgmentRetentionState | null
  /**
   * 被外部技能放行的觉醒条件；见 engine/forced-awakening.ts。
   *
   * 只放行条件，不改时机也不改记账。觉醒完成后清除。
   */
  forcedAwakenings?: ForcedAwakening[]
  /** 被授予的技能记住授予者；见 engine/skill-grant-source.ts。 */
  skillGrantSources?: SkillGrantSource[]
  /**
   * 「每种牌名限一次」的历史，按 `玩家:技能` 索引；见 engine/card-name-history.ts。
   *
   * 记录集合和已用集合是分开的——移除记录**不**退还一次性资格。
   */
  cardNameHistories?: Record<string, CardNameHistory>
  /**
   * 来源绑定的可叠加标记（神孙策【平定】）。
   * 形状是 `[targetId][key][sourceId] = count`，详见 engine/source-marks.ts。
   */
  sourceMarks?: Record<PlayerId, Record<string, Record<PlayerId, number>>>
  /** 使命技的状态（神太史慈【破围】）。见 engine/mission-skill.ts。 */
  missionSkills?: Record<string, MissionStatus>
  /** 会移动、且记得来源的标记（「围」）。见 engine/movable-tokens.ts。 */
  movableTokens?: MovableToken[]
  /** 定向的「视为在攻击范围内」。见 engine/attack-range-override.ts。 */
  attackRangeOverrides?: AttackRangeOverride[]
  /** 定向的「视为距离 N」。见 engine/distance-override.ts。 */
  distanceOverrides?: DistanceOverride[]
  /** 有序循环状态（神华佗【五灵】）。见 engine/cyclic-status.ts。 */
  cyclicStatuses?: CyclicStatus[]
  /** 正在结算的使用牌各自指定了哪些目标。见 engine/card-use-targets.ts。 */
  cardUseTargets?: CardUseTargets[]
  /**
   * 本回合判定阶段已经结算过的延时锦囊。
   *
   * 【闪电】判定失败会传给下一名没有【闪电】的角色；当场上只剩他自己
   * 符合条件时，闪电会回到他自己的判定区——如果不记账，判定阶段就会
   * 把同一张闪电反复判下去，一局直接卡死。回合结束时清空。
   */
  judgedDelayedCards: CardId[]
  /**
   * 死亡角色的牌正暂存在处理区，等某个技能（曹丕【行殇】）决定要不要拿。
   *
   * null 表示没有挂账。**处理区里绝不能留下没人管的牌**，
   * 所以每一条退出路径都要落到 `releaseDeathCards`。
   */
  deathClaim: DeathClaimState | null
  cardResolution: CardResolutionState | null
  /**
   * 借刀杀人在多目标场景下的挂起态：一个目标选择真的出杀后，那张杀要走
   * **完整的**杀结算（`cardResolution` 只有一格，被借刀杀人的锦囊结算占着
   * 就得先让位）。这里存的是「让位前」那份锦囊结算状态，杀真正结算完毕
   * （`cardResolution` 归零的那一刻）才恢复它、继续走它剩下的目标。
   * 没有别的锦囊会用到这个字段。
   */
  suspendedTrickResolution?: TrickResolutionState | null
  /**
   * 程昱【设伏】：暗置在「伏兵」堆里的手牌与声明牌名的绑定。
   * 键是程昱的 `playerId`；伏兵牌本体存在 `characterPiles.fubing` 里，
   * 这里只记「哪张 cardId 绑定了哪个牌名」。
   */
  fubingRecords?: Record<PlayerId, Array<{ cardId: CardId; cardName: string }>>
  /**
   * 张昌蒲【省身】给下一次【严教】累积的额外亮牌张数（可跨多次省身叠加，
   * 使用严教时一次性消费掉，见 sp3-zhangchangpu 的实现说明）。
   */
  yanjiaoBonus?: Record<PlayerId, number>
  /** 吕虔【威虏】：本回合内对吕虔造成过伤害、下一次出牌阶段开始还没结算的来源。 */
  weiluPending?: Record<PlayerId, PlayerId[]>
  /** 吕虔【威虏】：已经在本回合结算过、等吕虔回合结束时要恢复的失去量。 */
  weiluRecoverable?: Record<PlayerId, Array<{ sourceId: PlayerId; amount: number }>>
  /**
   * 郭汜【贪狈】选项 1：直到当前回合结束，郭汜不能对这个目标使用牌。
   * 用「施加时的回合序号」自然过期，不需要额外的回合结束清理。
   */
  guosiTanbeiLock?: Record<PlayerId, { targetId: PlayerId; turnNumber: number }>
  /** 郭汜【贪狈】选项 2：直到当前回合结束，郭汜对这个目标使用牌无距离/次数限制。 */
  guosiTanbeiUnlimited?: Record<PlayerId, { targetId: PlayerId; turnNumber: number }>
  /** 郭汜【伺盗】：本出牌阶段实例内，最近一次连续对同一目标使用牌的计数。 */
  guosiConsecutiveUse?: Record<PlayerId, { targetId: PlayerId; count: number; phaseKey: string }>
  /**
   * 许靖【实荐】：这名角色在当前回合内已经使用过的牌数量。
   * 按 `turnNumber` 自然过期，不需要额外的回合结束清理。
   */
  turnCardUseCount?: Record<PlayerId, { turnNumber: number; count: number }>
  /** 诸葛恪【黩武】：本次伤害是否让目标进入了濒死，等濒死结算完再回收判定。 */
  pendingDuwu?: Record<PlayerId, PlayerId>
  /**
   * 诸葛瞻【父荫】：本回合第一次成为杀/决斗目标时，若使用者手牌数达标，
   * 记下这次要被无效的来源，供 `cardEffectInvalid` 消费一次。
   */
  fuyinPending?: Record<PlayerId, { sourceId: PlayerId; turnNumber: number }>
  /**
   * 诸葛瞻【罪论】X=0 分支：双方各失去 1 点体力不能同时发生——濒死结算
   * 期间引擎不允许嵌套第二个濒死。这里记下「先手那次 LoseHp 触发了濒死，
   * 还欠另一方一次 LoseHp」，等这次濒死结算完（`QuitDying`/`Death`）再补上。
   */
  pendingZuilunLoseHp?: { ownerId: PlayerId; pendingPlayerId: PlayerId }
  /** 张绣【雄乱】：已经废除判定区的角色（配合 prohibitsTarget 拒绝延时锦囊目标）。 */
  zhangxiuJudgmentAbolished?: PlayerId[]
  /** 张绣【雄乱】：直到当前回合结束，对这个目标使用牌无距离/次数限制。 */
  zhangxiuXiongluan?: Record<PlayerId, { targetId: PlayerId; turnNumber: number }>
  /** 潘凤【狂斧】：当前这次虚拟杀的来源信息，等它结算完毕再按结果分支。 */
  pendingKuangfu?: { ownerId: PlayerId; targetId: PlayerId; fromOwnEquipment: boolean }
  /** 王平【兵略】：已经因【飞军】触发过摸牌的目标集合，一局内持久有效。 */
  bingluTargets?: Record<PlayerId, PlayerId[]>
  /** 严畯【观潮】：当前出牌阶段实例里，牌点是否仍保持严格递增/递减。 */
  yanjunTrend?: Record<PlayerId, { direction: 'asc' | 'desc'; lastRank: number | null; broken: boolean }>
  /** 费祎【和衷】：本回合尚未消费的“大于/小于 N”额外结算标记。 */
  hezhongMarkers?: Record<PlayerId, Array<{ kind: 'gt' | 'lt'; value: number }>>
  /** 周鲂【断发】：本出牌阶段实例内已经通过断发弃置的牌数量，按 maxHp 封顶。 */
  duanfaPhaseTotal?: Record<PlayerId, { phaseKey: string; total: number }>
  /** 黄祖【挽弓】：上一张真正使用的牌是不是基本牌，供下一张【杀】判断是否强化。 */
  huangzuLastBasic?: Record<PlayerId, boolean>
  /** 袁谭袁尚【内伐】：本回合的分支、X 值与装备过牌计数。 */
  neifaState?: Record<PlayerId, { branch: 'basic' | 'nonbasic'; x: number; turnNumber: number; equipUseCount: number }>
  /** 徐氏【伏诛】：依次使用牌堆里的杀，跨越多次异步结算需要记住还剩几次机会。 */
  fuzhuPending?: { ownerId: PlayerId; targetId: PlayerId; remaining: number }
  /** 潘濬【观微】：这名角色本出牌阶段实例内使用过的牌花色记录。 */
  panjunSuitLog?: Record<PlayerId, { turnNumber: number; suits: Array<string | null> }>
  /** 陆抗【决堰】防具栏分支：本回合手牌上限+3。 */
  lukangArmorMaxCardsTurn?: number
  /** 陆抗【决堰】坐骑栏分支：本回合使用牌无距离限制。 */
  lukangMountUnlimitedTurn?: number
  /** 陆抗【决堰】宝物栏分支：本回合是否已授予集智（配合 replaceTemporarySkill 清理）。 */
  lukangTreasureGrantTurn?: number
  /** 徐荣【凶镬】选项1：本回合内这名角色不能用杀指定徐荣为目标。 */
  xurongSlashBan?: Record<PlayerId, { turnNumber: number }>
  /** 徐荣【凶镬】选项2：本回合内这名角色手牌上限-1。 */
  xurongMaxCardsDebuff?: Record<PlayerId, { turnNumber: number }>
  /** 徐荣【杀绝】：这名角色最近一次受到伤害时的来源实体牌，供进入濒死时判断取牌。 */
  shajueLastDamageCard?: Record<PlayerId, CardId>
  /** 曹性【流矢】：当前这次虚拟杀的来源信息，等它造成伤害时点判断是否附加流矢标记。 */
  caoxingLiushiPending?: { ownerId: PlayerId; targetId: PlayerId }
  /** 刘琦【问计】：本回合内使用与这张牌同名的牌不能被响应。 */
  liuqiWenjiLock?: Record<PlayerId, { cardName: string; turnNumber: number }>
  /** 刘琦【屯江】：本回合是否进入过出牌阶段。 */
  liuqiPlayPhaseTurn?: number
  /** 刘琦【屯江】：本回合出牌阶段是否已经使用牌指定过其他角色为目标。 */
  liuqiTargetedOthers?: Record<PlayerId, boolean>
  /** 淳于琼【仓储】：本回合是否已经因回合外获得牌而增加过粮。 */
  cangchuGainTurn?: number
  /** 司马徽【荐杰】：龙印/凤印当前分别在谁身上。 */
  simahuiSeals?: { long: PlayerId | null; feng: PlayerId | null }
  /** 陆凯【謇谔】：陆凯抵消一张牌后，本回合不能成为牌的目标。 */
  lukaiJianeUntargetable?: Record<PlayerId, { turnNumber: number }>
  /** 孙皓【残蚀】：本回合是否已发动，发动后使用杀/普通锦囊须付出弃1张牌的代价。 */
  sunhaoCostTurn?: number
  /** 吴景【流兵】：本回合已经视为方块的第一张实体杀。 */
  wujingFirstSlashTurn?: Record<PlayerId, { turnNumber: number; cardId: CardId }>
  /** 吴景【流兵】：这些 Card ID 曾经造成过伤害（跨越单次 CardUse 生命周期的独立记账）。 */
  wujingDamagedCardIds?: CardId[]
  /** 牵招【威抚】：待消费的"下一张同类别牌"加成，可多次叠加。 */
  qianzhaoModifiers?: Record<PlayerId, Array<{ category: CardCategory; turnNumber: number }>>
  /** 杨阜【屏忠】：本回合已使用的牌数（用于判断是否落在前 X 张）。 */
  yangfuCardUseCount?: Record<PlayerId, { turnNumber: number; count: number }>
  /** 杜袭【避凶】：本回合内因弃牌阶段实际弃牌而封锁的花色集合。 */
  duxiForbiddenSuits?: { suits: Suit[]; sinceTurn: number }
  /** 蒋琬【蓄发】：当前可选的普通锦囊转化牌名（发动一次蓄发分支后短暂存在）。 */
  jiangwanPendingNames?: { ownerId: PlayerId; names: string[]; turnNumber: number }
  /** 蒋琬【自若】：本回合是否已经因自若摸牌而不能整理手牌顺序（暂无对应 UI，仅记录）。 */
  jiangwanNoReorderTurn?: number
  /** 朱儁【摧破】：本回合已使用的牌数（用于判断是否命中第 X 张）。 */
  zhujunCardUseCount?: Record<PlayerId, { turnNumber: number; count: number }>
  /** 朱儁【摧破】：本次命中触发的 CardUse，其造成的伤害+1。 */
  zhujunBoundDamageCardId?: { cardId: CardId; turnNumber: number }
  /** 陶谦【纵乱】：这次虚拟杀实际造成伤害的角色集合，供发动方统计 X。 */
  taoqianZongluanDamaged?: { ownerId: PlayerId; players: PlayerId[] }
  /** 陶谦【招祸】：本回合已经因首次受伤触发过的角色集合。 */
  taoqianZhaohuoDamaged?: { turnNumber: number; players: PlayerId[] }
  /** 陶谦【招祸】：因此获得、本回合不能使用/打出且不计入手牌上限的 Card ID。 */
  taoqianZhaohuoLocked?: Record<PlayerId, { cardIds: CardId[]; turnNumber: number }>
  /** 张琪瑛【真仪·紫微】：本次判定生效前选择的强制结果。 */
  zhangqiyingZiweiChoice?: { ownerId: PlayerId; cardId: CardId; suit: 'spade' | 'heart' }
  /** 祢衡【狂才】：本回合是否已经使用过牌（含此，避免只记最后一次）。 */
  mihengUsedCardTurn?: number
  /** 祢衡【狂才】：本回合累计造成的伤害点数。 */
  mihengDamageTurn?: Record<PlayerId, { turnNumber: number; total: number }>
  /** 祢衡【狂才】：本回合手牌上限的临时增减。 */
  mihengMaxCardsDelta?: { turnNumber: number; delta: number }
  /** 祢衡【舌剑】：每个 TurnInstance 已发动次数，按回合归零。 */
  mihengShejianUsed?: Record<PlayerId, { turnNumber: number; count: number }>
  /** 刘辩【诗怨】：三个分支每个 TurnInstance 各自的已发动次数，按回合归零。 */
  liubianShiyuanUsed?: Record<PlayerId, { turnNumber: number; counts: { greater: number; equal: number; less: number } }>
  /** 成公英【匡襄】：因匡襄获得的红牌导致的下一个摸牌阶段摸牌数扣减。 */
  chenggongyingDrawPenalty?: Record<PlayerId, number>
  /** 成公英【匡襄】：因匡襄获得且本回合内有效的黑色 Card ID 记录。 */
  chenggongyingBlackCards?: Record<CardId, { ownerId: PlayerId; sourceId: PlayerId; turnNumber: number }>
  /** 韩馥【恇守】：当前 TurnInstance 内受到过伤害的不同角色集合。 */
  hanfuDamagedTurn?: { turnNumber: number; players: PlayerId[] }
  /** 辛宪英【才识】：本回合手牌上限+1。 */
  xinxianyingCaishiMaxCardsTurn?: number
  /** 辛宪英【才识】：本回合不能对自己使用牌。 */
  xinxianyingCaishiNoSelfTurn?: number
  /** 辛宪英【忠鉴】：本回合已发动次数/解锁的额外次数/手牌上限扣减，按回合归零。 */
  xinxianyingZhongjian?: Record<PlayerId, { turnNumber: number; used: number; extra: number; maxCardsPenalty: number }>
  /** 陈登【丰积】：本轮由丰积产生的摸牌/出杀次数 modifier，按受影响角色记账。 */
  chendengModifiers?: Record<PlayerId, { roundNumber: number; drawDelta: number; slashDelta: number }>
  /** 陈登【旋回】：发动过之后失效，直到任意角色死亡才清除。 */
  chendengXuanhuiDisabled?: Record<PlayerId, boolean>
  /** 阎圃【缓图】：等待在目标结束阶段结算的补偿。 */
  yanpuHuantuPending?: { targetId: PlayerId; turnNumber: number }
  /** 阎圃【缓图】：本次要跳过摸牌阶段的目标。 */
  yanpuSkipDraw?: { targetId: PlayerId; turnNumber: number }
  /** 阎圃【避祸】：当前生效的距离加成，轮开始时按记录的量收回。 */
  yanpuBihuoActive?: { playerId: PlayerId; amount: number; roundNumber: number }
  /** 鲍三娘【武娘】：当前视为杀正在结算的 (使用者,目标) 标记，用于不可响应判定。 */
  baosanniangWuniangActive?: { ownerId: PlayerId; targetId: PlayerId; turnNumber: number }
  /** 鲍三娘【镇南】：正在结算的自定义目标南蛮入侵。 */
  baosanniangZhennanPending?: { cardId: CardId; targetIds: PlayerId[]; turnNumber: number }
  /** 鲍三娘【镇南】：这次南蛮入侵结算过程中已记录受到伤害的目标。 */
  baosanniangZhennanDamaged?: PlayerId[]
  /** 鲍三娘【镇南】：未受伤目标本回合被她使用杀无次数限制。 */
  baosanniangZhennanUnlimited?: Record<PlayerId, { ownerId: PlayerId; turnNumber: number }>
  /** 花鬘【薮影】：(source->target) 本 TurnInstance 内的使用次数记账。 */
  huamanSouyingUseCount?: Record<string, { turnNumber: number; count: number }>
  /** 系力：本 TurnInstance 是否已经发动过。 */
  xiliUsedTurn?: { turnNumber: number }
  /** 诸葛果【祈禳】：绑定这张具体 Card ID 的额外目标 buff。 */
  zhugeguoExtraTargetCardId?: CardId
  /** 孟达【苟得】：本 TurnInstance 内已经出现过的四项标记。 */
  mengdaGoudeSeen?: { turnNumber: number; items: number[] }
  /** 李严【督粮】：下个摸牌阶段多摸1张的目标集合。 */
  liyanNextDrawBonus?: Record<PlayerId, boolean>
  /** 李严【腹鳞】：本回合内各角色实际获得过的 Card ID。 */
  liyanGainedThisTurn?: Record<PlayerId, { turnNumber: number; cardIds: CardId[] }>
  /** 彭羕【嚣翻】：本回合已经使用过的牌张类型集合。 */
  pengyangUsedTypesTurn?: Record<PlayerId, { turnNumber: number; types: CardCategory[] }>
  /** 彭羕【侻失】：嚣翻因3次伤害牌未命中而失效至本回合结束。 */
  pengyangXiaofanDisabled?: { turnNumber: number; ownerId: PlayerId }
  /** 彭羕【侻失】：下一次对手牌数更少角色使用牌无距离/次数限制的待消费 buff。 */
  pengyangTuoshiBuffPending?: { ownerId: PlayerId; turnNumber: number }
  /** 彭羕【侻失】：本回合内使用伤害类牌但未造成伤害的次数。 */
  pengyangFailedDamageTurn?: { turnNumber: number; count: number }
  /** 许攸【成略】：本回合内因弃牌花色获得的无距离/次数限制的花色集合。 */
  xuyouChengueSuits?: { turnNumber: number; ownerId: PlayerId; suits: Suit[] }
  /** 严颜【拒战】阳：本回合内某角色不能对严颜使用牌。 */
  yanyanBlockedByOthers?: Record<PlayerId, { turnNumber: number; blockedSourceId: PlayerId }>
  /** 严颜【拒战】阴：本回合内严颜不能对某角色使用牌。 */
  yanyanSelfBlocked?: Record<PlayerId, { turnNumber: number; blockedTargetId: PlayerId }>
  /**
   * 挂起中的"来源侧是否防止这次伤害"发问现场（马谡【制蛮】）。
   * 记录时还没有任何伤害相关状态被改动，续接时原样重新走 `resolveDamage`。
   */
  pendingSourceDamage?: { options: Record<string, unknown> }
  /** 张宝【咒缚】：本 TurnInstance 内失去过"咒"的角色，TurnEnd 各扣1点体力。 */
  zhangbaoLostCurseTurn?: { turnNumber: number; playerIds: PlayerId[] }
  /** 张宝【影兵】：按"咒"的 Card ID 记录已经触发过几次摸牌。 */
  zhangbaoYingbingCount?: Record<CardId, number>
  /** 管亥【诱阙】：本回合出牌阶段是否已经因没有黑桃"饵"而失效。 */
  guanhaiYouqueDisabled?: { turnNumber: number; ownerId: PlayerId }
  /** 管亥【诱阙】：等待结算的"没赢者视为使用杀"是否造成过伤害。 */
  guanhaiPendingSlashDamage?: { turnNumber: number; sourceId: PlayerId; targetId: PlayerId }
  /** 武安国【历勇】：本回合已经使用过的牌张花色集合。 */
  wuanguoUsedSuitsTurn?: Record<PlayerId, { turnNumber: number; suits: Suit[] }>
  /** 马休马铁【垦伤】：正在结算的多子牌虚拟杀，记录目标数量与绑定 Card ID。 */
  maxiuKenshangPending?: { turnNumber: number; n: number; cardId: CardId }
  /** 华歆【草诏】：本局已经声明过的牌名，按角色分别记录。 */
  huaxinDeclaredNames?: Record<PlayerId, string[]>
  /** 华歆【息兵】：本回合内某角色不能使用牌指定某个被保护角色为目标。 */
  huaxinXibingBlocked?: Record<PlayerId, { turnNumber: number; protectedId: PlayerId }>
  /** 马日磾【秉节】：本回合内是否处于生效状态。 */
  maridiBingjieActive?: { turnNumber: number; ownerId: PlayerId }
  /** 王朗【激词】：拼点点数覆盖，一次性，用完即清。 */
  wanglangJici?: Record<PlayerId, { overrideRank: number }>
  /** 郭皇后【殚心】：矫诏的升级等级。 */
  guohuanghouJiaozhao?: Record<PlayerId, { level: 0 | 1 | 2 }>
  /** 孔淑【累卵】：本轮已经声明过的基本牌名。 */
  kongshuUsedBasics?: Record<PlayerId, { roundNumber: number; names: string[] }>
  /** 孔淑【累卵】：连续发动的轮次记录，用于推算 X。 */
  kongshuStreakRound?: Record<PlayerId, { roundNumber: number; streak: number }>
  /** 孔淑【累卵】：本轮进入弃牌堆的普通锦囊牌名（按牌使用记录，已知简化）。 */
  kongshuRoundTricks?: { roundNumber: number; names: string[] }
  /** 赵忠【抵慈】：等待目标由未连环变为连环的后续处理。 */
  zhaozhongDiciPending?: { ownerId: PlayerId; targetId: PlayerId }
  /** 成济成倅【透髓】：待结算的杀需要的闪张数。 */
  chengjiTousuiPending?: { ownerId: PlayerId; targetId: PlayerId; n: number }
  /** 成济成倅【畜鸣】：回合结束时延迟反用的实体伤害牌记录。 */
  chengjiChumingPending?: { turnNumber: number; ownerId: PlayerId; otherId: PlayerId; cardId: CardId }
  /** 朱灵【急陷】：本次虚拟杀是否已经造成伤害。 */
  zhulingPending?: { turnNumber: number; targetId: PlayerId; dealt: boolean }
  /** 阎柔【襄戍】：本回合造成的伤害点数总和。 */
  yanrouTurnDamage?: Record<PlayerId, { turnNumber: number; total: number }>
  /** 董翓【鞭御】：当前被授予无限次杀的具体 Card ID 列表，按受伤角色记录。 */
  dongheBianyuCards?: Record<PlayerId, CardId[]>
  /** 孔淑【覆巢】：延后到 AfterCardUse 时机才安全执行的额外结算记录。 */
  kongshuFuchaoPending?: { ownerId: PlayerId; sourceId: PlayerId; cardName: string; category: string }
  skillResolution: SkillResolutionState | null
  skillQueue: QueuedSkillPrompt[]
  /**
   * 随机源的当前状态。
   *
   * 只有 seed 是不够的：Durable Object 休眠再醒来时，如果从 seed 重新推导，
   * 已经消耗掉的那些随机数就丢了，之后的洗牌和判定会和休眠前发散。
   * 保存时由 `serialize()` 写入，恢复时由 `restore()` 读回。
   */
  rngState: number
  /**
   * 实体牌当前「被当作什么用」。
   *
   * 转化技把一张红桃当【乐不思蜀】放进判定区之后，判定时必须按转化后的牌名结算，
   * 而判定区里只存牌 id。所以在这里额外记一笔，牌离开判定区时由 `moveCard` 清掉。
   * 普通锦囊不需要它——那条路上转化后的牌名直接存在 `cardResolution.cardName` 里。
   */
  cardAliases: Record<CardId, string>
  /** 本次结算里被临时改写的伤害属性（龙魂的方块火杀）。见 zones.ts。 */
  cardNatures: Record<CardId, DamageNature>
  decisions: GameDecision[]
  result: GameResult | null
}

export function emptyEquipment(): EquipmentZone {
  return { weapon: null, weapon2: null, armor: null, offensiveHorse: null, defensiveHorse: null }
}
