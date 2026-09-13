import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 蒋琬（三国杀 OL 经典身份 SP）。
 *
 * 【蓄发】：出牌阶段，放入/移去两个分支各限一次。放入：将至少一半当前
 *          手牌置于专属牌堆（`characterPiles`）；移去：移去至少一半当前
 *          蓄发牌（进弃牌堆）。每个分支结束后，蒋琬可以将自己1张牌当
 *          相应牌堆（放入后的蓄发牌 / 本次移去的牌）中任意一张普通锦囊
 *          的牌名使用（`viewAs`，本次可选牌名过期即清空）。
 * 【自若】：转换技，锁定技。阳时使用当前手牌最左侧的牌摸1张，阴时使用
 *          最右侧的牌摸1张，然后阴阳翻转；直到本回合结束不能整理手牌
 *          顺序（本项目没有手牌拖动重排 UI，这一条没有可禁用的界面行为，
 *          只记录状态供以后接入时使用）。
 */

const XUFA = 'xufa'
const ZIRUO = 'ziruo'
const XUFA_PILE = 'xufa'
const YIN_MARK = 'jiangwan-yin'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function normalTrickNamesOf(state: SanguoshaState, cardIds: readonly CardId[]): string[] {
  const names = new Set<string>()
  for (const cardId of cardIds) {
    const name = state.cards[cardId]?.name
    if (name && INSTANT_TRICKS.has(name)) names.add(name)
  }
  return [...names]
}

registerSkillRuntime({
  id: XUFA,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const actions: Array<{ id: string; label: string }> = []
    if (!owner.turnUsedSkills.includes(`${XUFA}-in`) && owner.zones.hand.length > 0) {
      actions.push({ id: `${XUFA}-in`, label: '蓄发（放入）：将至少一半手牌置于蓄发牌堆' })
    }
    const pile = owner.characterPiles[XUFA_PILE] ?? []
    if (!owner.turnUsedSkills.includes(`${XUFA}-out`) && pile.length > 0) {
      actions.push({ id: `${XUFA}-out`, label: '蓄发（移去）：移去至少一半蓄发牌' })
    }
    return actions
  },

  invokeActive(host, ownerId, actionId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (actionId === `${XUFA}-in`) {
      if (owner.turnUsedSkills.includes(`${XUFA}-in`) || owner.zones.hand.length === 0) return
      const min = Math.ceil(owner.zones.hand.length / 2)
      host.askSkill({
        skillId: XUFA, ownerId, step: 'in',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【蓄发】：置入至少${min}张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min, max: owner.zones.hand.length,
        }),
      })
      return
    }
    if (actionId === `${XUFA}-out`) {
      const pile = owner.characterPiles[XUFA_PILE] ?? []
      if (owner.turnUsedSkills.includes(`${XUFA}-out`) || pile.length === 0) return
      const min = Math.ceil(pile.length / 2)
      host.askSkill({
        skillId: XUFA, ownerId, step: 'out',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【蓄发】：移去至少${min}张蓄发牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...pile], hiddenCardSlots: [], min, max: pile.length,
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'in') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const min = Math.ceil(owner.zones.hand.length / 2)
      if (owner.turnUsedSkills.includes(`${XUFA}-in`) || cardIds.length < min || cardIds.some((id) => !owner.zones.hand.includes(id))) return
      owner.turnUsedSkills.push(`${XUFA}-in`)
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: XUFA_PILE })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: XUFA }, { sourceId: ownerId, cardIds })
      host.dispatch('SkillActivated', { skillId: XUFA, skillName: '蓄发', playerId: ownerId, logText: `${owner.nickname}发动【蓄发】（放入）` }, { sourceId: ownerId })
      const names = normalTrickNamesOf(host.state, owner.characterPiles[XUFA_PILE] ?? [])
      if (names.length > 0 && owner.zones.hand.length > 0) host.state.jiangwanPendingNames = { ownerId, names, turnNumber: host.state.turnNumber }
      return
    }

    if (resolution.step === 'out') {
      const pile = owner.characterPiles[XUFA_PILE] ?? []
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const min = Math.ceil(pile.length / 2)
      if (owner.turnUsedSkills.includes(`${XUFA}-out`) || cardIds.length < min || cardIds.some((id) => !pile.includes(id))) return
      owner.turnUsedSkills.push(`${XUFA}-out`)
      const names = normalTrickNamesOf(host.state, cardIds)
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: XUFA_PILE }, { kind: 'discardPile' })
      host.dispatch('SkillActivated', { skillId: XUFA, skillName: '蓄发', playerId: ownerId, logText: `${owner.nickname}发动【蓄发】（移去）` }, { sourceId: ownerId })
      if (names.length > 0 && owner.zones.hand.length > 0) host.state.jiangwanPendingNames = { ownerId, names, turnNumber: host.state.turnNumber }
    }
  },

  viewAs(state, ownerId) {
    const pending = state.jiangwanPendingNames
    if (!pending || pending.ownerId !== ownerId || pending.turnNumber !== state.turnNumber) return []
    const owner = playerOf(state, ownerId)
    if (!owner) return []
    const options = []
    for (const cardId of owner.zones.hand) {
      for (const name of pending.names) options.push({ asCardName: name, cardId, label: `蓄发：当作【${name}】使用` })
    }
    return options
  },

  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { asCardName?: string }
      if (context.event.sourceId !== ownerId || !payload.asCardName) return
      if (host.state.jiangwanPendingNames?.ownerId === ownerId) host.state.jiangwanPendingNames = undefined
    },
  }],
})

registerSkillRuntime({
  id: ZIRUO,
  triggers: [{
    event: 'BeforeCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !payload.cardId || owner.zones.hand.length === 0) return
      const isYin = (owner.marks[YIN_MARK] ?? 0) > 0
      const edgeCardId = isYin ? owner.zones.hand[owner.zones.hand.length - 1] : owner.zones.hand[0]
      if (payload.cardId !== edgeCardId) return
      drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      owner.marks[YIN_MARK] = isYin ? 0 : 1
      host.state.jiangwanNoReorderTurn = host.state.turnNumber
      host.dispatch('SkillActivated', { skillId: ZIRUO, skillName: '自若', playerId: ownerId, logText: `${owner.nickname}发动【自若】` }, { sourceId: ownerId })
    },
  }],
})

export const JIANGWAN: CharacterDefinition = {
  id: 'jiangwan',
  name: '蒋琬',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: XUFA, name: '蓄发', description: '出牌阶段，放入（将至少一半手牌置于蓄发牌堆）/移去（移去至少一半蓄发牌）各限一次；发动后可以将自己1张牌当相应牌堆中任意一张普通锦囊的牌名使用。' },
    { id: ZIRUO, name: '自若', description: '转换技，锁定技，阳时使用当前手牌最左侧的牌摸1张，阴时使用最右侧的牌摸1张，然后阴阳翻转。' },
  ],
}
