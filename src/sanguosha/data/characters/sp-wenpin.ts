import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 文聘（三国杀 OL 经典身份 SP）。
 *
 * 【镇卫】：其他角色A成为一张【杀】或黑色锦囊的唯一目标，且A.currentHp<
 *          文聘.currentHp、使用者不是文聘时，文聘可以弃置1张牌，然后选择：
 *          A.令A摸1张牌，由文聘代替其成为目标；B.令这张牌整体无效并移出
 *          游戏，直到本回合结束归还使用者。
 */

const ZHENWEI = 'zhenwei'
const REMOVED_PILE = 'zhenwei-removed'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: ZHENWEI,
  interceptBystanderTarget(host, ownerId, context) {
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, context.targetId)
    if (!owner?.alive || !target?.alive || owner.zones.hand.length === 0) return false
    if (context.sourceId === ownerId || target.hp >= owner.hp) return false
    const card = host.state.cards[context.cardId]
    const isBlackTrick = context.category === 'trick' && card?.color === 'black'
    if (context.cardName !== '杀' && !isBlackTrick) return false
    const totalTargets = host.state.cardResolution?.kind === 'trick' ? host.state.cardResolution.targetIds.length : 1
    if (totalTargets !== 1) return false
    host.askSkill({
      skillId: ZHENWEI, ownerId, step: 'discard-ask', data: { targetId: context.targetId, sourceId: context.sourceId, cardId: context.cardId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【镇卫】：弃置1张牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'discard-ask') {
      const { targetId, sourceId, cardId } = resolution.data as { targetId: PlayerId; sourceId: PlayerId; cardId: CardId }
      const [discardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!discardId || !owner.zones.hand.includes(discardId)) { host.resumeCardTarget(); return }
      moveCard(host.state, discardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [discardId], reason: ZHENWEI }, { sourceId: ownerId, cardIds: [discardId] })
      host.askSkill({
        skillId: ZHENWEI, ownerId, step: 'choice', data: { targetId, sourceId, cardId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【镇卫】：选择一项', timeoutMs: 20_000, optional: false,
          options: [{ id: 'replace', label: '令其摸1张牌，由我代替成为目标' }, { id: 'remove', label: '此牌整体无效并移出游戏' }],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const { targetId, sourceId, cardId } = resolution.data as { targetId: PlayerId; sourceId: PlayerId; cardId: CardId }
      const optionId = (response.payload as { optionId?: string }).optionId
      const target = playerOf(host.state, targetId)
      host.dispatch('SkillActivated', { skillId: ZHENWEI, skillName: '镇卫', playerId: ownerId, logText: `${owner.nickname}发动【镇卫】` }, { sourceId: ownerId, targetId })

      if (optionId === 'replace' && target?.alive) {
        drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
        const current = host.state.cardResolution
        if (current?.kind === 'slash' && current.targetId === targetId) current.targetId = ownerId
        else if (current?.kind === 'trick') {
          const index = current.targetIds.indexOf(targetId)
          if (index >= 0) current.targetIds[index] = ownerId
        }
        host.resumeCardTarget()
        return
      }

      // 令整张牌无效并移出游戏：取消这个（唯一）目标，实体牌随后由
      // resolvedCardRecipient 接住送进文聘手里，再由 GainCard 触发搬去暗置区。
      const current = host.state.cardResolution
      if (current?.kind === 'slash') current.targetCancelled = true
      else if (current?.kind === 'trick' && !current.cancelledTargetIds.includes(targetId)) current.cancelledTargetIds.push(targetId)
      host.state.wenpinRemoveArmed = { ownerId, cardId, sourceId, turnNumber: host.state.turnNumber }
      host.resumeCardTarget()
    }
  },
  resolvedCardRecipient(state, ownerId, context) {
    const armed = state.wenpinRemoveArmed
    return !!armed && armed.ownerId === ownerId && armed.cardId === context.cardId
  },
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      const armed = host.state.wenpinRemoveArmed
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (!armed || armed.ownerId !== ownerId || payload.playerId !== ownerId || !payload.cardIds?.includes(armed.cardId)) return
      host.state.wenpinRemoveArmed = undefined
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !owner.zones.hand.includes(armed.cardId)) return
      moveCard(host.state, armed.cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: REMOVED_PILE })
      host.state.wenpinRemoved ??= []
      host.state.wenpinRemoved.push({ cardId: armed.cardId, originalUserId: armed.sourceId, turnNumber: armed.turnNumber })
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId) {
      const list = host.state.wenpinRemoved
      if (!list || list.length === 0) return
      const due = list.filter((entry) => entry.turnNumber === host.state.turnNumber)
      if (due.length === 0) return
      host.state.wenpinRemoved = list.filter((entry) => entry.turnNumber !== host.state.turnNumber)
      const owner = playerOf(host.state, ownerId)
      for (const entry of due) {
        if (!owner?.characterPiles[REMOVED_PILE]?.includes(entry.cardId)) continue
        const recipient = playerOf(host.state, entry.originalUserId)
        const to = recipient?.alive ? { kind: 'hand' as const, playerId: recipient.id } : { kind: 'discardPile' as const }
        moveCard(host.state, entry.cardId, { kind: 'characterPile', playerId: ownerId, pile: REMOVED_PILE }, to)
        if (to.kind === 'hand') host.dispatch('GainCard', { playerId: to.playerId, cardIds: [entry.cardId], reason: ZHENWEI }, { targetId: to.playerId, cardIds: [entry.cardId] })
      }
    },
  }],
})

export const WENPIN: CharacterDefinition = {
  id: 'wenpin',
  name: '文聘',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: ZHENWEI, name: '镇卫', description: '其他角色成为一张【杀】或黑色锦囊的唯一目标，且体力值小于你、使用者不是你时，你可以弃置1张牌，然后：令其摸1张牌并由你代替成为目标；或令这张牌整体无效并移出游戏，本回合结束时归还使用者。' },
  ],
}
