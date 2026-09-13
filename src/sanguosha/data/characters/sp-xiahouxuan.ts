import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { isLockedSkill } from '../../engine/locked-skills'
import { suppressSkill } from '../../engine/skill-suppression'
import { getSkillRuntime, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { skillIdsOf } from '../../data/characters/standard'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 夏侯玄（三国杀 OL 经典身份 SP）。
 *
 * 【宦浮】：夏侯玄使用【杀】指定目标后，或成为【杀】目标后，可以弃置N张
 *          牌（1~maxHp）；此杀结算后若对应目标实际受到伤害恰好为N，摸2N。
 * 【清议】：出牌阶段限一次，选择至多2名有手牌的其他角色，与之各弃1张
 *          牌；若本轮所提交的牌类别全部相同，可重复；结束阶段可获得过程
 *          中弃置且颜色不同的牌各1张（最多2张）。
 * 【迮阅】：限定技，准备阶段，选择一名自夏侯玄上个回合结束后曾对其造成
 *          过伤害的角色，令其失去一个可被移除的技能（排除锁定/觉醒/限定）
 *          ；每轮开始视为对夏侯玄使用其已失去技能轮数张【杀】，一旦造成
 *          伤害立即恢复技能并停止剩余的杀。
 */

const HUANFU = 'huanfu'
const QINGYI = 'qingyi'
const ZEYUE = 'zeyue'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: HUANFU,
  interceptSourceTarget(host, ownerId, context) {
    if (context.cardName !== '杀') return false
    return armHuanfu(host, ownerId, context.targetId)
  },
  interceptTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId === ownerId) return false
    return armHuanfu(host, ownerId, ownerId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') { return }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) { host.resumeCardTarget(); return }
    const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
    if (cardIds.length === 0) { host.resumeCardTarget(); return }
    const { targetId } = resolution.data as { targetId: PlayerId }
    for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: HUANFU }, { sourceId: ownerId, cardIds })
    host.dispatch('SkillActivated', { skillId: HUANFU, skillName: '宦浮', playerId: ownerId, logText: `${owner.nickname}发动【宦浮】，弃${cardIds.length}张牌` }, { sourceId: ownerId, targetId })
    host.state.xiahouxuanHuanfuPending = { ownerId, targetId, n: cardIds.length, dealt: 0 }
    host.resumeCardTarget()
  },
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const pending = host.state.xiahouxuanHuanfuPending
      if (!pending || pending.ownerId !== ownerId || context.event.targetId !== pending.targetId) return
      pending.dealt += Math.max(0, Math.trunc(((context.event.payload as { amount?: number }).amount) ?? 0))
    },
  }, {
    event: 'CardResolved',
    handle(host, ownerId, context) {
      const pending = host.state.xiahouxuanHuanfuPending
      if (!pending || pending.ownerId !== ownerId) return
      if (context.event.sourceId !== ownerId && context.event.targetId !== pending.targetId) return
      host.state.xiahouxuanHuanfuPending = undefined
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || pending.dealt !== pending.n) return
      drawCards(host.state, host.rng, ownerId, pending.n * 2, (name, payload) => { host.dispatch(name, payload) })
      host.dispatch('SkillActivated', { skillId: HUANFU, skillName: '宦浮', playerId: ownerId, logText: `${owner.nickname}发动【宦浮】，摸${pending.n * 2}张牌` }, { sourceId: ownerId })
    },
  }],
})

