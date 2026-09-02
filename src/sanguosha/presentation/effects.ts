import type { PresentationEvent } from '../engine/presentation'

export type SeatPresentationEffect = 'damage' | 'recover' | 'dodge' | 'skill' | 'skill-target'

/** 把公开事件映射到座位表现；来源和承受者的语义不可混用。 */
export function seatEffectFor(event: PresentationEvent | null, playerId: string): SeatPresentationEffect | null {
  if (!event) return null
  const targeted = event.targetIds?.includes(playerId) ?? false
  if ((event.kind === 'damage' || event.kind === 'lose-hp') && targeted) return 'damage'
  if (event.kind === 'recover' && targeted) return 'recover'
  if (event.kind === 'card-response' && event.cardName === '闪' && event.sourceId === playerId) return 'dodge'
  if (event.kind === 'skill') {
    if (event.sourceId === playerId) return 'skill'
    if (targeted) return 'skill-target'
  }
  return null
}

export function effectOwnerIds(event: PresentationEvent | null): string[] {
  if (!event) return []
  if (['damage', 'lose-hp', 'recover', 'dying', 'death'].includes(event.kind)) return event.targetIds ?? []
  if (event.kind === 'card-response' || event.kind === 'skill') return event.sourceId ? [event.sourceId] : []
  if (event.kind === 'judge') return event.targetIds?.slice(0, 1) ?? []
  if (event.kind === 'card-use' && event.cardName === '无懈可击') return event.sourceId ? [event.sourceId] : []
  return []
}

/** 三个及以上目标改用全座位高亮，避免满屏箭头。 */
export function directedTargets(event: PresentationEvent | null): string[] {
  if (!event?.sourceId) return []
  const targets = event.targetIds?.filter((id) => id !== event.sourceId) ?? []
  return targets.length <= 2 ? targets : []
}
