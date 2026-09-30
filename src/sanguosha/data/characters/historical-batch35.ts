// 武将册第37批（武将册序号486–495）。
// @ts-nocheck
import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { registerSkillRuntime, type SkillHost, effectiveCardColor, effectiveCardSuit, grantSkill, replaceTemporarySkills, characterSkillIdsOf, getSkillRuntime } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { getDistance, getAttackRange, canTarget } from '../../engine/distance'
import { registerPindianContinuation, startPindian, canPindian, finishPindianSettlement } from '../../engine/pindian'
import { flipCharacter } from '../../engine/character-state'
import { gainMaxHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { continueDyingAssists } from '../../engine/damage'
import { resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { hiddenHandSlot } from '../../engine/cards/host'
import { lockCardColor } from '../../engine/card-play-lock'
import { forceDistance } from '../../engine/distance-override'
import { declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'

type B37 = SanguoshaState & { b37?: Record<string, any> }
const st = (h: SkillHost) => h.state as B37
const player = (s: SanguoshaState, id: PlayerId) => s.players.find(p => p.id === id)
const alive = (s: SanguoshaState) => s.players.filter(p => p.alive)
const others = (s: SanguoshaState, id: PlayerId) => alive(s).filter(p => p.id !== id)
const hand = (s: SanguoshaState, id: PlayerId): CardId[] => player(s, id)?.zones.hand ?? []
const put = (h: SkillHost, k: string, v: any) => { st(h).b37 ??= {}; st(h).b37[k] = v; return v }
const get = (s: B37, k: string) => s.b37?.[k]
const erase = (s: B37, k: string) => { if (s.b37) delete s.b37[k] }
function draw(h: SkillHost, id: PlayerId, n: number) { if (n > 0) drawCards(h.state, h.rng, id, n, (name, payload) => h.dispatch(name, payload)) }
function discard(h: SkillHost, id: PlayerId, cardIds: CardId[], reason: string) {
  const moved: CardId[] = []
  for (const cardId of [...new Set(cardIds)]) {
    const from = locateOwnedCard(h.state, id, cardId)
    if (!from) continue
    moveCard(h.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') handleEquipmentLost(h as never, id, cardId)
    moved.push(cardId)
  }
  if (moved.length) h.dispatch('LoseCard', { playerId: id, cardIds: moved, reason }, { sourceId: id, cardIds: moved })
  return moved
}
function give(h: SkillHost, fromId: PlayerId, toId: PlayerId, cardIds: CardId[], reason: string) {
  const moved: CardId[] = []
  for (const cardId of [...new Set(cardIds)]) {
    const from = locateOwnedCard(h.state, fromId, cardId)
    if (!from) continue
    moveCard(h.state, cardId, from, { kind: 'hand', playerId: toId }); moved.push(cardId)
  }
  if (moved.length) {
    h.dispatch('LoseCard', { playerId: fromId, cardIds: moved, reason }, { sourceId: fromId, cardIds: moved })
    h.dispatch('GainCard', { playerId: toId, cardIds: moved, reason }, { sourceId: fromId, targetId: toId, cardIds: moved })
  }
  return moved
}
function askOption(h: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, options: any[], data: any = {}, optional = true) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional, options }) })
}
function askTargets(h: SkillHost, skillId: string, ownerId: PlayerId, step: string, ids: PlayerId[], prompt: string, data: any = {}, optional = false, min = 1, max = 1) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000, optional, candidateIds: ids, min, max }) })
}
function askCards(h: SkillHost, skillId: string, ownerId: PlayerId, step: string, ids: CardId[], prompt: string, data: any = {}, optional = false, min = 1, max = 1) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 25_000, optional, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min, max }) })
}

const ZHUIJI = 'zhuiji-sp-b37', SH仇 = 'shichou-sp-b37'
const LONGDAN = 'longdan-sp-b37', CHONGZHEN = 'chongzhen-sp-b37'
const LIHUN = 'lihun-sp-b37', BIYUE = 'biyue-sp-b37'
const ZHENLUE = 'zhenlue-sp-b37', JIANSHU = 'jianshu-sp-b37', YONGDI = 'yongdi-sp-b37'
const WEIKUI = 'weikui-sp-b37', LIZHAN = 'lizhan-sp-b37'
const CHENQING = 'chenqing-sp-b37', MOSHI = 'moshi-sp-b37'
const XINGWU = 'xingwu-b37', LUOYAN = 'luoyan-b37'
const KUNFEN = 'kunfen-sp-b37', FENGLIANG = 'fengliang-sp-b37', TIAOXIN = 'tiaoxin'
const MASHU = 'mashu-jie-madai-b37', QIANXI = 'qianxi-jie-madai-b37'
const YAOWU = 'yaowu-jie-huaxiong-b37'

// SP马超：追击直接覆盖距离；誓仇把按已损失体力增加目标接到统一出杀规则。
registerSkillRuntime({ id: ZHUIJI, directedDistanceTo(state, ownerId, targetId) { return (player(state, targetId)?.hp ?? 99) <= (player(state, ownerId)?.hp ?? 0) ? -99 : 0 } })
registerSkillRuntime({ id: SH仇, extraSlashTargets(state, ownerId) { return Math.max(0, (player(state, ownerId)?.maxHp ?? 0) - (player(state, ownerId)?.hp ?? 0)) } })

