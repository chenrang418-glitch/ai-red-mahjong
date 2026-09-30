import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { effectiveCardColor, registerSkillRuntime, grantSkill, type SkillHost, type TargetedCardContext } from '../../engine/skills/runtime'
import { startGroupCardDecision, registerGroupCardDecision } from '../../engine/group-card-decision'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { moveCard } from '../../engine/zones'
import { locateOwnedCard } from '../../engine/zones'
import { discardCardsByIds } from '../../engine/discard-all'
import { isLockedSkill } from '../../engine/locked-skills'
import { getCharacter, responseViewAsOptions, skillIdsOf } from './standard'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { addSlashUseQuota } from '../../engine/slash-rules'
import { canUseSlash, grantTurnSlashBonus, revokeTurnSlashBonus } from '../../engine/slash-rules'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { giveCards } from '../../engine/hand-transfer'
import { queueExtraPhaseAfterTurnEnd } from '../../engine/extra-phase'
import { effectiveKingdomOf } from '../../engine/huashen'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { handleEquipmentLost } from '../../engine/equipment'
import { canTarget } from '../../engine/distance'
import { discardAllCards } from '../../engine/discard-all'
import { hiddenHandSlot } from '../../engine/cards/host'
import { movePickedCard, resolvePickedCard } from '../../engine/card-pick'
import { pickableCardsOf } from '../../engine/card-pick'

const id = (name: string) => `${name}:b91`
const ZY_LONG = id('longlin-flash-zhaoyun'), ZY_DAN = id('zhendan-flash-zhaoyun')
const LH_CHAO = id('chaozheng-flash-liuhong'), LH_CHONG = id('shenchong-flash-liuhong'), LH_JU = id('julian-flash-liuhong')
const LH_FEI = id('feiyang-granted'), LH_BA = id('bahu-granted')
const ZL_ZHENG = id('zhengbing-flash-zhangliao'), ZL_TU = id('tuwei-flash-zhangliao')
const SJ_PING = id('pingtao-flash-sunjian'), SJ_JUE = id('juelie-flash-sunjian')
const ZJ_FEN = id('fendi-flash-zhujun'), ZJ_JU = id('jujiang-flash-zhujun')
const XG_DUN = id('dunji-clan-xunguan'), XG_YUN = id('yunying-clan-xunguan'), XG_DAO = id('daojie-clan-xunguan-b91')

export const FLASH_BATCH91_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'flash-zhaoyun-b91', name: '闪·赵云', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZY_LONG, name: '龙临', description: '当其他角色于其出牌阶段首次使用【杀】指定目标后，你可以弃置一张牌令此【杀】无效，然后其可以视为对你使用一张【决斗】，你以此法造成伤害后，其本阶段使用的下一张牌不能指定其他角色为目标。' },
    { id: ZY_DAN, name: '镇胆', description: '你可以将一张非基本手牌当本轮你未使用过的基本牌使用或打出；当你受到伤害后或每轮结束时，你摸X张牌，此技能本轮失效（X为本轮所有角色执行过的回合数且至多为5）。' },
  ] },
  { id: 'flash-liuhong-b91', name: '闪·刘宏', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: LH_CHAO, name: '朝争', description: '出牌阶段开始时，你可与所有其他角色进行议事，若议事结果为红色，意见为红色的角色各回复1点体力；若为黑色，意见为红色的其他角色各失去1点体力。议事完成后你摸X张牌（X为议事意见与你相同的角色数且至多为2）。你参与议事的意见始终视为+1。' },
    { id: LH_CHONG, name: '甚宠', description: '限定技，准备阶段，你可令一名其他角色获得“飞扬”“跋扈”。若如此做，当你死亡时，杀死你的角色弃置所有牌，因此获得技能的角色失去所有技能。' },
    { id: LH_JU, name: '聚敛', description: '主公技，其他群势力角色的回合限一次，当其于摸牌阶段外不因此技能摸牌后，可摸一张牌；结束阶段，你可以获得所有其他群势力角色各一张手牌。' },
    { id: LH_FEI, name: '飞扬', granted: true, description: '判定阶段开始时，若你的判定区有牌，你可以弃置两张牌，然后弃置你判定区里的一张牌。' },
    { id: LH_BA, name: '跋扈', granted: true, description: '锁定技，准备阶段开始时，你摸一张牌；出牌阶段使用【杀】的次数上限+1。' },
  ] },
  { id: 'flash-zhangliao-b91', name: '闪·张辽', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZL_ZHENG, name: '整兵', description: '群势力技，出牌阶段限三次，你可以重铸一张牌，若此牌为【杀】，你的手牌上限+1；【闪】，你摸一张牌；【桃】或【酒】，此回合结束时，你执行一个额外的出牌阶段。然后若你以此法触发过所有选项，你变更势力至魏。' },
    { id: ZL_TU, name: '突围', description: '魏势力技，出牌阶段开始时，你可以获得攻击范围内任意角色各一张牌，然后回合结束时，其中本回合未受到伤害的角色各获得你一张牌。' },
  ] },
  { id: 'flash-sunjian-b91', name: '闪·孙坚', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SJ_PING, name: '平讨', description: '出牌阶段限一次，你可以令一名其他角色选择一项：其交给你一张牌，然后你本回合使用的下一张【杀】可以多指定一个目标；或你视为对其使用一张【杀】（有次数限制）。' },
    { id: SJ_JUE, name: '绝烈', description: '当你使用【杀】指定目标后，你可以弃置至多X张牌（X为你的体力值），令目标角色共弃置等量的牌。然后若你的体力值或手牌数最小，此【杀】伤害+1。若你因此【杀】杀死一名角色，你将手牌摸至体力上限。' },
  ] },
  { id: 'flash-zhujun-b91', name: '闪·朱儁', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZJ_FEN, name: '分敌', description: '当你使用【杀】指定唯一目标后，你可以展示该角色至多X张手牌（X为你的体力上限）。若如此做，直到此【杀】结算结束，其只能使用或打出这些牌；当此【杀】对其造成伤害后，你获得其手牌或弃牌堆中的这些牌。' },
    { id: ZJ_JU, name: '拒降', description: '每回合限一次，当你于摸牌阶段外获得牌后，你可以弃置这些牌，你每以此法弃置一张牌，当前回合角色本回合使用【杀】的次数便+1。' },
  ] },
  { id: 'clan-xunguan-b91', name: '族·荀灌', kingdom: 'qun', gender: 'female', maxHp: 4, pack: 'sp', clan: 'xun', skills: [
    { id: XG_DUN, name: '遁迹', description: '锁定技，当你每回合首次使用黑色牌后，你令一名角色用一张手牌交换此牌。', locked: true },
    { id: XG_YUN, name: '云影', description: '锁定技，每个结束阶段，上次“遁迹”目标角色每满足一项，你便执行一项：本回合扣减过体力，你将所有黑色手牌当无距离限制的【杀】使用；本回合失去过手牌，你将手牌摸至X张（X为本回合弃牌堆中黑色牌数且至多为5）。', locked: true },
    { id: XG_DAO, name: '蹈节', description: '宗族技，锁定技，当你每回合首次使用非伤害锦囊牌后，你失去1点体力或一个锁定技令一名同族角色获得此牌。', locked: true },
  ] },
]

