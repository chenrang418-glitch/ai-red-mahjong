import { drawCards } from '../../engine/draw'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 彭羕（三国杀 OL 经典身份 SP）。
 *
 * 【寸目】：锁定技，摸牌一律改从牌堆底摸（与许攸共用同一条 runtime，见
 *          `sp-xuyou.ts` 里的注册，此处只引用同一个技能 id）。
 * 【嚣翻】：可以观看牌堆底 X+1 张牌（X=本回合已使用过的牌张类型数，最多
 *          3），选择其中1张，按 判定区→装备区→手牌 的固定顺序弃置前X个
 *          区域各1张合法牌（区域为空则跳过，不补数量），然后获得这张底牌
 *          （本项目没有面向任意牌种的"立即代入合法使用时机"通用入口，
 *          简化为"支付代价后获得入手牌"，不强制当场使用，见批次报告）。
 * 【侻失】：锁定技，不能使用【无懈可击】；使用点数为J/Q/K的牌时，这次
 *          使用无效，然后摸1张牌（从牌堆底）；随后彭羕下一次对手牌数
 *          小于自己的角色使用牌时无距离和次数限制（次数限制口径同项目
 *          惯例只覆盖【杀】），满足并使用后消费；任意 TurnInstance 内3次
 *          使用伤害类牌都没有造成真实伤害后，【嚣翻】失效至本回合结束。
 */

export const CUNMU = 'cunmu'
const XIAOFAN = 'xiaofan'
const TUOSHI = 'tuoshi'
const DAMAGE_CARD_NAMES = new Set(['杀', '决斗', '南蛮入侵', '万箭齐发', '借刀杀人', '火攻', '雷杀', '火杀'])

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function usedTypeCount(state: SanguoshaState, ownerId: PlayerId): number {
  const entry = state.pengyangUsedTypesTurn?.[ownerId]
  return entry?.turnNumber === state.turnNumber ? entry.types.length : 0
}

function xiaofanDisabled(state: SanguoshaState, ownerId: PlayerId): boolean {
  return state.pengyangXiaofanDisabled?.turnNumber === state.turnNumber && state.pengyangXiaofanDisabled?.ownerId === ownerId
}

