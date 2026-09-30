import type { CardId, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'
import type { CharacterDefinition } from './types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, replaceTemporarySkills, skillsOf, getSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { discardCardsByIds } from '../../engine/discard-all'
import { moveCard } from '../../engine/zones'
import { effectiveCardColor } from '../../engine/skills/runtime'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { getCharacter } from './standard'
import { skillIdsOf } from './standard'
import { performJudgment, registerJudgmentContinuation, type JudgmentEngineHost } from '../../engine/judgment'
import { resolveDamage } from '../../engine/damage'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { cardDamageDealt } from '../../engine/card-damage-ledger'

const B = '-b75'
const sid = (name: string) => `${name}${B}`
const BIANXI_DUNXI = sid('dunxi-bianxi')
const GUANNING_XIUWEN = sid('xiuwen-guanning')
const GUANNING_LONGSONG = sid('longsong-guanning')
const HANLONG_DUWANG = sid('duwang-hanlong')
const HANLONG_CIBEI = sid('cibei-hanlong')
const ZHANGCHU_JIZHONG = sid('jizhong-zhangchu')
const ZHANGCHU_RIHUI = sid('rihui-zhangchu')
const ZHANGCHU_GUANGSHI = sid('guangshi-zhangchu')
const GONGSUNDU_ZHENZE = sid('zhenze-gongsundu')
const GONGSUNDU_ANLIAO = sid('anliao-gongsundu')
const YUANSHI_NEIFA = sid('neifa-yuantanshangxi')
const DONGGUIREN_LIANZHI = sid('lianzhi-dongguiren')
const DONGGUIREN_LINGFANG = sid('lingfang-dongguiren')
const DONGGUIREN_FENGYING = sid('fengying-dongguiren')
const ZHANGJINYUN_HUIZHI = sid('huizhi-zhangjinyun')
const ZHANGJINYUN_JIJIAO = sid('jijiao-zhangjinyun')
const DUANQIAOXIAO_CAIZHUANG = sid('caizhuang-duanqiaoxiao')
const DUANQIAOXIAO_HUAYI = sid('huayi-duanqiaoxiao')
const TIANSHANGYI_POSUO = sid('posuo-tianshangyi')
const TIANSHANGYI_XIAOREN = sid('xiaoren-tianshangyi')
const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])
const DUANQIAOXIAO_HUAYI_JUDGMENT = `${DUANQIAOXIAO_HUAYI}:judge`
const TIANSHANGYI_XIAOREN_JUDGMENT = `${TIANSHANGYI_XIAOREN}:judge`

registerJudgmentContinuation(DUANQIAOXIAO_HUAYI_JUDGMENT, (host, result, data) => {
  const ownerId = data.ownerId as PlayerId
  s75(host.state).huayi ??= {}
  s75(host.state).huayi[ownerId] = { color: result.color }
})
registerJudgmentContinuation(TIANSHANGYI_XIAOREN_JUDGMENT, (host, result, data) => {
  const ownerId = data.ownerId as PlayerId
  const injuredTargetId = data.injuredTargetId as PlayerId
  if (result.color === 'red') {
    const candidates = living(host.state).map(({ id }) => id)
    if (candidates.length) askTargets(host, TIANSHANGYI_XIAOREN, ownerId, 'red-target', ownerId, candidates,
      '【绡刃】：令一名角色回复1点体力', { chain: data.chain })
    return
  }
  const target = player(host.state, injuredTargetId)
  if (!target) return
  const candidates = living(host.state).filter((candidate) => candidate.id !== injuredTargetId
    && (Math.abs(candidate.seat - target.seat) === 1 || Math.abs(candidate.seat - target.seat) === host.state.players.length - 1))
    .map(({ id }) => id)
  if (candidates.length) askTargets(host, TIANSHANGYI_XIAOREN, ownerId, 'black-target', ownerId, candidates,
    '【绡刃】：对受伤角色的上家或下家造成1点伤害', { injuredTargetId, chain: data.chain })
})

function startZhangChuEcho(host: SkillHost, ownerId: PlayerId): void {
  const queue = s75(host.state).rihuiQueue?.[ownerId] as Array<{ sourceId: PlayerId; targetId: PlayerId; cardName: string; category: string }> | undefined
  while (queue?.length) {
    const next = queue.shift()!
    if (!player(host.state, next.sourceId)?.alive || !player(host.state, next.targetId)?.alive) continue
    const started = next.category === 'basic'
      ? host.beginVirtualBasic({ sourceId: next.sourceId, targetIds: [next.targetId], cardName: next.cardName, sourceSkillId: ZHANGCHU_RIHUI })
      : host.beginVirtualTrick({ sourceId: next.sourceId, targetId: next.targetId, cardName: next.cardName, sourceSkillId: ZHANGCHU_RIHUI })
    if (started) return
  }
  if (s75(host.state).rihuiQueue) delete s75(host.state).rihuiQueue[ownerId]
}

type B75State = SanguoshaState & { b75?: Record<string, any> }
function s75(state: SanguoshaState): Record<string, any> { const value = state as B75State; value.b75 ??= {}; return value.b75 }
function player(state: SanguoshaState, id: PlayerId) { return state.players.find((entry) => entry.id === id) }
function living(state: SanguoshaState) { return state.players.filter((entry) => entry.alive) }
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId,
    prompt, timeoutMs: 25_000, optional, options }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, candidateIds: PlayerId[],
  prompt: string, data: Record<string, unknown> = {}, min = 1, max = 1) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId,
    prompt, timeoutMs: 25_000, optional: false, candidateIds, min, max }) })
}
function askPickable(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, targetId: PlayerId,
  prompt: string, data: Record<string, unknown> = {}, min = 1, max = 1, includeJudgingArea = false) {
  const cards = pickableCardsOf(host.state, targetId, { discarderId: playerId, includeJudgingArea })
  host.askSkill({ skillId, ownerId, step, data: { ...data, targetId }, build: (id) => ({ id, kind: 'choose-cards', playerId,
    prompt, timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards.cardIds, hiddenCardSlots: cards.hiddenCardSlots,
    min: Math.min(min, cards.cardIds.length + cards.hiddenCardSlots.length), max: Math.min(max, cards.cardIds.length + cards.hiddenCardSlots.length) }) })
}
function blackTrickOrBasic(state: SanguoshaState, ownerId: PlayerId, id: CardId) {
  const card = state.cards[id]
  return !!card && (card.category === 'basic' || card.category === 'trick') && effectiveCardColor(state, ownerId, id) === 'black'
}

registerSkillRuntime({ id: DONGGUIREN_LINGFANG, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    if ((context.event.payload as { phase?: TurnPhase }).phase !== 'prepare') return
    const owner = player(host.state, ownerId)
    if (owner) { owner.marks ??= {}; owner.marks['绞'] = (owner.marks['绞'] ?? 0) + 1 }
  } },
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    const data = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
    const sourceId = context.event.sourceId
    if (!data.cardId || !sourceId || (sourceId !== ownerId && !data.targetIds?.includes(ownerId))) return
    if (sourceId === ownerId && !(data.targetIds ?? []).some((id) => id !== ownerId)) return
    if (!blackTrickOrBasic(host.state, ownerId, data.cardId)) return
    const owner = player(host.state, ownerId)
    if (owner) { owner.marks ??= {}; owner.marks['绞'] = (owner.marks['绞'] ?? 0) + 1 }
  } },
] })

