import { moveCard } from '../../engine/zones'
import { loseMaxHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 李傕（三国杀 OL 经典身份 SP）。
 *
 * 【狼袭】：准备阶段，李傕可以选择一名体力值不大于自己的其他角色，对其
 *          随机造成0/1/2点伤害。
 * 【亦算】：出牌阶段限一次，当李傕本阶段使用的一张锦囊牌真正进入弃牌堆
 *          后，李傕可以失去1点体力上限，然后获得这张牌。
 *
 * 亦算在 `AfterCardUse` 时点检查「这张具体的 cardId 现在是不是还躺在
 * 弃牌堆里」——如果结算途中被别的技能（比如某个「结算后获得此牌」的
 * 效果）抢先拿走，这里天然就不会再拿一遍，不需要额外判重。
 */

const LANGXI = 'langxi'
const YISUAN = 'yisuan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: LANGXI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.hp <= owner.hp).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: LANGXI, ownerId, step: 'target', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    if (!playerOf(host.state, ownerId)?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: LANGXI, ownerId, step: 'target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【狼袭】：选择一名体力值不大于自己的角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    const amount = host.rng.nextInt(3)
    host.dispatch('SkillActivated', { skillId: LANGXI, skillName: '狼袭', playerId: ownerId, targetId, logText: `${owner.nickname}发动【狼袭】，判定为${amount}点伤害` }, { sourceId: ownerId, targetId })
    if (amount > 0) resolveDamage(host as never, { sourceId: ownerId, targetId, amount, nature: 'normal', cardName: null })
  },
})

registerSkillRuntime({
  id: YISUAN,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      if (context.event.sourceId !== ownerId || payload.cancelled || !payload.cardId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.turnUsedSkills.includes(YISUAN)) return
      if (host.state.cards[payload.cardId]?.category !== 'trick') return
      if (!host.state.zones.discardPile.includes(payload.cardId)) return
      host.queueSkill({ skillId: YISUAN, ownerId, step: 'ask', data: { cardId: payload.cardId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const { cardId } = prompt.data as { cardId: CardId }
    if (!owner?.alive || owner.turnUsedSkills.includes(YISUAN) || !host.state.zones.discardPile.includes(cardId)) return
    host.askSkill({
      skillId: YISUAN, ownerId, step: 'ask', data: { cardId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【亦算】：是否失去1点体力上限，获得这张牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    const { cardId } = resolution.data as { cardId: CardId }
    if (!owner?.alive || owner.turnUsedSkills.includes(YISUAN) || !host.state.zones.discardPile.includes(cardId)) return
    owner.turnUsedSkills.push(YISUAN)
    loseMaxHp(host as never, ownerId, 1, YISUAN)
    if (!playerOf(host.state, ownerId)?.alive) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: YISUAN }, { targetId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: YISUAN, skillName: '亦算', playerId: ownerId, logText: `${owner.nickname}发动【亦算】` }, { sourceId: ownerId })
  },
})

export const LIJUE: CharacterDefinition = {
  id: 'lijue',
  name: '李傕',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 6,
  pack: 'sp',
  skills: [
    { id: LANGXI, name: '狼袭', description: '准备阶段，李傕可以选择一名体力值不大于自己的其他角色，对其随机造成0/1/2点伤害。' },
    { id: YISUAN, name: '亦算', description: '出牌阶段限一次，当李傕本阶段使用的一张锦囊牌真正进入弃牌堆后，李傕可以失去1点体力上限，然后获得这张牌。' },
  ],
}
