
import type { EventContext, GameEvent, GameEventName } from '../events'
import { clearForcedAwakening, hasForcedAwakening } from '../forced-awakening'
import type { LegalAction } from '../actions'
import type { GameRequest, GameResponse } from '../requests'
import type { ChooseCardsRequest } from '../requests'
import type { GameRng } from '../rng'
import { isSkillSuppressed } from '../skill-suppression'
import { equipmentEffectsSuppressed } from '../equipment-suppression'
export { equipmentEffectsSuppressed } from '../equipment-suppression'
import { revealedGeneralCharacterIdsOf } from '../general-slots'
import { cardColorOverrideOf } from '../card-color'
import { blocksMilitaryOrderHandCard, retainOnlyLockedSkills, suppressesMilitaryOrderSkills } from '../modes/military-order'
import { isLockedSkill } from '../locked-skills'
import type { MultiCardViewAsSpec } from '../multi-card-viewas'
import type { CardCategory, CardId, DamageNature, PlayerId, QueuedSkillPrompt, SanguoshaState, SkillResolutionState, Suit, TurnPhase } from '../types'

export interface TargetedCardContext {
  sourceId: PlayerId
  targetId: PlayerId
  cardId: CardId
  cardName: string
  category: CardCategory
}

export interface DamageSourceContext {
  sourceId: PlayerId | null
  targetId: PlayerId
  cardId: CardId | null
  cardName: string | null
  chainTransfer: boolean
}

export interface ResolvedCardContext {
  sourceId: PlayerId
  cardId: CardId
  cardName: string
  targetIds: PlayerId[]
  cancelled: boolean
}

/**
 * 技能运行时。
 *
 * 三条约束，都是被参考项目和任务书点过名的：
 *
 * 1. **技能处理器是运行时代码，不能序列化。**
 *    Durable Object 醒来之后必须重新调用 `registerAllSkills`，
 *    绝不能指望把函数存进 GameState。
 * 2. **技能不自己算距离、不自己判合法性。**
 *    距离改动走 `distanceModifier`，出杀次数走 `unlimitedSlash`，
 *    统一入口只有一个，技能只负责报告修正值。
 * 3. **转化技必须产出真正的 LegalAction。**
 *    「关羽的红牌可以当杀用」不能靠前端自己猜，
 *    引擎要把「用这张红牌当杀打某人」作为一条独立动作发出去，
 *    玩家才点得到，AI 才选得到，回放才对得上。
 */

/** 一次伤害在被防止之前的全部已知信息。 */
export interface DamagePreventionContext {
  sourceId: PlayerId | null
  targetId: PlayerId
  amount: number
  nature: DamageNature
  cardId: CardId | null
  cardName: string | null
  chainTransfer: boolean
}

export interface SkillHost {
  state: SanguoshaState
  rng: GameRng
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
  /**
   * 技能向某名玩家发问，并把「问到哪一步」写进可序列化的 SkillResolutionState。
   *
   * 只允许在能安全挂起的时机调用——回合开始、阶段开始这类边界。
   * 引擎收到回应后会回调这个技能的 `resume`。
   *
   * `build` 拿到引擎分配的 requestId，用它组装 Request，
   * 免得技能自己编 id 撞车。
   */
  askSkill(options: {
    skillId: string
    ownerId: PlayerId
    step: string
    data?: Record<string, unknown>
    build(requestId: string): GameRequest
  }): void
  /** Re-run a suspended root operation after a choice at a pre-draw interruption point. */
  resumeDrawOperation?(options: {
    skillId: string
    attemptIndex: number
    step: string
    playerId: PlayerId
    requestId: string
    requestKind: string
    payload: unknown
  }): void
  /**
   * 把发问推迟到牌局回到干净状态。
   *
   * 「受到伤害后」这类时机必须走这里：当场发问会让玩家的回答
   * 和还没走完的伤害/濒死结算错位。触发时把需要的事实抓进 `data`，
   * 引擎稍后回调这个技能的 `startQueued`。
   */
  queueSkill(prompt: QueuedSkillPrompt): void
  /** 技能造成的「失去体力」把人打到 0 时走这里，不允许技能自己判死。 */
  enterDying(playerId: PlayerId): void
  /** 濒死前置技能（如陈情）以虚拟桃救援，并续接同一濒死栈。 */
  useVirtualPeachDuringDying(sourceId: PlayerId, dyingPlayerId: PlayerId, reason: string, physicalCardIds?: CardId[]): boolean
  /** 濒死技能结束后恢复属性链、判定或卡牌结算。 */
  resumeAfterDying(): void
  /**
   * 技能发起一张无距离和次数限制的【杀】。
   *
   * 不给 `cardId` 就是纯虚拟【杀】；给了则用这张实体手牌当载体，
   * 牌该弃还是照常弃，花色和火/雷属性照常生效。
   */
  /** 「视为使用一张【杀】」。返回 false 表示被封牌规则挡住、这次没用出去。 */
  beginVirtualSlash(options: {
    sourceId: PlayerId
    targetId?: PlayerId
    targetIds?: PlayerId[]
    sourceSkillId: string
    nature?: DamageNature
    cardId?: CardId
    /** 这张虚拟【杀】算不算一次出杀次数；不传按老行为不计次数。 */
    countUsage?: boolean
    /** 技能明确规定此杀不受距离限制时使用。 */
    ignoreDistance?: boolean
    /** 本次技能杀无视目标防具，仅持续到这张牌结算完毕。 */
    ignoreArmor?: boolean
    /** 指定目标响应这张【杀】前须额外弃置一张牌。 */
    responseDiscardCostTargetIds?: PlayerId[]
    /** 指定目标不能以【闪】响应此【杀】。 */
    noDodgeTargetIds?: PlayerId[]
    /** 该技能杀可指定的合法目标上限。 */
    maxTargets?: number
    /** 转换规则明确允许时，实体载体可同时指定多个目标。 */
    allowMultipleTargetsWithPhysicalCard?: boolean
    /** 该技能杀的基础伤害修正。 */
    damageBonus?: number
    /** Card user remains sourceId while damage attribution can be source-less. */
    damageSourceId?: PlayerId | null
  }): boolean
  /** 直接使用另一名角色手牌里的实体牌，避免先获得到手牌再转换使用。 */
  beginSkillSlashFromOtherHand(options: { sourceId: PlayerId; physicalOwnerId: PlayerId; cardId: CardId; targetId: PlayerId; sourceSkillId: string }): boolean
  /** 技能在使用时机内真实使用一张虚拟基本牌，并复用普通出牌合法性与结算管线。 */
  beginVirtualBasic(options: { sourceId: PlayerId; targetIds: PlayerId[]; cardName: string; sourceSkillId: string }): boolean
  /** 由技能时机授权，将一张实体手牌按普通合法性完整使用为基本牌。 */
  beginSkillBasicUse(options: { sourceId: PlayerId; cardId: CardId; cardName: string; targetIds: PlayerId[]; sourceSkillId: string }): boolean
  /** 使用明确由技能授权、且正位于弃牌堆中的实体【杀】。 */
  beginSkillSlashFromDiscard(options: { sourceId: PlayerId; cardId: CardId; targetId: PlayerId; sourceSkillId: string }): boolean
  /** 将弃牌堆中的实体牌按【闪电】使用，复用真实延时锦囊生命周期。 */
  beginSkillLightningFromDiscard(sourceId: PlayerId, cardId: CardId, sourceSkillId: string): boolean
  /** 技能真实使用一张虚拟即时锦囊，完整经过无懈、目标与弃置生命周期。 */
  beginVirtualTrick(options: { sourceId: PlayerId; targetId?: PlayerId; targetIds?: PlayerId[]; cardName: string; sourceSkillId: string; cardId?: CardId; extraCardIds?: CardId[]; damageAmount?: number }): boolean
  /** 使用一张无实体材料的延时锦囊，并按实体延时锦囊生命周期留在判定区。 */
  beginVirtualDelayedTrick(options: { sourceId: PlayerId; targetId: PlayerId; cardName: string; sourceSkillId: string }): boolean
  /** 由规则明确授权在通常出牌阶段之外使用一张手牌。 */
  performSkillCardAction(options: { playerId: PlayerId; cardOwnerId: PlayerId; cardId: CardId; sourceSkillId: string; actionId: string }): void
  /** 使用因技能效果仍在处理区、且已授权给指定角色使用的实体牌。 */
  beginSkillCardUseFromProcessing(playerId: PlayerId, cardId: CardId, sourceSkillId: string, actionId: string): boolean
  /** 技能授权从弃牌堆使用实体牌；可选声明牌名，合法性仍走普通用牌规则。 */
  beginSkillCardUseFromDiscard(playerId: PlayerId, cardId: CardId, sourceSkillId: string, actionId: string, asCardName?: string,
    options?: { ignoreDistance?: boolean; ignoreUsageLimits?: boolean }): boolean
  beginSkillCardUseFromOtherHand(playerId: PlayerId, physicalOwnerId: PlayerId, cardId: CardId | CardId[], sourceSkillId: string,
    actionId: string, asCardName?: string, nature?: DamageNature,
    options?: { allowSelf?: boolean; ignoreDistance?: boolean; ignoreUsageLimits?: boolean }): boolean
  /** 技能授权将他人手牌转化成实体锦囊并使用。 */
  beginSkillDeclaredCardUseFromOtherHand(options: { playerId: PlayerId; physicalOwnerId: PlayerId; cardId: CardId; asCardName: string; targetIds: PlayerId[]; sourceSkillId: string }): boolean
  /** “成为目标后”的技能回答完毕，把控制权交回当前牌的结算管线。 */
  resumeCardTarget(): void
  /** 技能完成阶段替代效果后，按统一回合状态机进入下一阶段。 */
  advancePhase(): void
  /**
   * 「付代价跳过这个阶段」的窗口里回答完了，接着往下走。
   *
   * 无论玩家选的是跳过还是放弃都要调它：跳过的话技能自己先调过
   * `skipPhase`，这里会把阶段收掉；放弃的话这里会继续问下一个技能，
   * 都没有了就正式开始这个阶段。**技能不要自己发 `PhaseStart`，
   * 也不要自己调 `advancePhase` 来「跳过」**——那样跳过的语义会有两套。
   */
  resumePhaseEntry(): void
  /**
   * **真正结束当前的出牌阶段**（神甘宁【魄袭】弃一张时）。
   *
   * 不是「AI 放弃」，也不是「禁止再出牌但仍停留在阶段里」——
   * 阶段状态机要往前走到弃牌阶段，后面的弃牌照常按修正后的手牌上限结算。
   * 只对当前正在进行的、属于这名角色的出牌阶段生效。
   */
  endPlayPhaseEarly(playerId: PlayerId): void
}

/**
 * 技能自己播横幅，引擎不要再补兜底那条。
 *
 * 引擎默认会在技能被肯定发动时补一条 `SkillActivated`，给的是「谁发动了【X】」
 * 这种通用文案。有些技能自己发的那条信息更全（带目标、带战报文案），
 * 两条挨在一起就是牌桌中央同一个技能名连播两遍。
 *
 * 只给**每次发动都会自己报**的技能加这个标记。像【牛来】那种只在收手/爆仓时
 * 报结果的，仍然需要引擎那条开场横幅，不要加。
 */

export interface SkillTrigger {
  event: GameEventName
  /** 死亡事件中允许刚刚阵亡的技能拥有者完成遗言类技能。 */
  allowDeadOwner?: boolean
  /** 数字越大越先执行，和 GameEventBus 的排序一致。 */
  priority?: number
  handle(host: SkillHost, ownerId: PlayerId, context: EventContext): void
}

/** 一张手牌可以被转化成什么牌来用。 */
export interface ViewAsOption {
  /** 转化后当作哪张牌 */
  asCardName: string
  /** 需要打出的原牌 */
  cardId: CardId
  /** 展示给玩家的说明，多用途牌靠它区分用途 */
  label: string
  /** 转化出的【杀】属性；不提供时按牌自身属性处理。 */
  nature?: DamageNature
  /** 转化时保留实体材料（「改为展示」而非弃置）。仅用于正式视为使用路径。 */
  retainCard?: boolean
}

/** 由技能/公共效果发起的虚拟【杀】；拦截器可在牌进入结算前挂起并续接。 */
export interface VirtualSlashUseContext {
  sourceId: PlayerId
  targetIds: PlayerId[]
  sourceSkillId: string
  nature?: 'normal' | 'fire' | 'thunder'
  cardId?: CardId
  countUsage?: boolean
  maxTargets?: number
  /** Explicit permission for a physical carrier card to resolve as a multi-target Slash. */
  allowMultipleTargetsWithPhysicalCard?: boolean
  damageBonus?: number
  ignoreArmor?: boolean
  noDodgeTargetIds?: PlayerId[]
  responseDiscardCostTargetIds?: PlayerId[]
}