// SP赵云：转化牌仍是原手牌载体；冲阵仅读取手牌暗槽，不开放装备区选项。
registerSkillRuntime({ id: LONGDAN, viewAs(state, ownerId) {
  return hand(state, ownerId).flatMap(cardId => {
    const name = state.cards[cardId]?.name
    return name === '杀' ? [{ cardId, asCardName: '闪', label: '龙胆：杀当闪' }]
      : name === '闪' ? [{ cardId, asCardName: '杀', label: '龙胆：闪当杀' }] : []
  })
} })
registerSkillRuntime({
  id: CHONGZHEN,
  triggers: [{ event: 'CardResponded', handle(h, ownerId, context) {
    const p = context.event.payload as any
    const resolution = h.state.cardResolution as any
    const targetId = context.event.targetId ?? (resolution?.kind === 'trick' ? resolution.targetIds[resolution.targetIndex] : resolution?.kind === 'slash' ? resolution.sourceId : undefined)
    if (p.playerId !== ownerId || !['杀', '闪'].includes(p.cardName) || !p.cardId || !targetId || targetId === ownerId || !hand(h.state, targetId).length) return
    const physical = h.state.cards[p.cardId]
    if (!physical || !((p.cardName === '闪' && physical.name === '杀') || (p.cardName === '杀' && physical.name === '闪'))) return
    h.queueSkill({ skillId: CHONGZHEN, ownerId, step: 'rob', data: { targetId } })
  } }, { event: 'CardUsed', handle(h, ownerId, context) {
    const p = context.event.payload as any
    if (context.event.sourceId !== ownerId || !p.cardId || p.cardName !== '杀') return
    const physical = h.state.cards[p.cardId]
    if (physical?.name !== '闪') return
    const targetId = p.targetIds?.[0]
    if (targetId && targetId !== ownerId && hand(h.state, targetId).length) h.queueSkill({ skillId: CHONGZHEN, ownerId, step: 'rob', data: { targetId } })
  } }],
  startQueued(h, ownerId, prompt) {
    if (prompt.step !== 'rob') return
    const targetId = prompt.data.targetId as PlayerId
    if (!player(h.state, targetId)?.alive || !hand(h.state, targetId).length) return
    askOption(h, CHONGZHEN, ownerId, 'choose', '是否发动【冲阵】获得其一张手牌？', [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], { targetId })
  },
  resume(h, ownerId, resolution, response) {
    const targetId = (resolution.data as any).targetId as PlayerId
    if (resolution.step === 'choose') {
      if ((response.payload as any).optionId !== 'yes' || !player(h.state, targetId)?.alive || !hand(h.state, targetId).length) return
      const hiddenHandSlots = hand(h.state, targetId).map((_, index) => hiddenHandSlot(targetId, index))
      h.askSkill({ skillId: CHONGZHEN, ownerId, step: 'steal', data: { targetId }, build: id => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【冲阵】：选择获得其一张手牌（暗置）', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots: hiddenHandSlots, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'steal') {
      const picked = (response.payload as any).cardIds?.[0] as string | undefined
      const cardId = picked && resolvePickedCard(h.state, targetId, picked)
      if (!cardId || !movePickedCard(h as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) return
      h.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: CHONGZHEN }, { sourceId: targetId, cardIds: [cardId] })
      h.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CHONGZHEN }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
    }
  },
})

// SP貂蝉：离魂取走男角色全部手牌；阶段结束时按其当前体力逐张分配，翻面由回合引擎处理。
registerSkillRuntime({
  id: LIHUN,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && !usedThisPhase(state, ownerId, LIHUN) && owner.zones.hand.length > 0
      && others(state, ownerId).some(p => p.gender === 'male')
      ? [{ id: `skill:${LIHUN}`, label: '离魂：弃置一张牌并获得一名男性角色的所有手牌' }] : []
  },
  invokeActive(h, ownerId, actionId) {
    if (actionId !== `skill:${LIHUN}`) return
    askCards(h, LIHUN, ownerId, 'cost', '【离魂】：弃置一张牌', {}, false, 1, 1)
  },
  resume(h, ownerId, resolution, response) {
    const owner = player(h.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'cost') {
      const cardId = (response.payload as any).cardIds?.[0] as CardId | undefined
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      discard(h, ownerId, [cardId], LIHUN)
      markUsedThisPhase(h.state, ownerId, LIHUN)
      flipCharacter(h, ownerId, LIHUN)
      const candidates = others(h.state, ownerId).filter(p => p.gender === 'male').map(p => p.id)
      if (candidates.length) askTargets(h, LIHUN, ownerId, 'target', candidates, '【离魂】：选择一名男性角色获得其所有手牌', {}, false)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
      const target = targetId && player(h.state, targetId)
      if (!target?.alive || target.gender !== 'male') return
      const cards = [...target.zones.hand]
      if (!cards.length) return
      give(h, target.id, ownerId, cards, LIHUN)
      put(h, `${LIHUN}:target`, target.id)
      put(h, `${LIHUN}:needed`, target.hp)
      return
    }
    if (resolution.step === 'distribute') {
      const { targetId, remaining } = resolution.data as any
      const cardIds = [...new Set((response.payload as any).cardIds ?? [])].filter((id: CardId) => owner.zones.hand.includes(id)).slice(0, remaining)
      const target = player(h.state, targetId)
      if (target?.alive && cardIds.length === remaining) give(h, ownerId, targetId, cardIds, LIHUN)
    }
  },
  triggers: [
    { event: 'PhaseEnd', handle(h, ownerId, context) {
      const p = context.event.payload as any
      if (p.playerId !== ownerId || p.phase !== 'play') return
      const targetId = get(st(h), `${LIHUN}:target`) as PlayerId | undefined
      if (!targetId) return
      const target = player(h.state, targetId), owner = player(h.state, ownerId)
      const remaining = target?.hp ?? (get(st(h), `${LIHUN}:needed`) as number)
      erase(st(h), `${LIHUN}:target`); erase(st(h), `${LIHUN}:needed`)
      if (!target?.alive || !owner?.alive || remaining <= 0) return
      const count = Math.min(remaining, hand(h.state, ownerId).length)
      if (count > 0) askCards(h, LIHUN, ownerId, 'distribute', hand(h.state, ownerId), `【离魂】：交给该角色${count}张手牌`, { targetId, remaining: count }, false, count, count)
    } },
  ],
})