// Runtime implementations are kept in this batch module so each roster entry remains
// coupled to its actual rules rather than becoming a registration-only stub.
registerSkillRuntime({ id: DONGGUIREN_LIANZHI,
  onGameStart(host, ownerId) {
    const candidates = living(host.state).filter((target) => target.id !== ownerId).map(({ id }) => id)
    if (candidates.length) askTargets(host, DONGGUIREN_LIANZHI, ownerId, 'choose-bond', ownerId, candidates, '【连枝】：选择一名连枝角色')
  },
  triggers: [
    { event: 'EnterDying', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || s75(host.state).lianzhiRescued?.[ownerId] === host.state.turnNumber) return
      const partnerId = s75(host.state).lianzhiPartner?.[ownerId] as PlayerId | undefined
      if (!partnerId || !player(host.state, partnerId)?.alive) return
      s75(host.state).lianzhiRescued ??= {}
      s75(host.state).lianzhiRescued[ownerId] = host.state.turnNumber
      recover(host as never, ownerId, 1, partnerId)
      drawCards(host.state, host.rng, ownerId, 1)
      drawCards(host.state, host.rng, partnerId, 1)
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const partnerId = s75(host.state).lianzhiPartner?.[ownerId] as PlayerId | undefined
      if (!partnerId || context.event.targetId !== partnerId) return
      const candidates = living(host.state).filter((target) => target.id !== ownerId).map(({ id }) => id)
      if (candidates.length) askTargets(host, DONGGUIREN_LIANZHI, ownerId, 'replace-bond', ownerId, candidates, '【连枝】：选择新连枝角色')
    } },
  ],
  resume(host, ownerId, resolution, response) {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !player(host.state, targetId)?.alive || targetId === ownerId) return
    if (resolution.step === 'choose-bond') {
      s75(host.state).lianzhiPartner ??= {}
      s75(host.state).lianzhiPartner[ownerId] = targetId
      return
    }
    if (resolution.step === 'replace-bond') {
      s75(host.state).lianzhiPartner[ownerId] = targetId
      const count = Math.max(1, Number(player(host.state, ownerId)?.marks?.['绞'] ?? 0))
      const owner = player(host.state, ownerId)!
      owner.marks ??= {}
      owner.marks['受责'] = 1
      const partner = player(host.state, targetId)!
      partner.marks ??= {}
      partner.marks['受责'] = 1
      partner.marks['绞'] = (partner.marks['绞'] ?? 0) + count
    }
  },
})

registerSkillRuntime({ id: DONGGUIREN_FENGYING,
  viewAs(state, ownerId) {
    const owner = player(state, ownerId)
    const allowedNames = (s75(state).fengyingNames?.[ownerId] ?? []) as string[]
    const marks = owner?.marks?.['绞'] ?? 0
    if (!owner || !allowedNames.length || marks <= 0) return []
    const already = (s75(state).fengyingUsed?.[ownerId]?.[state.turnNumber] ?? []) as string[]
    return owner.zones.hand.flatMap((cardId) => {
      const card = state.cards[cardId]
      if (!card || card.rank > marks) return []
      return allowedNames.filter((name) => !already.includes(name)).map((name) => ({ cardId, asCardName: name,
        label: `【风影】：${name}` }))
    })
  },
  unlimitedSlashFor(state, ownerId, cardId) {
    const card = cardId ? state.cards[cardId] : undefined
    return !!card && card.rank <= (player(state, ownerId)?.marks?.['绞'] ?? 0)
      && (s75(state).fengyingNames?.[ownerId] ?? []).includes('杀')
  },
  unlimitedWineFor(state, ownerId, cardId) {
    const card = cardId ? state.cards[cardId] : undefined
    return !!card && card.rank <= (player(state, ownerId)?.marks?.['绞'] ?? 0)
      && (s75(state).fengyingNames?.[ownerId] ?? []).includes('酒')
  },
  ignoresTrickDistance(state, ownerId, cardId) {
    const card = cardId ? state.cards[cardId] : undefined
    return !!card && card.rank <= (player(state, ownerId)?.marks?.['绞'] ?? 0)
      && (s75(state).fengyingNames?.[ownerId] ?? []).some((name: string) => {
        const definition = Object.values(state.cards).find((candidate) => candidate.name === name)
        return definition?.category === 'trick' && !DELAYED_TRICK_NAMES.has(name)
      })
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId) {
      const names = new Set<string>()
      for (const cardId of host.state.zones.discardPile) {
        const card = host.state.cards[cardId]
        if (card?.color === 'black' && (card.category === 'basic' || card.category === 'trick')
          && !(card.category === 'trick' && DELAYED_TRICK_NAMES.has(card.name))) names.add(card.name)
      }
      s75(host.state).fengyingNames ??= {}
      s75(host.state).fengyingNames[ownerId] = [...names]
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== DONGGUIREN_FENGYING) return
      const name = (context.event.payload as { cardName?: string }).cardName
      if (!name) return
      s75(host.state).fengyingUsed ??= {}
      s75(host.state).fengyingUsed[ownerId] ??= {}
      const used = s75(host.state).fengyingUsed[ownerId]
      used[host.state.turnNumber] ??= []
      if (!used[host.state.turnNumber].includes(name)) used[host.state.turnNumber].push(name)
    } },
  ],
})

registerSkillRuntime({ id: BIANXI_DUNXI,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const data = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const card = data.cardId ? host.state.cards[data.cardId] : undefined
      if (!card || !data.targetIds?.length || !(card.name === '杀' || DAMAGE_TRICKS.has(data.cardName ?? card.name))) return
      host.queueSkill({ skillId: BIANXI_DUNXI, ownerId, step: 'mark-target', data: { targetIds: data.targetIds } })
    } },
    { event: 'BeforeCardUse', priority: 100, handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const card = data.cardId ? host.state.cards[data.cardId] : undefined
      if (!card || !data.targetIds || data.targetIds.length !== 1
        || (card.category !== 'basic' && card.category !== 'trick')) return
      const oldTargetId = data.targetIds[0]!
      const tokens = s75(host.state).dunxiTokens?.[oldTargetId] as Record<PlayerId, number> | undefined
      if (!tokens || Number(tokens[ownerId] ?? 0) <= 0 || (player(host.state, oldTargetId)?.marks?.['钝'] ?? 0) <= 0) return
      const target = player(host.state, oldTargetId)!
      target.marks!['钝'] = Math.max(0, target.marks!['钝'] - 1)
      tokens[ownerId] -= 1
      const choices = living(host.state)
      if (!choices.length) return
      const newTargetId = host.rng.pick(choices).id
      data.targetIds[0] = newTargetId
      if (data.cardId) {
        s75(host.state).dunxiPending ??= {}
        s75(host.state).dunxiPending[data.cardId] = { sourceId: context.event.sourceId, oldTargetId, same: newTargetId === oldTargetId }
      }
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const { cardId } = context.event.payload as { cardId?: CardId }
      const pending = cardId ? s75(host.state).dunxiPending?.[cardId] : undefined
      if (!pending) return
      delete s75(host.state).dunxiPending[cardId!]
      if (!pending.same || !player(host.state, pending.sourceId)?.alive) return
      loseHp(host as never, pending.sourceId, 1, BIANXI_DUNXI)
      host.endPlayPhaseEarly(pending.sourceId)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'mark-target') return
    const candidates = (prompt.data.targetIds as PlayerId[]).filter((id) => player(host.state, id)?.alive)
    if (candidates.length) askTargets(host, BIANXI_DUNXI, ownerId, 'choose-mark', ownerId, candidates, '【钝袭】：选择令其获得“钝”的目标')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-mark') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId) return
    const target = player(host.state, targetId)
    if (!target?.alive) return
    target.marks ??= {}
    target.marks['钝'] = (target.marks['钝'] ?? 0) + 1
    s75(host.state).dunxiTokens ??= {}
    s75(host.state).dunxiTokens[targetId] ??= {}
    s75(host.state).dunxiTokens[targetId][ownerId] = Number(s75(host.state).dunxiTokens[targetId][ownerId] ?? 0) + 1
  },
})

