import type { CardId, DamageNature, PlayerId, TurnPhase } from './types'

export type GameEventName =
  | 'GameStart' | 'TurnStart' | 'TurnEnd' | 'PhaseStart' | 'PhaseEnd'
  | 'JudgePhase' | 'DrawPhase' | 'PlayPhase' | 'DiscardPhase'
  | 'BeforeCardUse' | 'CardUsed' | 'TargetSpecified' | 'TargetConfirmed' | 'CardResolved' | 'AfterCardUse'
  | 'CardResponded' | 'BeforeDamage' | 'DamageCaused' | 'DamageInflicted' | 'Damaged' | 'AfterDamage'
  | 'SkillActivated'
  | 'CharacterFlip' | 'CharacterChained'
  | 'Recover'
  | 'LoseHp' | 'MaxHpChange'
  | 'LoseEquipment' | 'EnterDying' | 'AskForPeach' | 'QuitDying' | 'BeforeDeath' | 'Death'
  | 'CardMove' | 'LoseCard' | 'GainCard' | 'HandSwap' | 'JudgeStart' | 'JudgeResult' | 'JudgeEnd'
  /** 场上的牌（装备区 / 判定区）被直接移动到另一名角色的对应区域。见 field-move.ts。 */
  | 'FieldCardMoved'

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
