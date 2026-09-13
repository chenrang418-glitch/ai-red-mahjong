import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { resolveDamage } from '../../engine/damage'
import { setChained } from '../../engine/character-state'
import { getSeatDistance } from '../../engine/distance'
import { grantSkill } from '../../engine/skills/runtime'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 赵忠（三国杀 OL 经典身份 SP）。
 *
 * 【朋比】：自己首个真正 Turn 开始时执行一次，自己永久获得【隐天】或【蔽日】
 *          之一，可以选择一名其他角色永久获得另一个（动态技能授予）。
 * 【隐天】：锁定技，每个 TurnInstance 第一次有任意角色回复体力成功后，拥有
 *          隐天的角色获得"下一次造成伤害 +1"（不叠加），走 damage.ts 里
 *          新增的一条最小判定（无通用钩子）。
 * 【蔽日】：锁定技，每个 TurnInstance 第一次有任意角色不因摸牌而获得牌后，
 *          拥有蔽日的角色摸1张牌。
 * 【抵慈】：出牌阶段限一次，选择一名角色A，A交给赵忠1张手牌，然后回复1点
 *          体力，解除连环，其相邻角色全部进入连环；A下一次由未连环变为
 *          连环后，选择交给赵忠1张手牌或受到赵忠1点雷电伤害。
 */

