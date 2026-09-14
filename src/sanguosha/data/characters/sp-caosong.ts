import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { gainMaxHp, loseMaxHp } from '../../engine/hp'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹嵩（三国杀 OL 经典身份 SP）。
 *
 * 【礼赂】：摸牌阶段，你可以改为将手牌摸至体力上限（至多摸至5张），然后
 *          可以交给一名其他角色至少1张手牌；若是本局第一次礼赂给牌，
 *          或本次给出的数量大于上一次，你增加1点体力上限并回复1点体力。
 * 【翊正】：结束阶段，选择一名其他角色A，直到你下一个回合开始：A即将
 *          造成伤害/回复体力时，若A的体力上限小于你，你减1点体力上限，
 *          若成功，这次伤害/回复+1。
 */

const LILU = 'lilu'
const YIZHENG = 'yizheng'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: LILU,
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      context.cancel()
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const target = Math.min(owner.maxHp, 5)
      const n = target - owner.zones.hand.length
      if (n > 0) drawCards(host.state, host.rng, ownerId, n, (name, p) => { host.dispatch(name, p) })
      host.dispatch('SkillActivated', { skillId: LILU, skillName: '礼赂', playerId: ownerId, logText: `${owner.nickname}发动【礼赂】` }, { sourceId: ownerId })
      if (owner.zones.hand.length === 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: LILU, ownerId, step: 'pick-target', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: LILU, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【礼赂】：可以选择一名其他角色，交给其至少1张手牌', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive) return
      host.askSkill({
        skillId: LILU, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【礼赂】：交给其至少1张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length,
        }),
      })
      return
    }
    if (resolution.step === 'give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => owner?.zones.hand.includes(id))
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || picked.length === 0) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: LILU }, { sourceId: ownerId, cardIds: picked })
      host.dispatch('GainCard', { playerId: targetId, cardIds: picked, reason: LILU }, { sourceId: ownerId, targetId, cardIds: picked })
      const last = owner.marks['lilu-last-count']
      const n = picked.length
      if (last === undefined || n > last) {
        gainMaxHp(host as never, ownerId, 1, LILU)
        if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ownerId)
        host.dispatch('SkillActivated', { skillId: LILU, skillName: '礼赂', playerId: ownerId, logText: `${owner.nickname}的【礼赂】增长，体力上限+1` }, { sourceId: ownerId })
      }
      owner.marks['lilu-last-count'] = n
    }
  },
})

registerSkillRuntime({
  id: YIZHENG,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: YIZHENG, ownerId, step: 'pick-target', data: {} })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        host.state.yizhengBound = undefined
      },
    },
    {
      event: 'BeforeDamage',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        if (!sourceId || host.state.yizhengBound?.targetId !== sourceId || host.state.yizhengBound.ownerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        const source = playerOf(host.state, sourceId)
        if (!owner?.alive || !source?.alive || source.maxHp >= owner.maxHp) return
        loseMaxHp(host as never, ownerId, 1, YIZHENG)
        if (!playerOf(host.state, ownerId)?.alive) return
        const payload = context.event.payload as { amount?: number }
        payload.amount = (typeof payload.amount === 'number' ? payload.amount : 0) + 1
      },
    },
  ],
  recoverAmountBonus(state, targetId) {
    if (state.yizhengBound?.targetId !== targetId) return 0
    const owner = state.players.find((candidate) => candidate.id === state.yizhengBound!.ownerId)
    const target = state.players.find((candidate) => candidate.id === targetId)
    if (!owner?.alive || !target?.alive || target.maxHp >= owner.maxHp) return 0
    /*
     * loseMaxHp 需要 host.dispatch，这个钩子只拿得到 state；但翊正的
     * "先扣血再+1" 本质就是这一刻的联动效果，直接改 state 字段，
     * MaxHpChange 事件改由调用方（recover）之后不再重复发——这里只做
     * 最小的数值联动，事件通知从略，属于已知简化。
     */
    // 只读钩子拿不到 dispatch/enterDying：为避免在这里把自己扣到 0 血又
    // 没法正常进入濒死，体力上限已经降到会让自己归零时就不再消耗。
    const nextMax = owner.maxHp - 1
    if (nextMax <= 0 || Math.min(owner.hp, nextMax) <= 0) return 0
    owner.maxHp = nextMax
    owner.hp = Math.min(owner.hp, nextMax)
    return 1
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: YIZHENG, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【翊正】：选择一名其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive) return
    host.state.yizhengBound = { ownerId, targetId }
    host.dispatch('SkillActivated', { skillId: YIZHENG, skillName: '翊正', playerId: ownerId, targetId, logText: `${owner.nickname}发动【翊正】` }, { sourceId: ownerId, targetId })
  },
})

export const CAOSONG: CharacterDefinition = {
  id: 'caosong',
  name: '曹嵩',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: LILU, name: '礼赂', description: '摸牌阶段，你可以改为将手牌摸至体力上限（至多摸至5张），然后可以交给一名其他角色至少1张手牌；若是本局第一次礼赂给牌，或本次给出的数量大于上一次，你增加1点体力上限并回复1点体力。' },
    { id: YIZHENG, name: '翊正', description: '结束阶段，选择一名其他角色，直到你下一个回合开始：其即将造成伤害/回复体力时，若其体力上限小于你，你减1点体力上限，若成功，这次伤害/回复+1。' },
  ],
}
