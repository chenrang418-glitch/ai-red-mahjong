import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { resumeTargetDamagePrevention } from '../../engine/damage'
import { registerSkillRuntime, replaceTemporarySkills, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 赵俨（三国杀 OL 经典身份 SP）。
 *
 * 【同协】：出牌阶段开始时，赵俨可以令自己和至多两名其他角色组成"同协"，
 *          直到赵俨下一个回合开始：
 *          1. 立即检查同协成员手牌数，若唯一最少者存在，其摸1张；
 *          2. 一名同协成员使用只指定唯一目标B的杀完整结算后，其余同协
 *             成员可依次使用1张无距离限制的杀；
 *          3. 一名同协成员即将受到伤害时，另一名本回合未失去过体力的
 *             同协成员可以代为失去1点体力，防止这次伤害。
 *
 * 已知简化：代伤固定选取座次最靠前的合法人选自动代替（不逐一询问是否
 * 发动），为最小可用范围。
 */

const TONGXIE = 'tongxie'
const TONGXIE_MEMBER = 'tongxie-member'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function groupMembers(state: SanguoshaState): PlayerId[] {
  return state.tongxieGroup?.members ?? []
}

function eligibleSubstitute(state: SanguoshaState, targetId: PlayerId): PlayerId | null {
  const members = groupMembers(state)
  if (!members.includes(targetId)) return null
  for (const memberId of members) {
    if (memberId === targetId) continue
    const member = playerOf(state, memberId)
    if (!member?.alive) continue
    if (state.tongxieHpLossTurn?.[memberId] === state.turnNumber) continue
    return memberId
  }
  return null
}

registerSkillRuntime({
  id: TONGXIE,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        host.queueSkill({ skillId: TONGXIE, ownerId, step: 'ask-group', data: { candidateIds } })
      },
    },
    {
      event: 'LoseHp',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (!payload.playerId) return
        host.state.tongxieHpLossTurn ??= {}
        host.state.tongxieHpLossTurn[payload.playerId] = host.state.turnNumber
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const group = host.state.tongxieGroup
        if (group && group.formedTurn !== host.state.turnNumber) host.state.tongxieGroup = undefined
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        const members = groupMembers(host.state)
        if (!sourceId || !members.includes(sourceId)) return
        const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[]; virtual?: boolean }
        if (payload.cardName !== '杀' || payload.virtual) return
        const targetIds = payload.targetIds ?? []
        if (targetIds.length !== 1) return
        const [targetId] = targetIds
        const order = members.filter((memberId) => memberId !== sourceId && memberId !== targetId)
        if (order.length === 0) return
        host.queueSkill({ skillId: TONGXIE, ownerId, step: 'coordinate', data: { targetId, order, index: 0 } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask-group') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: TONGXIE, ownerId, step: 'ask-group', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【同协】：选择至多两名其他角色组成同协角色组', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 2,
        }),
      })
      return
    }
    if (prompt.step === 'coordinate') {
      const { targetId, order, index } = prompt.data as { targetId: PlayerId; order: PlayerId[]; index: number }
      if (index >= order.length) return
      const memberId = order[index]
      const member = playerOf(host.state, memberId)
      const target = playerOf(host.state, targetId)
      if (!member?.alive || !target?.alive) { advanceCoordinate(host, ownerId, targetId, order, index); return }
      const slashCardIds = member.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
      host.askSkill({
        skillId: TONGXIE, ownerId, step: 'coordinate', data: prompt.data,
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: memberId,
          prompt: `【同协】：是否使用一张无距离限制的杀，对${target.nickname}造成伤害？`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: slashCardIds, hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask-group') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const picked = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const members = [ownerId, ...picked.filter((id) => playerOf(host.state, id)?.alive)]
      host.state.tongxieGroup = { members, ownerId, formedTurn: host.state.turnNumber }
      for (const memberId of members) replaceTemporarySkills(host.state, memberId, TONGXIE, [TONGXIE_MEMBER])
      host.dispatch('SkillActivated', { skillId: TONGXIE, skillName: '同协', playerId: ownerId, logText: `${owner.nickname}发动【同协】` }, { sourceId: ownerId })
      let uniqueMin: PlayerId | null = null
      let minCount = Infinity
      let tie = false
      for (const memberId of members) {
        const member = playerOf(host.state, memberId)
        if (!member?.alive) continue
        const count = member.zones.hand.length
        if (count < minCount) { minCount = count; uniqueMin = memberId; tie = false } else if (count === minCount) tie = true
      }
      if (uniqueMin && !tie) drawCards(host.state, host.rng, uniqueMin, 1, (n, p) => { host.dispatch(n, p) })
      return
    }
    if (resolution.step === 'coordinate') {
      const { targetId, order, index } = resolution.data as { targetId: PlayerId; order: PlayerId[]; index: number }
      const memberId = order[index]
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const member = playerOf(host.state, memberId)
      const target = playerOf(host.state, targetId)
      if (cardId && member?.alive && target?.alive && member.zones.hand.includes(cardId)) {
        host.beginVirtualSlash({ sourceId: memberId, targetId, sourceSkillId: TONGXIE, cardId })
      }
      advanceCoordinate(host, ownerId, targetId, order, index)
    }
  },
})

function advanceCoordinate(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, order: PlayerId[], index: number): void {
  if (index + 1 < order.length) host.queueSkill({ skillId: TONGXIE, ownerId, step: 'coordinate', data: { targetId, order, index: index + 1 } })
}

registerSkillRuntime({
  id: TONGXIE_MEMBER,
  offersTargetDamagePreventionAsk(host, ownerId) {
    const substituteId = eligibleSubstitute(host.state, ownerId)
    if (!substituteId) return false
    host.queueSkill({ skillId: TONGXIE_MEMBER, ownerId, step: 'substitute', data: { substituteId } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'substitute') return
    const { substituteId } = prompt.data as { substituteId: PlayerId }
    if (!host.state.pendingTargetDamage || eligibleSubstitute(host.state, ownerId) !== substituteId) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    resumeTargetDamagePrevention(host as never, true, TONGXIE)
    loseHp(host as never, substituteId, 1, TONGXIE)
    const substitute = playerOf(host.state, substituteId)
    const owner = playerOf(host.state, ownerId)
    if (substitute && owner) {
      host.dispatch('SkillActivated', { skillId: TONGXIE, skillName: '同协', playerId: substituteId, targetId: ownerId, logText: `${substitute.nickname}代替${owner.nickname}失去1点体力` }, { sourceId: substituteId, targetId: ownerId })
    }
  },
})

export const ZHAOYAN: CharacterDefinition = {
  id: 'zhaoyan',
  name: '赵俨',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: TONGXIE, name: '同协', description: '出牌阶段开始时，你可以令自己和至多两名其他角色组成"同协"，直到你下一回合开始：唯一手牌最少的同协成员摸1张；同协成员使用只指定唯一目标的杀完整结算后，其余同协成员可依次使用1张无距离限制的杀；一名同协成员即将受到伤害时，另一名本回合未失去过体力的同协成员可代为失去1点体力防止这次伤害。' },
  ],
}
