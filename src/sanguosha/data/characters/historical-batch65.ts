import type { CharacterDefinition } from './types'
import { skillIdsOf } from './standard'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { drawCards } from '../../engine/draw'
import { effectiveCardColor, effectiveCardSuit, grantSkill, isCardProtectedFromDiscard, isTargetProhibited, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { declaredCardActions, executeUseCardAction, skillHandCardUseActions } from '../../engine/cards/basic'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { moveCard, setCardAlias } from '../../engine/zones'
import { getAttackRange, getDistance } from '../../engine/distance'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { resolveDamage, resolveDamageSequence } from '../../engine/damage'
import { startGroupCardDecision, registerGroupCardDecision } from '../../engine/group-card-decision'
import { startGroupDecision, registerGroupDecision, playersWhoChose } from '../../engine/group-decision'
import { gainMaxHp } from '../../engine/hp'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { giveCards } from '../../engine/hand-transfer'
import { effectiveKingdomOf } from '../../engine/huashen'

const B65 = '-b65'
const id = (name: string) => `${name}${B65}`
const B65_JIE_XIAHOU_ID = 'jie-xiahoushi-b65'
const B65_JIE_GUO_ID = 'jie-guohuanghou-b65'
const B65_JIE_ZHANGSONG_ID = 'jie-zhangsong-b65'
const playerOf = (state: SanguoshaState, playerId: PlayerId) => state.players.find((player) => player.id === playerId)
type Batch65State = SanguoshaState & {
  b65RoundUse?: { roundNumber: number; names: string[] }
  b65LastCard?: Partial<Record<PlayerId, { cardId: CardId; dealtDamage: boolean }>>
  b65ZhuijiaoBonusCards?: CardId[]
  b65ZhuijiaoDiscardCards?: Record<PlayerId, CardId>
  b65HulieBonusCards?: CardId[]
  b65HulieRetaliation?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId }>
  b65HulieUses?: Record<PlayerId, Record<string, number>>
  b65TurnDiscard?: { turnNumber: number; cardIds: CardId[] }
  b65FengshangSuits?: Record<PlayerId, { roundNumber: number; suits: string[] }>
  b65FengshangTurn?: Record<PlayerId, number>
  b65WenchouTargets?: Record<PlayerId, { turnNumber: number; counts: Record<PlayerId, number> }>
  b65WenchouJuejueUsed?: Record<PlayerId, number>
  b65ZhibingBlackUses?: number
  b65ZhibingLevels?: Record<PlayerId, number>
  b65JinmingOptions?: Record<PlayerId, number[]>
  b65JinmingCurrent?: Record<PlayerId, { turnNumber: number; option: number; recovered: boolean; discarded: number; categories: string[]; damage: number }>
  b65Xiaoshi?: Record<PlayerId, { turnNumber: number; pending: boolean; cardId?: CardId; targets?: PlayerId[] }>
  b65YipoSeen?: Record<PlayerId, number[]>
  b65Lunzhan?: Record<PlayerId, { turnNumber: number; usedTargets: PlayerId[]; counts: Record<PlayerId, number>; pendingCards?: CardId[]; pendingDuel?: { cardId: CardId; targetId: PlayerId } }>
  b65Choulie?: Record<PlayerId, { targetId: PlayerId; turnNumber: number }>
  b65ChoulieCards?: CardId[]
  b65YanliangUsed?: Record<PlayerId, number>
  b65LiwenPrevious?: Record<PlayerId, { suit: string | null; category: string }>
  b65LiwenQueue?: Record<PlayerId, { holders: PlayerId[]; index: number; failed: number; pending?: { playerId: PlayerId; cardId: CardId } }>
  b65DuliePending?: Record<CardId, { ownerId: PlayerId; sourceId: PlayerId; targetId: PlayerId; cardName: string; action: Extract<import('../../engine/actions').LegalAction, { kind: 'use-card' }>; stage: 'first' | 'second' }>
}
const stateOf = (host: SkillHost) => host.state as Batch65State

function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}): void {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseOptionRequest => ({
    id: requestId, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional: true, options,
  }) })
}

// 界夏侯氏：燕语沿用夏侯氏已完成的重铸逻辑；樵拾改为每轮一次的结束阶段互摸。
const JIE_QIAOSHI = id('qiaoshi-jie-xiahoushi')
const QIAOSHI_DISABLED = 'b65-jie-xiahoushi-qiaoshi-disabled-round'
registerSkillRuntime({
  id: JIE_QIAOSHI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.phase !== 'finish' || !phase.playerId) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.marks[QIAOSHI_DISABLED] === host.state.roundNumber
      || usedThisPhase(host.state, ownerId, JIE_QIAOSHI)) return
    host.queueSkill({ skillId: JIE_QIAOSHI, ownerId, step: 'invoke', data: { turnPlayerId: phase.playerId, roundNumber: host.state.roundNumber } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const owner = playerOf(host.state, ownerId)
    const current = playerOf(host.state, prompt.data.turnPlayerId as PlayerId)
    if (!owner?.alive || !current?.alive || owner.marks[QIAOSHI_DISABLED] === host.state.roundNumber
      || usedThisPhase(host.state, ownerId, JIE_QIAOSHI)) return
    askOption(host, JIE_QIAOSHI, ownerId, 'invoke', `【樵拾】：是否与当前回合角色${current.nickname}各摸一张牌？`, [
      { id: 'yes', label: '各摸一张牌' }, { id: 'no', label: '不发动' },
    ], { turnPlayerId: current.id, roundNumber: host.state.roundNumber })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, resolution.data.turnPlayerId as PlayerId)
    if (!owner?.alive || !target?.alive || Number(resolution.data.roundNumber) !== host.state.roundNumber
      || owner.marks[QIAOSHI_DISABLED] === host.state.roundNumber) return
    markUsedThisPhase(host.state, ownerId, JIE_QIAOSHI)
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    if (target.id === ownerId) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    else drawCards(host.state, host.rng, target.id, 1, (name, payload) => host.dispatch(name, payload))
    host.dispatch('SkillActivated', { skillId: JIE_QIAOSHI, skillName: '樵拾', playerId: ownerId, targetId: target.id,
      logText: `${owner.nickname}发动【樵拾】，与${target.nickname}各摸一张牌` }, { sourceId: ownerId, targetId: target.id })
    const ownerHand = owner.zones.hand.length
    const targetHand = target.id === ownerId ? ownerHand : target.zones.hand.length
    if (ownerHand !== targetHand) owner.marks[QIAOSHI_DISABLED] = host.state.roundNumber
  },
})

// 界郭皇后【矫诏】：全场共用牌名回合账本；每轮的已使用牌名由 RoundStart 重置。
const JIE_JIAOZHAO = id('jiaozhao-jie-guohuanghou')
const JIE_DANXIN = id('danxin-jie-guohuanghou')
const JIE_GUO_NAMES = ['杀', '闪', '桃', '酒', '无懈可击', ...INSTANT_TRICKS]
function refreshB65RoundLedger(state: Batch65State): Set<string> {
  if (!state.b65RoundUse || state.b65RoundUse.roundNumber !== state.roundNumber) {
    state.b65RoundUse = { roundNumber: state.roundNumber, names: [] }
  }
  return new Set(state.b65RoundUse.names)
}
const JIE_GUO_ROUND_TRACKER = id('guohuanghou-round-card-tracker')
registerSkillRuntime({ id: JIE_GUO_ROUND_TRACKER, triggers: [
  { event: 'AfterCardUse', handle(host, _ownerId, context) {
    const payload = context.event.payload as { cardName?: string }
    if (payload.cardName) {
      const state = stateOf(host)
      const used = refreshB65RoundLedger(state)
      if (!used.has(payload.cardName)) state.b65RoundUse!.names.push(payload.cardName)
    }
  } },
  { event: 'RoundStart', handle(host) { stateOf(host).b65RoundUse = { roundNumber: host.state.roundNumber, names: [] } } },
] })
registerSkillRuntime({
  id: JIE_JIAOZHAO,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const rank = owner?.marks[id('jiaozhao-level')] ?? 0
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || !owner.zones.hand.length) return []
    if (rank === 0 && usedThisPhase(state, ownerId, JIE_JIAOZHAO)) return []
    const used = refreshB65RoundLedger(state as Batch65State)
    if (rank >= 1 && usedThisPhase(state, ownerId, JIE_JIAOZHAO)) return []
    const names = JIE_GUO_NAMES.filter((name) => !used.has(name))
    return names.length ? [{ id: `skill:${JIE_JIAOZHAO}`, label: '发动【矫诏】：将牌当本轮未使用的基本牌或普通锦囊使用' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIE_JIAOZHAO}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.zones.hand.length) return
    const used = refreshB65RoundLedger(stateOf(host))
    const names = JIE_GUO_NAMES.filter((name) => !used.has(name))
    if (!names.length) return
    host.askSkill({ skillId: JIE_JIAOZHAO, ownerId, step: 'card', data: { names, roundNumber: host.state.roundNumber }, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【矫诏】：选择一张牌作为使用载体', timeoutMs: 20_000,
      optional: true, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || Number(resolution.data.roundNumber) !== host.state.roundNumber) return
    if (resolution.step === 'card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      const names = (resolution.data.names as string[]).filter((name) => !refreshB65RoundLedger(stateOf(host)).has(name))
      if (!names.length) return
      host.askSkill({ skillId: JIE_JIAOZHAO, ownerId, step: 'declare', data: { cardId, names, roundNumber: host.state.roundNumber }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【矫诏】：声明一种本轮未使用过的基本牌或普通锦囊牌',
        timeoutMs: 20_000, optional: false, options: names.map((name) => ({ id: name, label: name })),
      }) })
      return
    }
    if (resolution.step === 'declare') {
      const cardId = resolution.data.cardId as CardId
      const name = (response.payload as { optionId?: string }).optionId
      if (!name || !(resolution.data.names as string[]).includes(name) || !owner.zones.hand.includes(cardId)
        || refreshB65RoundLedger(stateOf(host)).has(name)) return
      const rank = owner.marks[id('jiaozhao-level')] ?? 0
      setCardAlias(host.state, cardId, name)
      owner.marks[id('jiaozhao-round')] = host.state.roundNumber
      owner.marks[id('jiaozhao-level-used')] = rank
      markUsedThisPhase(host.state, ownerId, JIE_JIAOZHAO)
      // 技能转化牌仍由标准合法动作生成器处理目标、距离、次数、无懈与响应。
      const actions = declaredCardActions(host.state, ownerId, cardId, name, `【矫诏】视为使用【${name}】`, { sourceSkillId: JIE_JIAOZHAO })
        .filter((action) => action.kind === 'use-card')
      if (actions.length === 1) executeUseCardAction(host as never, ownerId, actions[0] as never)
      else if (actions.length > 1) {
        host.askSkill({ skillId: JIE_JIAOZHAO, ownerId, step: 'targets', data: { cardId, name, roundNumber: host.state.roundNumber }, build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: `【矫诏】：选择【${name}】的目标`, timeoutMs: 25_000,
          optional: false, candidateIds: [...new Set(actions.flatMap((action) => action.kind === 'use-card' ? action.targetIds : []))], min: 1,
          max: Math.max(1, Math.min(...actions.map((action) => action.kind === 'use-card' ? action.targetMax : 1))),
        }) })
      }
      return
    }
    if (resolution.step === 'targets') {
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const cardId = resolution.data.cardId as CardId
      const name = resolution.data.name as string
      if (!owner.zones.hand.includes(cardId)) return
      setCardAlias(host.state, cardId, name)
      const action = declaredCardActions(host.state, ownerId, cardId, name, `【矫诏】视为使用【${name}】`, { sourceSkillId: JIE_JIAOZHAO })
        .find((candidate) => candidate.kind === 'use-card' && candidate.targetIds.length === targetIds.length
          && candidate.targetIds.every((target, index) => target === targetIds[index]))
      if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
    }
  },
})
registerSkillRuntime({
  id: JIE_DANXIN,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: JIE_DANXIN, ownerId, step: 'invoke', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    askOption(host, JIE_DANXIN, ownerId, 'choice', '【殚心】：摸牌并修改【矫诏】，或只修改【矫诏】？', [
      { id: 'draw-modify', label: '摸X张牌并修改【矫诏】' }, { id: 'modify', label: '修改【矫诏】' },
    ], { level: owner.marks[id('jiaozhao-level')] ?? 0 })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const level = owner.marks[id('jiaozhao-level')] ?? 0
    if ((response.payload as { optionId?: string }).optionId === 'draw-modify') drawCards(host.state, host.rng, ownerId, Math.max(1, level), (name, payload) => host.dispatch(name, payload))
    if (level < 2) {
      owner.marks[id('jiaozhao-level')] = level + 1
      host.dispatch('SkillActivated', { skillId: JIE_DANXIN, skillName: '殚心', playerId: ownerId, logText: `${owner.nickname}发动【殚心】，修改【矫诏】至第${level + 1}阶段` }, { sourceId: ownerId })
    }
  },
})


