import { executeUseCardAction } from '../../engine/cards/basic'
import { useAction } from '../../engine/cards/host'
import { canTarget, getAttackRange } from '../../engine/distance'
import { effectiveCardColor, registerSkillRuntime } from '../../engine/skills/runtime'
import { effectiveCardName, moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 周仓（一将成名 2014）。
 *
 * 【忠勇】：周仓使用的【杀】结算完毕后，可以选择这张【杀】，或目标在此结算
 *          中打出过的一张【闪】，将其交给一名角色。若获得的牌是红色，获得
 *          者可以对周仓攻击范围内的一名角色使用一张【杀】。
 *
 * 三处最容易做错的：
 *
 * 1. **候选牌必须当前仍在弃牌堆里**：结算完之后可能已经被别的效果拿走，
 *    这里只认「现在还在」的那一张，不能凭空复制。
 * 2. **获得者用的是他自己真实的【杀】**，忠勇不生成虚拟杀，只是给了一次
 *    「对谁使用」的额外授权——目标范围按周仓的攻击范围算，不是获得者的。
 * 3. **闪的候选只认这次结算里真实打出、且仍取得到的那一张**，不能因为
 *    「找一张闪」而泄漏目标其它手牌。
 */

const ZHONGYONG = 'zhongyong'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: ZHONGYONG,
  triggers: [
    {
      // 记下这次结算里目标真实打出的那张闪，供忠勇选用；不泄露其它手牌。
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string; cardId?: CardId }
        if (payload.cardName !== '闪' || context.event.targetId !== ownerId) return
        if (!payload.cardId) return
        host.state.lastSlashDodgeCard ??= {}
        host.state.lastSlashDodgeCard[ownerId] = payload.cardId
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cardName?: string }
        if (context.event.sourceId !== ownerId || payload.cardName !== '杀') return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const dodgeCardId = host.state.lastSlashDodgeCard?.[ownerId]
        if (host.state.lastSlashDodgeCard) delete host.state.lastSlashDodgeCard[ownerId]
        const candidates = [payload.cardId, dodgeCardId]
          .filter((cardId): cardId is CardId => Boolean(cardId) && host.state.zones.discardPile.includes(cardId!))
        const unique = [...new Set(candidates)]
        if (unique.length === 0) return
        // 排队而不是当场问：这个出牌阶段可能还有别的角色技能同时挂起发问。
        host.queueSkill({ skillId: ZHONGYONG, ownerId, step: 'pick', data: { candidates: unique } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const unique = (prompt.data.candidates as CardId[]).filter((cardId) => host.state.zones.discardPile.includes(cardId))
    if (unique.length === 0) return
    host.askSkill({
      skillId: ZHONGYONG, ownerId, step: 'pick',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【忠勇】：选择这张【杀】或目标打出的【闪】，交给一名角色',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: unique, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'pick') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner?.alive || !host.state.zones.discardPile.includes(cardId)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: ZHONGYONG, ownerId, step: 'recipient', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【忠勇】：交给一名角色',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'recipient') {
      const cardId = resolution.data.cardId as CardId
      const [recipientId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const recipient = recipientId ? playerOf(host.state, recipientId) : undefined
      if (!owner?.alive || !recipient?.alive || !host.state.zones.discardPile.includes(cardId)) return
      const color = effectiveCardColor(host.state, recipientId!, cardId)
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: recipientId! })
      host.dispatch('GainCard', { playerId: recipientId, cardIds: [cardId], reason: ZHONGYONG }, { sourceId: ownerId, targetId: recipientId, cardIds: [cardId] })
      host.dispatch('SkillActivated', {
        skillId: ZHONGYONG, skillName: '忠勇', playerId: ownerId, targetId: recipientId,
        logText: `${owner.nickname}发动【忠勇】，${recipient.nickname}获得一张牌`,
      }, { sourceId: ownerId, targetId: recipientId })
      if (color !== 'red') return

      const range = getAttackRange(host.state, ownerId)
      const rangeTargets = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== recipientId && canTarget(host.state, ownerId, candidate.id, range))
        .map((candidate) => candidate.id)
      const slashCards = recipient.zones.hand.filter((candidateId) => effectiveCardName(host.state, candidateId) === '杀')
      if (rangeTargets.length === 0 || slashCards.length === 0) return
      host.askSkill({
        skillId: ZHONGYONG, ownerId, step: 'bonus-card', data: { recipientId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: recipientId!,
          prompt: '获得的牌是红色：可以对周仓攻击范围内一名角色使用一张【杀】',
          timeoutMs: 20_000, optional: true, purpose: 'skill',
          cardIds: slashCards, hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'bonus-card') {
      const recipientId = resolution.data.recipientId as PlayerId
      const recipient = playerOf(host.state, recipientId)
      const [slashCardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!recipient?.alive || !slashCardId || !recipient.zones.hand.includes(slashCardId)) return
      const range = getAttackRange(host.state, ownerId)
      const rangeTargets = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== recipientId && canTarget(host.state, ownerId, candidate.id, range))
        .map((candidate) => candidate.id)
      if (rangeTargets.length === 0) return
      host.askSkill({
        skillId: ZHONGYONG, ownerId, step: 'bonus-target', data: { recipientId, slashCardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: recipientId,
          prompt: '选择攻击范围内一名角色（按周仓的攻击范围）',
          timeoutMs: 20_000, optional: false,
          candidateIds: rangeTargets, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'bonus-target') {
      const recipientId = resolution.data.recipientId as PlayerId
      const slashCardId = resolution.data.slashCardId as CardId
      const recipient = playerOf(host.state, recipientId)
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!recipient?.alive || !targetId || !recipient.zones.hand.includes(slashCardId)) return
      const action = useAction(slashCardId, recipientId, '杀', [targetId], '')
      if (action.kind !== 'use-card') return
      executeUseCardAction(host as never, recipientId, action)
    }
  },
})

export const ZHOUCANG: CharacterDefinition = {
  id: 'zhoucang',
  name: '周仓',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2014',
  skills: [
    {
      id: ZHONGYONG,
      name: '忠勇',
      description: '周仓使用的【杀】结算完毕后，可以选择这张【杀】，或目标在此结算中打出过的一张【闪】，将其交给一名角色。若获得的牌是红色，获得者可以对周仓攻击范围内的一名角色使用一张【杀】。',
    },
  ],
}
