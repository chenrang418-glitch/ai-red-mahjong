import type { CharacterDefinition } from './types'
import { getCharacter, skillIdsOf } from './standard'
import type { CardCategory, CardId, PlayerId, SanguoshaState, Suit, TurnPhase } from '../../engine/types'
import { isCardProtectedFromDiscard, isTargetProhibited, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseNumberRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest, DistributeCardsRequest } from '../../engine/requests'
import type { LegalAction } from '../../engine/actions'
import { drawCards } from '../../engine/draw'
import { resolveDamageSequence, resumeDamageModifier } from '../../engine/damage'
import { discardCardsByIds } from '../../engine/discard-all'
import { effectiveCardName, effectiveDamageNature, locateOwnedCard, moveCard } from '../../engine/zones'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { giveCards, giveOwnedCards, swapSelectedHandCards } from '../../engine/hand-transfer'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { canTarget, getAttackRange, getDistance } from '../../engine/distance'
import { effectiveCardColor } from '../../engine/skills/runtime'
import { ruleCardNumber } from '../../engine/deck'
import { skillDiscardCardUseActions } from '../../engine/cards/basic'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { DAMAGE_TRICKS, DELAYED_TRICKS, instantTrickActions } from '../../engine/cards/tricks'
import { damageCardCategory } from '../../engine/damage-provenance'
import { canUseSlash } from '../../engine/slash-rules'
import { formationFlanks } from '../../engine/formation'
import { getEngineCallbacks } from '../../engine/equipment-requests'

const B = '-b86'
const sid = (name: string) => `${name}${B}`
const LIUYI_DULU = sid('dulu-liuyijun')
const LIUYI_FUJI = sid('fuji-liuyijun')
const WUYI_SHIBIAN = sid('shibian-wuyi')
const WUYI_BIBU = sid('bibu-wuyi')
const ZHANGSONG_XISONG = sid('xisong-zhangsong')
const ZHANGSONG_FANGLANG = sid('fanglang-zhangsong')
const ZHANGREN_SHEDAO = sid('shedao-zhangren')
const ZHANGREN_XUNSHI = sid('xunshi-zhangren')
const ZHANGREN_ZHENGONG = sid('zhengong-zhangren')
const HOU_ZHAONING_WANGZI = sid('wangzi-houzhaoning')
const HOU_ZHAONING_HERONG = sid('herong-houzhaoning')
const GONGSUN_JUXI = sid('juxi-gongsunzan')
const GONGSUN_ZHUTAO = sid('zhutao-gongsunzan')
const WEIFENG_HUOZHONG = sid('huozhong-weifeng')
const WEIFENG_ZHUGUO = sid('zhuguo-weifeng')
const LIUZHANG_JUTU = sid('jutu-liuzhang')
const LIUZHANG_RENSHAN = sid('renshan-liuzhang')
const LIUZHANG_YIZHI = sid('yizhi-liuzhang')
const ZHANGFEI_ZISHENG = sid('zisheng-zhangfei')
const ZHANGFEI_XIANLUE = sid('xianlue-zhangfei')
const ZHANGFEI_HAOXIAN = sid('haoxian-zhangfei')
const WANGPING_YUYI = sid('yuyi-wangping')
const WANGPING_FANGONG = sid('fangong-wangping')

type B86State = Record<string, any>
function b86(state: SanguoshaState): B86State {
  const root = state as unknown as B86State
  return (root.paperSanguoB86 ??= {}) as B86State
}
const alive = (state: SanguoshaState) => state.players.filter((player) => player.alive)
const player = (state: SanguoshaState, id: PlayerId) => state.players.find((entry) => entry.id === id)
const hand = (state: SanguoshaState, id: PlayerId) => player(state, id)?.zones.hand ?? []
const card = (state: SanguoshaState, id: CardId) => state.cards[id]
const dispatch = (host: SkillHost, name: string, payload: Record<string, unknown>, sourceId?: PlayerId, targetId?: PlayerId, cardIds?: CardId[]) =>
  host.dispatch(name as never, payload, { sourceId, targetId, cardIds })

function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, data: Record<string, unknown>, prompt: string,
  options: Array<{ id: string; label: string }>, optional = true): void {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional, options,
  }) })
}

type ShiBianRecord = { roundNumber: number; targetId: PlayerId }
function shiBianRecord(state: SanguoshaState, ownerId: PlayerId): ShiBianRecord | undefined {
  const record = b86(state).shibian?.[ownerId] as ShiBianRecord | undefined
  return record?.roundNumber === state.roundNumber ? record : undefined
}

registerSkillRuntime({
  id: WUYI_SHIBIAN,
  ignoresDistanceTo(state, ownerId, targetId) {
    const record = shiBianRecord(state, ownerId)
    const marked = record ? player(state, record.targetId) : undefined
    const target = player(state, targetId)
    return Boolean(marked?.alive && target?.alive && target.id !== marked.id && target.id !== ownerId
      && getDistance(state, marked.id, target.id) <= getAttackRange(state, marked.id))
  },
  nextCardTargetExpansion(state, ownerId, cardId, cardName) {
    const record = shiBianRecord(state, ownerId)
    const marked = record ? player(state, record.targetId) : undefined
    if (!marked?.alive || !player(state, ownerId)?.alive) return null
    const physical = card(state, cardId)
    const isSlash = cardName === '杀' || cardName === '火杀' || cardName === '雷杀'
    const isOrdinaryTrick = physical?.category === 'trick' && !DELAYED_TRICKS.has(cardName)
    if (!isSlash && !isOrdinaryTrick) return null
    const candidateIds = alive(state).filter((candidate) => candidate.id !== ownerId && candidate.id !== marked.id
      && getDistance(state, marked.id, candidate.id) <= getAttackRange(state, marked.id)).map(({ id }) => id)
    return candidateIds.length ? { maxAdditionalTargets: 1, candidateIds } : null
  },
  triggers: [{ event: 'RoundStart', handle(host, ownerId, context) {
    const roundNumber = Number((context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber)
    if (!player(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: WUYI_SHIBIAN, ownerId, step: 'choose-marked', data: { roundNumber } })
  } }],
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'choose-marked' || Number(queued.data.roundNumber) !== host.state.roundNumber) return
    const candidates = alive(host.state).filter((entry) => entry.id !== ownerId)
    host.askSkill({ skillId: WUYI_SHIBIAN, ownerId, step: 'mark-target', data: { roundNumber: host.state.roundNumber }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【识变】：可选择一名其他角色，其攻击范围内的角色本轮视为在你的攻击范围内',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map(({ id }) => id), min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'mark-target' || Number(resolution.data.roundNumber) !== host.state.roundNumber) return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId) { delete b86(host.state).shibian?.[ownerId]; return }
    if (targetId === ownerId || !player(host.state, ownerId)?.alive || !player(host.state, targetId)?.alive) return
    b86(host.state).shibian ??= {}
    b86(host.state).shibian[ownerId] = { roundNumber: host.state.roundNumber, targetId } satisfies ShiBianRecord
  },
})

type BibuTurnRecord = { turnNumber: number; redirectedTargetIds: PlayerId[]; finishedUserIds: PlayerId[] }
function bibuRecord(state: SanguoshaState, ownerId: PlayerId): BibuTurnRecord {
  const records = b86(state).bibuTurn ??= {}
  const record = records[ownerId] as BibuTurnRecord | undefined
  if (record?.turnNumber === state.turnNumber) return record
  const next: BibuTurnRecord = { turnNumber: state.turnNumber, redirectedTargetIds: [], finishedUserIds: [] }
  records[ownerId] = next
  return next
}
function bibuCardAllowed(state: SanguoshaState, cardId: CardId, cardName: string, category: CardCategory): boolean {
  return (category === 'basic' && ['杀', '火杀', '雷杀'].includes(cardName))
    || (category === 'trick' && !DELAYED_TRICKS.has(cardName) && Boolean(card(state, cardId)))
}

registerSkillRuntime({
  id: WUYI_BIBU,
  interceptTarget(host, ownerId, context) {
    const flanks = formationFlanks(host.state, ownerId)
    const resolution = host.state.cardResolution
    const targets = resolution?.kind === 'trick' ? resolution.targetIds
      : resolution?.kind === 'slash' ? [resolution.targetId, ...resolution.remainingTargetIds] : [context.targetId]
    const record = bibuRecord(host.state, ownerId)
    if (!flanks?.includes(context.targetId) || context.sourceId === ownerId || !player(host.state, ownerId)?.alive
      || targets.length !== 1 || targets[0] !== context.targetId
      || !bibuCardAllowed(host.state, context.cardId, context.cardName, context.category)
      || record.redirectedTargetIds.includes(context.targetId)) return false
    record.redirectedTargetIds.push(context.targetId)
    host.askSkill({ skillId: WUYI_BIBU, ownerId, step: 'redirect-target', data: {
      turnNumber: host.state.turnNumber, cardId: context.cardId, cardName: context.cardName,
      sourceId: context.sourceId, targetId: context.targetId, category: context.category,
    }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: `【庇部】：是否摸一张牌并将${player(host.state, context.targetId)?.nickname ?? '该角色'}为唯一目标的此牌转移给你？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '摸一张并转移目标' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId
    const source = sourceId ? player(host.state, sourceId) : undefined
    if (!sourceId || !source?.alive || !formationFlanks(host.state, ownerId)?.includes(sourceId)
      || !cardId || !bibuCardAllowed(host.state, cardId, payload.cardName ?? effectiveCardName(host.state, cardId), card(host.state, cardId)?.category ?? 'basic')) return
    const record = bibuRecord(host.state, ownerId)
    if (record.finishedUserIds.includes(sourceId)) return
    record.finishedUserIds.push(sourceId)
    if (player(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    if (host.state.zones.discardPile.includes(cardId) && player(host.state, ownerId)?.alive)
      host.queueSkill({ skillId: WUYI_BIBU, ownerId, step: 'offer-reuse', data: { turnNumber: host.state.turnNumber, cardId } })
  } }],
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'offer-reuse' || Number(queued.data.turnNumber) !== host.state.turnNumber
      || !host.state.zones.discardPile.includes(queued.data.cardId as CardId) || !player(host.state, ownerId)?.alive) return
    const cardId = queued.data.cardId as CardId
    const actions = skillDiscardCardUseActions(host.state, ownerId, cardId, WUYI_BIBU)
    if (!actions.length) return
    host.askSkill({ skillId: WUYI_BIBU, ownerId, step: 'reuse-card', data: { cardId, actionIds: actions.map(({ id }) => id) }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【庇部】：可视为使用刚结算完毕的牌', timeoutMs: 25_000,
      optional: true, options: [{ id: 'decline', label: '不使用' }, ...actions.map(({ id: actionId, label }) => ({ id: actionId, label }))],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'redirect-target') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const data = resolution.data as { turnNumber: number; cardId: CardId; sourceId: PlayerId; targetId: PlayerId; category: CardCategory; cardName: string }
      const current = host.state.cardResolution
      const targetStillCurrent = current?.kind === 'trick' ? current.targetIds[current.targetIndex] === data.targetId
        : current?.kind === 'slash' ? current.targetId === data.targetId : false
      if (!player(host.state, ownerId)?.alive || !player(host.state, data.sourceId)?.alive || !player(host.state, data.targetId)?.alive
        || data.turnNumber !== host.state.turnNumber || !targetStillCurrent) { host.resumeCardTarget(); return }
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      if (current?.kind === 'slash') {
        const transferSlashTarget = getEngineCallbacks()?.transferSlashTarget
        if (transferSlashTarget) transferSlashTarget(host, ownerId, '谋·吴懿【庇部】')
        else host.resumeCardTarget()
      } else if (current?.kind === 'trick') {
        current.targetIds[current.targetIndex] = ownerId
        host.resumeCardTarget()
      } else host.resumeCardTarget()
      return
    }
    if (resolution.step === 'reuse-card') {
      const data = resolution.data as { cardId: CardId; actionIds: string[] }
      const actionId = (response.payload as { optionId?: string }).optionId
      if (!actionId || actionId === 'decline' || !data.actionIds.includes(actionId)
        || !host.state.zones.discardPile.includes(data.cardId) || !player(host.state, ownerId)?.alive) return
      host.beginSkillCardUseFromDiscard(ownerId, data.cardId, WUYI_BIBU, actionId)
    }
  },
})

type DuluFlow = { targetIds: PlayerId[]; index: number; activationTurn: number }
function startDuluTargetDamage(host: SkillHost, ownerId: PlayerId, flow: DuluFlow): void {
  const targetId = flow.targetIds[flow.index]
  if (!targetId || !player(host.state, targetId)?.alive) {
    host.queueSkill({ skillId: LIUYI_DULU, ownerId, step: 'after-target', data: { ...flow }, allowDeadOwner: true })
    return
  }
  resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: [targetId], amount: 1,
    nature: 'normal', cardId: null, cardName: null, sourceSkillId: LIUYI_DULU })
}

// 刘懿君【妒戮】：发动对象只限本回合曾对其使用过牌的其他角色。
registerSkillRuntime({
  id: LIUYI_DULU,
  activeActions(state, ownerId) {
    const used = b86(state).duluUsedTurn?.[ownerId] === state.turnNumber
    const targets = (b86(state).duluTargets?.[ownerId] ?? []) as PlayerId[]
    return state.status === 'playing' && state.phase === 'play' && state.currentPlayerId === ownerId && !used && targets.length
      ? [{ id: `${LIUYI_DULU}:activate`, kind: 'invoke-skill', playerId: ownerId, skillId: LIUYI_DULU, cardIds: [], targetIds: [], label: `发动【妒戮】（${targets.length}名角色）` } as LegalAction]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${LIUYI_DULU}:activate` || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || b86(host.state).duluUsedTurn?.[ownerId] === host.state.turnNumber) return
    const targetIds = ((b86(host.state).duluTargets?.[ownerId] ?? []) as PlayerId[]).filter((id) => player(host.state, id)?.alive)
    if (!targetIds.length) return
    b86(host.state).duluUsedTurn ??= {}; b86(host.state).duluUsedTurn[ownerId] = host.state.turnNumber
    const flow: DuluFlow = { targetIds, index: 0, activationTurn: host.state.turnNumber }
    b86(host.state).duluFlows ??= {}; b86(host.state).duluFlows[ownerId] = flow
    startDuluTargetDamage(host, ownerId, flow)
  },
  triggers: [
    { event: 'BeforeCardUse', handle(host, _ownerId, context) {
      const sourceId = context.event.sourceId
      const targetIds = ((context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? [])
      if (!sourceId || !player(host.state, sourceId)?.alive) return
      b86(host.state).duluTargets ??= {}
      const targets = (b86(host.state).duluTargets[sourceId] ??= []) as PlayerId[]
      for (const targetId of targetIds)
        if (targetId !== sourceId && !targets.includes(targetId)) targets.push(targetId)
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) {
        delete b86(host.state).duluUsedTurn?.[ownerId]
        delete b86(host.state).duluTargets?.[ownerId]
        for (const [holderId, record] of Object.entries(b86(host.state).duluMarks ?? {}) as Array<[string, { expiryTurn: number | null }]>)
          if (record.expiryTurn !== null && host.state.turnNumber > record.expiryTurn) delete b86(host.state).duluMarks[holderId]
        const record = b86(host.state).duluMarks?.[ownerId] as { createdTurn: number; expiryTurn: number | null } | undefined
        if (record && record.createdTurn !== host.state.turnNumber) record.expiryTurn = host.state.turnNumber
      }
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      const record = b86(host.state).duluMarks?.[ownerId] as { targetIds: PlayerId[]; expiryTurn: number | null } | undefined
      if (!targetId || !record?.targetIds.includes(targetId) || (record.expiryTurn !== null && host.state.turnNumber > record.expiryTurn)) return
      const victim = player(host.state, targetId)
      if (!victim?.alive) return
      const allOwned = [...victim.zones.hand, ...victim.zones.judgingArea,
        ...Object.values(victim.zones.equipment).filter((id): id is CardId => id !== null)]
      const black = allOwned.filter((id) => effectiveCardColor(host.state, targetId, id) === 'black')
      const gained: CardId[] = []
      for (const id of black) {
        if (movePickedCard(host as never, targetId, id, { kind: 'hand', playerId: ownerId })) gained.push(id)
      }
      if (gained.length) {
        dispatch(host, 'LoseCard', { playerId: targetId, cardIds: gained, reason: LIUYI_DULU }, targetId, ownerId, gained)
        dispatch(host, 'GainCard', { playerId: ownerId, cardIds: gained, reason: LIUYI_DULU }, targetId, ownerId, gained)
      }
    } },
    { event: 'DamageSequenceResolved', allowDeadOwner: true, handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== LIUYI_DULU) return
      const flow = b86(host.state).duluFlows?.[ownerId] as DuluFlow | undefined
      if (flow) host.queueSkill({ skillId: LIUYI_DULU, ownerId, step: 'after-target', data: { ...flow }, allowDeadOwner: true })
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'next-target') {
      const flow = queued.data as DuluFlow
      if (flow.index >= flow.targetIds.length) {
        delete b86(host.state).duluFlows?.[ownerId]
        if (!player(host.state, ownerId)?.alive) return
        b86(host.state).duluMarks ??= {}
        b86(host.state).duluMarks[ownerId] = { targetIds: flow.targetIds, createdTurn: flow.activationTurn, expiryTurn: null }
        return
      }
      b86(host.state).duluFlows ??= {}; b86(host.state).duluFlows[ownerId] = flow
      startDuluTargetDamage(host, ownerId, flow)
      return
    }
    if (queued.step !== 'after-target') return
    const flow = queued.data as DuluFlow
    const targetId = flow.targetIds[flow.index]
    if (targetId && player(host.state, targetId)?.alive && hand(host.state, targetId).length) {
      const selected = host.rng.pick(hand(host.state, targetId))
      discardCardsByIds(host as never, targetId, [selected], LIUYI_DULU)
    }
    flow.index += 1
    host.queueSkill({ skillId: LIUYI_DULU, ownerId, step: 'next-target', data: { ...flow }, allowDeadOwner: true })
  },
})

// 刘懿君【缚己】的回合结算奖励与本轮一次手牌交付拦截。
registerSkillRuntime({
  id: LIUYI_FUJI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (!playerId || playerId === ownerId || phase !== 'play' || !player(host.state, ownerId)?.alive
      || b86(host.state).fujiRound?.[ownerId] === host.state.roundNumber) return
    host.queueSkill({ skillId: LIUYI_FUJI, ownerId, step: 'offer', data: { actorId: playerId, round: host.state.roundNumber } })
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    const turnPlayer = (context.event.payload as { playerId?: PlayerId }).playerId
    const record = b86(host.state).fujiReward?.[ownerId] as { actorId: PlayerId } | undefined
    if (record?.actorId !== turnPlayer) return
    delete b86(host.state).fujiReward[ownerId]
    if (player(host.state, ownerId)?.alive) {
      recover(host as never, ownerId, 1, turnPlayer, LIUYI_FUJI)
      drawCards(host.state, host.rng, ownerId, 3, (name, payload) => host.dispatch(name, payload))
    }
  } }],
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'offer') return
    const actorId = queued.data.actorId as PlayerId
    if (!player(host.state, actorId)?.alive || !player(host.state, ownerId)?.alive
      || Number(queued.data.round) !== host.state.roundNumber || b86(host.state).fujiRound?.[ownerId] === host.state.roundNumber) return
    askOption(host, LIUYI_FUJI, ownerId, 'invoke', { actorId }, `【缚己】：是否令${player(host.state, actorId)?.nickname ?? '该角色'}观看你的手牌？`,
      [{ id: 'yes', label: '展示手牌并建立缚己' }, { id: 'no', label: '不发动' }])
  },
  interceptTarget(host, ownerId, context) {
    const mark = b86(host.state).fujiTargets?.[ownerId] as { targets: PlayerId[]; round: number } | undefined
    if (!mark || mark.round !== host.state.roundNumber || context.targetId !== ownerId || context.sourceId === ownerId
      || !mark.targets.includes(context.sourceId) || !hand(host.state, ownerId).length) return false
    host.askSkill({ skillId: LIUYI_FUJI, ownerId, step: 'redirect', data: { cardId: context.cardId, sourceId: context.sourceId }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【缚己】：交出所有手牌并令此牌对你无效；选择手牌接收者', timeoutMs: 25_000,
      optional: true, candidateIds: alive(host.state).filter((entry) => entry.id !== ownerId).map((entry) => entry.id), min: 0, max: 1,
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const actorId = resolution.data.actorId as PlayerId
      if (!player(host.state, actorId)?.alive || !player(host.state, ownerId)?.alive) return
      host.askSkill({ skillId: LIUYI_FUJI, ownerId, step: 'reveal-hand', data: { actorId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: actorId, prompt: '【缚己】：观看刘懿君的手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [], viewOnlyCardIds: [...hand(host.state, ownerId)], hiddenCardSlots: [], min: 0, max: 0,
      }) })
      return
    }
    if (resolution.step === 'reveal-hand') {
      const actorId = resolution.data.actorId as PlayerId
      if (!player(host.state, actorId)?.alive || !player(host.state, ownerId)?.alive) return
      b86(host.state).fujiRound ??= {}; b86(host.state).fujiRound[ownerId] = host.state.roundNumber
      b86(host.state).fujiReward ??= {}; b86(host.state).fujiReward[ownerId] = { actorId }
      b86(host.state).fujiTargets ??= {}; b86(host.state).fujiTargets[ownerId] = { targets: [actorId], round: host.state.roundNumber }
      return
    }
    if (resolution.step !== 'redirect') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const sourceId = resolution.data.sourceId as PlayerId
    const cardId = resolution.data.cardId as CardId
    const owner = player(host.state, ownerId), target = targetId ? player(host.state, targetId) : undefined
    if (!owner || !target?.alive || !owner.zones.hand.length || !host.state.cardResolution || host.state.cardResolution.cardId !== cardId) {
      host.resumeCardTarget(); return
    }
    giveOwnedCards(host as never, ownerId, targetId!, [...owner.zones.hand], LIUYI_FUJI)
    const current = host.state.cardResolution
    if (current?.kind === 'slash' && current.targetId === ownerId) current.targetCancelled = true
    else if (current?.kind === 'trick' && current.targetIds[current.targetIndex] === ownerId
      && !current.cancelledTargetIds.includes(ownerId)) current.cancelledTargetIds.push(ownerId)
    host.dispatch('SkillActivated', { skillId: LIUYI_FUJI, skillName: '缚己', playerId: ownerId, targetIds: [sourceId, targetId], result: 'hand-given-card-invalidated' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.resumeCardTarget()
  },
})