// 界张松沿用强识、献图既有完整规则；身份差异只在卡册登记。
export const JIE_XIAHOU_SHI_B65: CharacterDefinition = {
  id: B65_JIE_XIAHOU_ID, name: '界·夏侯氏', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'yjcm2015',
  skills: [
    { id: JIE_QIAOSHI, name: '樵拾', description: '每个结束阶段，你可以与当前回合角色各摸一张牌。然后若其与你手牌数不相等，此技能本轮失效。' },
    { id: 'yanyu', name: '燕语', description: '出牌阶段，你可以重铸【杀】。出牌阶段结束时，若你本阶段失去过至少两张【杀】，你可以令一名男性角色摸两张牌。' },
  ],
}

export const JIE_GUO_HUANGHOU_B65: CharacterDefinition = {
  id: B65_JIE_GUO_ID, name: '界·郭皇后', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: JIE_JIAOZHAO, name: '矫诏', description: '出牌阶段限一次，你可将一张牌当本轮未有角色使用过的基本或普通锦囊牌使用。修改一：每轮限一次，你可将一张牌当任意基本牌或普通锦囊牌使用。修改二：每轮限一次，你可视为使用一张基本牌或普通锦囊。' },
    { id: JIE_DANXIN, name: '殚心', description: '当你受到伤害后，你可摸X张牌，然后修改“矫诏”（X为你修改“矫诏”的次数）。' },
  ],
}

export const JIE_ZHANGSONG_B65: CharacterDefinition = {
  id: B65_JIE_ZHANGSONG_ID, name: '界·张松', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'yjcm2014',
  skills: [
    { id: 'qiangshi', name: '强识', description: '出牌阶段开始时，你可观看一名其他角色的手牌并展示其中一张牌，然后你本阶段使用此类别的牌时可摸一张牌。' },
    { id: 'xiantu', name: '献图', description: '其他角色出牌阶段开始时，你可以摸至多两张牌，然后交给其等量牌。此阶段结束时，若其造成伤害小于你以此法交给其的牌数，你失去1点体力。' },
  ],
}

const MOU_TAISHICI_DULIE = id('dulie-mou-taishici')
const MOU_TAISHICI_DOUCHAN = id('douchan-mou-taishici')
const MOU_DONGZHUO_GUANBIAN = id('guanbian-mou-dongzhuo')
const MOU_DONGZHUO_XIONGNI = id('xiongni-mou-dongzhuo')
const MOU_DONGZHUO_FENGSHANG = id('fengshang-mou-dongzhuo')
const MOU_DONGZHUO_ZHIBING = id('zhibing-mou-dongzhuo')
const MOU_SUNJIAN_YIPO = id('yipo-mou-sunjian')
const MOU_SUNJIAN_HULIE = id('hulie-mou-sunjian')
const MOU_KONGRONG_LIWEN = id('liwen-mou-kongrong')
const MOU_KONGRONG_ZHENGYI = id('zhengyi-mou-kongrong')
const MOU_YUANSHU_JINMING = id('jinming-mou-yuanshu')
const MOU_YUANSHU_XIAOSHI = id('xiaoshi-mou-yuanshu')
const MOU_YUANSHU_YANLIANG = id('yanliang-mou-yuanshu')
const MOU_ZHANGXIU_CHOULIE = id('choulie-mou-zhangxiu')
const MOU_ZHANGXIU_ZHUIJIAO = id('zhuijiao-mou-zhangxiu')
const MOU_WENCHOU_LUNZHAN = id('lunzhan-mou-wenchou')
const MOU_WENCHOU_JUEJUE = id('juejue-mou-wenchou')

