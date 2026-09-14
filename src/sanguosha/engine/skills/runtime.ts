
import type { EventContext, GameEvent, GameEventName } from '../events'
import { clearForcedAwakening, hasForcedAwakening } from '../forced-awakening'
import type { LegalAction } from '../actions'
import type { GameRequest, GameResponse } from '../requests'
import type { GameRng } from '../rng'
import { isSkillSuppressed } from '../skill-suppression'
import { cardColorOverrideOf } from '../card-color'
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
  /** 「视为使用一张【杀】」。返回 false 表示被封牌规则挡住、这次没用出去。 */
  beginVirtualSlash(options: {
    sourceId: PlayerId
    targetId: PlayerId
    sourceSkillId: string
    nature?: DamageNature
    cardId?: CardId
    /** 这张虚拟【杀】算不算一次出杀次数；不传按老行为不计次数。 */
    countUsage?: boolean
  }): boolean
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
   * 按【杀】的**属性**多指定几个目标（程普【疠火】的火【杀】+1）。
   *
   * 和 `slash-rules.ts` 里那个回合级的 `extraTargets` 分开：那一个是
   * 「这一回合每张杀都多一个目标」（太史慈【天义】），这一个只看这张牌
   * 是什么属性，和回合无关。两者在 `slashTargetLimit` 里相加。
   */
  extraSlashTargets?(state: SanguoshaState, ownerId: PlayerId, nature: DamageNature): number
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
  /**
   * 使用锦囊时无视距离限制（奇才）。
   *
   * 允许写成函数：有些效果只在某个条件下成立（神孙权【圣质】只管「下一张牌」），
   * 写死成布尔就只能是「一直有」或「一直没有」。
   */
  ignoresTrickDistance?: boolean | ((state: SanguoshaState, ownerId: PlayerId) => boolean)
  /** 指定锦囊的额外使用距离；断粮只给【兵粮寸断】增加 1。 */
  trickDistanceBonus?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardName: string): number
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
  ): boolean
  /** 锁定技：在伤害事件产生前改写伤害来源。 */
  modifyDamageSource?(state: SanguoshaState, ownerId: PlayerId, context: DamageSourceContext): PlayerId | null | undefined
  /**
   * 拥有者这张拼点牌的有效点数覆盖（秦宓【天辩】：自己的红桃拼点牌视为 13）。
   * 返回 null/undefined 表示不覆盖，按牌面点数算。只改拼点里的比较值，
   * 不改这张牌本身的点数。
   */
  pindianRankOverride?(state: SanguoshaState, ownerId: PlayerId, card: { rank: number; suit?: string }): number | null | undefined
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
   * 拥有者对**某一个特定目标**的距离修正（田豫【追讨】：只对被选中的那个人
   * -1，不是对所有人都 -1）。和 `distanceModifier.toOthers` 是两回事——
   * 那个对所有人生效，这个只对 `targetId` 生效，技能自己按
   * source-target 维护持久状态（不建立在 `distanceModifier` 里，避免
   * 「对所有人」和「对某一个人」两种语义混进同一个字段）。
   */
  directedDistanceTo?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): number
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
   * 拥有者即将回复的体力值加成（曹嵩【翊正】：目标下一次回复+1）。
   *
   * 在 `recover()` 夹住上限之前叠加到 amount 上，多个来源相加。
   * 返回 0 表示不加。
   */
  recoverAmountBonus?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId | null): number
  /**
   * 弃牌阶段手牌数是否计入「张数」：返回 true 表示这张牌**不计入**手牌上限判定
   * （诸葛果【羽化】的锦囊/装备牌、李严【腹鳞】本回合获得的牌）。
   * 只影响弃牌数量的计算，不影响这张牌能否被选中弃置。
   */
  handLimitExempt?(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): boolean
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
  invokeRescueAction?(host: SkillHost, ownerId: PlayerId, actionId: string, dyingPlayerId: PlayerId): boolean
  /**
   * 濒死介入：拥有者刚进入濒死时先给技能一次机会（不屈）。
   *
   * 返回 true 表示「这次濒死已经由技能处理掉了」，引擎会直接结束濒死状态，
   * **不再求桃**。返回 false 走正常的求桃流程。
   *
   * 只在拥有者自己濒死时调用，而且在 `EnterDying` 之后、第一次求桃之前。
   */
  dyingIntercept?(host: SkillHost, ownerId: PlayerId): boolean | 'pending'
  /**
   * 拥有者对**这个目标**使用【杀】时不受次数限制（高顺【陷阵】胜利后）。
   *
   * 和「本回合无限杀」不是一回事：这是**定向**的，
   * 对别人出杀仍然要按普通次数算。多目标的一张【杀】只有在
   * **每个目标**都被豁免时才算突破次数限制，否则捎带一个普通目标
   * 就成了无限杀的后门。
   */
  ignoresSlashUsesTo?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean
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
  /** 拥有者作为用牌者时，临时禁止其把某名角色设为指定目标。 */
  prohibitsSourceTarget?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardName: string): boolean
  /** 成为【杀】或普通锦囊目标后可插入发问；返回 true 表示结算已挂起。 */
  interceptTarget?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
  /**
   * **使用者**在指定目标后的插入点（神马超【霆威】）。
   *
   * 和 `interceptTarget` 同一个挂起点，只是方向相反：那个属于被指定的人，
   * 这个属于出牌的人。排在装备和目标方的反应之前——【铁骑】就是这个位置，
   * 它先于雌雄双股剑和【流离】。
   *
   * 返回 true 表示已经发问、结算挂起；答完之后**必须**调 `resumeCardTarget()`
   * 把控制权交回去，否则牌局停在这里。
   */
  interceptSourceTarget?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
  /**
   * 旁观者插入点（秦宓【谏征】）：既不是使用者也不是目标，只要求某个前置
   * 条件（谏征要求「在使用者攻击范围内」，由技能自己判断，这里不做通用
   * 校验）。目前只有【杀】的结算会遍历它，见 `askSlashInterceptors`。
   * 返回 true 表示已经发问、结算挂起；答完之后同样要调 `resumeCardTarget()`。
   */
  interceptBystanderTarget?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
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
  /**
   * 锁定技：拥有者对某个目标使用的**锦囊**，那个目标完全不能响应
   * （神孙策【覆海】）。
   *
   * 和 `slashUndodgeable` 是同一件事的锦囊版，问的同样是**使用者**的技能。
   * 只封住这一个目标本人：别人替他出【无懈可击】不受影响，
   * 那是另一条规则，不从这里走。
   */
  trickUnresponsive?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardName: string, cardId?: CardId): boolean
  /**
   * 拥有者对某个特定角色**使用牌时不受距离限制**（神孙策【英霸】）。
   *
   * 和 `distanceModifier` 的区别：那个是把距离算小一点，这个是整条距离限制
   * 直接不成立。文本说的是「使用牌」，所以【杀】的攻击范围、
   * 【顺手牵羊】【兵粮寸断】的距离 1 都一并覆盖，不是只管杀。
   */
  ignoresDistanceTo?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardId?: CardId): boolean
  /**
   * 拥有者的技能让**任意第三方**对某个目标无视距离（孙休【诏缚】：与孙休
   * 距离为 1 的角色视为处于所有其他吴势力角色的攻击范围内）。
   *
   * 和 `ignoresDistanceTo` 的区别：那个只问「拥有者自己打这个目标」，
   * 这个要覆盖「别人打这个目标」，`attackerId` 因此和 `ownerId` 是两个人。
   * 动态计算，不建立常驻覆盖记录——诏缚这类效果会随距离实时变化。
   */
  globalIgnoresDistanceTo?(state: SanguoshaState, ownerId: PlayerId, attackerId: PlayerId, targetId: PlayerId): boolean
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
  const ids: string[] = []
  for (const cardId of Object.values(player.zones.equipment)) {
    if (!cardId) continue
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
  if (!player.characterId || player.characterSkillsDisabled) {
    return borrowed.filter((skillId) => !isSkillSuppressed(state, playerId, skillId))
  }
  // 提到闭包外面：TS 在 filter 的回调里丢掉 characterId 的非空收窄
  const own = skillIdsOf(player.characterId)
  const granted = player.grantedSkills ?? []
  const temporary = (player.temporaryGrantedSkills ?? []).map((entry) => entry.skillId)
  /*
   * 被单独压制的技能在这里就摘掉（神张辽【夺锐】）。
   *
   * 出口只有这一个，所以主动技按钮、触发时机、转化、响应、被动修正、
   * AI 全都自然失效——不需要在每条路径上各写一遍判断。
   * 和断肠的「全部技能失效」是两条独立规则，各管各的。
   */
  return [...new Set([...own, ...granted, ...temporary, ...borrowed])]
    .filter((skillId) => !isSkillSuppressed(state, playerId, skillId))
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
  return ownedSkillIds(state, playerId, skillIdsOf)
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
): number {
  let bonus = 0
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      bonus += Math.trunc(runtime.recoverAmountBonus?.(state, targetId, sourceId) ?? 0)
    }
  }
  return bonus
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
  return skillsOf(state, playerId, skillIdsOf).some((runtime) => runtime.handLimitExempt?.(state, playerId, cardId))
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