type XiSongObservation = { targetId: PlayerId; round: number; viewedHand: CardId[] }
const XI_SONG_CATEGORIES: CardCategory[] = ['basic', 'trick', 'equipment']
const XI_SONG_SUITS: Suit[] = ['spade', 'heart', 'club', 'diamond']
function xisongObservation(state: SanguoshaState, ownerId: PlayerId): XiSongObservation | undefined {
  return b86(state).xisongObservation?.[ownerId] as XiSongObservation | undefined
}

registerSkillRuntime({
  id: ZHANGSONG_XISONG,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const { playerId: targetId, phase } = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (!targetId || targetId === ownerId || phase !== 'play' || !player(host.state, ownerId)?.alive
        || b86(host.state).xisongUsedRound?.[ownerId] === host.state.roundNumber) return
      host.queueSkill({ skillId: ZHANGSONG_XISONG, ownerId, step: 'offer-view', data: { targetId, round: host.state.roundNumber } })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const { playerId: targetId, phase } = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const observation = xisongObservation(host.state, ownerId)
      if (phase !== 'play' || !targetId || observation?.targetId !== targetId || observation.round !== host.state.roundNumber
        || !player(host.state, ownerId)?.alive || !player(host.state, targetId)?.alive) return
      const options = [
        ...XI_SONG_CATEGORIES.map((value) => ({ id: `category:${value}`, label: `类别：${value === 'basic' ? '基本牌' : value === 'trick' ? '锦囊牌' : '装备牌'}` })),
        ...XI_SONG_SUITS.map((value) => ({ id: `suit:${value}`, label: `花色：${({ spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' } as const)[value]}` })),
        ...Array.from({ length: 13 }, (_, index) => ({ id: `number:${index + 1}`, label: `点数：${index + 1}` })),
      ]
      host.queueSkill({ skillId: ZHANGSONG_XISONG, ownerId, step: 'offer-declare', data: { ...observation, options } })
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'offer-use-match') {
      const cardId = queued.data.cardId as CardId
      if (!player(host.state, ownerId)?.alive || !host.state.zones.discardPile.includes(cardId)) return
      const actions = skillDiscardCardUseActions(host.state, ownerId, cardId, ZHANGSONG_XISONG)
      if (!actions.length) return
      host.askSkill({ skillId: ZHANGSONG_XISONG, ownerId, step: 'use-match', data: { cardId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【悉诵】：选择合法方式使用刚才弃置的牌', timeoutMs: 25_000,
        optional: false, options: actions.map(({ id: actionId, label }) => ({ id: actionId, label })),
      }) })
      return
    }
    if (queued.step === 'offer-view') {
      const targetId = queued.data.targetId as PlayerId
      if (!player(host.state, ownerId)?.alive || !player(host.state, targetId)?.alive
        || Number(queued.data.round) !== host.state.roundNumber || b86(host.state).xisongUsedRound?.[ownerId] === host.state.roundNumber) return
      askOption(host, ZHANGSONG_XISONG, ownerId, 'view-offer', { targetId, round: host.state.roundNumber },
        `【悉诵】：是否观看${player(host.state, targetId)?.nickname ?? '该角色'}的手牌？`, [{ id: 'yes', label: '观看' }, { id: 'no', label: '不观看' }])
      return
    }
    if (queued.step !== 'offer-declare') return
    const observation = queued.data as XiSongObservation
    if (observation.round !== host.state.roundNumber || xisongObservation(host.state, ownerId)?.targetId !== observation.targetId) return
    const options = queued.data.options as Array<{ id: string; label: string }>
    host.askSkill({ skillId: ZHANGSONG_XISONG, ownerId, step: 'declare', data: { targetId: observation.targetId, round: observation.round }, build: (id): ChooseOptionsRequest => ({
      id, kind: 'choose-options', playerId: ownerId, prompt: '【悉诵】：声明一种类别、一种花色和一个点数', timeoutMs: 25_000,
      optional: false, options, min: 3, max: 3,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'view-offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId
      const target = player(host.state, targetId), owner = player(host.state, ownerId)
      if (!target?.alive || !owner?.alive || Number(resolution.data.round) !== host.state.roundNumber
        || b86(host.state).xisongUsedRound?.[ownerId] === host.state.roundNumber) return
      host.askSkill({ skillId: ZHANGSONG_XISONG, ownerId, step: 'view-hand', data: { targetId, round: host.state.roundNumber }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【悉诵】：观看${target.nickname}的手牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [], viewOnlyCardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max: 0,
      }) })
      return
    }
    if (resolution.step === 'view-hand') {
      const targetId = resolution.data.targetId as PlayerId
      const target = player(host.state, targetId)
      if (!target?.alive || Number(resolution.data.round) !== host.state.roundNumber) return
      b86(host.state).xisongObservation ??= {}
      b86(host.state).xisongObservation[ownerId] = { targetId, round: host.state.roundNumber, viewedHand: [...target.zones.hand] } satisfies XiSongObservation
      b86(host.state).xisongUsedRound ??= {}; b86(host.state).xisongUsedRound[ownerId] = host.state.roundNumber
      return
    }
    if (resolution.step === 'declare') {
      const observation = resolution.data as XiSongObservation
      const target = player(host.state, observation.targetId)
      if (!target?.alive || observation.round !== host.state.roundNumber) return
      const selected = (response.payload as { optionIds?: string[] }).optionIds ?? []
      const category = selected.find((value) => value.startsWith('category:'))?.slice('category:'.length) as CardCategory | undefined
      const suit = selected.find((value) => value.startsWith('suit:'))?.slice('suit:'.length) as Suit | undefined
      const number = Number(selected.find((value) => value.startsWith('number:'))?.slice('number:'.length))
      if (selected.length !== 3 || !category || !suit || !XI_SONG_CATEGORIES.includes(category) || !XI_SONG_SUITS.includes(suit)
        || !Number.isInteger(number) || number < 1 || number > 13
        || selected.filter((value) => value.startsWith('category:')).length !== 1
        || selected.filter((value) => value.startsWith('suit:')).length !== 1
        || selected.filter((value) => value.startsWith('number:')).length !== 1) return
      host.dispatch('CardMove', { playerId: target.id, cardIds: [...target.zones.hand], revealed: true, reason: ZHANGSONG_XISONG },
        { sourceId: ownerId, targetId: target.id, cardIds: [...target.zones.hand] })
      const match = target.zones.hand.find((cardId) => card(host.state, cardId)?.category === category
        && card(host.state, cardId)?.suit === suit && ruleCardNumber(host.state, cardId) === number)
      delete b86(host.state).xisongObservation?.[ownerId]
      if (!match) return
      delete b86(host.state).xisongUsedRound?.[ownerId]
      const discarded = discardCardsByIds(host as never, target.id, [match], ZHANGSONG_XISONG)
      if (!discarded.includes(match) || !player(host.state, ownerId)?.alive || !host.state.zones.discardPile.includes(match)) return
      host.queueSkill({ skillId: ZHANGSONG_XISONG, ownerId, step: 'offer-use-match', data: { cardId: match } })
      return
    }
    if (resolution.step === 'use-match') {
      const cardId = resolution.data.cardId as CardId
      const actionId = (response.payload as { optionId?: string }).optionId
      if (!actionId || !host.state.zones.discardPile.includes(cardId)) return
      host.beginSkillCardUseFromDiscard(ownerId, cardId, ZHANGSONG_XISONG, actionId)
    }
  },
})

type FanglangRecord = { shownCardId: CardId; activatedTurn: number; firstProcessedTurn: number | null }
type FanglangCriteria = { category: CardCategory; suit: Suit; number: number | null }
const FANGLANG_ORDER: Array<'category' | 'number' | 'suit'> = ['category', 'number', 'suit']
function fanglangRecord(state: SanguoshaState, ownerId: PlayerId): FanglangRecord | undefined {
  return b86(state).fanglang?.[ownerId] as FanglangRecord | undefined
}
function fanglangMatchCount(state: SanguoshaState, shownCardId: CardId, playedCardId: CardId | null, cardName?: string): number {
  const shown = card(state, shownCardId)
  if (!shown) return 0
  const used = playedCardId ? card(state, playedCardId) : undefined
  if (playedCardId && playedCardId === shownCardId) return 0
  const nameDefinition = used ?? (cardName ? Object.values(state.cards).find((entry) => entry.name === cardName) : undefined)
  if (!nameDefinition) return 0
  const shownNumber = ruleCardNumber(state, shownCardId)
  const usedNumber = playedCardId ? ruleCardNumber(state, playedCardId) : (nameDefinition.rank ?? null)
  return Number(shown.category === nameDefinition.category)
    + Number(Boolean(shown.suit && nameDefinition.suit && shown.suit === nameDefinition.suit))
    + Number(shownNumber !== null && usedNumber !== null && shownNumber === usedNumber)
}