registerSkillRuntime({ id: BIYUE, triggers: [{ event: 'PhaseStart', handle(h, ownerId, context) {
  const p = context.event.payload as any
  if (p.playerId === ownerId && p.phase === 'finish') h.queueSkill({ skillId: BIYUE, ownerId, step: 'ask', data: {} })
} }], startQueued(h, ownerId, prompt) {
  if (prompt.step === 'ask') askOption(h, BIYUE, ownerId, 'resolve', '是否发动【闭月】摸一张牌？', [{ id: 'yes', label: '摸一张牌' }, { id: 'no', label: '不发动' }])
}, resume(h, ownerId, resolution, response) { if (resolution.step === 'resolve' && (response.payload as any).optionId === 'yes') draw(h, ownerId, 1) } })

// SP贾诩：针对普通即时锦囊禁止无懈，并禁止以延时锦囊指定为目标。
const ORDINARY_TRICKS = new Set(['无中生有', '铁索连环', '决斗', '过河拆桥', '顺手牵羊', '火攻', '借刀杀人'])
const DELAYED = new Set(['乐不思蜀', '兵粮寸断', '闪电'])
registerSkillRuntime({ id: ZHENLUE,
  cannotBeNullified(_state, _ownerId, cardName) { return ORDINARY_TRICKS.has(cardName) },
  prohibitsTarget(_state, _ownerId, _sourceId, cardName) { return DELAYED.has(cardName) },
})
registerSkillRuntime({ id: JIANSHU, limited: true, allowsDeadResponder: true,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && !owner.usedLimitedSkills.includes(JIANSHU) && hand(state, ownerId).some(id => effectiveCardColor(state, ownerId, id) === 'black')
      && others(state, ownerId).some(p => canPindian(state, p.id))
      ? [{ id: `skill:${JIANSHU}`, label: '间书：交给一名角色黑色手牌并令其与另一名角色拼点' }] : []
  },
  invokeActive(h, ownerId, actionId) {
    if (actionId !== `skill:${JIANSHU}`) return
    askCards(h, JIANSHU, ownerId, 'black-card', hand(h.state, ownerId).filter(id => effectiveCardColor(h.state, ownerId, id) === 'black'), '【间书】：交给一名角色一张黑色手牌')
  },
  startQueued(h, ownerId, prompt) {
    if (prompt.step !== 'tie-second-loss') return
    const loserId = prompt.data.loserId as PlayerId
    if (player(h.state, loserId)?.alive) loseHp(h as never, loserId, 1, JIANSHU)
    finishPindianSettlement(h as never)
  },
  resume(h, ownerId, resolution, response) {
    if (resolution.step === 'winner-discard') {
      const winnerId = (resolution.data as any).winnerId as PlayerId
      const ids = [...new Set((response.payload as any).cardIds ?? [])].filter((id: CardId) => locateOwnedCard(h.state, winnerId, id))
      discard(h, winnerId, ids, JIANSHU)
      finishPindianSettlement(h as never)
      return
    }
    if (resolution.step === 'black-card') {
      const cardId = (response.payload as any).cardIds?.[0] as CardId | undefined
      if (!cardId || !hand(h.state, ownerId).includes(cardId) || effectiveCardColor(h.state, ownerId, cardId) !== 'black') return
      put(h, `${JIANSHU}:card`, cardId)
      const candidates = others(h.state, ownerId).filter(receiver => canPindian(h.state, receiver.id)
        && others(h.state, receiver.id).some(candidate => canPindian(h.state, candidate.id)
          && getDistance(h.state, receiver.id, candidate.id) <= getAttackRange(h.state, receiver.id))).map(p => p.id)
      askTargets(h, JIANSHU, ownerId, 'beneficiary', candidates, '【间书】：选择获得黑色牌并参与拼点的角色')
      return
    }
    if (resolution.step === 'beneficiary') {
      const receiverId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
      const cardId = get(st(h), `${JIANSHU}:card`) as CardId | undefined
      if (!receiverId || !cardId || !hand(h.state, ownerId).includes(cardId) || !canPindian(h.state, receiverId)) return
      give(h, ownerId, receiverId, [cardId], JIANSHU)
      put(h, `${JIANSHU}:receiver`, receiverId)
      const opponentIds = others(h.state, receiverId).filter(p => canPindian(h.state, p.id) && getDistance(h.state, receiverId, p.id) <= getAttackRange(h.state, receiverId)).map(p => p.id)
      // 技能要求“另一名”目标：发起者和先前选定的角色均不可再次入选。
      if (!opponentIds.length) { erase(st(h), `${JIANSHU}:receiver`); return }
      askTargets(h, JIANSHU, ownerId, 'opponent', opponentIds, '【间书】：选择与其拼点的另一名角色')
      return
    }
    if (resolution.step === 'opponent') {
      const initiatorId = get(st(h), `${JIANSHU}:receiver`) as PlayerId | undefined
      const opponentId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
      erase(st(h), `${JIANSHU}:receiver`); erase(st(h), `${JIANSHU}:card`)
      if (!initiatorId || !opponentId || !canPindian(h.state, initiatorId) || !canPindian(h.state, opponentId)) return
      player(h.state, ownerId)!.usedLimitedSkills.push(JIANSHU)
      startPindian(h, { id: `b37-jianshu-${h.state.seq}`, initiatorId, opponentId, reason: JIANSHU, continuationTag: JIANSHU, data: { skillOwnerId: ownerId } })
    }
  },
})