export interface SkillRuntime {
  id: string
  /** An unconditional prevention has resolved; stateful armor-like rules may now consume a source. */
  onDamagePrevented?(host: SkillHost, ownerId: PlayerId, side: 'source' | 'target', context: DamagePreventionContext): void
  /** A locked transformation may replace the effective name of a committed physical card use. */
  useCardNameOverride?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId, cardId: CardId,
    cardName: string, targetIds: readonly PlayerId[]): string | null
  /** 锁定技造成条件性技能失效时，集中于拥有技能集合出口过滤（于吉【缠怨】）。 */
  invalidatesOtherSkills?(state: SanguoshaState, ownerId: PlayerId): boolean
  /** 全局按角色状态令指定角色的非锁定技能失效（如手牌带“筝”的角色）。 */
  globallyInvalidatesSkill?(state: SanguoshaState, targetId: PlayerId, skillId: string): boolean
  /** 全局压制指定角色的非锁定武将技（界贾诩【完杀】：濒死结算期间）。 */
  globallyInvalidatesOtherSkills?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean
  /** 供化身资格判断使用，不能靠技能 id 黑名单。 */
  limited?: boolean
  lord?: boolean
  /** 选将完成并进入 playing 后初始化本技能的可序列化局内资源。 */
  onGameStart?(host: SkillHost, ownerId: PlayerId): void
  /** 弃牌阶段确定弃牌后、实际移区前的可选公共替代处理。返回 true 表示技能接管此次结算。 */
  interceptDiscardPhaseSelection?(host: SkillHost, ownerId: PlayerId, request: ChooseCardsRequest, response: GameResponse): boolean
  /** 弃牌阶段选中的牌若改为交给其他角色，返回接收者；否则返回 null。 */
  discardPhaseRecipient?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): PlayerId | null
  /** 仅拦截主动使用，不影响响应/打出；用于阶段内次数类公共限制。 */
  prohibitsCardIdUse?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): boolean
  /** 由技能拥有者施加给另一角色的主动用牌限制。 */
  globallyProhibitsCardUse?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardId: CardId): boolean
  /** 把弃牌阶段选中的牌改为交给另一角色；用于延迟结算的全局效果。 */
  globallyRedirectsDiscardPhaseCard?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardId: CardId): PlayerId | null
  /** Override this player's initial hand count for mode-dependent character rules. */
  initialHandCount?(state: SanguoshaState, ownerId: PlayerId, normalCount: number): number | null
  /** A global skill may adjust another player's dealt opening-hand count. */
  globalInitialHandModifier?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): number
  /** Optional state-dependent wording shown by existing player skill glossary surfaces. */
  descriptionForView?(state: SanguoshaState, ownerId: PlayerId): string | undefined
  /** 见上方说明：这个技能每次发动都自己播横幅，引擎不补兜底那条。 */
  announcesSelf?: boolean
  /** 挂到事件总线上的触发技。 */
  triggers?: SkillTrigger[]
  /**
   * 主动用牌真正进入处理区之前的可挂起拦截点。
   * 返回 true 表示技能已经发出可序列化 Request，原动作暂不继续。
   */
  interceptPlayAction?(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>): boolean
  /** 虚拟/技能发起的【杀】在实体牌转移前拦截，返回 true 表示已挂起原动作。 */
  interceptVirtualSlash?(host: SkillHost, ownerId: PlayerId, context: VirtualSlashUseContext): boolean
  /**
   * 阶段开始**之前**的「付代价跳过这个阶段」机会（张郃【巧变】、刘禅【放权】）。
   *
   * 引擎只问当前回合角色自己的技能——能跳过的只有自己的阶段。
   * 返回 true 表示技能已经发出可序列化 Request，阶段暂不开始；
   * 玩家答完之后技能**必须**调 `host.resumePhaseEntry()` 把控制权交回来，
   * 否则牌局就停在这里了。
   *
   * 真要跳过时调 `skipPhase(state, phase)`，走的是和兵粮寸断、乐不思蜀
   * 同一份 `skippedPhases`；**不要**用「摸 0 张」「手牌上限设无穷」
   * 这类假跳过糊弄过去，那样阶段技能的时机全是错的。
   */
  offerPhaseSkip?(host: SkillHost, ownerId: PlayerId, phase: TurnPhase): boolean
  /**
   * 觉醒技：条件满足即**强制**发动，一局一次。
   *
   * 邓艾【凿险】、姜维【志继】、刘禅【若愚】共用这一套，各自只提供
   * 条件和效果，不各写一份 PhaseStart 触发和「发动过没有」的私有开关。
   *
   * 三条纪律：
   * - **不问玩家要不要觉醒**。觉醒技是强制的，条件成立就发动；
   *   效果内部的选择（志继选回复还是摸牌）才是玩家的决定。
   * - **一局一次由引擎记账**（`player.awakenedSkills`），可序列化、
   *   重连之后仍然算已觉醒，技能不要自己维护 `zaoxianDone` 这种私有标记。
   * - 觉醒过程可以挂起发问；引擎在调用 `invoke` **之前**就已经记好账了。
   */
  awakening?: {
    /** 什么阶段检查。经典觉醒技都在准备阶段。 */
    phase: TurnPhase
    priority?: number
    /** 条件成立吗。只读状态，不要在这里改动牌局。 */
    ready(state: SanguoshaState, ownerId: PlayerId): boolean
    /** 发动。可以调 host.askSkill 挂起。 */
    invoke(host: SkillHost, ownerId: PlayerId): void
  }
  /**
   * 把某个阶段位**改成**另一个阶段（神孙权【持纲】）。
   *
   * 返回要换成的阶段，返回 null / undefined 表示照原样跑。
   * 换上来的是**真阶段**：`PhaseStart` / `PhaseEnd` 报新阶段，
   * 阶段内容也按新阶段跑。被换掉的那个阶段不执行。
   */
  replacesPhase?(state: SanguoshaState, ownerId: PlayerId, slot: TurnPhase): TurnPhase | null

  /**
   * 锁定技：回合开始时**额外执行**一个阶段（廖化【当先】）。
   *
   * 返回要执行的阶段，返回 null / undefined 表示这个回合不给。
   * 和 `replacesPhase` 的区别在「额外」二字：没有阶段位被顶掉，
   * 这个回合原有的六个阶段一个不少地照跑。
   *
   * **必须是锁定技、必须同步返回**：判定发生在 `beginTurn` 里，
   * 那里发不了问。需要询问的额外阶段要另起一个可挂起的窗口。
   */
  extraPhaseAtTurnStart?(state: SanguoshaState, ownerId: PlayerId): TurnPhase | null

  /**
   * 攻击范围**定值覆盖**（史阿【砺刃】"攻击范围始终为2"）。
   *
   * 和武器/坐骑/distanceModifier 的加减法不同：这是"不管装备什么、
   * 不管别的加成，最终结果就是这个数"，所以放在 `getAttackRange` 计算
   * 完普通公式之前单独短路返回，不参与 `attackRangeBonus` 累加。
   * 多个技能都声明覆盖时取第一个命中的（当前没有武将会撞车）。
   */
  overridesAttackRange?(state: SanguoshaState, ownerId: PlayerId): number | null
  /** 普通攻击范围的动态加值（攻击范围+N），与距离修正相互独立。 */
  attackRangeBonus?(state: SanguoshaState, ownerId: PlayerId): number
  /** 拥有者给指定角色的攻击范围加值；与距离修正相互独立。 */
  globalAttackRangeBonus?(state: SanguoshaState, ownerId: PlayerId, actorId: PlayerId): number
  /** Absolute attack range for a specific physical card, when the rule replaces weapon range. */
  attackRangeForCard?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): number | null

  /**
   * 按【杀】的**属性**多指定几个目标（程普【疠火】的火【杀】+1）。
   *
   * 和 `slash-rules.ts` 里那个回合级的 `extraTargets` 分开：那一个是
   * 「这一回合每张杀都多一个目标」（太史慈【天义】），这一个只看这张牌
   * 是什么属性，和回合无关。两者在 `slashTargetLimit` 里相加。
   */
  extraSlashTargets?(state: SanguoshaState, ownerId: PlayerId, nature: DamageNature): number
  /** Specific living players granted as selectable additional targets for this player's Slash. */
  extraSlashTargetIds?(state: SanguoshaState, ownerId: PlayerId): PlayerId[]
  /** Conceal this owner's Slash targets from all viewers except the source and each target. */
  concealsSlashTargets?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): boolean
  /** 锁定技：出牌阶段【杀】不限次。 */
  unlimitedSlash?: boolean | ((state: SanguoshaState, ownerId: PlayerId) => boolean)
  /** 本次【杀】的回合/阶段次数不记账（一次性通用出牌额度豁免）。 */
  slashUseQuotaBypass?(state: SanguoshaState, ownerId: PlayerId, cardId?: CardId): boolean
  /** 锁定技：使用【酒】不受通常每回合次数限制。 */
  unlimitedWine?: boolean
  /** 本回合使用牌均不受通常次数限制；由共享牌使用入口同时覆盖【杀】与【酒】等有次数账目的牌。 */
  unlimitedCardUses?: boolean | ((state: SanguoshaState, ownerId: PlayerId, cardId?: CardId) => boolean)
  /** A skill owner may grant a specific card in another player's hand unlimited use this turn. */
  globalUnlimitedCardUses?(state: SanguoshaState, ownerId: PlayerId, actorId: PlayerId, cardId: CardId): boolean
  /** 按本次实体牌动态豁免【酒】次数限制；用于有花色条件的效果。 */
  unlimitedWineFor?(state: SanguoshaState, ownerId: PlayerId, cardId?: CardId): boolean
  /** Character-card subzones whose physical cards may be played from their own area. */
  playableCharacterPiles?(state: SanguoshaState, ownerId: PlayerId): string[]
  /** Equipment-derived unlimited slash effect that varies with the owner's current loadout. */
  unlimitedSlashFor?(state: SanguoshaState, ownerId: PlayerId, cardId?: CardId): boolean
  /**
   * 条件式无距离使用【杀】；状态必须来自可序列化牌局数据。
   *
   * `cardId` 是这次要用的**载体实体牌**，转化技也给。
   * 神关羽【武神】只对**红桃**牌当的【杀】免距离，手上一张真的黑桃【杀】
   * 仍然要讲距离——所以不能只按「这个人有没有这个技能」判断，
   * 必须看具体是哪张牌。没有载体的调用点（纯虚拟杀）传 undefined。
   */
  slashIgnoresDistance?(state: SanguoshaState, ownerId: PlayerId, cardId?: CardId): boolean
  /**
   * 【杀】实际开始前由服务器补充目标。候选已经过存活、自身和禁止目标检查；
   * 随机选择必须使用 host.rng。
   */
  modifySlashTargets?(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], candidateIds: PlayerId[]): PlayerId[]
  /** 锁定技：使用锦囊时无视距离限制（奇才）。 */
  /**
   * 使用锦囊时无视距离限制（奇才）。
   *
   * 允许写成函数：有些效果只在某个条件下成立（神孙权【圣质】只管「下一张牌」），
   * 写死成布尔就只能是「一直有」或「一直没有」。
   */
  ignoresTrickDistance?: boolean | ((state: SanguoshaState, ownerId: PlayerId, cardId?: CardId) => boolean)
  /**
   * 使用普通锦囊（非延时、非全体固定目标）时可以额外指定/减少一个目标（石苞【擢升】）。
   *
   * 目标增减在**动作生成**这一层解决，不是「用牌后再问」：单/双目标即时锦囊
   * 共用同一套按 `targetIds` 逐个结算的循环（见 tricks.ts 顶部注释），只要
   * 生成动作时给出更长/更短的 `targetIds`，后续无懈、效果结算不需要改一行。
   */
  modifiesTrickTargetCount?(state: SanguoshaState, ownerId: PlayerId): boolean
  /** Pending skill that modifies the target count of the next basic or non-delayed trick. */
  modifiesNextCardTargets?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, cardName: string): boolean
  /**
   * 为下一张基本牌或普通锦囊提供一次多目标扩展。候选牌必须先通过技能自身的
   * 限制（例如奔袭的“距离为1”）；引擎仍会再次检查存活、重复目标和目标禁止。
   */
  nextCardTargetExpansion?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, cardName: string):
    { maxAdditionalTargets: number; candidateIds: PlayerId[] } | null
  /** Target-dependent extra Slash targets, evaluated while the player is choosing a concrete target set. */
  slashTargetExpansionForAction?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, targetIds: readonly PlayerId[]):
    { maxAdditionalTargets: number; candidateIds: PlayerId[] } | null
  /** Repeat one Slash target's full response/effect sequence once after its first resolution. */
  repeatSlashTarget?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardId: CardId): boolean
  /** Repeat a card target's complete effect sequence this many additional times. */
  repeatTargetEffectCount?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardId: CardId): number
  /** A source skill owned by someone other than the current card user repeats this target's effect. */
  globalRepeatTargetEffectCount?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId, targetId: PlayerId, cardId: CardId): number
  /** 指定某种锦囊可额外选择的目标数；与通用锦囊目标增减技能分开。 */
  extraTargetsForTrick?(state: SanguoshaState, ownerId: PlayerId, cardName: string): number
  /** Another character's skill may grant this actor one conditional trick target. */
  globalExtraTargetsForTrick?(state: SanguoshaState, ownerId: PlayerId, actorId: PlayerId, cardName: string, cardId: CardId): number
  /** Skill-authorized concrete multi-target sets for a particular trick use. */
  additionalTargetSetsForTrick?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, cardName: string): PlayerId[][]
  /** 技能指定的普通锦囊不能响应无懈；范围锦囊是否受影响由技能自行判定。 */
  cannotBeNullified?(state: SanguoshaState, ownerId: PlayerId, cardName: string): boolean
  /** 由此技能转化打出的响应牌不能被后续响应（界卧龙【看破】）。 */
  unanswerableResponses?: string[]
  /**
   * 可以被钟琰【博览】这类"动态随机技能池"临时授予（源自钟琰当前批次）。
   *
   * 这是一份**显式白名单**，不是对整个技能表做安全性扫描——现有几百个技能
   * 各自依赖各自武将的初始化/专属状态，逐一审计不在本批范围内。只标记
   * 本项目里已确认"出牌阶段限一次、完全自包含、随便哪个角色拿到都能正常
   * 运作"的技能，候选池天然会小，"候选不足3个"在博览自己的规则文字里
   * 就是被允许的结果。
   */
  bolanEligible?: boolean
  /**
   * 薛灵芸【思泣】：自己的红色实体牌因正常流程准备进入弃牌堆时，改为置入牌堆底。
   *
   * 只接入了弃牌阶段这一条路径（`phase.ts` 的 `resolveDiscardPhaseResponse`）——
   * 那是"红牌准备进弃牌堆"最主要也最常见的入口；其余技能各自的弃置成本
   * 分散在几十个调用点，逐一接管超出这批的合理范围，按已知简化处理。
   */
  redirectsOwnDiscardToBottom?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): boolean
  /**
   * 张陵【授符】的"箓"：拥有者不能使用/打出手牌中与箓同类别的牌。
   *
   * 和 `cardCategoryLocks`（杨修【鸡肋】）判据一样但生命周期不同——箓要跨回合
   * 持续到技能自己声明的条件（受到伤害/弃牌阶段同类别弃≥2张）才清除，
   * 不能套用鸡肋"回合结束自动清"那条路径，所以走独立的技能钩子。
   */
  locksOwnCategories?(state: SanguoshaState, ownerId: PlayerId): CardCategory[]
  /** 指定锦囊的额外使用距离；断粮只给【兵粮寸断】增加 1。 */
  trickDistanceBonus?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardName: string): number
  /** 拥有者持续可见牌堆顶几张牌（晋司马懿【鹰视】），0 表示不提供。 */
  drawPileTopVisibleCount?(state: SanguoshaState, ownerId: PlayerId): number
  /** 拥有者当前不能使用/打出哪些花色的（实体）手牌（杨芷【婉嫕】）。 */
  locksOwnSuits?(state: SanguoshaState, ownerId: PlayerId): Suit[]
  /**
   * 锁定技：指定牌对拥有者无效。和「不能成为目标」是两个不同规则——
   * 无效的角色**仍然是这张牌的合法目标**，只是这张牌对他不产生效果。
   *
   * `cardColor` 是这张牌的**有效颜色**（转化技按实体牌算，多张实体牌合成的
   * 转化牌按统一口径算），技能凭空生成的虚拟牌没有颜色，是 null。
   * 于禁【毅重】按它判断「黑色的【杀】」——只看印刷颜色或者只看第一张子牌都是错的。
   */
  cardEffectInvalid?(
    state: SanguoshaState,
    ownerId: PlayerId,
    sourceId: PlayerId | null,
    cardName: string,
    cardColor?: 'red' | 'black' | null,
    targetId?: PlayerId,
  ): boolean
  /** 锁定技：在伤害事件产生前改写伤害来源。 */
  modifyDamageSource?(state: SanguoshaState, ownerId: PlayerId, context: DamageSourceContext): PlayerId | null | undefined
  /**
   * 拥有者这张拼点牌的有效点数覆盖（秦宓【天辩】：自己的红桃拼点牌视为 13）。
   * 返回 null/undefined 表示不覆盖，按牌面点数算。只改拼点里的比较值，
   * 不改这张牌本身的点数。
   */
  pindianRankOverride?(state: SanguoshaState, ownerId: PlayerId, card: { rank: number; suit?: string }): number | null | undefined
  /** Ask an owner-side optional skill before that participant privately commits a Pindian card. */
  offersPindianSelectionAsk?(host: SkillHost, ownerId: PlayerId, pindianId: string): boolean
  /** Ask a participant-side optional skill after both Pindian cards are privately committed but before reveal. */
  offersPindianPreRevealAsk?(host: SkillHost, ownerId: PlayerId, pindianId: string): boolean
  /**
   * 拥有者**造成**伤害时对属性和数值的修正（神马超【驭雳】）。
   *
   * 排在藤甲、狂风、大雾之前，见 `damage-modifiers.ts`。返回改动后的值；
   * 不改就返回 null。**不要在这里直接改血或者另造一笔伤害**——
   * 那会变成两次「受到伤害」，藤甲、连环、濒死全部结算两遍。
   */
  outgoingDamage?(
    state: SanguoshaState,
    ownerId: PlayerId,
    context: { targetId: PlayerId; amount: number; nature: DamageNature; cardId: CardId | null; cardName: string | null; chainTransfer: boolean },
  ): { amount?: number; nature?: DamageNature } | null
  /**
   * 拥有者（第三方）给**某个具体来源这次造成的伤害**加成（成公英【匡襄】：
   * A 使用因匡襄获得的黑牌造成伤害+1，拥有者是成公英，`sourceId` 是 A，
   * 不是拥有者自己）。和 `outgoingDamage` 的区别只是查询对象换成了
   * 全场角色而不是伤害来源自己。
   */
  globalOutgoingDamage?(
    state: SanguoshaState,
    ownerId: PlayerId,
    sourceId: PlayerId,
    context: { targetId: PlayerId; amount: number; nature: DamageNature; cardId: CardId | null; cardName: string | null; chainTransfer: boolean },
  ): { amount?: number; nature?: DamageNature } | null
  /**
   * 拥有者**受到**伤害时对数值 / 属性的修正（潘濬【公清】按来源攻击范围
   * 改伤害值）。和 `outgoingDamage` 是同一形状，只是站在受伤者这一边，
   * 排在源头的 `outgoingDamage` 结算完之后。
   */
  incomingDamage?(
    state: SanguoshaState,
    ownerId: PlayerId,
    context: { sourceId: PlayerId | null; amount: number; nature: DamageNature; cardId: CardId | null; cardName: string | null; chainTransfer: boolean },
  ): { amount?: number; nature?: DamageNature } | null
  /** A bystander-owned effect may modify damage received by a specific other player. */
  globalIncomingDamage?(
    state: SanguoshaState,
    ownerId: PlayerId,
    targetId: PlayerId,
    context: { sourceId: PlayerId | null; amount: number; nature: DamageNature; cardId: CardId | null; cardName: string | null; chainTransfer: boolean },
  ): { amount?: number; nature?: DamageNature } | null
  /**
   * 锁定技：把拥有者**造成的伤害**整个换成等量的失去体力（张春华【绝情】）。
   *
   * 返回 true 表示这次伤害不再作为伤害发生——目标改为失去等量体力。
   * 因此「受到伤害后」「造成伤害后」那批时机一个都不跑，
   * 铁索不传导，藤甲、狂风、大雾也都无从谈起：最终不是伤害。
   *
   * **不要用「先造成伤害再回复」或者「防止伤害再另外扣血」来模拟**，
   * 那两种做法都会真的触发一次伤害时机。
   */
  replacesDamageWithHpLoss?(
    state: SanguoshaState,
    ownerId: PlayerId,
    context: { targetId: PlayerId; amount: number; nature: DamageNature; cardName: string | null },
  ): boolean
  /**
   * 拥有者**受到**伤害时把它整个挡下来（神马超【驭雳】防雷伤）。
   *
   * 返回 true 表示这次伤害不发生：不扣血，也不触发「受到伤害后」那批时机。
   * 允许在挡下的同时做事（摸牌），所以拿的是 host。
   */
  interceptIncomingDamage?(
    host: SkillHost,
    ownerId: PlayerId,
    context: { sourceId: PlayerId | null; amount: number; nature: DamageNature; cardId: CardId | null; cardName: string | null; chainTransfer: boolean },
  ): boolean
  /** 全局旁观者对指定角色所受伤害的交互式防止；适用于需同时征询其他角色的规则。 */
  interceptGlobalIncomingDamage?(
    host: SkillHost,
    ownerId: PlayerId,
    targetId: PlayerId,
    context: { sourceId: PlayerId | null; amount: number; nature: DamageNature; cardId: CardId | null; cardName: string | null; chainTransfer: boolean },
  ): boolean
  /** 多目标牌逐目标结算时，由非受伤者技能防止某一个目标的伤害。 */
  interceptCardDamageTarget?(
    host: SkillHost,
    ownerId: PlayerId,
    context: { targetId: PlayerId; sourceId: PlayerId | null; amount: number; nature: DamageNature; cardId: CardId | null; cardName: string | null; chainTransfer: boolean },
  ): boolean
  /**
   * 锁定「这名角色死亡时，我要认领他的牌」。
   *
   * 只是**声明意向**：声明之后引擎会把死者的牌暂存到处理区而不是弃牌堆，
   * 真正拿不拿由技能自己在 `Death` 之后发问决定。返回 true 的技能有义务
   * 把挂账收干净（拿走或 `releaseDeathCards`），否则处理区会留下无主的牌。
   */
  claimsDeathCards?(state: SanguoshaState, ownerId: PlayerId, deadId: PlayerId): boolean
  /** 牌结算后仍在处理区时，改写实体牌的最终去向。 */
  resolvedCardRecipient?(state: SanguoshaState, ownerId: PlayerId, context: ResolvedCardContext): boolean
  /**
   * 距离修正：正数表示「与其他角色距离 +n」，负数表示 -n。
   *
   * `toOthers` 只影响**拥有者到别人**的距离（马术、屯田），
   * `fromOthers` 只影响**别人到拥有者**的距离。两个方向分开，
   * 写错方向会让「更容易杀到远处」变成「更不容易被杀」。
   *
   * 值可以是常数，也可以是函数——邓艾【屯田】的修正量等于「田」的张数，
   * 每次都要现算，不能在注册时定死。
   */
  distanceModifier?: {
    toOthers?: number | ((state: SanguoshaState, ownerId: PlayerId) => number)
    fromOthers?: number | ((state: SanguoshaState, ownerId: PlayerId) => number)
  }
  /** A field-wide faction or aura rule can adjust distance for one acting role. */
  globalDistanceModifier?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId, targetId: PlayerId): number
  /** 针对这张实体牌覆盖锦囊距离上限；null 表示不覆盖。 */
  trickDistanceLimit?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, cardName: string): number | null
  /**
   * 拥有者对**某一个特定目标**的距离修正（田豫【追讨】：只对被选中的那个人
   * -1，不是对所有人都 -1）。和 `distanceModifier.toOthers` 是两回事——
   * 那个对所有人生效，这个只对 `targetId` 生效，技能自己按
   * source-target 维护持久状态（不建立在 `distanceModifier` 里，避免
   * 「对所有人」和「对某一个人」两种语义混进同一个字段）。
   */
  directedDistanceTo?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): number
  /** 对某一名攻击者的攻击范围作定向修正；不改变普通距离。 */
  directedAttackRangeModifier?(state: SanguoshaState, ownerId: PlayerId, attackerId: PlayerId, targetId: PlayerId): number
  /**
   * 固定手牌上限。返回 null 表示沿用通常的“当前体力值”。
   *
   * 这是“固定为 N”而不是普通加减修正，所以 1 体力时返回 2 仍然是 2。
   * 临时效果必须把有效期写进可序列化状态，不能依赖计时器或闭包。
   */
  fixedMaxCards?(state: SanguoshaState, ownerId: PlayerId): number | null
  /** 锁定技改写全部最终判定花色（族荀粲【分钗】）。 */
  overrideJudgmentSuit?(state: SanguoshaState, ownerId: PlayerId, judgedPlayerId: PlayerId, suit: Suit): Suit | null
  /** 将一个既有阶段位替换成另一种真实阶段；位置不变，内容完整执行。 */
  replacesPhase?(state: SanguoshaState, ownerId: PlayerId, slot: TurnPhase): TurnPhase | null
  /**
   * 手牌上限**加成**。返回 0 表示不加。
   *
   * 和 `fixedMaxCards` 是两件事：那个是「固定为 N」，这个是在基数上叠加，
   * 多个来源相加，不会互相覆盖（袁绍【血裔】走这一条）。
   */
  maxCardsBonus?(state: SanguoshaState, ownerId: PlayerId): number
  /** 给指定目标的手牌上限加减值（妄尊等跨角色效果）。 */
  globalMaxCardsBonus?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): number
  /**
   * 拥有者即将回复的体力值加成（曹嵩【翊正】：目标下一次回复+1）。
   *
   * 在 `recover()` 夹住上限之前叠加到 amount 上，多个来源相加。
   * 返回 0 表示不加。
   */
  recoverAmountBonus?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId | null, sourceCardId?: CardId): number
  /** 拥有者使用的某张基本牌，其伤害值/回复值等牌面数值加成。 */
  basicCardUseValueBonus?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, cardName: string): number
  /**
   * 弃牌阶段手牌数是否计入「张数」：返回 true 表示这张牌**不计入**手牌上限判定
   * （诸葛果【羽化】的锦囊/装备牌、李严【腹鳞】本回合获得的牌）。
   * 只影响弃牌数量的计算，不影响这张牌能否被选中弃置。
   */
  handLimitExempt?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): boolean
  /** 其他玩家可被拥有者技能指定为手牌上限豁免对象（王桃【护关】）。 */
  globalHandLimitExempt?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardId: CardId): boolean
  /**
   * 锁定技：拥有者的摸牌一律改为从牌堆底摸（许攸/彭羕【寸目】）。
   * 只改摸牌的来源位置，不改摸牌数量、不改摸牌事件本身。
   */
  drawsFromBottom?(state: SanguoshaState, ownerId: PlayerId): boolean
  /**
   * 锁定技：拥有者的连环状态不能被解除（神刘备【结营】）。
   * 属性伤害传导时的统一解除不受此限制，那是规则本身。
   */
  preventsUnchain?: boolean
  /**
   * 锁定技：拥有者不能进入横置（连环）状态（陆抗【谦节】）。
   * 直接挡在 `setChained` 变为 true 之前，不是「横置后再解除」。
   */
  preventsChaining?: boolean
  /**
   * 锁定技：拥有者不能成为其他角色发起的拼点的目标（陆抗【谦节】）。
   * 自己发起拼点不受影响，挡在 `startPindian` 里。
   */
  prohibitsBeingPindianTarget?: boolean
  /**
   * 这个技能能不能被临时夺走（神张辽【夺锐】）。
   *
   * **默认可以**。限定技、觉醒技、主公技由 `limited` / `awakening` / `lord`
   * 自动排除，不需要在这里重复声明；只有「理论上是普通技能但夺过去会形成规则冲突」
   * 才显式写 false，并在 docs/duorui-compatibility.md 里说明原因。
   */
  stealable?: boolean
  /**
   * 拥有者给**任意角色**提供的手牌上限修正（神刘备【结营】给全场连环角色 +2）。
   *
   * 和 `maxCardsBonus` 的区别：那个只影响拥有者自己，
   * 这个是「因为场上有他，别人也受影响」。
   */
  globalMaxCardsBonus?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): number
  /**
   * 拥有者给**任意角色**提供的出杀次数加成（神甘宁的「营」+1）。
   *
   * 是「限制次数 +1」，不是无限杀；和天义、诸葛连弩按 `canUseSlash` 的统一规则聚合。
   */
  globalSlashUses?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): number
  /**
   * 濒死求救时，这个技能给拥有者提供的额外选项（曹植【酒诗】视为使用一张【酒】）。
   *
   * 返回的动作 id 会直接进 `RescueRequest.actionIds`，玩家才点得到——
   * 服务端支持不等于前端能用。**不要在这里改动牌局**，只报告现在能不能用。
   */
  rescueActions?(state: SanguoshaState, ownerId: PlayerId, dyingPlayerId: PlayerId): Array<{ id: string; label: string }>
  /**
   * 玩家选了上面那条动作。返回 true 表示这一步已经由技能处理完毕。
   *
   * 处理完之后引擎会照常继续濒死流程，技能自己不要去碰内部入口。
   */
  invokeRescueAction?(host: SkillHost, ownerId: PlayerId, actionId: string, dyingPlayerId: PlayerId): boolean | 'deferred'
  /**
   * 濒死介入：拥有者刚进入濒死时先给技能一次机会（不屈）。
   *
   * 返回 true 表示「这次濒死已经由技能处理掉了」，引擎会直接结束濒死状态，
   * **不再求桃**。返回 false 走正常的求桃流程。
   *
   * 只在拥有者自己濒死时调用，而且在 `EnterDying` 之后、第一次求桃之前。
   */
  dyingIntercept?(host: SkillHost, ownerId: PlayerId): boolean | 'pending'
  /** 其他角色进入濒死、开始常规求桃前的旁观介入。返回 pending 挂起选择。 */
  dyingAssist?(host: SkillHost, ownerId: PlayerId, dyingPlayerId: PlayerId, sourceId: PlayerId | null): boolean | 'pending'
  /**
   * 拥有者对**这个目标**使用【杀】时不受次数限制（高顺【陷阵】胜利后）。
   *
   * 和「本回合无限杀」不是一回事：这是**定向**的，
   * 对别人出杀仍然要按普通次数算。多目标的一张【杀】只有在
   * **每个目标**都被豁免时才算突破次数限制，否则捎带一个普通目标
   * 就成了无限杀的后门。
   */
  ignoresSlashUsesTo?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, targetIds?: readonly PlayerId[]): boolean
  /**
   * 拥有者手上的某张牌**只能**按另一张牌用（高顺【禁酒】：酒均视为杀）。
   *
   * 和 `viewAs` 是两回事：`viewAs` 是「多给一个用途」，原用途还在；
   * 这条是**改写身份并禁止原用途**——高顺的【酒】不能再当酒喝，
   * 濒死时也不能靠它自救。
   *
   * 返回改写成的牌名（以及属性）；不改写就返回 null。
   * 结果由 `forcedIdentityFor` 统一提供给动作生成和各条响应路径。
   */
  forcedCardIdentity?(
    state: SanguoshaState,
    ownerId: PlayerId,
    cardId: CardId,
  ): { asCardName: string; nature?: DamageNature } | null
  /** 无真实防具时提供的虚拟防具牌名（八阵）。 */
  virtualArmor?(state: SanguoshaState, ownerId: PlayerId): string | null
  /** 武器栏均为空时由技能提供的虚拟武器。 */
  virtualWeapon?(state: SanguoshaState, ownerId: PlayerId): string | null
  /**
   * 锁定技：允许拥有者在体力值 0 或更低时**不处于濒死状态地活着**（不屈）。
   *
   * 这是给不变量看的：正常规则下「存活 + 非正体力 + 不在濒死」是坏状态，
   * 只有这个能力明确说了「我现在撑得住」才放行。
   */
  survivesAtZeroHp?(state: SanguoshaState, ownerId: PlayerId): boolean
  /**
   * 改判：判定牌翻开之后、生效之前，用一张牌代替它（鬼才、鬼道）。
   *
   * 返回现在能拿来改判的牌，空数组表示这次插不上手。
   * 判定引擎按座位顺序逐个问，改判成功后会再从头问一遍——
   * 所以这里只报「有哪些牌可用」，**不要自己判断该不该改**。
   */
  retrial?(state: SanguoshaState, ownerId: PlayerId, judgingPlayerId: PlayerId): CardId[]
  /** 允许被判定角色额外选择并使用牌堆顶牌；替换前仍留在牌堆。 */
  retrialDrawPileTop?(state: SanguoshaState, ownerId: PlayerId, judgingPlayerId: PlayerId): boolean
  /**
   * 改判该问谁：默认问拥有者自己（他自己决定用不用、用哪张）。
   *
   * 诸葛瑾【缓释】反过来——牌是诸葛瑾的，但**挑哪张牌由被判定角色决定**。
   * 返回一个不同的 `PlayerId` 就把这一轮的询问对象换成他，候选牌仍然来自
   * `retrial` 报的那份（拥有者的手牌），不要在这里改变牌的归属。
   * 返回 null/undefined 就是默认行为。
   */
  retrialDecidedBy?(state: SanguoshaState, ownerId: PlayerId, judgingPlayerId: PlayerId): PlayerId | null
  /**
   * 强制判定牌（张宝【咒缚】）：这名角色本次判定**直接使用**这张实体牌，
   * 不翻牌堆顶。技能自己负责把这张牌移进处理区并返回它的 Card ID；
   * 返回 null 表示这条不生效，走正常翻牌。判定引擎按玩家顺序问一圈，
   * 第一个给出非 null 结果的就采用——目前只有单一来源的场景会用到它。
   */
  forcedJudgmentCard?(host: SkillHost, ownerId: PlayerId, judgingPlayerId: PlayerId): CardId | null
  /** 锁定技对拥有者牌张花色的修正；判定牌按判定角色处理。 */
  cardSuit?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, printedSuit: Suit): Suit
  /** 判定牌翻开、改判结束后，判定结果公开前的可挂起修正窗口。返回 true 表示等待技能回应。 */
  beforeJudgmentResult?(host: SkillHost, ownerId: PlayerId, cardId: CardId, suit: Suit): boolean
  /**
   * 锁定技对判定牌点数的修正（张琪瑛【真仪·紫微】把判定结果强制改成 5）。
   * 只在判定改判窗口关闭、真正计算最终结果时生效，不改变这张牌本身的点数。
   * 返回 null/undefined 表示不覆盖。
   */
  judgmentRankOverride?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): number | null
  /**
   * 禁止拥有者成为指定牌的目标；谦逊、空城、贾诩【帷幕】统一走这个入口。
   *
   * `cardId` 是这次要用的**实体牌**，转化技也给（奇袭把黑牌当过河拆桥，
   * 实体牌仍然是那张黑牌）。帷幕要判「黑色锦囊」，颜色只能从实体牌上取，
   * 而且必须走 `effectiveCardColor` 这个统一口径，不能读印刷颜色。
   * 有些调用点（技能生成的虚拟【杀】）没有实体牌，这时是 undefined。
   */
  prohibitsTarget?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId, cardName: string, cardId?: CardId): boolean
  /**
   * 拥有者装备区的这张牌不能被过河拆桥/顺手牵羊的「弃置」分支选中（滕胤
   * 【皙秀】：不能弃置装备区最后一张牌）。只挡弃置，拿走（顺手牵羊）不挡，
   * 由调用方按 `mode` 区分是否查询这个钩子。
   */
  protectsCardFromDiscard?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, sourceId?: PlayerId): boolean
  /**
   * 禁止**别人**在当前情境下使用某张牌（贾诩【完杀】）。
   *
   * 和 `prohibitsTarget` 的方向相反：这里的拥有者是施加限制的那个人，
   * `userId` 是想用牌的人。濒死救援是目前唯一的调用点，所以上下文里带着
   * 当前濒死角色——嵌套濒死时读的必须是**当前**那一个，不能锁死在最初那个。
   */
  prohibitsCardUse?(
    state: SanguoshaState,
    ownerId: PlayerId,
    context: { userId: PlayerId; cardName: string; dyingPlayerId: PlayerId | null; cardIds?: readonly CardId[] },
  ): boolean
  /**
   * 禁止**拥有者自己**打出某个牌名的牌（曹彰【将驰】的多摸分支）。
   *
   * 和 `prohibitsCardUse` 是两件事：那条管的是「使用」，这条管的是「打出」。
   * 技能文本说「不能使用或打出」时两条都要声明——只堵一条的话，
   * 他照样能打出【杀】响应南蛮和决斗。
   *
   * 判断的是**有效牌名**：转化出来的【杀】（武圣、龙胆、禁酒的酒）同样被堵住。
   */
  prohibitsOwnResponse?(state: SanguoshaState, ownerId: PlayerId, cardName: string): boolean
  /** 改写拥有者使用/打出【杀】的有效属性（谋·黄忠未装备武器时只能按普通【杀】结算）。 */
  slashNatureOverride?(state: SanguoshaState, ownerId: PlayerId, nature: DamageNature): DamageNature | null
  /** 全局禁止某名角色在响应入口打出指定牌名。 */
  prohibitsCardResponse?(state: SanguoshaState, ownerId: PlayerId, responderId: PlayerId, cardName: string): boolean
  /** 按响应实体牌继续过滤响应（例如牌色），需同时确认正在响应的牌结算上下文。 */
  prohibitsResponseCard?(state: SanguoshaState, ownerId: PlayerId, responderId: PlayerId, responseCardId: CardId, cardName: string): boolean
  /** 禁止不消耗响应实体牌的技能/装备响应，供“只能使用或打出指定实体牌”类规则复用。 */
  prohibitsCardlessResponse?(state: SanguoshaState, ownerId: PlayerId, responderId: PlayerId, cardName: string): boolean
  /** The current use cannot be answered by one of its targets (while preserving other response windows). */
  cardUnresponsiveToTarget?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId, cardId: CardId, targetId: PlayerId, cardName: string): boolean
  /** 拥有者作为用牌者时，临时禁止其把某名角色设为指定目标。 */
  prohibitsSourceTarget?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardName: string, sourceSkillId?: string): boolean
  /** 在“成为目标时”窗口插入发问；对【杀】而言早于“指定目标后”，返回 true 表示结算已挂起。 */
  interceptTarget?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
  /**
   * **使用者**在“指定目标后”窗口的插入点（神马超【霆威】、马超【铁骑】）。
   *
   * 和 `interceptTarget` 属于不同窗口：目标方的“成为目标时”效果（如大乔【流离】）
   * 先处理；之后才轮到这里。相同窗口内先处理使用者的武将技能，再处理装备效果。
   *
   * 返回 true 表示已经发问、结算挂起；答完之后**必须**调 `resumeCardTarget()`
   * 把控制权交回去，否则牌局停在这里。
   */
  interceptSourceTarget?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
  /** 使用者在“指定目标后”对每个目标分别调用的插入点。 */
  interceptSourceTargetEach?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
  /**
   * 旁观者插入点：既不是使用者也不是目标，只要求某个前置
   * 条件（秦宓【谏征】要求「在使用者攻击范围内」、谋甘宁【奋威】要求
   * 「本角色有威牌且成为锦囊目标」，由技能自己判断）。【杀】和普通锦囊
   * 的目标结算都会遍历此入口。
   * 返回 true 表示已经发问、结算挂起；答完之后同样要调 `resumeCardTarget()`。
   */
  interceptBystanderTarget?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
  /** 满足条件的旁观技能可以将拥有者追加为这张正在使用之牌的额外目标。 */
  additionalTargetsOnUse?(
    state: SanguoshaState,
    ownerId: PlayerId,
    sourceId: PlayerId,
    cardId: CardId,
    cardName: string,
    currentTargetIds: readonly PlayerId[],
  ): PlayerId[]
  /** Forced targets attached to a skill-authorized use, such as adjacent targets. */
  forcedAdditionalTargetsOnUse?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId, cardId: CardId,
    cardName: string, currentTargetIds: readonly PlayerId[], skillIdsOf: (characterId: string) => string[]): PlayerId[]
  /** 持有者可对当前出牌者施加跨目标选择的限制（乱群标记）。 */
  globalProhibitsSourceTarget?(
    state: SanguoshaState,
    ownerId: PlayerId,
    sourceId: PlayerId,
    targetId: PlayerId,
    cardName: string,
    sourceSkillId?: string,
  ): boolean
  /**
   * 锁定技式的「取消自己这个目标」（神荀彧【定汉】）。
   *
   * 和 `interceptTarget` 的区别是**不发问、当场给结论**，所以它能用在
   * 延时锦囊上——那条路径是一路同步走完的，根本没有挂起点。
   * 返回 true 表示这个目标被取消。
   *
   * 只在**锦囊牌**指定目标时被问到（即时锦囊逐个目标结算时、延时锦囊放置时），
   * 【杀】不走这里。实现里仍然要自己确认 `context.category`，
   * 因为转化技能可以把任何牌当锦囊用。
   *
   * 拿到的是 host 而不是 state：取消这件事要能报横幅、留记录。
   * 同一个目标只会被问一次，可以在里面放一次性资源的消耗。
   */
  cancelsBecomingTarget?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
  /** 拥有者使用【杀】时，目标需要连续打出多少张【闪】。 */
  slashDodgeResponses?: number
  /**
   * 条件式的「需要几张【闪】」（董卓【肉林】）。
   *
   * 攻守双方的技能都会被问到，所以 `ownerId` 可能是 `sourceId` 也可能是 `targetId`，
   * 技能自己判断这次是不是自己该管的方向。返回 1 表示不加成。
   * 多个来源取 max，不相加。
   */
  dodgeResponsesFor?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId, targetId: PlayerId): number
  /**
   * 锁定技：拥有者对某个目标使用的【杀】不可被【闪】响应。
   *
   * 每个目标单独判定——多目标【杀】里可能只有一部分满足条件。
   * 不发问、不产生请求，所以放在这里而不是「成为目标时」的插入点链上。
   */
  slashUndodgeable?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardId?: CardId): boolean
  /**
   * 无实体牌的"视为打出一张闪"（鲁芝【卫境】）。只读判定，供求闪的合法
   * 动作列表拼接一条 `virtual-dodge:<skillId>` 使用；真正命中后引擎调
   * `consumeVirtualDodge` 让技能自己记账（多次判定之间不能有副作用）。
   */
  virtualDodge?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId | null): boolean
  /** 与 `virtualDodge` 配对：确认真正使用后由技能自己更新用量记录。 */
  consumeVirtualDodge?(host: SkillHost, ownerId: PlayerId): void
  /** 无实体牌地响应所需基本牌；声明和扣费分离，确认响应后才扣费。 */
  virtualBasicResponse?(state: SanguoshaState, ownerId: PlayerId, requiredCardName: string): boolean
  consumeVirtualBasicResponse?(host: SkillHost, ownerId: PlayerId, requiredCardName: string): void
  /** 允许需要选择实体支付牌的技能接管虚拟基本牌响应。 */
  beginVirtualBasicResponse?(host: SkillHost, ownerId: PlayerId, requiredCardName: string, request?: GameRequest): boolean
  /**
   * 锁定技：拥有者对某个目标使用的**锦囊**，那个目标完全不能响应
   * （神孙策【覆海】）。
   *
   * 和 `slashUndodgeable` 是同一件事的锦囊版，问的同样是**使用者**的技能。
   * 只封住这一个目标本人：别人替他出【无懈可击】不受影响，
   * 那是另一条规则，不从这里走。
   */
  trickUnresponsive?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardName: string, cardId?: CardId): boolean
  /** Locking rule that prevents a particular responder from responding to any card used by this owner. */
  blocksResponseToCard?(state: SanguoshaState, ownerId: PlayerId, responderId: PlayerId, cardName: string, cardId?: CardId): boolean
  /**
   * 拥有者对某个特定角色**使用牌时不受距离限制**（神孙策【英霸】）。
   *
   * 和 `distanceModifier` 的区别：那个是把距离算小一点，这个是整条距离限制
   * 直接不成立。文本说的是「使用牌」，所以【杀】的攻击范围、
   * 【顺手牵羊】【兵粮寸断】的距离 1 都一并覆盖，不是只管杀。
   */
  ignoresDistanceTo?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardId?: CardId): boolean
  /** 该角色对这个目标使用牌时，目标的防具技能无效；不移动装备牌。 */
  ignoresArmorFor?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean
  /** A target may disable its own armor against a specific incoming card. */
  armorIneffectiveWhenTargeted?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId | null, cardName: string, color: 'red' | 'black' | null): boolean
  /** Per-card, per-target effect immunity whose identity depends on a skill-selected physical card. */
  cardIneffectiveForTarget?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId | null, cardName: string, cardId?: CardId): boolean
  /**
   * 拥有者的技能让**任意第三方**对某个目标无视距离（孙休【诏缚】：与孙休
   * 距离为 1 的角色视为处于所有其他吴势力角色的攻击范围内）。
   *
   * 和 `ignoresDistanceTo` 的区别：那个只问「拥有者自己打这个目标」，
   * 这个要覆盖「别人打这个目标」，`attackerId` 因此和 `ownerId` 是两个人。
   * 动态计算，不建立常驻覆盖记录——诏缚这类效果会随距离实时变化。
   */
  globalIgnoresDistanceTo?(state: SanguoshaState, ownerId: PlayerId, attackerId: PlayerId, targetId: PlayerId, cardId?: CardId): boolean
  /** A skill owner may waive distance for a particular card used by another player. */
  globalIgnoresDistanceToCard?(state: SanguoshaState, ownerId: PlayerId, actorId: PlayerId, targetId: PlayerId, cardId: CardId): boolean
  /** 第三方授予的实体牌在其持有者手中可无限使用【杀】。 */
  globalUnlimitedSlashWithCard?(state: SanguoshaState, ownerId: PlayerId, attackerId: PlayerId, cardId: CardId): boolean
  /** 第三方技能仅让指定角色使用【杀】时无视距离，不影响其其他牌。 */
  globalSlashIgnoresDistanceTo?(state: SanguoshaState, ownerId: PlayerId, attackerId: PlayerId, targetId: PlayerId): boolean
  /** 对方在与拥有者【决斗】时，每轮需要连续打出多少张【杀】。 */
  duelSlashResponses?: number
  /**
   * 主动技：出牌阶段能发动的技能，直接产出 LegalAction。
   * 和转化技一样，不能让前端自己猜「现在能不能发动」。
   */
  activeActions?(state: SanguoshaState, ownerId: PlayerId): Array<{ id: string; label: string }>
  /** 该主动入口最终会使用一张牌；被【限行】等规则封牌后不再展示。 */
  activeActionUsesCard?: boolean
  /**
   * 主公技授权：**拥有者的技能**给**别人**的出牌阶段加一条动作（黄天）。
   *
   * `ownerId` 是技能拥有者（主公），`actorId` 是正在出牌的那个人。
   * 技能自己负责确认「我确实是主公」——主公技只在坐主公位时生效，
   * 这是规则，不是引擎该猜的事。
   */
  grantsPlayActions?(state: SanguoshaState, ownerId: PlayerId, actorId: PlayerId): Array<{ id: string; label: string }>
  /** 被授权动作的执行。`actorId` 是点这条动作的人，不是技能拥有者。 */
  invokeGrantedAction?(host: SkillHost, ownerId: PlayerId, actorId: PlayerId, actionId: string): void
  /** 主动技的执行。id 是 activeActions 给出的那一个。 */
  invokeActive?(host: SkillHost, ownerId: PlayerId, actionId: string): void
  /**
   * 技能发问之后的续接。
   *
   * `resolution` 就是发问时写下的那份状态，`response` 已经通过引擎的合法性校验。
   * 想继续问下一步就再调用一次 `host.askSkill`。
   */
  resume?(host: SkillHost, ownerId: PlayerId, resolution: SkillResolutionState, response: GameResponse): void
  /**
   * 排队的发问轮到了。
   *
   * 队列里的事实是触发当时抓下来的，牌局已经往前走了一段，
   * 所以这里必须重新确认前提还成立（人还活着、牌还在原处），不成立就安静地放弃。
   */
  /**
   * 防止一次伤害。`side` 说明现在问的是**这次伤害的哪一侧**：
   * `source` 是「我造成的伤害」，`target` 是「我受到的伤害」。
   *
   * 防止 ≠ 改成 0 点：防止意味着这次伤害**没有发生**，
   * 「受到伤害后」那批时机、连环传导、濒死一个都不该跑。
   */
  preventsDamage?(
    state: SanguoshaState,
    ownerId: PlayerId,
    side: 'source' | 'target',
    context: DamagePreventionContext,
  ): boolean
  /** After all source/target damage modifiers, prevent final damage based on its settled amount. */
  preventsFinalDamage?(state: SanguoshaState, ownerId: PlayerId, context: DamagePreventionContext): boolean
  /**
   * 可选（交互式）的伤害防止发问（马谡【制蛮】"你可以防止此伤害"）。
   *
   * 和 `preventsDamage` 的区别：那个是无条件、同步给结论；这个要弹一次
   * "是否防止"的问询，返回 true 表示已经调用 `host.askSkill` 挂起——
   * `resolveDamage` 会记下这次伤害的完整现场并立即返回（此时还没有任何
   * 状态被改动，挂起是安全的），技能的 `resume` 用
   * `resumeSourceDamagePrevention` 续接。目前只支持来源侧（source）。
   */
  offersSourceDamagePreventionAsk?(host: SkillHost, ownerId: PlayerId, context: DamagePreventionContext): boolean
  /**
   * 目标侧版本（杜畿【安东】"来源可以选择防止此伤害"）：技能挂在**目标**身上，
   * 但由**来源**来做选择。返回 true 表示已经挂起，`resolveDamage` 会记下
   * 这次伤害的完整现场（`pendingTargetDamage`），技能的 `resume` 用
   * `resumeTargetDamagePrevention` 续接。构造 Request 时把 `playerId` 设成
   * 来源（`context.sourceId`），`ownerId` 仍是目标——两者不必相同，
   * 张济【掠命】的询问已经是这个先例。
   */
  offersTargetDamagePreventionAsk?(host: SkillHost, ownerId: PlayerId, context: DamagePreventionContext): boolean
  /** 可在任意角色将因伤害进入濒死时介入的全局目标侧防止技能。 */
  offersGlobalDamagePreventionAsk?(host: SkillHost, ownerId: PlayerId, context: DamagePreventionContext): boolean
  /** 伤害结算前，可挂起询问并在同一笔伤害上调整数值。 */
  offersDamageModifierAsk?(host: SkillHost, ownerId: PlayerId, side: 'source' | 'target', context: DamagePreventionContext): boolean
  /** 伤害目标侧的全局修正询问；仅用于拥有者以外角色受到特定伤害时介入。 */
  offersGlobalDamageModifierAsk?(host: SkillHost, ownerId: PlayerId, side: 'source' | 'target', context: DamagePreventionContext): boolean
  startQueued?(host: SkillHost, ownerId: PlayerId, prompt: QueuedSkillPrompt): void
  /**
   * 这个技能的发问可以问一名**已阵亡**的角色。
   *
   * 默认不行：请求发给一个出局的人通常意味着某条路径没清理干净，
   * 不变量会当场把它拦下来。
   *
   * 例外是「当你死亡时」这一类技能（步练师【追忆】）——**它本来就是
   * 死后才跑的**，那一次决定合法地属于已经出局的那个人。
   * 声明写在技能上而不是放宽不变量：放宽了就再也拦不住真正的漏网请求。
   *
   * 联机侧照常把请求下发给那名玩家；超时兜底也照常，所以不会卡住牌局。
   */
  allowsDeadResponder?: boolean
  /**
   * 主公技代打：拥有者作为主公需要打出某张牌时，哪些角色可以替他打。
   *
   * 返回的顺序就是询问顺序。技能自己负责确认「我确实是主公」——
   * 主公技只在坐主公位时生效，这是规则，不是引擎该猜的事。
   */
  surrogateResponders?(state: SanguoshaState, ownerId: PlayerId, requiredCardName: string): PlayerId[]
  /**
   * 主公技救援：别人用【桃】救拥有者时，额外多回复几点。
   * 返回 0 表示这次不生效。
   */
  rescueRecoverBonus?(state: SanguoshaState, ownerId: PlayerId, responderId: PlayerId): number
  /**
   * 转化技：把手牌当成别的牌用。
   * 返回这名玩家当前能做的所有转化，引擎据此生成 LegalAction。
   */
  viewAs?(state: SanguoshaState, ownerId: PlayerId): ViewAsOption[]
  /** A skill owner may grant a temporary card conversion to another responder. */
  globalResponseViewAs?(state: SanguoshaState, ownerId: PlayerId, responderId: PlayerId, requiredCardName: string): ViewAsOption[]
  /** A globally granted response conversion can carry response-only properties when that exact conversion is used. */
  globalUnanswerableResponses?: string[]
  /** Global conversion that creates ordinary legal use actions for another player. */
  globalViewAs?(state: SanguoshaState, ownerId: PlayerId, actorId: PlayerId): ViewAsOption[]
  /** 允许另一名角色在限定期间将拥有者的指定手牌当作自己的牌使用/打出。 */
  sharedHandCards?(state: SanguoshaState, ownerId: PlayerId, userId: PlayerId): CardId[]
  /**
   * 「恰好 N 张同花色的牌当作某张牌」的转化能力（神赵云【龙魂】）。
   *
   * 和单牌 `viewAs` 分开：那个一次只报一张牌，凑不出「恰好 N 张同花色」这个约束，
   * 而且把所有组合枚举成选项在手机上没法用。具体流程见 engine/multi-card-viewas.ts。
   */
  multiCardViewAs?(state: SanguoshaState, ownerId: PlayerId): MultiCardViewAsSpec | null
}

