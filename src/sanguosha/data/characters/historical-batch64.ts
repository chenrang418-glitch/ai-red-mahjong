// 武将册第64批新增十将：序号864–866、868–874；序号867已在第39批登记并在该批更正名称。
// 国战专属的756–863按项目既定收录范围暂不接入。
import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { getAttackRange, getDistance } from '../../engine/distance'
import { drawCards } from '../../engine/draw'
import { effectiveCardColor, getSkillRuntime, isCardProtectedFromDiscard, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { resumeTargetDamagePrevention } from '../../engine/damage'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { giveCards, swapHands } from '../../engine/hand-transfer'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { handleEquipmentLost } from '../../engine/equipment'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { startGroupDecision, registerGroupDecision } from '../../engine/group-decision'
import { movePickedCard } from '../../engine/card-pick'
import { flipCharacter } from '../../engine/character-state'
import { recover } from '../../engine/recover'
import { QIAOBIAN } from './mountain-zhanghe'
import { JIE_TAISHICI_B64 } from './fire-taishici'

type Batch64State = SanguoshaState & { batch64?: Record<string, any> }
const stateOf = (host: SkillHost) => host.state as Batch64State
const playerOf = (state: SanguoshaState, id: PlayerId) => state.players.find((player) => player.id === id)
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown>) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional: true, options }) })
}

// 标袁术【妄尊】【同疾】。
const WANGZUN_B64 = 'wangzun-b64'
const TONGJI_B64 = 'tongji-b64'
registerSkillRuntime({
  id: WANGZUN_B64,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const { playerId: lordId, phase } = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    if (phase !== 'prepare' || !lordId || lordId === ownerId || !owner?.alive) return
    const lord = playerOf(host.state, lordId)
    if (!lord?.alive || lord.identity !== 'lord') return
    askOption(host, WANGZUN_B64, ownerId, 'invoke', `【妄尊】：是否于${lord.nickname}的准备阶段摸一张牌并令其本回合手牌上限-1？`, [
      { id: 'yes', label: '摸一张牌并令其手牌上限-1' }, { id: 'no', label: '不发动' },
    ], { lordId })
  } }],
  resume(host, ownerId, resolution, response) {
    if ((response.payload as any).optionId !== 'yes') return
    const lordId = resolution.data.lordId as PlayerId
    const lord = playerOf(host.state, lordId)
    if (!playerOf(host.state, ownerId)?.alive || !lord?.alive || lord.identity !== 'lord') return
    const cardIds = drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    if (cardIds.length) host.dispatch('GainCard', { playerId: ownerId, cardIds, reason: WANGZUN_B64 }, { targetId: ownerId, cardIds })
    const state = stateOf(host)
    state.batch64 ??= {}
    state.batch64[`wangzun:${ownerId}`] = { lordId, turnNumber: host.state.turnNumber }
  },
  globalMaxCardsBonus(state, ownerId, targetId) {
    const record = (state as Batch64State).batch64?.[`wangzun:${ownerId}`]
    return record?.lordId === targetId && record.turnNumber === state.turnNumber && state.currentPlayerId === targetId ? -1 : 0
  },
})
registerSkillRuntime({
  id: TONGJI_B64,
  globalProhibitsSourceTarget(state, ownerId, sourceId, targetId, cardName) {
    if (cardName !== '杀' || sourceId === ownerId || targetId === ownerId) return false
    const owner = playerOf(state, ownerId)
    const source = playerOf(state, sourceId)
    return Boolean(owner?.alive && source?.alive && owner.zones.hand.length > owner.hp
      && getDistance(state, sourceId, ownerId) <= getAttackRange(state, sourceId))
  },
})
export const BIAO_YUANSHU_B64: CharacterDefinition = {
  id: 'biao-yuanshu-b64', name: '标袁术', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: WANGZUN_B64, name: '妄尊', description: '主公的准备阶段，你可以摸一张牌，然后令其本回合手牌上限-1。' },
    { id: TONGJI_B64, name: '同疾', description: '锁定技，若你的手牌数大于体力值，攻击范围包含你的其他角色使用【杀】不能指定除你外的角色为目标。', locked: true },
  ],
}

