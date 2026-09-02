
import type { EventContext, GameEvent, GameEventName } from '../events'
import type { GameRequest, GameResponse } from '../requests'
import type { GameRng } from '../rng'
import type { CardCategory, CardId, DamageNature, PlayerId, QueuedSkillPrompt, SanguoshaState, SkillResolutionState, Suit } from '../types'

export interface TargetedCardContext {
  sourceId: PlayerId
  targetId: PlayerId
  cardId: CardId
  cardName: string
  category: CardCategory
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
  /** 见上方说明：这个技能每次发动都自己播横幅，引擎不补兜底那条。 */
  announcesSelf?: boolean
  /** 挂到事件总线上的触发技。 */
  triggers?: SkillTrigger[]
  /** 锁定技：出牌阶段【杀】不限次。 */
  unlimitedSlash?: boolean
  /** 锁定技：使用锦囊时无视距离限制（奇才）。 */
  ignoresTrickDistance?: boolean
  /** 距离修正：正数表示「与其他角色距离 +n」，负数表示 -n。 */
  distanceModifier?: { toOthers?: number; fromOthers?: number }
  /**
   * 濒死介入：拥有者刚进入濒死时先给技能一次机会（不屈）。
   *
   * 返回 true 表示「这次濒死已经由技能处理掉了」，引擎会直接结束濒死状态，
   * **不再求桃**。返回 false 走正常的求桃流程。
   *
   * 只在拥有者自己濒死时调用，而且在 `EnterDying` 之后、第一次求桃之前。
   */
  dyingIntercept?(host: SkillHost, ownerId: PlayerId): boolean
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
  /** 禁止拥有者成为指定牌的目标；谦逊、空城等统一走这个入口。 */
  prohibitsTarget?(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId, cardName: string): boolean
  /** 拥有者作为用牌者时，临时禁止其把某名角色设为指定目标。 */
  prohibitsSourceTarget?(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, cardName: string): boolean
  /** 成为【杀】或普通锦囊目标后可插入发问；返回 true 表示结算已挂起。 */
  interceptTarget?(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean
  /** 拥有者使用【杀】时，目标需要连续打出多少张【闪】。 */
  slashDodgeResponses?: number
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

/** 某名玩家当前拥有的技能运行时。武将没选定时返回空。 */
export function skillsOf(state: SanguoshaState, playerId: PlayerId, skillIdsOf: (characterId: string) => string[]): SkillRuntime[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player?.characterId) return []
  return skillIdsOf(player.characterId)
    .map((skillId) => registry.get(skillId))
    .filter((runtime): runtime is SkillRuntime => !!runtime)
}

/** 服务端生成合法操作时统一检查目标限制，客户端不自行推断。 */
export function isTargetProhibited(
  state: SanguoshaState,
  sourceId: PlayerId,
  targetId: PlayerId,
  cardName: string,
  skillIdsOf: (characterId: string) => string[],
): boolean {
  return skillsOf(state, targetId, skillIdsOf)
    .some((runtime) => runtime.prohibitsTarget?.(state, targetId, sourceId, cardName) ?? false)
    || skillsOf(state, sourceId, skillIdsOf)
      .some((runtime) => runtime.prohibitsSourceTarget?.(state, sourceId, targetId, cardName) ?? false)
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
        // 只有真正拥有这个技能的人才会被触发
        for (const player of host.state.players) {
          if (!player.alive || !player.characterId) continue
          if (!skillIdsOf(player.characterId).includes(runtime.id)) continue
          trigger.handle(host, player.id, context)
        }
      }, trigger.priority ?? 0)
    }
  }
}
