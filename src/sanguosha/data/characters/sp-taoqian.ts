import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { canTarget } from '../../engine/distance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陶谦（三国杀 OL 经典身份 SP）。
 *
 * 【纵乱】：准备阶段，陶谦可以选择一名角色A，令A视为使用一张【杀】，
 *          可以指定A攻击范围内任意数量合法其他角色为目标（虚拟杀，走
 *          `beginVirtualSlash` 的 `additionalTargetIds`，走标准杀结算
 *          管线）。结算后，陶谦弃置X张牌，X为因此次杀实际受到伤害的
 *          角色数量（不是伤害点数总和）。
 * 【招祸】：锁定技，一名角色在陶谦自己回合内首次受到伤害后，须交给陶谦
 *          1张手牌；陶谦因此获得的这些具体 Card ID，直到本回合结束不能
 *          使用、不能打出，且不计入陶谦的手牌上限。
 * 【温仁】：出牌阶段限一次，陶谦可以选择任意数量角色，每个角色独立判断：
 *          没有手牌则摸1张；手牌数不多于陶谦当前手牌数则摸1张（可以同时
 *          成立，摸2张）。
 */

const ZONGLUAN = 'zongluan'
const ZHAOHUO = 'zhaohuo'
const WENREN = 'wenren'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: ZONGLUAN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
        host.queueSkill({ skillId: ZONGLUAN, ownerId, step: 'pick-a', data: { candidateIds } })
      },
    },
    {
      event: 'Damaged',
      handle(host, _ownerId, context) {
        const record = host.state.taoqianZongluanDamaged
        if (!record || !context.event.targetId) return
        record.players.push(context.event.targetId)
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-a') return
    if (!playerOf(host.state, ownerId)?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: ZONGLUAN, ownerId, step: 'pick-a',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【纵乱】：选择一名角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-a') {
      const [aId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const a = aId ? playerOf(host.state, aId) : undefined
      if (!a?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && canTarget(host.state, a.id, candidate.id)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: ZONGLUAN, ownerId, step: 'pick-targets', data: { aId: a.id },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: a.id,
          prompt: '【纵乱】：视为使用一张杀，选择攻击范围内任意数量目标', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: candidateIds.length,
        }),
      })
      return
    }

    if (resolution.step === 'pick-targets') {
      const { aId } = resolution.data as { aId: PlayerId }
      const a = playerOf(host.state, aId)
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const validTargets = targetIds.filter((id) => playerOf(host.state, id)?.alive)
      if (!a?.alive || validTargets.length === 0) return
      host.dispatch('SkillActivated', { skillId: ZONGLUAN, skillName: '纵乱', playerId: ownerId, targetId: aId, logText: `${owner.nickname}发动【纵乱】` }, { sourceId: ownerId, targetId: aId })
      host.state.taoqianZongluanDamaged = { ownerId, players: [] }
      /*
       * `beginVirtualSlash` 一次只接受一个 target，不支持方天画戟式的
       * 多目标单张杀；这里退而求其次，对每个目标各触发一次独立的虚拟杀
       * （各自走完整闪/伤害流程），已知与官方"一张杀打多个目标"在
       * 连环、藤甲之类多目标联动效果上不完全等价。
       */
      for (const targetId of validTargets) host.beginVirtualSlash({ sourceId: aId, targetId, sourceSkillId: ZONGLUAN })
      const record = host.state.taoqianZongluanDamaged
      const x = record?.ownerId === ownerId ? new Set(record.players).size : 0
      host.state.taoqianZongluanDamaged = undefined
      if (x <= 0 || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: ZONGLUAN, ownerId, step: 'discard', data: { x: Math.min(x, owner.zones.hand.length) },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【纵乱】：弃置${Math.min(x, owner.zones.hand.length)}张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: Math.min(x, owner.zones.hand.length), max: Math.min(x, owner.zones.hand.length),
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (valid.length === 0) return
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: ZONGLUAN }, { sourceId: ownerId, cardIds: valid })
    }
  },
})