// 界徐庶：复用同文本SP版的诛害、潜心觉醒及荐言完整流程。
export const JIE_XUSHU_B64: CharacterDefinition = {
  id: 'jie-xushu-b64', name: '界·徐庶', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: 'zhuhai-sp-b39', name: '诛害', description: '其他角色的结束阶段，若该角色于此回合内造成过伤害，则你可以对其使用一张无距离限制的【杀】。' },
    { id: 'qianxin-sp-b39', name: '潜心', description: '觉醒技，当你造成伤害后，若你已受伤，你减1点体力上限，然后获得“荐言”。' },
    { id: 'jianyan-sp-b39', name: '荐言', granted: true, description: '出牌阶段限一次，你可以选择一种牌的类别或颜色，然后亮出牌堆顶的一张牌，若此牌不为此类别或颜色，你重复此流程。你令一名男性角色获得最后亮出的牌，然后将其余亮出的牌置入弃牌堆。' },
  ],
}

// 界李典：恂恂与忘隙在登记版与现有完整运行时一致。
export const JIE_LIDIAN_B64: CharacterDefinition = {
  id: 'jie-lidian-b64', name: '界·李典', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: 'xunxun', name: '恂恂', description: '摸牌阶段开始时，你可以观看牌堆顶的四张牌，然后将其中两张牌置于牌堆顶，将剩余牌置于牌堆底。' },
    { id: 'wangxi', name: '忘隙', description: '当你对其他角色造成1点伤害后，或受到其他角色的1点伤害后，你可以摸两张牌并交给该角色其中一张牌。' },
  ],
}

// 界贾诩【帷幕】：经典帷幕目标禁止 + 自己回合内防止所有伤害并摸两倍牌数。
const WEIMU_JIE_B64 = 'weimu-jie-b64'
const DELAYED_TRICK_NAMES_B64 = new Set(['乐不思蜀', '兵粮寸断', '闪电'])
registerSkillRuntime({
  id: WEIMU_JIE_B64,
  prohibitsTarget(state, ownerId, _sourceId, cardName, cardId) {
    const owner = playerOf(state, ownerId)
    const isTrick = INSTANT_TRICKS.has(cardName) || DELAYED_TRICK_NAMES_B64.has(cardName)
    return Boolean(owner?.alive && isTrick && cardId && effectiveCardColor(state, ownerId, cardId) === 'black')
  },
  offersTargetDamagePreventionAsk(host, ownerId, context) {
    if (context.targetId !== ownerId || host.state.currentPlayerId !== ownerId || context.amount <= 0
      || !playerOf(host.state, ownerId)?.alive) return false
    host.queueSkill({ skillId: WEIMU_JIE_B64, ownerId, step: 'prevent', data: { amount: context.amount } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'prevent') return
    const amount = Math.max(0, Number(prompt.data.amount) || 0)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.currentPlayerId !== ownerId || amount <= 0) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    const cardIds = drawCards(host.state, host.rng, ownerId, amount * 2, (name, payload) => host.dispatch(name, payload))
    if (cardIds.length) host.dispatch('GainCard', { playerId: ownerId, cardIds, reason: WEIMU_JIE_B64 }, { targetId: ownerId, cardIds })
    resumeTargetDamagePrevention(host as never, true, WEIMU_JIE_B64)
  },
})
const wanshaRuntime = getSkillRuntime('wansha')
if (!wanshaRuntime) throw new Error('界贾诩依赖的【完杀】基础运行时未注册')
wanshaRuntime.globallyInvalidatesOtherSkills = (state, ownerId, targetId) => {
  if (playerOf(state, ownerId)?.characterId !== 'jie-jiaxu-b64' || state.currentPlayerId !== ownerId) return false
  const dyingId = state.dying?.playerId
  return Boolean(dyingId && targetId !== ownerId && targetId !== dyingId)
}

export const JIE_JIA_XU_B64: CharacterDefinition = {
  id: 'jie-jiaxu-b64', name: '界·贾诩', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'forest',
  skills: [
    { id: WEIMU_JIE_B64, name: '帷幕', description: '锁定技，你不能成为黑色锦囊牌的目标；你的回合内，你防止受到的伤害，然后摸等量的两倍张牌。', locked: true },
    { id: 'luanwu', name: '乱武', description: '限定技，出牌阶段，你可以令所有其他角色依次选择一项：对其距离最小的另一名角色使用一张【杀】，或失去1点体力。所有角色结算完毕后，你可以视为使用一张无距离限制的【杀】。' },
    { id: 'wansha', name: '完杀', description: '锁定技，在你的回合内，只有你和处于濒死状态的角色才能使用【桃】；任意角色的濒死结算中，除你和濒死角色外的其他角色的非锁定技失效。', locked: true },
  ],
}