function matchesTuoshiBuff(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean {
  const pending = state.pengyangTuoshiBuffPending
  if (!pending || pending.turnNumber !== state.turnNumber || pending.ownerId !== ownerId) return false
  const owner = playerOf(state, ownerId)
  const target = playerOf(state, targetId)
  return !!owner && !!target && target.zones.hand.length < owner.zones.hand.length
}

registerSkillRuntime({
  id: XIAOFAN,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; asCardName?: string }
      const cardId = payload.cardId
      const category: CardCategory | undefined = cardId ? host.state.cards[cardId]?.category : undefined
      if (!category) return
      host.state.pengyangUsedTypesTurn ??= {}
      const entry = host.state.pengyangUsedTypesTurn[ownerId]
      const types = entry?.turnNumber === host.state.turnNumber ? new Set(entry.types) : new Set<CardCategory>()
      types.add(category)
      host.state.pengyangUsedTypesTurn[ownerId] = { turnNumber: host.state.turnNumber, types: [...types] }
    },
  }],
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || xiaofanDisabled(state, ownerId)) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const count = Math.min(3, usedTypeCount(state, ownerId)) + 1
    if (state.zones.drawPile.length === 0) return []
    return [{ id: 'xiaofan-invoke', label: `嚣翻：观看牌堆底${Math.min(count, state.zones.drawPile.length)}张牌` }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'xiaofan-invoke' || xiaofanDisabled(host.state, ownerId)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const count = Math.min(3, usedTypeCount(host.state, ownerId)) + 1
    const pile = host.state.zones.drawPile
    const bottom = pile.slice(Math.max(0, pile.length - count))
    if (bottom.length === 0) return
    host.askSkill({
      skillId: XIAOFAN, ownerId, step: 'pick', data: { bottom, x: Math.min(3, usedTypeCount(host.state, ownerId)) },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【嚣翻】：观看牌堆底${bottom.length}张牌，可以选择其中1张（需支付相应区域代价）`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: bottom, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const { bottom, x } = resolution.data as { bottom: CardId[]; x: number }
    const [picked] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!picked || !bottom.includes(picked) || !host.state.zones.drawPile.includes(picked)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // 先验证能否支付：按 判定区->装备区->手牌 顺序，每区最多1张，区域为空则跳过
    const zoneOrder: Array<{ kind: 'judgingArea' | 'equipment' | 'hand' }> = [{ kind: 'judgingArea' }, { kind: 'equipment' }, { kind: 'hand' }]
    const paid: CardId[] = []
    for (let index = 0; index < x; index += 1) {
      const zoneKind = zoneOrder[index]?.kind
      if (!zoneKind) break
      if (zoneKind === 'judgingArea' && owner.zones.judgingArea.length > 0) paid.push(owner.zones.judgingArea[0])
      else if (zoneKind === 'equipment') {
        const equipped = Object.values(owner.zones.equipment).find((cardId): cardId is CardId => !!cardId)
        if (equipped) paid.push(equipped)
      } else if (zoneKind === 'hand' && owner.zones.hand.length > 0) paid.push(owner.zones.hand[0])
    }
    for (const cardId of paid) {
      const zone = locateOwnedCard(host.state, ownerId, cardId)
      if (zone) moveCard(host.state, cardId, zone, { kind: 'discardPile' })
    }
    if (paid.length > 0) host.dispatch('LoseCard', { playerId: ownerId, cardIds: paid, reason: XIAOFAN }, { sourceId: ownerId, cardIds: paid })
    moveCard(host.state, picked, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: XIAOFAN }, { targetId: ownerId, cardIds: [picked] })
    host.dispatch('SkillActivated', { skillId: XIAOFAN, skillName: '嚣翻', playerId: ownerId, logText: `${owner.nickname}发动【嚣翻】，获得牌堆底一张牌` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: TUOSHI,
  prohibitsCardUse(_state, ownerId, context) {
    return context.userId === ownerId && context.cardName === '无懈可击'
  },
  interceptPlayAction(host, ownerId, action) {
    if (action.kind !== 'use-card' || action.playerId !== ownerId) return false
    const [cardId] = action.cardIds
    const card = host.state.cards[cardId]
    if (!card || card.rank < 11) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    for (const id of action.cardIds) {
      const zone = locateOwnedCard(host.state, ownerId, id, { includeCharacterPiles: true })
      if (zone) moveCard(host.state, id, zone, { kind: 'discardPile' })
    }
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [...action.cardIds], reason: TUOSHI }, { sourceId: ownerId, cardIds: [...action.cardIds] })
    host.dispatch('SkillActivated', { skillId: TUOSHI, skillName: '侻失', playerId: ownerId, logText: `${owner.nickname}使用点数为J/Q/K的牌，这次使用无效` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    host.state.pengyangTuoshiBuffPending = { ownerId, turnNumber: host.state.turnNumber }
    return true
  },
  ignoresDistanceTo(state, ownerId, targetId) {
    return matchesTuoshiBuff(state, ownerId, targetId)
  },
  ignoresSlashUsesTo(state, ownerId, targetId) {
    return matchesTuoshiBuff(state, ownerId, targetId)
  },
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const pending = host.state.pengyangTuoshiBuffPending
        if (!pending || pending.turnNumber !== host.state.turnNumber || pending.ownerId !== ownerId) return
        const payload = context.event.payload as { targetIds?: PlayerId[] }
        if ((payload.targetIds ?? []).some((id) => matchesTuoshiBuff(host.state, ownerId, id))) {
          host.state.pengyangTuoshiBuffPending = undefined
        }
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cardName?: string; asCardName?: string; cancelled?: boolean }
        if (payload.cancelled || context.event.sourceId !== ownerId) return
        const name = payload.asCardName ?? payload.cardName
        if (!name || !DAMAGE_CARD_NAMES.has(name)) return
        const dealt = payload.cardId ? cardDamageDealt(host.state, payload.cardId) > 0 : false
        if (dealt) return
        const entry = host.state.pengyangFailedDamageTurn
        const count = entry?.turnNumber === host.state.turnNumber ? entry.count + 1 : 1
        host.state.pengyangFailedDamageTurn = { turnNumber: host.state.turnNumber, count }
        if (count >= 3) host.state.pengyangXiaofanDisabled = { turnNumber: host.state.turnNumber, ownerId }
      },
    },
  ],
})

export const PENGYANG: CharacterDefinition = {
  id: 'pengyang',
  name: '彭羕',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: CUNMU, name: '寸目', description: '锁定技，你的摸牌一律改为从牌堆底获得。' },
    { id: XIAOFAN, name: '嚣翻', description: '你可以观看牌堆底X+1张牌（X为本回合已使用过的牌张类型数，最多3），支付判定区/装备区/手牌前X个区域各1张合法牌（区域为空则跳过）后获得其中1张。' },
    { id: TUOSHI, name: '侻失', description: '锁定技，你不能使用【无懈可击】；使用点数为J/Q/K的牌时，这次使用无效，然后摸1张牌；随后你下一次对手牌数小于你的角色使用牌时无距离和次数限制；任意 TurnInstance 内3次使用伤害类牌都没有造成伤害后，【嚣翻】失效至本回合结束。' },
  ],
}
