import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { registerPindianContinuation, startPindian } from '../../engine/pindian'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘协（三国杀 OL 经典身份 SP）。
 *
 * 【天命】：成为【杀】的目标后可以发动：弃置两张牌（不足则全弃），摸两张牌；
 *          若此时全场体力值唯一最高的角色不是刘协，该角色也可以执行同样
 *          流程。
 * 【密诏】：出牌阶段限一次，刘协将所有手牌交给一名其他角色 A，再选择另一名
 *          其他角色 B，A、B 拼点，赢家视为对没赢的一方使用一张【杀】，平局
 *          没有赢家。
 *
 * 两处最容易做错的：
 *
 * 1. **天命的「唯一最高体力值」用当前 hp，不是 maxHp**，并列最高则没有人
 *    追加发动；追加的那位是否执行由他自己选择，不是刘协替他决定。
 * 2. **密诏走既有拼点核心**，赢家的【杀】用 `beginVirtualSlash` 发起
 *    （不消耗实体牌、不计入使用次数限制），平局分支直接不生成任何效果。
 */

const TIANMING = 'tianming'
const MIZHAO = 'mizhao'
const MIZHAO_TAG = 'mizhao'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function uniqueMaxHpOther(state: SanguoshaState, excludeId: PlayerId): PlayerId | null {
  const alive = state.players.filter((candidate) => candidate.alive)
  if (alive.length === 0) return null
  const max = Math.max(...alive.map((candidate) => candidate.hp))
  const holders = alive.filter((candidate) => candidate.hp === max)
  if (holders.length !== 1 || holders[0].id === excludeId) return null
  return holders[0].id
}

function discardUpTo(host: SkillHost, playerId: PlayerId, count: number): CardId[] {
  const owner = playerOf(host.state, playerId)
  if (!owner) return []
  const cardIds = owner.zones.hand.slice(0, count)
  for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  if (cardIds.length > 0) host.dispatch('LoseCard', { playerId, cardIds, reason: TIANMING }, { targetId: playerId, cardIds })
  return cardIds
}

registerSkillRuntime({
  id: TIANMING,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; targetId?: PlayerId }
      if (payload.cardName !== '杀' || (payload.targetId ?? context.event.targetId) !== ownerId) return
      host.queueSkill({ skillId: TIANMING, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: TIANMING, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【天命】：弃置两张牌（不足则全弃），摸两张牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【天命】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.dispatch('SkillActivated', {
      skillId: TIANMING, skillName: '天命', playerId: ownerId,
      logText: `${owner.nickname}发动【天命】`,
    }, { sourceId: ownerId })
    discardUpTo(host, ownerId, 2)
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })

    const extraId = uniqueMaxHpOther(host.state, ownerId)
    if (!extraId) return
    host.askSkill({
      skillId: `${TIANMING}-extra`, ownerId: extraId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: extraId,
        prompt: `【天命】：你是全场体力值唯一最高的角色，是否也弃置两张牌（不足则全弃）并摸两张牌？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '执行' }, { id: 'no', label: '不执行' }],
      }),
    })
  },
})

registerSkillRuntime({
  id: `${TIANMING}-extra`,
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.dispatch('SkillActivated', {
      skillId: TIANMING, skillName: '天命', playerId: ownerId,
      logText: `${owner.nickname}响应【天命】，弃置两张牌（不足则全弃），摸两张牌`,
    }, { sourceId: ownerId })
    discardUpTo(host, ownerId, 2)
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: MIZHAO,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || usedThisTurn(state, ownerId, MIZHAO)) return []
    const others = state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId)
    if (others.length < 2) return []
    const withHand = others.filter((candidate) => candidate.zones.hand.length > 0)
    // 至少要存在一种「A、B」分配：排除 A 之后，还剩至少一个有手牌的人当 B
    if (!others.some((candidate) => withHand.some((holder) => holder.id !== candidate.id))) return []
    return [{ id: MIZHAO, label: '密诏：把所有手牌交给一名角色，令另一名角色与其拼点' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== MIZHAO) return
    const owner = playerOf(host.state, ownerId)
    const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || others.length < 2) return
    const withHand = others.filter((candidate) => candidate.zones.hand.length > 0)
    /*
     * A 只能选「排除掉他之后，还剩至少一个有手牌的人当 B」的那些角色——
     * 否则 pick-b 那一步会因为凑不出合法 B 而静默放弃，AI 又会把同一个
     * 非法的 A 选回来，卡成死循环（压测 seed=bisect-liuxie-post-1）。
     */
    const candidateIds = others
      .filter((candidate) => withHand.some((holder) => holder.id !== candidate.id))
      .map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: MIZHAO, ownerId, step: 'pick-a',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【密诏】：选择一名角色，交给其所有手牌',
        timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pick-a') {
      const owner = playerOf(host.state, ownerId)
      const [aId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const a = aId ? playerOf(host.state, aId) : undefined
      if (!owner?.alive || !a?.alive || owner.zones.hand.length === 0) return
      const candidateIds = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.id !== aId && candidate.zones.hand.length > 0)
        .map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: MIZHAO, ownerId, step: 'pick-b', data: { aId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【密诏】：选择另一名角色，与${a.nickname}拼点`,
          timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-b') {
      const aId = resolution.data.aId as PlayerId
      const owner = playerOf(host.state, ownerId)
      const a = playerOf(host.state, aId)
      const [bId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const b = bId ? playerOf(host.state, bId) : undefined
      if (!owner?.alive || !a?.alive || !b?.alive || owner.zones.hand.length === 0 || aId === bId || b.zones.hand.length === 0) return
      markUsedThisTurn(host.state, ownerId, MIZHAO)
      const cardIds = [...owner.zones.hand]
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: aId })
      host.dispatch('GainCard', { playerId: aId, cardIds, reason: MIZHAO }, { sourceId: ownerId, targetId: aId, cardIds })
      host.dispatch('SkillActivated', {
        skillId: MIZHAO, skillName: '密诏', playerId: ownerId, targetId: aId,
        logText: `${owner.nickname}发动【密诏】，将所有手牌交给${a.nickname}，令其与${b.nickname}拼点`,
      }, { sourceId: ownerId, targetId: aId })
      startPindian(host, { id: `mizhao-${host.state.seq}`, initiatorId: aId, opponentId: bId!, reason: MIZHAO, continuationTag: MIZHAO_TAG })
    }
  },
})

registerPindianContinuation(MIZHAO_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const { initiatorId, opponentId, outcome } = result
  if (outcome === 'tie') return
  const winnerId = outcome === 'initiator-win' ? initiatorId : opponentId
  const loserId = outcome === 'initiator-win' ? opponentId : initiatorId
  if (!playerOf(host.state, winnerId)?.alive || !playerOf(host.state, loserId)?.alive) return
  skillHost.beginVirtualSlash({ sourceId: winnerId, targetId: loserId, sourceSkillId: MIZHAO })
})

export const LIUXIE: CharacterDefinition = {
  id: 'liuxie',
  name: '刘协',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: TIANMING,
      name: '天命',
      description: '成为【杀】的目标后可以发动：弃置两张牌（不足则全弃），摸两张牌；若此时全场体力值唯一最高的角色不是刘协，该角色也可以执行同样流程。',
    },
    {
      id: MIZHAO,
      name: '密诏',
      description: '出牌阶段限一次，刘协将所有手牌交给一名其他角色 A，再选择另一名其他角色 B，A、B 拼点，赢家视为对没赢的一方使用一张【杀】，平局没有赢家。',
    },
  ],
}