export function isCardResponseProhibited(
  state: SanguoshaState,
  responderId: PlayerId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return skillsOf(state, responderId, skillIdsOf)
    .some((runtime) => runtime.prohibitsOwnResponse?.(state, responderId, cardName))
}

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

/**
 * 来源侧是否有技能想就"是否防止这次伤害"发起一次交互式发问。
 * 只在来源侧调用（目前只支持这一侧），别的侧没有对应需求。
 */
export function offerSourceDamagePreventionAsk(
  host: SkillHost,
  sourceId: PlayerId | null,
  context: DamagePreventionContext,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  if (!sourceId) return false
  return skillsOf(host.state, sourceId, skillIdsOf).some((runtime) => runtime.offersSourceDamagePreventionAsk?.(host, sourceId, context) ?? false)
}

/** 目标侧的等价版本（杜畿【安东】），见 `offersTargetDamagePreventionAsk` 字段说明。 */
export function offerTargetDamagePreventionAsk(
  host: SkillHost,
  targetId: PlayerId,
  context: DamagePreventionContext,
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return skillsOf(host.state, targetId, skillIdsOf).some((runtime) => runtime.offersTargetDamagePreventionAsk?.(host, targetId, context) ?? false)
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
    .find((runtime) => runtime.cardEffectInvalid?.(state, targetId, sourceId, cardName, cardColor) ?? false) ?? null
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
  skillIdsOf: (characterId: string) => string[] = providedSkillIdsOf,
): boolean {
  return skillsOf(state, sourceId, skillIdsOf).some((runtime) => runtime.ignoresSlashUsesTo?.(state, sourceId, targetId))
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
