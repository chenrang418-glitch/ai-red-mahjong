import { drawCards } from '../../engine/draw'
import { effectiveCardColor, registerSkillRuntime } from '../../engine/skills/runtime'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 关平（一将成名 2013）。
 *
 * 【龙吟】：每当一名角色于其出牌阶段内使用【杀】时，关平可以弃置一张牌，
 *          若如此做，这张【杀】不计入其出牌阶段使用次数的限制；
 *          若这张【杀】为红色，关平摸一张牌。
 *
 * 两处最容易做错的：
 *
 * 1. **「不计入次数」是把这一次用掉的次数还回去**，不是给使用者整个回合
 *    额外一次机会——用 `grantTurnSlashBonus` 的 `extraUses: 1` 正好抵消
 *    这一次已经计入的用量，语义是「这张不算」而不是「多给一张」。
 * 2. **红色判断按有效颜色**：转化出来的【杀】没有实体牌时（`cardId` 为空）
 *    没有颜色可言，不算红色。
 */

const LONGYIN = 'longyin'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: LONGYIN,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; virtual?: boolean }
      if (payload.cardName !== '杀') return
      if (host.state.phase !== 'play') return
      const userId = context.event.sourceId as PlayerId | undefined
      if (!userId) return
      const user = playerOf(host.state, userId)
      if (!user?.alive) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      host.queueSkill({ skillId: LONGYIN, ownerId, step: 'ask', data: { userId, cardId: payload.cardId ?? null, virtual: payload.virtual === true } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: LONGYIN, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【龙吟】：弃置一张牌，令这张【杀】不计入使用次数？',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: [
          ...owner.zones.hand,
          ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
        ], hiddenCardSlots: [],
        min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const userId = resolution.data.userId as PlayerId
    const slashCardId = resolution.data.cardId as CardId | null
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const costSource = cardId && owner?.alive ? locateOwnedCard(host.state, ownerId, cardId) : null
    if (!cardId || !owner?.alive || !costSource) return
    const user = playerOf(host.state, userId)
    if (!user?.alive) return

    moveCard(host.state, cardId, costSource, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: LONGYIN }, { targetId: ownerId, cardIds: [cardId] })
    grantTurnSlashBonus(host.state, userId, { extraUses: 1 })
    host.dispatch('SkillActivated', {
      skillId: LONGYIN, skillName: '龙吟', playerId: ownerId, targetId: userId,
      logText: `${owner.nickname}发动【龙吟】，${user.nickname}的这张【杀】不计入使用次数`,
    }, { sourceId: ownerId, targetId: userId })

    const virtual = resolution.data.virtual === true
    if (!virtual && slashCardId && host.state.cards[slashCardId] && effectiveCardColor(host.state, userId, slashCardId) === 'red') {
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

export const GUANPING: CharacterDefinition = {
  id: 'guanping',
  name: '关平',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2013',
  skills: [
    {
      id: LONGYIN,
      name: '龙吟',
      description: '每当一名角色于其出牌阶段内使用【杀】时，关平可以弃置一张牌，若如此做，这张【杀】不计入其出牌阶段使用次数的限制；若这张【杀】为红色，关平摸一张牌。',
    },
  ],
}