registerSkillRuntime({
  id: MOU_TAISHICI_DULIE,
  interceptPlayAction(host, ownerId, action) {
    const cardId = action.cardIds[0]
    const card = host.state.cards[cardId]
    if (!card || action.playerId === ownerId || action.targetIds.length !== 1 || action.targetIds[0] !== ownerId
      || !['basic', 'trick'].includes(card.category) || (card.category === 'trick' && !INSTANT_TRICKS.has(action.asCardName))) return false
    host.askSkill({ skillId: MOU_TAISHICI_DULIE, ownerId, step: 'invoke', data: { action },
      build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【笃烈】：是否令${action.asCardName}的效果额外结算一次？`, timeoutMs: 25_000, optional: true,
        options: [{ id: 'yes', label: '额外结算一次，并摸牌' }, { id: 'no', label: '不发动' }] }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke') return
    const action = (resolution.data as { action?: Extract<import('../../engine/actions').LegalAction, { kind: 'use-card' }> }).action
    if (!action) return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') {
      executeUseCardAction(host as never, action.playerId, action, { skipPlayInterceptors: true })
      return
    }
    const cardId = action.cardIds[0]!
    const state = stateOf(host)
    state.b65DuliePending ??= {}
    state.b65DuliePending[cardId] = { ownerId, sourceId: action.playerId, targetId: ownerId, cardName: action.asCardName, action, stage: 'first' }
    executeUseCardAction(host as never, action.playerId, action, { skipPlayInterceptors: true })
    if (stateOf(host).b65DuliePending?.[cardId]?.stage === 'first' && !host.state.cardResolution) {
      // A use cancelled before entering resolution still has a CardResolved event in the normal lifecycle.
      // If a replacement rule returned early, clear stale bookkeeping rather than leaving a phantom trigger.
      delete stateOf(host).b65DuliePending?.[cardId]
    }
  },
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      const state = stateOf(host)
      const pending = state.b65DuliePending?.[cardId]
      if (!pending || pending.ownerId !== ownerId || pending.stage !== 'first') return
      delete state.b65DuliePending![cardId]
      const target = playerOf(host.state, pending.targetId)
      const source = playerOf(host.state, pending.sourceId)
      if (!target?.alive || !source?.alive) {
        drawCards(host.state, host.rng, ownerId, Math.min(5, getAttackRange(host.state, ownerId)), (name, payload) => host.dispatch(name, payload))
        return
      }
      const replayId = `virtual:${MOU_TAISHICI_DULIE}:${host.state.seq + 1}:${host.state.decisions.length}`
      const original = host.state.cards[cardId]
      const category = original?.category === 'basic' ? 'basic' : 'trick'
      host.state.cards[replayId] = {
        id: replayId, ruleset: host.state.rulesetVersion, expansion: 'standard',
        name: pending.cardName, suit: 'spade', rank: 1, color: 'black', category,
        virtual: true, sourceSkillId: MOU_TAISHICI_DULIE, repeatedEffect: true,
      }
      source.zones.hand.push(replayId)
      state.b65DuliePending![replayId] = { ...pending, stage: 'second' }
      const replayAction = { ...pending.action,
        id: `b65-dulie-repeat:${replayId}`, kind: 'use-card' as const, playerId: source.id,
        label: `【笃烈】重复结算【${pending.cardName}】`, cardIds: [replayId],
        targetIds: [target.id], targetMin: 1, targetMax: 1, asCardName: pending.cardName,
        sourceSkillId: MOU_TAISHICI_DULIE }
      executeUseCardAction(host as never, source.id, replayAction as never, { skipPlayInterceptors: true, countSlashUsage: false })
      if (!state.b65DuliePending?.[replayId]) return
      if (host.state.cardResolution || host.state.pendingRequests.length) return
      delete state.b65DuliePending?.[replayId]
      source.zones.hand = source.zones.hand.filter((id) => id !== replayId)
      delete host.state.cards[replayId]
      drawCards(host.state, host.rng, ownerId, Math.min(5, getAttackRange(host.state, ownerId)), (name, payload) => host.dispatch(name, payload))
    } },
    { event: 'CardEffectResolved', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      const state = stateOf(host)
      const pending = state.b65DuliePending?.[cardId]
      if (!pending || pending.ownerId !== ownerId || pending.stage !== 'second') return
      delete state.b65DuliePending![cardId]
      drawCards(host.state, host.rng, ownerId, Math.min(5, getAttackRange(host.state, ownerId)), (name, payload) => host.dispatch(name, payload))
    } },
  ],
})

// 谋孔融【争义】的旁观者同时决定；拒绝者不透露给其他参与者。
const ZHENGYI_GROUP = 'batch65-kongrong-zhengyi'
const XIAN_MARK = 'mou-kongrong-xian'
registerGroupDecision(ZHENGYI_GROUP, (groupHost, decision) => {
  const host = groupHost as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  const targetId = decision.data.targetId as PlayerId
  const target = playerOf(host.state, targetId)
  const amount = Number(decision.data.amount)
  const agrees = playersWhoChose(decision, 'yes').filter((playerId) => playerOf(host.state, playerId)?.alive)
  if (!agrees.length) {
    resolveDamage(host as never, {
      ...(decision.data.damage as Record<string, unknown>),
      skipGlobalDamagePreventionSkillIds: [MOU_KONGRONG_ZHENGYI],
    } as never)
    return
  }
  const payer = agrees.map((playerId) => playerOf(host.state, playerId)!).sort((a, b) => b.hp - a.hp || a.seat - b.seat)[0]
  if (target?.alive) {
    host.dispatch('SkillActivated', { skillId: MOU_KONGRONG_ZHENGYI, skillName: '争义', playerId: ownerId,
      targetId, result: 'damage-prevented', logText: `【争义】防止了${target.nickname}受到的普通伤害` }, { sourceId: ownerId, targetId })
  }
  if (payer?.alive) loseHp(host as never, payer.id, amount, MOU_KONGRONG_ZHENGYI)
})

registerSkillRuntime({
  id: MOU_KONGRONG_LIWEN,
  limited: false,
  onGameStart(_host, ownerId) {
    const owner = _host.state.players.find((player) => player.id === ownerId)
    if (owner) owner.marks[XIAN_MARK] = 3
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; playerId?: PlayerId; cardIds?: CardId[] }
      const playerId = payload.playerId ?? context.event.sourceId
      if (playerId !== ownerId) return
      const cardId = payload.cardId ?? payload.cardIds?.[0]
      const card = cardId ? host.state.cards[cardId] : undefined
      if (!card) return
      const resolvedCardId = card.id
      const state = stateOf(host)
      const previous = state.b65LiwenPrevious?.[ownerId]
      if (previous && (previous.suit === card.suit || previous.category === card.category)) {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks[XIAN_MARK] = Math.min(5, (owner.marks[XIAN_MARK] ?? 0) + 1)
      }
      state.b65LiwenPrevious ??= {}
      state.b65LiwenPrevious[ownerId] = { suit: effectiveCardSuit(host.state, ownerId, resolvedCardId, skillIdsOf), category: card.category }
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId | null; playerId?: PlayerId }
      const cardId = payload.cardId
      if (payload.playerId !== ownerId || !cardId) return
      const card = host.state.cards[cardId]
      if (!card) return
      const state = stateOf(host)
      const previous = state.b65LiwenPrevious?.[ownerId]
      if (previous && (previous.suit === card.suit || previous.category === card.category)) {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks[XIAN_MARK] = Math.min(5, (owner.marks[XIAN_MARK] ?? 0) + 1)
      }
      state.b65LiwenPrevious ??= {}
      state.b65LiwenPrevious[ownerId] = { suit: effectiveCardSuit(host.state, ownerId, cardId, skillIdsOf), category: card.category }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if (context.event.payload.playerId !== ownerId || (playerOf(host.state, ownerId)?.marks[XIAN_MARK] ?? 0) <= 0) return
      host.queueSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'distribute', data: { selected: [] } })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const queue = stateOf(host).b65LiwenQueue?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId }
      if (!queue?.pending || context.event.sourceId !== queue.pending.playerId || payload.cardId !== queue.pending.cardId) return
      queue.index += 1
      queue.pending = undefined
      host.queueSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'offer-use', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'distribute') {
      const owner = playerOf(host.state, ownerId)
      const data = prompt.data as { selected?: PlayerId[] }
      const candidates = host.state.players.filter((player) => player.alive
        && !(data.selected ?? []).includes(player.id) && (player.marks[XIAN_MARK] ?? 0) < 5).map((player) => player.id)
      if (!owner?.alive || (owner.marks[XIAN_MARK] ?? 0) <= 0 || !candidates.length) {
        const holders = host.state.players.filter((player) => player.alive && (player.marks[XIAN_MARK] ?? 0) > 0)
          .sort((a, b) => (b.marks[XIAN_MARK] ?? 0) - (a.marks[XIAN_MARK] ?? 0) || a.seat - b.seat).map((player) => player.id)
        const state = stateOf(host)
        state.b65LiwenQueue ??= {}
        state.b65LiwenQueue[ownerId] = { holders, index: 0, failed: 0 }
        host.queueSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'offer-use', data: {} })
        return
      }
      host.askSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'distribution-target', data: { selected: data.selected ?? [] },
        build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【立文】：可将“贤”分配给等量其他角色（每名角色至多5枚）', timeoutMs: 25_000,
          optional: true, candidateIds: candidates, min: 0, max: 1 }) })
      return
    }
    if (prompt.step !== 'offer-use') return
    const queue = stateOf(host).b65LiwenQueue?.[ownerId]
    if (!queue) return
    if (queue.index >= queue.holders.length) {
      const failed = queue.failed
      delete stateOf(host).b65LiwenQueue![ownerId]
      if (failed) drawCards(host.state, host.rng, ownerId, failed, (name, payload) => host.dispatch(name, payload))
      return
    }
    const holderId = queue.holders[queue.index]!
    const holder = playerOf(host.state, holderId)
    if (!holder?.alive) { queue.index += 1; host.queueSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'offer-use', data: {} }); return }
    const cards = holder.zones.hand
    const actions = cards.flatMap((cardId) => skillHandCardUseActions(host.state, holderId, cardId))
    if (!actions.length) {
      const lost = holder.marks[XIAN_MARK] ?? 0
      delete holder.marks[XIAN_MARK]
      queue.failed += lost
      queue.index += 1
      host.queueSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'offer-use', data: {} })
      return
    }
    host.askSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'use-card', data: { holderId, actionIds: actions.map((action) => action.id) },
      build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: holderId,
        prompt: '【立文】：选择使用一张手牌，或放弃并移去你的全部“贤”', timeoutMs: 25_000, optional: false,
        options: [...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'decline', label: '不使用' }] }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'distribution-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const data = resolution.data as { selected?: PlayerId[] }
      if (!targetId) {
        const holders = host.state.players.filter((player) => player.alive && (player.marks[XIAN_MARK] ?? 0) > 0)
          .sort((a, b) => (b.marks[XIAN_MARK] ?? 0) - (a.marks[XIAN_MARK] ?? 0) || a.seat - b.seat).map((player) => player.id)
        const state = stateOf(host)
        state.b65LiwenQueue ??= {}
        state.b65LiwenQueue[ownerId] = { holders, index: 0, failed: 0 }
        host.queueSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'offer-use', data: {} })
        return
      }
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const owner = playerOf(host.state, ownerId)
      if (!target || !owner || (owner.marks[XIAN_MARK] ?? 0) <= 0 || (target.marks[XIAN_MARK] ?? 0) >= 5) {
        host.queueSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'distribute', data }); return
      }
      const max = Math.min(owner.marks[XIAN_MARK]!, 5 - (target.marks[XIAN_MARK] ?? 0))
      host.askSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'distribution-amount', data: { targetId, selected: data.selected ?? [] },
        build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【立文】：分配给${target.nickname}几枚“贤”？`, timeoutMs: 25_000, optional: false,
          options: Array.from({ length: max }, (_, index) => ({ id: String(index + 1), label: `${index + 1}枚` })) }) })
      return
    }
    if (resolution.step === 'distribution-amount') {
      const data = resolution.data as { targetId: PlayerId; selected: PlayerId[] }
      const amount = Number((response.payload as { optionId?: string }).optionId)
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, data.targetId)
      if (owner && target && Number.isInteger(amount) && amount > 0 && amount <= (owner.marks[XIAN_MARK] ?? 0)
        && amount <= 5 - (target.marks[XIAN_MARK] ?? 0)) {
        owner.marks[XIAN_MARK]! -= amount
        if (!owner.marks[XIAN_MARK]) delete owner.marks[XIAN_MARK]
        target.marks[XIAN_MARK] = (target.marks[XIAN_MARK] ?? 0) + amount
        data.selected.push(target.id)
      }
      host.queueSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'distribute', data: { selected: data.selected } })
      return
    }
    if (resolution.step === 'use-card') {
      const queue = stateOf(host).b65LiwenQueue?.[ownerId]
      const data = resolution.data as { holderId: PlayerId; actionIds: string[] }
      const actionId = (response.payload as { optionId?: string }).optionId
      const holder = playerOf(host.state, data.holderId)
      if (!queue || !holder) return
      if (actionId && actionId !== 'decline' && data.actionIds.includes(actionId)) {
        const cardId = holder.zones.hand.find((id) => skillHandCardUseActions(host.state, holder.id, id).some((action) => action.id === actionId))
        const action = cardId && skillHandCardUseActions(host.state, holder.id, cardId).find((candidate) => candidate.id === actionId)
        if (cardId && action) {
          const beforeIndex = queue.index
          queue.pending = { playerId: holder.id, cardId }
          executeUseCardAction(host as never, holder.id, action)
          if (queue.pending || queue.index !== beforeIndex) return
        }
      }
      const lost = holder.marks[XIAN_MARK] ?? 0
      delete holder.marks[XIAN_MARK]
      queue.failed += lost
      queue.index += 1
      host.queueSkill({ skillId: MOU_KONGRONG_LIWEN, ownerId, step: 'offer-use', data: {} })
    }
  },
})

registerSkillRuntime({
  id: MOU_KONGRONG_ZHENGYI,
  interceptGlobalIncomingDamage(host, ownerId, targetId, context) {
    if (context.nature !== 'normal' || context.amount <= 0) return false
    const target = playerOf(host.state, targetId)
    if (!target?.alive || (target.marks[XIAN_MARK] ?? 0) <= 0) return false
    const holders = host.state.players.filter((player) => player.alive && player.id !== targetId && (player.marks[XIAN_MARK] ?? 0) > 0)
      .map((player) => player.id)
    const damage = {
      sourceId: context.sourceId, targetId, amount: context.amount, nature: context.nature,
      cardId: context.cardId, cardName: context.cardName,
      chainTransfer: context.chainTransfer,
    }
    startGroupDecision(host as never, {
      id: `b65-zhengyi:${host.state.seq}`, tag: ZHENGYI_GROUP, skillId: MOU_KONGRONG_ZHENGYI,
      playerIds: holders, prompt: '【争义】：是否失去体力以防止该角色受到的普通伤害？',
      options: [{ id: 'yes', label: '失去体力并防止伤害' }, { id: 'no', label: '不发动' }],
      defaultOptionId: 'no', timeoutMs: 25_000,
      data: { ownerId, targetId, amount: context.amount, damage },
    })
    return true
  },
})

export const MOU_TAISHICI_B65: CharacterDefinition = {
  id: 'mou-taishici-b65', name: '谋·太史慈', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: MOU_TAISHICI_DULIE, name: '笃烈', description: '每回合限一次，你成为其他角色基本牌或普通锦囊牌的唯一目标时，你可令此牌的效果结算两次，然后你摸X张牌（X为你的攻击范围且至多为5）。' },
    { id: MOU_TAISHICI_DOUCHAN, name: '斗缠', description: '锁定技，准备阶段，你从牌堆中获得一张【决斗】，否则你的攻击范围和出牌阶段使用【杀】的次数+1（增加次数不超过游戏人数）。', locked: true },
  ],
}