registerSkillRuntime({
  id: ZHAOHUO,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId || host.state.currentPlayerId !== ownerId) return
      host.state.taoqianZhaohuoDamaged ??= { turnNumber: host.state.turnNumber, players: [] }
      if (host.state.taoqianZhaohuoDamaged.turnNumber !== host.state.turnNumber) host.state.taoqianZhaohuoDamaged = { turnNumber: host.state.turnNumber, players: [] }
      if (host.state.taoqianZhaohuoDamaged.players.includes(targetId)) return
      host.state.taoqianZhaohuoDamaged.players.push(targetId)
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !target?.alive || targetId === ownerId || target.zones.hand.length === 0) return
      host.queueSkill({ skillId: ZHAOHUO, ownerId, step: 'give', data: { targetId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'give') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!target?.alive || target.zones.hand.length === 0) return
    host.askSkill({
      skillId: ZHAOHUO, ownerId, step: 'give', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: targetId,
        prompt: '【招祸】：交给陶谦1张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'give') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!target?.alive || !owner?.alive || !cardId || !target.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: ZHAOHUO }, { sourceId: targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHAOHUO }, { targetId: ownerId, cardIds: [cardId] })
    host.state.taoqianZhaohuoLocked ??= {}
    host.state.taoqianZhaohuoLocked[ownerId] = { cardIds: [...(host.state.taoqianZhaohuoLocked[ownerId]?.cardIds ?? []), cardId], turnNumber: host.state.turnNumber }
    host.dispatch('SkillActivated', { skillId: ZHAOHUO, skillName: '招祸', playerId: ownerId, targetId, logText: `${owner.nickname}发动【招祸】` }, { sourceId: ownerId, targetId })
  },

  prohibitsOwnResponse(state, ownerId, cardName) {
    return isZhaohuoLocked(state, ownerId, cardName)
  },
  maxCardsBonus(state, ownerId) {
    const locked = state.taoqianZhaohuoLocked?.[ownerId]
    if (!locked || locked.turnNumber !== state.turnNumber) return 0
    return -locked.cardIds.length
  },
})

function isZhaohuoLocked(state: SanguoshaState, ownerId: PlayerId, cardName: string): boolean {
  const owner = playerOf(state, ownerId)
  const locked = state.taoqianZhaohuoLocked?.[ownerId]
  if (!owner || !locked || locked.turnNumber !== state.turnNumber) return false
  return owner.zones.hand.some((cardId) => locked.cardIds.includes(cardId) && state.cards[cardId]?.name === cardName)
}

registerSkillRuntime({
  id: WENREN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(WENREN)) return []
    return [{ id: WENREN, label: '温仁：选择任意数量角色，各自判断是否摸牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== WENREN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(WENREN)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: WENREN, ownerId, step: 'pick',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【温仁】：选择任意数量角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: candidateIds.length,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(WENREN)) return
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (targetIds.length === 0) return
    owner.turnUsedSkills.push(WENREN)
    host.dispatch('SkillActivated', { skillId: WENREN, skillName: '温仁', playerId: ownerId, logText: `${owner.nickname}发动【温仁】` }, { sourceId: ownerId })
    for (const targetId of targetIds) {
      const target = playerOf(host.state, targetId)
      if (!target?.alive) continue
      let draws = 0
      if (target.zones.hand.length === 0) draws += 1
      if (target.zones.hand.length <= owner.zones.hand.length) draws += 1
      if (draws > 0) drawCards(host.state, host.rng, targetId, draws, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

export const TAOQIAN: CharacterDefinition = {
  id: 'taoqian',
  name: '陶谦',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: ZONGLUAN, name: '纵乱', description: '准备阶段，陶谦可以选择一名角色，令其视为使用一张杀，可以指定其攻击范围内任意数量其他角色为目标；结算后，陶谦弃置X张牌，X为因此受到伤害的角色数量。' },
    { id: ZHAOHUO, name: '招祸', description: '锁定技，一名角色在陶谦自己回合内首次受到伤害后，须交给陶谦1张手牌；这些牌直到本回合结束不能使用、不能打出，且不计入陶谦的手牌上限。' },
    { id: WENREN, name: '温仁', description: '出牌阶段限一次，陶谦可以选择任意数量角色，每个角色独立判断：没有手牌则摸1张，手牌数不多于陶谦当前手牌数则摸1张，可以同时成立。' },
  ],
}