// 界鲁肃【好施】附加的受牌窗口：发动好施并交牌后持续到其下回合开始。
const HAOSHI_JIE_B64 = 'haoshi'
const HAOSHI_WINDOW = 'batch64-haoshi-window'
const haoshiRuntime = getSkillRuntime(HAOSHI_JIE_B64)
if (!haoshiRuntime) throw new Error('界鲁肃依赖的【好施】基础运行时未注册')
const baseHaoshiResume = haoshiRuntime.resume?.bind(haoshiRuntime)
haoshiRuntime.triggers = [
    ...(haoshiRuntime.triggers ?? []),
    { event: 'CardGiven', handle(host, ownerId, context) {
      if (playerOf(host.state, ownerId)?.characterId !== 'jie-lusu-b64') return
      const payload = context.event.payload as { fromId?: PlayerId; reason?: string }
      if (payload.fromId !== ownerId || payload.reason !== 'haoshi') return
      const state = stateOf(host)
      state.batch64 ??= {}
      state.batch64[`${HAOSHI_WINDOW}:${ownerId}`] = true
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if (playerOf(host.state, ownerId)?.characterId !== 'jie-lusu-b64') return
      const turnOwner = (context.event.payload as { playerId?: PlayerId }).playerId
      if (turnOwner === ownerId) delete stateOf(host).batch64?.[`${HAOSHI_WINDOW}:${ownerId}`]
    } },
  ]
haoshiRuntime.interceptTarget = (host, ownerId, context) => {
    if (playerOf(host.state, ownerId)?.characterId !== 'jie-lusu-b64') return false
    if (context.targetId !== ownerId || !stateOf(host).batch64?.[`${HAOSHI_WINDOW}:${ownerId}`]
      || context.sourceId === ownerId) return false
    if (context.cardName !== '杀' && !(context.category === 'trick' && !['乐不思蜀', '兵粮寸断', '闪电'].includes(context.cardName))) return false
    const source = playerOf(host.state, context.sourceId)
    const owner = playerOf(host.state, ownerId)
    if (!source?.alive || !source.zones.hand.length || !owner?.alive) return false
    host.askSkill({ skillId: HAOSHI_JIE_B64, ownerId, step: 'give-choice', data: { sourceId: context.sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: context.sourceId, prompt: `【好施】：是否交给${owner.nickname}一张手牌？`, timeoutMs: 20_000, optional: true,
      options: [{ id: 'give', label: '交给其一张手牌' }, { id: 'keep', label: '不交' }],
    }) })
    return true
  }
