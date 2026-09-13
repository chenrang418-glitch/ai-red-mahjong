import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 许攸（三国杀 OL 经典身份 SP）。
 *
 * 【成略】：转换技，出牌阶段限一次。阳：摸1然后弃2张手牌；阴：摸2然后弃1
 *          张手牌。完成后，直到本回合结束，使用与本次弃牌花色相同的牌无
 *          距离和次数限制（次数限制口径同项目惯例只覆盖【杀】），然后
 *          阴阳切换。
 * 【恃才】：每个 TurnInstance 内，你首次使用某种牌张类型（基本/锦囊/装备）
 *          后，可以将这张实体牌置于牌堆顶，然后摸1张牌（因【寸目】改为
 *          从牌堆底摸）。
 * 【寸目】：锁定技，摸牌一律改从牌堆底摸（与彭羕共用同一条 runtime）。
 */

export const CUNMU = 'cunmu'
const CHENGLUE = 'chenglue'
const CHENGLUE_INVOKE = 'chenglue-invoke'
const SHICAI = 'shicai'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function chengueSuits(state: SanguoshaState, ownerId: PlayerId): Suit[] | null {
  const entry = state.xuyouChengueSuits
  return entry?.turnNumber === state.turnNumber && entry.ownerId === ownerId ? entry.suits : null
}

registerSkillRuntime({
  id: CUNMU,
  drawsFromBottom: () => true,
})

registerSkillRuntime({
  id: CHENGLUE,
  slashIgnoresDistance(state, ownerId, cardId) {
    const suits = chengueSuits(state, ownerId)
    const suit = cardId ? state.cards[cardId]?.suit : undefined
    return !!suits && !!suit && suits.includes(suit)
  },
  ignoresSlashUsesTo(state, ownerId) {
    return !!chengueSuits(state, ownerId)
  },
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(CHENGLUE)) return []
    const mode = conversionStateOf(state, ownerId, CHENGLUE)
    const drawCount = mode === 'yang' ? 1 : 2
    const discardCount = mode === 'yang' ? 2 : 1
    // 弃牌数固定，摸牌之后手牌必须够弃，否则这个代价付不出来，不该弹出这个选项
    if (owner.zones.hand.length + drawCount < discardCount) return []
    return [{ id: CHENGLUE_INVOKE, label: '成略：摸牌后弃牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== CHENGLUE_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(CHENGLUE)) return
    const mode = conversionStateOf(host.state, ownerId, CHENGLUE)
    const drawCount = mode === 'yang' ? 1 : 2
    const discardCount = mode === 'yang' ? 2 : 1
    if (owner.zones.hand.length + drawCount < discardCount) return
    owner.turnUsedSkills.push(CHENGLUE)
    host.dispatch('SkillActivated', { skillId: CHENGLUE, skillName: '成略', playerId: ownerId, logText: `${owner.nickname}发动【成略】（${mode === 'yang' ? '阳' : '阴'}）` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, drawCount, (name, payload) => { host.dispatch(name, payload) })
    host.askSkill({
      skillId: CHENGLUE, ownerId, step: 'discard', data: { discardCount },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【成略】：弃置${discardCount}张手牌`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: discardCount, max: discardCount,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { discardCount } = resolution.data as { discardCount: number }
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
    if (valid.length !== discardCount) return
    const suits = [...new Set(valid.map((id) => host.state.cards[id]?.suit).filter((suit): suit is Suit => !!suit))]
    for (const id of valid) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: CHENGLUE }, { sourceId: ownerId, cardIds: valid })
    host.state.xuyouChengueSuits = { turnNumber: host.state.turnNumber, ownerId, suits }
    toggleConversionState(host.state, ownerId, CHENGLUE)
    host.dispatch('SkillActivated', { skillId: CHENGLUE, skillName: '成略', playerId: ownerId, logText: `${owner.nickname}本回合内使用对应花色的牌无距离和次数限制` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: SHICAI,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      if (payload.cancelled || context.event.sourceId !== ownerId || !payload.cardId) return
      const card = host.state.cards[payload.cardId]
      if (!card) return
      const owner = playerOf(host.state, ownerId)
      const key = `${SHICAI}-${card.category}`
      if (!owner?.alive || owner.turnUsedSkills.includes(key)) return
      host.queueSkill({ skillId: SHICAI, ownerId, step: 'ask', data: { cardId: payload.cardId, key } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { cardId, key } = prompt.data as { cardId: CardId; key: string }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(key) || !host.state.zones.discardPile.includes(cardId)) return
    host.askSkill({
      skillId: SHICAI, ownerId, step: 'confirm', data: { cardId, key },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【恃才】：是否将这张牌置于牌堆顶并摸1张牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'cancel', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'confirm') return
    const { cardId, key } = resolution.data as { cardId: CardId; key: string }
    const owner = playerOf(host.state, ownerId)
    if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner?.alive) return
    if (owner.turnUsedSkills.includes(key) || !host.state.zones.discardPile.includes(cardId)) return
    owner.turnUsedSkills.push(key)
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'drawPile' })
    host.state.zones.drawPile = [cardId, ...host.state.zones.drawPile.filter((id) => id !== cardId)]
    host.dispatch('SkillActivated', { skillId: SHICAI, skillName: '恃才', playerId: ownerId, logText: `${owner.nickname}发动【恃才】，将这张牌置于牌堆顶` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const XUYOU: CharacterDefinition = {
  id: 'xuyou',
  name: '许攸',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: CHENGLUE, name: '成略', description: '转换技，出牌阶段限一次。阳：摸1然后弃2张手牌；阴：摸2然后弃1张手牌。之后直到本回合结束，使用与弃牌花色相同的牌无距离和次数限制，然后阴阳切换。' },
    { id: SHICAI, name: '恃才', description: '每个 TurnInstance 内，你首次使用某种牌张类型后，可以将这张牌置于牌堆顶，然后摸1张牌。' },
    { id: CUNMU, name: '寸目', description: '锁定技，你的摸牌一律改为从牌堆底获得。' },
  ],
}
