
import type { EventContext, GameEvent, GameEventName } from '../events'
import type { LegalAction } from '../actions'
import type { GameRequest, GameResponse } from '../requests'
import type { GameRng } from '../rng'
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
  /** 濒死技能结束后恢复属性链、判定或卡牌结算。 */
  resumeAfterDying(): void
  /**
   * 技能发起一张无距离和次数限制的【杀】。
   *
   * 不给 `cardId` 就是纯虚拟【杀】；给了则用这张实体手牌当载体，
   * 牌该弃还是照常弃，花色和火/雷属性照常生效。
   */
  beginVirtualSlash(options: {
    sourceId: PlayerId
    targetId: PlayerId
    sourceSkillId: string
    nature?: DamageNature
    cardId?: CardId
  }): void
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
}

export interface SkillRuntime {
  id: string
  /** 供化身资格判断使用，不能靠技能 id 黑名单。 */
  limited?: boolean
  lord?: boolean
  /** 选将完成并进入 playing 后初始化本技能的可序列化局内资源。 */
  onGameStart?(host: SkillHost, ownerId: PlayerId): void
  /** 见上方说明：这个技能每次发动都自己播横幅，引擎不补兜底那条。 */
  announcesSelf?: boolean
  /** 挂到事件总线上的触发技。 */
  triggers?: SkillTrigger[]
  /**
   * 主动用牌真正进入处理区之前的可挂起拦截点。
   * 返回 true 表示技能已经发出可序列化 Request，原动作暂不继续。
   */
  interceptPlayAction?(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>): boolean
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
  /** 锁定技：出牌阶段【杀】不限次。 */
  unlimitedSlash?: boolean
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
  ignoresTrickDistance?: boolean
  /** 指定锦囊的额外使用距离；断粮只给【兵粮寸断】增加 1。 */
  trickDistanceBonus?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardName: string): number
  /** 锁定技：指定牌对拥有者无效。和“不能成为目标”是两个不同规则。 */
  cardEffectInvalid?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId | null, cardName: string): boolean
  /** 锁定技：在伤害事件产生前改写伤害来源。 */
  modifyDamageSource?(state: SanguoshaState, ownerId: PlayerId, context: DamageSourceContext): PlayerId | null | undefined
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
  /**
   * 固定手牌上限。返回 null 表示沿用通常的“当前体力值”。
   *
   * 这是“固定为 N”而不是普通加减修正，所以 1 体力时返回 2 仍然是 2。
   * 临时效果必须把有效期写进可序列化状态，不能依赖计时器或闭包。
   */
  fixedMaxCards?(state: SanguoshaState, ownerId: PlayerId): number | null
  /**
   * 手牌上限**加成**。返回 0 表示不加。
   *
   * 和 `fixedMaxCards` 是两件事：那个是「固定为 N」，这个是在基数上叠加，
   * 多个来源相加，不会互相覆盖（袁绍【血裔】走这一条）。
   */
  maxCardsBonus?(state: SanguoshaState, ownerId: PlayerId): number
  /**
   * 濒死介入：拥有者刚进入濒死时先给技能一次机会（不屈）。
   *
   * 返回 true 表示「这次濒死已经由技能处理掉了」，引擎会直接结束濒死状态，
   * **不再求桃**。返回 false 走正常的求桃流程。
   *
   * 只在拥有者自己濒死时调用，而且在 `EnterDying` 之后、第一次求桃之前。
   */
  dyingIntercept?(host: SkillHost, ownerId: PlayerId): boolean | 'pending'
  /** 无真实防具时提供的虚拟防具牌名（八阵）。 */
  virtualArmor?(state: SanguoshaState, ownerId: PlayerId): string | null
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
  /** 锁定技对拥有者牌张花色的修正；判定牌按判定角色处理。 */
  cardSuit?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, printedSuit: Suit): Suit
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
   * 禁止**别人**在当前情境下使用某张牌（贾诩【完杀】）。
   *
   * 和 `prohibitsTarget` 的方向相反：这里的拥有者是施加限制的那个人，
   * `userId` 是想用牌的人。濒死救援是目前唯一的调用点，所以上下文里带着
   * 当前濒死角色——嵌套濒死时读的必须是**当前**那一个，不能锁死在最初那个。
   */
  prohibitsCardUse?(
    state: SanguoshaState,
    ownerId: PlayerId,
    context: { userId: PlayerId; cardName: string; dyingPlayerId: PlayerId | null },
  ): boolean
  /** 拥有者作为用牌者时，临时禁止其把某名角色设为指定目标。 */
  prohibitsSourceTarget?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardName: string): boolean
  /** 成为【杀】或普通锦囊目标后可插入发问；返回 true 表示结算已挂起。 */
  interceptTarget?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
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
  slashUndodgeable?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean
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
  startQueued?(host: SkillHost, ownerId: PlayerId, prompt: QueuedSkillPrompt): void
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
  /**
   * 「恰好 N 张同花色的牌当作某张牌」的转化能力（神赵云【龙魂】）。
   *
   * 和单牌 `viewAs` 分开：那个一次只报一张牌，凑不出「恰好 N 张同花色」这个约束，
   * 而且把所有组合枚举成选项在手机上没法用。具体流程见 engine/multi-card-viewas.ts。
   */
  multiCardViewAs?(state: SanguoshaState, ownerId: PlayerId): MultiCardViewAsSpec | null
}