type B91State = SanguoshaState & {
  b91?: {
    zhaodanRound?: Record<PlayerId, { round: number; usedNames: string[]; disabled: boolean }>
    zhaodanTurns?: Record<number, number>
    xunguanLastTarget?: Record<PlayerId, PlayerId>
    xunguanUsedTurn?: Record<PlayerId, number>
    xunguanDaoTurn?: Record<PlayerId, number>
    xunguanTurnFlags?: Record<PlayerId, { turn: number; hpReduced: boolean; handLost: boolean }>
    xunguanFreeSlashCards?: Record<PlayerId, CardId[]>
    xunguanBlackDiscards?: Record<PlayerId, { turn: number; cardIds: CardId[] }>
    xunguanYunyingPending?: Record<PlayerId, { turn: number; cardIds: CardId[]; drawTo: number }>
    shenchongTarget?: Record<PlayerId, PlayerId>
    julianUsedTurn?: Record<PlayerId, number>
    julianQueuedTurn?: Record<PlayerId, number>
    julianGranting?: PlayerId[]
    julianTargets?: Record<PlayerId, PlayerId[]>
    zhangliaoRecasts?: Record<PlayerId, { turn: number; count: number; names: string[]; extraPlay: boolean }>
    zhangliaoSlashRecasts?: Record<PlayerId, number>
    zhuJunGainUse?: Record<PlayerId, number>
    zhuJunUseAllowance?: Record<PlayerId, { turn: number; amount: number }>
    zhaoyunDragonPhase?: Record<PlayerId, string>
    zhaoyunDragonAsked?: Record<PlayerId, Record<PlayerId, string>>
    zhaoyunDragonPending?: Record<CardId, { ownerId: PlayerId; attackerId: PlayerId }>
    zhaoyunDragonRestriction?: Record<PlayerId, { ownerId: PlayerId; turn: number }>
    sunjianJuelie?: Record<CardId, { ownerId: PlayerId; bonus: boolean; askedTargets: PlayerId[]; damagedTargets: PlayerId[] }>
    sunjianPingtaoBonus?: Record<PlayerId, number>
    zhangliaoDamaged?: Record<number, PlayerId[]>
    zhangliaoTuWei?: Record<PlayerId, { turn: number; targets: PlayerId[] }>
  }
}
const ext = (state: SanguoshaState) => state as B91State
const player = (state: SanguoshaState, id: PlayerId) => state.players.find((p) => p.id === id)
const hand = (state: SanguoshaState, id: PlayerId) => player(state, id)?.zones.hand ?? []
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  options: Array<{ id: string; label: string }>, data: Record<string, unknown>, optional = true, playerId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseOptionRequest => ({
    id: requestId, kind: 'choose-option', playerId, prompt, timeoutMs: 25_000, optional, options,
  }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  candidateIds: PlayerId[], data: Record<string, unknown>, playerId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseTargetsRequest => ({
    id: requestId, kind: 'choose-targets', playerId, prompt, timeoutMs: 25_000, optional: false, candidateIds, min: 1, max: 1,
  }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  cardIds: CardId[], data: Record<string, unknown>, playerId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseCardsRequest => ({
    id: requestId, kind: 'choose-cards', playerId, prompt, timeoutMs: 25_000, optional: false,
    purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
  }) })
}

function dragonLinIntercept(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean {
  if (context.cardName !== '杀' || context.sourceId === ownerId || !player(host.state, ownerId)?.alive
    || host.state.currentPlayerId !== context.sourceId || host.state.phase !== 'play') return false
  const state = ext(host.state); state.b91 ??= {}; state.b91.zhaoyunDragonPhase ??= {}
  state.b91.zhaoyunDragonAsked ??= {}
  const phaseToken = state.b91.zhaoyunDragonPhase[context.sourceId] ?? `${host.state.turnNumber}:play`
  const asked = state.b91.zhaoyunDragonAsked[ownerId] ??= {}
  if (asked[context.sourceId] === phaseToken) return false
  asked[context.sourceId] = phaseToken
  state.b91.zhaoyunDragonPhase[context.sourceId] = phaseToken
  const owner = player(host.state, ownerId)!
  const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
  if (!cards.length) return false
  host.askSkill({ skillId: ZY_LONG, ownerId, step: 'cancel-slash', data: {
    cardId: context.cardId, attackerId: context.sourceId, phaseToken,
  }, build: (requestId): ChooseCardsRequest => ({
    id: requestId, kind: 'choose-cards', playerId: ownerId,
    prompt: '【龙临】：可弃置一张牌令此【杀】无效', timeoutMs: 25_000, optional: true,
    purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: 1,
  }) })
  return true
}

registerSkillRuntime({ id: ZY_LONG,
  interceptTarget(host, ownerId, context) { return dragonLinIntercept(host, ownerId, context) },
  interceptBystanderTarget(host, ownerId, context) { return dragonLinIntercept(host, ownerId, context) },
  globalProhibitsSourceTarget(state, ownerId, sourceId, targetId) {
    const lock = ext(state).b91?.zhaoyunDragonRestriction?.[sourceId]
    return lock?.ownerId === ownerId && lock.turn === state.turnNumber && targetId !== ownerId
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (p.phase === 'play' && p.playerId) {
        const state = ext(host.state); state.b91 ??= {}; state.b91.zhaoyunDragonPhase ??= {}
        state.b91.zhaoyunDragonPhase[p.playerId] = context.event.id
      }
      if (p.playerId === ownerId && p.phase === 'play') {
        const state = ext(host.state); state.b91 ??= {}; state.b91.zhaoyunDragonAsked ??= {}
        delete state.b91.zhaoyunDragonAsked[ownerId]
      }
    } },
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const sourceId = context.event.sourceId
      if (sourceId) delete ext(host.state).b91?.zhaoyunDragonRestriction?.[sourceId]
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      const state = ext(host.state); state.b91 ??= {}
      const pending = state.b91.zhaoyunDragonPending?.[cardId]
      if (!pending || pending.ownerId !== ownerId) return
      delete state.b91.zhaoyunDragonPending?.[cardId]
      delete host.state.invalidatedCardUses?.[cardId]
      if (!player(host.state, pending.attackerId)?.alive || !player(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: ZY_LONG, ownerId, step: 'duel-choice', data: pending })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceSkillId !== ZY_LONG || context.event.targetId !== ownerId
        || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      const attackerId = context.event.sourceId
      if (!attackerId) return
      const state = ext(host.state); state.b91 ??= {}; state.b91.zhaoyunDragonRestriction ??= {}
      state.b91.zhaoyunDragonRestriction[attackerId] = { ownerId, turn: host.state.turnNumber }
    } },
    { event: 'TurnEnd', handle(host, _ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (playerId) delete ext(host.state).b91?.zhaoyunDragonRestriction?.[playerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'cancel-slash') return
    if (prompt.step === 'duel-choice') {
      const attackerId = prompt.data.attackerId as PlayerId
      if (!player(host.state, attackerId)?.alive || !player(host.state, ownerId)?.alive) return
      askOption(host, ZY_LONG, ownerId, 'duel-choice', '【龙临】：是否视为对赵云使用【决斗】？',
        [{ id: 'yes', label: '使用【决斗】' }, { id: 'no', label: '不使用' }], prompt.data, true, attackerId)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cancel-slash') {
      const cardId = resolution.data.cardId as CardId
      const attackerId = resolution.data.attackerId as PlayerId
      const cardIdChosen = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId)
      if (cardIdChosen && owner && (owner.zones.hand.includes(cardIdChosen)
        || Object.values(owner.zones.equipment).includes(cardIdChosen))
        && discardCardsByIds(host as never, ownerId, [cardIdChosen], ZY_LONG).length === 1) {
        host.state.invalidatedCardUses ??= {}
        host.state.invalidatedCardUses[cardId] = { sourceId: ownerId, skillId: ZY_LONG }
        const state = ext(host.state); state.b91 ??= {}; state.b91.zhaoyunDragonPending ??= {}
        state.b91.zhaoyunDragonPending[cardId] = { ownerId, attackerId }
      }
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'duel-choice'
      && (response.payload as { optionId?: string }).optionId === 'yes') {
      const attackerId = resolution.data.attackerId as PlayerId
      if (player(host.state, attackerId)?.alive && player(host.state, ownerId)?.alive)
        host.beginVirtualTrick({ sourceId: attackerId, targetId: ownerId, cardName: '决斗', sourceSkillId: ZY_LONG })
    }
  },
})