const registry = new Map<string, SkillRuntime>()
const SPECIAL_EQUIPMENT_SKILLS: Record<string, string> = {
  qiongshu: 'qiongshu', xishu: 'xishu', jinshu: 'jinshu', 'taiping-yaoshu': 'taiping-yaoshu', 'huntianyi-b69': 'gailan-luji-b69',
}
let providedSkillIdsOf: (characterId: string) => string[] = () => []
let providedClanOf: (characterId: string) => string | undefined = () => undefined

export function provideCharacterClanLookup(lookup: (characterId: string) => string | undefined): void {
  providedClanOf = lookup
}

export function clanOfCharacter(characterId: string): string | undefined {
  return providedClanOf(characterId)
}
/**
 * 一张武将牌作为装备被借用时，能提供哪些技能（神典韦【挈挟】）。
 *
 * 和 `provideSkillIdsLookup` 同一套注入做法，理由也一样：这个模块被武将数据
 * 依赖，不能反过来 import 它。默认空数组——没注册就等于借不到任何技能，
 * 漏注册只会让人少一个技能，不会凭空多一个。
 */
let providedBorrowableSkillIdsOf: (characterId: string) => string[] = () => []

export function provideBorrowableSkillLookup(lookup: (characterId: string) => string[]): void {
  providedBorrowableSkillIdsOf = lookup
}

