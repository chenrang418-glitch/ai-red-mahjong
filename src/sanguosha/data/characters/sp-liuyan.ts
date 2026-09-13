import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { getAttackRange, getDistance } from '../../engine/distance'
import { executeUseCardAction } from '../../engine/cards/basic'
import { cardCategoryOfName } from '../../engine/damage-provenance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘焉（三国杀 OL 经典身份 SP）。
 *
 * 【图射】：使用一张非装备牌指定目标后，若当前手牌无基本牌，摸X张牌
 *          （X为这次使用的目标数量）。
 * 【立牧】：出牌阶段，可以将1张方块手牌当【乐不思蜀】对自己使用，然后
 *          回复1点体力；锁定技，若判定区有牌，对攻击范围内的角色使用牌
 *          无距离限制、无使用次数限制。
 */

const TUSHE = 'tushe'
const LIMU = 'limu'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function inRawRange(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): boolean {
  return getDistance(state, sourceId, targetId) <= getAttackRange(state, sourceId)
}

registerSkillRuntime({
  id: TUSHE,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[]; cancelled?: boolean }
      if (payload.cancelled || !payload.cardName) return
      const category = payload.cardId ? host.state.cards[payload.cardId]?.category : cardCategoryOfName(payload.cardName) ?? undefined
      if (category === 'equipment') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const hasBasic = owner.zones.hand.some((id) => host.state.cards[id]?.category === 'basic')
      if (hasBasic) return
      const x = payload.targetIds?.length ?? 0
      if (x <= 0) return
      drawCards(host.state, host.rng, ownerId, x, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      host.dispatch('SkillActivated', { skillId: TUSHE, skillName: '图射', playerId: ownerId, logText: `${owner.nickname}发动【图射】，摸${x}张牌` }, { sourceId: ownerId })
    },
  }],
})

registerSkillRuntime({
  id: LIMU,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    if (owner.zones.judgingArea.some((id) => state.cards[id]?.name === '乐不思蜀')) return []
    if (!owner.zones.hand.some((id) => state.cards[id]?.suit === 'diamond')) return []
    return [{ id: LIMU, label: '立牧：将1张方块手牌当【乐不思蜀】对自己使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== LIMU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const diamonds = owner.zones.hand.filter((id) => host.state.cards[id]?.suit === 'diamond')
    if (diamonds.length === 0) return
    host.askSkill({
      skillId: LIMU, ownerId, step: 'pick-card', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【立牧】：选择1张方块手牌当【乐不思蜀】使用', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: diamonds, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-card') return
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
    host.dispatch('SkillActivated', { skillId: LIMU, skillName: '立牧', playerId: ownerId, logText: `${owner.nickname}发动【立牧】` }, { sourceId: ownerId })
    executeUseCardAction(host as never, ownerId, {
      kind: 'use-card', id: `limu:${cardId}`, playerId: ownerId,
      cardIds: [cardId], targetIds: [ownerId], targetMin: 1, targetMax: 1,
      asCardName: '乐不思蜀', label: '【立牧】：使用【乐不思蜀】',
    })
    recover(host as never, ownerId, 1, ownerId)
  },
  ignoresDistanceTo(state, ownerId, targetId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.judgingArea.length === 0) return false
    return inRawRange(state, ownerId, targetId)
  },
  ignoresSlashUsesTo(state, ownerId, targetId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.judgingArea.length === 0) return false
    return inRawRange(state, ownerId, targetId)
  },
})

export const LIUYAN: CharacterDefinition = {
  id: 'liuyan',
  name: '刘焉',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: TUSHE, name: '图射', description: '使用一张非装备牌指定目标后，若当前手牌无基本牌，摸X张牌（X为这次使用的目标数量）。' },
    { id: LIMU, name: '立牧', description: '出牌阶段，可以将1张方块手牌当【乐不思蜀】对自己使用，然后回复1点体力；锁定技，若判定区有牌，对攻击范围内的角色使用牌无距离限制、无使用次数限制。' },
  ],
}