registerSkillRuntime({ id: GUANNING_XIUWEN, triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
  if (context.event.sourceId !== ownerId) return
  const payload = context.event.payload as { cardName?: string }
  const name = payload.cardName
  if (!name || s75(host.state).xiuwenNames?.[ownerId]?.includes(name)) return
  askOption(host, GUANNING_XIUWEN, ownerId, 'draw', ownerId, `【修文】：是否摸一张牌（本回合首次使用${name}）`,
    [{ id: 'yes', label: '摸一张牌' }], { name })
} }], resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'draw' || (response.payload as { optionId?: string }).optionId !== 'yes') return
  const name = resolution.data.name as string
  s75(host.state).xiuwenNames ??= {}
  ;(s75(host.state).xiuwenNames[ownerId] ??= []).push(name)
  drawCards(host.state, host.rng, ownerId, 1)
} })

registerSkillRuntime({ id: GUANNING_LONGSONG,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      if ((context.event.payload as { phase?: TurnPhase }).phase !== 'play' || host.state.currentPlayerId !== ownerId) return
      const candidates = living(host.state).filter((target) => target.id !== ownerId && target.characterId
        && skillsOf(host.state, target.id, skillIdsOf).some((runtime) => !!runtime.activeActions)
        && (player(host.state, ownerId)?.zones.hand.some((id) => host.state.cards[id]?.color === 'red')
          || target.zones.hand.some((id) => host.state.cards[id]?.color === 'red'))).map(({ id }) => id)
      if (candidates.length) askOption(host, GUANNING_LONGSONG, ownerId, 'offer', ownerId, '【龙诵】：是否与一名角色交换一张红色手牌并获得其出牌阶段技能？',
        [{ id: 'yes', label: '发动龙诵' }], { candidates })
    } },
    { event: 'SkillActivated', handle(host, ownerId, context) {
      const data = context.event.payload as { skillId?: string }
      const borrowed = s75(host.state).longsongBorrowed?.[ownerId]
      if (context.event.sourceId !== ownerId || !borrowed || data.skillId !== borrowed.skillId) return
      s75(host.state).longsongBorrowed[ownerId].used = true
      replaceTemporarySkills(host.state, ownerId, GUANNING_LONGSONG, [])
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const data = context.event.payload as { phase?: TurnPhase; playerId?: PlayerId }
      if (data.phase === 'play' && data.playerId === ownerId) {
        replaceTemporarySkills(host.state, ownerId, GUANNING_LONGSONG, [])
        delete s75(host.state).longsongBorrowed?.[ownerId]
      }
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      askTargets(host, GUANNING_LONGSONG, ownerId, 'target', ownerId, resolution.data.candidates as PlayerId[], '【龙诵】：选择一名角色')
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const target = player(host.state, targetId)
      const owner = player(host.state, ownerId)
      if (!target?.alive || !owner) return
      const skills = skillsOf(host.state, targetId, skillIdsOf).filter((runtime) => runtime.activeActions
        && !skillsOf(host.state, ownerId, skillIdsOf).some((own) => own.id === runtime.id))
      if (!skills.length) return
      const canGive = owner.zones.hand.some((id) => host.state.cards[id]?.color === 'red')
      const redHandIds = target.zones.hand.filter((id) => host.state.cards[id]?.color === 'red')
      const options = [ ...(canGive ? [{ id: 'give', label: '交给其一张红色手牌' }] : []),
        ...(redHandIds.length ? [{ id: 'take', label: '获得其一张红色手牌' }] : []) ]
      if (!options.length) return
      askOption(host, GUANNING_LONGSONG, ownerId, 'exchange-mode', ownerId, '【龙诵】：选择红色手牌的交换方向', options,
        { targetId, skills: skills.map(({ id }) => id) })
      return
    }
    if (resolution.step === 'exchange-mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      const targetId = resolution.data.targetId as PlayerId
      if (mode === 'give') {
        const owner = player(host.state, ownerId)
        const red = owner?.zones.hand.filter((id) => host.state.cards[id]?.color === 'red') ?? []
        if (red.length) host.askSkill({ skillId: GUANNING_LONGSONG, ownerId, step: 'give-card', data: resolution.data, build: (id) => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【龙诵】：交给目标一张红色手牌', timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: red, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      } else if (mode === 'take') {
        const target = player(host.state, targetId)
        const redHandIds = target?.zones.hand.filter((cardId) => host.state.cards[cardId]?.color === 'red') ?? []
        if (redHandIds.length) host.askSkill({ skillId: GUANNING_LONGSONG, ownerId, step: 'take-card', data: resolution.data, build: (id) => ({
          id, kind: 'choose-cards', playerId: targetId, prompt: '【龙诵】：选择交给关宁的红色手牌', timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: redHandIds, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'give-card' || resolution.step === 'take-card') {
      const targetId = resolution.data.targetId as PlayerId
      const source = resolution.step === 'give-card' ? ownerId : targetId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected
      if (!cardId || !player(host.state, source)?.zones.hand.includes(cardId) || host.state.cards[cardId]?.color !== 'red') return
      const recipient = resolution.step === 'give-card' ? targetId : ownerId
      moveCard(host.state, cardId, { kind: 'hand', playerId: source }, { kind: 'hand', playerId: recipient })
      host.dispatch('CardGiven', { fromPlayerId: source, toPlayerId: recipient, cardIds: [cardId], reason: GUANNING_LONGSONG },
        { sourceId: source, targetId: recipient, cardIds: [cardId] })
      const skillIds = resolution.data.skills as string[]
      const options = skillIds.flatMap((skillId) => {
        const runtime = getSkillRuntime(skillId)
        const targetCharacter = player(host.state, targetId)?.characterId
        const skillName = targetCharacter ? getCharacter(targetCharacter)?.skills.find((skill) => skill.id === skillId)?.name : undefined
        return runtime?.activeActions ? [{ id: skillId, label: skillName ?? skillId }] : []
      })
      if (options.length) askOption(host, GUANNING_LONGSONG, ownerId, 'choose-skill', ownerId, '【龙诵】：选择获得的出牌阶段技能', options,
        { skillIds })
      return
    }
    if (resolution.step === 'choose-skill') {
      const skillId = (response.payload as { optionId?: string }).optionId
      const runtime = skillId ? getSkillRuntime(skillId) : undefined
      if (!skillId || !runtime?.activeActions) return
      s75(host.state).longsongBorrowed ??= {}
      s75(host.state).longsongBorrowed[ownerId] = { skillId, used: false }
      replaceTemporarySkills(host.state, ownerId, GUANNING_LONGSONG, [skillId])
    }
  },
})

registerSkillRuntime({ id: ZHANGCHU_JIZHONG,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, ZHANGCHU_JIZHONG)) return []
    return living(state).some((target) => target.id !== ownerId)
      ? [{ id: 'jizhong:activate', label: '【集众】令一名其他角色摸两张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'jizhong:activate' || usedThisPhase(host.state, ownerId, ZHANGCHU_JIZHONG)) return
    const candidates = living(host.state).filter((target) => target.id !== ownerId).map(({ id }) => id)
    if (!candidates.length) return
    markUsedThisPhase(host.state, ownerId, ZHANGCHU_JIZHONG)
    askTargets(host, ZHANGCHU_JIZHONG, ownerId, 'target', ownerId, candidates, '【集众】：选择一名角色，其摸两张牌')
  },
  resume(host, ownerId, resolution, response) {
  if (resolution.step === 'take-three') {
    const targetId = resolution.data.targetId as PlayerId
    const ids = (response.payload as { cardIds?: string[] }).cardIds ?? []
    for (const selected of ids) {
      const cardId = resolvePickedCard(host.state, targetId, selected)
      if (cardId) movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })
    }
    return
  }
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !player(host.state, targetId)?.alive) return
    markUsedThisPhase(host.state, ownerId, ZHANGCHU_JIZHONG)
    drawCards(host.state, host.rng, targetId, 2)
    askOption(host, ZHANGCHU_JIZHONG, ownerId, 'target-choice', targetId, '【集众】：获得“信众”标记，或让技能拥有者获得你区域内三张牌', [
      { id: 'faith', label: '获得1个“信众”标记' }, { id: 'give', label: '令技能拥有者获得你区域内三张牌' },
    ], { targetId }, false)
    return
  }
  if (resolution.step !== 'target-choice') return
  const targetId = resolution.data.targetId as PlayerId
  const choice = (response.payload as { optionId?: string }).optionId
  const target = player(host.state, targetId)
  if (!target) return
  if (choice === 'faith') {
    target.marks ??= {}
    target.marks['信众'] = (target.marks['信众'] ?? 0) + 1
    return
  }
  if (choice === 'give') askPickable(host, ZHANGCHU_JIZHONG, ownerId, 'take-three', ownerId, targetId, '【集众】：选择获得的三张牌', {}, 3, 3)
} })