/**
 * 这名角色**从装备上借来**的技能。
 *
 * 来源是装备实例，不是他的武将牌：所以【断肠】把武将技能全废掉时这些仍然有效，
 * 【夺锐】也偷不走它们（那个只看目标武将牌自己的技能表）。
 * 装备一离开装备区，这里立刻就查不到了——不需要另写一条「失效」逻辑。
 */
export function equipmentSkillIdsOf(state: SanguoshaState, playerId: PlayerId): string[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return []
  if (equipmentEffectsSuppressed(state, playerId)) return []
  const ids: string[] = []
  for (const cardId of Object.values(player.zones.equipment)) {
    if (!cardId) continue
    // 特殊装备不是武将牌，也没有可借用的 characterId；它们的技能归属
    // 直接由牌实例声明，离开装备区后自然随本枚举结果失效。
    const specialEquipment = state.cards[cardId]?.specialEquipment
    if (specialEquipment && SPECIAL_EQUIPMENT_SKILLS[specialEquipment]) {
      ids.push(SPECIAL_EQUIPMENT_SKILLS[specialEquipment])
      continue
    }
    const characterId = state.cards[cardId]?.characterId
    if (!characterId) continue
    ids.push(...providedBorrowableSkillIdsOf(characterId))
  }
  return [...new Set(ids)]
}

