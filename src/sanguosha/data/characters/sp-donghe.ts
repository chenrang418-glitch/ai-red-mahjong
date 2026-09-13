import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { applyForcedIdentity, forcedIdentityFor } from '../../engine/forced-identity'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 董翓（三国杀 OL 经典身份 SP）。
 *
 * 【狡威】：锁定技。A. 董翓的黑色手牌不计入手牌上限；B. 若手牌数>体力值，
 *          对体力值≤董翓的角色使用黑色牌时无距离限制、对方不能响应。
 *          `ignoresDistanceTo`/`slashUndodgeable`/`trickUnresponsive` 三个
 *          既有钩子本批扩展了可选 cardId 参数，这里按具体牌的花色精确判断。
 * 【鞭御】：锁定技。董翓使用【杀】造成伤害，或受到【杀】造成的伤害后，
 *          受伤角色 lostHp=X，董翓选择受伤角色至多X张手牌，视为无次数限制
 *          的【杀】，直到该角色使用第一张非基本牌为止；期间若董翓或受伤者
 *          的全部手牌均为【杀】，董翓摸2张牌。
 * 【凤瑶】：锁定技。任意角色装备区的黑桃牌离开装备区后，董翓回复1点体力；
 *          董翓对其他角色即将造成伤害时，自动弃置双方场上一张黑桃牌（无则
 *          不加），成功则伤害+1。
 */

const JIAOWEI = 'jiaowei'
const BIANYU = 'bianyu'
const FENGYAO = 'fengyao'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function jiaoweiActive(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  return !!owner?.alive && owner.zones.hand.length > owner.hp
}

registerSkillRuntime({
  id: JIAOWEI,
  handLimitExempt(state, _ownerId, cardId) {
    return state.cards[cardId]?.color === 'black'
  },
  ignoresDistanceTo(state, ownerId, targetId, cardId) {
    if (!cardId || state.cards[cardId]?.color !== 'black') return false
    const target = playerOf(state, targetId)
    const owner = playerOf(state, ownerId)
    return jiaoweiActive(state, ownerId) && !!target?.alive && !!owner?.alive && target.hp <= owner.hp
  },
  slashUndodgeable(state, ownerId, targetId, cardId) {
    if (!cardId || state.cards[cardId]?.color !== 'black') return false
    const target = playerOf(state, targetId)
    const owner = playerOf(state, ownerId)
    return jiaoweiActive(state, ownerId) && !!target?.alive && !!owner?.alive && target.hp <= owner.hp
  },
  trickUnresponsive(state, ownerId, targetId, _cardName, cardId) {
    if (!cardId || state.cards[cardId]?.color !== 'black') return false
    const target = playerOf(state, targetId)
    const owner = playerOf(state, ownerId)
    return jiaoweiActive(state, ownerId) && !!target?.alive && !!owner?.alive && target.hp <= owner.hp
  },
})

function allHandIsSlash(state: SanguoshaState, playerId: PlayerId): boolean {
  const player = playerOf(state, playerId)
  if (!player?.alive || player.zones.hand.length === 0) return false
  return player.zones.hand.every((cardId) => (forcedIdentityFor(state, playerId, cardId)?.asCardName ?? state.cards[cardId]?.name) === '杀')
}

