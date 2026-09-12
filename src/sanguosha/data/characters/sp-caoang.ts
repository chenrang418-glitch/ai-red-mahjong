import { drawCards } from '../../engine/draw'
import { getDistance } from '../../engine/distance'
import { executeUseCardAction } from '../../engine/cards/basic'
import { moveCard } from '../../engine/zones'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹昂（三国杀 OL 经典身份 SP）。
 *
 * 【慷忾】：一名角色成为【杀】的目标后，若曹昂与该角色距离 ≤ 1，曹昂可以
 *          摸一张牌，然后展示并交给该角色一张牌；若这张牌是装备牌且目标
 *          不是曹昂自己，目标可以立即使用（装备）这张牌。
 *
 * 最容易做错的：**给出的是曹昂当前拥有的任意一张手牌，不必是刚摸的那张**
 * （摸牌在给牌之前，只是让候选池多一张，不绑定必须给哪张）；装备使用走
 * 既有的 `executeUseCardAction`（和使用者选择自己装备完全同一条管线），
 * 不手写「牌进装备区」——那样会漏掉装备替换、栏位校验这些既有规则。
 */

const KANGKAI = 'kangkai'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: KANGKAI,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; targetId?: PlayerId }
      if (payload.cardName !== '杀') return
      const targetId = payload.targetId ?? context.event.targetId
      if (!targetId) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      if (getDistance(host.state, ownerId, targetId) > 1) return
      host.queueSkill({ skillId: KANGKAI, ownerId, step: 'ask', data: { targetId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const targetId = prompt.data.targetId as PlayerId
    if (!playerOf(host.state, targetId)?.alive) return
    host.askSkill({
      skillId: KANGKAI, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【慷忾】：摸一张牌，然后展示并交给目标一张牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【慷忾】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      host.dispatch('SkillActivated', {
        skillId: KANGKAI, skillName: '慷忾', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【慷忾】，摸一张牌`,
      }, { sourceId: ownerId, targetId })
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      if (owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: KANGKAI, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【慷忾】：展示并交给${target.nickname}一张牌`,
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const targetId = resolution.data.targetId as PlayerId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !target?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      const card = host.state.cards[cardId]
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('CardMove', { cardIds: [cardId], reason: KANGKAI, revealed: true }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: KANGKAI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      if (card?.category === 'equipment' && targetId !== ownerId) {
        host.askSkill({
          skillId: KANGKAI, ownerId, step: 'equip', data: { targetId, cardId },
          build: (requestId): ChooseOptionRequest => ({
            id: requestId, kind: 'choose-option', playerId: targetId,
            prompt: `是否立即使用（装备）这张【${card.name}】？`,
            timeoutMs: 20_000, optional: true,
            options: [{ id: 'yes', label: `装备【${card.name}】` }, { id: 'no', label: '不装备' }],
          }),
        })
      }
      return
    }

    if (resolution.step === 'equip') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = resolution.data.cardId as CardId
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const target = playerOf(host.state, targetId)
      if (!target?.alive || !target.zones.hand.includes(cardId)) return
      const card = host.state.cards[cardId]
      if (!card || card.category !== 'equipment') return
      executeUseCardAction(host as never, targetId, {
        kind: 'use-card', id: `kangkai-equip:${cardId}`, playerId: targetId,
        cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1,
        asCardName: card.name, label: `装备【${card.name}】`,
      })
    }
  },
})

export const CAOANG: CharacterDefinition = {
  id: 'caoang',
  name: '曹昂',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    {
      id: KANGKAI,
      name: '慷忾',
      description: '一名角色成为【杀】的目标后，若曹昂与该角色距离不超过 1，曹昂可以摸一张牌，然后展示并交给该角色一张牌；若这张牌是装备牌且目标不是曹昂自己，目标可以立即使用这张牌。',
    },
  ],
}