export const MOU_DONGZHUO_B65: CharacterDefinition = {
  id: 'mou-dongzhuo-b65', name: '谋·董卓', kingdom: 'qun', gender: 'male', maxHp: 5, pack: 'sp',
  skills: [
    { id: MOU_DONGZHUO_GUANBIAN, name: '观变', description: '锁定技，游戏开始时，你的手牌上限、其他角色与你的距离、你与其他角色的距离+X。首轮结束后或你发动“凶逆”或“封赏”后，你失去此技能。（X为游戏人数）', locked: true },
    { id: MOU_DONGZHUO_XIONGNI, name: '凶逆', description: '出牌阶段开始时，你可以弃置一张牌，其他每名角色需弃置一张与此牌花色相同的牌，否则受到你的1点伤害。' },
    { id: MOU_DONGZHUO_FENGSHANG, name: '封赏', description: '出牌阶段限一次，或有角色进入濒死状态时（每回合限一次），你可以将本回合弃牌堆中两张花色相同牌分配给等量角色（每轮每花色的牌限一次）。若你未以此法获得牌，你视为使用一张不计入次数的【酒】。' },
    { id: MOU_DONGZHUO_ZHIBING, name: '执柄', description: '主公技，锁定技，准备阶段，若其他群雄势力角色累计使用黑色牌达到：3张，你增加1点体力上限并回复1体力；6张，你获得“焚城”；9张，你获得“崩坏”。', locked: true },
  ],
}

export const MOU_SUNJIAN_B65: CharacterDefinition = {
  id: 'mou-sunjian-b65', name: '谋·孙坚', kingdom: 'wu', gender: 'male', maxHp: 5, pack: 'sp',
  skills: [
    { id: MOU_SUNJIAN_YIPO, name: '毅魄', description: '你的体力值变化后，若当前体力值大于0且为你首次达到，你可以选择一名角色并选择一项：1.令其摸X张牌，然后弃置一张牌；2.令其摸一张牌，然后弃置X张牌。（X为你已损失体力值且至少为1）' },
    { id: MOU_SUNJIAN_HULIE, name: '虎烈', description: '每回合各限一次，你使用【杀】或【决斗】仅指定一名角色为目标后，你可令此牌伤害+1。若此牌未造成伤害，你可令目标角色视为对你使用一张【杀】。' },
  ],
}

export const MOU_KONGRONG_B65: CharacterDefinition = {
  id: 'mou-kongrong-b65', name: '谋·孔融', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: MOU_KONGRONG_LIWEN, name: '立文', description: '游戏开始时你获得3个“贤”标记。你每使用或打出一张花色或类型与前一张相同的牌后，你获得一个“贤”。回合结束时，你可将任意“贤”标记分配给等量角色（每名角色至多拥有5个标记），有“贤”的角色按照“贤”数量从高到低顺序依次使用一张手牌，若其不使用，移去其“贤”，你摸等量的牌。' },
    { id: MOU_KONGRONG_ZHENGYI, name: '争义', description: '当有“贤”的角色受到非属性伤害时，其他有“贤”的角色同时选择是否失去体力，然后若有角色选择同意，则防止此伤害，同意的角色中体力值最大的角色失去等同于此伤害值的体力。' },
  ],
}

export const MOU_YUANSHU_B65: CharacterDefinition = {
  id: 'mou-yuanshu-b65', name: '谋·袁术', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: MOU_YUANSHU_JINMING, name: '矜名', description: '锁定技，回合开始时，你选择一项条件：1.回复过1点体力；2.弃置过两张牌；3.使用过三种类别的牌；4.造成过4点伤害。然后此回合结束时，你摸X张牌，若本回合未满足条件，则你删除对应选项（X为你上次“矜名”选择的选项序号数）。', locked: true },
    { id: MOU_YUANSHU_XIAOSHI, name: '枭噬', description: '出牌阶段限一次，你使用的牌可以额外指定一个目标（无距离限制），若此牌未造成伤害，你失去1点体力或令其中一个目标摸X张牌（X为你上次“矜名”选择的选项序号数）。' },
    { id: MOU_YUANSHU_YANLIANG, name: '厌粱', description: '主公技，其他群势力角色的出牌阶段限一次，其可以交给你一张装备牌，视为使用一张【酒】。' },
  ],
}

export const MOU_ZHANGXIU_B65: CharacterDefinition = {
  id: 'mou-zhangxiu-b65', name: '谋·张绣', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: MOU_ZHANGXIU_CHOULIE, name: '仇猎', description: '限定技，回合开始时，你可选择一名其他角色。本回合你的每个阶段开始时，你可弃置一张牌视为对其使用一张【杀】。其可弃置一张基本牌或武器牌令此【杀】无效。' },
    { id: MOU_ZHANGXIU_ZHUIJIAO, name: '追剿', description: '锁定技，你使用【杀】时，若你使用的上一张牌未造成伤害，则你摸一张牌并令此【杀】伤害+1，此【杀】结算后，若仍未造成伤害，你弃置一张牌。', locked: true },
  ],
}

export const MOU_WENCHOU_B65: CharacterDefinition = {
  id: 'mou-wenchou-b65', name: '谋·文丑', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: MOU_WENCHOU_LUNZHAN, name: '轮战', description: '出牌阶段，你可将任意张牌当一张【决斗】使用（至多为5，且本回合不可重复）。若你以此法对唯一目标造成了伤害，你可摸X张牌，然后你本回合不能再对目标角色发动此技能（X为本回合你使用牌指定其为目标的次数）。' },
    { id: MOU_WENCHOU_JUEJUE, name: '决绝', description: '锁定技，当你于回合内首次使用所有手牌（仅包含手牌）指定仅一名其他角色为目标时，令其弃置X张牌（X为本回合你使用牌指定其为目标的次数）。', locked: true },
  ],
}

// 谋太史慈【斗缠】：按准备阶段检索牌堆；未检得时将攻击范围与出杀额度永久累增。
const DOUCHAN_RANGE = id('douchan-range')
const DOUCHAN_SLASH = id('douchan-slash')
const GUANBIAN_ACTIVE = id('guanbian-active')
const FENGSHANG_ACTION = id('fengshang-action')
function fengshangTurnCards(host: SkillHost): CardId[] {
  const state = stateOf(host)
  if (!state.b65TurnDiscard || state.b65TurnDiscard.turnNumber !== host.state.turnNumber)
    state.b65TurnDiscard = { turnNumber: host.state.turnNumber, cardIds: [] }
  return state.b65TurnDiscard.cardIds.filter((cardId) => host.state.zones.discardPile.includes(cardId))
}
function fengshangSuits(host: SkillHost, ownerId: PlayerId): string[] {
  const state = stateOf(host)
  const record = state.b65FengshangSuits?.[ownerId]
  const used = record?.roundNumber === host.state.roundNumber ? record.suits : []
  const counts = new Map<string, number>()
  for (const cardId of fengshangTurnCards(host)) {
    const suit = host.state.cards[cardId]?.suit
    if (suit && !used.includes(suit)) counts.set(suit, (counts.get(suit) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count >= 2).map(([suit]) => suit)
}
function offerFengshang(host: SkillHost, ownerId: PlayerId, fromDying: boolean): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (fromDying && stateOf(host).b65FengshangTurn?.[ownerId] === host.state.turnNumber) return
  const suits = fengshangSuits(host, ownerId)
  if (!suits.length) {
    if (fromDying) {
      const state = stateOf(host)
      state.b65FengshangTurn ??= {}
      state.b65FengshangTurn[ownerId] = host.state.turnNumber
    }
    host.beginVirtualBasic({ sourceId: ownerId, targetIds: [ownerId], cardName: '酒', sourceSkillId: MOU_DONGZHUO_FENGSHANG })
    return
  }
  host.askSkill({ skillId: MOU_DONGZHUO_FENGSHANG, ownerId, step: 'suit', data: { fromDying },
    build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【封赏】：选择本回合弃牌堆中两张同花色牌的花色', timeoutMs: 25_000, optional: true,
      options: [...suits.map((suit) => ({ id: suit, label: suit })), { id: 'decline', label: '不发动' }] }) })
}
registerSkillRuntime({
  id: MOU_DONGZHUO_FENGSHANG,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && !usedThisPhase(state, ownerId, MOU_DONGZHUO_FENGSHANG)
      ? [{ id: FENGSHANG_ACTION, label: '封赏：分配本回合弃牌堆的同花色牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId === FENGSHANG_ACTION) offerFengshang(host, ownerId, false)
  },
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, _ownerId, context) {
      const data = context.event.payload as { cardId?: CardId }
      if (!data.cardId || !host.state.zones.discardPile.includes(data.cardId)) return
      const state = stateOf(host)
      if (!state.b65TurnDiscard || state.b65TurnDiscard.turnNumber !== host.state.turnNumber)
        state.b65TurnDiscard = { turnNumber: host.state.turnNumber, cardIds: [] }
      if (!state.b65TurnDiscard.cardIds.includes(data.cardId)) state.b65TurnDiscard.cardIds.push(data.cardId)
    } },
    { event: 'TurnStart', handle(host, _ownerId) { stateOf(host).b65TurnDiscard = { turnNumber: host.state.turnNumber, cardIds: [] } } },
    { event: 'EnterDying', handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || stateOf(host).b65FengshangTurn?.[ownerId] === host.state.turnNumber) return
      host.queueSkill({ skillId: MOU_DONGZHUO_FENGSHANG, ownerId, step: 'dying', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'dying') {
      if (stateOf(host).b65FengshangTurn?.[ownerId] === host.state.turnNumber) return
      askOption(host, MOU_DONGZHUO_FENGSHANG, ownerId, 'dying-choice', '【封赏】：是否发动？', [
        { id: 'yes', label: '发动封赏' }, { id: 'no', label: '不发动' },
      ])
      return
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'dying-choice') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') offerFengshang(host, ownerId, true)
      return
    }
    if (resolution.step === 'suit') {
      const suit = (response.payload as { optionId?: string }).optionId
      if (!suit || suit === 'decline' || !fengshangSuits(host, ownerId).includes(suit)) return
      const candidates = fengshangTurnCards(host).filter((cardId) => host.state.cards[cardId]?.suit === suit)
      host.askSkill({ skillId: MOU_DONGZHUO_FENGSHANG, ownerId, step: 'cards', data: { suit, fromDying: resolution.data.fromDying },
        build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【封赏】：选择两张同花色牌', timeoutMs: 25_000, optional: false, purpose: 'skill',
          cardIds: candidates, hiddenCardSlots: [], min: 2, max: 2 }) })
      return
    }
    if (resolution.step === 'cards') {
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const suit = resolution.data.suit as string
      if (cardIds.length !== 2 || cardIds.some((cardId) => !fengshangTurnCards(host).includes(cardId)
        || host.state.cards[cardId]?.suit !== suit) || !fengshangSuits(host, ownerId).includes(suit)) return
      host.askSkill({ skillId: MOU_DONGZHUO_FENGSHANG, ownerId, step: 'targets', data: {
        cardIds, suit, fromDying: resolution.data.fromDying,
      }, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【封赏】：选择一至两名角色分配这两张牌', timeoutMs: 25_000, optional: false,
        candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 2 }) })
      return
    }
    if (resolution.step !== 'targets') return
    const targets = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const data = resolution.data as { cardIds: CardId[]; suit: string; fromDying: boolean }
    const validTargets = [...new Set(targets)].filter((targetId) => playerOf(host.state, targetId)?.alive)
    const currentCards = fengshangTurnCards(host)
    if ((validTargets.length !== 1 && validTargets.length !== 2) || !fengshangSuits(host, ownerId).includes(data.suit)
      || data.cardIds.some((cardId) => !currentCards.includes(cardId))) return
    for (const [index, cardId] of data.cardIds.entries()) {
      const targetId = validTargets.length === 1 ? validTargets[0]! : validTargets[index]!
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: MOU_DONGZHUO_FENGSHANG }, { targetId, cardIds: [cardId] })
    }
    const state = stateOf(host)
    state.b65FengshangSuits ??= {}
    const record = state.b65FengshangSuits[ownerId]
    if (!record || record.roundNumber !== host.state.roundNumber) state.b65FengshangSuits[ownerId] = { roundNumber: host.state.roundNumber, suits: [data.suit] }
    else if (!record.suits.includes(data.suit)) record.suits.push(data.suit)
    if (data.fromDying) {
      state.b65FengshangTurn ??= {}
      state.b65FengshangTurn[ownerId] = host.state.turnNumber
    } else markUsedThisPhase(host.state, ownerId, MOU_DONGZHUO_FENGSHANG)
    if (!validTargets.includes(ownerId)) host.beginVirtualBasic({ sourceId: ownerId, targetIds: [ownerId], cardName: '酒', sourceSkillId: MOU_DONGZHUO_FENGSHANG })
  },
})
registerSkillRuntime({
  id: MOU_DONGZHUO_GUANBIAN,
  onGameStart(_host, ownerId) {
    const owner = playerOf(_host.state, ownerId)
    if (owner) owner.marks[GUANBIAN_ACTIVE] = 1
  },
  maxCardsBonus(state, ownerId) {
    return playerOf(state, ownerId)?.marks[GUANBIAN_ACTIVE] ? state.players.length : 0
  },
  distanceModifier: {
    toOthers(state, ownerId) { return playerOf(state, ownerId)?.marks[GUANBIAN_ACTIVE] ? state.players.length : 0 },
    fromOthers(state, ownerId) { return playerOf(state, ownerId)?.marks[GUANBIAN_ACTIVE] ? state.players.length : 0 },
  },
  triggers: [{ event: 'RoundEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { roundNumber?: number }
    if (payload.roundNumber === 1) {
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks[GUANBIAN_ACTIVE] = 0
    }
  } }, { event: 'SkillActivated', handle(host, ownerId, context) {
    const payload = context.event.payload as { skillId?: string }
    if (context.event.sourceId !== ownerId || ![MOU_DONGZHUO_XIONGNI, MOU_DONGZHUO_FENGSHANG].includes(payload.skillId ?? '')) return
    const owner = playerOf(host.state, ownerId)
    if (owner) owner.marks[GUANBIAN_ACTIVE] = 0
  } }],
})