registerSkillRuntime({ id: SJ_JUE,
  outgoingDamage(state, ownerId, context) {
    if (!context.cardId || context.chainTransfer) return null
    const record = ext(state).b91?.sunjianJuelie?.[context.cardId]
    return record?.ownerId === ownerId && record.bonus ? { amount: context.amount + 1 } : null
  },
  interceptSourceTargetEach(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId !== ownerId) return false
    const state = ext(host.state); state.b91 ??= {}; state.b91.sunjianJuelie ??= {}
    let record = state.b91.sunjianJuelie[context.cardId]
    if (!record) {
      const owner = player(host.state, ownerId)
      if (!owner) return false
      const living = host.state.players.filter((candidate) => candidate.alive)
      const hpMinimum = living.length > 0 && owner.hp === Math.min(...living.map((candidate) => candidate.hp))
      const handMinimum = living.length > 0 && owner.zones.hand.length === Math.min(...living.map((candidate) => candidate.zones.hand.length))
      record = { ownerId, bonus: hpMinimum || handMinimum, askedTargets: [], damagedTargets: [] }
      state.b91.sunjianJuelie[context.cardId] = record
    }
    if (record.askedTargets.includes(context.targetId)) return false
    record.askedTargets.push(context.targetId)
    const owner = player(host.state, ownerId)
    const cards = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    host.askSkill({ skillId: SJ_JUE, ownerId, step: 'owner-discard', data: {
      cardId: context.cardId, targetId: context.targetId,
    }, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【绝烈】：可弃置至多当前体力值张牌',
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0,
      max: Math.min(owner?.hp ?? 0, cards.length),
    }) })
    return true
  },
  triggers: [
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId | null }
      const record = payload.cardId ? ext(host.state).b91?.sunjianJuelie?.[payload.cardId] : undefined
      if (record?.ownerId === ownerId && context.event.targetId && !record.damagedTargets.includes(context.event.targetId))
        record.damagedTargets.push(context.event.targetId)
    } },
    { event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
      const deadId = context.event.targetId
      if (!deadId || context.event.sourceId !== ownerId) return
      const state = ext(host.state)
      const record = Object.values(state.b91?.sunjianJuelie ?? {}).find((entry) => entry.ownerId === ownerId && entry.damagedTargets.includes(deadId))
      const owner = player(host.state, ownerId)
      if (record && owner?.alive) {
        const amount = Math.max(0, owner.maxHp - owner.zones.hand.length)
        if (amount) drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
      }
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (cardId) delete ext(host.state).b91?.sunjianJuelie?.[cardId]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    const cardId = resolution.data.cardId as CardId
    const targetId = resolution.data.targetId as PlayerId
    if (resolution.step === 'owner-discard') {
      const owner = player(host.state, ownerId)
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const available = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      const toDiscard = [...new Set(selected)].filter((id) => available.includes(id)).slice(0, owner?.hp ?? 0)
      const discarded = discardCardsByIds(host as never, ownerId, toDiscard, '绝烈')
      const target = player(host.state, targetId)
      if (!discarded.length || !target?.alive) return
      const targetsCards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
      if (!targetsCards.length) return
      const count = Math.min(discarded.length, targetsCards.length)
      host.askSkill({ skillId: SJ_JUE, ownerId, step: 'target-discard', data: { cardId, targetId, count }, build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: targetId, prompt: `【绝烈】：弃置${count}张牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: targetsCards, hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (resolution.step === 'target-discard') {
      const target = player(host.state, targetId)
      if (target?.alive) {
        const available = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
        const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
        discardCardsByIds(host as never, targetId, [...new Set(selected)].filter((id) => available.includes(id))
          .slice(0, Number(resolution.data.count ?? 0)), '绝烈')
      }
    }
  },
})

registerSkillRuntime({ id: SJ_PING,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play'
      && !usedThisPhase(state, ownerId, SJ_PING)
      && state.players.some((candidate) => candidate.alive && candidate.id !== ownerId
        && (candidate.zones.hand.length > 0 || (canUseSlash(state, ownerId, false) && canTarget(state, ownerId, candidate.id))))
      ? [{ id: `skill:${SJ_PING}`, label: '发动【平讨】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SJ_PING}`) return
    const candidates = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
      && (candidate.zones.hand.length > 0 || (canUseSlash(host.state, ownerId, false) && canTarget(host.state, ownerId, candidate.id))))
      .map((candidate) => candidate.id)
    if (candidates.length) askTargets(host, SJ_PING, ownerId, 'target', '【平讨】：选择一名其他角色', candidates, {})
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardName?: string }
    if (payload.cardName !== '杀') return
    const state = ext(host.state); state.b91 ??= {}; state.b91.sunjianPingtaoBonus ??= {}
    if (state.b91.sunjianPingtaoBonus[ownerId] === host.state.turnNumber) {
      revokeTurnSlashBonus(host.state, ownerId, { extraTargets: 1 })
      delete state.b91.sunjianPingtaoBonus[ownerId]
    }
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !player(host.state, targetId)?.alive || targetId === ownerId) return
      markUsedThisPhase(host.state, ownerId, SJ_PING)
      const options = [
        ...(hand(host.state, targetId).length ? [{ id: 'give', label: '交给孙坚一张手牌，本回合下一张杀可多指定一名目标' }] : []),
        ...(canUseSlash(host.state, ownerId, false) && canTarget(host.state, ownerId, targetId)
          ? [{ id: 'slash', label: '孙坚视为对你使用一张【杀】' }] : []),
      ]
      if (options.length) askOption(host, SJ_PING, ownerId, 'target-choice', '【平讨】：选择一项', options, { targetId }, false, targetId)
      return
    }
    if (resolution.step === 'target-choice') {
      const targetId = resolution.data.targetId as PlayerId
      const choice = (response.payload as { optionId?: string }).optionId
      if (!player(host.state, targetId)?.alive) return
      if (choice === 'slash') {
        if (canUseSlash(host.state, ownerId, false) && canTarget(host.state, ownerId, targetId))
          host.beginVirtualBasic({ sourceId: ownerId, targetIds: [targetId], cardName: '杀', sourceSkillId: SJ_PING })
        return
      }
      if (choice !== 'give' || !hand(host.state, targetId).length) return
      host.askSkill({ skillId: SJ_PING, ownerId, step: 'give-card', data: { targetId }, build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: targetId, prompt: '【平讨】：交给孙坚一张手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: hand(host.state, targetId), hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'give-card') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !hand(host.state, targetId).includes(cardId)) return
      if (giveCards(host, targetId, ownerId, [cardId], '平讨').length !== 1) return
      const state = ext(host.state); state.b91 ??= {}; state.b91.sunjianPingtaoBonus ??= {}
      if (state.b91.sunjianPingtaoBonus[ownerId] !== host.state.turnNumber) {
        state.b91.sunjianPingtaoBonus[ownerId] = host.state.turnNumber
        grantTurnSlashBonus(host.state, ownerId, { extraTargets: 1 })
      }
    }
  },
})