haoshiRuntime.resume = (host, ownerId, resolution, response) => {
    if (playerOf(host.state, ownerId)?.characterId !== 'jie-lusu-b64'
      || !['jie-give-choice', 'jie-give-card'].includes(resolution.step)) {
      baseHaoshiResume?.(host, ownerId, resolution, response)
      return
    }
    const sourceId = resolution.data.sourceId as PlayerId
    if (resolution.step === 'jie-give-choice') {
      if ((response.payload as any).optionId !== 'give') { host.resumeCardTarget(); return }
      const source = playerOf(host.state, sourceId)
      if (!source?.alive || !source.zones.hand.length || !playerOf(host.state, ownerId)?.alive) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: HAOSHI_JIE_B64, ownerId, step: 'jie-give-card', data: { sourceId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: sourceId, prompt: `【好施】：选择交给${playerOf(host.state, ownerId)?.nickname ?? '鲁肃'}的一张手牌`,
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...source.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'jie-give-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (cardId) giveCards(host, sourceId, ownerId, [cardId], HAOSHI_JIE_B64)
      host.resumeCardTarget()
    }
  }

// 界鲁肃【缔盟】：先换手牌；出牌阶段结束弃置交换前的手牌数差。
const DIMENG_JIE_B64 = 'dimeng-jie-b64'
function allOwnedCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)), ...owner.zones.judgingArea] : []
}
function askDimengTargets(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId)
  host.askSkill({ skillId: DIMENG_JIE_B64, ownerId, step: 'targets', data: {}, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【缔盟】：选择两名其他角色交换手牌', timeoutMs: 25_000, optional: true,
    candidateIds: candidates.map((target) => target.id), min: 0, max: 2,
  }) })
}
registerSkillRuntime({
  id: DIMENG_JIE_B64,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, DIMENG_JIE_B64)) return []
    const targets = state.players.filter((target) => target.alive && target.id !== ownerId)
    const cardCount = allOwnedCards(state, ownerId).length
    const hasPair = targets.some((left, index) => targets.slice(index + 1).some((right) => Math.abs(left.zones.hand.length - right.zones.hand.length) <= cardCount))
    return hasPair ? [{ id: `skill:${DIMENG_JIE_B64}`, label: '发动【缔盟】：交换两名其他角色的手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${DIMENG_JIE_B64}`) throw new Error('界鲁肃【缔盟】动作不匹配')
    askDimengTargets(host, ownerId)
  },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'play') return
    const record = stateOf(host).batch64?.[`dimeng:${ownerId}`]
    if (!record || record.turnNumber !== host.state.turnNumber) return
    const candidates = allOwnedCards(host.state, ownerId)
    const count = Math.min(record.discardCount, candidates.length)
    if (!count) return
    host.askSkill({ skillId: DIMENG_JIE_B64, ownerId, step: 'discard', data: { count }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【缔盟】：弃置${count}张牌（手牌数差）`, timeoutMs: 25_000,
      optional: false, purpose: 'discard-phase', cardIds: candidates, hiddenCardSlots: [], min: count, max: count,
    }) })
    delete stateOf(host).batch64?.[`dimeng:${ownerId}`]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (ids.length === 0) return
      const [leftId, rightId] = ids
      const owner = playerOf(host.state, ownerId)
      const left = playerOf(host.state, leftId)
      const right = playerOf(host.state, rightId)
      if (!owner?.alive || !left?.alive || !right?.alive || leftId === rightId) return
      const difference = Math.abs(left.zones.hand.length - right.zones.hand.length)
      if (difference > allOwnedCards(host.state, ownerId).length) return
      markUsedThisPhase(host.state, ownerId, DIMENG_JIE_B64)
      swapHands(host, leftId, rightId, DIMENG_JIE_B64)
      const state = stateOf(host)
      state.batch64 ??= {}
      state.batch64[`dimeng:${ownerId}`] = { discardCount: difference, turnNumber: host.state.turnNumber }
      host.dispatch('SkillActivated', { skillId: DIMENG_JIE_B64, skillName: '缔盟', playerId: ownerId, targetIds: ids, logText: `${owner.nickname}发动【缔盟】，交换${left.nickname}与${right.nickname}的手牌` }, { sourceId: ownerId, targetId: leftId })
      return
    }
    if (resolution.step !== 'discard') return
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const amount = resolution.data.count as number
    const valid = [...new Set(selected)].filter((id) => allOwnedCards(host.state, ownerId).includes(id)).slice(0, amount)
    for (const cardId of valid) {
      const zone = locateOwnedCard(host.state, ownerId, cardId)
      if (!zone) continue
      moveCard(host.state, cardId, zone, { kind: 'discardPile' })
      if (zone.kind === 'equipment') handleEquipmentLost(host as never, ownerId, cardId)
    }
    if (valid.length) host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: DIMENG_JIE_B64 }, { sourceId: ownerId, cardIds: valid })
  },
})

export const JIE_LUSU_B64: CharacterDefinition = {
  id: 'jie-lusu-b64', name: '界·鲁肃', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'forest',
  skills: [
    { id: 'haoshi', name: '好施', description: '摸牌阶段，你可以多摸两张牌，然后若你的手牌数大于5，你将一半的手牌（向下取整）交给手牌最少的一名其他角色；此后直到你的下回合开始，当你成为【杀】或普通锦囊牌的目标后，其可以交给你一张手牌。' },
    { id: DIMENG_JIE_B64, name: '缔盟', description: '出牌阶段限一次，你可以令两名其他角色交换手牌（两者手牌数之差不大于你的牌数量），若如此做，出牌阶段结束时，你弃置X张牌（X为交换前两者手牌数之差）。' },
  ],
}

// 界张郃【巧变】与山包技能共用同一阶段跳过/场上移牌流程；界限差异已在其运行时适配。
export const JIE_ZHANGHE_B64: CharacterDefinition = {
  id: 'jie-zhanghe-b64', name: '界·张郃', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'mountain',
  skills: [{ id: QIAOBIAN, name: '巧变', description: '游戏开始时，你获得2枚“变”标记。你可以弃置一张牌或移除1枚“变”，跳过你的一个阶段（准备阶段和结束阶段除外）：若跳过摸牌阶段，你可以获得至多两名角色各一张手牌；若跳过出牌阶段，你可以移动场上的一张牌。结束阶段，若你的手牌数与之前你每回合结束阶段的手牌数均不相等，你获得1枚“变”。' }],
}

// 界张春华【翦灭】：双色由双方同时秘密选择，再按弃牌数决定虚拟【决斗】来源。
const JIANMIE_B64 = 'jianmie-jie-b64'
const JIANMIE_GROUP = 'jianmie-jie-b64-color-choices'
const GROUP_TAG = 'batch64-jianmie'
registerGroupDecision(GROUP_TAG, (groupHost, decision) => {
  const host = groupHost as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  const otherId = decision.data.otherId as PlayerId
  const choices = decision.responses
  const discardedCounts: Record<PlayerId, number> = {}
  for (const playerId of [ownerId, otherId]) {
    const selectedColor = choices[playerId]
    const hand = playerOf(host.state, playerId)?.zones.hand ?? []
    const toDiscard = hand.filter((cardId) => effectiveCardColor(host.state, playerId, cardId) === selectedColor
      && !isCardProtectedFromDiscard(host.state, playerId, cardId, ownerId))
    for (const cardId of toDiscard) moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
    discardedCounts[playerId] = toDiscard.length
    if (toDiscard.length) host.dispatch('LoseCard', { playerId, cardIds: toDiscard, reason: JIANMIE_B64 }, { sourceId: playerId, cardIds: toDiscard })
  }
  const owner = playerOf(host.state, ownerId)
  const other = playerOf(host.state, otherId)
  if (!owner?.alive || !other?.alive || discardedCounts[ownerId] === discardedCounts[otherId]) return
  const sourceId = discardedCounts[ownerId] > discardedCounts[otherId] ? ownerId : otherId
  const targetId = sourceId === ownerId ? otherId : ownerId
  host.beginVirtualTrick({ sourceId, targetId, cardName: '决斗', sourceSkillId: JIANMIE_B64 })
})
registerSkillRuntime({
  id: JIANMIE_B64,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, JIANMIE_B64)
      && playerOf(state, ownerId)?.alive && state.players.some((target) => target.alive && target.id !== ownerId)
      ? [{ id: `skill:${JIANMIE_B64}`, label: '发动【翦灭】：与一名角色同时选择颜色' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIANMIE_B64}`) throw new Error('【翦灭】动作不匹配')
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId).map((target) => target.id)
    host.askSkill({ skillId: JIANMIE_B64, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【翦灭】：选择一名其他角色', timeoutMs: 20_000,
      optional: true, candidateIds: candidates, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const otherId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!otherId || !playerOf(host.state, otherId)?.alive) return
    markUsedThisPhase(host.state, ownerId, JIANMIE_B64)
    startGroupDecision(host, {
      id: `${JIANMIE_GROUP}:${host.state.seq}`, tag: GROUP_TAG, skillId: JIANMIE_B64,
      playerIds: [ownerId, otherId], prompt: '【翦灭】：秘密选择一种颜色；然后你弃置所有此颜色手牌',
      options: [{ id: 'red', label: '红色' }, { id: 'black', label: '黑色' }],
      defaultOptionId: 'red', timeoutMs: 25_000, data: { ownerId, otherId },
    })
  },
})