const registry = new Map<string, SkillRuntime>()
let providedSkillIdsOf: (characterId: string) => string[] = () => []

/** 由角色总表在模块初始化完成后回注，避免各扩展包反向 import 总表形成环。 */
export function provideSkillIdsLookup(lookup: (characterId: string) => string[]): void {
  providedSkillIdsOf = lookup
}

export function registerSkillRuntime(runtime: SkillRuntime): void {
  if (registry.has(runtime.id)) throw new Error(`技能重复注册：${runtime.id}`)
  registry.set(runtime.id, runtime)
}

export function getSkillRuntime(skillId: string): SkillRuntime | undefined {
  return registry.get(skillId)
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
  if (!player?.characterId) return []
  if (player.characterSkillsDisabled) return []
  // 提到闭包外面：TS 在 filter 的回调里丢掉 characterId 的非空收窄
  const own = skillIdsOf(player.characterId)
  const granted = player.grantedSkills ?? []
  const temporary = (player.temporaryGrantedSkills ?? []).map((entry) => entry.skillId)
  return [...new Set([...own, ...granted, ...temporary])]
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
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return
  player.temporaryGrantedSkills ??= []
  const removedSkillIds = new Set(player.temporaryGrantedSkills
    .filter((entry) => entry.source === source)
    .map((entry) => entry.skillId))
  player.temporaryGrantedSkills = player.temporaryGrantedSkills.filter((entry) => entry.source !== source)
  if (removedSkillIds.size > 0) {
    state.skillQueue = state.skillQueue.filter((prompt) => prompt.ownerId !== playerId || !removedSkillIds.has(prompt.skillId))
  }
  if (skillId) player.temporaryGrantedSkills.push({ source, skillId })
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
  return ownedSkillIds(state, playerId, skillIdsOf)
    .map((skillId) => registry.get(skillId))
    .filter((runtime): runtime is SkillRuntime => !!runtime)
}

/** 技能给出的手牌上限加成之和。 */
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

/** 服务端生成合法操作时统一检查目标限制，客户端不自行推断。 */
export function isTargetProhibited(
  state: SanguoshaState,
  sourceId: PlayerId,
  targetId: PlayerId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[],
  cardId?: CardId,
): boolean {
  return skillsOf(state, targetId, skillIdsOf)
    .some((runtime) => runtime.prohibitsTarget?.(state, targetId, sourceId, cardName, cardId) ?? false)
    || skillsOf(state, sourceId, skillIdsOf)
      .some((runtime) => runtime.prohibitsSourceTarget?.(state, sourceId, targetId, cardName) ?? false)
}

/**
 * 某人现在能不能使用某张牌。
 *
 * 遍历**全场存活角色**的技能，因为施加限制的人（贾诩）和被限制的人不是同一个。
 * 目前只有濒死救援会问到这里，所以上下文里带当前濒死角色。
 */
export function isCardUseProhibited(
  state: SanguoshaState,
  userId: PlayerId,
  cardName: string,
  context: { dyingPlayerId: PlayerId | null },
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      if (runtime.prohibitsCardUse?.(state, owner.id, { userId, cardName, dyingPlayerId: context.dyingPlayerId })) return true
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

export function effectiveCardColor(
  state: SanguoshaState,
  ownerId: PlayerId,
  cardId: CardId,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): 'red' | 'black' {
  const suit = effectiveCardSuit(state, ownerId, cardId, skillIdsOf)
  return suit === 'heart' || suit === 'diamond' ? 'red' : 'black'
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

/** 返回让牌对目标无效的第一个技能；顺序固定为武将技能登记顺序。 */
export function cardEffectInvalidBy(
  state: SanguoshaState,
  targetId: PlayerId,
  sourceId: PlayerId | null,
  cardName: string,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): SkillRuntime | null {
  return skillsOf(state, targetId, skillIdsOf)
    .find((runtime) => runtime.cardEffectInvalid?.(state, targetId, sourceId, cardName) ?? false) ?? null
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
          if (!ownedSkillIds(host.state, player.id, skillIdsOf).includes(runtime.id)) continue
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
        if (!awakening.ready(host.state, ownerId)) return
        /*
         * **先记账再发动。** 觉醒过程里可能挂起发问（姜维【志继】要选
         * 回复还是摸牌），挂起期间这条 PhaseStart 已经走完，
         * 后面再有事件把这个技能问一遍就会重复觉醒。
         */
        player.awakenedSkills.push(runtime.id)
        host.dispatch('SkillAwakened', { playerId: ownerId, skillId: runtime.id }, { sourceId: ownerId })
        awakening.invoke(host, ownerId)
      }, awakening.priority ?? 0)
    }
  }
}
