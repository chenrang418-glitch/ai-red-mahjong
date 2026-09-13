import { moveCard } from '../../engine/zones'
import { setChained } from '../../engine/character-state'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 蔡瑁（三国杀 OL 经典身份 SP）。
 *
 * 【佐练】：出牌阶段限一次，X=蔡瑁当前体力值，选择至多X名（至少1名）有
 *          手牌的角色，随机展示其各1张手牌（服务器种子随机）；对每张展示
 *          的牌，蔡瑁可以选择将其与牌堆/弃牌堆中的一张属性【杀】交换。
 * 【精舟】：受到伤害后，X=当前体力值，选择至多X名角色，切换其连环状态。
 */

const ZUOLIAN = 'zuolian'
const JINGZHOU = 'jingzhou'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function attributeSlashesIn(state: SanguoshaState, zone: 'drawPile' | 'discardPile'): CardId[] {
  return state.zones[zone].filter((cardId) => {
    const card = state.cards[cardId]
    return card && card.name === '杀' && (card.damageNature === 'fire' || card.damageNature === 'thunder')
  })
}

registerSkillRuntime({
  id: ZUOLIAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(ZUOLIAN)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.zones.hand.length > 0)) return []
    return [{ id: ZUOLIAN, label: '佐练：随机展示至多X名角色各1张手牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZUOLIAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(ZUOLIAN)) return
    const x = Math.max(0, owner.hp)
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0 || x === 0) return
    owner.turnUsedSkills.push(ZUOLIAN)
    host.askSkill({
      skillId: ZUOLIAN, ownerId, step: 'pick-targets', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【佐练】：选择至多${x}名有手牌的角色`, timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: Math.min(x, candidateIds.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-targets') {
      const targetIds = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? []).filter((id) => playerOf(host.state, id)?.alive && (playerOf(host.state, id)?.zones.hand.length ?? 0) > 0)
      if (targetIds.length === 0) return
      host.dispatch('SkillActivated', { skillId: ZUOLIAN, skillName: '佐练', playerId: ownerId, logText: `${owner.nickname}发动【佐练】` }, { sourceId: ownerId })
      const revealed: Array<{ playerId: PlayerId; cardId: CardId }> = []
      for (const targetId of targetIds) {
        const target = playerOf(host.state, targetId)
        if (!target?.alive || target.zones.hand.length === 0) continue
        const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
        revealed.push({ playerId: targetId, cardId })
      }
      if (revealed.length === 0) return
      host.dispatch('CardMove', { cardIds: revealed.map((entry) => entry.cardId), reason: ZUOLIAN, revealed: true }, { sourceId: ownerId })
      askSwap(host, ownerId, revealed, 0)
      return
    }

    if (resolution.step === 'swap-ask') {
      const { revealed, index } = resolution.data as { revealed: Array<{ playerId: PlayerId; cardId: CardId }>; index: number }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId && optionId !== 'skip') {
        const [zone, slashCardId] = optionId.split(':') as ['drawPile' | 'discardPile', CardId]
        const entry = revealed[index]
        const target = playerOf(host.state, entry.playerId)
        if (target?.alive && target.zones.hand.includes(entry.cardId) && host.state.zones[zone].includes(slashCardId)) {
          moveCard(host.state, slashCardId, { kind: zone }, { kind: 'hand', playerId: entry.playerId })
          // 换出的牌放回同一堆顶端，牌堆位置真实归位，不是随手塞底
          moveCard(host.state, entry.cardId, { kind: 'hand', playerId: entry.playerId }, { kind: zone }, { toTop: true })
          host.dispatch('SkillActivated', { skillId: ZUOLIAN, skillName: '佐练', playerId: ownerId, logText: `${owner.nickname}发动【佐练】，为${target.nickname}换入属性【杀】` }, { sourceId: ownerId, targetId: entry.playerId })
        }
      }
      askSwap(host, ownerId, revealed, index + 1)
    }
  },
})

function askSwap(host: SkillHost, ownerId: PlayerId, revealed: Array<{ playerId: PlayerId; cardId: CardId }>, index: number): void {
  if (index >= revealed.length) return
  const options = [
    ...attributeSlashesIn(host.state, 'drawPile').map((id) => ({ id: `drawPile:${id}`, label: `牌堆顶属性杀` })),
    ...attributeSlashesIn(host.state, 'discardPile').map((id) => ({ id: `discardPile:${id}`, label: `弃牌堆属性杀` })),
  ]
  if (options.length === 0) { askSwap(host, ownerId, revealed, index + 1); return }
  options.push({ id: 'skip', label: '不交换' })
  host.askSkill({
    skillId: ZUOLIAN, ownerId, step: 'swap-ask', data: { revealed, index },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【佐练】：是否将展示的牌与一张属性【杀】交换？', timeoutMs: 20_000, optional: true, options,
    }),
  })
}

registerSkillRuntime({
  id: JINGZHOU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const x = Math.max(0, owner.hp)
      if (x === 0) return
      host.queueSkill({ skillId: JINGZHOU, ownerId, step: 'pick-targets', data: { x } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-targets') return
    const { x } = prompt.data as { x: number }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: JINGZHOU, ownerId, step: 'pick-targets', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【精舟】：选择至多${x}名角色，切换连环状态`, timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: Math.min(x, candidateIds.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-targets') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (targetIds.length === 0) return
    for (const targetId of targetIds) {
      const target = playerOf(host.state, targetId)
      if (target?.alive) setChained(host as never, targetId, JINGZHOU)
    }
    host.dispatch('SkillActivated', { skillId: JINGZHOU, skillName: '精舟', playerId: ownerId, logText: `${owner.nickname}发动【精舟】，切换连环状态` }, { sourceId: ownerId })
  },
})

export const CAIMAO: CharacterDefinition = {
  id: 'caimao',
  name: '蔡瑁',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: ZUOLIAN, name: '佐练', description: '出牌阶段限一次，X=你当前体力值，选择至多X名有手牌的角色，随机展示其各1张手牌，可以将展示的牌与牌堆/弃牌堆中的一张属性【杀】交换。' },
    { id: JINGZHOU, name: '精舟', description: '受到伤害后，X=你当前体力值，选择至多X名角色，切换其连环状态。' },
  ],
}