registerSkillRuntime({ id: ZL_TU,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (p.playerId !== ownerId || p.phase !== 'play' || effectiveKingdomOf(host.state, ownerId) !== 'wei') return
      host.queueSkill({ skillId: ZL_TU, ownerId, step: 'invoke', data: { turn: host.state.turnNumber } })
    } },
    { event: 'Damaged', handle(host, _ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId) return
      const state = ext(host.state); state.b91 ??= {}; state.b91.zhangliaoDamaged ??= {}
      const current = state.b91.zhangliaoDamaged[host.state.turnNumber] ??= []
      if (!current.includes(targetId)) current.push(targetId)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turnPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId
      const state = ext(host.state); state.b91 ??= {}; state.b91.zhangliaoTuWei ??= {}
      const record = state.b91.zhangliaoTuWei[ownerId]
      if (turnPlayerId !== ownerId || !record || record.turn !== host.state.turnNumber) return
      const damaged = new Set(state.b91.zhangliaoDamaged?.[record.turn] ?? [])
      const targets = record.targets.filter((id) => player(host.state, id)?.alive && !damaged.has(id))
      delete state.b91.zhangliaoTuWei[ownerId]
      if (targets.length) host.queueSkill({ skillId: ZL_TU, ownerId, step: 'give-next', data: { targets, turn: record.turn } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'invoke') {
      askOption(host, ZL_TU, ownerId, 'invoke', '【突围】：是否获得攻击范围内任意名角色各一张牌？',
        [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], prompt.data)
      return
    }
    if (prompt.step === 'steal-next') {
      const targetId = prompt.data.targetId as PlayerId
      const pickable = pickableCardsOf(host.state, targetId)
      if (!player(host.state, targetId)?.alive || !pickable.cardIds.length && !pickable.hiddenCardSlots.length) {
        queueNextZhangliaoSteal(host, ownerId, prompt.data.targets as PlayerId[])
        return
      }
      host.askSkill({ skillId: ZL_TU, ownerId, step: 'steal-card', data: prompt.data, build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【突围】：选择获得${player(host.state, targetId)?.nickname ?? '目标'}的一张牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: pickable.cardIds,
        hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'give-next') {
      const targets = prompt.data.targets as PlayerId[]
      const targetId = targets[0]
      const owner = player(host.state, ownerId)
      const ownCards = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (!targetId || !player(host.state, targetId)?.alive || !ownCards.length) {
        queueNextZhangliaoGift(host, ownerId, targets.slice(1), Number(prompt.data.turn))
        return
      }
      host.askSkill({ skillId: ZL_TU, ownerId, step: 'give-card', data: prompt.data, build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【突围】：选择交给${player(host.state, targetId)?.nickname ?? '目标'}的一张牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: ownCards, hiddenCardSlots: [], min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidates = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
        && canTarget(host.state, ownerId, candidate.id)
        && (pickableCardsOf(host.state, candidate.id).cardIds.length + pickableCardsOf(host.state, candidate.id).hiddenCardSlots.length > 0))
        .map((candidate) => candidate.id)
      if (!candidates.length) return
      host.askSkill({ skillId: ZL_TU, ownerId, step: 'targets', data: { turn: host.state.turnNumber }, build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【突围】：选择任意名攻击范围内的角色',
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: candidates.length,
      }) })
      return
    }
    if (resolution.step === 'targets') {
      const candidateSet = new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])
      const candidates = host.state.players.filter((candidate) => candidateSet.has(candidate.id) && candidate.alive
        && candidate.id !== ownerId && canTarget(host.state, ownerId, candidate.id)
        && (pickableCardsOf(host.state, candidate.id).cardIds.length + pickableCardsOf(host.state, candidate.id).hiddenCardSlots.length > 0))
        .map((candidate) => candidate.id)
      if (!candidates.length) return
      const state = ext(host.state); state.b91 ??= {}; state.b91.zhangliaoTuWei ??= {}
      state.b91.zhangliaoTuWei[ownerId] = { turn: host.state.turnNumber, targets: candidates }
      queueNextZhangliaoSteal(host, ownerId, candidates)
      return
    }
    if (resolution.step === 'steal-card') {
      const targets = resolution.data.targets as PlayerId[]
      const targetId = targets[0]
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = targetId && picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (targetId && cardId && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '突围' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '突围' }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
      queueNextZhangliaoSteal(host, ownerId, targets.slice(1))
      return
    }
    if (resolution.step === 'give-card') {
      const targets = resolution.data.targets as PlayerId[]
      const targetId = targets[0]
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId)
      const owned = owner && (owner.zones.hand.includes(cardId!) || Object.values(owner.zones.equipment).includes(cardId!))
      if (cardId && targetId && owned && player(host.state, targetId)?.alive
        && movePickedCard(host as never, ownerId, cardId, { kind: 'hand', playerId: targetId })) {
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '突围' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: '突围' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
      queueNextZhangliaoGift(host, ownerId, targets.slice(1), Number(resolution.data.turn))
    }
  },
})

function queueNextZhangliaoSteal(host: SkillHost, ownerId: PlayerId, targets: PlayerId[]) {
  const targetId = targets.find((id) => player(host.state, id)?.alive && (pickableCardsOf(host.state, id).cardIds.length
    + pickableCardsOf(host.state, id).hiddenCardSlots.length > 0))
  if (targetId) host.queueSkill({ skillId: ZL_TU, ownerId, step: 'steal-next', data: { targetId, targets: [targetId, ...targets.filter((id) => id !== targetId)] } })
}

function queueNextZhangliaoGift(host: SkillHost, ownerId: PlayerId, targets: PlayerId[], turn: number) {
  const targetId = targets.find((id) => player(host.state, id)?.alive)
  if (targetId) host.queueSkill({ skillId: ZL_TU, ownerId, step: 'give-next', data: { targets: [targetId, ...targets.filter((id) => id !== targetId)], turn } })
}