registerSkillRuntime({
  id: MOU_DONGZHUO_ZHIBING,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId
    if (!sourceId || sourceId === ownerId || effectiveKingdomOf(host.state, sourceId) !== 'qun') return
    const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
    const cards = [...new Set([...(payload.cardIds ?? []), ...(payload.cardId ? [payload.cardId] : [])])]
    const blackCount = cards.filter((cardId) => effectiveCardColor(host.state, sourceId, cardId) === 'black').length
    if (blackCount) stateOf(host).b65ZhibingBlackUses = (stateOf(host).b65ZhibingBlackUses ?? 0) + blackCount
  } }, { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { phase?: string; playerId?: PlayerId }
    const owner = playerOf(host.state, ownerId)
    if (phase.phase !== 'prepare' || phase.playerId !== ownerId || owner?.identity !== 'lord' || !owner.alive) return
    const state = stateOf(host)
    const level = state.b65ZhibingLevels?.[ownerId] ?? 0
    const count = state.b65ZhibingBlackUses ?? 0
    let nextLevel = level
    if (nextLevel < 1 && count >= 3) {
      gainMaxHp(host as never, ownerId, 1, MOU_DONGZHUO_ZHIBING)
      recover(host as never, ownerId, 1, ownerId)
      nextLevel = 1
    }
    if (nextLevel < 2 && count >= 6) {
      grantSkill(host.state, ownerId, 'fencheng')
      nextLevel = 2
    }
    if (nextLevel < 3 && count >= 9) {
      grantSkill(host.state, ownerId, 'benghuai')
      nextLevel = 3
    }
    if (nextLevel !== level) {
      state.b65ZhibingLevels ??= {}
      state.b65ZhibingLevels[ownerId] = nextLevel
      host.dispatch('SkillActivated', { skillId: MOU_DONGZHUO_ZHIBING, skillName: '执柄', playerId: ownerId,
        result: `threshold-${nextLevel}`, logText: `${owner.nickname}的【执柄】达到第${nextLevel}档` }, { sourceId: ownerId })
    }
  } }],
})

registerSkillRuntime({
  id: MOU_YUANSHU_JINMING,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId }
      if (data.playerId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
      const state = stateOf(host)
      state.b65JinmingOptions ??= {}
      state.b65JinmingOptions[ownerId] ??= [1, 2, 3, 4]
      if (state.b65JinmingOptions[ownerId].length)
        host.queueSkill({ skillId: MOU_YUANSHU_JINMING, ownerId, step: 'choose', data: { turnNumber: host.state.turnNumber } })
    } },
    { event: 'Recover', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId) {
        const record = stateOf(host).b65JinmingCurrent?.[ownerId]
        if (record?.turnNumber === host.state.turnNumber) record.recovered = true
      }
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const data = context.event.payload as { fromPlayerId?: PlayerId }
      const record = stateOf(host).b65JinmingCurrent?.[ownerId]
      if (data.fromPlayerId === ownerId && record?.turnNumber === host.state.turnNumber) record.discarded += 1
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const data = context.event.payload as { cardId?: CardId }
      const record = stateOf(host).b65JinmingCurrent?.[ownerId]
      const category = data.cardId ? host.state.cards[data.cardId]?.category : undefined
      if (record?.turnNumber === host.state.turnNumber && category && !record.categories.includes(category)) record.categories.push(category)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const record = stateOf(host).b65JinmingCurrent?.[ownerId]
      const amount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      if (record?.turnNumber === host.state.turnNumber) record.damage += Math.max(0, amount)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId }
      const state = stateOf(host)
      const record = state.b65JinmingCurrent?.[ownerId]
      if (data.playerId !== ownerId || !record || record.turnNumber !== host.state.turnNumber) return
      const met = record.option === 1 ? record.recovered : record.option === 2 ? record.discarded >= 2
        : record.option === 3 ? record.categories.length >= 3 : record.damage >= 4
      drawCards(host.state, host.rng, ownerId, record.option, (name, payload) => host.dispatch(name, payload))
      if (!met) state.b65JinmingOptions![ownerId] = (state.b65JinmingOptions![ownerId] ?? []).filter((option) => option !== record.option)
      delete state.b65JinmingCurrent![ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const options = stateOf(host).b65JinmingOptions?.[ownerId] ?? []
    if (!options.length) return
    host.askSkill({ skillId: MOU_YUANSHU_JINMING, ownerId, step: 'choose', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【矜名】：选择本回合的达成条件', timeoutMs: 25_000, optional: false,
        options: options.map((number) => ({ id: String(number), label: [
          '', '回复过1点体力', '弃置过两张牌', '使用过三种类别的牌', '造成过4点伤害',
        ][number]! })) }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const option = Number((response.payload as { optionId?: string }).optionId)
    const options = stateOf(host).b65JinmingOptions?.[ownerId] ?? []
    if (!options.includes(option) || Number(resolution.data.turnNumber) !== host.state.turnNumber) return
    const state = stateOf(host)
    state.b65JinmingCurrent ??= {}
    state.b65JinmingCurrent[ownerId] = {
      turnNumber: host.state.turnNumber, option, recovered: false, discarded: 0, categories: [], damage: 0,
    }
  },
})

registerSkillRuntime({
  id: MOU_YUANSHU_YANLIANG,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const lord = playerOf(host.state, ownerId)
    const contributor = phase.playerId ? playerOf(host.state, phase.playerId) : undefined
    if (phase.phase !== 'play' || !lord?.alive || lord.identity !== 'lord' || !contributor?.alive
      || contributor.id === ownerId || effectiveKingdomOf(host.state, contributor.id) !== 'qun'
      || !contributor.zones.hand.some((cardId) => host.state.cards[cardId]?.category === 'equipment')
      || usedThisPhase(host.state, contributor.id, MOU_YUANSHU_YANLIANG)) return
    host.askSkill({ skillId: MOU_YUANSHU_YANLIANG, ownerId, step: 'offer', data: { contributorId: contributor.id },
      build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: contributor.id,
        prompt: '【厌粱】：是否交给谋袁术一张装备牌，视为使用【酒】？', timeoutMs: 25_000, optional: true,
        options: [{ id: 'yes', label: '交给谋袁术并使用【酒】' }, { id: 'no', label: '不发动' }] }) })
  } }],
  resume(host, ownerId, resolution, response) {
    const contributorId = resolution.data.contributorId as PlayerId
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes'
        || !playerOf(host.state, ownerId)?.alive || playerOf(host.state, ownerId)?.identity !== 'lord') return
      const contributor = playerOf(host.state, contributorId)
      const equipment = contributor?.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === 'equipment') ?? []
      if (!contributor?.alive || !equipment.length) return
      host.askSkill({ skillId: MOU_YUANSHU_YANLIANG, ownerId, step: 'card', data: { contributorId },
        build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: contributorId,
          prompt: '【厌粱】：选择一张手牌中的装备牌交给谋袁术', timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: equipment, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step !== 'card') return
    const contributor = playerOf(host.state, contributorId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!contributor?.alive || !playerOf(host.state, ownerId)?.alive || !cardId
      || !contributor.zones.hand.includes(cardId) || host.state.cards[cardId]?.category !== 'equipment') return
    if (!giveCards(host as never, contributorId, ownerId, [cardId], MOU_YUANSHU_YANLIANG).includes(cardId)) return
    markUsedThisPhase(host.state, contributorId, MOU_YUANSHU_YANLIANG)
    host.beginVirtualBasic({ sourceId: contributorId, targetIds: [contributorId], cardName: '酒', sourceSkillId: MOU_YUANSHU_YANLIANG })
  },
})