registerSkillRuntime({ id: ZHANGCHU_RIHUI, triggers: [
{ event: 'AfterCardUse', handle(host, ownerId, context) {
  const data = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
  if (context.event.sourceId !== ownerId || !data.cardId || !data.cardName || data.targetIds?.length !== 1
    || usedThisTurn(host.state, ownerId, ZHANGCHU_RIHUI)) return
  const card = host.state.cards[data.cardId]
  if (!card || !blackTrickOrBasic(host.state, ownerId, data.cardId) || (card.category === 'trick' && DELAYED_TRICK_NAMES.has(data.cardName))) return
  const targetId = data.targetIds[0]!
  if ((player(host.state, targetId)?.marks?.['信众'] ?? 0) > 0) {
    askOption(host, ZHANGCHU_RIHUI, ownerId, 'take-offer', ownerId, '【日彗】：是否获得其区域内一张牌？',
      [{ id: 'yes', label: '获得一张牌' }], { targetId })
    return
  }
  const believers = living(host.state).filter((candidate) => candidate.id !== ownerId && (candidate.marks?.['信众'] ?? 0) > 0)
  if (believers.length) askOption(host, ZHANGCHU_RIHUI, ownerId, 'echo-offer', ownerId, '【日彗】：是否令所有“信众”角色依次对其使用此牌？',
    [{ id: 'yes', label: '令“信众”角色依次使用此牌' }], { targetId, cardId: data.cardId, cardName: data.cardName,
      believers: believers.map(({ id }) => id), category: card.category })
} },
{ event: 'CardResolved', handle(host, ownerId, context) {
  if (context.event.sourceSkillId === ZHANGCHU_RIHUI) startZhangChuEcho(host, ownerId)
} },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'take-offer') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    markUsedThisTurn(host.state, ownerId, ZHANGCHU_RIHUI)
    askPickable(host, ZHANGCHU_RIHUI, ownerId, 'take-card', ownerId, targetId, '【日彗】：选择获得的牌', {}, 1, 1, true)
    return
  }
  if (resolution.step === 'echo-offer') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    markUsedThisTurn(host.state, ownerId, ZHANGCHU_RIHUI)
    const targetId = resolution.data.targetId as PlayerId
    const cardName = resolution.data.cardName as string
    const believers = resolution.data.believers as PlayerId[]
    s75(host.state).rihuiQueue ??= {}
    s75(host.state).rihuiQueue[ownerId] = believers.map((sourceId) => ({ sourceId, targetId, cardName, category: resolution.data.category as string }))
    startZhangChuEcho(host, ownerId)
    return
  }
  if (resolution.step === 'take-card') {
    const targetId = resolution.data.targetId as PlayerId
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected && resolvePickedCard(host.state, targetId, selected)
    if (cardId) movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })
  }
} })

registerSkillRuntime({ id: HANLONG_DUWANG,
  onGameStart(host, ownerId) {
    const draw = host.state.zones.drawPile
    const picks = draw.filter((id) => host.state.cards[id]?.name !== '杀').slice(0, 5)
    for (const id of picks) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: '刺' })
    host.dispatch('CharacterPileMoved', { playerId: ownerId, pile: '刺', cardIds: picks, reason: HANLONG_DUWANG }, { sourceId: ownerId })
  },
  distanceModifier: { toOthers(state, ownerId) {
    const spikes = player(state, ownerId)?.characterPiles?.['刺']?.length ?? 0
    return spikes > 0 ? 1 : 0
  }, fromOthers(state, ownerId) {
    return (player(state, ownerId)?.characterPiles?.['刺']?.length ?? 0) > 0 ? 1 : 0
  } },
})