registerSkillRuntime({ id: ZJ_FEN,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const p = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (p.cardName !== '杀' || !p.cardId || p.targetIds?.length !== 1) return
      const targetId = p.targetIds[0]
      const target = player(host.state, targetId)
      const max = Math.min(target?.maxHp ?? 0, target?.zones.hand.length ?? 0)
      if (!target || max < 1) return
      host.queueSkill({ skillId: ZJ_FEN, ownerId, step: 'show-cards', data: { cardId: p.cardId, targetId, max } })
    } },
    { event: 'Damaged', handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId | null }
      const cardId = p.cardId
      const targetId = context.event.targetId
      if (!cardId || !targetId || context.event.sourceId !== ownerId) return
      const state = ext(host.state)
      const fence = (state.b91 as unknown as { zhuJunFence?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; shown: CardId[]; damaged: boolean }> } | undefined)?.zhuJunFence?.[cardId]
      if (fence?.ownerId === ownerId && fence.targetId === targetId) fence.damaged = true
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId }
      const cardId = p.cardId
      if (!cardId) return
      const state = ext(host.state)
      const record = (state.b91 as unknown as { zhuJunFence?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; shown: CardId[]; damaged: boolean }> } | undefined)?.zhuJunFence?.[cardId]
      if (!record || record.ownerId !== ownerId) return
      delete (state.b91 as unknown as { zhuJunFence?: Record<CardId, unknown> }).zhuJunFence?.[cardId]
      if (!record.damaged || !player(host.state, ownerId)?.alive) return
      const target = player(host.state, record.targetId)
      for (const shownId of record.shown) {
        const fromHand = target?.zones.hand.includes(shownId) ?? false
        const fromDiscard = host.state.zones.discardPile.includes(shownId)
        if (!fromHand && !fromDiscard) continue
        moveCard(host.state, shownId, fromHand ? { kind: 'hand', playerId: record.targetId } : { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        if (fromHand) host.dispatch('LoseCard', { playerId: record.targetId, cardIds: [shownId], reason: '分敌' }, { sourceId: ownerId, targetId: record.targetId, cardIds: [shownId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [shownId], reason: '分敌' }, { sourceId: record.targetId, targetId: ownerId, cardIds: [shownId] })
      }
    } },
  ],
  globallyProhibitsCardUse(state, ownerId, targetId, cardId) {
    const resolution = state.cardResolution
    if (targetId === ownerId || resolution?.kind !== 'slash' || resolution.targetId !== targetId) return false
    const record = (ext(state).b91 as unknown as { zhuJunFence?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; shown: CardId[]; damaged: boolean }> } | undefined)?.zhuJunFence?.[resolution.cardId]
    return Boolean(record && record.ownerId === ownerId && record.targetId === targetId && !record.shown.includes(cardId))
  },
  prohibitsCardResponse(state, ownerId, responderId, cardName) {
    const resolution = state.cardResolution
    if (resolution?.kind !== 'slash' || resolution.targetId !== responderId) return false
    const record = (ext(state).b91 as unknown as { zhuJunFence?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; shown: CardId[]; damaged: boolean }> } | undefined)?.zhuJunFence?.[resolution.cardId]
    if (!record || record.ownerId !== ownerId || record.targetId !== responderId) return false
    const physicalOrConvertedAvailable = record.shown.some((cardId) => state.cards[cardId]?.name === cardName)
      || responseViewAsOptions(state, responderId, cardName).some((option) => record.shown.includes(option.cardId))
    return !physicalOrConvertedAvailable
  },
  prohibitsResponseCard(state, ownerId, responderId, responseCardId) {
    const resolution = state.cardResolution
    if (resolution?.kind !== 'slash' || resolution.targetId !== responderId) return false
    const record = (ext(state).b91 as unknown as { zhuJunFence?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; shown: CardId[]; damaged: boolean }> } | undefined)?.zhuJunFence?.[resolution.cardId]
    return Boolean(record && record.ownerId === ownerId && record.targetId === responderId && !record.shown.includes(responseCardId))
  },
  prohibitsCardlessResponse(state, ownerId, responderId) {
    const resolution = state.cardResolution
    if (resolution?.kind !== 'slash' || resolution.targetId !== responderId) return false
    const record = (ext(state).b91 as unknown as { zhuJunFence?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; shown: CardId[]; damaged: boolean }> } | undefined)?.zhuJunFence?.[resolution.cardId]
    return Boolean(record && record.ownerId === ownerId && record.targetId === responderId)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'show-cards') return
    const targetId = prompt.data.targetId as PlayerId
    const target = player(host.state, targetId)
    if (!target?.alive || !target.zones.hand.length) return
    const slots = target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index))
    host.askSkill({ skillId: ZJ_FEN, ownerId, step: 'choose-shown-cards', data: prompt.data, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【分敌】：秘密选择展示${Math.min(Number(prompt.data.max), slots.length)}张以内的手牌`,
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: [], hiddenCardSlots: slots,
      min: 0, max: Math.min(Number(prompt.data.max), slots.length),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-shown-cards') return
    const cardId = resolution.data.cardId as CardId
    const targetId = resolution.data.targetId as PlayerId
    const target = player(host.state, targetId)
    if (!target?.alive || host.state.cards[cardId]?.name !== '杀') return
    const picked = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const shown = [...new Set(picked)].map((token) => resolvePickedCard(host.state, targetId, token))
      .filter((id): id is CardId => id !== null && target.zones.hand.includes(id))
      .slice(0, Math.min(target.maxHp, resolution.data.max as number))
    if (!shown.length) return
    const state = ext(host.state); state.b91 ??= {}
    const extended = state.b91 as unknown as { zhuJunFence?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; shown: CardId[]; damaged: boolean }> }
    extended.zhuJunFence ??= {}
    extended.zhuJunFence[cardId] = { ownerId, targetId, shown, damaged: false }
    host.dispatch('CardMove', { playerId: targetId, cardIds: shown, reason: '分敌', revealed: true }, { sourceId: ownerId, targetId, cardIds: shown })
  },
})

const LH_DEBATE_TAG = 'flash-liuhong-b91-chaozheng'
registerGroupCardDecision(LH_DEBATE_TAG, (rawHost, decision) => {
  const host = rawHost as SkillHost
  const votes = decision.playerIds.flatMap((playerId) => {
    const cardId = decision.responses[playerId]?.[0]
    return cardId && hand(host.state, playerId).includes(cardId) ? [{ playerId, cardId }] : []
  })
  const score = (color: 'red' | 'black') => votes.reduce((sum, vote) => {
    if (effectiveCardColor(host.state, vote.playerId, vote.cardId) !== color) return sum
    return sum + (host.state.cards[vote.cardId]?.rank ?? 0) + (vote.playerId === decision.data.ownerId ? 1 : 0)
  }, 0)
  const red = score('red'), black = score('black')
  if (red === black) return
  const result = red > black ? 'red' : 'black'
  const ownerId = decision.data.ownerId as PlayerId
  const redPlayers = votes.filter((vote) => effectiveCardColor(host.state, vote.playerId, vote.cardId) === 'red').map((vote) => vote.playerId)
  if (result === 'red') {
    for (const playerId of redPlayers) recover(host, playerId, 1, ownerId)
  } else {
    for (const playerId of redPlayers) if (playerId !== ownerId) loseHp(host, playerId, 1, LH_CHAO)
  }
  const ownerVote = votes.find((vote) => vote.playerId === ownerId)
  const ownerColor = ownerVote ? effectiveCardColor(host.state, ownerVote.playerId, ownerVote.cardId) : null
  const same = ownerColor ? votes.filter((vote) => effectiveCardColor(host.state, vote.playerId, vote.cardId) === ownerColor).length : 0
  if (same) drawCards(host.state, host.rng, ownerId, Math.min(2, same), (name, payload) => host.dispatch(name, payload))
})

registerSkillRuntime({ id: LH_CHAO, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const p = context.event.payload as { playerId?: PlayerId; phase?: string }
  if (p.playerId !== ownerId || p.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
  const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
  host.queueSkill({ skillId: LH_CHAO, ownerId, step: 'invoke', data: { others } })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'invoke') askOption(host, LH_CHAO, ownerId, 'invoke', '【朝争】：是否与所有其他角色进行议事？',
    [{ id: 'yes', label: '议事' }, { id: 'no', label: '不发动' }], prompt.data)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
  const participantIds = [ownerId, ...(resolution.data.others as PlayerId[])].filter((id) => player(host.state, id)?.alive)
  startGroupCardDecision(host, { id: `${LH_DEBATE_TAG}:${host.state.seq}`, tag: LH_DEBATE_TAG, skillId: LH_CHAO,
    playerIds: participantIds, prompt: '【朝争】：秘密选择一张手牌作为意见牌',
    cardIdsFor: (id) => hand(host.state, id), minFor: (_id, cards) => cards.length ? 1 : 0, max: 1, timeoutMs: 25_000,
    data: { ownerId, participantIds, kind: 'chaozheng' } })
} })

registerSkillRuntime({ id: LH_CHONG, limited: true,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = player(host.state, ownerId)
      if (p.playerId === ownerId && p.phase === 'prepare'
        && owner && !owner.usedLimitedSkills.includes(LH_CHONG)) host.queueSkill({ skillId: LH_CHONG, ownerId, step: 'invoke', data: {} })
    } },
    { event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const targetId = ext(host.state).b91?.shenchongTarget?.[ownerId]
      if (!targetId) return
      const beneficiary = player(host.state, targetId)
      if (beneficiary) beneficiary.characterSkillsDisabled = true
      const killerId = context.event.sourceId
      if (killerId && killerId !== ownerId && player(host.state, killerId)?.alive)
        discardAllCards(host as never, killerId, '甚宠')
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'invoke') askOption(host, LH_CHONG, ownerId, 'invoke', '【甚宠】：是否令一名其他角色获得“飞扬”“跋扈”？',
      [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], {}, true)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidates = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidates.length) askTargets(host, LH_CHONG, ownerId, 'target', '【甚宠】：选择一名其他角色', candidates, {})
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const owner = player(host.state, ownerId)
    if (!targetId || !player(host.state, targetId)?.alive || !owner || owner.usedLimitedSkills.includes(LH_CHONG)) return
    owner.usedLimitedSkills.push(LH_CHONG)
    grantSkill(host.state, targetId, LH_FEI)
    grantSkill(host.state, targetId, LH_BA)
    const state = ext(host.state); state.b91 ??= {}; state.b91.shenchongTarget ??= {}
    state.b91.shenchongTarget[ownerId] = targetId
  },
})

registerSkillRuntime({ id: LH_FEI, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const p = context.event.payload as { playerId?: PlayerId; phase?: string }
  const owner = player(host.state, ownerId)
  const discardable = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))] : []
  if (p.playerId !== ownerId || p.phase !== 'judge' || !owner?.zones.judgingArea.length || discardable.length < 2) return
  host.queueSkill({ skillId: LH_FEI, ownerId, step: 'invoke', data: { discardable } })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'invoke') return
  askOption(host, LH_FEI, ownerId, 'invoke', '【飞扬】：是否弃置两张牌并弃置判定区里的一张牌？',
    [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], prompt.data)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = player(host.state, ownerId)
    const candidates = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))] : []
    host.askSkill({ skillId: LH_FEI, ownerId, step: 'cost', data: {}, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【飞扬】：弃置两张牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 2, max: 2,
    }) })
    return
  }
  if (resolution.step === 'cost') {
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = player(host.state, ownerId)
    if (!owner || ids.length !== 2 || ids.some((cardId) => !owner.zones.hand.includes(cardId)
      && !Object.values(owner.zones.equipment).includes(cardId))) return
    if (discardCardsByIds(host as never, ownerId, ids, '飞扬').length !== 2 || !owner.zones.judgingArea.length) return
    askCards(host, LH_FEI, ownerId, 'judgment', '【飞扬】：选择弃置判定区里的一张牌', owner.zones.judgingArea, {})
    return
  }
  if (resolution.step === 'judgment') {
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const owner = player(host.state, ownerId)
    if (!cardId || !owner?.zones.judgingArea.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'judgingArea', playerId: ownerId }, { kind: 'discardPile' }, { discardReason: 'discard' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '飞扬' }, { targetId: ownerId, cardIds: [cardId] })
  }
} })

registerSkillRuntime({ id: LH_BA, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const p = context.event.payload as { playerId?: PlayerId; phase?: string }
  if (p.playerId !== ownerId || p.phase !== 'prepare') return
  drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  addSlashUseQuota(host.state, ownerId, 1)
} }] })

registerSkillRuntime({ id: LH_JU, triggers: [
  { event: 'GainCard', handle(host, ownerId, context) {
    const lord = player(host.state, ownerId)
    const p = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    const targetId = p.playerId
    const target = targetId ? player(host.state, targetId) : undefined
    if (lord?.identity !== 'lord' || !target?.alive || target.id === ownerId || !p.cardIds?.length
      || host.state.phase === 'draw' || context.event.sourceSkillId === LH_JU
      || (ext(host.state).b91?.julianGranting ?? []).includes(target.id)
      || effectiveKingdomOf(host.state, target.id) !== 'qun') return
    const state = ext(host.state); state.b91 ??= {}; state.b91.julianQueuedTurn ??= {}
    if (state.b91.julianQueuedTurn[target.id] === host.state.turnNumber
      || state.b91.julianUsedTurn?.[target.id] === host.state.turnNumber) return
    state.b91.julianQueuedTurn[target.id] = host.state.turnNumber
    host.queueSkill({ skillId: LH_JU, ownerId, step: 'bonus-draw', data: { targetId, turn: host.state.turnNumber } })
  } },
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const lord = player(host.state, ownerId)
    const p = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (lord?.identity !== 'lord' || p.playerId !== ownerId || p.phase !== 'finish') return
    const targets = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
      && effectiveKingdomOf(host.state, candidate.id) === 'qun' && hand(host.state, candidate.id).length).map((candidate) => candidate.id)
    if (targets.length) host.queueSkill({ skillId: LH_JU, ownerId, step: 'steal-invoke', data: { targets } })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'bonus-draw') {
    const targetId = prompt.data.targetId as PlayerId
    if (!player(host.state, targetId)?.alive) return
    askOption(host, LH_JU, ownerId, 'bonus-draw', '【聚敛】：是否额外摸一张牌？',
      [{ id: 'yes', label: '摸一张' }, { id: 'no', label: '不摸' }], prompt.data, true, targetId)
    return
  }
  if (prompt.step === 'steal-invoke') {
    askOption(host, LH_JU, ownerId, 'steal-invoke', '【聚敛】：是否依次获得其他群势力角色各一张手牌？',
      [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], prompt.data)
    return
  }
  if (prompt.step === 'steal-next') {
    const targetId = prompt.data.targetId as PlayerId
    const target = player(host.state, targetId)
    if (!target?.alive || !target.zones.hand.length) {
      queueNextJulianTarget(host, ownerId, prompt.data.targets as PlayerId[])
      return
    }
    const hiddenCardSlots = target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index))
    host.askSkill({ skillId: LH_JU, ownerId, step: 'steal-card', data: prompt.data, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【聚敛】：选择获得${target.nickname}的一张手牌`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots, min: 1, max: 1,
    }) })
  }
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'bonus-draw') {
    const targetId = resolution.data.targetId as PlayerId
    if ((response.payload as { optionId?: string }).optionId !== 'yes' || !player(host.state, targetId)?.alive
      || resolution.data.turn !== host.state.turnNumber) return
    const state = ext(host.state); state.b91 ??= {}; state.b91.julianUsedTurn ??= {}
    state.b91.julianUsedTurn[targetId] = host.state.turnNumber
    state.b91.julianGranting ??= []
    state.b91.julianGranting.push(targetId)
    drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
    state.b91.julianGranting = state.b91.julianGranting.filter((id) => id !== targetId)
    return
  }
  if (resolution.step === 'steal-invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    queueNextJulianTarget(host, ownerId, resolution.data.targets as PlayerId[])
    return
  }
  if (resolution.step !== 'steal-card') return
  const targets = resolution.data.targets as PlayerId[]
  const targetId = targets[0]
  const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
  const cardId = targetId && picked ? resolvePickedCard(host.state, targetId, picked) : null
  if (targetId && cardId && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '聚敛' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '聚敛' }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  }
  queueNextJulianTarget(host, ownerId, targets.slice(1))
}, })