registerSkillRuntime({
  id: MOU_YUANSHU_XIAOSHI,
  modifiesNextCardTargets(state, ownerId, _cardId, cardName) {
    const pending = stateOf({ state } as SkillHost).b65Xiaoshi?.[ownerId]
    return Boolean(pending?.pending && pending.turnNumber === state.turnNumber
      && (['杀', '闪', '桃', '酒'].includes(cardName) || INSTANT_TRICKS.has(cardName)))
  },
  nextCardTargetExpansion(state, ownerId, _cardId, cardName) {
    const pending = stateOf({ state } as SkillHost).b65Xiaoshi?.[ownerId]
    if (!pending?.pending || pending.turnNumber !== state.turnNumber
      || (!['杀', '闪', '桃', '酒'].includes(cardName) && !INSTANT_TRICKS.has(cardName))) return null
    return { maxAdditionalTargets: 1, candidateIds: state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id) }
  },
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && playerOf(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, MOU_YUANSHU_XIAOSHI)
      ? [{ id: `skill:${MOU_YUANSHU_XIAOSHI}`, label: '发动【枭噬】：下一张牌可额外指定一名目标' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MOU_YUANSHU_XIAOSHI}`) return
    askOption(host, MOU_YUANSHU_XIAOSHI, ownerId, 'invoke', '【枭噬】：是否令你下一张基本牌或普通锦囊牌额外指定一名目标（无距离限制）？', [
      { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
    ])
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const pending = stateOf(host).b65Xiaoshi?.[ownerId]
      const data = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || !pending?.pending || pending.turnNumber !== host.state.turnNumber
        || !data.cardId || (!['杀', '闪', '桃', '酒'].includes(data.cardName ?? '') && !INSTANT_TRICKS.has(data.cardName ?? ''))) return
      pending.pending = false
      pending.cardId = data.cardId
      pending.targets = [...(data.targetIds ?? [])]
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const state = stateOf(host)
      const pending = state.b65Xiaoshi?.[ownerId]
      const data = context.event.payload as { cardId?: CardId }
      if (!pending || !data.cardId || pending.cardId !== data.cardId) return
      const targets = pending.targets ?? []
      delete state.b65Xiaoshi![ownerId]
      if (cardDamageDealt(host.state, data.cardId) === 0)
        host.queueSkill({ skillId: MOU_YUANSHU_XIAOSHI, ownerId, step: 'failure', data: { targets, drawCount: state.b65JinmingCurrent?.[ownerId]?.option ?? 1 } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'failure') return
    askOption(host, MOU_YUANSHU_XIAOSHI, ownerId, 'failure-choice', '【枭噬】：此牌未造成伤害，选择一项', [
      { id: 'lose-hp', label: '失去1点体力' }, { id: 'draw', label: `令一名目标摸${Number(prompt.data.drawCount)}张牌` },
    ], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      markUsedThisPhase(host.state, ownerId, MOU_YUANSHU_XIAOSHI)
      const state = stateOf(host)
      state.b65Xiaoshi ??= {}
      state.b65Xiaoshi[ownerId] = { turnNumber: host.state.turnNumber, pending: true }
      return
    }
    const choice = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'failure-choice') {
      if (choice === 'lose-hp') loseHp(host as never, ownerId, 1, MOU_YUANSHU_XIAOSHI)
      else if (choice === 'draw') {
        const candidates = (resolution.data.targets as PlayerId[]).filter((targetId) => playerOf(host.state, targetId)?.alive)
        if (candidates.length) host.askSkill({ skillId: MOU_YUANSHU_XIAOSHI, ownerId, step: 'draw-target', data: resolution.data,
          build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【枭噬】：选择一名目标摸牌', timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1 }) })
      }
      return
    }
    if (resolution.step === 'draw-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && (resolution.data.targets as PlayerId[]).includes(targetId) && playerOf(host.state, targetId)?.alive)
        drawCards(host.state, host.rng, targetId, Number(resolution.data.drawCount), (name, payload) => host.dispatch(name, payload))
    }
  },
})

const XIONGNI_GROUP = id('xiongni-group')
function b65OwnedCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))]
}
function b65DiscardOwnedCard(host: SkillHost, ownerId: PlayerId, cardId: CardId, reason: string, sourceId: PlayerId = ownerId): boolean {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return false
  const from = owner.zones.hand.includes(cardId) ? { kind: 'hand' as const, playerId: ownerId }
    : Object.entries(owner.zones.equipment).find(([, equipped]) => equipped === cardId)
      ? { kind: 'equipment' as const, playerId: ownerId, slot: Object.entries(owner.zones.equipment).find(([, equipped]) => equipped === cardId)![0] as keyof typeof owner.zones.equipment }
      : null
  if (!from || isCardProtectedFromDiscard(host.state, ownerId, cardId, sourceId)) return false
  moveCard(host.state, cardId, from, { kind: 'discardPile' }, { discardReason: 'discard' })
  host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason }, { sourceId, cardIds: [cardId] })
  return true
}
registerGroupCardDecision(XIONGNI_GROUP, (groupHost, decision) => {
  const host = groupHost as SkillHost
  const { sourceId, suit } = decision.data as { sourceId: PlayerId; suit: string }
  const damageTargets: PlayerId[] = []
  for (const targetId of decision.playerIds) {
    const selected = (decision.responses[targetId] ?? [])[0]
    const legal = selected && b65OwnedCards(host.state, targetId).includes(selected)
      && host.state.cards[selected]?.suit === suit
      && !isCardProtectedFromDiscard(host.state, targetId, selected, sourceId)
    if (legal && b65DiscardOwnedCard(host, targetId, selected, MOU_DONGZHUO_XIONGNI, sourceId)) continue
    if (playerOf(host.state, targetId)?.alive) damageTargets.push(targetId)
  }
  if (damageTargets.length) resolveDamageSequence(host as never, {
    sourceId, targetIds: damageTargets, amount: 1, nature: 'normal', cardId: null, cardName: MOU_DONGZHUO_XIONGNI,
  })
})
registerSkillRuntime({
  id: MOU_DONGZHUO_XIONGNI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { phase?: string; playerId?: PlayerId }
    if (phase.phase === 'play' && phase.playerId === ownerId && playerOf(host.state, ownerId)?.alive)
      host.queueSkill({ skillId: MOU_DONGZHUO_XIONGNI, ownerId, step: 'invoke', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    askOption(host, MOU_DONGZHUO_XIONGNI, ownerId, 'invoke', '【凶逆】：是否弃置一张牌并令其他角色弃置同花色牌，否则受到1点伤害？', [
      { id: 'yes', label: '弃置一张牌发动' }, { id: 'no', label: '不发动' },
    ])
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidates = b65OwnedCards(host.state, ownerId).filter((cardId) => !isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId))
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_DONGZHUO_XIONGNI, ownerId, step: 'cost', data: {},
        build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【凶逆】：选择一张牌弃置', timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step !== 'cost') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !b65DiscardOwnedCard(host, ownerId, cardId, MOU_DONGZHUO_XIONGNI)) return
    const suit = host.state.cards[cardId]?.suit
    if (!suit) return
    markUsedThisPhase(host.state, ownerId, MOU_DONGZHUO_XIONGNI)
    host.dispatch('SkillActivated', { skillId: MOU_DONGZHUO_XIONGNI, skillName: '凶逆', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname ?? '董卓'}发动【凶逆】` }, { sourceId: ownerId })
    const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    startGroupCardDecision(host, { id: `${XIONGNI_GROUP}:${host.state.seq}`, tag: XIONGNI_GROUP,
      skillId: MOU_DONGZHUO_XIONGNI, playerIds: targets, prompt: '【凶逆】：秘密选择一张与指定花色相同的牌弃置；不弃置则受到1点伤害',
      cardIdsFor: (playerId) => b65OwnedCards(host.state, playerId).filter((id) => host.state.cards[id]?.suit === suit
        && !isCardProtectedFromDiscard(host.state, playerId, id, ownerId)),
      min: 0, max: 1, timeoutMs: 25_000, data: { sourceId: ownerId, suit } })
  },
})
registerSkillRuntime({
  id: MOU_TAISHICI_DOUCHAN,
  attackRangeBonus(state, ownerId) {
    return playerOf(state, ownerId)?.marks[DOUCHAN_RANGE] ?? 0
  },
  globalSlashUses(state, ownerId, targetId) {
    return ownerId === targetId ? playerOf(state, ownerId)?.marks[DOUCHAN_SLASH] ?? 0 : 0
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { phase?: string; playerId?: PlayerId }
    const owner = playerOf(host.state, ownerId)
    if (phase.phase !== 'prepare' || phase.playerId !== ownerId || !owner?.alive) return
    const duel = host.state.zones.drawPile.find((cardId) => host.state.cards[cardId]?.name === '决斗')
    if (duel) {
      moveCard(host.state, duel, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [duel], reason: MOU_TAISHICI_DOUCHAN }, { targetId: ownerId, cardIds: [duel] })
      return
    }
    owner.marks[DOUCHAN_RANGE] = (owner.marks[DOUCHAN_RANGE] ?? 0) + 1
    owner.marks[DOUCHAN_SLASH] = Math.min(host.state.players.length, (owner.marks[DOUCHAN_SLASH] ?? 0) + 1)
    host.dispatch('SkillActivated', { skillId: MOU_TAISHICI_DOUCHAN, skillName: '斗缠', playerId: ownerId,
      logText: `${owner.nickname}未从牌堆中找到【决斗】，其攻击范围与出杀次数增加` }, { sourceId: ownerId })
  } }],
})

