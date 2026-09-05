import type { CardId, DamageNature, PlayerId, TurnPhase } from './types'

export type GameEventName =
  | 'GameStart' | 'PlayBegin' | 'TurnStart' | 'TurnEnd' | 'PhaseStart' | 'PhaseEnd'
  | 'JudgePhase' | 'DrawPhase' | 'PlayPhase' | 'DiscardPhase'
  | 'BeforeCardUse' | 'CardUsed' | 'TargetSpecified' | 'TargetConfirmed' | 'CardResolved' | 'AfterCardUse'
  | 'CardResponded' | 'BeforeDamage' | 'DamageCaused' | 'DamageInflicted' | 'Damaged' | 'AfterDamage'
  | 'SkillActivated'
  | 'CharacterFlip' | 'CharacterChained'
  /**
   * 拼点 / 决斗的**胜负结果**。
   *
   * 神张辽【止啼】要的是「你赢时」，不能拿「最后一次伤害的来源是他」凑：
   * 决斗里对方可能被别的效果打死，拼点更是根本不产生伤害。
   * 平局不派发 `PindianResult`——平局不算赢。
   */
  | 'PindianResult' | 'DuelResult'
  | 'Recover'
  | 'LoseHp' | 'MaxHpChange'
  | 'LoseEquipment' | 'EnterDying' | 'AskForPeach' | 'QuitDying' | 'BeforeDeath' | 'Death'
  | 'CardMove' | 'LoseCard' | 'GainCard' | 'HandSwap' | 'JudgeStart' | 'JudgeResult' | 'JudgeEnd'
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