function queueNextJulianTarget(host: SkillHost, ownerId: PlayerId, targets: PlayerId[]) {
  const targetId = targets.find((id) => player(host.state, id)?.alive && hand(host.state, id).length)
  if (!targetId) return
  host.queueSkill({ skillId: LH_JU, ownerId, step: 'steal-next', data: { targetId, targets: [targetId, ...targets.filter((id) => id !== targetId)] } })
}

// 闪张辽【整兵】：逐次重铸，按牌名记录三类结果；额外出牌阶段排在完整回合结束后。
registerSkillRuntime({ id: ZL_ZHENG,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId
      && effectiveKingdomOf(state, ownerId) === 'qun'
      && (ext(state).b91?.zhangliaoRecasts?.[ownerId]?.turn !== state.turnNumber
        || (ext(state).b91?.zhangliaoRecasts?.[ownerId]?.count ?? 0) < 3)
      && hand(state, ownerId).length
      ? [{ id: `skill:${ZL_ZHENG}`, label: '发动【整兵】：重铸一张手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${ZL_ZHENG}`) return
    askCards(host, ZL_ZHENG, ownerId, 'recast', '【整兵】：选择一张手牌重铸', hand(host.state, ownerId), {})
  },
  maxCardsBonus(state, ownerId) {
    return ext(state).b91?.zhangliaoSlashRecasts?.[ownerId] ?? 0
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'recast') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !hand(host.state, ownerId).includes(cardId)) return
    const cardName = host.state.cards[cardId]?.name
    if (!cardName) return
    const discarded = discardCardsByIds(host as never, ownerId, [cardId], '整兵', 'other')
    if (!discarded.length) return
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    const state = ext(host.state); state.b91 ??= {}; state.b91.zhangliaoRecasts ??= {}
    const previous = state.b91.zhangliaoRecasts[ownerId]
    const rec = previous ?? { turn: host.state.turnNumber, count: 0, names: [], extraPlay: false }
    if (rec.turn !== host.state.turnNumber) {
      rec.turn = host.state.turnNumber
      rec.count = 0
      rec.extraPlay = false
    }
    if (rec.count >= 3) return
    rec.count += 1
    const branch = cardName === '杀' ? '杀' : cardName === '闪' ? '闪' : ['桃', '酒'].includes(cardName) ? '酒桃' : ''
    if (branch) rec.names = [...new Set([...rec.names, branch])]
    if (cardName === '杀') {
      state.b91.zhangliaoSlashRecasts ??= {}
      state.b91.zhangliaoSlashRecasts[ownerId] = (state.b91.zhangliaoSlashRecasts[ownerId] ?? 0) + 1
    }
    if (cardName === '闪') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    if (['桃', '酒'].includes(cardName)) {
      queueExtraPhaseAfterTurnEnd(host.state, ownerId, 'play', ZL_ZHENG)
    }
    state.b91.zhangliaoRecasts[ownerId] = rec
    if (rec.names.includes('杀') && rec.names.includes('闪') && rec.names.includes('酒桃')) {
      const owner = player(host.state, ownerId)
      if (owner) owner.kingdomOverride = 'wei'
    }
  },
})

// 【拒降】：放弃摸牌阶段的牌；仅这一次 GainCard 的确切入手牌可被弃置并转化次数。
registerSkillRuntime({ id: ZJ_JU, triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
  const p = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
  if (p.playerId !== ownerId || !p.cardIds?.length || host.state.phase === 'draw'
    || ext(host.state).b91?.zhuJunGainUse?.[ownerId] === host.state.turnNumber) return
  const available = p.cardIds.filter((cardId) => hand(host.state, ownerId).includes(cardId))
  if (!available.length) return
  host.queueSkill({ skillId: ZJ_JU, ownerId, step: 'discard-gained', data: { cardIds: available, turnNumber: host.state.turnNumber } })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'discard-gained') askOption(host, ZJ_JU, ownerId, 'discard-gained', '【拒降】：是否弃置此次获得的所有牌，令当前回合角色增加等量【杀】次数？',
    [{ id: 'yes', label: '弃置并增加次数' }, { id: 'no', label: '不发动' }], prompt.data)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'discard-gained' || (response.payload as { optionId?: string }).optionId !== 'yes') return
  const state = ext(host.state); state.b91 ??= {}; state.b91.zhuJunGainUse ??= {}
  if (state.b91.zhuJunGainUse[ownerId] === host.state.turnNumber) return
  const cardIds = (resolution.data.cardIds as CardId[]).filter((cardId) => hand(host.state, ownerId).includes(cardId))
  const discarded = discardCardsByIds(host as never, ownerId, cardIds, '拒降')
  if (!discarded.length) return
  state.b91.zhuJunGainUse[ownerId] = host.state.turnNumber
  const current = host.state.currentPlayerId
  if (!current || !player(host.state, current)?.alive) return
  addSlashUseQuota(host.state, current, discarded.length)
} })