registerSkillRuntime({
  id: ZHANGSONG_FANGLANG,
  triggers: [
    { event: 'DrawPhaseResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      const owner = player(host.state, ownerId)
      if (payload.playerId !== ownerId || !owner?.alive || !payload.cardIds?.some((id) => owner.zones.hand.includes(id))) return
      const candidates = payload.cardIds.filter((id) => owner.zones.hand.includes(id))
      host.queueSkill({ skillId: ZHANGSONG_FANGLANG, ownerId, step: 'offer-show', data: { candidates, turn: host.state.turnNumber } })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) {
        const record = fanglangRecord(host.state, ownerId)
        if (record && record.activatedTurn !== host.state.turnNumber) delete b86(host.state).fanglang?.[ownerId]
      }
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; cardName?: string }
      applyFanglangFirstCard(host, ownerId, payload.cardId ?? payload.cardIds?.[0] ?? null, payload.cardName, payload.cardIds)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId | null; cardIds?: CardId[]; cardName?: string; revealed?: boolean; reason?: string }
      if (payload.revealed || payload.reason === '改判') return
      applyFanglangFirstCard(host, ownerId, payload.cardId ?? null, payload.cardName, payload.cardIds)
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (playerId !== ownerId || phase !== 'finish' || !player(host.state, ownerId)?.alive) return
      const owner = player(host.state, ownerId)!
      const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => id !== null)]
        .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      if (cardIds.length) host.queueSkill({ skillId: ZHANGSONG_FANGLANG, ownerId, step: 'offer-discard', data: { cardIds, turn: host.state.turnNumber } })
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'start-gains') {
      const pending = queued.data as { selectedId: CardId; criteria: FanglangCriteria; index: number; gained: CardId[] }
      resolveFanglangGain(host, ownerId, pending.selectedId, pending.criteria, pending.index, pending.gained)
      return
    }
    if (queued.step === 'offer-show') {
      const candidates = (queued.data.candidates as CardId[]).filter((id) => hand(host.state, ownerId).includes(id))
      if (Number(queued.data.turn) !== host.state.turnNumber || !candidates.length) return
      host.askSkill({ skillId: ZHANGSONG_FANGLANG, ownerId, step: 'show-card', data: { candidates, turn: host.state.turnNumber }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【放浪】：展示一张本次摸到的牌', timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
      }) })
      return
    }
    if (queued.step === 'offer-discard') {
      const cardIds = (queued.data.cardIds as CardId[]).filter((id) => {
        const zone = locateOwnedCard(host.state, ownerId, id)
        return Boolean(zone && (zone.kind === 'hand' || zone.kind === 'equipment') && !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      })
      if (Number(queued.data.turn) !== host.state.turnNumber || !cardIds.length) return
      host.askSkill({ skillId: ZHANGSONG_FANGLANG, ownerId, step: 'discard', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【放浪】：可弃置一张手牌或装备牌，获得弃牌堆中分别与其类别、点数、花色相同的牌各一张',
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'show-card') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!selected) return
      const owner = player(host.state, ownerId)
      const allowed = (resolution.data.candidates as CardId[]).includes(selected)
      if (!owner?.zones.hand.includes(selected) || !allowed || resolution.data.turn !== host.state.turnNumber) return
      b86(host.state).fanglang ??= {}
      b86(host.state).fanglang[ownerId] = { shownCardId: selected, activatedTurn: host.state.turnNumber, firstProcessedTurn: null } satisfies FanglangRecord
      host.dispatch('CardMove', { playerId: ownerId, cardIds: [selected], revealed: true, reason: ZHANGSONG_FANGLANG }, { sourceId: ownerId, targetId: ownerId, cardIds: [selected] })
      return
    }
    if (resolution.step === 'discard') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!selected) return
      const zone = locateOwnedCard(host.state, ownerId, selected)
      const selectedCard = card(host.state, selected)
      if (!zone || (zone.kind !== 'hand' && zone.kind !== 'equipment') || !selectedCard
        || isCardProtectedFromDiscard(host.state, ownerId, selected, ownerId)
        || !discardCardsByIds(host as never, ownerId, [selected], ZHANGSONG_FANGLANG).includes(selected)) return
      const criteria: FanglangCriteria = { category: selectedCard.category, number: ruleCardNumber(host.state, selected), suit: selectedCard.suit }
      host.queueSkill({ skillId: ZHANGSONG_FANGLANG, ownerId, step: 'start-gains', data: { selectedId: selected, criteria, index: 0, gained: [] } })
    }
    if (resolution.step.startsWith('gain-')) {
      const payload = response.payload as { cardIds?: CardId[] }
      const pending = resolution.data as { selectedId: CardId; criteria: FanglangCriteria; index: number; gained: CardId[] }
      const criterion = FANGLANG_ORDER[pending.index]
      const chosen = payload.cardIds?.[0]
      if (criterion && chosen && !pending.gained.includes(chosen) && host.state.zones.discardPile.includes(chosen)) {
        const candidate = card(host.state, chosen)
        const matches = criterion === 'category' ? candidate?.category === pending.criteria.category
          : criterion === 'number' ? pending.criteria.number !== null && ruleCardNumber(host.state, chosen) === pending.criteria.number
            : candidate?.suit === pending.criteria.suit
        if (!matches) {
          host.queueSkill({ skillId: ZHANGSONG_FANGLANG, ownerId, step: 'start-gains', data: {
            selectedId: pending.selectedId, criteria: pending.criteria, index: pending.index + 1, gained: pending.gained,
          } })
          return
        }
        moveCard(host.state, chosen, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [chosen], reason: ZHANGSONG_FANGLANG, criterion }, { sourceId: ownerId, targetId: ownerId, cardIds: [chosen] })
        pending.gained.push(chosen)
      }
      host.queueSkill({ skillId: ZHANGSONG_FANGLANG, ownerId, step: 'start-gains', data: {
        selectedId: pending.selectedId, criteria: pending.criteria, index: pending.index + 1, gained: pending.gained,
      } })
    }
  },
})

function applyFanglangFirstCard(host: SkillHost, ownerId: PlayerId, playedCardId: CardId | null, cardName?: string, physicalIds: CardId[] = []): void {
  const record = fanglangRecord(host.state, ownerId)
  if (!record || physicalIds.includes(record.shownCardId) || playedCardId === record.shownCardId
    || record.firstProcessedTurn === host.state.turnNumber) return
  record.firstProcessedTurn = host.state.turnNumber
  const count = fanglangMatchCount(host.state, record.shownCardId, playedCardId, cardName)
  if (count > 0) drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
}