/** 由角色总表在模块初始化完成后回注，避免各扩展包反向 import 总表形成环。 */
export function provideSkillIdsLookup(lookup: (characterId: string) => string[]): void {
  providedSkillIdsOf = lookup
}

/**
 * 按角色 id 查它的完整技能表——跨角色查另一个人的技能构成时用它，
 * 不要反过来 import `data/characters/standard`（那边引擎文件本身就被它依赖，
 * 会成环）。袁术【伪帝】动态借主公技靠它找到「当前主公的武将有哪些技能」。
 */
export function characterSkillIdsOf(characterId: string): string[] {
  return providedSkillIdsOf(characterId)
}

export function registerSkillRuntime(runtime: SkillRuntime): void {
  if (registry.has(runtime.id)) throw new Error(`技能重复注册：${runtime.id}`)
  registry.set(runtime.id, runtime)
}

export function getSkillRuntime(skillId: string): SkillRuntime | undefined {
  return registry.get(skillId)
}

/** 枚举当前已注册的全部技能运行时（钟琰【博览】按 metadata 动态过滤要用）。 */
export function allSkillRuntimes(): SkillRuntime[] {
  return [...registry.values()]
}

/** 仅供测试使用：清空注册表。 */
export function resetSkillRegistry(): void {
  registry.clear()
}

