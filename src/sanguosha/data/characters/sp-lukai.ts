import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陆凯（三国杀 OL 经典身份 SP，玄注/謇谔版本——不是卜筮/忠壮）。
 *
 * 【玄注】：转换技，每个 TurnInstance 限一次。阳时，移出一张手牌（进入陆凯
 *          专属的移出区，走 `characterPiles`，不是弃牌堆），视为对一名角色
 *          使用一张【杀】（复用 `beginVirtualSlash`）；阴时，移出一张手牌，
 *          视为对一名角色使用【过河拆牌】式效果——拿走其一张手牌或装备牌
 *          并弃置。引擎没有「视为使用任意普通锦囊」的通用入口，本实现按
 *          过河拆桥的效果手动结算，不经过完整的锦囊结算/无懈可击管线，
 *          这是相对官方文本的已知简化。非装备牌之后弃置，装备牌之后重铸。
 *          发动后阴阳翻转。
 * 【謇谔】：锁定技，陆凯对其他角色使用的牌生效后，该角色本回合不能抵消牌；
 *          陆凯抵消一张牌后，本回合不能成为牌的目标。
 */

const XUANZHU = 'xuanzhu'
const JIANE = 'jiane'
const REMOVED_PILE = 'xuanzhu-removed'
const YIN_MARK = 'xuanzhu-yin'
const TURN_MARK = 'xuanzhu-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: XUANZHU,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return []
    if (owner.marks[TURN_MARK] === state.turnNumber) return []
    const isYin = (owner.marks[YIN_MARK] ?? 0) > 0
    return [{ id: XUANZHU, label: isYin ? '玄注（阴）：移出一张牌，视为使用过河拆桥式效果' : '玄注（阳）：移出一张牌，视为使用一张杀' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== XUANZHU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.marks[TURN_MARK] === host.state.turnNumber) return
    host.askSkill({
      skillId: XUANZHU, ownerId, step: 'pick',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【玄注】：移出一张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId) || owner.marks[TURN_MARK] === host.state.turnNumber) return
      owner.marks[TURN_MARK] = host.state.turnNumber
      const isYin = (owner.marks[YIN_MARK] ?? 0) > 0
      owner.marks[YIN_MARK] = isYin ? 0 : 1
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: REMOVED_PILE })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: XUANZHU }, { sourceId: ownerId, cardIds: [cardId] })
      const isEquipment = host.state.cards[cardId]?.category === 'equipment'
      host.dispatch('SkillActivated', { skillId: XUANZHU, skillName: '玄注', playerId: ownerId, logText: `${owner.nickname}发动【玄注】（${isYin ? '阴' : '阳'}）` }, { sourceId: ownerId })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: XUANZHU, ownerId, step: 'target', data: { removedCardId: cardId, isEquipment, wasYin: isYin },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: isYin ? '【玄注】：选择一名角色，拿走其一张牌并弃置' : '【玄注】：视为使用一张杀，选择目标',
          timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const { removedCardId, isEquipment, wasYin } = resolution.data as { removedCardId: CardId; isEquipment: boolean; wasYin: boolean }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined

      // 阳分支的虚拟杀走引擎自己的结算管线（可能异步挂起求闪），必须放在
      // 玄注自身的技能问答链**结束之后**再触发，不能夹在两次 askSkill 之间。
      if (target?.alive && wasYin) {
        const pool: Array<{ cardId: CardId; from: 'hand' | 'equipment'; slot?: string }> = [
          ...target.zones.hand.map((id) => ({ cardId: id, from: 'hand' as const })),
          ...Object.entries(target.zones.equipment).filter(([, id]) => id).map(([slot, id]) => ({ cardId: id as CardId, from: 'equipment' as const, slot })),
        ]
        if (pool.length > 0) {
          const picked = pool[host.rng.nextInt(pool.length)]
          if (picked.from === 'hand') moveCard(host.state, picked.cardId, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
          else moveCard(host.state, picked.cardId, { kind: 'equipment', playerId: target.id, slot: picked.slot as never }, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: target.id, cardIds: [picked.cardId], reason: XUANZHU }, { sourceId: target.id, cardIds: [picked.cardId] })
        }
      }

      const pileHasCard = host.state.players.find((candidate) => candidate.id === ownerId)?.characterPiles[REMOVED_PILE]?.includes(removedCardId)
      if (pileHasCard) {
        if (isEquipment) {
          moveCard(host.state, removedCardId, { kind: 'characterPile', playerId: ownerId, pile: REMOVED_PILE }, { kind: 'discardPile' }, { discardReason: 'other' })
          host.dispatch('LoseCard', { playerId: ownerId, cardIds: [removedCardId], reason: 'recast' }, { sourceId: ownerId, cardIds: [removedCardId] })
          drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
        } else if (owner.zones.hand.length > 0) {
          host.askSkill({
            skillId: XUANZHU, ownerId, step: 'discard-choice', data: { removedCardId, targetId: target?.alive && !wasYin ? target.id : null },
            build: (requestId): ChooseCardsRequest => ({
              id: requestId, kind: 'choose-cards', playerId: ownerId,
              prompt: '【玄注】：再弃置一张手牌', timeoutMs: 20_000, optional: false,
              purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
            }),
          })
          return
        } else {
          moveCard(host.state, removedCardId, { kind: 'characterPile', playerId: ownerId, pile: REMOVED_PILE }, { kind: 'discardPile' })
        }
      }

      if (target?.alive && !wasYin) host.beginVirtualSlash({ sourceId: ownerId, targetId: target.id, sourceSkillId: XUANZHU })
      return
    }

    if (resolution.step === 'discard-choice') {
      const { removedCardId, targetId } = resolution.data as { removedCardId: CardId; targetId: PlayerId | null }
      moveCard(host.state, removedCardId, { kind: 'characterPile', playerId: ownerId, pile: REMOVED_PILE }, { kind: 'discardPile' })
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardId && owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: XUANZHU }, { sourceId: ownerId, cardIds: [cardId] })
      }
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (target?.alive) host.beginVirtualSlash({ sourceId: ownerId, targetId: target.id, sourceSkillId: XUANZHU })
    }
  },
})