function resolveFanglangGain(host: SkillHost, ownerId: PlayerId, selectedId: CardId,
  criteria: FanglangCriteria, index: number, gained: CardId[]): void {
  if (index >= FANGLANG_ORDER.length || !player(host.state, ownerId)?.alive) return
  const criterion = FANGLANG_ORDER[index]!
  const candidates = host.state.zones.discardPile.filter((id) => !gained.includes(id)
    && (criterion === 'category' ? card(host.state, id)?.category === criteria.category
      : criterion === 'number' ? criteria.number !== null && ruleCardNumber(host.state, id) === criteria.number : card(host.state, id)?.suit === criteria.suit))
  if (!candidates.length) {
    host.queueSkill({ skillId: ZHANGSONG_FANGLANG, ownerId, step: 'start-gains', data: { selectedId, criteria, index: index + 1, gained } })
    return
  }
  host.askSkill({ skillId: ZHANGSONG_FANGLANG, ownerId, step: `gain-${criterion}`, data: { selectedId, criteria, index, gained }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【放浪】：选择获得弃牌堆中与所弃牌${criterion === 'category' ? '类别' : criterion === 'number' ? '点数' : '花色'}相同的一张牌`,
    timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
  }) })
}

type ZhenGongFlow = { cardIds: CardId[]; assignments: Array<{ cardId: CardId; recipientId: PlayerId }>; index: number; actualTargets: PlayerId[] }

function startZhenGongAssignmentDamage(host: SkillHost, ownerId: PlayerId, flow: ZhenGongFlow): void {
  const recipientDamage = new Map<PlayerId, number>()
  for (const assignment of flow.assignments) recipientDamage.set(assignment.recipientId, (recipientDamage.get(assignment.recipientId) ?? 0) + 1)
  const entries = [...recipientDamage]
  const [targetId, amount] = entries[flow.index] ?? []
  if (!targetId || !amount) {
    host.queueSkill({ skillId: ZHANGREN_ZHENGONG, ownerId, step: 'finish-damage', data: { ...flow }, allowDeadOwner: true })
    return
  }
  b86(host.state).zhenGongFlows ??= {}
  b86(host.state).zhenGongFlows[ownerId] = flow
  resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: [targetId], amount, nature: 'normal', cardId: null, cardName: null, sourceSkillId: ZHANGREN_ZHENGONG })
}

type SheDaoTurn = { turnNumber: number; redCardIds: CardId[] }
function sheDaoTurn(state: SanguoshaState, ownerId: PlayerId): SheDaoTurn {
  const records = b86(state).shedaoTurn ??= {}
  const current = records[ownerId] as SheDaoTurn | undefined
  if (current?.turnNumber === state.turnNumber) return current
  const next: SheDaoTurn = { turnNumber: state.turnNumber, redCardIds: [] }
  records[ownerId] = next
  return next
}

registerSkillRuntime({
  id: ZHANGREN_SHEDAO,
  handLimitExempt(state, ownerId, cardId) {
    const record = b86(state).shedaoTurn?.[ownerId] as SheDaoTurn | undefined
    return Boolean(record?.turnNumber === state.turnNumber && record.redCardIds.includes(cardId) && hand(state, ownerId).includes(cardId))
  },
  triggers: [{ event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null }
    const owner = player(host.state, ownerId)
    const candidate = payload.cardId ? card(host.state, payload.cardId) : undefined
    if (!owner?.alive || host.state.currentPlayerId !== ownerId || !payload.cardId
      || !payload.fromPlayerId || payload.fromPlayerId === ownerId || !candidate
      || !host.state.zones.discardPile.includes(payload.cardId)) return
    host.queueSkill({ skillId: ZHANGREN_SHEDAO, ownerId, step: 'offer', data: {
      turnNumber: host.state.turnNumber, cardIds: [payload.cardId],
    } })
  } }],
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'offer') return
    const turnNumber = Number(queued.data.turnNumber)
    const cardIds = (queued.data.cardIds as CardId[]).filter((id) => host.state.zones.discardPile.includes(id))
    const owner = player(host.state, ownerId)
    if (!owner?.alive || turnNumber !== host.state.turnNumber || host.state.currentPlayerId !== ownerId || !cardIds.length) return
    const redIds = cardIds.filter((id) => effectiveCardColor(host.state, ownerId, id) === 'red')
    const slashIds = cardIds.filter((id) => effectiveCardName(host.state, id) === '杀')
    const blackCosts = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => id !== null)]
      .filter((id) => effectiveCardColor(host.state, ownerId, id) === 'black' && !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
    const options = [
      ...(redIds.length && blackCosts.length ? [{ id: 'red', label: '获得其中任意张红色牌并弃置一张黑色牌' }] : []),
      ...(slashIds.length ? [{ id: 'thunder-slash', label: '获得其中的【杀】，令其永久视为雷【杀】' }] : []),
    ]
    if (!options.length) return
    host.askSkill({ skillId: ZHANGREN_SHEDAO, ownerId, step: 'choose-mode', data: { turnNumber, cardIds }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【慑道】：选择一项效果', timeoutMs: 25_000,
      optional: true, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const turnNumber = Number(resolution.data.turnNumber)
    const owner = player(host.state, ownerId)
    const eventCardIds = (Array.isArray(resolution.data.cardIds) ? resolution.data.cardIds as CardId[] : [])
      .filter((id) => host.state.zones.discardPile.includes(id))
    if (!owner?.alive || turnNumber !== host.state.turnNumber || host.state.currentPlayerId !== ownerId) return
    if (resolution.step === 'choose-mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      const redIds = eventCardIds.filter((id) => effectiveCardColor(host.state, ownerId, id) === 'red')
      const slashIds = eventCardIds.filter((id) => effectiveCardName(host.state, id) === '杀')
      if (mode === 'red' && redIds.length) {
        host.askSkill({ skillId: ZHANGREN_SHEDAO, ownerId, step: 'choose-red', data: { turnNumber, redIds }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【慑道】：获得其中任意张红色牌', timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: redIds, hiddenCardSlots: [], min: 1, max: redIds.length,
        }) })
      } else if (mode === 'thunder-slash' && slashIds.length) {
        host.askSkill({ skillId: ZHANGREN_SHEDAO, ownerId, step: 'choose-slash', data: { turnNumber, slashIds }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【慑道】：获得其中一张【杀】并令其永久视为雷【杀】', timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: slashIds, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'choose-red') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const allowed = new Set(resolution.data.redIds as CardId[])
      const unique = [...new Set(selected)]
      if (!unique.length || unique.length !== selected.length || unique.some((id) => !allowed.has(id) || !host.state.zones.discardPile.includes(id))) return
      const costs = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => id !== null)]
        .filter((id) => effectiveCardColor(host.state, ownerId, id) === 'black' && !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      if (!costs.length) return
      host.askSkill({ skillId: ZHANGREN_SHEDAO, ownerId, step: 'discard-black', data: { turnNumber, selectedIds: unique }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【慑道】：弃置一张黑色手牌或装备牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: costs, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'discard-black') {
      const selectedBlack = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const costs = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => id !== null)]
      if (!selectedBlack || !costs.includes(selectedBlack) || effectiveCardColor(host.state, ownerId, selectedBlack) !== 'black'
        || isCardProtectedFromDiscard(host.state, ownerId, selectedBlack, ownerId)
        || !discardCardsByIds(host as never, ownerId, [selectedBlack], ZHANGREN_SHEDAO).includes(selectedBlack)) return
      const selectedIds = (resolution.data.selectedIds as CardId[]).filter((id) => host.state.zones.discardPile.includes(id)
        && effectiveCardColor(host.state, ownerId, id) === 'red')
      const record = sheDaoTurn(host.state, ownerId)
      for (const id of selectedIds) {
        moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        if (!record.redCardIds.includes(id)) record.redCardIds.push(id)
      }
      if (selectedIds.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: selectedIds, reason: ZHANGREN_SHEDAO },
        { sourceId: ownerId, targetId: ownerId, cardIds: selectedIds })
      return
    }
    if (resolution.step === 'choose-slash') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!selected || !(resolution.data.slashIds as CardId[]).includes(selected) || !host.state.zones.discardPile.includes(selected)
        || effectiveCardName(host.state, selected) !== '杀') return
      const definition = card(host.state, selected)
      if (!definition) return
      definition.damageNature = 'thunder'
      moveCard(host.state, selected, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: ZHANGREN_SHEDAO, permanentNature: 'thunder' },
        { sourceId: ownerId, targetId: ownerId, cardIds: [selected] })
    }
  },
})

registerSkillRuntime({
  id: ZHANGREN_XUNSHI,
  unlimitedCardUses(state, ownerId, cardId) {
    const owner = player(state, ownerId)
    return Boolean(owner?.alive && cardId && effectiveCardName(state, cardId) === '杀' && effectiveDamageNature(state, cardId) === 'thunder')
  },
  ignoresDistanceTo(state, ownerId, _targetId, cardId) {
    const owner = player(state, ownerId)
    return Boolean(owner?.alive && cardId && effectiveCardName(state, cardId) === '杀' && effectiveDamageNature(state, cardId) === 'thunder')
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId | null; cardName?: string | null; finalAmount?: number }
    const targetId = context.event.targetId
    const target = targetId ? player(host.state, targetId) : undefined
    if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || !payload.cardId
      || effectiveDamageNature(host.state, payload.cardId) !== 'thunder' || Number(payload.finalAmount ?? 0) <= 0 || !target?.alive) return
    const owned = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => id !== null)]
    if (owned.length) discardCardsByIds(host as never, target.id, [host.rng.pick(owned)], ZHANGREN_XUNSHI)
    if (player(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
  } }],
})

type HuoZhongFlow = { shownCardId: CardId; targetIds: PlayerId[]; index: number; turnNumber: number }
function huoZhongTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const range = getAttackRange(state, ownerId)
  return alive(state).filter((entry) => entry.id !== ownerId && getDistance(state, ownerId, entry.id) <= range)
    .sort((left, right) => left.seat - right.seat).map(({ id }) => id)
}
function huoZhongOtherSources(state: SanguoshaState, actorId: PlayerId): PlayerId[] {
  return alive(state).filter((entry) => entry.id !== actorId
    && (pickableCardsOf(state, entry.id).cardIds.length + pickableCardsOf(state, entry.id).hiddenCardSlots.length > 0))
    .sort((left, right) => left.seat - right.seat).map(({ id }) => id)
}
function huoZhongUseCount(state: SanguoshaState, ownerId: PlayerId): number {
  return Number(usedThisPhase(state, ownerId, WEIFENG_HUOZHONG))
    + Number(usedThisPhase(state, ownerId, `${WEIFENG_HUOZHONG}:second`))
}
function markHuoZhongUsed(state: SanguoshaState, ownerId: PlayerId): void {
  markUsedThisPhase(state, ownerId, huoZhongUseCount(state, ownerId) === 0
    ? WEIFENG_HUOZHONG : `${WEIFENG_HUOZHONG}:second`)
}

function finishHuoZhong(host: SkillHost, ownerId: PlayerId, flow: HuoZhongFlow): void {
  const owner = player(host.state, ownerId)
  const shown = card(host.state, flow.shownCardId)
  if (!owner?.alive || !shown) return
  const others = alive(host.state).filter((entry) => entry.id !== ownerId)
  if (!others.length) return
  const maximum = Math.max(...others.map((entry) => entry.zones.hand.length))
  const leaders = others.filter((entry) => entry.zones.hand.length === maximum).sort((left, right) => left.seat - right.seat)
  const placedByPlayer: Array<{ playerId: PlayerId; cardIds: CardId[] }> = []
  for (const leader of leaders) {
    const revealed = [...leader.zones.hand]
    if (revealed.length) host.dispatch('CardMove', { playerId: leader.id, cardIds: revealed, revealed: true, reason: WEIFENG_HUOZHONG },
      { sourceId: ownerId, targetId: leader.id, cardIds: revealed })
    const matching = revealed.filter((id) => card(host.state, id)?.category === shown.category
      && leader.zones.hand.includes(id))
    if (matching.length) placedByPlayer.push({ playerId: leader.id, cardIds: matching })
  }
  const topSequence = placedByPlayer.flatMap(({ cardIds }) => cardIds)
  for (const cardId of [...topSequence].reverse()) {
    const holder = placedByPlayer.find(({ cardIds }) => cardIds.includes(cardId))?.playerId
    if (!holder || !hand(host.state, holder).includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'hand', playerId: holder }, { kind: 'drawPile' }, { toTop: true })
  }
  for (const { playerId, cardIds } of placedByPlayer) {
    const moved = cardIds.filter((id) => host.state.zones.drawPile.includes(id))
    if (!moved.length) continue
    host.dispatch('LoseCard', { playerId, cardIds: moved, reason: WEIFENG_HUOZHONG },
      { sourceId: ownerId, targetId: playerId, cardIds: moved })
  }
}

function queueNextHuoZhongTarget(host: SkillHost, ownerId: PlayerId, flow: HuoZhongFlow): void {
  flow.index += 1
  host.queueSkill({ skillId: WEIFENG_HUOZHONG, ownerId, step: 'resolve-target', data: { flow } })
}

registerSkillRuntime({
  id: WEIFENG_HUOZHONG,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive || state.status !== 'playing' || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || huoZhongUseCount(state, ownerId) >= 2 || !owner.zones.hand.length || !huoZhongTargets(state, ownerId).length) return []
    return [{ id: `${WEIFENG_HUOZHONG}:activate`, kind: 'invoke-skill', playerId: ownerId,
      skillId: WEIFENG_HUOZHONG, cardIds: [], targetIds: [], label: '发动【惑众】' } as LegalAction]
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    if (actionId !== `${WEIFENG_HUOZHONG}:activate` || !owner?.alive || host.state.currentPlayerId !== ownerId
      || host.state.phase !== 'play' || huoZhongUseCount(host.state, ownerId) >= 2 || !owner.zones.hand.length) return
    host.askSkill({ skillId: WEIFENG_HUOZHONG, ownerId, step: 'choose-shown-card', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【惑众】：选择并展示一张手牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'resolve-target') return
    const flow = queued.data.flow as HuoZhongFlow
    if (flow.turnNumber !== host.state.turnNumber || !player(host.state, ownerId)?.alive) return
    while (flow.index < flow.targetIds.length && !player(host.state, flow.targetIds[flow.index]!)?.alive) flow.index += 1
    if (flow.index >= flow.targetIds.length) { finishHuoZhong(host, ownerId, flow); return }
    const actorId = flow.targetIds[flow.index]!
    const giveAvailable = hand(host.state, actorId).length > 0
    const sourceIds = huoZhongOtherSources(host.state, actorId)
    const options = [
      ...(sourceIds.length ? [{ id: 'obtain', label: '获得另一名其他角色的一张牌' }] : []),
      ...(giveAvailable ? [{ id: 'give', label: '交给魏讽一张手牌' }] : []),
    ]
    if (!options.length) { queueNextHuoZhongTarget(host, ownerId, flow); return }
    host.askSkill({ skillId: WEIFENG_HUOZHONG, ownerId, step: 'choose-mode', data: { flow, actorId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: actorId, prompt: '【惑众】：选择一项', timeoutMs: 25_000,
      optional: false, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-shown-card') {
      const shownCardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!shownCardId || !hand(host.state, ownerId).includes(shownCardId) || !huoZhongTargets(host.state, ownerId).length
        || huoZhongUseCount(host.state, ownerId) >= 2) return
      host.dispatch('CardMove', { playerId: ownerId, cardIds: [shownCardId], revealed: true, reason: WEIFENG_HUOZHONG },
        { sourceId: ownerId, targetId: ownerId, cardIds: [shownCardId] })
      host.askSkill({ skillId: WEIFENG_HUOZHONG, ownerId, step: 'choose-targets', data: { shownCardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【惑众】：选择攻击范围内任意名其他角色', timeoutMs: 25_000,
        optional: false, candidateIds: huoZhongTargets(host.state, ownerId), min: 0, max: huoZhongTargets(host.state, ownerId).length,
      }) })
      return
    }
    if (resolution.step === 'choose-targets') {
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const legal = new Set(huoZhongTargets(host.state, ownerId))
      if (new Set(targetIds).size !== targetIds.length || targetIds.some((id) => !legal.has(id))) return
      markHuoZhongUsed(host.state, ownerId)
      const flow: HuoZhongFlow = { shownCardId: resolution.data.shownCardId as CardId,
        targetIds: [...targetIds].sort((a, b) => (player(host.state, a)?.seat ?? 0) - (player(host.state, b)?.seat ?? 0)),
        index: 0, turnNumber: host.state.turnNumber }
      host.queueSkill({ skillId: WEIFENG_HUOZHONG, ownerId, step: 'resolve-target', data: { flow } })
      return
    }
    const { flow, actorId } = resolution.data as { flow: HuoZhongFlow; actorId: PlayerId }
    const actor = player(host.state, actorId)
    if (flow.turnNumber !== host.state.turnNumber || !actor?.alive || !player(host.state, ownerId)?.alive) return
    if (resolution.step === 'choose-mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode === 'give' && hand(host.state, actorId).length) {
        host.askSkill({ skillId: WEIFENG_HUOZHONG, ownerId, step: 'choose-give-card', data: { flow, actorId }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: actorId, prompt: '【惑众】：选择一张手牌交给魏讽', timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: [...hand(host.state, actorId)], hiddenCardSlots: [], min: 1, max: 1,
        }) })
        return
      }
      if (mode === 'obtain') {
        const candidateIds = huoZhongOtherSources(host.state, actorId)
        if (!candidateIds.length) { queueNextHuoZhongTarget(host, ownerId, flow); return }
        host.askSkill({ skillId: WEIFENG_HUOZHONG, ownerId, step: 'choose-source', data: { flow, actorId }, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: actorId, prompt: '【惑众】：选择一名非你角色提供一张牌', timeoutMs: 25_000,
          optional: false, candidateIds, min: 1, max: 1,
        }) })
        return
      }
      return
    }
    if (resolution.step === 'choose-give-card') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!selected || !hand(host.state, actorId).includes(selected)) return
      giveCards(host as never, actorId, ownerId, [selected], WEIFENG_HUOZHONG)
      queueNextHuoZhongTarget(host, ownerId, flow)
      return
    }
    if (resolution.step === 'choose-source') {
      const sourceId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!sourceId || !huoZhongOtherSources(host.state, actorId).includes(sourceId)) return
      const pickable = pickableCardsOf(host.state, sourceId)
      host.askSkill({ skillId: WEIFENG_HUOZHONG, ownerId, step: 'choose-obtained-card', data: { flow, actorId, sourceId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: actorId, prompt: `【惑众】：选择从${player(host.state, sourceId)?.nickname ?? '该角色'}处获得的一张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-obtained-card') {
      const sourceId = resolution.data.sourceId as PlayerId
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const resolved = selected ? resolvePickedCard(host.state, sourceId, selected) : null
      if (!resolved || !huoZhongOtherSources(host.state, actorId).includes(sourceId)
        || !movePickedCard(host as never, sourceId, resolved, { kind: 'hand', playerId: actorId })) return
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: [resolved], reason: WEIFENG_HUOZHONG },
        { sourceId, targetId: actorId, cardIds: [resolved] })
      host.dispatch('GainCard', { playerId: actorId, cardIds: [resolved], reason: WEIFENG_HUOZHONG },
        { sourceId, targetId: actorId, cardIds: [resolved] })
      queueNextHuoZhongTarget(host, ownerId, flow)
    }
  },
})

function claimZhuGuoTrigger(state: SanguoshaState, ownerId: PlayerId): boolean {
  const records = b86(state).zhuguoDrawCount ??= {}
  const previous = records[ownerId] as { turnNumber: number; count: number } | undefined
  const record = previous?.turnNumber === state.turnNumber ? previous : { turnNumber: state.turnNumber, count: 0 }
  if (record.count >= 3) return false
  record.count += 1
  records[ownerId] = record
  return true
}
function drawZhuGuoBottom(host: SkillHost, ownerId: PlayerId): void {
  const depths = b86(host.state).zhuguoBottomDepth ??= {}
  depths[ownerId] = Number(depths[ownerId] ?? 0) + 1
  try { drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload)) }
  finally {
    depths[ownerId] -= 1
    if (depths[ownerId] <= 0) delete depths[ownerId]
  }
}

registerSkillRuntime({
  id: WEIFENG_ZHUGUO,
  drawsFromBottom(state, ownerId) { return Number(b86(state).zhuguoBottomDepth?.[ownerId] ?? 0) > 0 },
  triggers: [
    { event: 'DeckReshuffled', handle(host, ownerId, context) {
      const count = Number((context.event.payload as { count?: number }).count ?? 0)
      if (count > 0 && player(host.state, ownerId)?.alive && claimZhuGuoTrigger(host.state, ownerId))
        drawZhuGuoBottom(host, ownerId)
    } },
    { event: 'CardZoneMoved', handle(host, ownerId, context) {
      const move = context.event.payload as { fromKind?: string; toKind?: string }
      if (!player(host.state, ownerId)?.alive || move.toKind !== 'drawPile' || move.fromKind === 'drawPile'
        || !claimZhuGuoTrigger(host.state, ownerId)) return
      host.queueSkill({ skillId: WEIFENG_ZHUGUO, ownerId, step: 'draw-bottom', data: { turnNumber: host.state.turnNumber } })
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'draw-bottom' && Number(queued.data.turnNumber) === host.state.turnNumber
      && player(host.state, ownerId)?.alive) drawZhuGuoBottom(host, ownerId)
  },
})

type WangZiGainRecord = { actorId: PlayerId; roundNumber: number; phaseTurnNumber: number; cardIds: CardId[] }
function blackDrawPileCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return state.zones.drawPile.filter((id) => effectiveCardColor(state, ownerId, id) === 'black')
}

registerSkillRuntime({
  id: HOU_ZHAONING_WANGZI,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const { playerId: actorId, phase } = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (!actorId || actorId === ownerId || phase !== 'play' || !player(host.state, ownerId)?.alive
        || b86(host.state).wangziUsedRound?.[ownerId] === host.state.roundNumber
        || !blackDrawPileCards(host.state, ownerId).length) return
      const candidateCosts = [...hand(host.state, ownerId), ...Object.values(player(host.state, ownerId)!.zones.equipment).filter((id): id is CardId => id !== null)]
        .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      if (candidateCosts.length) host.queueSkill({ skillId: HOU_ZHAONING_WANGZI, ownerId, step: 'offer', data: {
        actorId, roundNumber: host.state.roundNumber, phaseTurnNumber: host.state.turnNumber,
      } })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const record = b86(host.state).wangziGains?.[ownerId] as WangZiGainRecord | undefined
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      if (!record || record.phaseTurnNumber !== host.state.turnNumber || context.event.sourceId !== record.actorId
        || !player(host.state, ownerId)?.alive || !player(host.state, record.actorId)?.alive) return
      const usedIds = new Set([...(payload.cardId ? [payload.cardId] : []), ...(payload.cardIds ?? [])])
      const matching = record.cardIds.filter((id) => usedIds.has(id))
      if (!matching.length) return
      record.cardIds = record.cardIds.filter((id) => !matching.includes(id))
      for (let index = 0; index < matching.length; index += 1) {
        if (player(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
        if (player(host.state, record.actorId)?.alive) drawCards(host.state, host.rng, record.actorId, 1, (name, data) => host.dispatch(name, data))
      }
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const record = b86(host.state).wangziGains?.[ownerId] as WangZiGainRecord | undefined
      if (phase === 'play' && record && record.actorId === playerId && record.phaseTurnNumber === host.state.turnNumber)
        delete b86(host.state).wangziGains[ownerId]
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'offer') {
      const actorId = queued.data.actorId as PlayerId
      if (!player(host.state, ownerId)?.alive || !player(host.state, actorId)?.alive || actorId === ownerId
        || Number(queued.data.roundNumber) !== host.state.roundNumber || Number(queued.data.phaseTurnNumber) !== host.state.turnNumber
        || b86(host.state).wangziUsedRound?.[ownerId] === host.state.roundNumber) return
      const maximum = Math.min(5, blackDrawPileCards(host.state, ownerId).length,
        [...hand(host.state, ownerId), ...Object.values(player(host.state, ownerId)!.zones.equipment).filter((id): id is CardId => id !== null)]
          .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId)).length)
      if (!maximum) return
      askOption(host, HOU_ZHAONING_WANGZI, ownerId, 'invoke', { ...queued.data, maximum },
        `【望资】：是否弃置至多${maximum}张牌，令${player(host.state, actorId)!.nickname}从牌堆获得等量黑色牌？`,
        [{ id: 'yes', label: '弃牌并令其获得黑牌' }, { id: 'no', label: '不发动' }])
      return
    }
    if (queued.step === 'choose-cost') {
      const maximum = Number(queued.data.maximum)
      const cards = [...hand(host.state, ownerId), ...Object.values(player(host.state, ownerId)?.zones.equipment ?? {}).filter((id): id is CardId => id !== null)]
        .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      if (!player(host.state, ownerId)?.alive || !cards.length || maximum <= 0) return
      host.askSkill({ skillId: HOU_ZHAONING_WANGZI, ownerId, step: 'discard-cost', data: { ...queued.data }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【望资】：弃置至多${maximum}张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: Math.min(maximum, cards.length),
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const actorId = resolution.data.actorId as PlayerId
      const maximum = Math.min(Number(resolution.data.maximum), blackDrawPileCards(host.state, ownerId).length)
      const costs = [...hand(host.state, ownerId), ...Object.values(player(host.state, ownerId)?.zones.equipment ?? {}).filter((id): id is CardId => id !== null)]
        .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      if (!player(host.state, ownerId)?.alive || !player(host.state, actorId)?.alive || !maximum || !costs.length) return
      host.queueSkill({ skillId: HOU_ZHAONING_WANGZI, ownerId, step: 'choose-cost', data: { ...resolution.data, maximum } })
      return
    }
    if (resolution.step !== 'discard-cost') return
    const actorId = resolution.data.actorId as PlayerId
    const owner = player(host.state, ownerId)
    const actor = player(host.state, actorId)
    if (!owner?.alive || !actor?.alive || actorId === ownerId || resolution.data.roundNumber !== host.state.roundNumber
      || resolution.data.phaseTurnNumber !== host.state.turnNumber || b86(host.state).wangziUsedRound?.[ownerId] === host.state.roundNumber) return
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    const allowed = [...hand(host.state, ownerId), ...Object.values(owner.zones.equipment).filter((id): id is CardId => id !== null)]
    const maximum = Math.min(Number(resolution.data.maximum), blackDrawPileCards(host.state, ownerId).length)
    if (selected.length > maximum || selected.some((id) => !allowed.includes(id) || isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))) return
    if (!selected.length) return
    const discarded = discardCardsByIds(host as never, ownerId, selected, HOU_ZHAONING_WANGZI)
    if (discarded.length !== selected.length) return
    const black = blackDrawPileCards(host.state, ownerId)
    if (black.length < discarded.length) return
    const gained = [...black]
    const selectedBlack: CardId[] = []
    for (let index = 0; index < discarded.length; index += 1) {
      const pickIndex = host.rng.nextInt(gained.length)
      selectedBlack.push(gained.splice(pickIndex, 1)[0]!)
    }
    for (const id of selectedBlack) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: actorId })
    b86(host.state).wangziUsedRound ??= {}
    b86(host.state).wangziUsedRound[ownerId] = host.state.roundNumber
    b86(host.state).wangziGains ??= {}
    b86(host.state).wangziGains[ownerId] = { actorId, roundNumber: host.state.roundNumber,
      phaseTurnNumber: host.state.turnNumber, cardIds: selectedBlack } satisfies WangZiGainRecord
    host.dispatch('GainCard', { playerId: actorId, cardIds: selectedBlack, reason: HOU_ZHAONING_WANGZI },
      { sourceId: ownerId, targetId: actorId, cardIds: selectedBlack })
  },
})

