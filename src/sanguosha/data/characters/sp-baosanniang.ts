import { continueDyingRescue } from '../../engine/damage'
import { loseHp } from '../../engine/hp'
import { hasPickableCards, pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { moveCard } from '../../engine/zones'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { canUseSlash } from '../../engine/slash-rules'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 鲍三娘（三国杀 OL 经典身份 SP）。
 *
 * 【武娘】：可以将一张非基本牌当【杀】使用（无距离限制、不可响应），结算后
 *          获得目标一张牌；若所得牌非基本牌，可以失去1点体力，令场上所有
 *          角色的【镇南】视为未发动过。
 * 【镇南】：限定技，准备阶段弃置2张牌，视为使用一张【南蛮入侵】（可指定
 *          任意合法目标）；结算后，受到伤害的目标随机弃1张牌，未受到伤害
 *          的目标本回合内被她使用牌无次数限制（本项目只有"杀"存在次数
 *          限制，故落在杀的次数豁免上）。
 * 【许身】：限定技，濒死时可选另一名角色二选一（清除可失去技能永久获得
 *          【征南】，或永久获得【镇南】），然后回复到1点体力。
 */

const WUNIANG = 'wuniang'
const ZHENNAN = 'zhennan'
const ZHENNAN_INVOKE = 'zhennan-invoke'
const XUSHEN = 'xushen'
const XUSHEN_INVOKE = 'xushen-invoke'
const WUNIANG_INVOKE = 'wuniang-invoke'
const ZHENGNAN_SKILL_ID = 'zhengnan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: WUNIANG,
  slashUndodgeable(state, ownerId, targetId) {
    const active = state.baosanniangWuniangActive
    return !!active && active.ownerId === ownerId && active.targetId === targetId
  },
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || !canUseSlash(state, ownerId, false)) return []
    if (!owner.zones.hand.some((cardId) => state.cards[cardId]?.category !== 'basic')) return []
    return [{ id: WUNIANG_INVOKE, label: '武娘：将一张非基本牌当【杀】使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== WUNIANG_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const nonBasic = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.category !== 'basic')
    if (nonBasic.length === 0) return
    host.askSkill({
      skillId: WUNIANG, ownerId, step: 'pick-card', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【武娘】：选择一张非基本牌当【杀】使用', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: nonBasic, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.category === 'basic') return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: WUNIANG, ownerId, step: 'pick-target', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【武娘】：选择这张【杀】的目标（无距离限制）', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-target') {
      const { cardId } = resolution.data as { cardId: CardId }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = playerOf(host.state, targetId)
      if (!target?.alive || !owner.zones.hand.includes(cardId)) return
      host.state.baosanniangWuniangActive = { ownerId, targetId, turnNumber: host.state.turnNumber }
      host.dispatch('SkillActivated', { skillId: WUNIANG, skillName: '武娘', playerId: ownerId, targetId, logText: `${owner.nickname}发动【武娘】，将一张牌当【杀】对${target.nickname}使用` }, { sourceId: ownerId, targetId })
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `wuniang:${cardId}`, playerId: ownerId,
        cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1,
        asCardName: '杀', label: '武娘：视为使用【杀】',
      })
      host.state.baosanniangWuniangActive = undefined
      host.queueSkill({ skillId: WUNIANG, ownerId, step: 'gain', data: { targetId } })
      return
    }

    if (resolution.step === 'gain-pick') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      if (!picked) return
      const realId = resolvePickedCard(host.state, targetId, picked)
      if (!realId) return
      movePickedCard(host as never, targetId, realId, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [realId], reason: WUNIANG }, { sourceId: ownerId, targetId, cardIds: [realId] })
      if (host.state.cards[realId]?.category === 'basic') return
      host.askSkill({
        skillId: WUNIANG, ownerId, step: 'reset-ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【武娘】：是否失去1点体力，令场上所有角色的【镇南】视为未发动过？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'reset', label: '失去1点体力并重置' }, { id: 'cancel', label: '不发动' }],
        }),
      })
      return
    }

    if (resolution.step === 'reset-ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'reset') return
      loseHp(host as never, ownerId, 1, WUNIANG)
      for (const player of host.state.players) {
        player.usedLimitedSkills = player.usedLimitedSkills.filter((skillId) => skillId !== ZHENNAN)
      }
      host.dispatch('SkillActivated', { skillId: WUNIANG, skillName: '武娘', playerId: ownerId, logText: `${owner.nickname}失去1点体力，场上所有角色的【镇南】视为未发动过` }, { sourceId: ownerId })
    }
  },

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'gain') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || !hasPickableCards(host.state, targetId)) return
    const pickable = pickableCardsOf(host.state, targetId)
    host.askSkill({
      skillId: WUNIANG, ownerId, step: 'gain-pick', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【武娘】：获得${target.nickname}的一张牌`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }),
    })
  },
})

registerSkillRuntime({
  id: ZHENNAN,
  limited: true,
  ignoresSlashUsesTo(state, ownerId, targetId) {
    const entry = state.baosanniangZhennanUnlimited?.[targetId]
    return !!entry && entry.ownerId === ownerId && entry.turnNumber === state.turnNumber
  },
  activeActions(state, ownerId) {
    if (state.phase !== 'prepare' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(ZHENNAN) || owner.zones.hand.length < 2) return []
    return [{ id: ZHENNAN_INVOKE, label: '镇南：弃置2张牌，视为使用一张【南蛮入侵】（可自选目标）' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHENNAN_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(ZHENNAN) || owner.zones.hand.length < 2) return
    host.askSkill({
      skillId: ZHENNAN, ownerId, step: 'discard', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【镇南】：弃置2张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'discard') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (valid.length !== 2 || owner.usedLimitedSkills.includes(ZHENNAN)) return
      for (const id of valid) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: ZHENNAN }, { sourceId: ownerId, cardIds: valid })
      owner.usedLimitedSkills.push(ZHENNAN)
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: ZHENNAN, ownerId, step: 'targets', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【镇南】：选择这张【南蛮入侵】的目标', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: candidateIds.length,
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const targetIds = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? []).filter((id) => playerOf(host.state, id)?.alive)
      if (targetIds.length === 0) return
      host.dispatch('SkillActivated', { skillId: ZHENNAN, skillName: '镇南', playerId: ownerId, logText: `${owner.nickname}发动限定技【镇南】，视为对${targetIds.length}名角色使用【南蛮入侵】` }, { sourceId: ownerId })
      const cardId = createVirtualTrick(host.state, ownerId, '南蛮入侵', ZHENNAN)
      host.state.baosanniangZhennanPending = { cardId, targetIds: [...targetIds], turnNumber: host.state.turnNumber }
      host.state.baosanniangZhennanDamaged = []
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `zhennan:${cardId}`, playerId: ownerId,
        cardIds: [cardId], targetIds, targetMin: targetIds.length, targetMax: targetIds.length,
        asCardName: '南蛮入侵', label: '镇南：视为使用【南蛮入侵】',
      })
    }
  },
  triggers: [
    {
      event: 'Damaged',
      handle(host, _ownerId, context) {
        const pending = host.state.baosanniangZhennanPending
        const payload = context.event.payload as { cardId?: CardId }
        if (!pending || payload.cardId !== pending.cardId || !context.event.targetId) return
        host.state.baosanniangZhennanDamaged ??= []
        host.state.baosanniangZhennanDamaged.push(context.event.targetId)
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const pending = host.state.baosanniangZhennanPending
        const payload = context.event.payload as { cardId?: CardId }
        if (!pending || payload.cardId !== pending.cardId || context.event.sourceId !== ownerId) return
        const damaged = new Set(host.state.baosanniangZhennanDamaged ?? [])
        for (const targetId of pending.targetIds) {
          const target = playerOf(host.state, targetId)
          if (!target?.alive) continue
          if (damaged.has(targetId)) {
            if (target.zones.hand.length > 0) {
              const discardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
              moveCard(host.state, discardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
              host.dispatch('LoseCard', { playerId: targetId, cardIds: [discardId], reason: ZHENNAN }, { sourceId: targetId, cardIds: [discardId] })
            }
          } else {
            host.state.baosanniangZhennanUnlimited ??= {}
            host.state.baosanniangZhennanUnlimited[targetId] = { ownerId, turnNumber: host.state.turnNumber }
          }
        }
        host.state.baosanniangZhennanPending = undefined
        host.state.baosanniangZhennanDamaged = undefined
      },
    },
  ],
})

function finishXushen(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (owner?.alive) {
    const recovered = Math.max(0, 1 - owner.hp)
    if (recovered > 0) {
      owner.hp += recovered
      host.dispatch('Recover', { playerId: ownerId, amount: recovered, reason: XUSHEN }, { targetId: ownerId })
    }
  }
  host.dispatch('QuitDying', { playerId: ownerId, hp: owner?.hp ?? 0, reason: XUSHEN }, { targetId: ownerId })
  host.state.dying = null
  host.resumeAfterDying()
}

registerSkillRuntime({
  id: XUSHEN,
  limited: true,
  dyingIntercept(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(XUSHEN)) return false
    host.askSkill({
      skillId: XUSHEN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '你处于濒死状态，是否发动限定技【许身】？', timeoutMs: 20_000, optional: true,
        options: [
          { id: XUSHEN_INVOKE, label: '发动【许身】：选择一名其他角色为你二选一，然后回复到1点体力' },
          { id: 'cancel', label: '不发动，继续求桃' },
        ],
      }),
    })
    return 'pending'
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const declined = (response.payload as { optionId?: string }).optionId !== XUSHEN_INVOKE
      const owner = playerOf(host.state, ownerId)
      if (declined || !owner?.alive || owner.usedLimitedSkills.includes(XUSHEN)) {
        continueDyingRescue(host)
        if (!host.state.dying) host.resumeAfterDying()
        return
      }
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) {
        continueDyingRescue(host)
        if (!host.state.dying) host.resumeAfterDying()
        return
      }
      owner.usedLimitedSkills.push(XUSHEN)
      host.askSkill({
        skillId: XUSHEN, ownerId, step: 'pick-a', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【许身】：选择一名其他角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-a') {
      const [aId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const a = playerOf(host.state, aId)
      if (!a?.alive) { finishXushen(host, ownerId); return }
      host.askSkill({
        skillId: XUSHEN, ownerId, step: 'a-choose', data: { aId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: aId,
          prompt: '【许身】：请选择', timeoutMs: 20_000, optional: false,
          options: [
            { id: 'skills', label: '失去所有可失去的技能，永久获得【征南】' },
            { id: 'zhennan', label: '永久获得【镇南】' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'a-choose') {
      const { aId } = resolution.data as { aId: PlayerId }
      const a = playerOf(host.state, aId)
      if (a?.alive) {
        const optionId = (response.payload as { optionId?: string }).optionId
        if (optionId === 'skills') {
          a.characterSkillsDisabled = true
          grantSkill(host.state, aId, ZHENGNAN_SKILL_ID)
          host.dispatch('SkillActivated', { skillId: XUSHEN, skillName: '许身', playerId: ownerId, targetId: aId, logText: `${a.nickname}失去所有可失去的技能，永久获得【征南】` }, { sourceId: ownerId, targetId: aId })
        } else {
          grantSkill(host.state, aId, ZHENNAN)
          host.dispatch('SkillActivated', { skillId: XUSHEN, skillName: '许身', playerId: ownerId, targetId: aId, logText: `${a.nickname}永久获得【镇南】` }, { sourceId: ownerId, targetId: aId })
        }
      }
      finishXushen(host, ownerId)
    }
  },
})

export const BAOSANNIANG: CharacterDefinition = {
  id: 'baosanniang',
  name: '鲍三娘',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: WUNIANG, name: '武娘', description: '你可以将一张非基本牌当【杀】使用，此杀无距离限制且不能被响应；结算后，获得目标一张牌，若这张牌不是基本牌，你可以失去1点体力，令场上所有角色的【镇南】视为未发动过。' },
    { id: ZHENNAN, name: '镇南', description: '限定技，准备阶段，你可以弃置2张牌，视为对任意数量角色使用一张【南蛮入侵】；结算后，其中受到伤害的角色随机弃置1张牌，未受到伤害的角色本回合内你对其使用【杀】无次数限制。' },
    { id: XUSHEN, name: '许身', description: '限定技，你处于濒死状态时，可以选择一名其他角色，令其选择：失去所有可失去的技能并永久获得【征南】，或永久获得【镇南】；然后你回复体力到1点。' },
  ],
}
