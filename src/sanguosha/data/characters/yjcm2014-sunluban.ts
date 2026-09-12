import { executeUseCardAction } from '../../engine/cards/basic'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { finalizeDamage } from '../../engine/damage'
import { effectiveGenderOf } from '../../engine/huashen'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { effectiveCardColor, registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { LegalAction } from '../../engine/actions'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, DamageNature, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孙鲁班（一将成名 2014）。
 *
 * 【谮毁】：出牌阶段限一次，孙鲁班使用【杀】或黑色普通 / 非延时锦囊牌且只
 *          指定一个目标时，可以选择另一名可以成为此牌目标的角色 C（不是
 *          当前唯一目标）。C 选择：交给孙鲁班一张牌，然后代替孙鲁班成为这
 *          张牌的使用者；或 C 也成为这张牌的额外目标。
 * 【骄矜】：孙鲁班受到男性角色造成的伤害时，可以弃置一张装备牌，令此伤害
 *          -1。
 *
 * 三处最容易做错的：
 *
 * 1. **谮毁 A 分支不重新支付、不复制实体牌**：拦在 `interceptPlayAction`
 *    （牌真正进入处理区之前），原动作从未开始，把同一个 `cardIds` 的
 *    动作换成 `playerId = C` 重新发起，物理牌只做一次「孙鲁班手上 → C 手上」
 *    的静默转移，不产生第二张牌。
 * 2. **骄矜是真正的伤害数值修正，且需要孙鲁班当场决定要不要付代价**：
 *    走 `BeforeDamage` 挂起询问，不发动或付不起代价时用 `finalizeDamage`
 *    原样续上原始点数；发动且减到 0 点时直接不再结算，不触发受到伤害之后
 *    的时机。
 */

const ZANHUI = 'zanhui'
const JIAOJIN = 'jiaojin'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isEligibleCard(state: SanguoshaState, ownerId: PlayerId, action: LegalAction): boolean {
  if (action.kind !== 'use-card' || action.playerId !== ownerId) return false
  if (action.targetIds.length !== 1) return false
  const cardId = action.cardIds[0]
  const card = state.cards[cardId]
  if (!card) return false
  if (action.asCardName === '杀') return true
  if (card.category !== 'trick' || DELAYED_TRICKS.has(action.asCardName)) return false
  return effectiveCardColor(state, ownerId, cardId) === 'black'
}

registerSkillRuntime({
  id: ZANHUI,
  interceptPlayAction(host, ownerId, action) {
    if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return false
    if (usedThisPhase(host.state, ownerId, ZANHUI)) return false
    if (!isEligibleCard(host.state, ownerId, action)) return false
    const soleTarget = action.targetIds[0]
    const candidateIds = host.state.players
      .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.id !== soleTarget)
      .map((candidate) => candidate.id)
    if (candidateIds.length === 0) return false
    host.askSkill({
      skillId: ZANHUI, ownerId, step: 'ask', data: { action },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '发动【谮毁】？选择另一名角色 C，令其代替使用或追加为目标',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【谮毁】' }, { id: 'no', label: '正常使用' }],
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    const action = resolution.data.action as Extract<LegalAction, { kind: 'use-card' }>

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner?.alive) {
        executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
        return
      }
      const soleTarget = action.targetIds[0]
      const candidateIds = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.id !== soleTarget)
        .map((candidate) => candidate.id)
      if (candidateIds.length === 0) {
        executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
        return
      }
      markUsedThisPhase(host.state, ownerId, ZANHUI)
      host.askSkill({
        skillId: ZANHUI, ownerId, step: 'choose-c', data: { action },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【谮毁】：选择另一名角色 C',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'choose-c') {
      const [cId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const c = cId ? playerOf(host.state, cId) : undefined
      if (!c?.alive || !owner?.alive) {
        executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
        return
      }
      host.askSkill({
        skillId: ZANHUI, ownerId, step: 'c-choice', data: { action, cId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: cId!,
          prompt: `${owner.nickname}发动【谮毁】：选择一项`,
          timeoutMs: 20_000, optional: false,
          options: [
            ...(c.zones.hand.length > 0 ? [{ id: 'replace', label: '交给孙鲁班一张牌，代替她成为使用者' }] : []),
            { id: 'target', label: '成为这张牌的额外目标' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'c-choice') {
      const cId = resolution.data.cId as PlayerId
      const c = playerOf(host.state, cId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!c?.alive || !owner?.alive) {
        executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
        return
      }
      if (optionId === 'replace' && c.zones.hand.length > 0) {
        host.askSkill({
          skillId: ZANHUI, ownerId, step: 'give-pick', data: { action, cId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: cId,
            prompt: '【谮毁】：交给孙鲁班一张牌',
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: [...c.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      // B：C 追加为额外目标，原使用者、原目标不变
      executeUseCardAction(host as never, ownerId, { ...action, targetIds: [...action.targetIds, cId] }, { skipPlayInterceptors: true })
      return
    }

    if (resolution.step === 'give-pick') {
      const action = resolution.data.action as Extract<LegalAction, { kind: 'use-card' }>
      const cId = resolution.data.cId as PlayerId
      const c = playerOf(host.state, cId)
      const [giveCardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!c?.alive || !owner?.alive || !giveCardId || !c.zones.hand.includes(giveCardId)) {
        executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
        return
      }
      moveCard(host.state, giveCardId, { kind: 'hand', playerId: cId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [giveCardId], reason: ZANHUI }, { sourceId: cId, targetId: ownerId, cardIds: [giveCardId] })
      // 使用者替换：同一张实体牌，静默转移到 C 手上，再由 C 重新发起这次使用
      const usedCardId = action.cardIds[0]
      if (!c.zones.hand.includes(usedCardId) && playerOf(host.state, ownerId)?.zones.hand.includes(usedCardId)) {
        moveCard(host.state, usedCardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: cId })
      }
      host.dispatch('SkillActivated', {
        skillId: ZANHUI, skillName: '谮毁', playerId: ownerId, targetId: cId,
        logText: `${owner.nickname}发动【谮毁】，${c.nickname}代替她成为这次使用的使用者`,
      }, { sourceId: ownerId, targetId: cId })
      executeUseCardAction(host as never, cId, { ...action, playerId: cId }, { skipPlayInterceptors: true })
    }
  },
})

// ─────────────────────────────── 骄矜 ───────────────────────────────

function equipmentCandidatesOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return [
    ...owner.zones.hand.filter((cardId) => state.cards[cardId]?.category === 'equipment'),
    ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
  ]
}

registerSkillRuntime({
  id: JIAOJIN,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const sourceId = context.event.sourceId as PlayerId | undefined
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      if (!source?.alive) return
      if (effectiveGenderOf(host.state, source.id) !== 'male') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || equipmentCandidatesOf(host.state, ownerId).length === 0) return
      // 属性伤害传导是同步 while 循环，挂起发问会打乱它，骄矜不掺和
      if (host.state.damageChain) return
      // 群体锦囊的多目标结算会同步推进到下一个目标，骄矜同样不掺和
      if (host.state.cardResolution?.kind === 'trick') return
      // 已经有别的技能在这次事件里挂起发问了，不重复挤占同一个 skillResolution
      if (host.state.skillResolution) return
      const payload = context.event.payload as { amount?: number; cardId?: CardId; cardName?: string; redirectedBy?: string }
      const amount = typeof payload.amount === 'number' ? payload.amount : 0
      if (amount <= 0) return
      context.cancel()
      host.askSkill({
        skillId: JIAOJIN, ownerId, step: 'ask',
        data: {
          sourceId, amount, nature: (context.event.damageNature ?? 'normal') as DamageNature,
          cardId: payload.cardId ?? null, cardName: payload.cardName ?? null, redirectedBy: payload.redirectedBy ?? null,
        },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【骄矜】：弃置一张装备牌，令此伤害 -1？',
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动【骄矜】' }, { id: 'no', label: '不发动' }],
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask' && resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const sourceId = resolution.data.sourceId as PlayerId | null
    const amount = resolution.data.amount as number
    const nature = resolution.data.nature as DamageNature
    const cardId = resolution.data.cardId as CardId | null
    const cardName = resolution.data.cardName as string | null
    const redirectedBy = resolution.data.redirectedBy as string | null

    const reapply = (finalAmount: number): void => {
      if (finalAmount <= 0) return
      const target = playerOf(host.state, ownerId)
      if (!target?.alive) return
      finalizeDamage(host as never, target, sourceId, finalAmount, nature, cardId, cardName, redirectedBy, false)
    }

    const discard = (pickedId: CardId): void => {
      if (!owner) return
      const from = owner.zones.hand.includes(pickedId)
        ? { kind: 'hand' as const, playerId: ownerId }
        : { kind: 'equipment' as const, playerId: ownerId, slot: Object.entries(owner.zones.equipment).find(([, id]) => id === pickedId)?.[0] as never }
      moveCard(host.state, pickedId, from, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [pickedId], reason: JIAOJIN }, { targetId: ownerId, cardIds: [pickedId] })
      host.dispatch('SkillActivated', {
        skillId: JIAOJIN, skillName: '骄矜', playerId: ownerId,
        logText: `${owner.nickname}发动【骄矜】，此伤害 -1`,
      }, { sourceId: ownerId })
      reapply(amount - 1)
    }

    if (resolution.step === 'discard') {
      const [pickedId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !pickedId || !equipmentCandidatesOf(host.state, ownerId).includes(pickedId)) { reapply(amount); return }
      discard(pickedId)
      return
    }

    const accepted = (response.payload as { optionId?: string }).optionId === 'yes'
    if (!accepted || !owner?.alive) { reapply(amount); return }
    const candidates = equipmentCandidatesOf(host.state, ownerId)
    if (candidates.length === 0) { reapply(amount); return }
    if (candidates.length === 1) { discard(candidates[0]); return }
    host.askSkill({
      skillId: JIAOJIN, ownerId, step: 'discard', data: { sourceId, amount, nature, cardId, cardName, redirectedBy },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【骄矜】：弃置一张装备牌',
        timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
})

export const SUNLUBAN: CharacterDefinition = {
  id: 'sunluban',
  name: '孙鲁班',
  kingdom: 'wu',
  gender: 'female',
  maxHp: 3,
  pack: 'yjcm2014',
  skills: [
    {
      id: ZANHUI,
      name: '谮毁',
      description: '出牌阶段限一次，孙鲁班使用【杀】或黑色普通 / 非延时锦囊牌且只指定一个目标时，可以选择另一名可以成为此牌目标的角色 C（不是当前唯一目标）。C 选择：交给孙鲁班一张牌，然后代替孙鲁班成为这张牌的使用者；或 C 也成为这张牌的额外目标。',
    },
    {
      id: JIAOJIN,
      name: '骄矜',
      description: '孙鲁班受到男性角色造成的伤害时，可以弃置一张装备牌，令此伤害 -1。',
    },
  ],
}