registerSkillRuntime({
  id: BIANYU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; amount?: number }
      if (payload.cardName !== '杀') return
      const sourceId = context.event.sourceId
      const injuredId = context.event.targetId
      if (!injuredId || (sourceId !== ownerId && injuredId !== ownerId)) return
      const injured = playerOf(host.state, injuredId)
      if (!injured?.alive || injured.zones.hand.length === 0) return
      const x = Math.max(1, Math.trunc(payload.amount ?? 1))
      host.queueSkill({ skillId: BIANYU, ownerId, step: 'pick', data: { injuredId, x } })
    },
  }, {
    event: 'AfterCardUse',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; playerId?: PlayerId }
      const injuredId = context.event.sourceId
      if (!injuredId) return
      const granted = host.state.dongheBianyuCards?.[injuredId]
      if (!granted || granted.length === 0) return
      const cardId = payload.cardId
      const card = cardId ? host.state.cards[cardId] : null
      if (!card || card.category === 'basic') return
      host.state.forcedIdentities = (host.state.forcedIdentities ?? []).filter((entry) => !(entry.scope === 'card' && entry.skillId === BIANYU && granted.includes(entry.cardId as CardId)))
      delete host.state.dongheBianyuCards![injuredId]
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const { injuredId, x } = prompt.data as { injuredId: PlayerId; x: number }
    const injured = playerOf(host.state, injuredId)
    if (!injured?.alive || injured.zones.hand.length === 0) return
    host.askSkill({
      skillId: BIANYU, ownerId, step: 'pick', data: { injuredId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【鞭御】：选择受伤角色至多${x}张手牌，视为无次数限制的【杀】`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...injured.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(x, injured.zones.hand.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const { injuredId } = resolution.data as { injuredId: PlayerId }
    const injured = playerOf(host.state, injuredId)
    const owner = playerOf(host.state, ownerId)
    if (!injured?.alive || !owner?.alive) return
    const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => injured.zones.hand.includes(id))
    if (cardIds.length === 0) return
    for (const cardId of cardIds) {
      applyForcedIdentity(host.state, {
        ownerId: injuredId, scope: 'card', cardId, asCardName: '杀', nature: 'normal',
        ignoreDistance: false, unlimitedUses: true, skillId: BIANYU, expiry: 'manual',
      })
    }
    host.state.dongheBianyuCards ??= {}
    host.state.dongheBianyuCards[injuredId] = cardIds
    host.dispatch('SkillActivated', { skillId: BIANYU, skillName: '鞭御', playerId: ownerId, logText: `${owner.nickname}发动【鞭御】，令${injured.nickname}的${cardIds.length}张手牌视为无次数限制的【杀】` }, { sourceId: ownerId, targetId: injuredId })
    if (allHandIsSlash(host.state, ownerId) || allHandIsSlash(host.state, injuredId)) {
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

registerSkillRuntime({
  id: FENGYAO,
  triggers: [{
    event: 'LoseEquipment',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (!payload.cardId || host.state.cards[payload.cardId]?.suit !== 'spade') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.hp >= owner.maxHp) return
      recover(host as never, ownerId, 1, ownerId)
      host.dispatch('SkillActivated', { skillId: FENGYAO, skillName: '凤瑶', playerId: ownerId, logText: `${owner.nickname}发动【凤瑶】，回复1点体力` }, { sourceId: ownerId })
    },
  }, {
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const targetId = context.event.targetId
      if (!targetId || targetId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      const fromOwner = [...Object.values(owner.zones.equipment), ...owner.zones.judgingArea].filter((id): id is CardId => !!id && host.state.cards[id]?.suit === 'spade')
      const fromTarget = [...Object.values(target.zones.equipment), ...target.zones.judgingArea].filter((id): id is CardId => !!id && host.state.cards[id]?.suit === 'spade')
      const candidate = fromOwner[0] ?? fromTarget[0]
      if (!candidate) return
      const holderId = fromOwner[0] ? ownerId : targetId
      const holder = playerOf(host.state, holderId)!
      const slot = (Object.keys(holder.zones.equipment) as Array<keyof typeof holder.zones.equipment>).find((key) => holder.zones.equipment[key] === candidate)
      if (slot) moveCard(host.state, candidate, { kind: 'equipment', playerId: holderId, slot }, { kind: 'discardPile' })
      else moveCard(host.state, candidate, { kind: 'judgingArea', playerId: holderId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: holderId, cardIds: [candidate], reason: FENGYAO }, { sourceId: holderId, cardIds: [candidate] })
      const payload = context.event.payload as { amount?: number }
      payload.amount = (typeof payload.amount === 'number' ? payload.amount : 0) + 1
      host.dispatch('SkillActivated', { skillId: FENGYAO, skillName: '凤瑶', playerId: ownerId, logText: `${owner.nickname}发动【凤瑶】，伤害+1` }, { sourceId: ownerId, targetId })
    },
  }],
})

export const DONGHE: CharacterDefinition = {
  id: 'donghe',
  name: '董翓',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: JIAOWEI, name: '狡威', description: '锁定技，你的黑色手牌不计入手牌上限；若你的手牌数大于体力值，你对体力值不大于你的角色使用黑色牌无距离限制，且对方不能响应。' },
    { id: BIANYU, name: '鞭御', description: '锁定技，你使用【杀】造成伤害，或受到【杀】造成的伤害后，X=受伤角色失去的体力值，你选择其至多X张手牌，视为无次数限制的【杀】，直到其使用第一张非基本牌为止；期间若你或其全部手牌均为【杀】，你摸2张牌。' },
    { id: FENGYAO, name: '凤瑶', description: '锁定技，任意角色装备区的黑桃牌离开装备区后，你回复1点体力；你对其他角色造成伤害时，弃置你或其场上一张黑桃牌，此伤害+1。' },
  ],
}