// SP曹仁【伪溃】：看牌后分支由服务器判定；杀走真实虚拟杀流程，弃牌由曹仁选择。
registerSkillRuntime({ id: WEIKUI,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && player(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, WEIKUI) && others(state, ownerId).some(p => hand(state, p.id).length)
      ? [{ id: `skill:${WEIKUI}`, label: '伪溃：失去1点体力并查看一名有手牌角色的手牌' }] : []
  },
  invokeActive(h, ownerId, actionId) {
    if (actionId !== `skill:${WEIKUI}`) return
    const candidates = others(h.state, ownerId).filter(p => hand(h.state, p.id).length).map(p => p.id)
    askTargets(h, WEIKUI, ownerId, 'target', candidates, '【伪溃】：选择一名有手牌的其他角色')
  },
  resume(h, ownerId, resolution, response) {
    if (resolution.step === 'discard-target') {
      const { targetId } = resolution.data as any
      const cardId = (response.payload as any).cardIds?.[0] as CardId | undefined
      if (cardId && hand(h.state, targetId).includes(cardId)) discard(h, targetId, [cardId], WEIKUI)
      return
    }
    if (resolution.step === 'reveal-hand') {
      const targetId = (resolution.data as any).targetId as PlayerId
      const target = player(h.state, targetId)
      const owner = player(h.state, ownerId)
      if (!owner?.alive || !target?.alive || !target.zones.hand.length) return
      const hasDodge = target.zones.hand.some(cardId => h.state.cards[cardId]?.name === '闪')
      if (hasDodge) {
        forceDistance(h.state, { fromId: ownerId, toId: target.id, distance: 1, sourceSkillId: WEIKUI })
        forceDistance(h.state, { fromId: target.id, toId: ownerId, distance: 1, sourceSkillId: WEIKUI })
        h.beginVirtualSlash({ sourceId: ownerId, targetId: target.id, sourceSkillId: WEIKUI, countUsage: false })
      } else askCards(h, WEIKUI, ownerId, 'discard-target', hand(h.state, target.id), '【伪溃】：其没有【闪】，弃置其一张手牌', { targetId }, false, 1, 1)
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
    const target = targetId && player(h.state, targetId)
    if (!target?.alive || target.id === ownerId || !hand(h.state, target.id).length) return
    markUsedThisPhase(h.state, ownerId, WEIKUI)
    loseHp(h as never, ownerId, 1, WEIKUI)
    const owner = player(h.state, ownerId)
    if (!owner?.alive || !target.alive) return
    h.askSkill({ skillId: WEIKUI, ownerId, step: 'reveal-hand', data: { targetId: target.id }, build: id => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【伪溃】：观看目标手牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [], viewOnlyCardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max: 0,
    }) })
  },
})
registerSkillRuntime({ id: LIZHAN,
  triggers: [{ event: 'TurnEnd', handle(h, ownerId, context) {
    if ((context.event.payload as any).playerId !== ownerId) return
    h.queueSkill({ skillId: LIZHAN, ownerId, step: 'ask', data: {} })
  } }],
  startQueued(h, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const candidates = alive(h.state).filter(p => p.hp < p.maxHp).map(p => p.id)
    if (candidates.length) askTargets(h, LIZHAN, ownerId, 'targets', candidates, '【励战】：可以令任意名已受伤角色各摸一张牌', {}, true, 0, candidates.length)
  },
  resume(h, _ownerId, resolution, response) {
    if (resolution.step !== 'targets') return
    for (const id of (response.payload as any).targetIds ?? []) if (player(h.state, id)?.alive && player(h.state, id)!.hp < player(h.state, id)!.maxHp) draw(h, id, 1)
  },
})

const XINGWU_PILE = 'xingwu'
function refreshLuoyan(h: SkillHost, ownerId: PlayerId) {
  const owner = player(h.state, ownerId)
  replaceTemporarySkills(h.state, ownerId, LUOYAN, owner?.alive && (owner.characterPiles[XINGWU_PILE]?.length ?? 0) > 0 ? ['tianxiang', 'liuli'] : [])
}
registerSkillRuntime({ id: LUOYAN, onGameStart(h, ownerId) { refreshLuoyan(h, ownerId) } })
registerSkillRuntime({ id: XINGWU,
  triggers: [{ event: 'PhaseStart', handle(h, ownerId, context) {
    const p = context.event.payload as any
    if (p.playerId === ownerId && p.phase === 'discard' && hand(h.state, ownerId).length) h.queueSkill({ skillId: XINGWU, ownerId, step: 'place', data: {} })
  } }],
  startQueued(h, ownerId, prompt) {
    if (prompt.step === 'place' && hand(h.state, ownerId).length) askCards(h, XINGWU, ownerId, 'place-card', hand(h.state, ownerId), '【星舞】：可以将一张手牌置于武将牌上', {}, true, 0, 1)
  },
  resume(h, ownerId, resolution, response) {
    const owner = player(h.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'place-card') {
      const cardId = (response.payload as any).cardIds?.[0] as CardId | undefined
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(h.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: XINGWU_PILE })
      h.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: XINGWU }, { sourceId: ownerId, cardIds: [cardId] })
      refreshLuoyan(h, ownerId)
      const pile = owner.characterPiles[XINGWU_PILE] ?? []
      const suits = new Set(pile.map(id => effectiveCardSuit(h.state, ownerId, id)))
      if (['spade', 'heart', 'club', 'diamond'].filter(suit => suits.has(suit)).length === 3) askCards(h, XINGWU, ownerId, 'consume', pile, '【星舞】：移去每种花色各一张“舞”', {}, false, 3, 3)
      return
    }
    if (resolution.step === 'consume') {
      const chosen = [...new Set((response.payload as any).cardIds ?? [])].filter((id: CardId) => owner.characterPiles[XINGWU_PILE]?.includes(id)).slice(0, 3) as CardId[]
      const suits = chosen.map(id => effectiveCardSuit(h.state, ownerId, id))
      if (chosen.length !== 3 || new Set(suits).size !== 3) return
      for (const cardId of chosen) moveCard(h.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: XINGWU_PILE }, { kind: 'discardPile' })
      refreshLuoyan(h, ownerId)
      const candidates = others(h.state, ownerId).map(p => p.id)
      if (candidates.length) askTargets(h, XINGWU, ownerId, 'target', candidates, '【星舞】：选择一名其他角色，弃置其所有装备并对其造成伤害')
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
      const target = targetId && player(h.state, targetId)
      if (!target?.alive) return
      for (const cardId of Object.values(target.zones.equipment).filter(Boolean) as CardId[]) {
        const from = locateOwnedCard(h.state, target.id, cardId)
        if (from) moveCard(h.state, cardId, from, { kind: 'discardPile' })
        handleEquipmentLost(h as never, target.id, cardId)
      }
      resolveDamage(h as never, { sourceId: ownerId, targetId, amount: target.gender === 'female' ? 1 : 2, nature: 'normal', cardId: null, cardName: null })
      refreshLuoyan(h, ownerId)
    }
  },
})
registerPindianContinuation(JIANSHU, (host, result) => {
  const h = host as unknown as SkillHost
  const winnerId = result.outcome === 'initiator-win' ? result.initiatorId : result.outcome === 'opponent-win' ? result.opponentId : null
  if (winnerId) {
    const ownerId = result.data.skillOwnerId as PlayerId
    const winner = player(h.state, winnerId)!
    const ids = [...winner.zones.hand, ...Object.values(winner.zones.equipment).filter(Boolean)] as CardId[]
    if (ids.length === 0) { finishPindianSettlement(host as never); return }
    h.askSkill({ skillId: JIANSHU, ownerId, step: 'winner-discard', data: { winnerId }, build: id => ({
      id, kind: 'choose-cards', playerId: winnerId, prompt: '【间书】：拼点赢的角色弃置两张牌', timeoutMs: 25_000,
      optional: false, purpose: 'discard', cardIds: ids, hiddenCardSlots: [], min: Math.min(2, ids.length), max: Math.min(2, ids.length),
    }) })
    return 'defer-settlement'
  } else {
    const ownerId = result.data.skillOwnerId as PlayerId
    h.queueSkill({ skillId: JIANSHU, ownerId, step: 'tie-second-loss', data: { loserId: result.opponentId }, allowDeadOwner: true } as never)
    if (player(h.state, result.initiatorId)?.alive) loseHp(h as never, result.initiatorId, 1, JIANSHU)
    return 'defer-settlement'
  }
  finishPindianSettlement(host as never)
})

