import type { CardId, DamageNature, EquipmentSlot, PlayerId } from './types'

interface LegalActionBase<K extends string> {
  id: string
  kind: K
  playerId: PlayerId
  label: string
}

export type LegalAction =
  | (LegalActionBase<'pass'> & { requestId: string })
  | (LegalActionBase<'use-card'> & {
    cardIds: CardId[]
    targetIds: PlayerId[]
    targetMin: number
    targetMax: number
    asCardName: string
    sourceSkillId?: string
    /** Skill that granted this action's explicit optional extra-target choice. */
    targetExpansionSkillId?: string
    targetExpansionTargetId?: PlayerId
    nature?: DamageNature
    retainMaterial?: boolean
    retainedMaterialId?: CardId
    /** 该牌由其他角色的【好施】等公共规则临时共享。 */
    cardOwnerId?: PlayerId
    targetMode?: 'fixed'
    /**
     * 装到哪个栏。
     *
     * 只有**两个武器栏都占着**的时候才需要它：那时玩家得自己决定顶掉哪一把，
     * 引擎不替他挑。其余情况留空，按牌自己的 `equipmentSlot` 走。
     */
    equipmentSlot?: EquipmentSlot
    /** 已经挂起并续接过的出牌拦截技能；供多技能串行接管同一出牌动作。 */
    interceptedSkillKeys?: string[]
  })
  | (LegalActionBase<'respond-card'> & { cardIds: CardId[]; asCardName: string })
  | (LegalActionBase<'invoke-skill'> & { skillId: string; cardIds: CardId[]; targetIds: PlayerId[] })
  | (LegalActionBase<'choose'> & { requestId: string; value: string | number | string[] })

export function actionsForPlayer(actions: readonly LegalAction[], playerId: PlayerId): LegalAction[] {
  return actions.filter((action) => action.playerId === playerId)
}

export function findLegalAction(actions: readonly LegalAction[], playerId: PlayerId, actionId: string): LegalAction {
  const action = actions.find((candidate) => candidate.playerId === playerId && candidate.id === actionId)
  if (!action) throw new Error('操作不存在、已过期或不属于当前玩家')
  return action
}
