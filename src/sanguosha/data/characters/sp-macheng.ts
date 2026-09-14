import { moveCard } from '../../engine/zones'
import { recover } from '../../engine/recover'
import { giveCards } from '../../engine/hand-transfer'
import { openPrivateZone, closePrivateZone } from '../../engine/private-zone'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 马承（三国杀 OL 经典身份 SP）。
 *
 * 【马术】：直接复用既有距离修正，你与其他角色的距离-1。
 * 【骋烈】：你使用【杀】可以额外指定至多2名目标；亮出牌堆顶X张牌（X为最终
 *          目标数），你可以将其中1张与你1张手牌秘密交换，然后将这X张牌
 *          分别暗置于各目标的武将牌上，称为"骋烈牌"，只持续到这张杀结算
 *          结束。红色骋烈牌：结算结束时若对应目标响应了此杀，其交给你1张
 *          牌；若未响应，其回复1点体力。
 *
 * 骋烈牌的暗置用私有牌区实现（只有马承能看到内容）；红色效果统一放在
 * 这张杀完全结算之后（`AfterCardUse`）一次性处理——多目标杀的引擎里没有
 * 逐目标的"这一个目标已经了结"事件，这是相对文本的一处简化，但每个目标
 * 是否响应、最终是否存活都已经确定，结果与文本一致。
 */

const MASHU = 'macheng-mashu'
const CHENGLIE = 'chenglie'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: MASHU,
  distanceModifier: { toOthers: -1 },
})

registerSkillRuntime({
  id: CHENGLIE,
  extraSlashTargets() { return 2 },
  interceptSourceTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || host.state.machengPending) return false
    const resolution = host.state.cardResolution
    if (resolution?.kind !== 'slash') return false
    const targetIds = [resolution.targetId, ...resolution.remainingTargetIds]
    if (targetIds.length === 0) return false
    const x = targetIds.length
    if (host.state.zones.drawPile.length < x) return false
    const top = host.state.zones.drawPile.slice(0, x)
    for (const cardId of top) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    host.dispatch('CardMove', { cardIds: top, reason: CHENGLIE, revealed: true }, { sourceId: ownerId })
    host.dispatch('SkillActivated', { skillId: CHENGLIE, skillName: '骋烈', playerId: ownerId, logText: `${playerOf(host.state, ownerId)!.nickname}发动【骋烈】，亮出${x}张牌` }, { sourceId: ownerId })
    const owner = playerOf(host.state, ownerId)
    host.state.machengPending = { ownerId, targetIds, revealed: top, responded: [] }
    // 没有手牌可秘密交换：直接落地暗置，同步完成，不产生等待中的请求，
    // 所以这里必须返回 false（不是 true），交回正常结算流程；也不能调
    // resumeCardTarget——那是配合"已挂起"状态用的，这里从没挂起过。
    if (!owner?.zones.hand.length) { distributeChenglie(host, ownerId); return false }
    host.askSkill({
      skillId: CHENGLIE, ownerId, step: 'ask-swap', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【骋烈】：可以选择1张手牌与展示牌中的1张秘密交换', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask-swap') {
      const [ownCardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !ownCardId || !owner.zones.hand.includes(ownCardId)) { distributeChenglie(host, ownerId); host.resumeCardTarget(); return }
      const pending = host.state.machengPending
      if (!pending || pending.ownerId !== ownerId) return
      host.askSkill({
        skillId: CHENGLIE, ownerId, step: 'pick-swap', data: { ownCardId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【骋烈】：选择展示牌中的1张换到手里', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: pending.revealed, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-swap') {
      const { ownCardId } = resolution.data as { ownCardId: CardId }
      const [revealedId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      const pending = host.state.machengPending
      if (owner?.alive && pending && revealedId && pending.revealed.includes(revealedId) && owner.zones.hand.includes(ownCardId)) {
        moveCard(host.state, ownCardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
        moveCard(host.state, revealedId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [revealedId], reason: CHENGLIE }, { targetId: ownerId, cardIds: [revealedId] })
        pending.revealed = pending.revealed.map((id) => (id === revealedId ? ownCardId : id))
      }
      distributeChenglie(host, ownerId)
      host.resumeCardTarget()
    }
  },
  triggers: [
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const pending = host.state.machengPending
        if (!pending || pending.ownerId !== ownerId || context.event.targetId !== ownerId) return
        const payload = context.event.payload as { cardName?: string; playerId?: PlayerId }
        if (payload.cardName !== '闪' || !payload.playerId) return
        if (!pending.responded.includes(payload.playerId)) pending.responded.push(payload.playerId)
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const pending = host.state.machengPending
        if (!pending || pending.ownerId !== ownerId || context.event.sourceId !== ownerId) return
        host.state.machengPending = undefined
        for (const targetId of pending.targetIds) {
          const zoneId = `chenglie-${ownerId}-${targetId}`
          const cards = closePrivateZone(host.state, zoneId, { kind: 'discardPile' })
          const cardId = cards[0]
          if (!cardId) continue
          const target = playerOf(host.state, targetId)
          if (!target?.alive) continue
          if (host.state.cards[cardId]?.color !== 'red') continue
          if (pending.responded.includes(targetId)) {
            const [handCard] = target.zones.hand
            if (handCard) giveCards(host as never, targetId, ownerId, [handCard], CHENGLIE)
          } else if (target.hp < target.maxHp) {
            recover(host as never, targetId, 1, ownerId)
          }
        }
      },
    },
  ],
})

/** 纯数据落地：把展示牌分别暗置到各目标身上。不碰结算流程的挂起/恢复。 */
function distributeChenglie(host: SkillHost, ownerId: PlayerId): void {
  const pending = host.state.machengPending
  if (!pending) return
  for (const targetId of pending.targetIds) {
    const cardId = pending.revealed.shift()
    if (!cardId) continue
    if (!host.state.zones.processingArea.includes(cardId)) continue
    const zoneId = `chenglie-${ownerId}-${targetId}`
    openPrivateZone(host.state, zoneId, ownerId, CHENGLIE)
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'privateZone', zoneId })
  }
}

export const MACHENG: CharacterDefinition = {
  id: 'macheng',
  name: '马承',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: MASHU, name: '马术', description: '你计算与其他角色的距离-1。' },
    { id: CHENGLIE, name: '骋烈', description: '你使用杀可以额外指定至多2名目标；亮出牌堆顶X张牌（X为最终目标数），可以将其中1张与你1张手牌秘密交换，然后将这X张牌分别暗置于各目标武将牌上，称为"骋烈牌"，只持续到这张杀结算结束。红色骋烈牌：结算结束时若对应目标响应了此杀，其交给你1张牌；若未响应，其回复1点体力。' },
  ],
}