// 界马岱：潜袭限制记录在回合标记，使用与打出路径统一按牌名/颜色拦截。
registerSkillRuntime({ id: MASHU, distanceModifier: { toOthers: -1 } })
registerSkillRuntime({ id: QIANXI,
  triggers: [{ event: 'PhaseStart', handle(h, ownerId, context) {
    const p = context.event.payload as any
    if (p.playerId !== ownerId || p.phase !== 'prepare' || usedThisTurn(h.state, ownerId, QIANXI)) return
    h.queueSkill({ skillId: QIANXI, ownerId, step: 'start', data: {} })
  } }],
  startQueued(h, ownerId, prompt) {
    if (prompt.step !== 'start' || usedThisTurn(h.state, ownerId, QIANXI)) return
    const ids = hand(h.state, ownerId)
    if (!ids.length) return
    askOption(h, QIANXI, ownerId, 'invoke', '是否发动【潜袭】摸一张牌并弃置一张牌？', [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }])
  },
  resume(h, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as any).optionId !== 'yes') return
      draw(h, ownerId, 1)
      const ids = hand(h.state, ownerId)
      if (ids.length) askCards(h, QIANXI, ownerId, 'discard', ids, '【潜袭】：弃置一张牌')
      return
    }
    if (resolution.step === 'discard') {
      const cardId = (response.payload as any).cardIds?.[0] as CardId | undefined
      if (!cardId || !hand(h.state, ownerId).includes(cardId)) return
      const color = effectiveCardColor(h.state, ownerId, cardId)
      discard(h, ownerId, [cardId], QIANXI)
      markUsedThisTurn(h.state, ownerId, QIANXI)
      const candidates = others(h.state, ownerId).filter(p => getDistance(h.state, ownerId, p.id) === 1).map(p => p.id)
      if (candidates.length) askTargets(h, QIANXI, ownerId, 'target', candidates, '【潜袭】：选择一名距离为1的角色，本回合其不能使用或打出该颜色手牌', { color }, false)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
      if (!targetId) return
      const { color } = resolution.data as any
      if (color === 'red' || color === 'black') lockCardColor(h.state, { targetId, color, sourceId: ownerId, skillId: QIANXI })
    }
  },
})

// 界华雄【耀武】：伤害来源获得一个二选一救济，或华雄自己摸牌。
registerSkillRuntime({ id: YAOWU, triggers: [{ event: 'Damaged', handle(h, ownerId, context) {
  const p = context.event.payload as any
  if (context.event.targetId !== ownerId || p.cardName !== '杀') return
  const cardId = p.cardId as CardId | undefined
    const sourceId = context.event.sourceId as PlayerId | undefined
  const red = cardId ? effectiveCardColor(h.state, sourceId ?? ownerId, cardId) === 'red' : false
    if (red) {
      if (sourceId && player(h.state, sourceId)?.alive) h.queueSkill({ skillId: YAOWU, ownerId, step: 'red', data: { sourceId } })
    } else h.queueSkill({ skillId: YAOWU, ownerId, step: 'draw', data: {} })
} }], startQueued(h, ownerId, prompt) {
  if (prompt.step === 'red') {
    const sourceId = prompt.data.sourceId as PlayerId
    h.askSkill({ skillId: YAOWU, ownerId, step: 'red-choice', data: prompt.data, build: id => ({
      id, kind: 'choose-option', playerId: sourceId, prompt: '红色【杀】造成伤害：你可以令自己回复1点体力或摸一张牌', timeoutMs: 25_000, optional: false,
      options: [{ id: 'recover', label: '回复1点体力' }, { id: 'draw', label: '摸一张牌' }],
    }) })
  }
  if (prompt.step === 'draw') draw(h, ownerId, 1)
}, resume(h, ownerId, resolution, response) {
  if (resolution.step !== 'red-choice') return
  const sourceId = (resolution.data as any).sourceId as PlayerId
  if ((response.payload as any).optionId === 'recover') recover(h as never, sourceId, 1, sourceId)
  else if ((response.payload as any).optionId === 'draw') draw(h, sourceId, 1)
} })