registerSkillRuntime({ id: HANLONG_CIBEI,
  unlimitedSlashFor(state, ownerId, cardId) { return !!cardId && s75(state).cibeiSlashes?.[ownerId]?.includes(cardId) === true },
  slashIgnoresDistance(state, ownerId, cardId) { return !!cardId && s75(state).cibeiSlashes?.[ownerId]?.includes(cardId) === true },
  handLimitExempt(state, ownerId, cardId) { return s75(state).cibeiSlashes?.[ownerId]?.includes(cardId) === true },
  protectsCardFromDiscard(state, ownerId, cardId) { return s75(state).cibeiSlashes?.[ownerId]?.includes(cardId) === true },
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId }
      const cardId = data.cardId
      if (!cardId || host.state.cards[cardId]?.name !== '杀' || !host.state.zones.discardPile.includes(cardId)
        || cardDamageDealt(host.state, cardId) <= 0) return
      const spikes = player(host.state, ownerId)?.characterPiles?.['刺'] ?? []
      const replaceable = spikes.filter((id) => host.state.cards[id]?.name !== '杀')
      if (!replaceable.length) return
      askOption(host, HANLONG_CIBEI, ownerId, 'offer-swap', ownerId, '【刺北】：是否将刚进入弃牌堆的【杀】与一张非【杀】“刺”交换？',
        [{ id: 'yes', label: '交换并弃置一名角色区域内一张牌' }], { cardId, replaceable })
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      const pile = player(host.state, ownerId)?.characterPiles?.['刺'] ?? []
      if (!pile.length || !pile.every((id) => host.state.cards[id]?.name === '杀')) return
      s75(host.state).cibeiSlashes ??= {}
      const acquired = [...pile]
      s75(host.state).cibeiSlashes[ownerId] = [...new Set([...(s75(host.state).cibeiSlashes[ownerId] ?? []), ...acquired])]
      for (const cardId of acquired) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: '刺' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: acquired, reason: HANLONG_CIBEI }, { sourceId: ownerId, cardIds: acquired })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer-swap') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const ids = (resolution.data.replaceable as CardId[]).filter((id) => (player(host.state, ownerId)?.characterPiles?.['刺'] ?? []).includes(id))
      host.askSkill({ skillId: HANLONG_CIBEI, ownerId, step: 'select-spike', data: { cardId: resolution.data.cardId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【刺北】：选择与此【杀】交换的“刺”', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'select-spike') {
      const spikeId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const slashId = resolution.data.cardId as CardId
      if (!spikeId || !host.state.zones.discardPile.includes(slashId)
        || !(player(host.state, ownerId)?.characterPiles?.['刺'] ?? []).includes(spikeId)) return
      moveCard(host.state, slashId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: '刺' })
      moveCard(host.state, spikeId, { kind: 'characterPile', playerId: ownerId, pile: '刺' }, { kind: 'discardPile' })
      const targets = living(host.state).filter((target) => pickableCardsOf(host.state, target.id, { discarderId: ownerId }).cardIds.length
        + pickableCardsOf(host.state, target.id, { discarderId: ownerId }).hiddenCardSlots.length > 0).map(({ id }) => id)
      if (targets.length) askTargets(host, HANLONG_CIBEI, ownerId, 'discard-target', ownerId, targets, '【刺北】：选择弃置一张牌的角色')
      return
    }
    if (resolution.step === 'discard-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive) askPickable(host, HANLONG_CIBEI, ownerId, 'discard-card', ownerId, targetId, '【刺北】：选择弃置的牌', {}, 1, 1, true)
      return
    }
    if (resolution.step === 'discard-card') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected && resolvePickedCard(host.state, targetId, selected)
      if (cardId) movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
    }
  },
})

registerSkillRuntime({ id: ZHANGCHU_GUANGSHI, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  if ((context.event.payload as { phase?: TurnPhase }).phase !== 'prepare') return
  const others = living(host.state).filter((candidate) => candidate.id !== ownerId)
  if (!others.every((candidate) => (candidate.marks?.['信众'] ?? 0) > 0)) return
  const count = living(host.state).reduce((total, candidate) => total + (candidate.marks?.['信众'] ?? 0), 0)
  drawCards(host.state, host.rng, ownerId, count)
  loseHp(host as never, ownerId, 1, ZHANGCHU_GUANGSHI)
} }], })

registerSkillRuntime({ id: GONGSUNDU_ZHENZE, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  if ((context.event.payload as { phase?: TurnPhase }).phase !== 'discard') return
  askOption(host, GONGSUNDU_ZHENZE, ownerId, 'mode', ownerId, '【震泽】：选择一项', [
    { id: 'damage', label: '令手牌数与体力值大小关系不同于你的角色失去1点体力' },
    { id: 'recover', label: '令手牌数与体力值大小关系与你相同的角色回复1点体力' },
  ])
} }], resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'mode') return
  const mode = (response.payload as { optionId?: string }).optionId
  if (mode !== 'damage' && mode !== 'recover') return
  const relation = (id: PlayerId) => Math.sign((player(host.state, id)?.zones.hand.length ?? 0) - (player(host.state, id)?.hp ?? 0))
  const own = relation(ownerId)
  for (const target of living(host.state)) {
    if ((relation(target.id) === own) !== (mode === 'recover')) continue
    if (mode === 'damage') loseHp(host as never, target.id, 1, GONGSUNDU_ZHENZE)
    else recover(host as never, target.id, 1, ownerId)
  }
} })

registerSkillRuntime({ id: GONGSUNDU_ANLIAO,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    if ((context.event.payload as { phase?: TurnPhase }).phase === 'play' && host.state.currentPlayerId === ownerId)
      delete s75(host.state).anliaoUsed?.[ownerId]
  } }],
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play') return []
    const limit = living(state).filter((candidate) => candidate.characterId && getCharacter(candidate.characterId)?.kingdom === 'qun').length
    const used = s75(state).anliaoUsed?.[ownerId] ?? 0
    if (used >= limit) return []
    return [{ id: 'anliao:recast', label: `【安辽】重铸一张牌（${used}/${limit}）` }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'anliao:recast') return
    const limit = living(host.state).filter((candidate) => candidate.characterId && getCharacter(candidate.characterId)?.kingdom === 'qun').length
    const used = s75(host.state).anliaoUsed?.[ownerId] ?? 0
    if (used >= limit) return
  const targets = living(host.state).filter((candidate) => pickableCardsOf(host.state, candidate.id, { discarderId: ownerId, includeJudgingArea: true }).cardIds.length
    + pickableCardsOf(host.state, candidate.id, { discarderId: ownerId, includeJudgingArea: true }).hiddenCardSlots.length > 0).map(({ id }) => id)
    if (targets.length) askTargets(host, GONGSUNDU_ANLIAO, ownerId, 'target', ownerId, targets, '【安辽】：选择一名角色重铸其一张牌', { limit, used })
  },
  resume(host, ownerId, resolution, response) {
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !player(host.state, targetId)?.alive) return
    askPickable(host, GONGSUNDU_ANLIAO, ownerId, 'recast', ownerId, targetId, '【安辽】：选择重铸的牌', { limit: resolution.data.limit, used: resolution.data.used }, 1, 1, true)
    return
  }
  if (resolution.step !== 'recast') return
  const targetId = resolution.data.targetId as PlayerId
  const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
  const cardId = selected && resolvePickedCard(host.state, targetId, selected)
  if (!cardId || !movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) return
  drawCards(host.state, host.rng, targetId, 1)
  s75(host.state).anliaoUsed ??= {}
  s75(host.state).anliaoUsed[ownerId] = Number(resolution.data.used ?? 0) + 1
} })

