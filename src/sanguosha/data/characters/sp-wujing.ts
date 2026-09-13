import { moveCard } from '../../engine/zones'
import { canTarget } from '../../engine/distance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 吴景（三国杀 OL 经典身份 SP）。
 *
 * 【合击】：一名角色使用只指定唯一目标的红色【杀】后，吴景可以使用一张
 *          【杀】指定同一目标（用真实手牌，走 `beginVirtualSlash` 的
 *          实体牌载体分支）。引擎没有"视为使用一张决斗"的通用入口，
 *          决斗分支不在本次实现范围内，只做红杀分支。若这张杀不是
 *          转化牌，吴景随机获得牌堆中一张红色牌。
 * 【流兵】：锁定技，吴景每个回合使用的第一张实体【杀】视为方块；其他
 *          角色于自己的出牌阶段内使用一张非黑色【杀】、未造成伤害且
 *          最终进入弃牌堆后，吴景获得这张牌。
 */

const HEJI = 'heji'
const LIUBING = 'liubing'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: HEJI,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; cardId?: CardId; targetIds?: PlayerId[]; cancelled?: boolean; color?: string }
      if (context.event.sourceId === ownerId || payload.cancelled || payload.cardName !== '杀') return
      const targetIds = payload.targetIds ?? []
      if (targetIds.length !== 1 || targetIds[0] === ownerId) return
      const cardColor = payload.cardId ? host.state.cards[payload.cardId]?.color : null
      if (cardColor !== 'red') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !canTarget(host.state, ownerId, targetIds[0])) return
      const slashes = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
      if (slashes.length === 0) return
      host.queueSkill({ skillId: HEJI, ownerId, step: 'ask', data: { targetId: targetIds[0], slashes } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const { targetId, slashes } = prompt.data as { targetId: PlayerId; slashes: CardId[] }
    if (!owner?.alive || !playerOf(host.state, targetId)?.alive) return
    const validSlashes = slashes.filter((cardId) => owner.zones.hand.includes(cardId))
    if (validSlashes.length === 0) return
    host.askSkill({
      skillId: HEJI, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【合击】：对${playerOf(host.state, targetId)?.nickname}使用一张杀？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    const { targetId } = resolution.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const slashCardId = owner.zones.hand.find((cardId) => host.state.cards[cardId]?.name === '杀')
    if (!slashCardId) return
    host.dispatch('SkillActivated', { skillId: HEJI, skillName: '合击', playerId: ownerId, targetId, logText: `${owner.nickname}发动【合击】` }, { sourceId: ownerId, targetId })
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: HEJI, cardId: slashCardId })
    const redCards: CardId[] = []
    for (const cardId of host.state.zones.drawPile) {
      if (host.state.cards[cardId]?.color === 'red') redCards.push(cardId)
    }
    if (redCards.length === 0) return
    const picked = redCards[host.rng.nextInt(redCards.length)]
    moveCard(host.state, picked, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: HEJI }, { targetId: ownerId, cardIds: [picked] })
  },
})

registerSkillRuntime({
  id: LIUBING,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string; cardId?: CardId; asCardName?: string }
        if (context.event.sourceId !== ownerId || payload.asCardName || payload.cardName !== '杀' || !payload.cardId) return
        if (host.state.cards[payload.cardId]?.category !== 'basic') return
        host.state.wujingFirstSlashTurn ??= {}
        const entry = host.state.wujingFirstSlashTurn[ownerId]
        if (entry?.turnNumber === host.state.turnNumber) return
        host.state.wujingFirstSlashTurn[ownerId] = { turnNumber: host.state.turnNumber, cardId: payload.cardId }
      },
    },
    {
      event: 'Damaged',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId }
        if (!payload.cardId) return
        host.state.wujingDamagedCardIds ??= []
        if (!host.state.wujingDamagedCardIds.includes(payload.cardId)) host.state.wujingDamagedCardIds.push(payload.cardId)
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string; cardId?: CardId; cancelled?: boolean; asCardName?: string }
        const actorId = context.event.sourceId
        if (!actorId || actorId === ownerId || payload.cancelled || payload.asCardName || payload.cardName !== '杀' || !payload.cardId) return
        if (host.state.phase !== 'play' || host.state.currentPlayerId !== actorId) return
        if (host.state.cards[payload.cardId]?.color === 'black') return
        if (!host.state.zones.discardPile.includes(payload.cardId)) return
        if (host.state.wujingDamagedCardIds?.includes(payload.cardId)) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        moveCard(host.state, payload.cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('SkillActivated', { skillId: LIUBING, skillName: '流兵', playerId: ownerId, targetId: actorId, logText: `${owner.nickname}发动【流兵】` }, { sourceId: ownerId, targetId: actorId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [payload.cardId], reason: LIUBING }, { targetId: ownerId, cardIds: [payload.cardId] })
      },
    },
  ],

  cardSuit(state, ownerId, cardId, printedSuit) {
    return state.wujingFirstSlashTurn?.[ownerId]?.turnNumber === state.turnNumber && state.wujingFirstSlashTurn[ownerId].cardId === cardId
      ? 'diamond'
      : printedSuit
  },
})

export const WUJING: CharacterDefinition = {
  id: 'wujing',
  name: '吴景',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: HEJI, name: '合击', description: '一名角色使用只指定唯一目标的红色【杀】后，吴景可以使用一张【杀】指定同一目标；若这张杀不是转化牌，吴景随机获得牌堆中一张红色牌。' },
    { id: LIUBING, name: '流兵', description: '锁定技，吴景每个回合使用的第一张实体【杀】视为方块；其他角色于自己的出牌阶段内使用一张非黑色【杀】、未造成伤害且最终进入弃牌堆后，吴景获得这张牌。' },
  ],
}