const PENGBI = 'pengbi'
const YINTIAN = 'yintian'
const BIRI = 'biri'
const DICI = 'dici'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: PENGBI,
  triggers: [{
    event: 'TurnStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.marks[PENGBI + '-done']) return
      owner.marks[PENGBI + '-done'] = 1
      host.queueSkill({ skillId: PENGBI, ownerId, step: 'self-pick', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'self-pick') return
    host.askSkill({
      skillId: PENGBI, ownerId, step: 'self-pick', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【朋比】：自己永久获得哪个技能？', timeoutMs: 20_000, optional: false,
        options: [{ id: YINTIAN, label: '隐天' }, { id: BIRI, label: '蔽日' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'self-pick') {
      const picked = (response.payload as { optionId?: string }).optionId
      if (picked !== YINTIAN && picked !== BIRI) return
      grantSkill(host.state, ownerId, picked)
      const other = picked === YINTIAN ? BIRI : YINTIAN
      host.dispatch('SkillActivated', { skillId: PENGBI, skillName: '朋比', playerId: ownerId, logText: `${owner.nickname}发动【朋比】，自己获得【${picked === YINTIAN ? '隐天' : '蔽日'}】` }, { sourceId: ownerId })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: PENGBI, ownerId, step: 'grant-other', data: { other },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【朋比】：选择一名角色永久获得【${other === YINTIAN ? '隐天' : '蔽日'}】`, timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'grant-other') {
      const { other } = resolution.data as { other: string }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      grantSkill(host.state, targetId, other)
      host.dispatch('SkillActivated', { skillId: PENGBI, skillName: '朋比', playerId: ownerId, logText: `${owner.nickname}发动【朋比】，令${target.nickname}获得【${other === YINTIAN ? '隐天' : '蔽日'}】` }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: YINTIAN,
  triggers: [{
    event: 'Recover',
    handle(host, ownerId, _context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const armedTurn = owner.marks[YINTIAN + '-armed']
      if (armedTurn === host.state.turnNumber) return
      owner.marks[YINTIAN + '-armed'] = host.state.turnNumber
      owner.marks.zhaozhongYintianPending = 1
      host.dispatch('SkillActivated', { skillId: YINTIAN, skillName: '隐天', playerId: ownerId, logText: `${owner.nickname}发动【隐天】，下一次造成的伤害+1` }, { sourceId: ownerId })
    },
  }],
})

registerSkillRuntime({
  id: BIRI,
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { reason?: string }
      if (payload.reason === 'draw') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const armedTurn = owner.marks[BIRI + '-armed']
      if (armedTurn === host.state.turnNumber) return
      owner.marks[BIRI + '-armed'] = host.state.turnNumber
      drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      host.dispatch('SkillActivated', { skillId: BIRI, skillName: '蔽日', playerId: ownerId, logText: `${owner.nickname}发动【蔽日】，摸1张牌` }, { sourceId: ownerId })
    },
  }],
})

registerSkillRuntime({
  id: DICI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DICI)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)) return []
    return [{ id: DICI, label: '抵慈：选择一名角色，令其交给你1张手牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== DICI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DICI)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(DICI)
    host.askSkill({
      skillId: DICI, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【抵慈】：选择一名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      host.askSkill({
        skillId: DICI, ownerId, step: 'give-card', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【抵慈】：交给赵忠1张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give-card') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (target?.alive && cardId && target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: DICI }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
      if (target?.alive) {
        recover(host as never, targetId, 1, ownerId)
        setChained(host as never, targetId, DICI, false)
        const neighbors = host.state.players.filter((candidate) => candidate.alive && candidate.id !== targetId && getSeatDistance(host.state, targetId, candidate.id) === 1)
        for (const neighbor of neighbors) setChained(host as never, neighbor.id, DICI, true)
        host.state.zhaozhongDiciPending = { ownerId, targetId }
      }
      host.dispatch('SkillActivated', { skillId: DICI, skillName: '抵慈', playerId: ownerId, logText: `${owner.nickname}发动【抵慈】` }, { sourceId: ownerId, targetId: target?.id })
      return
    }

    if (resolution.step === 'reconnect-choice') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!target?.alive) return
      if (optionId === 'give' && target.zones.hand.length > 0) {
        host.askSkill({
          skillId: DICI, ownerId, step: 'reconnect-give', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: '【抵慈】：交给赵忠1张手牌', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'thunder', cardName: null })
      return
    }

    if (resolution.step === 'reconnect-give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (target?.alive && cardId && target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: DICI }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
    }
  },
  triggers: [{
    event: 'CharacterChained',
    handle(host, ownerId, context) {
      const pending = host.state.zhaozhongDiciPending
      if (!pending || pending.ownerId !== ownerId) return
      const payload = context.event.payload as { playerId?: PlayerId; chained?: boolean }
      if (payload.playerId !== pending.targetId || !payload.chained) return
      host.state.zhaozhongDiciPending = undefined
      host.queueSkill({ skillId: DICI, ownerId, step: 'reconnect-ask', data: { targetId: pending.targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'reconnect-ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    host.askSkill({
      skillId: DICI, ownerId, step: 'reconnect-choice', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: targetId,
        prompt: '【抵慈】：交给赵忠1张手牌，或受到1点雷电伤害', timeoutMs: 20_000, optional: false,
        options: [{ id: 'give', label: '交给赵忠1张手牌' }, { id: 'damage', label: '受到1点雷电伤害' }],
      }),
    })
  },
})

export const ZHAOZHONG: CharacterDefinition = {
  id: 'zhaozhong',
  name: '赵忠',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: PENGBI, name: '朋比', description: '自己首个真正回合开始时，自己永久获得【隐天】或【蔽日】之一，可以选择一名其他角色永久获得另一个。' },
    { id: YINTIAN, name: '隐天', description: '锁定技，每个 TurnInstance 第一次有任意角色回复体力成功后，你获得"下一次造成的伤害+1"（不叠加）。' },
    { id: BIRI, name: '蔽日', description: '锁定技，每个 TurnInstance 第一次有任意角色不因摸牌而获得牌后，你摸1张牌。' },
    { id: DICI, name: '抵慈', description: '出牌阶段限一次，选择一名角色，其交给你1张手牌后回复1点体力、解除连环，其相邻角色进入连环；其下一次由未连环变为连环后，选择交给你1张手牌或受到你1点雷电伤害。' },
  ],
}