registerSkillRuntime({ id: YUANSHI_NEIFA,
  locksOwnCategories(state, ownerId) {
    const mode = s75(state).neifa?.[ownerId]?.mode
    return mode === 'basic' ? ['trick'] : mode === 'trick' ? ['basic'] : []
  },
  globalSlashUses(state, ownerId, targetId) {
    const record = s75(state).neifa?.[ownerId]
    return targetId === ownerId && record?.mode === 'basic' ? Number(record.slashBonus ?? 0) : 0
  },
  extraSlashTargets(state, ownerId) { return s75(state).neifa?.[ownerId]?.mode === 'basic' ? 1 : 0 },
  modifiesTrickTargetCount(state, ownerId) { return s75(state).neifa?.[ownerId]?.mode === 'trick' },
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const data = context.event.payload as { phase?: TurnPhase; playerId?: PlayerId }
      if (data.phase === 'play' && data.playerId === ownerId) delete s75(host.state).neifa?.[ownerId]
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      if ((context.event.payload as { phase?: TurnPhase }).phase !== 'play') return
      askOption(host, YUANSHI_NEIFA, ownerId, 'offer', ownerId, '【内伐】：是否摸三张牌并弃置一张牌？',
        [{ id: 'yes', label: '摸三张牌并弃置一张牌' }])
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      drawCards(host.state, host.rng, ownerId, 3)
      const hand = player(host.state, ownerId)?.zones.hand ?? []
      if (!hand.length) return
      host.askSkill({ skillId: YUANSHI_NEIFA, ownerId, step: 'discard', build: (id) => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【内伐】：弃置一张牌并决定此阶段的限制', timeoutMs: 25_000, optional: false, purpose: 'skill',
        cardIds: [...hand], hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step !== 'discard') return
    const owner = player(host.state, ownerId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const card = cardId ? host.state.cards[cardId] : undefined
    if (!owner || !cardId || !card || !owner.zones.hand.includes(cardId) || (card.category !== 'basic' && card.category !== 'trick')) return
    discardCardsByIds(host as never, ownerId, [cardId], YUANSHI_NEIFA)
    if (card.category === 'basic') {
      const noTrickCount = Math.min(5, owner.zones.hand.filter((id) => host.state.cards[id]?.category === 'trick').length)
      s75(host.state).neifa ??= {}
      s75(host.state).neifa[ownerId] = { mode: 'basic', slashBonus: noTrickCount }
    } else {
      s75(host.state).neifa ??= {}
      s75(host.state).neifa[ownerId] = { mode: 'trick' }
    }
  },
})

registerSkillRuntime({ id: ZHANGJINYUN_HUIZHI, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  if ((context.event.payload as { phase?: TurnPhase }).phase !== 'prepare') return
  askOption(host, ZHANGJINYUN_HUIZHI, ownerId, 'offer', ownerId, '【蕙质】：是否弃置任意张手牌并摸牌？',
    [{ id: 'yes', label: '弃置手牌并摸至全场最多手牌数' }])
} }], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'offer') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const hand = player(host.state, ownerId)?.zones.hand ?? []
    host.askSkill({ skillId: ZHANGJINYUN_HUIZHI, ownerId, step: 'discard', build: (id) => ({ id, kind: 'choose-cards', playerId: ownerId,
      prompt: '【蕙质】：弃置任意张手牌', timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...hand],
      hiddenCardSlots: [], min: 0, max: hand.length }) })
    return
  }
  if (resolution.step !== 'discard') return
  const owner = player(host.state, ownerId)
  if (!owner) return
  const ids = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
  if (ids.length) discardCardsByIds(host as never, ownerId, ids, ZHANGJINYUN_HUIZHI)
  const maxHand = Math.max(...living(host.state).map((target) => target.zones.hand.length))
  drawCards(host.state, host.rng, ownerId, Math.min(5, Math.max(1, maxHand - owner.zones.hand.length)))
} })

registerSkillRuntime({ id: ZHANGJINYUN_JIJIAO, limited: true,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner || !owner.alive || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || owner.usedLimitedSkills.includes(ZHANGJINYUN_JIJIAO)) return []
    const cards = (s75(state).jijiaoCards?.[ownerId] ?? []) as CardId[]
    return cards.some((id) => state.zones.discardPile.includes(id))
      ? [{ id: 'jijiao:receive', label: '【继椒】令一名角色获得你使用和弃置的普通锦囊牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'jijiao:receive') return
    askTargets(host, ZHANGJINYUN_JIJIAO, ownerId, 'recipient', ownerId, living(host.state).map(({ id }) => id), '【继椒】：选择一名角色')
  },
  triggers: [
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const data = context.event.payload as { cardId?: CardId; cardName?: string }
      const card = data.cardId ? host.state.cards[data.cardId] : undefined
      if (!card || card.category !== 'trick' || DELAYED_TRICK_NAMES.has(data.cardName ?? card.name)) return
      s75(host.state).jijiaoCards ??= {}
      s75(host.state).jijiaoCards[ownerId] ??= []
      if (data.cardId) s75(host.state).jijiaoCards[ownerId].push(data.cardId)
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId; reason?: string }
      const card = data.cardId ? host.state.cards[data.cardId] : undefined
      if (data.fromPlayerId !== ownerId || data.reason !== 'discard' || card?.category !== 'trick' || DELAYED_TRICK_NAMES.has(card.name)) return
      s75(host.state).jijiaoCards ??= {}
      s75(host.state).jijiaoCards[ownerId] ??= []
      if (data.cardId) s75(host.state).jijiaoCards[ownerId].push(data.cardId)
    } },
    { event: 'DeckReshuffled', handle(host, ownerId) { s75(host.state).jijiaoReset ??= {}; s75(host.state).jijiaoReset[ownerId] = true } },
    { event: 'Death', handle(host, ownerId) { s75(host.state).jijiaoReset ??= {}; s75(host.state).jijiaoReset[ownerId] = true } },
    { event: 'TurnEnd', handle(host, ownerId) {
      if (!s75(host.state).jijiaoReset?.[ownerId]) return
      const owner = player(host.state, ownerId)
      if (owner) owner.usedLimitedSkills = owner.usedLimitedSkills.filter((id) => id !== ZHANGJINYUN_JIJIAO)
      delete s75(host.state).jijiaoReset?.[ownerId]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'recipient') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId) return
    const target = player(host.state, targetId)
    const owner = player(host.state, ownerId)
    if (!target?.alive || !owner || owner.usedLimitedSkills.includes(ZHANGJINYUN_JIJIAO)) return
    owner.usedLimitedSkills.push(ZHANGJINYUN_JIJIAO)
    const cards = [...new Set((s75(host.state).jijiaoCards?.[ownerId] ?? []) as CardId[])]
      .filter((id) => host.state.zones.discardPile.includes(id) && host.state.cards[id]?.category === 'trick'
        && !DELAYED_TRICK_NAMES.has(host.state.cards[id]!.name))
    for (const cardId of cards) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
    if (cards.length) host.dispatch('GainCard', { playerId: targetId, cardIds: cards, reason: ZHANGJINYUN_JIJIAO },
      { sourceId: ownerId, targetId, cardIds: cards })
  },
})