registerSkillRuntime({ id: YONGDI, limited: true,
  triggers: [{ event: 'Damaged', handle(h, ownerId, context) {
    const p = context.event.payload as any
    if (context.event.targetId !== ownerId || !(p.amount > 0) || player(h.state, ownerId)?.usedLimitedSkills.includes(YONGDI)) return
    const candidates = others(h.state, ownerId).filter(p => p.gender === 'male')
    if (candidates.length) h.queueSkill({ skillId: YONGDI, ownerId, step: 'target', data: {} })
  } }],
  startQueued(h, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const candidates = others(h.state, ownerId).filter(p => p.gender === 'male').map(p => p.id)
    if (candidates.length) askTargets(h, YONGDI, ownerId, 'choose', candidates, '【拥嫡】：可以令一名其他男性角色增加1点体力上限', {}, true)
  },
  resume(h, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const targetId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
    const target = targetId && player(h.state, targetId)
    if (!target?.alive || target.id === ownerId || target.gender !== 'male') return
    player(h.state, ownerId)!.usedLimitedSkills.push(YONGDI)
    gainMaxHp(h as never, targetId, 1, YONGDI)
    const lordSkills = characterSkillIdsOf(target.characterId ?? '').filter(id => getSkillRuntime(id)?.lord)
    if (target.identity !== 'lord') for (const skillId of lordSkills) grantSkill(h.state, targetId, skillId)
  },
})

registerSkillRuntime({ id: KUNFEN,
  onGameStart(h, ownerId) { put(h, `${KUNFEN}:${ownerId}:level`, 1) },
  triggers: [{ event: 'PhaseStart', handle(h, ownerId, context) {
    const p = context.event.payload as any
    if (p.playerId === ownerId && p.phase === 'finish') h.queueSkill({ skillId: KUNFEN, ownerId, step: 'finish', data: {} })
  } }],
  startQueued(h, ownerId, prompt) {
    if (prompt.step !== 'finish') return
    const level = get(st(h), `${KUNFEN}:${ownerId}:level`) ?? 1
    if (level === 1) {
      loseHp(h as never, ownerId, 1, KUNFEN)
      if (player(h.state, ownerId)?.alive) draw(h, ownerId, 2)
    } else askOption(h, KUNFEN, ownerId, 'invoke', '是否发动二级【困奋】？失去1点体力并摸两张牌', [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }])
  },
  resume(h, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as any).optionId !== 'yes') return
    loseHp(h as never, ownerId, 1, KUNFEN)
    if (player(h.state, ownerId)?.alive) draw(h, ownerId, 2)
  },
})
registerSkillRuntime({ id: FENGLIANG,
  triggers: [{ event: 'EnterDying', priority: 100, handle(h, ownerId, context) {
    if (context.event.targetId !== ownerId || player(h.state, ownerId)?.awakenedSkills.includes(FENGLIANG)) return
    const owner = player(h.state, ownerId)
    if (!owner?.alive) return
    owner.awakenedSkills.push(FENGLIANG)
    loseMaxHp(h as never, ownerId, 1, FENGLIANG)
    const current = player(h.state, ownerId)
    if (!current?.alive) return
    if (current.hp < 2) recover(h as never, ownerId, 2 - current.hp, ownerId)
    grantSkill(h.state, ownerId, TIAOXIN)
    put(h, `${KUNFEN}:${ownerId}:level`, 2)
  } }],
})