type HeRongPrevention = { pending: boolean }
function gainRandomEquipmentCard(host: SkillHost, targetId: PlayerId, sourceSkillId: string): CardId | null {
  const candidates = host.state.zones.drawPile.filter((id) => card(host.state, id)?.category === 'equipment')
  if (!candidates.length || !player(host.state, targetId)?.alive) return null
  const selected = host.rng.pick(candidates)
  moveCard(host.state, selected, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
  host.dispatch('GainCard', { playerId: targetId, cardIds: [selected], reason: sourceSkillId },
    { sourceId: sourceSkillId, targetId, cardIds: [selected] })
  return selected
}

function resolveHeRongDamage(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  if (!player(host.state, ownerId)?.alive || !player(host.state, targetId)?.alive) return
  resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: [targetId], amount: 1,
    nature: 'normal', cardId: null, cardName: null, sourceSkillId: HOU_ZHAONING_HERONG })
}

registerSkillRuntime({
  id: HOU_ZHAONING_HERONG,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive || state.status !== 'playing' || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || usedThisPhase(state, ownerId, HOU_ZHAONING_HERONG) || !owner.zones.hand.length) return []
    const candidates = alive(state).filter((entry) => entry.id !== ownerId && entry.zones.hand.length > 0)
    return candidates.length ? [{ id: `${HOU_ZHAONING_HERONG}:start`, kind: 'invoke-skill', playerId: ownerId,
      skillId: HOU_ZHAONING_HERONG, cardIds: [], targetIds: [], label: '发动【和戎】' } as LegalAction] : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    const candidates = alive(host.state).filter((entry) => entry.id !== ownerId && entry.zones.hand.length > 0)
    if (actionId !== `${HOU_ZHAONING_HERONG}:start` || !owner?.alive || !owner.zones.hand.length
      || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play' || usedThisPhase(host.state, ownerId, HOU_ZHAONING_HERONG)
      || !candidates.length) return
    host.askSkill({ skillId: HOU_ZHAONING_HERONG, ownerId, step: 'choose-target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【和戎】：选择一名有手牌的其他角色', timeoutMs: 25_000,
      optional: true, candidateIds: candidates.map(({ id }) => id), min: 0, max: 1,
    }) })
  },
  incomingDamage(state, ownerId) {
    const record = b86(state).heRongPrevention?.[ownerId] as HeRongPrevention | undefined
    if (!record?.pending) return null
    record.pending = false
    return { amount: 0 }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = player(host.state, ownerId), target = targetId ? player(host.state, targetId) : undefined
      if (!targetId || !owner?.alive || !target?.alive || targetId === ownerId || !owner.zones.hand.length || !target.zones.hand.length
        || usedThisPhase(host.state, ownerId, HOU_ZHAONING_HERONG)) return
      markUsedThisPhase(host.state, ownerId, HOU_ZHAONING_HERONG)
      const hiddenCardSlots = target.zones.hand.map((_, index) => `hidden:${targetId}:${index}`)
      host.askSkill({ skillId: HOU_ZHAONING_HERONG, ownerId, step: 'choose-revealed-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【和戎】：选择${target.nickname}的一张手牌展示`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-revealed-card') {
      const targetId = resolution.data.targetId as PlayerId
      const target = player(host.state, targetId)
      const picked = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const revealedId = target && picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (!target?.alive || !revealedId || !target.zones.hand.includes(revealedId) || !player(host.state, ownerId)?.alive) return
      b86(host.state).heRongSelected ??= {}
      b86(host.state).heRongSelected[ownerId] = revealedId
      host.dispatch('CardMove', { playerId: targetId, cardIds: [revealedId], revealed: true, reason: HOU_ZHAONING_HERONG },
        { sourceId: ownerId, targetId, cardIds: [revealedId] })
      const owner = player(host.state, ownerId)!
      host.askSkill({ skillId: HOU_ZHAONING_HERONG, ownerId, step: 'choose-own-card', data: { targetId, revealedId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【和戎】：选择一张手牌与展示牌交换', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-own-card') {
      const { targetId, revealedId } = resolution.data as { targetId: PlayerId; revealedId: CardId }
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId), target = player(host.state, targetId)
      if (!owner?.alive || !target?.alive || !selected || !owner.zones.hand.includes(selected) || !target.zones.hand.includes(revealedId)
        || b86(host.state).heRongSelected?.[ownerId] !== revealedId) return
      delete b86(host.state).heRongSelected?.[ownerId]
      const sameCategory = card(host.state, selected)?.category === card(host.state, revealedId)?.category
      if (!swapSelectedHandCards(host as never, ownerId, targetId, selected, revealedId, HOU_ZHAONING_HERONG)) return
      if (sameCategory) {
        gainRandomEquipmentCard(host, ownerId, HOU_ZHAONING_HERONG)
        gainRandomEquipmentCard(host, targetId, HOU_ZHAONING_HERONG)
        b86(host.state).heRongPrevention ??= {}
        b86(host.state).heRongPrevention[ownerId] = { pending: true } satisfies HeRongPrevention
        return
      }
      const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
      const total = pickable.cardIds.length + pickable.hiddenCardSlots.length
      const max = Math.min(2, total)
      if (!max) { resolveHeRongDamage(host, ownerId, targetId); return }
      host.askSkill({ skillId: HOU_ZHAONING_HERONG, ownerId, step: 'discard-two', data: { targetId, max }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【和戎】：弃置${target.nickname}${max === 2 ? '两' : '所有'}张牌，然后对其造成1点伤害`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: pickable.cardIds,
        hiddenCardSlots: pickable.hiddenCardSlots, min: max, max,
      }) })
      return
    }
    if (resolution.step === 'discard-two') {
      const targetId = resolution.data.targetId as PlayerId
      const max = Number(resolution.data.max)
      const target = player(host.state, targetId)
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      if (!target?.alive || selected.length !== max || !player(host.state, ownerId)?.alive) return
      const resolved = selected.map((picked) => resolvePickedCard(host.state, targetId, picked))
      if (resolved.some((cardId) => !cardId) || new Set(resolved).size !== resolved.length) return
      for (const cardId of resolved as CardId[]) {
        if (!movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) continue
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: HOU_ZHAONING_HERONG },
          { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
      resolveHeRongDamage(host, ownerId, targetId)
    }
  },
})

registerSkillRuntime({
  id: ZHANGREN_ZHENGONG,
  limited: true,
  globallyInvalidatesSkill(state, ownerId, targetId) {
    const record = b86(state).zhenGongSuppression?.[ownerId] as { turnNumber: number; targetIds: PlayerId[] } | undefined
    return record?.turnNumber === state.turnNumber && record.targetIds.includes(targetId)
  },
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive || state.status !== 'playing' || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || owner.usedLimitedSkills.includes(ZHANGREN_ZHENGONG) || !alive(state).some((entry) => entry.id !== ownerId)) return []
    const ownedIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => id !== null)]
      .filter((id) => !isCardProtectedFromDiscard(state, ownerId, id, ownerId))
    const names = [...new Set(ownedIds.map((id) => card(state, id)?.name).filter((name): name is string => Boolean(name)))]
    return names.map((name) => ({ id: `${ZHANGREN_ZHENGONG}:name:${name}`, kind: 'invoke-skill', playerId: ownerId,
      skillId: ZHANGREN_ZHENGONG, cardIds: [], targetIds: [], label: `发动【震弓】（弃置同名牌：${name}）` } as LegalAction))
  },
  invokeActive(host, ownerId, actionId) {
    const prefix = `${ZHANGREN_ZHENGONG}:name:`
    const name = actionId.startsWith(prefix) ? actionId.slice(prefix.length) : ''
    const owner = player(host.state, ownerId)
    if (!name || !owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || owner.usedLimitedSkills.includes(ZHANGREN_ZHENGONG)) return
    const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => id !== null)]
      .filter((id) => card(host.state, id)?.name === name && !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
    if (!cardIds.length) return
    host.askSkill({ skillId: ZHANGREN_ZHENGONG, ownerId, step: 'choose-cost', data: { name, offered: cardIds }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【震弓】：弃置任意张同名【${name}】`, timeoutMs: 25_000,
      optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: cardIds.length,
    }) })
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== ZHANGREN_ZHENGONG
        || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      const flow = b86(host.state).zhenGongFlows?.[ownerId] as ZhenGongFlow | undefined
      const targetId = context.event.targetId
      if (flow && targetId && !flow.actualTargets.includes(targetId)) flow.actualTargets.push(targetId)
    } },
    { event: 'DamageSequenceResolved', allowDeadOwner: true, handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== ZHANGREN_ZHENGONG) return
      const flow = b86(host.state).zhenGongFlows?.[ownerId] as ZhenGongFlow | undefined
      if (!flow) return
      flow.index += 1
      host.queueSkill({ skillId: ZHANGREN_ZHENGONG, ownerId, step: 'next-damage', data: { ...flow }, allowDeadOwner: true })
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'choose-damage') {
      const cardIds = queued.data.cardIds as CardId[]
      const recipientIds = alive(host.state).filter((entry) => entry.id !== ownerId).map(({ id }) => id)
      if (!player(host.state, ownerId)?.alive || !cardIds.length || !recipientIds.length) return
      host.askSkill({ skillId: ZHANGREN_ZHENGONG, ownerId, step: 'assign-damage', data: { cardIds }, build: (id): DistributeCardsRequest => ({
        id, kind: 'distribute-cards', playerId: ownerId, prompt: `【震弓】：将${cardIds.length}点伤害分配给任意名其他角色`, timeoutMs: 25_000,
        optional: false, cardIds, recipientIds, min: cardIds.length, max: cardIds.length,
      }) })
      return
    }
    if (queued.step === 'next-damage') {
      startZhenGongAssignmentDamage(host, ownerId, queued.data as ZhenGongFlow)
      return
    }
    if (queued.step !== 'finish-damage') return
    const flow = queued.data as ZhenGongFlow
    delete b86(host.state).zhenGongFlows?.[ownerId]
    if (!player(host.state, ownerId)?.alive || !flow.actualTargets.length) return
    b86(host.state).zhenGongSuppression ??= {}
    b86(host.state).zhenGongSuppression[ownerId] = { turnNumber: host.state.turnNumber, targetIds: [...flow.actualTargets] }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-cost') {
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const owner = player(host.state, ownerId)
      const name = String(resolution.data.name ?? '')
      if (!selected.length || !owner?.alive || owner.usedLimitedSkills.includes(ZHANGREN_ZHENGONG)) return
      const valid = selected.filter((id) => (resolution.data.offered as CardId[]).includes(id) && card(host.state, id)?.name === name
        && !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId)
        && ['hand', 'equipment'].includes(locateOwnedCard(host.state, ownerId, id)?.kind ?? ''))
      if (valid.length !== selected.length) return
      const discarded = discardCardsByIds(host as never, ownerId, valid, ZHANGREN_ZHENGONG)
      if (discarded.length !== valid.length) return
      owner.usedLimitedSkills.push(ZHANGREN_ZHENGONG)
      host.dispatch('SkillActivated', { skillId: ZHANGREN_ZHENGONG, skillName: '震弓', playerId: ownerId, cardIds: discarded, damagePoints: discarded.length }, { sourceId: ownerId, cardIds: discarded })
      host.queueSkill({ skillId: ZHANGREN_ZHENGONG, ownerId, step: 'choose-damage', data: { cardIds: discarded }, allowDeadOwner: true })
      return
    }
    if (resolution.step !== 'assign-damage') return
    const assignments = (response.payload as { assignments?: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments ?? []
    const flow: ZhenGongFlow = { cardIds: resolution.data.cardIds as CardId[], assignments, index: 0, actualTargets: [] }
    if (flow.assignments.length !== flow.cardIds.length || new Set(flow.assignments.map((item) => item.cardId)).size !== flow.cardIds.length
      || flow.assignments.some((item) => !flow.cardIds.includes(item.cardId) || !player(host.state, item.recipientId)?.alive || item.recipientId === ownerId)) return
    host.queueSkill({ skillId: ZHANGREN_ZHENGONG, ownerId, step: 'next-damage', data: flow })
  },
})

function renshanUse(state: SanguoshaState, ownerId: PlayerId): { turnNumber: number; count: number } {
  const records = b86(state).renshanUse ??= {}
  const record = records[ownerId] as { turnNumber: number; count: number } | undefined
  if (record?.turnNumber === state.turnNumber) return record
  records[ownerId] = { turnNumber: state.turnNumber, count: 0 }
  return records[ownerId] as { turnNumber: number; count: number }
}

