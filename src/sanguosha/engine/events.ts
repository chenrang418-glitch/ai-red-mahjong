import type { CardId, DamageNature, PlayerId, TurnPhase } from './types'

export type GameEventName =
  | 'GameStart' | 'PlayBegin' | 'RoundStart' | 'RoundEnd' | 'TurnStart' | 'TurnEnd' | 'PhaseStart' | 'PhaseEnd' | 'PhaseSkipped'
  | 'JudgePhase' | 'DrawPhase' | 'DrawPhaseResolved' | 'DrawAttempt' | 'PlayPhase' | 'DiscardPhase'
  | 'BeforeCardUse' | 'CardUsed' | 'TargetSpecified' | 'TargetConfirmed' | 'TargetExpansionSelected' | 'CardResolved' | 'AfterCardUse' | 'CardEnteredDiscard'
  | 'CardResponded' | 'CardEffectResolved' | 'BeforeDamage' | 'DamageCaused' | 'DamageInflicted' | 'Damaged' | 'AfterDamage'
  /**
   * 一次伤害结算彻底走完（无论是正常扣血、被完全防止还是减到 0）。
   * 携带 requestedAmount/finalAmount，供「伤害被减少/防止后」这类
   * 旁观判定使用（骆统【仁政】）——不看某一个具体修正时机，而是看
   * 这一整笔伤害请求最终真正扣掉了多少体力。
   */
  | 'DamageSettled'
  /** 有序多目标伤害序列全部完成（包含其中的濒死/交互续接）后派发。 */
  | 'DamageSequenceResolved'
  | 'SkillActivated' | 'SkillEffectResolved' | 'ConversionStateToggled'
  | 'CharacterFlip' | 'CharacterChained' | 'GeneralSlotChanged' | 'SeatOrderChanged'
  /**
   * 拼点 / 决斗的**胜负结果**。
   *
   * 神张辽【止啼】要的是「你赢时」，不能拿「最后一次伤害的来源是他」凑：
   * 决斗里对方可能被别的效果打死，拼点更是根本不产生伤害。
   * 平局不派发 `PindianResult`——平局不算赢。
   */
  | 'PindianStart' | 'PindianResult' | 'DuelResult'
  /**
   * 拼点**结算完毕**（含平局），供任意参与者的被动技使用——公共的
   * `PindianResult` 只在分出胜负时才派发，接不住简雍【纵适】这类
   * 「平局也要反应」的技能。派发时机在 `state.pindianSettlement` 已经
   * 建好、两张拼点牌仍留在处理区之后，`claimPindianCards` 在这里调用有效。
   */
  | 'PindianEnd'
  | 'Recover' | 'HpExchanged' | 'HpSet' | 'HealthColorChanged' | 'ArmorChanged'
  | 'LoseHp' | 'MaxHpChange'
  /**
   * 「一次失去装备区里的牌」，按**原子操作**计数（一次换三件只发一条）。
   * 每张一条的是 `LoseEquipment`。两个粒度都真实存在，见 engine/equipment-zone-loss.ts。
   */
  | 'EquipmentZoneLoss'
  | 'LoseEquipment' | 'EquipmentLossSettled' | 'EnterDying' | 'AskForPeach' | 'QuitDying' | 'BeforeDeath' | 'Death'
  | 'RestBegin' | 'RestEnd'
  | 'CardMove' | 'CardZoneMoved' | 'HandCardLeft' | 'LoseCard' | 'GainCard' | 'CardGiven' | 'HandSwap' | 'JudgeStart' | 'JudgeResult' | 'JudgeEnd'
  /** 武将专属牌堆的一张牌进出；不包含牌面 ID，防止把暗置信息暴露给视图层。 */
  | 'CharacterPileMoved' | 'FieldCardEntered'
  /** 弃牌堆被洗回牌堆。见 engine/deck.ts；这是唯一的洗牌痕迹，不要靠牌堆剩几张去猜。 */
  | 'DeckReshuffled'
  /** 一张牌真实进入弃牌堆，携带移动前区域和弃置/判定/其他来源。 */
  | 'CardEnteredDiscardByMove'
  /** 场上的牌（装备区 / 判定区）被直接移动到另一名角色的对应区域。见 field-move.ts。 */
  | 'FieldCardMoved'
  /** 觉醒技发动。一局一次，由 registerSkillTriggers 统一记账后发出。 */
  | 'SkillAwakened'

export interface GameEvent<TPayload = Record<string, unknown>> {
  id: string
  seq: number
  name: GameEventName
  sourceId?: PlayerId
  targetId?: PlayerId
  sourceSkillId?: string
  cardIds?: CardId[]
  phase?: TurnPhase
  damageNature?: DamageNature
  payload: TPayload
}

export interface EventContext<TPayload = Record<string, unknown>> {
  event: GameEvent<TPayload>
  cancelled: boolean
  cancel(): void
}

export type EventHandler = (context: EventContext) => void

interface RegisteredHandler {
  priority: number
  order: number
  handler: EventHandler
}

/** 仅保存可信技能处理器；牌局等待状态仍由可序列化 Request 表达。 */
export class GameEventBus {
  private handlers = new Map<GameEventName, RegisteredHandler[]>()
  private order = 0

  on(name: GameEventName, handler: EventHandler, priority = 0): () => void {
    const entry = { priority, order: this.order++, handler }
    const handlers = this.handlers.get(name) ?? []
    handlers.push(entry)
    handlers.sort((left, right) => right.priority - left.priority || left.order - right.order)
    this.handlers.set(name, handlers)
    return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== entry))
  }

  emit(event: GameEvent): EventContext {
    const context: EventContext = {
      event,
      cancelled: false,
      cancel() { context.cancelled = true },
    }
    for (const entry of this.handlers.get(event.name) ?? []) entry.handler(context)
    return context
  }
}
