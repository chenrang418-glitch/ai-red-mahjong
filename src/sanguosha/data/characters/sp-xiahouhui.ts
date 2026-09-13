import { moveCard } from '../../engine/zones'
import { startPindian, registerPindianContinuation } from '../../engine/pindian'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 夏侯徽（三国杀 OL 经典身份 SP）。
 *
 * 【宝箧】：锁定技，游戏开始时从牌堆/弃牌堆获得1张装备牌（项目无独立
 *          "宝物"类别，用任意装备牌代替），可以立即使用之。
 * 【宜室】：每个 TurnInstance 限一次，其他角色A在其自己的出牌阶段因弃置
 *          失去手牌后，夏侯徽可以从这次弃置进入弃牌堆的牌中选1张给A，
 *          剩余仍在弃牌堆的牌归夏侯徽。
 * 【识度】：出牌阶段限一次，与一名有手牌的其他角色拼点，若夏侯徽赢，获得
 *          其所有手牌，然后交给其floor(夏侯徽当前手牌数/2)张牌。
 */

const BAOQIE = 'baoqie'
const YISHI = 'yishi'
const SHIDU = 'shidu'
const SHIDU_TAG = 'shidu-pindian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: BAOQIE,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = [...host.state.zones.drawPile, ...host.state.zones.discardPile].filter((id) => host.state.cards[id]?.category === 'equipment')
    if (candidates.length === 0) return
    const cardId = candidates[host.rng.nextInt(candidates.length)]
    const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
    moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: BAOQIE }, { targetId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: BAOQIE, skillName: '宝箧', playerId: ownerId, logText: `${owner.nickname}发动【宝箧】，获得【${host.state.cards[cardId]?.name}】` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: YISHI,
  triggers: [{
    event: 'LoseCard',
    handle(host, ownerId, context) {
      // LoseCard 的 reason 大多是各技能自己的 skillId（弃置成本），不是字面的
      // 'discard'——那个值只用在弃牌阶段的账本上，这里不按 reason 过滤。
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      const targetId = payload.playerId
      if (!targetId || targetId === ownerId) return
      if (host.state.phase !== 'play' || host.state.currentPlayerId !== targetId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.turnUsedSkills.includes(YISHI)) return
      const cardIds = (payload.cardIds ?? []).filter((id) => host.state.zones.discardPile.includes(id))
      if (cardIds.length === 0) return
      owner.turnUsedSkills.push(YISHI)
      host.queueSkill({ skillId: YISHI, ownerId, step: 'pick', data: { targetId, cardIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const { cardIds } = prompt.data as { targetId: PlayerId; cardIds: CardId[] }
    const remaining = cardIds.filter((id) => host.state.zones.discardPile.includes(id))
    if (remaining.length === 0) return
    host.askSkill({
      skillId: YISHI, ownerId, step: 'pick', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【宜室】：选择1张牌给对方，其余归你', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: remaining, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const { targetId, cardIds } = resolution.data as { targetId: PlayerId; cardIds: CardId[] }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const [givenId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !target?.alive || !givenId || !host.state.zones.discardPile.includes(givenId)) return
    host.dispatch('SkillActivated', { skillId: YISHI, skillName: '宜室', playerId: ownerId, logText: `${owner.nickname}发动【宜室】` }, { sourceId: ownerId, targetId })
    moveCard(host.state, givenId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [givenId], reason: YISHI }, { targetId, cardIds: [givenId] })
    const rest = cardIds.filter((id) => id !== givenId && host.state.zones.discardPile.includes(id))
    for (const cardId of rest) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    if (rest.length > 0) host.dispatch('GainCard', { playerId: ownerId, cardIds: rest, reason: YISHI }, { targetId: ownerId, cardIds: rest })
  },
})

registerSkillRuntime({
  id: SHIDU,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(SHIDU)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)) return []
    return [{ id: SHIDU, label: '识度：与一名角色拼点' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== SHIDU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(SHIDU)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(SHIDU)
    host.askSkill({
      skillId: SHIDU, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【识度】：选择一名角色拼点', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    startPindian(host as never, { id: `shidu-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId, reason: SHIDU, continuationTag: SHIDU_TAG, timeoutMs: 20_000 })
  },
})

registerPindianContinuation(SHIDU_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  if (result.outcome !== 'initiator-win') return
  const ownerId = result.initiatorId
  const targetId = result.opponentId
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive || target.zones.hand.length === 0) return
  const cardIds = [...target.zones.hand]
  for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
  host.dispatch('GainCard', { playerId: ownerId, cardIds, reason: SHIDU }, { sourceId: targetId, targetId: ownerId, cardIds })
  host.dispatch('SkillActivated', { skillId: SHIDU, skillName: '识度', playerId: ownerId, logText: `${owner.nickname}发动【识度】，获得${target.nickname}所有手牌` }, { sourceId: ownerId, targetId })
  const n = Math.floor(owner.zones.hand.length / 2)
  if (n <= 0) return
  const giveIds = owner.zones.hand.slice(0, n)
  for (const cardId of giveIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
  skillHost.dispatch('GainCard', { playerId: targetId, cardIds: giveIds, reason: SHIDU }, { sourceId: ownerId, targetId, cardIds: giveIds })
})

export const XIAHOUHUI: CharacterDefinition = {
  id: 'xiahouhui',
  name: '夏侯徽',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: BAOQIE, name: '宝箧', description: '锁定技，游戏开始时从牌堆/弃牌堆获得1张装备牌，可以立即使用之。' },
    { id: YISHI, name: '宜室', description: '每个 TurnInstance 限一次，其他角色在其自己的出牌阶段因弃置失去手牌后，你可以从中选1张给其，其余归你。' },
    { id: SHIDU, name: '识度', description: '出牌阶段限一次，与一名有手牌的其他角色拼点，若你赢，获得其所有手牌，然后交给其floor(你当前手牌数/2)张牌。' },
  ],
}