registerSkillRuntime({
  id: LIUZHANG_JUTU,
  offersDamageModifierAsk(host, ownerId, side, context) {
    const owner = player(host.state, ownerId)
    if (side !== 'target' || context.targetId !== ownerId || !owner?.alive || owner.zones.hand.length <= owner.hp) return false
    const redCards = owner.zones.hand.filter((id) => effectiveCardColor(host.state, ownerId, id) === 'red')
    if (!redCards.length) return false
    askOption(host, LIUZHANG_JUTU, ownerId, 'prevent-offer', {
      sourceId: context.sourceId, amount: context.amount, redCards,
    }, '【据土】：是否弃置一张红色手牌防止此伤害？', [{ id: 'yes', label: '弃置并防止伤害' }, { id: 'no', label: '不发动' }])
    return true
  },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const record = context.event.payload as { turnNumber?: number }
    const turnNumber = Number(record.turnNumber ?? host.state.turnNumber)
    const owner = player(host.state, ownerId)
    const wasDamaged = (host.state.damageHistory ?? []).some((entry) => entry.targetId === ownerId && entry.turnNumber === turnNumber)
    if (!owner?.alive || wasDamaged || owner.zones.hand.length > owner.hp) return
    host.queueSkill({ skillId: LIUZHANG_JUTU, ownerId, step: 'offer-end-draw', data: { turnNumber } })
  } }],
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'offer-end-draw') return
    const owner = player(host.state, ownerId)
    const turnNumber = Number(queued.data.turnNumber)
    const wasDamaged = (host.state.damageHistory ?? []).some((entry) => entry.targetId === ownerId && entry.turnNumber === turnNumber)
    if (!owner?.alive || wasDamaged || owner.zones.hand.length > owner.hp || turnNumber !== host.state.turnNumber) return
    askOption(host, LIUZHANG_JUTU, ownerId, 'end-draw', { turnNumber }, '【据土】：本回合未受到伤害且手牌不多于体力，是否摸两张牌？',
      [{ id: 'yes', label: '摸两张牌' }, { id: 'no', label: '不摸牌' }])
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'prevent-offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { resumeDamageModifier(host as never, LIUZHANG_JUTU, 0); return }
      const owner = player(host.state, ownerId)
      const candidates = (resolution.data.redCards as CardId[]).filter((id) => owner?.zones.hand.includes(id)
        && effectiveCardColor(host.state, ownerId, id) === 'red')
      if (!owner || owner.zones.hand.length <= owner.hp || !candidates.length) { resumeDamageModifier(host as never, LIUZHANG_JUTU, 0); return }
      host.askSkill({ skillId: LIUZHANG_JUTU, ownerId, step: 'prevent-cost', data: { amount: resolution.data.amount }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【据土】：弃置一张红色手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'prevent-cost') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId)
      if (!selected || !owner?.alive || owner.zones.hand.length <= owner.hp
        || !owner.zones.hand.includes(selected) || effectiveCardColor(host.state, ownerId, selected) !== 'red'
        || !discardCardsByIds(host as never, ownerId, [selected], LIUZHANG_JUTU).includes(selected)) {
        resumeDamageModifier(host as never, LIUZHANG_JUTU, 0); return
      }
      resumeDamageModifier(host as never, LIUZHANG_JUTU, -Number(resolution.data.amount ?? 1))
      return
    }
    if (resolution.step === 'end-draw' && (response.payload as { optionId?: string }).optionId === 'yes'
      && resolution.data.turnNumber === host.state.turnNumber && player(host.state, ownerId)?.alive
      && !(host.state.damageHistory ?? []).some((entry) => entry.targetId === ownerId && entry.turnNumber === host.state.turnNumber)
      && hand(host.state, ownerId).length <= (player(host.state, ownerId)?.hp ?? 0))
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
  },
})

registerSkillRuntime({
  id: LIUZHANG_RENSHAN,
  triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; reason?: string }
    const gainedPlayerId = payload.playerId ?? context.event.targetId
    const owner = player(host.state, ownerId)
    if (gainedPlayerId !== ownerId || payload.reason === LIUZHANG_RENSHAN || b86(host.state).renshanResolving?.[ownerId]
      || !owner?.alive || renshanUse(host.state, ownerId).count >= owner.hp) return
    host.queueSkill({ skillId: LIUZHANG_RENSHAN, ownerId, step: 'offer', data: { turnNumber: host.state.turnNumber } })
  } }],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'offer') {
      const owner = player(host.state, ownerId)
      if (!owner?.alive || Number(queued.data.turnNumber) !== host.state.turnNumber || renshanUse(host.state, ownerId).count >= owner.hp) return
      const recipients = alive(host.state).filter((entry) => entry.id !== ownerId && entry.zones.hand.length <= owner.zones.hand.length + 1)
      if (recipients.length) askOption(host, LIUZHANG_RENSHAN, ownerId, 'invoke', { turnNumber: host.state.turnNumber },
        '【仁善】：是否摸一张牌并交给一名手牌数不大于你的其他角色一张牌？', [{ id: 'yes', label: '摸牌并交牌' }, { id: 'no', label: '不发动' }])
      return
    }
    if (queued.step !== 'choose-recipient') return
    const owner = player(host.state, ownerId)
    if (!owner?.alive || Number(queued.data.turnNumber) !== host.state.turnNumber || renshanUse(host.state, ownerId).count >= owner.hp) return
    const candidates = alive(host.state).filter((entry) => entry.id !== ownerId && entry.zones.hand.length <= owner.zones.hand.length)
    if (!candidates.length) return
    host.askSkill({ skillId: LIUZHANG_RENSHAN, ownerId, step: 'recipient', data: { turnNumber: host.state.turnNumber }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【仁善】：选择手牌数不大于你的其他角色', timeoutMs: 25_000,
      optional: false, candidateIds: candidates.map(({ id }) => id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = player(host.state, ownerId)
      if (!owner?.alive || resolution.data.turnNumber !== host.state.turnNumber || renshanUse(host.state, ownerId).count >= owner.hp) return
      renshanUse(host.state, ownerId).count += 1
      b86(host.state).renshanResolving ??= {}; b86(host.state).renshanResolving[ownerId] = true
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      delete b86(host.state).renshanResolving[ownerId]
      host.queueSkill({ skillId: LIUZHANG_RENSHAN, ownerId, step: 'choose-recipient', data: { turnNumber: host.state.turnNumber } })
      return
    }
    if (resolution.step === 'recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = player(host.state, ownerId), target = targetId ? player(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.id === ownerId || target.zones.hand.length > owner.zones.hand.length) return
      const cardIds = [...owner.zones.hand]
      if (!cardIds.length) return
      host.askSkill({ skillId: LIUZHANG_RENSHAN, ownerId, step: 'give-card', data: { targetId, turnNumber: host.state.turnNumber }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【仁善】：交给${target.nickname}一张手牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'give-card') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId), target = player(host.state, targetId)
      if (!selected || !owner?.alive || !target?.alive || target.zones.hand.length > owner.zones.hand.length || !owner.zones.hand.includes(selected)) return
      giveCards(host as never, ownerId, targetId, [selected], LIUZHANG_RENSHAN)
    }
  },
})

registerSkillRuntime({
  id: LIUZHANG_YIZHI,
  lord: true,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return owner?.alive && owner.identity === 'lord' && state.status === 'playing' && state.currentPlayerId === ownerId
      && state.phase === 'play' && !usedThisPhase(state, ownerId, LIUZHANG_YIZHI)
      && alive(state).some((entry) => getCharacter(entry.characterId ?? '')?.kingdom === 'qun')
      ? [{ id: `${LIUZHANG_YIZHI}:harvest`, kind: 'invoke-skill', playerId: ownerId, skillId: LIUZHANG_YIZHI,
        cardIds: [], targetIds: [], label: '发动【益治】：对群势力角色使用【五谷丰登】' } as LegalAction]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    if (actionId !== `${LIUZHANG_YIZHI}:harvest` || !owner?.alive || owner.identity !== 'lord'
      || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play' || usedThisPhase(host.state, ownerId, LIUZHANG_YIZHI)) return
    const targetIds = alive(host.state).filter((entry) => getCharacter(entry.characterId ?? '')?.kingdom === 'qun').map(({ id }) => id)
    if (!targetIds.length) return
    if (host.beginVirtualTrick({ sourceId: ownerId, targetIds, cardName: '五谷丰登', sourceSkillId: LIUZHANG_YIZHI }))
      markUsedThisPhase(host.state, ownerId, LIUZHANG_YIZHI)
  },
})

type YuYiTurn = { turnNumber: number; used: { discardDraw: boolean; hpGift: boolean }; slashBonusByActor: Record<string, number> }
function yuYiTurn(state: SanguoshaState, ownerId: PlayerId): YuYiTurn {
  const records = b86(state).yuyiTurn ??= {}
  const old = records[ownerId] as YuYiTurn | undefined
  if (old?.turnNumber === state.turnNumber) return old
  const next: YuYiTurn = { turnNumber: state.turnNumber, used: { discardDraw: false, hpGift: false }, slashBonusByActor: {} }
  records[ownerId] = next
  return next
}

registerSkillRuntime({
  id: WANGPING_YUYI,
  globalSlashUses(state, ownerId, actorId) {
    const record = b86(state).yuyiTurn?.[ownerId] as YuYiTurn | undefined
    return record?.turnNumber === state.turnNumber && state.currentPlayerId === actorId && state.phase === 'play'
      ? Number(record.slashBonusByActor[actorId] ?? 0) : 0
  },
  interceptTarget(host, ownerId, context) {
    const actor = context.sourceId ? player(host.state, context.sourceId) : undefined
    if (!actor?.alive || actor.id === ownerId || context.targetId !== ownerId || !player(host.state, ownerId)?.alive) return false
    const record = yuYiTurn(host.state, ownerId)
    const options = [
      ...(!record.used.discardDraw ? [{ id: 'discard-draw', label: '弃置任意张牌并摸一张，本回合结束时再摸等量张' }] : []),
      ...(!record.used.hpGift ? [{ id: 'hp-gift', label: '失去至多4点体力并令一名角色摸等量张，本回合结束时回复等量体力' }] : []),
    ]
    if (!options.length) return false
    host.askSkill({ skillId: WANGPING_YUYI, ownerId, step: 'choose-effect', data: {
      actorId: actor.id, cardId: context.cardId, turnNumber: host.state.turnNumber,
    }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【诱夷】：选择本回合尚未发动过的一项效果',
      timeoutMs: 25_000, optional: true, options,
    }) })
    return true
  },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const turnNumber = Number((context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber)
    const delayed = b86(host.state).yuyiDelayed?.[ownerId] as { turnNumber: number; draw: number; recover: number } | undefined
    if (delayed?.turnNumber === turnNumber && (delayed.draw || delayed.recover))
      host.queueSkill({ skillId: WANGPING_YUYI, ownerId, step: 'settle-delayed', data: { ...delayed, turnNumber }, allowDeadOwner: true })
  } }],
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'settle-delayed') return
    const pending = b86(host.state).yuyiDelayed?.[ownerId] as { turnNumber: number; draw: number; recover: number } | undefined
    if (!pending || pending.turnNumber !== Number(queued.data.turnNumber)) return
    delete b86(host.state).yuyiDelayed[ownerId]
    if (pending.draw && player(host.state, ownerId)?.alive)
      drawCards(host.state, host.rng, ownerId, pending.draw, (name, payload) => host.dispatch(name, payload))
    if (pending.recover && player(host.state, ownerId)?.alive) recover(host as never, ownerId, pending.recover)
  },
  resume(host, ownerId, resolution, response) {
    const actorId = resolution.data.actorId as PlayerId
    if (resolution.step === 'choose-effect') {
      if (resolution.data.turnNumber !== host.state.turnNumber || !player(host.state, ownerId)?.alive || !player(host.state, actorId)?.alive) {
        host.resumeCardTarget(); return
      }
      const optionId = (response.payload as { optionId?: string }).optionId
      const record = yuYiTurn(host.state, ownerId)
      if (optionId === 'discard-draw' && !record.used.discardDraw) {
        record.slashBonusByActor[actorId] = (record.slashBonusByActor[actorId] ?? 0) + 1
        record.used.discardDraw = true
        const owned = [...hand(host.state, ownerId), ...Object.values(player(host.state, ownerId)!.zones.equipment).filter((id): id is CardId => id !== null)]
          .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
        host.askSkill({ skillId: WANGPING_YUYI, ownerId, step: 'discard-for-draw', data: { actorId, turnNumber: host.state.turnNumber }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【诱夷】：弃置任意张手牌或装备牌', timeoutMs: 25_000,
          optional: true, purpose: 'skill', cardIds: owned, hiddenCardSlots: [], min: 0, max: owned.length,
        }) })
        return
      }
      if (optionId === 'hp-gift' && !record.used.hpGift) {
        record.slashBonusByActor[actorId] = (record.slashBonusByActor[actorId] ?? 0) + 1
        record.used.hpGift = true
      const targets = alive(host.state).map(({ id }) => id)
        host.askSkill({ skillId: WANGPING_YUYI, ownerId, step: 'choose-draw-recipient', data: { actorId, turnNumber: host.state.turnNumber }, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【诱夷】：选择摸牌角色', timeoutMs: 25_000,
          optional: false, candidateIds: targets, min: 1, max: 1,
        }) })
        return
      }
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'discard-for-draw') {
      const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const owner = player(host.state, ownerId)
      const validOwned = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => id !== null)] : []
      if (!owner?.alive || ids.some((id) => !validOwned.includes(id) || isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))) {
        host.resumeCardTarget(); return
      }
      const discarded = ids.length ? discardCardsByIds(host as never, ownerId, ids, WANGPING_YUYI) : []
      if (discarded.length !== ids.length) { host.resumeCardTarget(); return }
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      const delayed = b86(host.state).yuyiDelayed ??= {}
      const pending = (delayed[ownerId] as { turnNumber: number; draw: number; recover: number } | undefined)
      delayed[ownerId] = { turnNumber: Number(resolution.data.turnNumber), draw: (pending?.turnNumber === host.state.turnNumber ? pending.draw : 0) + ids.length,
        recover: pending?.turnNumber === host.state.turnNumber ? pending.recover : 0 }
      b86(host.state).yuyiAccumulated ??= {}
      addFangongProgress(host.state, ownerId, ids.length)
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'choose-draw-recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !player(host.state, targetId)?.alive) { host.resumeCardTarget(); return }
      const owner = player(host.state, ownerId)
      if (!owner?.alive) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: WANGPING_YUYI, ownerId, step: 'choose-hp-loss', data: { actorId, targetId, turnNumber: host.state.turnNumber }, build: (id): ChooseNumberRequest => ({
        id, kind: 'choose-number', playerId: ownerId, prompt: '【诱夷】：选择失去的体力值（1至4）', timeoutMs: 25_000,
        optional: false, min: 1, max: 4,
      }) })
      return
    }
    if (resolution.step === 'choose-hp-loss') {
      const amount = Math.trunc(Number((response.payload as { number?: number }).number))
      const targetId = resolution.data.targetId as PlayerId
      const owner = player(host.state, ownerId), target = player(host.state, targetId)
      if (!owner?.alive || !target?.alive || !Number.isInteger(amount) || amount < 1 || amount > 4) { host.resumeCardTarget(); return }
      loseHp(host as never, ownerId, amount, WANGPING_YUYI)
      if (target.alive) drawCards(host.state, host.rng, targetId, amount, (name, payload) => host.dispatch(name, payload))
      const delayed = b86(host.state).yuyiDelayed ??= {}
      const pending = delayed[ownerId] as { turnNumber: number; draw: number; recover: number } | undefined
      delayed[ownerId] = { turnNumber: Number(resolution.data.turnNumber), draw: pending?.turnNumber === host.state.turnNumber ? pending.draw : 0,
        recover: (pending?.turnNumber === host.state.turnNumber ? pending.recover : 0) + amount }
      addFangongProgress(host.state, ownerId, amount)
      host.resumeCardTarget()
    }
  },
})

function addFangongProgress(state: SanguoshaState, ownerId: PlayerId, amount: number): void {
  if (!amount) return
  const accumulators = b86(state).fangongProgress ??= {}
  let remaining = Number(accumulators[ownerId] ?? 0) + amount
  while (remaining >= 7) {
    remaining -= 7
    const owner = player(state, ownerId)
    if (owner) owner.usedLimitedSkills = owner.usedLimitedSkills.filter((skillId) => skillId !== WANGPING_FANGONG)
  }
  accumulators[ownerId] = remaining
}