/**
 * 某名玩家现在拥有哪些技能 id：**武将自带 + 运行中获得的**。
 *
 * 觉醒后拿到的技能（邓艾的【急袭】、姜维的【观星】、刘禅的【激将】）走
 * `player.grantedSkills`，绝不能去改 `CharacterDefinition`——那是模块级共享常量，
 * 改一次全进程的同名武将都会跟着变。
 */
export function ownedSkillIds(
  state: SanguoshaState,
  playerId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): string[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return []
  /*
   * 装备技能的来源是**装备**，不是武将牌。
   *
   * 所以【断肠】把武将技能全部废掉之后，装备上借来的技能仍然照常工作——
   * 断肠说的是「武将牌上的技能」，管不到装备。
   */
  const borrowed = equipmentSkillIdsOf(state, playerId)
  if (player.characterSkillsDisabled) {
    const availableBorrowed = borrowed.filter((skillId) => !isSkillSuppressed(state, playerId, skillId))
    return suppressesMilitaryOrderSkills(state, playerId) ? retainOnlyLockedSkills(availableBorrowed, state, playerId) : availableBorrowed
  }
  const own = revealedGeneralCharacterIdsOf(player).flatMap((characterId) => skillIdsOf(characterId))
  const granted = player.grantedSkills ?? []
  const temporary = (player.temporaryGrantedSkills ?? []).map((entry) => entry.skillId)
  /*
   * 被单独压制的技能在这里就摘掉（神张辽【夺锐】）。
   *
   * 出口只有这一个，所以主动技按钮、触发时机、转化、响应、被动修正、
   * AI 全都自然失效——不需要在每条路径上各写一遍判断。
   * 和断肠的「全部技能失效」是两条独立规则，各管各的。
   */
  const available = [...new Set([...own, ...granted, ...temporary, ...borrowed])]
    .filter((skillId) => !(player.permanentlyLostSkills ?? []).includes(skillId))
    .filter((skillId) => !isSkillSuppressed(state, playerId, skillId))
  const invalidators = available.filter(skillId => registry.get(skillId)?.invalidatesOtherSkills?.(state, playerId))
  const validSkills = (invalidators.length ? available.filter(skillId => invalidators.includes(skillId)) : available)
    .filter((skillId) => isLockedSkill(skillId, state, playerId) || ![...registry.values()].some((runtime) => runtime.globallyInvalidatesSkill?.(state, playerId, skillId)))
  return suppressesMilitaryOrderSkills(state, playerId) ? retainOnlyLockedSkills(validSkills, state, playerId) : validSkills
}

export function sharedHandCardSourcesOf(state: SanguoshaState, userId: PlayerId): Array<{ ownerId: PlayerId; cardIds: CardId[] }> {
  const sources: Array<{ ownerId: PlayerId; cardIds: CardId[] }> = []
  for (const owner of state.players) {
    if (!owner.alive || owner.id === userId) continue
    const cardIds = skillsOf(state, owner.id, providedSkillIdsOf).flatMap((runtime) => runtime.sharedHandCards?.(state, owner.id, userId) ?? [])
      .filter((cardId) => owner.zones.hand.includes(cardId))
    if (cardIds.length) sources.push({ ownerId: owner.id, cardIds: [...new Set(cardIds)] })
  }
  return sources
}

export function sharedHandCardOwnerOf(state: SanguoshaState, userId: PlayerId, cardId: CardId): PlayerId | null {
  const override = state.skillCardOwnerOverride
  if (override?.playerId === userId && (override.cardId === cardId || override.cardIds?.includes(cardId))) return override.physicalOwnerId
  return sharedHandCardSourcesOf(state, userId).find((source) => source.cardIds.includes(cardId))?.ownerId ?? null
}

/**
 * 授予一个技能。已经有了就什么都不做（重复授予不该产生第二份触发）。
 *
 * 死亡角色不再触发技能，但这里仍然记账：`serialize` / `restore` 之后
 * 战报和界面还要显示「他觉醒过」。规则层的过滤在 `registerSkillTriggers`
 * 和各调用点的 `alive` 判断里。
 */
export function grantSkill(state: SanguoshaState, playerId: PlayerId, skillId: string): boolean {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return false
  player.grantedSkills ??= []
  if (player.grantedSkills.includes(skillId)) return false
  player.grantedSkills.push(skillId)
  return true
}

/** 同一来源只保留一个临时技能，替换对序列化状态是原子的。 */
export function replaceTemporarySkill(state: SanguoshaState, playerId: PlayerId, source: string, skillId: string | null): void {
  replaceTemporarySkills(state, playerId, source, skillId ? [skillId] : [])
}

/**
 * 同一来源整批替换临时技能。
 *
 * 关兴张苞【父魂】一次给**两个**技能（武圣、咆哮），逐个调
 * `replaceTemporarySkill` 会让后一个把前一个覆盖掉，最后只剩一个。
 *
 * 「按来源替换」还保证了收回时**只收回这一次授予的**：
 * 他本来就有的、或别的技能给的同名技能不会被一起收走。
 */
export function replaceTemporarySkills(
  state: SanguoshaState,
  playerId: PlayerId,
  source: string,
  skillIds: readonly string[],
): void {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return
  player.temporaryGrantedSkills ??= []
  const removedSkillIds = new Set(player.temporaryGrantedSkills
    .filter((entry) => entry.source === source)
    .map((entry) => entry.skillId))
  player.temporaryGrantedSkills = player.temporaryGrantedSkills.filter((entry) => entry.source !== source)
  if (removedSkillIds.size > 0) {
    // 已经排队但还没问出去的那些，随技能一起收走
    state.skillQueue = state.skillQueue.filter((prompt) => prompt.ownerId !== playerId || !removedSkillIds.has(prompt.skillId))
  }
  for (const skillId of skillIds) player.temporaryGrantedSkills.push({ source, skillId })
}

/**
 * 移除技能后重新检查“非正体力仍存活”的依据。
 * 典型场景是左慈换掉【不屈】或被【断肠】剥夺技能；不能留下 0 血活人，也不能把武将名写进伤害管线。
 */
export function recheckZeroHpAfterSkillLoss(host: SkillHost, playerId: PlayerId): void {
  const player = host.state.players.find((candidate) => candidate.id === playerId)
  if (!player?.alive || player.hp > 0) return
  const survives = ownedSkillIds(host.state, playerId).some((skillId) => getSkillRuntime(skillId)?.survivesAtZeroHp?.(host.state, playerId))
  if (!survives) host.enterDying(playerId)
}

/** 选将完成后的技能初始化；只调用当前实际拥有技能的角色。 */
export function initializeGameSkills(host: SkillHost, skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf): void {
  for (const player of host.state.players) {
    if (!player.alive || !player.characterId) continue
    for (const runtime of skillsOf(host.state, player.id, skillIdsOf)) runtime.onGameStart?.(host, player.id)
  }
}

