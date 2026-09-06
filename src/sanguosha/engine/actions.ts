import type { CardId, EquipmentSlot, PlayerId } from './types'

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
    targetMode?: 'fixed'
    /**
     * 装到哪个栏。
     *
     * 只有**两个武器栏都占着**的时候才需要它：那时玩家得自己决定顶掉哪一把，
     * 引擎不替他挑。其余情况留空，按牌自己的 `equipmentSlot` 走。
     */
    equipmentSlot?: EquipmentSlot
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