registerSkillRuntime({
  id: WANGPING_FANGONG,
  limited: true,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return owner?.alive && state.status === 'playing' && state.currentPlayerId === ownerId && state.phase === 'play'
      && !owner.usedLimitedSkills.includes(WANGPING_FANGONG)
      ? [{ id: `${WANGPING_FANGONG}:activate`, kind: 'invoke-skill', playerId: ownerId, skillId: WANGPING_FANGONG,
        cardIds: [], targetIds: [], label: '发动【返攻】：回复至体力上限并摸五张牌' } as LegalAction] : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    if (actionId !== `${WANGPING_FANGONG}:activate` || !owner?.alive || host.state.currentPlayerId !== ownerId
      || host.state.phase !== 'play' || owner.usedLimitedSkills.includes(WANGPING_FANGONG)) return
    owner.usedLimitedSkills.push(WANGPING_FANGONG)
    recover(host as never, ownerId, Math.max(0, owner.maxHp - owner.hp))
    drawCards(host.state, host.rng, ownerId, 5, (name, payload) => host.dispatch(name, payload))
  },
})

type JuXiTurn = { turnNumber: number; usedNames: string[] }
function juXiTurn(state: SanguoshaState, ownerId: PlayerId): JuXiTurn {
  const records = b86(state).juxiUse ??= {}
  const record = records[ownerId] as JuXiTurn | undefined
  if (record?.turnNumber === state.turnNumber) return record
  records[ownerId] = { turnNumber: state.turnNumber, usedNames: [] }
  return records[ownerId] as JuXiTurn
}

function juXiDamageOptions(state: SanguoshaState, ownerId: PlayerId, name: string): Array<{ targetIds: PlayerId[]; label: string }> {
  const owner = player(state, ownerId)
  if (!owner?.alive) return []
  if (name === '杀') return canUseSlash(state, ownerId, false)
    ? alive(state).filter((target) => target.id !== ownerId && canTarget(state, ownerId, target.id)
      && !isTargetProhibited(state, ownerId, target.id, name, skillIdsOf)).map((target) => ({ targetIds: [target.id], label: `对${target.nickname}使用【杀】` }))
    : []
  if (!DAMAGE_TRICKS.has(name)) return []
  const probeId = `probe:${GONGSUN_JUXI}:${ownerId}:${state.seq}:${name}`
  state.cards[probeId] = { id: probeId, ruleset: state.rulesetVersion, expansion: 'standard', name,
    suit: 'spade', rank: 1, color: 'black', category: 'trick', virtual: true }
  try {
    return instantTrickActions(state, ownerId, probeId, name).filter((action) => action.kind === 'use-card')
      .map((action) => ({ targetIds: action.targetIds, label: action.label }))
  } finally { delete state.cards[probeId] }
}

function juXiHasUsableHandDamage(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = player(state, ownerId)
  if (!owner) return false
  return owner.zones.hand.some((cardId) => {
    const physical = card(state, cardId)
    if (!physical || damageCardCategory(state, { cardId }) !== 'basic' && damageCardCategory(state, { cardId }) !== 'trick') return false
    const name = effectiveCardName(state, cardId)
    if (name === '杀') return canUseSlash(state, ownerId, false) && alive(state).some((target) => target.id !== ownerId
      && canTarget(state, ownerId, target.id, undefined, cardId) && !isTargetProhibited(state, ownerId, target.id, name, skillIdsOf, cardId))
    return DAMAGE_TRICKS.has(name) && instantTrickActions(state, ownerId, cardId, name).length > 0
  })
}

registerSkillRuntime({
  id: GONGSUN_JUXI,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive || state.status !== 'playing' || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || juXiHasUsableHandDamage(state, ownerId)) return []
    const record = juXiTurn(state, ownerId)
    return ['杀', ...DAMAGE_TRICKS].filter((name) => !record.usedNames.includes(name) && juXiDamageOptions(state, ownerId, name).length > 0)
      .map((name) => ({ id: `${GONGSUN_JUXI}:use:${encodeURIComponent(name)}`, kind: 'invoke-skill' as const, playerId: ownerId,
        skillId: GONGSUN_JUXI, cardIds: [], targetIds: [], label: `发动【举袭】：视为使用【${name}】` }))
  },
  invokeActive(host, ownerId, actionId) {
    const prefix = `${GONGSUN_JUXI}:use:`
    if (!actionId.startsWith(prefix) || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
      || juXiHasUsableHandDamage(host.state, ownerId)) return
    const name = decodeURIComponent(actionId.slice(prefix.length))
    const options = juXiDamageOptions(host.state, ownerId, name)
    if (!options.length || juXiTurn(host.state, ownerId).usedNames.includes(name)) return
    host.askSkill({ skillId: GONGSUN_JUXI, ownerId, step: 'choose-targets', data: {
      name, turnNumber: host.state.turnNumber, options,
    }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【举袭】：选择【${name}】的目标`, timeoutMs: 25_000,
      optional: true, options: options.map((option, index) => ({ id: String(index), label: option.label })),
    }) })
  },
  triggers: [{ event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    if (host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const physical = cardId ? card(host.state, cardId) : undefined
    if (!physical || physical.virtual) return
    const record = juXiTurn(host.state, ownerId)
    const name = effectiveCardName(host.state, physical.id)
    record.usedNames = record.usedNames.filter((usedName) => usedName !== name)
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-targets' || resolution.data.turnNumber !== host.state.turnNumber
      || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play' || juXiHasUsableHandDamage(host.state, ownerId)) return
    const index = Number((response.payload as { optionId?: string }).optionId)
    const name = String(resolution.data.name ?? '')
    const saved = (resolution.data.options as Array<{ targetIds: PlayerId[]; label: string }>)[index]
    const current = juXiDamageOptions(host.state, ownerId, name).find((option) => option.targetIds.join('|') === saved?.targetIds.join('|'))
    if (!saved || !current || juXiTurn(host.state, ownerId).usedNames.includes(name)) return
    const used = name === '杀'
      ? host.beginVirtualSlash({ sourceId: ownerId, targetIds: current.targetIds, sourceSkillId: GONGSUN_JUXI, countUsage: true })
      : host.beginVirtualTrick({ sourceId: ownerId, targetIds: current.targetIds, cardName: name, sourceSkillId: GONGSUN_JUXI })
    if (used) juXiTurn(host.state, ownerId).usedNames.push(name)
  },
})

type ZhuTaoTurn = { turnNumber: number; lastWasBlack: boolean; selectedTargets: PlayerId[] }
function zhuTaoTurn(state: SanguoshaState, ownerId: PlayerId): ZhuTaoTurn {
  const records = b86(state).zhutaoTurn ??= {}
  const previous = records[ownerId] as ZhuTaoTurn | undefined
  if (previous?.turnNumber === state.turnNumber) return previous
  const next: ZhuTaoTurn = { turnNumber: state.turnNumber, lastWasBlack: false, selectedTargets: [] }
  records[ownerId] = next
  return next
}

registerSkillRuntime({
  id: GONGSUN_ZHUTAO,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || !player(host.state, ownerId)?.alive) return
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; cardName?: string }
      const ids = payload.cardIds?.length ? payload.cardIds : (payload.cardId ? [payload.cardId] : context.event.cardIds ?? [])
      const isBlack = ids.some((id) => effectiveCardColor(host.state, ownerId, id) === 'black')
      const isDamage = payload.cardName === '杀' || DAMAGE_TRICKS.has(payload.cardName ?? '')
      const record = zhuTaoTurn(host.state, ownerId)
      const completedCombo = record.lastWasBlack && isDamage
      record.lastWasBlack = isBlack
      if (completedCombo && alive(host.state).some((entry) => entry.id !== ownerId && !record.selectedTargets.includes(entry.id)))
        host.queueSkill({ skillId: GONGSUN_ZHUTAO, ownerId, step: 'choose-target', data: { turnNumber: host.state.turnNumber } })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const record = b86(host.state).zhutaoTurn?.[ownerId] as ZhuTaoTurn | undefined
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; cardName?: string; targetIds?: PlayerId[] }
      const sourceId = context.event.sourceId
      const usedCardId = payload.cardId ?? payload.cardIds?.[0] ?? context.event.cardIds?.[0]
      if (!record || record.turnNumber !== host.state.turnNumber || sourceId !== ownerId || !usedCardId) return
      const isDamage = payload.cardName === '杀' || DAMAGE_TRICKS.has(payload.cardName ?? '')
      const isBlack = effectiveCardColor(host.state, ownerId, usedCardId) === 'black'
      const max = Number(isDamage) + Number(isBlack)
      if (!max) return
      for (const targetId of record.selectedTargets) {
        if (!(payload.targetIds ?? []).includes(targetId) || !player(host.state, targetId)?.alive) continue
        const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
        const count = Math.min(max, pickable.cardIds.length + pickable.hiddenCardSlots.length)
        if (count) host.queueSkill({ skillId: GONGSUN_ZHUTAO, ownerId, step: 'discard-target', data: {
          targetId, max: count, turnNumber: host.state.turnNumber,
        } })
      }
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (Number(queued.data.turnNumber) !== host.state.turnNumber || !player(host.state, ownerId)?.alive) return
    if (queued.step === 'choose-target') {
      const record = zhuTaoTurn(host.state, ownerId)
      const candidates = alive(host.state).filter((entry) => entry.id !== ownerId && !record.selectedTargets.includes(entry.id))
      if (!candidates.length) return
      host.askSkill({ skillId: GONGSUN_ZHUTAO, ownerId, step: 'select-target', data: { turnNumber: host.state.turnNumber }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【追讨】：选择本回合尚未选择过的一名其他角色，摸两张牌并令你与其距离为1',
        timeoutMs: 25_000, optional: true, candidateIds: candidates.map(({ id }) => id), min: 0, max: 1,
      }) })
      return
    }
    if (queued.step !== 'discard-target') return
    const targetId = queued.data.targetId as PlayerId
    const target = player(host.state, targetId)
    const record = b86(host.state).zhutaoTurn?.[ownerId] as ZhuTaoTurn | undefined
    if (!target?.alive || !record?.selectedTargets.includes(targetId)) return
    const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
    const max = Math.min(Number(queued.data.max), pickable.cardIds.length + pickable.hiddenCardSlots.length)
    if (!max) return
    host.askSkill({ skillId: GONGSUN_ZHUTAO, ownerId, step: 'choose-discard', data: { targetId, max, turnNumber: host.state.turnNumber }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【追讨】：可弃置${target.nickname}至多${max}张牌`, timeoutMs: 25_000,
      optional: true, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 0, max,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (Number(resolution.data.turnNumber) !== host.state.turnNumber || !player(host.state, ownerId)?.alive) return
    if (resolution.step === 'select-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const record = zhuTaoTurn(host.state, ownerId)
      if (!player(host.state, targetId)?.alive || targetId === ownerId || record.selectedTargets.includes(targetId)) return
      record.selectedTargets.push(targetId)
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      const distanceRecord = { fromId: ownerId, toId: targetId, distance: 1, sourceSkillId: GONGSUN_ZHUTAO }
      const reverseRecord = { fromId: targetId, toId: ownerId, distance: 1, sourceSkillId: GONGSUN_ZHUTAO }
      const overrides = (host.state.distanceOverrides ??= [])
      for (const entry of [distanceRecord, reverseRecord]) {
        const index = overrides.findIndex((candidate) => candidate.fromId === entry.fromId && candidate.toId === entry.toId)
        if (index >= 0) overrides.splice(index, 1)
        overrides.push(entry)
      }
      return
    }
    if (resolution.step !== 'choose-discard') return
    const targetId = resolution.data.targetId as PlayerId
    const target = player(host.state, targetId)
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    const max = Number(resolution.data.max)
    if (!target?.alive || selected.length > max) return
    const resolved = selected.map((picked) => resolvePickedCard(host.state, targetId, picked))
    if (resolved.some((id) => !id) || new Set(resolved).size !== resolved.length) return
    for (const id of resolved as CardId[]) {
      if (!movePickedCard(host as never, targetId, id, { kind: 'discardPile' })) continue
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [id], reason: GONGSUN_ZHUTAO }, { sourceId: ownerId, targetId, cardIds: [id] })
    }
  },
})

type XianLueRecord = { ranks: number[]; pointLimit: number; targetUses: PlayerId[]; turnNumber: number }
function xianLueRecord(state: SanguoshaState, ownerId: PlayerId): XianLueRecord {
  const records = b86(state).xianlueRecord ??= {}
  const existing = records[ownerId] as XianLueRecord | undefined
  if (existing) {
    if (existing.turnNumber !== state.turnNumber) {
      existing.turnNumber = state.turnNumber
      existing.targetUses = []
    }
    return existing
  }
  const record: XianLueRecord = { ranks: [], pointLimit: 13, targetUses: [], turnNumber: state.turnNumber }
  records[ownerId] = record
  return record
}

function xianLueReset(state: SanguoshaState, ownerId: PlayerId): void {
  delete b86(state).xianlueRecord?.[ownerId]
  const owner = player(state, ownerId)
  if (owner) owner.usedLimitedSkills = owner.usedLimitedSkills.filter((id) => id !== ZHANGFEI_HAOXIAN)
}

function xianLueCanRecord(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean {
  const record = xianLueRecord(state, ownerId)
  if (record.turnNumber !== state.turnNumber || record.targetUses.includes(targetId)) return false
  if ((state.damageHistory ?? []).some((entry) => entry.targetId === targetId && entry.turnNumber === state.turnNumber)) return true
  return b86(state).zhangfeiLostThisTurn?.[targetId] === state.turnNumber
}

function applyXianLueRankResults(host: SkillHost, ownerId: PlayerId, newRanks: number[]): void {
  const record = xianLueRecord(host.state, ownerId)
  const before = record.ranks.length
  record.ranks = [...new Set([...record.ranks, ...newRanks.filter((rank) => Number.isInteger(rank) && rank >= 1 && rank <= 13)])].sort((a, b) => a - b)
  const after = record.ranks.length
  if (after <= before) return
  const crossed = [3, 6, 9].filter((threshold) => before <= threshold && after > threshold).length
  if (crossed) drawCards(host.state, host.rng, ownerId, crossed * 3, (name, payload) => host.dispatch(name, payload))
  if (after >= record.pointLimit) xianLueReset(host.state, ownerId)
}

function reduceXianLuePointLimit(state: SanguoshaState, ownerId: PlayerId): void {
  const record = b86(state).xianlueRecord?.[ownerId] as XianLueRecord | undefined
  if (!record || record.turnNumber !== state.turnNumber) return
  record.pointLimit = Math.max(0, record.pointLimit - 3)
  if (record.ranks.length >= record.pointLimit) xianLueReset(state, ownerId)
}

function zhangfeiOtherCardMovement(host: SkillHost, ownerId: PlayerId, targetId: PlayerId | undefined, cardIds: CardId[]): void {
  const target = targetId ? player(host.state, targetId) : undefined
  if (!target?.alive || target.id === ownerId || !player(host.state, ownerId)?.alive) return
  const count = Math.min(cardIds.length, Math.max(0, target.hp))
  if (!count) return
  host.queueSkill({ skillId: ZHANGFEI_ZISHENG, ownerId, step: 'damage-card-move', data: {
    targetId, amount: count, turnNumber: host.state.turnNumber,
  } })
}

registerSkillRuntime({
  id: ZHANGFEI_ZISHENG,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardIds?: CardId[]; cardId?: CardId }
      const materialIds = [...new Set([...(payload.cardIds ?? []), ...(payload.cardId ? [payload.cardId] : []), ...(context.event.cardIds ?? [])])]
        .filter((id) => !card(host.state, id)?.virtual)
      if (!materialIds.length) return
      const sum = materialIds.reduce((total, id) => total + (ruleCardNumber(host.state, id) ?? 0), 0)
      if (sum <= 3 || sum % 3 !== 0) return
      host.queueSkill({ skillId: ZHANGFEI_ZISHENG, ownerId, step: 'choose-rank-three', data: { turnNumber: host.state.turnNumber } })
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (context.event.sourceId === ownerId && context.event.targetId && context.event.targetId !== ownerId
        && payload.playerId === context.event.targetId && payload.cardIds?.length)
        zhangfeiOtherCardMovement(host, ownerId, context.event.targetId, payload.cardIds)
    } },
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId === ownerId && context.event.targetId === ownerId && context.event.sourceId
        && context.event.sourceId !== ownerId && payload.cardIds?.length)
        zhangfeiOtherCardMovement(host, ownerId, context.event.sourceId, payload.cardIds)
    } },
    { event: 'CardGiven', handle(host, ownerId, context) {
      const payload = context.event.payload as { fromId?: PlayerId; toId?: PlayerId; cardIds?: CardId[] }
      if (payload.toId === ownerId && payload.fromId && payload.fromId !== ownerId && payload.cardIds?.length)
        zhangfeiOtherCardMovement(host, ownerId, payload.fromId, payload.cardIds)
    } },
    { event: 'CardMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { mode?: string; cardId?: CardId }
      if (context.event.sourceId !== ownerId || !context.event.targetId || context.event.targetId === ownerId || !payload.cardId) return
      if (payload.mode === 'discard' || payload.mode === 'steal')
        zhangfeiOtherCardMovement(host, ownerId, context.event.targetId, [payload.cardId])
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (!player(host.state, ownerId)?.alive) return
    if (queued.step === 'damage-card-move') {
      if (Number(queued.data.turnNumber) !== host.state.turnNumber) return
      const targetId = queued.data.targetId as PlayerId
      const target = player(host.state, targetId)
      if (!target?.alive) return
      resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: [targetId],
        amount: Math.min(Number(queued.data.amount), target.hp), nature: 'normal', cardId: null, cardName: null,
        sourceSkillId: ZHANGFEI_ZISHENG })
      return
    }
    if (queued.step !== 'choose-rank-three' || Number(queued.data.turnNumber) !== host.state.turnNumber) return
    const candidates = host.rng.shuffle(host.state.zones.drawPile.filter((id) => ruleCardNumber(host.state, id) === 3)).slice(0, 3)
    if (!candidates.length) return
    for (const id of candidates) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'processingArea' })
    host.askSkill({ skillId: ZHANGFEI_ZISHENG, ownerId, step: 'choose-rank-three', data: { candidates }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【恣胜】：从随机亮出的点数为3的牌中选择一张获得',
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-rank-three' || !player(host.state, ownerId)?.alive) return
    const candidates = resolution.data.candidates as CardId[]
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!selected || !candidates.includes(selected) || !host.state.zones.processingArea.includes(selected)) return
    for (const id of candidates) {
      if (!host.state.zones.processingArea.includes(id)) continue
      if (id === selected) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      else moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'drawPile' })
    }
    const returned = candidates.filter((id) => id !== selected && host.state.zones.drawPile.includes(id))
    if (returned.length) host.state.zones.drawPile = host.rng.shuffle(host.state.zones.drawPile)
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: ZHANGFEI_ZISHENG }, { targetId: ownerId, cardIds: [selected] })
  },
})

