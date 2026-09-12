import { movePickedCard } from '../../engine/card-pick'
import { canTarget, getAttackRange } from '../../engine/distance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 潘璋马忠（一将成名 2013）。
 *
 * 【夺刀】：潘璋马忠受到【杀】造成的伤害后，可以弃置一张牌，然后获得伤害
 *          来源装备区里的武器牌。
 * 【暗箭】：潘璋马忠使用【杀】对目标造成伤害时，若潘璋马忠不在该目标的
 *          攻击范围内，则此伤害 +1。
 *
 * 两处最容易做错的：
 *
 * 1. **暗箭查的方向是「目标→潘璋马忠」**：用目标自己的攻击范围反过来判断
 *    潘璋马忠在不在里面，不是用潘璋马忠的攻击范围去看目标。
 * 2. **夺刀先付代价再拿武器**：弃置一张牌是成本，拿到的武器进潘璋马忠
 *    的手牌，不自动装备；来源的武器离场要走 `handleEquipmentLost`
 *    （白银狮子回血、枭姬这类效果要照常触发），`movePickedCard` 已经处理好。
 */

const DUODAO = 'duodao'
const ANJIAN = 'anjian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: DUODAO,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const payload = context.event.payload as { cardName?: string }
      if (payload.cardName !== '杀') return
      const sourceId = context.event.sourceId as PlayerId | undefined
      if (!sourceId) return
      const source = playerOf(host.state, sourceId)
      if (!source?.alive || !source.zones.equipment.weapon) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      host.queueSkill({ skillId: DUODAO, ownerId, step: 'ask', data: { sourceId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const sourceId = prompt.data.sourceId as PlayerId
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || owner.zones.hand.length === 0 || !source?.alive || !source.zones.equipment.weapon) return
    host.askSkill({
      skillId: DUODAO, ownerId, step: 'cost', data: { sourceId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【夺刀】：弃置一张牌，获得伤害来源装备区里的武器牌？',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [],
        min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'cost') return
    const owner = playerOf(host.state, ownerId)
    const sourceId = resolution.data.sourceId as PlayerId
    const source = playerOf(host.state, sourceId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner?.alive || !owner.zones.hand.includes(cardId)) return
    const weaponId = source?.alive ? source.zones.equipment.weapon : null
    if (!weaponId) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: DUODAO }, { targetId: ownerId, cardIds: [cardId] })
    if (movePickedCard(host as never, sourceId, weaponId, { kind: 'hand', playerId: ownerId })) {
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [weaponId], reason: DUODAO }, { targetId: ownerId, cardIds: [weaponId] })
      host.dispatch('SkillActivated', {
        skillId: DUODAO, skillName: '夺刀', playerId: ownerId, targetId: sourceId,
        logText: `${owner.nickname}发动【夺刀】，获得${source?.nickname ?? ''}的武器牌`,
      }, { sourceId: ownerId, targetId: sourceId })
    }
  },
})

registerSkillRuntime({
  id: ANJIAN,
  outgoingDamage(state, ownerId, context) {
    if (context.cardName !== '杀') return null
    // 方向是「目标→潘璋马忠」，不是反过来
    if (canTarget(state, context.targetId, ownerId, getAttackRange(state, context.targetId))) return null
    return { amount: context.amount + 1 }
  },
})

export const PANZHANG_MAZHONG: CharacterDefinition = {
  id: 'panzhangmazhong',
  name: '潘璋马忠',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2013',
  skills: [
    {
      id: DUODAO,
      name: '夺刀',
      description: '潘璋马忠受到【杀】造成的伤害后，可以弃置一张牌，然后获得伤害来源装备区里的武器牌。',
    },
    {
      id: ANJIAN,
      name: '暗箭',
      description: '潘璋马忠使用【杀】对目标造成伤害时，若潘璋马忠不在该目标的攻击范围内，则此伤害 +1。',
    },
  ],
}