/** 某名玩家当前拥有的技能运行时。武将没选定时返回空。 */
export function skillsOf(state: SanguoshaState, playerId: PlayerId, skillIdsOf: (characterId: string) => string[]): SkillRuntime[] {
  const ownIds = ownedSkillIds(state, playerId, skillIdsOf)
  const useMuted = state.clanUseSkillMute?.playerId === playerId
  const effectiveIds = useMuted ? ownIds.filter((skillId) => skillId === 'zhongliu-clan-wang') : ownIds
  const externallyDisabled = Boolean(state.dying && state.players.some((owner) => owner.alive && owner.id !== playerId && owner.characterId
    && ownedSkillIds(state, owner.id, skillIdsOf).some((skillId) => registry.get(skillId)
      ?.globallyInvalidatesOtherSkills?.(state, owner.id, playerId) ?? false)))
  return (externallyDisabled ? effectiveIds.filter((skillId) => isLockedSkill(skillId, state, playerId)) : effectiveIds)
    .map((skillId) => registry.get(skillId))
    .filter((runtime): runtime is SkillRuntime => !!runtime)
}

/** 技能给出的手牌上限加成之和。 */
/** 场上所有角色的技能给这名角色提供的手牌上限修正之和。 */
export function globalMaxCardsBonusOf(
  state: SanguoshaState,
  targetId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number {
  let bonus = 0
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      bonus += Math.trunc(runtime.globalMaxCardsBonus?.(state, owner.id, targetId) ?? 0)
    }
  }
  return bonus
}

/** 场上所有角色的技能给这名角色提供的出杀次数加成之和。 */
export function globalSlashUsesOf(
  state: SanguoshaState,
  targetId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number {
  let bonus = 0
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      bonus += Math.trunc(runtime.globalSlashUses?.(state, owner.id, targetId) ?? 0)
    }
  }
  return bonus
}

/** 场上所有角色的技能给这名角色提供的"即将回复体力值"加成之和。 */
export function recoverAmountBonusOf(
  state: SanguoshaState,
  targetId: PlayerId,
  sourceId: PlayerId | null,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
  sourceCardId?: CardId,
): number {
  let bonus = 0
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      bonus += Math.trunc(runtime.recoverAmountBonus?.(state, targetId, sourceId, sourceCardId) ?? 0)
    }
  }
  return bonus
}

/** 拥有者使用一张基本牌时，来自其技能的数值加成之和。 */
export function basicCardUseValueBonusOf(
  state: SanguoshaState,
  ownerId: PlayerId,
  cardId: CardId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number {
  return skillsOf(state, ownerId, skillIdsOf).reduce((bonus, runtime) =>
    bonus + Math.trunc(runtime.basicCardUseValueBonus?.(state, ownerId, cardId, cardName) ?? 0), 0)
}

export function maxCardsBonusOf(
  state: SanguoshaState,
  playerId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number {
  let bonus = 0
  for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
    bonus += Math.trunc(runtime.maxCardsBonus?.(state, playerId) ?? 0)
  }
  return bonus
}

/** 这张牌在弃牌阶段是否不计入拥有者的手牌上限判定。 */
export function isHandLimitExempt(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId: CardId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return (state.skillHandLimitExemptCardIds?.[playerId]?.includes(cardId) ?? false)
    || state.cards[cardId]?.name === '瞒天过海'
    || skillsOf(state, playerId, skillIdsOf).some((runtime) => runtime.handLimitExempt?.(state, playerId, cardId))
    || state.players.some((owner) => owner.alive && owner.id !== playerId
      && skillsOf(state, owner.id, skillIdsOf).some((runtime) => runtime.globalHandLimitExempt?.(state, owner.id, playerId, cardId)))
}

/** 拥有者的摸牌是否一律改从牌堆底摸。 */
export function drawsFromBottomFor(
  state: SanguoshaState,
  playerId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return skillsOf(state, playerId, skillIdsOf).some((runtime) => runtime.drawsFromBottom?.(state, playerId))
}

/** 统一计算技能给出的固定手牌上限；没有固定效果时返回 null。 */
export function fixedMaxCardsOf(
  state: SanguoshaState,
  playerId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number | null {
  for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
    const value = runtime.fixedMaxCards?.(state, playerId)
    if (value != null) return Math.max(0, Math.trunc(value))
  }
  return null
}

export function overrideJudgmentSuitOf(state: SanguoshaState, judgedPlayerId: PlayerId, suit: Suit,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf): Suit {
  let result = suit
  for (const owner of state.players) {
    if (!owner.alive) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      result = runtime.overrideJudgmentSuit?.(state, owner.id, judgedPlayerId, result) ?? result
    }
  }
  return result
}

/** 服务端生成合法操作时统一检查目标限制，客户端不自行推断。 */
/** 过河拆桥/顺手牵羊的「弃置」分支挑牌前过一遍：拥有者的哪些牌不能被这样弃掉。 */
export function isCardProtectedFromDiscard(
  state: SanguoshaState,
  ownerId: PlayerId,
  cardId: CardId,
  sourceId?: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return skillsOf(state, ownerId, skillIdsOf).some((runtime) => runtime.protectsCardFromDiscard?.(state, ownerId, cardId, sourceId) ?? false)
}

export function isTargetProhibited(
  state: SanguoshaState,
  sourceId: PlayerId,
  targetId: PlayerId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[],
  cardId?: CardId,
  sourceSkillId?: string,
): boolean {
  return skillsOf(state, targetId, skillIdsOf)
    .some((runtime) => runtime.prohibitsTarget?.(state, targetId, sourceId, cardName, cardId) ?? false)
    || skillsOf(state, sourceId, skillIdsOf)
      .some((runtime) => runtime.prohibitsSourceTarget?.(state, sourceId, targetId, cardName, sourceSkillId) ?? false)
    || state.players.some((owner) => owner.alive && skillsOf(state, owner.id, skillIdsOf)
      .some((runtime) => runtime.globalProhibitsSourceTarget?.(state, owner.id, sourceId, targetId, cardName) ?? false))
}

/** 将旁观技能要求的额外目标接入牌的真实结算列表，按座次聚合并去重。 */
export function additionalTargetsOnUseOf(
  state: SanguoshaState,
  sourceId: PlayerId,
  cardId: CardId,
  cardName: string,
  currentTargetIds: readonly PlayerId[],
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): PlayerId[] {
  const result = [...currentTargetIds]
  for (const owner of state.players) {
    if (!owner.alive || owner.id === sourceId || result.includes(owner.id)) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      const added = runtime.additionalTargetsOnUse?.(state, owner.id, sourceId, cardId, cardName, result) ?? []
      for (const targetId of added) {
        if (targetId === owner.id && !result.includes(targetId) && state.players.some(p => p.id === targetId && p.alive)) result.push(targetId)
      }
    }
  }
  for (const owner of state.players) {
    if (!owner.alive) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      const forced = runtime.forcedAdditionalTargetsOnUse?.(state, owner.id, sourceId, cardId, cardName, result, skillIdsOf) ?? []
      for (const targetId of forced) {
        if (!result.includes(targetId) && state.players.some(p => p.id === targetId && p.alive)) result.push(targetId)
      }
    }
  }
  return result
}

/**
 * 某人现在能不能使用某张牌。
 *
 * 遍历**全场存活角色**的技能，因为施加限制的人（贾诩）和被限制的人不是同一个。
 * 目前只有濒死救援会问到这里，所以上下文里带当前濒死角色。
 */
/**
 * 这名角色现在能不能**打出**这个牌名的牌。
 *
 * 各条求牌路径（求闪、南蛮万箭决斗的求牌）共用这一个入口，
 * 不要各写一遍——漏一条就等于那条路上的禁令不存在。
 */
/** 技能给出的、按属性算的额外【杀】目标数之和。 */
export function extraSlashTargetsOf(
  state: SanguoshaState,
  playerId: PlayerId,
  nature: DamageNature,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number {
  return skillsOf(state, playerId, skillIdsOf)
    .reduce((total, runtime) => total + Math.max(0, Math.trunc(runtime.extraSlashTargets?.(state, playerId, nature) ?? 0)), 0)
}

/** Candidate identities granted as selectable additional Slash targets by skills. */
export function extraSlashTargetIdsOf(
  state: SanguoshaState,
  playerId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): PlayerId[] {
  return [...new Set(skillsOf(state, playerId, skillIdsOf)
    .flatMap((runtime) => runtime.extraSlashTargetIds?.(state, playerId) ?? [])
    .filter((targetId) => state.players.some((target) => target.id === targetId && target.alive && target.id !== playerId)))]
}

export function isCardResponseProhibited(
  state: SanguoshaState,
  responderId: PlayerId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  if (skillsOf(state, responderId, skillIdsOf)
    .some((runtime) => runtime.prohibitsOwnResponse?.(state, responderId, cardName))) return true
  return state.players
    .filter((player) => player.alive && player.characterId)
    .some((owner) => skillsOf(state, owner.id, skillIdsOf)
      .some((runtime) => runtime.prohibitsCardResponse?.(state, owner.id, responderId, cardName)))
}

/** 对响应实体牌应用全场技能的牌级限制；转化牌仍以其实体子牌判定。 */
export function isResponseCardProhibited(
  state: SanguoshaState,
  responderId: PlayerId,
  responseCardId: CardId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  if (blocksMilitaryOrderHandCard(state, responderId, responseCardId)) return true
  return state.players
    .filter((owner) => owner.alive && owner.characterId)
    .some((owner) => skillsOf(state, owner.id, skillIdsOf)
      .some((runtime) => runtime.prohibitsResponseCard?.(state, owner.id, responderId, responseCardId, cardName)))
}

/** 无实体牌的虚拟响应与装备响应也必须经过公共限制入口。 */
export function isCardlessResponseProhibited(
  state: SanguoshaState,
  responderId: PlayerId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return state.players.filter((owner) => owner.alive && owner.characterId)
    .some((owner) => skillsOf(state, owner.id, skillIdsOf)
      .some((runtime) => runtime.prohibitsCardlessResponse?.(state, owner.id, responderId, cardName)))
}

export function isCardUseUnresponsiveToTarget(
  state: SanguoshaState,
  sourceId: PlayerId,
  cardId: CardId,
  targetId: PlayerId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return state.players.filter((player) => player.alive && player.characterId)
    .some((owner) => skillsOf(state, owner.id, skillIdsOf)
      .some((runtime) => runtime.cardUnresponsiveToTarget?.(state, owner.id, sourceId, cardId, targetId, cardName) ?? false))
}

export function isCardUseProhibited(
  state: SanguoshaState,
  userId: PlayerId,
  cardName: string,
  context: { dyingPlayerId: PlayerId | null; cardIds?: readonly CardId[] },
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  if (context.cardIds?.some((cardId) => blocksMilitaryOrderHandCard(state, userId, cardId))) return true
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      if (runtime.prohibitsCardUse?.(state, owner.id, { userId, cardName, dyingPlayerId: context.dyingPlayerId, cardIds: context.cardIds })) return true
    }
  }
  return false
}

/**
 * 取得某名角色视角下牌张的有效花色。
 *
 * 花色修正必须集中在规则层：判定、火攻等地方只读这个结果，不能分别写
 * “如果是小乔且为黑桃”的特殊判断。没有技能修正时返回实体牌印刷花色。
 */
export function effectiveCardSuit(
  state: SanguoshaState,
  ownerId: PlayerId,
  cardId: CardId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): Suit {
  const card = state.cards[cardId]
  if (!card) throw new Error(`卡牌不存在：${cardId}`)
  return skillsOf(state, ownerId, skillIdsOf)
    .reduce((suit, runtime) => runtime.cardSuit?.(state, ownerId, cardId, suit) ?? suit, card.suit)
}

export function slashNatureFor(
  state: SanguoshaState,
  ownerId: PlayerId,
  nature: DamageNature,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): DamageNature {
  let result = nature
  for (const runtime of skillsOf(state, ownerId, skillIdsOf))
    result = runtime.slashNatureOverride?.(state, ownerId, result) ?? result
  return result
}