// 谋张绣【追剿】：以真实上一张已结算牌的伤害记录判定，不以“最近一次伤害来源”代替牌结算。
registerSkillRuntime({
  id: MOU_ZHANGXIU_ZHUIJIAO,
  outgoingDamage(state, _ownerId, context) {
    if (!context.cardId || !stateOf({ state } as SkillHost).b65ZhuijiaoBonusCards?.includes(context.cardId)) return null
    return { amount: context.amount + 1 }
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; cardName?: string }
      if (context.event.sourceId !== ownerId || data.cardName !== '杀' || !data.cardId) return
      const last = stateOf(host).b65LastCard?.[ownerId]
      if (last && !last.dealtDamage) {
        const bonusCards = stateOf(host).b65ZhuijiaoBonusCards ??= []
        bonusCards.push(data.cardId)
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      }
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; cardName?: string }
      if (context.event.sourceId !== ownerId || !data.cardId) return
      const state = stateOf(host)
      const didApply = state.b65ZhuijiaoBonusCards?.includes(data.cardId) ?? false
      if (didApply) {
        state.b65ZhuijiaoBonusCards = (state.b65ZhuijiaoBonusCards ?? []).filter((cardId) => cardId !== data.cardId)
        if (data.cardName === '杀' && cardDamageDealt(host.state, data.cardId) === 0) {
          state.b65ZhuijiaoDiscardCards ??= {}
          state.b65ZhuijiaoDiscardCards[ownerId] = data.cardId
          host.queueSkill({ skillId: MOU_ZHANGXIU_ZHUIJIAO, ownerId, step: 'discard', data: { cardId: data.cardId } })
        }
      }
      state.b65LastCard ??= {}
      state.b65LastCard[ownerId] = { cardId: data.cardId, dealtDamage: cardDamageDealt(host.state, data.cardId) > 0 }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))]
      .filter((cardId) => !isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId))
    if (!candidates.length) return
    host.askSkill({ skillId: MOU_ZHANGXIU_ZHUIJIAO, ownerId, step: 'discard', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【追剿】：弃置一张牌', timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !cardId || isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId)) return
    const from = cardId && (owner.zones.hand.includes(cardId) ? { kind: 'hand' as const, playerId: ownerId }
      : Object.entries(owner.zones.equipment).find(([, equipped]) => equipped === cardId)
        ? { kind: 'equipment' as const, playerId: ownerId, slot: Object.entries(owner.zones.equipment).find(([, equipped]) => equipped === cardId)![0] as keyof typeof owner.zones.equipment }
        : null)
    if (!from) return
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: MOU_ZHANGXIU_ZHUIJIAO }, { sourceId: ownerId, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: MOU_ZHANGXIU_CHOULIE,
  limited: true,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId }
      const owner = playerOf(host.state, ownerId)
      if (data.playerId === ownerId && owner?.alive && !(owner.usedLimitedSkills ?? []).includes(MOU_ZHANGXIU_CHOULIE))
        host.queueSkill({ skillId: MOU_ZHANGXIU_CHOULIE, ownerId, step: 'choose-target', data: {} })
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId; phase?: string }
      const record = stateOf(host).b65Choulie?.[ownerId]
      const target = record && playerOf(host.state, record.targetId)
      const owner = playerOf(host.state, ownerId)
      if (!record || record.turnNumber !== host.state.turnNumber || data.playerId !== ownerId || !data.phase
        || !owner?.alive || !target?.alive || getDistance(host.state, ownerId, target.id) > getAttackRange(host.state, ownerId)
        || isTargetProhibited(host.state, ownerId, target.id, '杀', skillIdsOf)) return
      if (!b65OwnedCards(host.state, ownerId).some((cardId) => !isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId))) return
      host.queueSkill({ skillId: MOU_ZHANGXIU_CHOULIE, ownerId, step: 'phase-fire', data: {
        targetId: target.id, turnNumber: host.state.turnNumber, phase: data.phase,
      } })
    } },
  ],
  interceptSourceTargetEach(host, ownerId, context) {
    const sourceCard = host.state.cards[context.cardId]
    const record = stateOf(host).b65Choulie?.[ownerId]
    if (context.cardName !== '杀' || sourceCard?.sourceSkillId !== MOU_ZHANGXIU_CHOULIE
      || record?.turnNumber !== host.state.turnNumber || record.targetId !== context.targetId) return false
    const candidates = b65OwnedCards(host.state, context.targetId).filter((cardId) => {
      const card = host.state.cards[cardId]
      return Boolean(card && (card.category === 'basic' || card.equipmentSlot === 'weapon')
        && !isCardProtectedFromDiscard(host.state, context.targetId, cardId, ownerId))
    })
    if (!candidates.length) return false
    host.askSkill({ skillId: MOU_ZHANGXIU_CHOULIE, ownerId, step: 'target-defence', data: { targetId: context.targetId, cardId: context.cardId },
      build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: context.targetId,
        prompt: '【仇猎】：可弃置一张基本牌或武器牌，令此【杀】无效', timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1 }) })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-target') {
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      host.askSkill({ skillId: MOU_ZHANGXIU_CHOULIE, ownerId, step: 'choose-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【仇猎】：是否选择一名角色作为追杀目标？', timeoutMs: 25_000, optional: true,
          candidateIds: candidates, min: 0, max: 1 }) })
      return
    }
    if (prompt.step === 'phase-fire') askOption(host, MOU_ZHANGXIU_CHOULIE, ownerId, 'phase-fire',
      `【仇猎】：是否弃置一张牌，对${playerOf(host.state, prompt.data.targetId as PlayerId)?.nickname ?? '目标'}使用【杀】？`, [
        { id: 'yes', label: '弃置并使用【杀】' }, { id: 'no', label: '不发动' },
      ], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.usedLimitedSkills.includes(MOU_ZHANGXIU_CHOULIE)) owner?.usedLimitedSkills.push(MOU_ZHANGXIU_CHOULIE)
      owner && (owner.marks[id('choulie-used')] = 1)
      const state = stateOf(host)
      state.b65Choulie ??= {}
      state.b65Choulie[ownerId] = { targetId, turnNumber: host.state.turnNumber }
      return
    }
    if (resolution.step === 'phase-fire') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      const candidates = b65OwnedCards(host.state, ownerId).filter((cardId) => !isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId))
      if (!owner?.alive || !target?.alive || !candidates.length
        || Number(resolution.data.turnNumber) !== host.state.turnNumber
        || getDistance(host.state, ownerId, targetId) > getAttackRange(host.state, ownerId)
        || isTargetProhibited(host.state, ownerId, targetId, '杀', skillIdsOf)) return
      host.askSkill({ skillId: MOU_ZHANGXIU_CHOULIE, ownerId, step: 'phase-cost', data: resolution.data,
        build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【仇猎】：选择一张牌弃置', timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'phase-cost') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || Number(resolution.data.turnNumber) !== host.state.turnNumber
        || !b65DiscardOwnedCard(host, ownerId, cardId, MOU_ZHANGXIU_CHOULIE)) return
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: MOU_ZHANGXIU_CHOULIE, countUsage: true })
      return
    }
    if (resolution.step === 'target-defence') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const target = playerOf(host.state, targetId)
      const card = cardId ? host.state.cards[cardId] : undefined
      if (cardId && target && b65OwnedCards(host.state, targetId).includes(cardId) && card
        && (card.category === 'basic' || card.equipmentSlot === 'weapon')
        && b65DiscardOwnedCard(host, targetId, cardId, MOU_ZHANGXIU_CHOULIE, ownerId)) {
        const slash = host.state.cardResolution
        if (slash?.kind === 'slash' && slash.cardId === resolution.data.cardId && slash.targetId === targetId)
          slash.targetCancelled = true
      }
      host.resumeCardTarget()
    }
  },
})