registerSkillRuntime({ id: DUANQIAOXIAO_HUAYI, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    if ((context.event.payload as { phase?: TurnPhase }).phase !== 'finish') return
    askOption(host, DUANQIAOXIAO_HUAYI, ownerId, 'offer', ownerId, '【华衣】：是否进行一次判定？', [{ id: 'yes', label: '进行判定' }])
  } },
  { event: 'TurnStart', handle(host, ownerId, context) {
    if (context.event.sourceId === ownerId) delete s75(host.state).huayi?.[ownerId]
  } },
  { event: 'TurnEnd', handle(host, ownerId) {
    if (s75(host.state).huayi?.[ownerId]?.color === 'red') drawCards(host.state, host.rng, ownerId, 1)
  } },
  { event: 'DamageSettled', handle(host, ownerId, context) {
    const record = s75(host.state).huayi?.[ownerId]
    if (record?.color !== 'black' || context.event.targetId !== ownerId
      || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
    drawCards(host.state, host.rng, ownerId, 2)
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'offer' && (response.payload as { optionId?: string }).optionId === 'yes')
    performJudgment(host as JudgmentEngineHost, ownerId, DUANQIAOXIAO_HUAYI, { tag: DUANQIAOXIAO_HUAYI_JUDGMENT, data: { ownerId } })
} })

registerSkillRuntime({ id: TIANSHANGYI_XIAOREN,
  limited: false,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const data = context.event.payload as { targetId?: PlayerId; finalAmount?: number }
      if (context.event.sourceId !== ownerId || !data.targetId || Number(data.finalAmount ?? 0) <= 0
        || usedThisTurn(host.state, ownerId, TIANSHANGYI_XIAOREN)) return
      askOption(host, TIANSHANGYI_XIAOREN, ownerId, 'offer', ownerId, '【绡刃】：是否判定并按结果结算？', [{ id: 'yes', label: '进行判定' }],
        { injuredTargetId: data.targetId })
    } },
    { event: 'EnterDying', handle(host, ownerId) {
      if (s75(host.state).xiaorenChain?.[ownerId]) s75(host.state).xiaorenChain[ownerId].stopped = true
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const injuredTargetId = resolution.data.injuredTargetId as PlayerId
      if (!player(host.state, injuredTargetId)?.alive || usedThisTurn(host.state, ownerId, TIANSHANGYI_XIAOREN)) return
      markUsedThisTurn(host.state, ownerId, TIANSHANGYI_XIAOREN)
      s75(host.state).xiaorenChain ??= {}
      s75(host.state).xiaorenChain[ownerId] = { stopped: false }
      performJudgment(host as JudgmentEngineHost, ownerId, TIANSHANGYI_XIAOREN,
        { tag: TIANSHANGYI_XIAOREN_JUDGMENT, data: { ownerId, injuredTargetId, chain: 0 } })
      return
    }
    if (resolution.step === 'red-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const target = player(host.state, targetId)
      if (target?.alive) {
        recover(host as never, targetId, 1, ownerId)
        if (target.hp === target.maxHp) drawCards(host.state, host.rng, targetId, 1)
      }
      delete s75(host.state).xiaorenChain?.[ownerId]
      return
    }
    if (resolution.step === 'black-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !player(host.state, targetId)?.alive) return
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, sourceSkillId: TIANSHANGYI_XIAOREN })
      if (s75(host.state).xiaorenChain?.[ownerId]?.stopped || host.state.dying) {
        delete s75(host.state).xiaorenChain?.[ownerId]
        return
      }
      askOption(host, TIANSHANGYI_XIAOREN, ownerId, 'again', ownerId, '【绡刃】：是否再次判定？', [{ id: 'yes', label: '再次判定' }],
        { injuredTargetId: resolution.data.injuredTargetId, chain: Number(resolution.data.chain ?? 0) + 1 })
      return
    }
    if (resolution.step === 'again') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes'
        || s75(host.state).xiaorenChain?.[ownerId]?.stopped || host.state.dying) {
        delete s75(host.state).xiaorenChain?.[ownerId]
        return
      }
      performJudgment(host as JudgmentEngineHost, ownerId, TIANSHANGYI_XIAOREN,
        { tag: TIANSHANGYI_XIAOREN_JUDGMENT, data: { ownerId, injuredTargetId: resolution.data.injuredTargetId, chain: resolution.data.chain } })
    }
  },
})

registerSkillRuntime({ id: TIANSHANGYI_POSUO,
  viewAs(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || s75(state).posuoDamaged?.[ownerId] === true) return []
    const owner = player(state, ownerId)
    if (!owner) return []
    const usedSuits = (s75(state).posuoSuits?.[ownerId] ?? []) as string[]
    return owner.zones.hand.flatMap((cardId) => {
      const suit = effectiveCardSuit(state, ownerId, cardId)
      if (usedSuits.includes(suit)) return []
      const damageNames = [...new Set(Object.values(state.cards)
        .filter((card) => card.suit === suit && (card.name === '杀' || DAMAGE_TRICKS.has(card.name)))
        .map((card) => card.name))]
      return damageNames.map((asCardName) => ({ cardId, asCardName, label: `【婆娑】：${asCardName}（${suit}）` }))
    })
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      if ((context.event.payload as { phase?: TurnPhase }).phase !== 'play') return
      s75(host.state).posuoSuits ??= {}
      s75(host.state).posuoSuits[ownerId] = []
      s75(host.state).posuoDamaged ??= {}
      s75(host.state).posuoDamaged[ownerId] = false
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const data = context.event.payload as { targetId?: PlayerId; finalAmount?: number }
      if (context.event.sourceId === ownerId && data.targetId !== ownerId && Number(data.finalAmount ?? 0) > 0)
        (s75(host.state).posuoDamaged ??= {})[ownerId] = true
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== TIANSHANGYI_POSUO) return
      const { cardId } = context.event.payload as { cardId?: CardId }
      if (!cardId) return
      s75(host.state).posuoSuits ??= {}
      s75(host.state).posuoSuits[ownerId] ??= []
      const suit = effectiveCardSuit(host.state, ownerId, cardId)
      if (!s75(host.state).posuoSuits[ownerId].includes(suit)) s75(host.state).posuoSuits[ownerId].push(suit)
    } },
  ],
})

registerSkillRuntime({ id: DUANQIAOXIAO_CAIZHUANG,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, DUANQIAOXIAO_CAIZHUANG)) return []
    return [{ id: 'caizhuang:discard-draw', label: '【彩妆】弃置牌并摸至花色数' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'caizhuang:discard-draw') return
    const owner = player(host.state, ownerId)
    if (!owner) return
    const available = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    host.askSkill({ skillId: DUANQIAOXIAO_CAIZHUANG, ownerId, step: 'discard', data: {}, build: (id) => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【彩妆】：弃置任意张手牌或装备牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: available, hiddenCardSlots: [], min: 0, max: available.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = player(host.state, ownerId)
    if (!owner) return
    const available = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    const ids = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => available.includes(id))
    const suitCount = new Set(ids.map((id) => effectiveCardSuit(host.state, ownerId, id))).size
    markUsedThisPhase(host.state, ownerId, DUANQIAOXIAO_CAIZHUANG)
    if (ids.length) discardCardsByIds(host as never, ownerId, ids, DUANQIAOXIAO_CAIZHUANG)
    const handSuits = () => new Set((player(host.state, ownerId)?.zones.hand ?? [])
      .map((id) => effectiveCardSuit(host.state, ownerId, id))).size
    let guard = host.state.zones.drawPile.length + host.state.zones.discardPile.length + 1
    while (handSuits() < suitCount && guard-- > 0) {
      if (!drawCards(host.state, host.rng, ownerId, 1).length) break
    }
  },
})