// SP蔡文姬【陈情】：濒死前置介入，牌由被选者自己摸、自己选择弃置，花色检查实体牌。
registerSkillRuntime({ id: CHENQING, limited: false,
  dyingAssist(h, ownerId, dyingPlayerId) {
    const owner = player(h.state, ownerId)
    const used = get(st(h), `${CHENQING}:round`)
    if (!owner?.alive || ownerId === dyingPlayerId || used === h.state.roundNumber) return false
    const candidates = others(h.state, ownerId).filter(p => p.id !== dyingPlayerId)
    if (!candidates.length) return false
    h.askSkill({ skillId: CHENQING, ownerId, step: 'target', data: { dyingPlayerId }, build: id => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【陈情】：可以令一名其他角色摸四张牌并弃置四张牌', timeoutMs: 25_000,
      optional: true, candidateIds: candidates.map(p => p.id), min: 0, max: 1,
    }) })
    return 'pending'
  },
  resume(h, ownerId, resolution, response) {
    const { dyingPlayerId } = resolution.data as any
    if (resolution.step === 'target') {
      const targetId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
      if (!targetId) { continueDyingAssists(h as never); return }
      put(h, `${CHENQING}:round`, h.state.roundNumber)
      const target = player(h.state, targetId)
      if (!target?.alive) { continueDyingAssists(h as never); return }
      draw(h, targetId, 4)
      const count = Math.min(4, hand(h.state, targetId).length)
      if (count === 0) { continueDyingAssists(h as never); return }
      h.askSkill({ skillId: CHENQING, ownerId, step: 'discard', data: { dyingPlayerId, targetId }, build: id => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: '【陈情】：选择四张牌弃置', timeoutMs: 25_000,
        optional: false, purpose: 'discard', cardIds: [...hand(h.state, targetId)], hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (resolution.step === 'discard') {
      const { targetId } = resolution.data as any
      const target = player(h.state, targetId)
      const ids = [...new Set((response.payload as any).cardIds ?? [])].filter((id: CardId) => target?.zones.hand.includes(id)).slice(0, 4)
      const suits = ids.map((id: CardId) => effectiveCardSuit(h.state, targetId, id))
      discard(h, targetId, ids, CHENQING)
      const allDifferent = ids.length === 4 && new Set(suits).size === 4
      if (allDifferent && player(h.state, dyingPlayerId)?.hp <= 0) h.useVirtualPeachDuringDying(targetId, dyingPlayerId, CHENQING)
      else continueDyingAssists(h as never)
    }
  },
})

const DELAYED_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])
registerSkillRuntime({ id: MOSHI,
  onGameStart(h, ownerId) { put(h, `${MOSHI}:${ownerId}:names`, []) },
  triggers: [{ event: 'CardUsed', handle(h, ownerId, context) {
    if (context.event.sourceId !== ownerId || h.state.phase !== 'play') return
    const p = context.event.payload as any
    const cardName = p.cardName as string | undefined
    const isBasic = ['杀', '闪', '桃', '酒'].includes(cardName ?? '')
    const isTrick = ['无中生有', '桃园结义', '铁索连环', '南蛮入侵', '万箭齐发', '决斗', '过河拆桥', '顺手牵羊', '五谷丰登', '火攻', '借刀杀人', '奇正相生'].includes(cardName ?? '')
    if ((!isBasic && !isTrick) || DELAYED_NAMES.has(cardName ?? '')) return
    const names = get(st(h), `${MOSHI}:${ownerId}:names`) as string[] ?? []
    if (names.length < 2) put(h, `${MOSHI}:${ownerId}:names`, [...names, cardName ?? card.name])
  } }, { event: 'PhaseStart', handle(h, ownerId, context) {
    const p = context.event.payload as any
    if (p.playerId !== ownerId) return
    if (p.phase === 'play') { put(h, `${MOSHI}:${ownerId}:names`, []); return }
    if (p.phase === 'finish') {
      const names = get(st(h), `${MOSHI}:${ownerId}:names`) as string[] ?? []
      if (names.length && hand(h.state, ownerId).length) h.queueSkill({ skillId: MOSHI, ownerId, step: 'first', data: { names } })
    }
  } }, { event: 'AfterCardUse', handle(h, ownerId, context) {
    if (context.event.sourceId !== ownerId || !get(st(h), `${MOSHI}:await-second`)) return
    put(h, `${MOSHI}:await-second`, false)
    h.queueSkill({ skillId: MOSHI, ownerId, step: 'second', data: { names: get(st(h), `${MOSHI}:${ownerId}:names`) } })
  } }],
  startQueued(h, ownerId, prompt) {
    const names = (prompt.data.names as string[] | undefined) ?? get(st(h), `${MOSHI}:${ownerId}:names`) ?? []
    if (prompt.step === 'first' && names.length && hand(h.state, ownerId).length) askOption(h, MOSHI, ownerId, 'invoke-first', `【默识】：可将手牌当第一张牌【${names[0]}】使用`, [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], { names })
    if (prompt.step === 'second' && names[1] && hand(h.state, ownerId).length) askOption(h, MOSHI, ownerId, 'invoke-second', `【默识】：可将手牌当第二张牌【${names[1]}】使用`, [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], { names })
  },
  resume(h, ownerId, resolution, response) {
    const actionStep = resolution.step === 'first-actions' || resolution.step === 'second-actions'
    if (resolution.step === 'invoke-first' || resolution.step === 'invoke-second') {
      const names = (resolution.data as any).names as string[]
      if ((response.payload as any).optionId !== 'yes') {
        if (resolution.step === 'invoke-first' && names[1] && hand(h.state, ownerId).length) {
          askOption(h, MOSHI, ownerId, 'invoke-second', `【默识】：可将一张手牌当第二张牌【${names[1]}】使用`, [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], { names })
        }
        return
      }
      const cardStep = resolution.step === 'invoke-first' ? 'first-card' : 'second-card'
      askCards(h, MOSHI, ownerId, cardStep, hand(h.state, ownerId), `【默识】：选择一张手牌当【${names[cardStep === 'first-card' ? 0 : 1]}】使用`)
      return
    }
    if (resolution.step === 'first-card' || resolution.step === 'second-card') {
      const index = resolution.step === 'first-card' ? 0 : 1
      const names = get(st(h), `${MOSHI}:${ownerId}:names`) as string[] ?? []
      const cardId = (response.payload as any).cardIds?.[0] as CardId | undefined
      if (!cardId || !hand(h.state, ownerId).includes(cardId) || !names[index]) return
      const actions = declaredCardActions(h.state, ownerId, cardId, names[index], `默识：手牌当【${names[index]}】`)
        .filter(action => action.kind === 'use-card' && !action.id.includes('recast'))
      if (!actions.length) {
        if (index === 0 && names[1] && hand(h.state, ownerId).length) askOption(h, MOSHI, ownerId, 'invoke-second', `【默识】：可将一张手牌当第二张牌【${names[1]}】使用`, [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], { names })
        return
      }
      askOption(h, MOSHI, ownerId, index === 0 ? 'first-actions' : 'second-actions', `【默识】：选择【${names[index]}】的合法目标`, actions.map(action => ({ id: action.id, label: action.label })), { actionIds: actions.map(action => action.id), index })
      return
    }
    if (actionStep) {
      const actionId = (response.payload as any).optionId as string
      const actionIds = (resolution.data as any).actionIds as string[]
      if (!actionIds.includes(actionId)) return
      const names = get(st(h), `${MOSHI}:${ownerId}:names`) as string[] ?? []
      const index = (resolution.data as any).index as number
      const cardId = hand(h.state, ownerId).find(id => declaredCardActions(h.state, ownerId, id, names[index], '').some(action => action.id === actionId))
      if (!cardId) return
      const action = declaredCardActions(h.state, ownerId, cardId, names[index], `默识：手牌当【${names[index]}】`).find(candidate => candidate.id === actionId)
      if (!action || action.kind !== 'use-card') return
      put(h, `${MOSHI}:await-second`, index === 0 && names.length > 1)
      executeUseCardAction(h as never, ownerId, action)
      return
    }
    if (resolution.step === 'second-confirm' && (response.payload as any).optionId === 'yes') {
      const names = get(st(h), `${MOSHI}:${ownerId}:names`) as string[] ?? []
      if (names[1]) askCards(h, MOSHI, ownerId, 'second-card', hand(h.state, ownerId), `【默识】：选择一张手牌当【${names[1]}】使用`)
    }
  },
})