// 谋孙坚【虎烈】：杀、决斗分开按回合记次；加伤与未造成伤害后的反击均绑定原实体牌。
registerSkillRuntime({
  id: MOU_SUNJIAN_HULIE,
  outgoingDamage(state, _ownerId, context) {
    return context.cardId && stateOf({ state } as SkillHost).b65HulieBonusCards?.includes(context.cardId)
      ? { amount: context.amount + 1 } : null
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || !data.cardId || !['杀', '决斗'].includes(data.cardName ?? '')
        || data.targetIds?.length !== 1 || data.targetIds[0] === ownerId) return
      const state = stateOf(host)
      state.b65HulieUses ??= {}
      state.b65HulieUses[ownerId] ??= {}
      if (state.b65HulieUses[ownerId][data.cardName!] === host.state.turnNumber) return
      host.queueSkill({ skillId: MOU_SUNJIAN_HULIE, ownerId, step: 'damage', data: {
        cardId: data.cardId, targetId: data.targetIds[0], cardName: data.cardName,
      } })
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId }
      const state = stateOf(host)
      const record = data.cardId ? state.b65HulieRetaliation?.[data.cardId] : undefined
      if (!record || record.ownerId !== ownerId) return
      delete state.b65HulieRetaliation![data.cardId!]
      state.b65HulieBonusCards = (state.b65HulieBonusCards ?? []).filter((cardId) => cardId !== data.cardId)
      if (cardDamageDealt(host.state, data.cardId!) > 0 || !playerOf(host.state, record.targetId)?.alive) return
      host.askSkill({ skillId: MOU_SUNJIAN_HULIE, ownerId: record.targetId, step: 'retaliate',
        data: { sourceId: ownerId, targetId: record.targetId }, build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: record.targetId,
          prompt: '【虎烈】：是否视为对谋孙坚使用一张【杀】？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '视为使用【杀】' }, { id: 'no', label: '不使用' }],
        }) })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'damage') return
    const data = prompt.data as { cardId: CardId; targetId: PlayerId; cardName: string }
    const state = stateOf(host)
    state.b65HulieUses ??= {}
    state.b65HulieUses[ownerId] ??= {}
    if (state.b65HulieUses[ownerId][data.cardName] === host.state.turnNumber) return
    host.askSkill({ skillId: MOU_SUNJIAN_HULIE, ownerId, step: 'damage', data,
      build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【虎烈】：是否令对${playerOf(host.state, data.targetId)?.nickname ?? '该角色'}使用的【${data.cardName}】伤害+1？`,
        timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '伤害+1' }, { id: 'no', label: '不发动' }] }) })
  },
  resume(host, ownerId, resolution, response) {
    const optionId = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'retaliate') {
      if (optionId !== 'yes') return
      const sourceId = resolution.data.sourceId as PlayerId
      if (playerOf(host.state, ownerId)?.alive && playerOf(host.state, sourceId)?.alive)
        host.beginVirtualBasic({ sourceId: ownerId, targetIds: [sourceId], cardName: '杀', sourceSkillId: MOU_SUNJIAN_HULIE })
      return
    }
    if (resolution.step !== 'damage') return
    const data = resolution.data as { cardId: CardId; targetId: PlayerId; cardName: string }
    const state = stateOf(host)
    state.b65HulieUses ??= {}
    state.b65HulieUses[ownerId] ??= {}
    if (state.b65HulieUses[ownerId][data.cardName] === host.state.turnNumber) return
    state.b65HulieUses[ownerId][data.cardName] = host.state.turnNumber
    if (optionId !== 'yes') return
    state.b65HulieBonusCards ??= []
    state.b65HulieBonusCards.push(data.cardId)
    state.b65HulieRetaliation ??= {}
    state.b65HulieRetaliation[data.cardId] = { ownerId, targetId: data.targetId }
  },
})

// 谋文丑【决绝】：以 CardUsed 的实际手牌来源和本回合逐目标记录判定，不把装备/场区材料算作手牌。
registerSkillRuntime({
  id: MOU_WENCHOU_JUEJUE,
  triggers: [{ event: 'TurnStart', handle(host, ownerId) {
    const state = stateOf(host)
    state.b65WenchouTargets ??= {}
    state.b65WenchouTargets[ownerId] = { turnNumber: host.state.turnNumber, counts: {} }
  } }, { event: 'CardUsed', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId
    const data = context.event.payload as { cardIds?: CardId[]; fromKind?: string; targetIds?: PlayerId[] }
    if (sourceId !== ownerId || !data.targetIds || data.targetIds.length !== 1 || data.targetIds[0] === ownerId) return
    const state = stateOf(host)
    let record = state.b65WenchouTargets?.[ownerId]
    if (!record || record.turnNumber !== host.state.turnNumber) {
      state.b65WenchouTargets ??= {}
      record = state.b65WenchouTargets[ownerId] = { turnNumber: host.state.turnNumber, counts: {} }
    }
    const targetId = data.targetIds[0]!
    record.counts[targetId] = (record.counts[targetId] ?? 0) + 1
    const owner = playerOf(host.state, ownerId)
    if (state.b65WenchouJuejueUsed?.[ownerId] === host.state.turnNumber || data.fromKind !== 'hand'
      || !data.cardIds?.length || owner?.zones.hand.length !== 0) return
    state.b65WenchouJuejueUsed ??= {}
    state.b65WenchouJuejueUsed[ownerId] = host.state.turnNumber
    const count = record.counts[targetId] ?? 1
    host.queueSkill({ skillId: MOU_WENCHOU_JUEJUE, ownerId, step: 'discard', data: { targetId, count } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const candidates = b65OwnedCards(host.state, targetId).filter((cardId) => !isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId))
    const amount = Math.min(Number(prompt.data.count), candidates.length)
    if (!amount) return
    host.askSkill({ skillId: MOU_WENCHOU_JUEJUE, ownerId, step: 'discard', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: targetId,
        prompt: `【决绝】：弃置${amount}张牌`, timeoutMs: 25_000, optional: false, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [], min: amount, max: amount }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      for (const cardId of cardIds) b65DiscardOwnedCard(host, targetId, cardId, MOU_WENCHOU_JUEJUE, ownerId)
  },
})

registerSkillRuntime({
  id: MOU_SUNJIAN_YIPO,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const state = stateOf(host)
    state.b65YipoSeen ??= {}
    state.b65YipoSeen[ownerId] = [owner.hp]
  },
  triggers: ['DamageSettled', 'Recover', 'LoseHp', 'MaxHpChange'].map((event) => ({
    event: event as 'DamageSettled' | 'Recover' | 'LoseHp' | 'MaxHpChange',
    handle(host: SkillHost, ownerId: PlayerId, context: { event: { targetId?: PlayerId } }) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.hp <= 0) return
      const state = stateOf(host)
      state.b65YipoSeen ??= {}
      state.b65YipoSeen[ownerId] ??= []
      if (state.b65YipoSeen[ownerId].includes(owner.hp)) return
      state.b65YipoSeen[ownerId].push(owner.hp)
      host.queueSkill({ skillId: MOU_SUNJIAN_YIPO, ownerId, step: 'target', data: { reachedHp: owner.hp } })
    },
  })),
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
    host.askSkill({ skillId: MOU_SUNJIAN_YIPO, ownerId, step: 'target', data: prompt.data,
      build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【毅魄】：选择一名角色（可不选）', timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 0, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const x = Math.max(1, (playerOf(host.state, ownerId)?.maxHp ?? 1) - (playerOf(host.state, ownerId)?.hp ?? 0))
      host.askSkill({ skillId: MOU_SUNJIAN_YIPO, ownerId, step: 'mode', data: { targetId, x },
        build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【毅魄】：选择一项', timeoutMs: 25_000, optional: false,
          options: [{ id: 'draw-x-discard-one', label: `其摸${x}张牌，然后弃置一张牌` },
            { id: 'draw-one-discard-x', label: `其摸一张牌，然后弃置${x}张牌` }] }) })
      return
    }
    if (resolution.step === 'mode') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode !== 'draw-x-discard-one' && mode !== 'draw-one-discard-x') return
      const x = Math.max(1, Number(resolution.data.x))
      const drawCount = mode === 'draw-x-discard-one' ? x : 1
      const discardCount = mode === 'draw-x-discard-one' ? 1 : x
      drawCards(host.state, host.rng, targetId, drawCount, (name, payload) => host.dispatch(name, payload))
      const candidates = b65OwnedCards(host.state, targetId).filter((cardId) => !isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId))
      const amount = Math.min(discardCount, candidates.length)
      if (!amount) return
      host.askSkill({ skillId: MOU_SUNJIAN_YIPO, ownerId, step: 'discard', data: { targetId, amount },
        build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: `【毅魄】：弃置${amount}张牌`, timeoutMs: 25_000, optional: false, purpose: 'skill',
          cardIds: candidates, hiddenCardSlots: [], min: amount, max: amount }) })
      return
    }
    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      for (const cardId of cardIds) b65DiscardOwnedCard(host, targetId, cardId, MOU_SUNJIAN_YIPO, ownerId)
    }
  },
})

registerSkillRuntime({
  id: MOU_WENCHOU_LUNZHAN,
  activeActions(state, ownerId) {
    const record = stateOf({ state } as SkillHost).b65Lunzhan?.[ownerId]
    return state.phase === 'play' && state.currentPlayerId === ownerId && playerOf(state, ownerId)?.alive
      && Boolean(playerOf(state, ownerId)?.zones.hand.length)
      && (!record || record.turnNumber !== state.turnNumber || record.usedTargets.length < state.players.length)
      ? [{ id: `skill:${MOU_WENCHOU_LUNZHAN}`, label: '轮战：将1至5张手牌当【决斗】使用' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MOU_WENCHOU_LUNZHAN}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({ skillId: MOU_WENCHOU_LUNZHAN, ownerId, step: 'cards', data: {},
      build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【轮战】：选择1至5张手牌当【决斗】使用', timeoutMs: 25_000, optional: false, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: Math.min(5, owner.zones.hand.length) }) })
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId }
      if (data.playerId === ownerId) {
        const state = stateOf(host)
        state.b65Lunzhan ??= {}
        state.b65Lunzhan[ownerId] = { turnNumber: host.state.turnNumber, usedTargets: [], counts: {} }
      }
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const data = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const state = stateOf(host)
      state.b65Lunzhan ??= {}
      let record = state.b65Lunzhan[ownerId]
      if (!record || record.turnNumber !== host.state.turnNumber)
        record = state.b65Lunzhan[ownerId] = { turnNumber: host.state.turnNumber, usedTargets: [], counts: {} }
      for (const targetId of data.targetIds ?? []) record.counts[targetId] = (record.counts[targetId] ?? 0) + 1
      if (data.cardName === '决斗' && data.cardId && (record.pendingCards ?? []).length) {
        record.pendingDuel = { cardId: data.cardId, targetId: data.targetIds?.[0] ?? '' }
        record.pendingCards = undefined
      }
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId }
      const state = stateOf(host)
      const record = state.b65Lunzhan?.[ownerId]
      const pending = record?.pendingDuel
      if (!record || !pending || !data.cardId || pending.cardId !== data.cardId) return
      record.pendingDuel = undefined
      if (cardDamageDealt(host.state, data.cardId) <= 0) return
      if (!record.usedTargets.includes(pending.targetId)) record.usedTargets.push(pending.targetId)
      host.queueSkill({ skillId: MOU_WENCHOU_LUNZHAN, ownerId, step: 'draw-offer', data: {
        targetId: pending.targetId, count: record.counts[pending.targetId] ?? 1,
      } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'draw-offer') askOption(host, MOU_WENCHOU_LUNZHAN, ownerId, 'draw-offer',
      `【轮战】：是否摸${Number(prompt.data.count)}张牌？`, [
        { id: 'yes', label: '摸牌' }, { id: 'no', label: '不摸' },
      ], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cards') {
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const owner = playerOf(host.state, ownerId)
      const record = stateOf(host).b65Lunzhan?.[ownerId]
      if (!owner?.alive || !record || record.turnNumber !== host.state.turnNumber || !cardIds.length || cardIds.length > 5
        || cardIds.some((cardId) => !owner.zones.hand.includes(cardId)
          || isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId))) return
      const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
        && !record.usedTargets.includes(target.id) && !isTargetProhibited(host.state, ownerId, target.id, '决斗', skillIdsOf))
        .map((target) => target.id)
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_WENCHOU_LUNZHAN, ownerId, step: 'target', data: { cardIds },
        build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【轮战】：选择一名【决斗】目标', timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'target') {
      const cardIds = resolution.data.cardIds as CardId[]
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = playerOf(host.state, ownerId)
      const record = stateOf(host).b65Lunzhan?.[ownerId]
      if (!owner?.alive || !record || record.turnNumber !== host.state.turnNumber || !targetId
        || !playerOf(host.state, targetId)?.alive || record.usedTargets.includes(targetId)
        || isTargetProhibited(host.state, ownerId, targetId, '决斗', skillIdsOf) || cardIds.length < 1 || cardIds.length > 5
        || cardIds.some((cardId) => !owner.zones.hand.includes(cardId))) return
      record.pendingCards = [...cardIds]
      for (const cardId of cardIds) if (!b65DiscardOwnedCard(host, ownerId, cardId, MOU_WENCHOU_LUNZHAN)) return
      record.pendingCards = [...cardIds]
      const started = host.beginVirtualTrick({ sourceId: ownerId, targetId, cardName: '决斗', sourceSkillId: MOU_WENCHOU_LUNZHAN, extraCardIds: cardIds })
      if (!started) record.pendingCards = undefined
      return
    }
    if (resolution.step === 'draw-offer' && (response.payload as { optionId?: string }).optionId === 'yes')
      drawCards(host.state, host.rng, ownerId, Number(resolution.data.count), (name, payload) => host.dispatch(name, payload))
  },
})

// 界张松直接复用已验证的强识、献图运行时；其余技能在下方分别接入批次引擎。
export const HISTORICAL_BATCH65_CHARACTERS: readonly CharacterDefinition[] = [
  JIE_XIAHOU_SHI_B65, JIE_GUO_HUANGHOU_B65, JIE_ZHANGSONG_B65,
  MOU_TAISHICI_B65, MOU_DONGZHUO_B65, MOU_SUNJIAN_B65, MOU_KONGRONG_B65, MOU_YUANSHU_B65, MOU_ZHANGXIU_B65, MOU_WENCHOU_B65,
]