/*
 * 謇谔 A 半边（陆凯的牌生效后，该角色本回合不能抵消牌）未实现：引擎里
 * 「禁止使用某张具体牌名」的锁只有颜色/类别/CardId 三种（`card-play-lock.ts`），
 * 都锁不住「只禁无懈可击这一张牌名，且施加对象是任意第三方」，需要新增一类
 * 按牌名的通用锁才能做，超出本轮最小改动范围，记在案不是遗漏。
 * B 半边（陆凯自己抵消一张牌后本回合不能成为目标）可以直接复用陆抗【谦节】
 * 同款的 `prohibitsTarget`，正常实现。
 */
registerSkillRuntime({
  id: JIANE,
  triggers: [{
    event: 'CardResolved',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { targetCancelled?: boolean }
      if (context.event.sourceId !== ownerId || !payload.targetCancelled) return
      host.state.lukaiJianeUntargetable ??= {}
      host.state.lukaiJianeUntargetable[ownerId] = { turnNumber: host.state.turnNumber }
    },
  }],
  prohibitsTarget(state, ownerId) {
    return state.lukaiJianeUntargetable?.[ownerId]?.turnNumber === state.turnNumber
  },
})

export const LUKAI: CharacterDefinition = {
  id: 'lukai',
  name: '陆凯',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: XUANZHU, name: '玄注', description: '转换技，每个 TurnInstance 限一次。阳时，移出一张手牌，视为对一名角色使用一张无异议的杀，然后弃置一张手牌；阴时，移出一张手牌，视为对一名角色使用过河拆桥式效果拿走并弃置其一张牌，然后重铸/弃置移出的那张牌。发动后阴阳翻转。' },
    { id: JIANE, name: '謇谔', description: '锁定技，陆凯对其他角色使用的牌生效后，该角色本回合不能抵消牌；陆凯抵消一张牌后，本回合不能成为牌的目标。' },
  ],
}