// 闪赵云【镇胆】：使用/打出转化共用一轮牌名账本；伤害后与轮末摸牌仅结算一次。
registerSkillRuntime({ id: ZY_DAN,
  viewAs(state, ownerId) {
    const rec = ext(state).b91?.zhaodanRound?.[ownerId]
    if (rec?.round === state.roundNumber && rec.disabled) return []
    const basics = new Set(['杀', '闪', '桃', '酒', '火杀', '雷杀'])
    return hand(state, ownerId).filter((cardId) => state.cards[cardId]?.category !== 'basic').flatMap((cardId) =>
      [...basics].filter((name) => !rec || rec.round !== state.roundNumber || !rec.usedNames.includes(name))
        .map((asCardName) => ({ cardId, asCardName, label: `镇胆：当【${asCardName}】使用或打出` })))
  },
  triggers: [
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId) settleZhaodan(host, ownerId)
    } },
    { event: 'RoundEnd', handle(host, ownerId) { settleZhaodan(host, ownerId) } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId; cardName?: string }
      if (context.event.sourceId !== ownerId || !p.cardId) return
      const effectiveName = p.cardName ?? host.state.cards[p.cardId]?.name
      if (effectiveName && ['杀', '闪', '桃', '酒', '火杀', '雷杀'].includes(effectiveName))
        markZhaodanUsed(host.state, ownerId, effectiveName)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; cardId?: CardId; cardName?: string }
      const effectiveName = p.cardName ?? (p.cardId ? host.state.cards[p.cardId]?.name : undefined)
      if (p.playerId === ownerId && effectiveName && ['杀', '闪', '桃', '酒', '火杀', '雷杀'].includes(effectiveName))
        markZhaodanUsed(host.state, ownerId, effectiveName)
    } },
    { event: 'RoundStart', handle(host, ownerId) {
      const s = ext(host.state); s.b91 ??= {}; s.b91.zhaodanRound ??= {}
      s.b91.zhaodanTurns ??= {}; s.b91.zhaodanTurns[host.state.roundNumber] = 0
      s.b91.zhaodanRound[ownerId] = { round: host.state.roundNumber, usedNames: [], disabled: false }
    } },
    { event: 'TurnEnd', handle(host) {
      const s = ext(host.state); s.b91 ??= {}; s.b91.zhaodanTurns ??= {}
      s.b91.zhaodanTurns[host.state.roundNumber] = (s.b91.zhaodanTurns[host.state.roundNumber] ?? 0) + 1
    } },
  ],
})
function markZhaodanUsed(state: SanguoshaState, ownerId: PlayerId, name?: string) {
  if (!name) return
  const s = ext(state); s.b91 ??= {}; s.b91.zhaodanRound ??= {}
  const current = s.b91.zhaodanRound[ownerId]
  const rec = current?.round === state.roundNumber ? current : { round: state.roundNumber, usedNames: [], disabled: false }
  if (!rec.usedNames.includes(name)) rec.usedNames.push(name)
  s.b91.zhaodanRound[ownerId] = rec
}
function settleZhaodan(host: SkillHost, ownerId: PlayerId) {
  const s = ext(host.state); s.b91 ??= {}; s.b91.zhaodanRound ??= {}
  const rec = s.b91.zhaodanRound[ownerId]
  if (rec?.round === host.state.roundNumber && rec.disabled) return
  const turns = s.b91.zhaodanTurns?.[host.state.roundNumber] ?? 0
  drawCards(host.state, host.rng, ownerId, Math.min(5, turns), (name, payload) => host.dispatch(name, payload))
  s.b91.zhaodanRound[ownerId] = { round: host.state.roundNumber, usedNames: rec?.usedNames ?? [], disabled: true }
}

// 族荀灌【遁迹】：用同时秘密选牌请求完成手牌交换，避免逐人公开请求泄露选择。
registerSkillRuntime({ id: XG_DUN, triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
  const p = context.event.payload as { cardId?: CardId }
  if (context.event.sourceId !== ownerId || !p.cardId || effectiveCardColor(host.state, ownerId, p.cardId) !== 'black') return
  const state = ext(host.state); state.b91 ??= {}; state.b91.xunguanUsedTurn ??= {}
  if (state.b91.xunguanUsedTurn[ownerId] === host.state.turnNumber) return
  state.b91.xunguanUsedTurn[ownerId] = host.state.turnNumber
  const valid = host.state.players.filter((x) => x.alive && x.id !== ownerId && hand(host.state, x.id).length).map((x) => x.id)
  if (!valid.length) return
  host.queueSkill({ skillId: XG_DUN, ownerId, step: 'target', data: { cardId: p.cardId, valid } })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'target') askTargets(host, XG_DUN, ownerId, 'target', '【遁迹】：选择一名有手牌的角色与其交换此牌',
    prompt.data.valid as PlayerId[], prompt.data)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const cardId = resolution.data.cardId as CardId
    if (!targetId || !hand(host.state, targetId).length || !host.state.cards[cardId]) return
    askCards(host, XG_DUN, ownerId, 'exchange', '【遁迹】：选择一张手牌交换此牌', hand(host.state, targetId), { targetId, cardId }, targetId)
    return
  }
  if (resolution.step !== 'exchange') return
  const targetId = resolution.data.targetId as PlayerId
  const cardId = resolution.data.cardId as CardId
  const handCardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
  const from = locateOwnedCard(host.state, ownerId, cardId)
    ?? (host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const }
      : host.state.zones.processingArea.includes(cardId) ? { kind: 'processingArea' as const } : null)
  if (!handCardId || !hand(host.state, targetId).includes(handCardId) || !from) return
  if (!giveCards(host, targetId, ownerId, [handCardId], '遁迹').length) return
  if (from.kind === 'equipment') handleEquipmentLost(host, ownerId, cardId)
  moveCard(host.state, cardId, from, { kind: 'hand', playerId: targetId })
  host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: '遁迹' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
  const state = ext(host.state); state.b91 ??= {}; state.b91.xunguanLastTarget ??= {}
  state.b91.xunguanLastTarget[ownerId] = targetId
}, })

// 荀灌的另两项锁定技在此复用宗族识别及锁定技过滤；交互续接保持可序列化。
registerSkillRuntime({ id: XG_DAO, triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
  const p = context.event.payload as { cardId?: CardId; cardName?: string }
  if (context.event.sourceId !== ownerId || !p.cardId || host.state.cards[p.cardId]?.category !== 'trick') return
  const name = p.cardName ?? host.state.cards[p.cardId]?.name ?? ''
  if (DAMAGE_TRICKS.has(name) || ext(host.state).b91?.xunguanDaoTurn?.[ownerId] === host.state.turnNumber) return
  const allies = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
    && candidate.characterId && getCharacter(candidate.characterId)?.clan === 'xun')
  const locked = (player(host.state, ownerId)?.characterId ? getCharacter(player(host.state, ownerId)!.characterId!)?.skills : [])
    ?.filter((skill) => isLockedSkill(skill.id) && !skill.granted) ?? []
  const state = ext(host.state); state.b91 ??= {}; state.b91.xunguanDaoTurn ??= {}
  state.b91.xunguanDaoTurn[ownerId] = host.state.turnNumber
  if (!allies.length || !locked.length) { loseHp(host, ownerId, 1, XG_DAO); return }
  const options = [{ id: 'lose', label: '失去1点体力' }, ...locked.flatMap((skill) => allies.map((target) => ({
    id: `give:${skill.id}:${target.id}`, label: `失去锁定技【${skill.name}】并令${target.nickname}获得此牌`,
  })))]
  host.queueSkill({ skillId: XG_DAO, ownerId, step: 'choice', data: { cardId: p.cardId, options } })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'choice') askOption(host, XG_DAO, ownerId, 'choice', '【蹈节】：选择失去体力，或失去锁定技令同族角色获得此牌', prompt.data.options as Array<{id:string;label:string}>, prompt.data, false)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'choice') return
  const choice = (response.payload as { optionId?: string }).optionId ?? ''
  if (choice === 'lose') { loseHp(host, ownerId, 1, XG_DAO); return }
  const [, skillId, targetId] = choice.split(':')
  if (!skillId || !targetId) return
  const cardId = resolution.data.cardId as CardId
  if (!player(host.state, targetId)?.alive || !host.state.cards[cardId]) return
  const zone = locateOwnedCard(host.state, ownerId, cardId)
  const from = zone ?? (host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const }
    : host.state.zones.processingArea.includes(cardId) ? { kind: 'processingArea' as const } : null)
  if (!from) return
  // 选择锁定技是代价：永久失去的是荀灌的技能；同族角色只获得正在结算的牌。
  const source = player(host.state, ownerId)
  if (!source) return
  source.permanentlyLostSkills ??= []
  if (!source.permanentlyLostSkills.includes(skillId)) source.permanentlyLostSkills.push(skillId)
  if (from.kind === 'equipment') handleEquipmentLost(host, ownerId, cardId)
  moveCard(host.state, cardId, from, { kind: 'hand', playerId: targetId })
  host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: '蹈节' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
} })