export const JIE_ZHANGCHUNHUA_B64: CharacterDefinition = {
  id: 'jie-zhangchunhua-b64', name: '界·张春华', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'yjcm2011',
  skills: [
    { id: 'jueqing', name: '绝情', description: '锁定技，你即将造成的伤害视为失去体力。', locked: true },
    { id: 'shangshi', name: '伤逝', description: '当你的手牌数小于X后，你可以将手牌摸至X张（X为你已损失的体力值）。' },
    { id: JIANMIE_B64, name: '翦灭', description: '出牌阶段限一次，你可与一名其他角色同时选择一种颜色，你与其弃置各自选择颜色的手牌，然后弃置牌较多的角色视为对另一角色使用【决斗】。' },
  ],
}

// 界曹冲【仁心】：进入濒死时直接回复至1点体力，和旧版受伤害前防止伤害区分。
const RENXIN_JIE_B64 = 'renxin-jie-b64'
registerSkillRuntime({
  id: RENXIN_JIE_B64,
  triggers: [{ event: 'EnterDying', handle(host, ownerId, context) {
    const targetId = context.event.targetId
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || owner.characterId !== 'jie-caochong-b64' || !target?.alive || targetId === ownerId) return
    const equipment = [...owner.zones.hand.filter((id) => host.state.cards[id]?.category === 'equipment'),
      ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (!equipment.length) return
    host.queueSkill({ skillId: RENXIN_JIE_B64, ownerId, step: 'invoke', data: { targetId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const targetId = prompt.data.targetId as PlayerId
    if (host.state.dying?.playerId !== targetId || !playerOf(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: RENXIN_JIE_B64, ownerId, step: 'invoke', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【仁心】：是否弃置一张装备牌并翻面，令${playerOf(host.state, targetId)?.nickname ?? '该角色'}回复至1点体力？`,
      timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '弃置装备并翻面，回复至1点' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || host.state.dying?.playerId !== targetId) return
      const owner = playerOf(host.state, ownerId)
      const candidates = owner ? [...owner.zones.hand.filter((id) => host.state.cards[id]?.category === 'equipment'),
        ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (!candidates.length) return
      host.askSkill({ skillId: RENXIN_JIE_B64, ownerId, step: 'cost', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【仁心】：选择弃置一张装备牌', timeoutMs: 20_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'cost' || host.state.dying?.playerId !== targetId) return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const candidates = owner ? [...owner.zones.hand.filter((id) => host.state.cards[id]?.category === 'equipment'),
      ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    if (!owner?.alive || !target?.alive || !cardId || !candidates.includes(cardId)
      || !movePickedCard(host as never, ownerId, cardId, { kind: 'discardPile' })) return
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: RENXIN_JIE_B64 }, { sourceId: ownerId, cardIds: [cardId] })
    flipCharacter(host as never, ownerId, RENXIN_JIE_B64)
    if (target.hp < 1) recover(host as never, targetId, 1 - target.hp, ownerId)
  },
})

export const JIE_CAOCHONG_B64: CharacterDefinition = {
  id: 'jie-caochong-b64', name: '界·曹冲', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'yjcm2013',
  skills: [
    { id: 'chengxiang', name: '称象', description: '当你受到1点伤害后，你可以亮出牌堆顶四张牌，获得其中任意张点数和不大于13的牌；若获得的牌点数和恰好为13，你下次发动“称象”多亮出一张牌。' },
    { id: RENXIN_JIE_B64, name: '仁心', description: '当一名其他角色进入濒死时，你可以弃置一张装备牌并翻面，然后令其回复至1点体力。' },
  ],
}

export const JIE_CHENGONG_B64: CharacterDefinition = {
  id: 'jie-chengong-b64', name: '界·陈宫', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'yjcm2011',
  skills: [
    { id: 'zhichi', name: '智迟', description: '锁定技，当你于回合外受到伤害后，本回合【杀】和普通锦囊牌对你无效。', locked: true },
    { id: 'mingce', name: '明策', description: '出牌阶段限一次，你可以交给一名其他角色一张【杀】或装备牌，然后其选择一项：1.视为对你选择的另一名角色使用一张【杀】，若造成伤害，你与其各摸一张牌；2.你与其各摸一张牌。' },
  ],
}

// 其余武将实现完成后再整体并入标准注册池。
export const HISTORICAL_BATCH64_CHARACTERS: readonly CharacterDefinition[] = [
  BIAO_YUANSHU_B64, JIE_XUSHU_B64, JIE_LIDIAN_B64, JIE_TAISHICI_B64, JIE_JIA_XU_B64,
  JIE_LUSU_B64, JIE_ZHANGHE_B64, JIE_CHENGONG_B64, JIE_ZHANGCHUNHUA_B64, JIE_CAOCHONG_B64,
]
