import { movePickedCard } from '../../engine/card-pick'
import { drawCards } from '../../engine/draw'
import { getDistance } from '../../engine/distance'
import { effectiveKingdomOf } from '../../engine/huashen'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孙休（一将成名 2015）。
 *
 * 【宴诛】：出牌阶段限一次，选择一名其他角色（手牌或装备区至少有一张牌），
 *          目标选择：交给孙休装备区所有装备牌，然后孙休永久失去【宴诛】；
 *          或弃置一张牌。
 * 【兴学】：结束阶段开始时，孙休可以选择至多 X 名角色（X 为当前体力值，若
 *          已永久失去【宴诛】则改为体力上限），被选角色依次摸一张牌，然后
 *          将手牌中一张置于牌堆顶。
 * 【诏缚】：主公技，锁定技，只有孙休担任主公时生效，与孙休距离为 1 的角色
 *          视为处于所有其他吴势力角色的攻击范围内。
 *
 * 两处最容易做错的：
 *
 * 1. **宴诛 A 分支是装备交到孙休手牌**，不是自动装备；即使目标装备区为空
 *    也按实际 0 张处理，孙休照样永久失去这个技能。
 * 2. **诏缚是动态覆盖，不建立常驻状态**：新增的 `globalIgnoresDistanceTo`
 *    钩子在查距离的那一刻现算，孙休不在主公位或距离变化都立刻反映。
 */

const YANZHU = 'yanzhu'
const XINGXUE = 'xingxue'
const ZHAOFU = 'zhaofu'
const LOST_MARK = 'yanzhu-lost'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function yanzhuTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId
      && (candidate.zones.hand.length > 0 || Object.values(candidate.zones.equipment).some(Boolean)))
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: YANZHU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (!owner?.alive || (owner.marks[LOST_MARK] ?? 0) > 0) return []
    if (owner.marks['yanzhu-used-turn'] === state.turnNumber) return []
    if (yanzhuTargets(state, ownerId).length === 0) return []
    return [{ id: YANZHU, label: '宴诛：选择一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== YANZHU) return
    const candidateIds = yanzhuTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: YANZHU, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【宴诛】：选择一名其他角色',
        timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      owner.marks['yanzhu-used-turn'] = host.state.turnNumber
      const hasNonEquipmentDiscard = target.zones.hand.length > 0 || Object.values(target.zones.equipment).some(Boolean)
      host.askSkill({
        skillId: YANZHU, ownerId, step: 'choice', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId!,
          prompt: `${owner.nickname}发动【宴诛】：选择一项`,
          timeoutMs: 20_000, optional: false,
          options: [
            { id: 'give', label: `交给${owner.nickname}装备区所有装备牌，然后${owner.nickname}永久失去【宴诛】` },
            ...(hasNonEquipmentDiscard ? [{ id: 'discard', label: '弃置一张牌' }] : []),
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!owner?.alive || !target?.alive) return
      if (optionId === 'discard') {
        const pool = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
        host.askSkill({
          skillId: YANZHU, ownerId, step: 'discard-pick', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: '【宴诛】：弃置一张牌',
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: pool, hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      const cardIds = Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
      for (const cardId of cardIds) {
        movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })
      }
      if (cardIds.length > 0) host.dispatch('GainCard', { playerId: ownerId, cardIds, reason: YANZHU }, { sourceId: targetId, targetId: ownerId, cardIds })
      owner.marks[LOST_MARK] = 1
      host.dispatch('SkillActivated', {
        skillId: YANZHU, skillName: '宴诛', playerId: ownerId, targetId, cardIds,
        logText: `${target.nickname}交给${owner.nickname} ${cardIds.length} 张装备牌，${owner.nickname}永久失去【宴诛】`,
      }, { sourceId: ownerId, targetId, cardIds })
      return
    }

    if (resolution.step === 'discard-pick') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId) return
      movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: YANZHU }, { targetId, cardIds: [cardId] })
    }
  },
})

registerSkillRuntime({
  id: XINGXUE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const x = (owner.marks[LOST_MARK] ?? 0) > 0 ? owner.maxHp : owner.hp
      if (x <= 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: XINGXUE, ownerId, step: 'target', data: { x, candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const { x, candidateIds } = prompt.data as { x: number; candidateIds: PlayerId[] }
    host.askSkill({
      skillId: XINGXUE, ownerId, step: 'target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【兴学】：选择至多 ${x} 名角色`,
        timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: Math.min(x, candidateIds.length),
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
    if (targetIds.length === 0) return
    host.dispatch('SkillActivated', {
      skillId: XINGXUE, skillName: '兴学', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【兴学】`,
    }, { sourceId: ownerId })
    resolveXingxue(host, ownerId, targetIds, 0)
  },
})

function resolveXingxue(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number): void {
  if (index >= targetIds.length) return
  const targetId = targetIds[index]
  const target = playerOf(host.state, targetId)
  if (!target?.alive) { resolveXingxue(host, ownerId, targetIds, index + 1); return }
  drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
  const current = playerOf(host.state, targetId)
  if (!current?.alive || current.zones.hand.length === 0) { resolveXingxue(host, ownerId, targetIds, index + 1); return }
  host.askSkill({
    skillId: XINGXUE, ownerId, step: 'top', data: { targetIds, index },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: targetId,
      prompt: '【兴学】：选择一张手牌置于牌堆顶',
      timeoutMs: 20_000, optional: false, purpose: 'skill',
      cardIds: [...current.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: `${XINGXUE}-top`,
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'top') return
    const { targetIds, index } = resolution.data as { targetIds: PlayerId[]; index: number }
    const targetId = targetIds[index]
    const target = playerOf(host.state, targetId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (target?.alive && cardId && target.zones.hand.includes(cardId)) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'drawPile' }, { toTop: true })
    }
    resolveXingxue(host, ownerId, targetIds, index + 1)
  },
})

registerSkillRuntime({
  id: ZHAOFU,
  lord: true,
  globalIgnoresDistanceTo(state, ownerId, attackerId, targetId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.identity !== 'lord') return false
    if (attackerId === targetId || attackerId === ownerId) return false
    const attacker = playerOf(state, attackerId)
    const target = playerOf(state, targetId)
    if (!attacker?.alive || !target?.alive || effectiveKingdomOf(state, attackerId) !== 'wu') return false
    return getDistance(state, ownerId, targetId) === 1
  },
})

export const SUNXIU: CharacterDefinition = {
  id: 'sunxiu',
  name: '孙休',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2015',
  skills: [
    {
      id: YANZHU,
      name: '宴诛',
      description: '出牌阶段限一次，选择一名其他角色（手牌或装备区至少有一张牌），目标选择：交给孙休装备区所有装备牌，然后孙休永久失去【宴诛】；或弃置一张牌。',
    },
    {
      id: XINGXUE,
      name: '兴学',
      description: '结束阶段开始时，孙休可以选择至多 X 名角色（X 为当前体力值，若已永久失去【宴诛】则改为体力上限），被选角色依次摸一张牌，然后将手牌中一张置于牌堆顶。',
    },
    {
      id: ZHAOFU,
      name: '诏缚',
      description: '主公技，锁定技，只有孙休担任主公时生效，与孙休距离为 1 的角色视为处于所有其他吴势力角色的攻击范围内。',
    },
  ],
}