export const HISTORICAL_BATCH75_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'bianxi-b75', name: '卞喜', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: BIANXI_DUNXI, name: '钝袭', description: '当你使用伤害牌时，你可令其中一个目标获得1个“钝”标记。有“钝”标记的角色使用基本牌或锦囊牌指定单一目标后，移去一个“钝”，然后目标改为随机一名角色。若随机的目标与原本目标相同，则失去1点体力并结束自己的出牌阶段。' },
  ] },
  { id: 'guanning-b75', name: '关宁', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: GUANNING_XIUWEN, name: '修文', description: '每种牌名限一次，你使用一张牌时可以摸一张牌。' },
    { id: GUANNING_LONGSONG, name: '龙诵', description: '出牌阶段开始时，你可以交给或获得一名其他角色一张红色牌，然后你此阶段获得一个“出牌阶段”的技能（优先获得该角色的技能，只能发动一次）。' },
  ] },
  { id: 'hanlong-b75', name: '韩龙', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: HANLONG_DUWANG, name: '独往', description: '锁定技，游戏开始时，你将牌堆顶五张不为【杀】的牌置于武将牌上，称为“刺”。若你有“刺”，你和其他角色互相计算距离时均+1。', locked: true },
    { id: HANLONG_CIBEI, name: '刺北', description: '当任意角色使用的【杀】造成伤害并进入弃牌堆时，你可以将此牌与一张不为【杀】的“刺”交换，然后弃置一名角色区域内的一张牌；每个回合结束，若“刺”均为【杀】，你获得所有“刺”，以此法获得的【杀】不能被弃置（不计手牌上限）且无次数和距离限制。' },
  ] },
  { id: 'zhangchu-b75', name: '张楚', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANGCHU_JIZHONG, name: '集众', description: '出牌阶段限一次，你可以令一名其他角色摸两张牌，然后其选择一项：1.获得“信众”标记；2.你获得其三张牌。' },
    { id: ZHANGCHU_RIHUI, name: '日彗', description: '每回合限一次，当你指定其他角色为唯一目标的黑色基本牌或普通锦囊牌结算完毕后，若其没有“信众”标记，你可令所有有“信众”标记的角色均视为对其使用此牌；若其有“信众”标记，你可以获得其区域内的一张牌。' },
    { id: ZHANGCHU_GUANGSHI, name: '光噬', description: '锁定技，准备阶段，若所有其他角色均有“信众”标记，你摸X张牌（X为全场“信众”数），然后失去1点体力。', locked: true },
  ] },
  { id: 'gongsundu-b75', name: '公孙度', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: GONGSUNDU_ZHENZE, name: '震泽', description: '弃牌阶段开始时，你可以选择一项：1.令所有手牌数和体力值的大小关系与你不同的角色失去一点体力；2.令所有手牌数和体力值的大小关系与你相同的角色回复一点体力。' },
    { id: GONGSUNDU_ANLIAO, name: '安辽', description: '出牌阶段限X次，你可以重铸一名角色的一张牌（X为群雄势力角色数）。' },
  ] },
  { id: 'yuantanshangxi-b75', name: '袁谭袁尚袁熙', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: YUANSHI_NEIFA, name: '内伐', description: '出牌阶段开始时，你可以摸三张牌，然后弃置一张牌。若弃置的牌是基本牌，此阶段你不能使用锦囊牌且【杀】的使用次数+X且目标+1；若弃置的牌是锦囊牌，此阶段你不能使用基本牌，使用的普通锦囊牌的目标可+1或-1。（X为发动技能后手牌中不能使用的牌数且最多为5）' },
  ] },
  { id: 'dongguiren-b75', name: '董贵人', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: DONGGUIREN_LIANZHI, name: '连枝', description: '游戏开始时，你选择一名其他角色。当你进入濒死状态时，若该角色没有死亡，你回复1点体力且你与其各摸一张牌（每回合限一次）；该角色死亡后，你可以选择一名其他角色，你与其获得“受责”，且其获得与你等量的“绞”标记（至少获得1个）。' },
    { id: DONGGUIREN_LINGFANG, name: '凌芳', description: '锁定技，准备阶段，或当其他角色对你使用或你对其他角色使用的黑色牌结算完毕后，你获得一个“绞”标记。', locked: true },
    { id: DONGGUIREN_FENGYING, name: '风影', description: '每个回合开始时，记录此时弃牌堆中的黑色基本牌和黑色普通锦囊牌牌名。你手牌中点数小于等于“绞”标记数量的一张牌可以当做你记录的牌使用，且此牌没有距离和次数限制。每回合每种牌名限一次。' },
  ] },
  { id: 'zhangjinyun-b75', name: '张瑾云', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANGJINYUN_HUIZHI, name: '蕙质', description: '准备阶段，你可以弃置任意张手牌，然后将手牌摸至与全场手牌数最多的角色相同。（最少摸1张，最多摸5张）' },
    { id: ZHANGJINYUN_JIJIAO, name: '继椒', description: '限定技，出牌阶段，你可令一名角色获得弃牌堆中本局游戏你使用和弃置的所有普通锦囊牌（这些牌不会被【无懈可击】响应）。每个回合结束后，若本回合牌堆洗过牌或有角色死亡，此限定技视为未发动过。' },
  ] },
  { id: 'duanqiaoxiao-b75', name: '段巧笑', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: DUANQIAOXIAO_CAIZHUANG, name: '彩妆', description: '出牌阶段限一次，你可以弃置任意张牌，然后你连续摸牌摸直到手牌中至少拥有与弃牌花色数相同的花色数。' },
    { id: DUANQIAOXIAO_HUAYI, name: '华衣', description: '结束阶段，你可以进行一次判定，根据判定结果获得对应效果直到你的回合开始：红色，每个回合结束时摸一张牌；黑色，受到伤害后摸两张牌。' },
  ] },
  { id: 'tianshangyi-b75', name: '田尚衣', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: TIANSHANGYI_POSUO, name: '婆娑', description: '出牌阶段每种花色限一次，若你本阶段还没有对其他角色造成伤害，你可以将一张手牌当此花色有的一张伤害牌使用。' },
    { id: TIANSHANGYI_XIAOREN, name: '绡刃', description: '每回合限一次，当你造成伤害后，你可以进行一次判定，若结果为红色，你可令一名角色回复1点体力，然后若其满体力，其摸一张牌；若结果为黑色，对受伤角色的上家或下家造成1点伤害，然后你可以再次进行判定并执行对应结果直到有角色进入濒死状态。' },
  ] },
]