// 【云影】将受击/失牌事实按本回合记录；全黑手牌通过正式基本牌使用入口逐张结算。
registerSkillRuntime({ id: XG_YUN,
  globalIgnoresDistanceToCard(state, ownerId, actorId, _targetId, cardId) {
    return actorId === ownerId && (ext(state).b91?.xunguanFreeSlashCards?.[ownerId] ?? []).includes(cardId)
  },
  triggers: [
    { event: 'LoseHp', handle(host, _ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; amount?: number }
      if (p.playerId && Number(p.amount ?? 0) > 0) setXunguanFlag(host.state, p.playerId, 'hpReduced')
    } },
    { event: 'Damaged', handle(host, _ownerId, context) {
      const targetId = context.event.targetId
      if (targetId) setXunguanFlag(host.state, targetId, 'hpReduced')
    } },
    { event: 'HandCardLeft', handle(host, _ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId }
      if (p.playerId) setXunguanFlag(host.state, p.playerId, 'handLost')
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null }
      if (!p.cardId || !host.state.zones.discardPile.includes(p.cardId)) return
      const color = effectiveCardColor(host.state, p.fromPlayerId ?? ownerId, p.cardId, skillIdsOf)
      if (color !== 'black') return
      const state = ext(host.state); state.b91 ??= {}; state.b91.xunguanBlackDiscards ??= {}
      let entry = state.b91.xunguanBlackDiscards[ownerId]
      if (!entry || entry.turn !== host.state.turnNumber)
        entry = state.b91.xunguanBlackDiscards[ownerId] = { turn: host.state.turnNumber, cardIds: [] }
      if (!entry.cardIds.includes(p.cardId)) entry.cardIds.push(p.cardId)
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (p.playerId !== host.state.currentPlayerId || p.phase !== 'finish') return
      const targetId = ext(host.state).b91?.xunguanLastTarget?.[ownerId]
      if (!targetId) return
      const flag = ext(host.state).b91?.xunguanTurnFlags?.[targetId]
      if (!flag || flag.turn !== host.state.turnNumber) return
      const slashIds = flag.hpReduced
        ? hand(host.state, ownerId).filter((cardId) => effectiveCardColor(host.state, ownerId, cardId) === 'black')
        : []
      const discardRecord = ext(host.state).b91?.xunguanBlackDiscards?.[ownerId]
      const blackDiscardCount = discardRecord?.turn === host.state.turnNumber
        ? discardRecord.cardIds.filter((cardId) => host.state.zones.discardPile.includes(cardId)).length : 0
      const drawTo = flag.handLost ? Math.min(5, blackDiscardCount) : 0
      if (!slashIds.length) {
        const amount = Math.max(0, drawTo - hand(host.state, ownerId).length)
        if (amount) drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
        return
      }
      const state = ext(host.state); state.b91 ??= {}; state.b91.xunguanYunyingPending ??= {}
      state.b91.xunguanYunyingPending[ownerId] = { turn: host.state.turnNumber, cardIds: slashIds, drawTo }
      host.queueSkill({ skillId: XG_YUN, ownerId, step: 'use-black-slash', data: { cardId: slashIds[0] } })
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const resolvedCardId = (context.event.payload as { cardId?: CardId }).cardId
      if (resolvedCardId) {
        const allowed = ext(host.state).b91?.xunguanFreeSlashCards?.[ownerId]
        if (allowed?.includes(resolvedCardId))
          ext(host.state).b91!.xunguanFreeSlashCards![ownerId] = allowed.filter((id) => id !== resolvedCardId)
      }
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== XG_YUN) return
      const pending = ext(host.state).b91?.xunguanYunyingPending?.[ownerId]
      if (!pending) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      pending.cardIds = pending.cardIds.filter((candidate) => candidate !== cardId)
      if (pending.cardIds.length) host.queueSkill({ skillId: XG_YUN, ownerId, step: 'use-black-slash', data: { cardId: pending.cardIds[0] } })
      else {
        const amount = Math.max(0, pending.drawTo - hand(host.state, ownerId).length)
        delete ext(host.state).b91?.xunguanYunyingPending?.[ownerId]
        if (amount) drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'use-black-slash') return
    const cardId = prompt.data.cardId as CardId
    const candidates = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
      && canTarget(host.state, ownerId, candidate.id, Number.POSITIVE_INFINITY, cardId)).map((candidate) => candidate.id)
    if (!hand(host.state, ownerId).includes(cardId) || !candidates.length) {
      const pending = ext(host.state).b91?.xunguanYunyingPending?.[ownerId]
      if (pending) {
        pending.cardIds = pending.cardIds.filter((id) => id !== cardId)
        if (pending.cardIds.length) host.queueSkill({ skillId: XG_YUN, ownerId, step: 'use-black-slash', data: { cardId: pending.cardIds[0] } })
        else {
          const amount = Math.max(0, pending.drawTo - hand(host.state, ownerId).length)
          delete ext(host.state).b91?.xunguanYunyingPending?.[ownerId]
          if (amount) drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
        }
      }
      return
    }
    askTargets(host, XG_YUN, ownerId, 'choose-slash-target', `【云影】：选择【${host.state.cards[cardId]?.name ?? '黑色牌'}】当【杀】的目标`,
      candidates, { cardId })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-slash-target') return
    const cardId = resolution.data.cardId as CardId
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !hand(host.state, ownerId).includes(cardId)) return
    const state = ext(host.state); state.b91 ??= {}; state.b91.xunguanFreeSlashCards ??= {}
    state.b91.xunguanFreeSlashCards[ownerId] ??= []
    if (!state.b91.xunguanFreeSlashCards[ownerId]!.includes(cardId)) state.b91.xunguanFreeSlashCards[ownerId]!.push(cardId)
    if (!host.beginSkillBasicUse({ sourceId: ownerId, cardId, cardName: '杀', targetIds: [targetId], sourceSkillId: XG_YUN })) {
      state.b91.xunguanFreeSlashCards[ownerId] = state.b91.xunguanFreeSlashCards[ownerId]!.filter((id) => id !== cardId)
      const pending = state.b91.xunguanYunyingPending?.[ownerId]
      if (pending) {
        pending.cardIds = pending.cardIds.filter((id) => id !== cardId)
        if (pending.cardIds.length) host.queueSkill({ skillId: XG_YUN, ownerId, step: 'use-black-slash', data: { cardId: pending.cardIds[0] } })
        else {
          const amount = Math.max(0, pending.drawTo - hand(host.state, ownerId).length)
          delete state.b91.xunguanYunyingPending?.[ownerId]
          if (amount) drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
        }
      }
    }
  },
})

function setXunguanFlag(state: SanguoshaState, playerId: PlayerId, flagName: 'hpReduced' | 'handLost') {
  const b91 = ext(state); b91.b91 ??= {}; b91.b91.xunguanTurnFlags ??= {}
  let flag = b91.b91.xunguanTurnFlags[playerId]
  if (!flag || flag.turn !== state.turnNumber) {
    flag = { turn: state.turnNumber, hpReduced: false, handLost: false }
    b91.b91.xunguanTurnFlags[playerId] = flag
  }
  flag[flagName] = true
}

