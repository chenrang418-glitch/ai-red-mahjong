import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { giveCards } from '../../engine/hand-transfer'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { finalizeDamage, resumeDamageChain } from '../../engine/damage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, DistributeCardsRequest } from '../../engine/requests'
import type { CardId, DamageNature, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 邓芝（三国杀 OL 经典身份 SP）。
 *
 * 【修好】：每个 TurnInstance 限一次，你可以防止你对其他角色/其他角色对你
 *          将要造成的伤害；若如此做，伤害来源摸2张牌。
 * 【素俭】：锁定技，弃牌阶段不执行普通流程，而是从"分配非本回合获得的
 *          手牌"或"弃置非本回合获得的手牌、再拆一名角色至多等量的牌"中
 *          选择一项。
 */

const XIUHAO = 'xiuhao'
const SUJIAN = 'sujian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: XIUHAO,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      if (!targetId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      let otherId: PlayerId | null = null
      if (sourceId === ownerId && targetId !== ownerId) otherId = targetId
      else if (targetId === ownerId && sourceId && sourceId !== ownerId) otherId = sourceId
      if (!otherId) return
      if (owner.marks['xiuhao-turn'] === host.state.turnNumber) return
      if (host.state.damageChain) return
      if (host.state.cardResolution?.kind === 'trick') return
      /*
       * 多目标【杀】（贺齐【短兵】会让普通杀额外指定一名目标）同样不介入：
       * 防止的这一下若把当前目标打死会进入濒死，但还有别的目标在排队
       * 等下一轮求闪，濒死流程一旦挂起，那些排队的请求答完就会撞上
       * "当前濒死流程尚未结束"（和仁心排除多目标锦囊是同一个道理）。
       */
      if (host.state.cardResolution?.kind === 'slash' && host.state.cardResolution.remainingTargetIds.length > 0) return
      if (host.state.skillResolution) return
      const payload = context.event.payload as { amount?: number; cardId?: CardId; cardName?: string; redirectedBy?: string }
      const amount = typeof payload.amount === 'number' ? payload.amount : 0
      if (amount <= 0) return
      context.cancel()
      host.askSkill({
        skillId: XIUHAO, ownerId, step: 'ask',
        data: {
          targetId, sourceId: sourceId ?? null, otherId, amount,
          nature: (context.event.damageNature ?? 'normal') as DamageNature,
          cardId: payload.cardId ?? null, cardName: payload.cardName ?? null,
          redirectedBy: payload.redirectedBy ?? null,
        },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【修好】：防止这次伤害，令来源摸2张牌？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动【修好】' }, { id: 'no', label: '不发动' }],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    const targetId = resolution.data.targetId as PlayerId
    const sourceId = resolution.data.sourceId as PlayerId | null
    const otherId = resolution.data.otherId as PlayerId
    const amount = resolution.data.amount as number
    const nature = resolution.data.nature as DamageNature
    const cardId = resolution.data.cardId as CardId | null
    const cardName = resolution.data.cardName as string | null
    const redirectedBy = resolution.data.redirectedBy as string | null

    const reapply = (): void => {
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      finalizeDamage(host as never, target, sourceId, amount, nature, cardId, cardName, redirectedBy, false)
      // finalizeDamage 是底层原语，命中链环目标时会自己建一条新的
      // damageChain，但不会像 resolveDamage 那样自动续上——这里必须
      // 手动续，否则下一次不相关的伤害会被"属性伤害传导尚未结束"卡死。
      if (!host.state.dying) resumeDamageChain(host as never)
    }

    if (resolution.step !== 'ask') return
    const accepted = (response.payload as { optionId?: string }).optionId === 'yes'
    if (!accepted || !owner?.alive) return reapply()
    owner.marks['xiuhao-turn'] = host.state.turnNumber
    host.dispatch('SkillActivated', {
      skillId: XIUHAO, skillName: '修好', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【修好】，防止了这次伤害`,
    }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, otherId, 2, (name, payload) => { host.dispatch(name, payload) })
  },
})

function turnGainedOf(state: SanguoshaState): Set<CardId> {
  const ledger = state.dengzhiTurnGained
  if (!ledger || ledger.turnNumber !== state.turnNumber) return new Set()
  return new Set(ledger.cardIds)
}

registerSkillRuntime({
  id: SUJIAN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        host.state.dengzhiTurnGained = { turnNumber: host.state.turnNumber, cardIds: [] }
      },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId !== ownerId) return
        const ledger = host.state.dengzhiTurnGained
        if (!ledger || ledger.turnNumber !== host.state.turnNumber) return
        ledger.cardIds.push(...(payload.cardIds ?? []))
      },
    },
    {
      event: 'DiscardPhase',
      handle(host, ownerId, context) {
        if (context.event.payload && (context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
        context.cancel()
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const gained = turnGainedOf(host.state)
        const oldSet = owner.zones.hand.filter((cardId) => !gained.has(cardId))
        if (oldSet.length === 0) return
        host.queueSkill({ skillId: SUJIAN, ownerId, step: 'ask-option', data: { oldSet } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-option') return
    host.askSkill({
      skillId: SUJIAN, ownerId, step: 'ask-option', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【素俭】：选择处理非本回合获得的手牌的方式', timeoutMs: 20_000, optional: false,
        options: [
          { id: 'give', label: '将这些牌分配给其他角色' },
          { id: 'discard', label: '弃置这些牌，然后拆一名角色至多等量的牌' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask-option') {
      const { oldSet } = resolution.data as { oldSet: CardId[] }
      const valid = oldSet.filter((cardId) => owner.zones.hand.includes(cardId))
      if (valid.length === 0) return
      const choice = (response.payload as { optionId?: string }).optionId
      host.dispatch('SkillActivated', { skillId: SUJIAN, skillName: '素俭', playerId: ownerId, logText: `${owner.nickname}发动【素俭】` }, { sourceId: ownerId })
      if (choice === 'give') {
        const recipientIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (recipientIds.length === 0) return
        host.askSkill({
          skillId: SUJIAN, ownerId, step: 'distribute', data: {},
          build: (requestId): DistributeCardsRequest => ({
            id: requestId, kind: 'distribute-cards', playerId: ownerId,
            prompt: '【素俭】：将这些牌分配给其他角色', timeoutMs: 25_000, optional: false,
            cardIds: valid, recipientIds, min: valid.length, max: valid.length,
          }),
        })
        return
      }
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: SUJIAN }, { sourceId: ownerId, cardIds: valid })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: SUJIAN, ownerId, step: 'pick-victim', data: { n: valid.length },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【素俭】：选择一名角色，拆其至多等量的牌', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'distribute') {
      const assignments = (response.payload as { assignments?: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments ?? []
      const byRecipient = new Map<PlayerId, CardId[]>()
      for (const entry of assignments) {
        if (!entry?.cardId || !entry.recipientId || entry.recipientId === ownerId) continue
        if (!owner.zones.hand.includes(entry.cardId)) continue
        byRecipient.set(entry.recipientId, [...(byRecipient.get(entry.recipientId) ?? []), entry.cardId])
      }
      for (const [recipientId, cardIds] of byRecipient) giveCards(host as never, ownerId, recipientId, cardIds, SUJIAN)
      return
    }
    if (resolution.step === 'pick-victim') {
      const { n } = resolution.data as { n: number }
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const victim = victimId ? playerOf(host.state, victimId) : undefined
      if (!victim?.alive) return
      const pickable = pickableCardsOf(host.state, victimId)
      const pool = [...pickable.cardIds, ...pickable.hiddenCardSlots]
      const max = Math.min(n, pool.length)
      if (max <= 0) return
      host.askSkill({
        skillId: SUJIAN, ownerId, step: 'discard-victim', data: { victimId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【素俭】：拆${victim.nickname}至多${max}张牌`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 0, max,
        }),
      })
      return
    }
    if (resolution.step === 'discard-victim') {
      const { victimId } = resolution.data as { victimId: PlayerId }
      const picked = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardIds = picked.map((token) => resolvePickedCard(host.state, victimId, token)).filter((cardId): cardId is CardId => Boolean(cardId))
      for (const cardId of cardIds) movePickedCard(host as never, victimId, cardId, { kind: 'discardPile' })
      if (cardIds.length > 0) host.dispatch('LoseCard', { playerId: victimId, cardIds, reason: SUJIAN }, { sourceId: ownerId, targetId: victimId, cardIds })
    }
  },
})

export const DENGZHI: CharacterDefinition = {
  id: 'dengzhi',
  name: '邓芝',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: XIUHAO, name: '修好', description: '每个 TurnInstance 限一次，你可以防止你对其他角色/其他角色对你将要造成的伤害；若如此做，伤害来源摸2张牌。' },
    { id: SUJIAN, name: '素俭', description: '锁定技，弃牌阶段不执行普通流程，而是选择将非本回合获得的手牌分配给其他角色，或弃置这些牌后拆一名角色至多等量的牌。' },
  ],
}