registerSkillRuntime({
  id: ZHANGFEI_XIANLUE,
  triggers: [
    { event: 'LoseCard', handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId) { b86(host.state).zhangfeiLostThisTurn ??= {}; b86(host.state).zhangfeiLostThisTurn[payload.playerId] = host.state.turnNumber }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      const amount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      if (context.event.sourceId === ownerId && targetId && targetId !== ownerId && amount > 0
        && host.state.dying?.playerId === targetId) reduceXianLuePointLimit(host.state, ownerId)
    } },
  ],
  activeActions(state, ownerId) {
    if (!player(state, ownerId)?.alive || state.status !== 'playing' || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const candidates = alive(state).filter((entry) => entry.id !== ownerId && xianLueCanRecord(state, ownerId, entry.id))
    return candidates.length ? [{ id: `${ZHANGFEI_XIANLUE}:record`, kind: 'invoke-skill', playerId: ownerId,
      skillId: ZHANGFEI_XIANLUE, cardIds: [], targetIds: [], label: '发动【显略】：记录一名本回合受伤或失牌角色的手牌点数' } as LegalAction] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${ZHANGFEI_XIANLUE}:record` || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    const candidates = alive(host.state).filter((entry) => entry.id !== ownerId && xianLueCanRecord(host.state, ownerId, entry.id))
    if (!candidates.length) return
    host.askSkill({ skillId: ZHANGFEI_XIANLUE, ownerId, step: 'choose-target', data: { turnNumber: host.state.turnNumber }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【显略】：选择本回合受伤或失去过牌且本阶段未选过的角色',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map(({ id }) => id), min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      if (resolution.data.turnNumber !== host.state.turnNumber || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!target?.alive || target.id === ownerId || !xianLueCanRecord(host.state, ownerId, target.id)) return
      const record = xianLueRecord(host.state, ownerId)
      record.targetUses.push(target.id)
      const visibleIds = [...target.zones.hand]
      host.askSkill({ skillId: ZHANGFEI_XIANLUE, ownerId, step: 'view-hand', data: {
        turnNumber: host.state.turnNumber, targetId: target.id,
        ranks: visibleIds.map((id) => ruleCardNumber(host.state, id)).filter((rank): rank is number => rank !== null),
      }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【显略】：观看${target.nickname}的手牌（确认后记录其中尚未记录的点数）`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [], viewOnlyCardIds: visibleIds, hiddenCardSlots: [], min: 0, max: 0,
      }) })
      return
    }
    if (resolution.step === 'view-hand') {
      if (resolution.data.turnNumber !== host.state.turnNumber || !player(host.state, ownerId)?.alive) return
      applyXianLueRankResults(host, ownerId, resolution.data.ranks as number[])
    }
  },
})

registerSkillRuntime({
  id: ZHANGFEI_HAOXIAN,
  limited: true,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    const hasRankThree = state.zones.discardPile.some((id) => ruleCardNumber(state, id) === 3)
      || alive(state).some((entry) => entry.id !== ownerId && entry.zones.hand.some((id) => ruleCardNumber(state, id) === 3))
    return owner?.alive && state.status === 'playing' && state.currentPlayerId === ownerId && state.phase === 'play'
      && !owner.usedLimitedSkills.includes(ZHANGFEI_HAOXIAN) && hasRankThree
      ? [{ id: `${ZHANGFEI_HAOXIAN}:activate`, kind: 'invoke-skill', playerId: ownerId, skillId: ZHANGFEI_HAOXIAN,
        cardIds: [], targetIds: [], label: '发动【豪贤】：将弃牌堆点数为3的牌洗入牌堆并获得其他角色手牌中的点数为3的牌' } as LegalAction] : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    if (actionId !== `${ZHANGFEI_HAOXIAN}:activate` || !owner?.alive || host.state.currentPlayerId !== ownerId
      || host.state.phase !== 'play' || owner.usedLimitedSkills.includes(ZHANGFEI_HAOXIAN)) return
    const recycled = host.state.zones.discardPile.filter((id) => ruleCardNumber(host.state, id) === 3)
    const gathered = alive(host.state).filter((entry) => entry.id !== ownerId)
      .map((entry) => ({ player: entry, ids: entry.zones.hand.filter((id) => ruleCardNumber(host.state, id) === 3) }))
      .filter((entry) => entry.ids.length)
    if (!recycled.length && !gathered.length) return
    owner.usedLimitedSkills.push(ZHANGFEI_HAOXIAN)
    for (const id of recycled) moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'drawPile' })
    if (recycled.length) host.state.zones.drawPile = host.rng.shuffle(host.state.zones.drawPile)
    for (const entry of gathered) {
      const moved: CardId[] = []
      for (const id of entry.ids) {
        if (!entry.player.zones.hand.includes(id)) continue
        moveCard(host.state, id, { kind: 'hand', playerId: entry.player.id }, { kind: 'hand', playerId: ownerId })
        moved.push(id)
      }
      if (moved.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: moved, reason: ZHANGFEI_HAOXIAN },
        { sourceId: entry.player.id, targetId: ownerId, cardIds: moved })
    }
    host.dispatch('SkillActivated', { skillId: ZHANGFEI_HAOXIAN, skillName: '豪贤', playerId: ownerId, recycledCardIds: recycled })
  },
})

export const HISTORICAL_BATCH86_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'liu-yijun-b86', name: '刘懿君', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: LIUYI_DULU, name: '妒戮', description: '出牌阶段限一次，你可以对任意名本回合对你使用过牌的其他角色各造成1点伤害并随机弃置其1张手牌，然后直到你的下个回合结束，这些角色进入濒死状态时，你获得其所有黑色牌。' },
    { id: LIUYI_FUJI, name: '缚己', description: '每轮限一次，其他角色出牌阶段开始时，你可令其观看你的手牌。如若此做，本回合结束时你回复1点体力并摸3张牌，且本轮你成为其他角色使用牌的目标时，你可将所有手牌交给一名其他角色并令此牌无效。' },
  ] },
  { id: 'mou-wuyi-b86', name: '谋·吴懿', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: WUYI_SHIBIAN, name: '识变', description: '每轮开始时，你可选择一名其他角色，本轮其攻击范围内的角色视为在你的攻击范围内，且你使用〖杀〗与普通锦囊牌可指定其攻击范围内的1名角色为额外目标。' },
    { id: WUYI_BIBU, name: '庇部', description: '你的上家和下家每回合首次成为其他角色使用的〖杀〗或普通锦囊牌的唯一目标时，你可摸1张牌并令此牌的目标改为你；你的上家和下家每回合首次使用〖杀〗或普通锦囊牌结算完毕后，你可摸1张牌，然后可视为使用此牌。' },
  ] },
  { id: 'xing-zhangsong-b86', name: '星·张松', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANGSONG_XISONG, name: '悉诵', description: '每轮限一次，其他角色的出牌阶段开始时，你可观看其手牌，若如此做，此阶段结束时你声明一个类别、花色和点数并展示其手牌。若其中有完全符合你声明的牌，此技能视为未发动过，然后其弃置此牌，若你能使用则使用之。' },
    { id: ZHANGSONG_FANGLANG, name: '放浪', description: '摸牌阶段结束时，你可以展示一张此阶段摸到的牌，然后直到你的下回合开始，除展示的牌之外，你每回合使用或打出第一张牌时，你摸X张牌（X为此牌与展示牌的类别、花色、点数相同的项数）。结束阶段，你可以弃置一张牌，然后你获得弃牌堆中与此牌类别、点数、花色相同的牌各一张牌。' },
  ] },
  { id: 'mou-zhangren-b86', name: '谋·张任', kingdom: 'qun', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: ZHANGREN_SHEDAO, name: '慑道', description: '你的回合内，其他角色的牌进入弃牌堆时，你可以选择一项：1.获得其中任意张红色牌并弃置一张黑色牌，然后本回合这些牌不计入手牌上限；2.获得其中的〖杀〗并视为雷〖杀〗直到离开你的手牌。' },
    { id: ZHANGREN_XUNSHI, name: '迅矢', locked: true, description: '锁定技，你使用的雷〖杀〗无距离和次数限制，且造成伤害后受伤角色随机弃置一张牌，然后你摸两张牌。' },
    { id: ZHANGREN_ZHENGONG, name: '震弓', description: '限定技，出牌阶段，你可以弃置任意张同名牌，然后对任意名其他角色造成共计与弃牌数等量的伤害，因此受到伤害的角色本回合非锁定技失效。' },
  ] },
  { id: 'hou-zhaoning-b86', name: '侯昭宁', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: HOU_ZHAONING_WANGZI, name: '望资', description: '每轮限一次，其他角色的出牌阶段开始时，你可弃置至多5张牌，令其从牌堆获得等量黑色牌，此阶段其使用这些牌后你与其各摸1张牌。' },
    { id: HOU_ZHAONING_HERONG, name: '和戎', description: '出牌阶段限一次，你可展示一名其他角色的1张手牌，然后你选择1张手牌与其交换，若这两张牌：1.类型相同，你与其各从牌堆获得1张装备牌，防止你下次受到的伤害；2.类型不同，你弃置其2张牌，然后你对其造成1点伤害。' },
  ] },
  { id: 'wei-gongsunzan-b86', name: '威·公孙瓒', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: GONGSUN_JUXI, name: '举袭', description: '出牌阶段限一次，若你手牌中无可使用的伤害牌，你可视为使用一张本回合未以此法使用过的伤害牌，若本阶段此牌名进入弃牌堆，此技能可再次发动。' },
    { id: GONGSUN_ZHUTAO, name: '追讨', description: '连招技（黑色牌+伤害牌），你可选择一名本回合未以此法选择过的其他角色并摸2张牌，本回合你与其计算距离为1，你对其使用伤害牌或黑色牌结算后，每满足一项可弃置其一张牌。' },
  ] },
  { id: 'weifeng-b86', name: '魏讽', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: WEIFENG_HUOZHONG, name: '惑众', description: '出牌阶段限两次，你可以展示一张手牌并选择攻击范围内任意名其他角色，这些角色依次选择一项：1.获得一名不为其与你的角色一张牌；2.交给你一张手牌。全部结算后，手牌数最多的其他角色展示手牌并将所有与你展示牌类型相同的牌置入牌堆顶。' },
    { id: WEIFENG_ZHUGUO, name: '蛀国', locked: true, description: '锁定技，每回合限三次，牌堆牌数量增加后，你从牌堆底摸两张牌。' },
  ] },
  { id: 'mou-liuzhang-b86', name: '谋·刘璋', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: LIUZHANG_JUTU, name: '据土', description: '若你手牌数大于体力值，当你受到伤害时，你可以弃置一张红色牌防止该伤害。每回合结束时，若你本回合未受到过伤害且手牌数小于等于体力值，你可以摸两张牌。' },
    { id: LIUZHANG_RENSHAN, name: '仁善', description: '每回合限X次，你不以此法获得牌后，你可以摸一张牌并交给一名手牌数不大于你的其他角色一张牌（X为你的体力值）。' },
    { id: LIUZHANG_YIZHI, name: '益治', description: '主公技，出牌阶段限一次，你可以视为对群势力角色使用一张〖五谷丰登〗。' },
  ] },
  { id: 'wu-zhangfei-b86', name: '武张飞', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHANGFEI_ZISHENG, name: '恣胜', description: '你使用点数大于3且为3的倍数的牌时（同时使用多张牌时点数相加），可从牌堆中随机三张点数为3的牌，选择其中一张获得；你弃置或获得其他角色牌时，可对该角色造成与弃置或获得牌数相等的伤害（不超过该角色当前体力值）。' },
    { id: ZHANGFEI_XIANLUE, name: '显略', description: '出牌阶段每名角色限一次，你可以观看本回合受到过伤害或失去过牌的一名其他角色的手牌并记录其中所有尚未记录的点数。当本次记录点数的数量首次超过3、6、9时，你摸三张牌。若已因此记录了所有点数，则清除记录且“豪贤”视为未发动过。你每次造成伤害令其他角色进入濒死状态后，本次记录点数上限减少3个。' },
    { id: ZHANGFEI_HAOXIAN, name: '豪贤', description: '限定技，出牌阶段，你可以将弃牌堆中所有点数为3的牌洗入牌库，然后获得其他角色手牌中点数为3的牌。' },
  ] },
  { id: 'mou-wangping-b86', name: '谋·王平', kingdom: 'shu', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: WANGPING_YUYI, name: '诱夷', description: '每回合每项限一次，你成为其他角色使用的牌的目标时，你可令其本阶段出〖杀〗次数+1，然后你选择一项执行：1.弃置任意张牌并摸1张牌，本回合结束时你摸等量张牌；2.失去至多4点体力并令一名角色摸等量张牌，本回合结束时你回复因此失去的体力。' },
    { id: WANGPING_FANGONG, name: '返攻', description: '限定技，出牌阶段，你可回复满体力值并摸5张牌。你因“诱夷”失去的体力值和牌数的总和每累计达到7后，此技能视为未发动过。' },
  ] },
]

