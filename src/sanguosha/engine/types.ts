import type { GameRequest } from './requests'
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
  /** 技能生成的临时牌。结算结束后销毁，不进入弃牌堆，也不计入牌堆组成。 */
  virtual?: boolean
  /** 生成这张虚拟牌的技能，用于结算完成后的技能奖励。 */
  sourceSkillId?: string
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
  distanceFromOthers: number
  distanceToOthers: number
  attackRangeBonus: number
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
  slashUses: number
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
  expiry: 'source-next-turn-start'
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
  decisions: GameDecision[]
  result: GameResult | null
}

export function emptyEquipment(): EquipmentZone {
  return { weapon: null, armor: null, offensiveHorse: null, defensiveHorse: null }
}