/** 判定牌点数的有效值：没有技能覆盖就是印刷点数。 */
export function effectiveJudgmentRank(
  state: SanguoshaState,
  ownerId: PlayerId,
  cardId: CardId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number {
  const card = state.cards[cardId]
  if (!card) throw new Error(`卡牌不存在：${cardId}`)
  for (const runtime of skillsOf(state, ownerId, skillIdsOf)) {
    const override = runtime.judgmentRankOverride?.(state, ownerId, cardId)
    if (override != null) return override
  }
  return card.rank
}

export function effectiveCardColor(
  state: SanguoshaState,
  ownerId: PlayerId,
  cardId: CardId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): 'red' | 'black' | null {
  /*
   * 颜色改写优先（荀攸【奇策】把一把混色手牌合成一张**无色**的锦囊）。
   * 有记录就照记录，包括记着「无色」的那一种——那正是需要表达的第三种结果。
   */
  const override = cardColorOverrideOf(state, cardId)
  if (override !== undefined) return override
  const suit = effectiveCardSuit(state, ownerId, cardId, skillIdsOf)
  return suit === 'heart' || suit === 'diamond' ? 'red' : 'black'
}

/**
 * 拥有者能持续看到牌堆顶几张牌（晋司马懿【鹰视】）。返回 0 表示不提供。
 * 只在 `view.ts` 里按 `viewerId === ownerId` 使用，绝不广播给其他客户端。
 */
export function drawPileTopVisibleCountOf(
  state: SanguoshaState,
  ownerId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number {
  return Math.max(0, ...skillsOf(state, ownerId, skillIdsOf).map((runtime) => Math.trunc(runtime.drawPileTopVisibleCount?.(state, ownerId) ?? 0)))
}

/** 统一计算某张有距离限制的锦囊可增加多少使用距离。 */
export function trickDistanceBonusOf(
  state: SanguoshaState,
  sourceId: PlayerId,
  targetId: PlayerId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number {
  return skillsOf(state, sourceId, skillIdsOf)
    .reduce((total, runtime) => total + Math.trunc(runtime.trickDistanceBonus?.(state, sourceId, targetId, cardName) ?? 0), 0)
}

/** 特定实体牌的锦囊距离上限；多个规则同时提供时取最大值。 */
export function trickDistanceLimitOf(state: SanguoshaState, sourceId: PlayerId, cardId: CardId, cardName: string,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf): number | null {
  const limits = skillsOf(state, sourceId, skillIdsOf).map((runtime) => runtime.trickDistanceLimit?.(state, sourceId, cardId, cardName))
    .filter((limit): limit is number => limit !== null && limit !== undefined)
  return limits.length ? Math.max(...limits) : null
}

/**
 * 「防止这次伤害」——**发生在伤害真的落地之前**的一整条阻断。
 *
 * 徐庶【无言】两个方向都要：他用锦囊打不出伤害，别人用锦囊也伤不到他。
 * 所以这里问的是**某一侧的某个人**（来源侧 / 目标侧），
 * 由伤害管线在两个不同的位置各调一次。
 *
 * 返回防止它的技能 id；没防住就是 null。
 */
export function damagePreventedBy(
  state: SanguoshaState,
  playerId: PlayerId | null,
  side: 'source' | 'target',
  context: DamagePreventionContext,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): string | null {
  if (!playerId) return null
  for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
    if (runtime.preventsDamage?.(state, playerId, side, context)) return runtime.id
  }
  return null
}

/** Final damage gate for skills whose condition depends on the fully modified amount. */
export function finalDamagePreventedBy(
  state: SanguoshaState,
  sourceId: PlayerId | null,
  context: DamagePreventionContext,
): string | null {
  if (!sourceId) return null
  return skillsOf(state, sourceId, providedSkillIdsOf)
    .find((runtime) => runtime.preventsFinalDamage?.(state, sourceId, context))?.id ?? null
}

/**
 * 来源侧是否有技能想就"是否防止这次伤害"发起一次交互式发问。
 * 只在来源侧调用（目前只支持这一侧），别的侧没有对应需求。
 */
export interface DamageAskOwner {
  skillId: string
  ownerId: PlayerId
  step?: string
}

function damageAskOwner(host: SkillHost, skillId: string, ownerId: PlayerId, previousQueueLength: number): DamageAskOwner {
  const queued = host.state.skillQueue.slice(previousQueueLength).find((prompt) => prompt.skillId === skillId && prompt.ownerId === ownerId)
  return { skillId, ownerId, ...(queued ? { step: queued.step } : {}) }
}

export function offerSourceDamagePreventionAsk(
  host: SkillHost,
  sourceId: PlayerId | null,
  context: DamagePreventionContext,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): DamageAskOwner | null {
  if (!sourceId) return null
  for (const runtime of skillsOf(host.state, sourceId, skillIdsOf)) {
    const previousQueueLength = host.state.skillQueue.length
    if (runtime.offersSourceDamagePreventionAsk?.(host, sourceId, context)) return damageAskOwner(host, runtime.id, sourceId, previousQueueLength)
  }
  return null
}

/** 目标侧的等价版本（杜畿【安东】），见 `offersTargetDamagePreventionAsk` 字段说明。 */
export function offerTargetDamagePreventionAsk(
  host: SkillHost,
  targetId: PlayerId,
  context: DamagePreventionContext,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
  skipSkillIds: readonly string[] = [],
): DamageAskOwner | null {
  const targetSkills = skillsOf(host.state, targetId, skillIdsOf)
  for (const runtime of targetSkills) {
    if (skipSkillIds.includes(runtime.id)) continue
    const previousQueueLength = host.state.skillQueue.length
    if (runtime.offersTargetDamagePreventionAsk?.(host, targetId, context)) return damageAskOwner(host, runtime.id, targetId, previousQueueLength)
  }
  for (const owner of host.state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(host.state, owner.id, skillIdsOf)) {
      if (skipSkillIds.includes(runtime.id)) continue
      const previousQueueLength = host.state.skillQueue.length
      if (runtime.offersGlobalDamagePreventionAsk?.(host, owner.id, context)) return damageAskOwner(host, runtime.id, owner.id, previousQueueLength)
    }
  }
  return null
}

export function offerDamageModifierAsk(
  host: SkillHost,
  playerId: PlayerId,
  side: 'source' | 'target',
  context: DamagePreventionContext,
  skippedSkillIds: readonly string[] = [],
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): DamageAskOwner | null {
  for (const runtime of skillsOf(host.state, playerId, skillIdsOf)) {
    if (skippedSkillIds.includes(runtime.id)) continue
    const previousQueueLength = host.state.skillQueue.length
    if (runtime.offersDamageModifierAsk?.(host, playerId, side, context)) return damageAskOwner(host, runtime.id, playerId, previousQueueLength)
  }
  if (side === 'target') {
    for (const owner of host.state.players) {
      if (!owner.alive || !owner.characterId || owner.id === playerId) continue
      for (const runtime of skillsOf(host.state, owner.id, skillIdsOf)) {
        if (skippedSkillIds.includes(runtime.id)) continue
        const previousQueueLength = host.state.skillQueue.length
        if (runtime.offersGlobalDamageModifierAsk?.(host, owner.id, side, context)) return damageAskOwner(host, runtime.id, owner.id, previousQueueLength)
      }
    }
  }
  return null
}

/** 返回让牌对目标无效的第一个技能；顺序固定为武将技能登记顺序。 */
export function cardEffectInvalidBy(
  state: SanguoshaState,
  targetId: PlayerId,
  sourceId: PlayerId | null,
  cardName: string,
  cardColor: 'red' | 'black' | null = null,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): SkillRuntime | null {
  return skillsOf(state, targetId, skillIdsOf)
    .find((runtime) => runtime.cardEffectInvalid?.(state, targetId, sourceId, cardName, cardColor, targetId) ?? false) ?? null
}

/** 拼点点数的有效值覆盖（秦宓【天辩】把自己的红桃拼点牌视为 13）；没有覆盖返回 null。 */
export function pindianRankOverrideOf(
  state: SanguoshaState,
  playerId: PlayerId,
  card: { rank: number; suit?: string },
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number | null {
  for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
    const value = runtime.pindianRankOverride?.(state, playerId, card)
    if (value != null) return value
  }
  return null
}

/** 这名角色是不是不能成为拼点目标（陆抗【谦节】）。 */
export function prohibitsBeingPindianTargetOf(
  state: SanguoshaState,
  playerId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return skillsOf(state, playerId, skillIdsOf).some((runtime) => runtime.prohibitsBeingPindianTarget)
}

/** 拥有者对这个目标使用【杀】时是不是不受次数限制。 */
export function ignoresSlashUsesTo(
  state: SanguoshaState,
  sourceId: PlayerId,
  targetId: PlayerId,
  targetIds: readonly PlayerId[] = [targetId],
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return skillsOf(state, sourceId, skillIdsOf).some((runtime) => runtime.ignoresSlashUsesTo?.(state, sourceId, targetId, targetIds))
}

/** 技能对这张手牌的强制身份改写（高顺【禁酒】）。没有就返回 null。 */
export function skillForcedCardIdentity(
  state: SanguoshaState,
  ownerId: PlayerId,
  cardId: CardId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): { asCardName: string; nature?: DamageNature; skillId: string } | null {
  for (const runtime of skillsOf(state, ownerId, skillIdsOf)) {
    const forced = runtime.forcedCardIdentity?.(state, ownerId, cardId)
    if (forced) return { ...forced, skillId: runtime.id }
  }
  return null
}

/** 按座次稳定地应用第一个伤害来源改写技能。 */
export function modifiedDamageSource(
  state: SanguoshaState,
  context: DamageSourceContext,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): { sourceId: PlayerId | null; ownerId: PlayerId; skillId: string } | null {
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      const sourceId = runtime.modifyDamageSource?.(state, owner.id, context)
      if (sourceId !== undefined && sourceId !== context.sourceId) return { sourceId, ownerId: owner.id, skillId: runtime.id }
    }
  }
  return null
}

/** 拥有者自己声明的攻击范围定值覆盖；没有就返回 null（走普通公式）。 */
export function attackRangeOverrideOf(
  state: SanguoshaState,
  ownerId: PlayerId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): number | null {
  for (const runtime of skillsOf(state, ownerId, skillIdsOf)) {
    const overridden = runtime.overridesAttackRange?.(state, ownerId)
    if (overridden !== undefined && overridden !== null) return overridden
  }
  return null
}

/** 按座次寻找结算后应获得实体牌的技能拥有者。 */
export function resolvedCardRecipientOf(
  state: SanguoshaState,
  context: ResolvedCardContext,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): { playerId: PlayerId; skillId: string } | null {
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      if (runtime.resolvedCardRecipient?.(state, owner.id, context)) return { playerId: owner.id, skillId: runtime.id }
    }
  }
  return null
}

/**
 * 把所有技能的触发器挂到事件总线上。
 *
 * **Durable Object 醒来之后必须重新调用这个函数。**
 * 处理器是运行时代码，序列化不了，GameState 里只有可序列化的数据。
 */
export function registerSkillTriggers(
  host: SkillHost,
  on: (event: GameEventName, handler: (context: EventContext) => void, priority?: number) => void,
  skillIdsOf: (characterId: string) => string[],
): void {
  for (const runtime of registry.values()) {
    for (const trigger of runtime.triggers ?? []) {
      on(trigger.event, (context) => {
        // 只有真正拥有这个技能的人才会被触发；觉醒后获得的技能也算拥有
        for (const player of host.state.players) {
          if ((!player.alive && !trigger.allowDeadOwner) || !player.characterId) continue
          const clanMute = host.state.clanUseSkillMute
          const eventCardId = (context.event.payload as { cardId?: CardId }).cardId
          if (runtime.id !== 'zhongliu-clan-wang' && clanMute?.playerId === player.id
            && clanMute.cardId === eventCardId) continue
          const removedEquipmentSkill = (context.event.payload as { playerId?: PlayerId; specialEquipment?: string }).playerId === player.id
            ? SPECIAL_EQUIPMENT_SKILLS[(context.event.payload as { specialEquipment?: string }).specialEquipment ?? '']
            : undefined
          if (removedEquipmentSkill !== runtime.id && !ownedSkillIds(host.state, player.id, skillIdsOf).includes(runtime.id)) continue
          trigger.handle(host, player.id, context)
        }
      }, trigger.priority ?? 0)
    }

    // 觉醒技统一挂在这里，三名觉醒武将不各写一套 PhaseStart 触发
    if (runtime.awakening) {
      const awakening = runtime.awakening
      on('PhaseStart', (context) => {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== awakening.phase) return
        const ownerId = payload.playerId
        if (!ownerId) return
        const player = host.state.players.find((candidate) => candidate.id === ownerId)
        if (!player?.alive || !player.characterId) return
        if (!ownedSkillIds(host.state, ownerId, skillIdsOf).includes(runtime.id)) return
        // 一局一次，永不重置
        player.awakenedSkills ??= []
        if (player.awakenedSkills.includes(runtime.id)) return
        /*
         * 外部技能（神郭嘉【辉逝】）可以令某个觉醒技「视为已满足觉醒条件」。
         * 放行的只是这一关：时机、记账、效果全都照原样走。
         */
        const forced = hasForcedAwakening(host.state, ownerId, runtime.id)
        if (!forced && !awakening.ready(host.state, ownerId)) return
        /*
         * **先记账再发动。** 觉醒过程里可能挂起发问（姜维【志继】要选
         * 回复还是摸牌），挂起期间这条 PhaseStart 已经走完，
         * 后面再有事件把这个技能问一遍就会重复觉醒。
         */
        player.awakenedSkills.push(runtime.id)
        // 用掉就清，留着没意义而且会让后面的判断读到过期的放行
        if (forced) clearForcedAwakening(host.state, ownerId, runtime.id)
        host.dispatch('SkillAwakened', { playerId: ownerId, skillId: runtime.id }, { sourceId: ownerId })
        awakening.invoke(host, ownerId)
      }, awakening.priority ?? 0)
    }
  }
}