export const SP_MA_CHAO_B37: CharacterDefinition = { id: 'sp-machao-b37', name: 'SP·马超', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: ZHUIJI, name: '追击', description: '锁定技，你计算与体力值不大于你的角色的距离视为1。' },
  { id: SH仇, name: '誓仇', description: '你使用【杀】可以多选择至多X名角色为目标（X为你已损失的体力值）。' },
] }
export const SP_ZHAO_YUN_B37: CharacterDefinition = { id: 'sp-zhaoyun-b37', name: 'SP·赵云', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: LONGDAN, name: '龙胆', description: '你可以将一张【杀】当【闪】、【闪】当【杀】使用或打出。' },
  { id: CHONGZHEN, name: '冲阵', description: '每当你发动【龙胆】使用或打出一张手牌时，你可以立即获得对方一张手牌。' },
] }
export const SP_DIAO_CHAN_B37: CharacterDefinition = { id: 'sp-diaochan-b37', name: 'SP·貂蝉', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
  { id: LIHUN, name: '离魂', description: '出牌阶段限一次，你可以弃置一张牌并将你的武将牌翻面，然后获得一名男性角色的所有手牌；出牌阶段结束时，你须交给其X张牌（X为其体力值）。' },
  { id: BIYUE, name: '闭月', description: '结束阶段，你可以摸一张牌。' },
] }
export const SP_JIA_XU_B37: CharacterDefinition = { id: 'sp-jiaxu-b37', name: 'SP·贾诩', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: ZHENLUE, name: '缜略', description: '锁定技，你使用的普通锦囊牌不能被【无懈可击】响应；你不能被选择为延时锦囊牌的目标。' },
  { id: JIANSHU, name: '间书', description: '限定技，出牌阶段，你可以将一张黑色手牌交给一名其他角色，并选择一名攻击范围内含有其的另一名角色，然后令这两名角色拼点：赢的角色弃置两张牌，没赢的角色失去1点体力。' },
  { id: YONGDI, name: '拥嫡', description: '限定技，当你受到伤害后，你可令一名其他男性角色增加1点体力上限；若其武将牌上有主公技且身份不为主公，其获得此主公技。' },
] }
export const SP_CAO_REN_B37: CharacterDefinition = { id: 'sp-caoren-b37', name: 'SP·曹仁', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: WEIKUI, name: '伪溃', description: '出牌阶段限一次，你可以失去1点体力并选择一名有手牌的其他角色，观看其手牌：若其有【闪】，视为你对其使用一张不计次数的【杀】，且本回合你与其距离视为1；若没有，你弃置其一张手牌。' },
  { id: LIZHAN, name: '励战', description: '回合结束时，你可以令任意名已受伤的角色各摸一张牌。' },
] }
export const SP_CAI_WEN_JI_B37: CharacterDefinition = { id: 'sp-caiwenji-b37', name: 'SP·蔡文姬', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
  { id: CHENQING, name: '陈情', description: '每轮限一次，当一名角色进入濒死状态时，你可以令另一名其他角色摸四张牌，然后弃置四张牌；若弃置的牌花色各不相同，其视为对濒死角色使用一张【桃】。' },
  { id: MOSHI, name: '默识', description: '结束阶段，你可以将一张手牌当你出牌阶段内使用过的第一张基本牌或普通锦囊牌使用，然后你可以将一张手牌当你出牌阶段使用过的第二张基本牌或普通锦囊牌使用。' },
] }
export const DA_QIAO_XIAO_QIAO_B37: CharacterDefinition = { id: 'daqiaoxiaoqiao-b37', name: '大乔小乔', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
  { id: XINGWU, name: '星舞', description: '弃牌阶段开始时，你可以将一张手牌置于武将牌上，称为“舞”。若“舞”包含三种花色，则移去每种花色各一张，然后弃置一名其他角色装备区里的所有牌，之后对其造成2点伤害（若为女性角色则改为1点伤害）。' },
  { id: LUOYAN, name: '落雁', description: '锁定技，若你有“星舞”牌，你视为拥有【天香】和【流离】。' },
] }
export const SP_JIANG_WEI_B37: CharacterDefinition = { id: 'sp-jiangwei-b37', name: 'SP·姜维', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: KUNFEN, name: '困奋', description: '1级：锁定技，结束阶段，你失去1点体力，然后摸两张牌。2级：结束阶段，你可以失去1点体力，然后摸两张牌。' },
  { id: FENGLIANG, name: '逢亮', description: '觉醒技，当你进入濒死状态时，你减1点体力上限并将体力回复至2点，然后获得【挑衅】并升级【困奋】。' },
] }
export const JIE_MA_DAI_B37: CharacterDefinition = { id: 'jie-madai-b37', name: '界·马岱', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: MASHU, name: '马术', description: '锁定技，你计算与其他角色的距离-1。' },
  { id: QIANXI, name: '潜袭', description: '准备阶段，你可以摸一张牌并弃置一张牌。若如此做，你选择距离为1的一名角色，然后本回合该角色不能使用或打出与你以此法弃置的牌颜色相同的手牌。' },
] }
export const JIE_HUA_XIONG_B37: CharacterDefinition = { id: 'jie-huaxiong-b37', name: '界·华雄', kingdom: 'qun', gender: 'male', maxHp: 6, pack: 'sp', skills: [
  { id: YAOWU, name: '耀武', description: '锁定技，当你受到【杀】造成的伤害时，若此【杀】为红色，伤害来源回复1点体力或摸一张牌；若此【杀】不为红色，则你摸一张牌。' },
] }

export const HISTORICAL_BATCH35_CHARACTERS: readonly CharacterDefinition[] = [SP_MA_CHAO_B37, SP_ZHAO_YUN_B37, SP_DIAO_CHAN_B37, SP_JIA_XU_B37, SP_CAO_REN_B37, SP_CAI_WEN_JI_B37, DA_QIAO_XIAO_QIAO_B37, SP_JIANG_WEI_B37, JIE_MA_DAI_B37, JIE_HUA_XIONG_B37]