function armHuanfu(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): boolean {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || owner.zones.hand.length === 0) return false
  const max = Math.max(1, owner.maxHp)
  host.askSkill({
    skillId: HUANFU, ownerId, step: 'discard', data: { targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【宦浮】：弃置1~${Math.min(max, owner.zones.hand.length)}张牌`, timeoutMs: 20_000, optional: true,
      purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(max, owner.zones.hand.length),
    }),
  })
  return true
}

registerSkillRuntime({
  id: QINGYI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(QINGYI)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)) return []
    return [{ id: QINGYI, label: '清议：选择至多2名角色各弃1张牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== QINGYI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(QINGYI)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(QINGYI)
    host.askSkill({
      skillId: QINGYI, ownerId, step: 'pick-players', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【清议】：选择至多2名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: Math.min(2, candidateIds.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-players') {
      const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (ids.length === 0) return
      host.dispatch('SkillActivated', { skillId: QINGYI, skillName: '清议', playerId: ownerId, logText: `${owner.nickname}发动【清议】` }, { sourceId: ownerId })
      runQingyiRound(host, ownerId, [ownerId, ...ids], 0, [])
      return
    }

    if (resolution.step === 'discard') {
      const { players, index, discarded } = resolution.data as { players: PlayerId[]; index: number; discarded: CardId[] }
      const playerId = players[index]
      const player = playerOf(host.state, playerId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const nextDiscarded = [...discarded]
      if (player?.alive && cardId && player.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: QINGYI }, { sourceId: ownerId, targetId: playerId, cardIds: [cardId] })
        nextDiscarded.push(cardId)
      }
      if (index + 1 < players.length) { runQingyiRound(host, ownerId, players, index + 1, nextDiscarded); return }
      // 一整轮结束：类别是否全部相同
      const categories = new Set(nextDiscarded.map((id) => host.state.cards[id]?.category).filter(Boolean))
      host.state.xiahouxuanQingyiDiscards ??= []
      host.state.xiahouxuanQingyiDiscards.push(...nextDiscarded)
      const stillHave = players.filter((id) => (playerOf(host.state, id)?.zones.hand.length ?? 0) > 0)
      if (categories.size === 1 && nextDiscarded.length > 0 && stillHave.length === players.length) {
        runQingyiRound(host, ownerId, players, 0, [])
      }
    }
  },
})

function runQingyiRound(host: SkillHost, ownerId: PlayerId, players: PlayerId[], index: number, discarded: CardId[]): void {
  const playerId = players[index]
  const player = playerOf(host.state, playerId)
  if (!player?.alive || player.zones.hand.length === 0) {
    if (index + 1 < players.length) { runQingyiRound(host, ownerId, players, index + 1, discarded); return }
    return
  }
  host.askSkill({
    skillId: QINGYI, ownerId, step: 'discard', data: { players, index, discarded },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId,
      prompt: '【清议】：弃置1张牌', timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds: [...player.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: ZEYUE,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId || !context.event.sourceId) return
        host.state.xiahouxuanDamagedBy ??= []
        if (!host.state.xiahouxuanDamagedBy.includes(context.event.sourceId)) host.state.xiahouxuanDamagedBy.push(context.event.sourceId)
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId === ownerId) host.state.xiahouxuanDamagedBy = []
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.usedLimitedSkills.includes(ZEYUE)) return
        const candidateIds = (host.state.xiahouxuanDamagedBy ?? []).filter((id) => playerOf(host.state, id)?.alive)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: ZEYUE, ownerId, step: 'pick-target', data: { candidateIds } })
      },
    },
    {
      event: 'RoundStart',
      handle(host, ownerId) {
        const pending = host.state.xiahouxuanZeyue
        if (!pending || pending.ownerId !== ownerId) return
        pending.roundsLost += 1
        host.queueSkill({ skillId: ZEYUE, ownerId, step: 'strike', data: { targetId: pending.targetId, remaining: pending.roundsLost } })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        const pending = host.state.xiahouxuanZeyue
        if (!pending || pending.ownerId !== ownerId || context.event.targetId !== ownerId || context.event.sourceId !== pending.targetId) return
        const target = playerOf(host.state, pending.targetId)
        if (target?.alive) {
          const entries = host.state.skillSuppressions ?? []
          host.state.skillSuppressions = entries.filter((entry) => !(entry.targetId === pending.targetId && entry.skillId === pending.skillId && entry.sourceSkillId === ZEYUE))
          host.dispatch('SkillActivated', { skillId: ZEYUE, skillName: '迮阅', playerId: ownerId, logText: `${target.nickname}恢复技能` }, { sourceId: ownerId, targetId: pending.targetId })
        }
        host.state.xiahouxuanZeyue = undefined
        host.state.xiahouxuanZeyueStriking = undefined
      },
    },
    {
      event: 'CardResolved',
      handle(host, ownerId, context) {
        const striking = host.state.xiahouxuanZeyueStriking
        if (!striking || striking.ownerId !== ownerId || context.event.sourceId !== striking.data.targetId) return
        host.state.xiahouxuanZeyueStriking = undefined
        // CardResolved 在 finishSlash/continueSlash 的同步级联中派发，此时
        // cardResolution 还没被调用方清空，不能在这里直接再起一次虚拟杀。
        host.queueSkill({ skillId: ZEYUE, ownerId, step: 'strike-next', data: { data: striking.data, index: striking.index + 1 } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'pick-target') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: ZEYUE, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【迮阅】：选择一名曾对你造成过伤害的角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'strike') {
      strikeZeyue(host, ownerId, prompt.data as { targetId: PlayerId; remaining: number })
      return
    }
    if (prompt.step === 'strike-next') {
      const { data, index } = prompt.data as { data: { targetId: PlayerId; remaining: number }; index: number }
      strikeZeyue(host, ownerId, data, index)
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const removable = skillIdsOf(target.characterId ?? '').filter((skillId) => {
        const runtime = getSkillRuntime(skillId)
        return !isLockedSkill(skillId) && !runtime?.awakening && !runtime?.limited
      })
      if (removable.length === 0) return
      host.askSkill({
        skillId: ZEYUE, ownerId, step: 'pick-skill', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【迮阅】：选择令其失去的技能', timeoutMs: 20_000, optional: false,
          options: removable.map((skillId) => ({ id: skillId, label: getSkillRuntime(skillId)?.id ?? skillId })),
        }),
      })
      return
    }
    if (resolution.step === 'pick-skill') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const skillId = (response.payload as { optionId?: string }).optionId
      const target = playerOf(host.state, targetId)
      if (!target?.alive || !skillId) return
      owner.usedLimitedSkills.push(ZEYUE)
      suppressSkill(host.state, { targetId, skillId, sourceId: ownerId, sourceSkillId: ZEYUE, armedAtTurn: Number.POSITIVE_INFINITY })
      host.state.xiahouxuanZeyue = { ownerId, targetId, skillId, roundsLost: 0 }
      host.dispatch('SkillActivated', { skillId: ZEYUE, skillName: '迮阅', playerId: ownerId, logText: `${owner.nickname}发动【迮阅】，令${target.nickname}失去技能` }, { sourceId: ownerId, targetId })
    }
  },
})

function strikeZeyue(host: SkillHost, ownerId: PlayerId, data: { targetId: PlayerId; remaining: number }, index = 0): void {
  const pending = host.state.xiahouxuanZeyue
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, data.targetId)
  if (!pending || !owner?.alive || !target?.alive || index >= data.remaining) return
  host.state.xiahouxuanZeyueStriking = { ownerId, index, data }
  host.beginVirtualSlash({ sourceId: data.targetId, targetId: ownerId, sourceSkillId: ZEYUE })
}

export const XIAHOUXUAN: CharacterDefinition = {
  id: 'xiahouxuan',
  name: '夏侯玄',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: HUANFU, name: '宦浮', description: '你使用【杀】指定目标后，或成为【杀】目标后，可以弃置N张牌（1~体力上限）；此杀结算后若对应目标实际受到伤害恰好为N，你摸2N张牌。' },
    { id: QINGYI, name: '清议', description: '出牌阶段限一次，选择至多2名有手牌的其他角色，与之各弃1张牌；若本轮所弃的牌类别全部相同则可重复；结束阶段可获得过程中弃置且颜色不同的牌各1张。' },
    { id: ZEYUE, name: '迮阅', description: '限定技，准备阶段，选择一名自你上个回合结束后曾对你造成过伤害的角色，令其失去一个可被移除的技能；每轮开始视为对你使用其已失去技能轮数张【杀】，一旦造成伤害立即恢复技能。' },
  ],
}
