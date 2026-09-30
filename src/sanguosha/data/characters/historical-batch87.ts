import type { CharacterDefinition } from './types'
import type { CardCategory, CardId, EquipmentSlot, PlayerId, SanguoshaState, Suit, TurnPhase } from '../../engine/types'
import { characterSkillIdsOf, grantSkill, isCardUseProhibited, isCardProtectedFromDiscard, isTargetProhibited, getSkillRuntime, ownedSkillIds, registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import { suppressArmorForCard } from '../../engine/armor-suppression'
import { ABOLISHABLE_SLOTS, abolishSlot, abolishableSlotsOf, abolishedSlotsOf, restoreSlot, SLOT_LABELS, weaponCardsOf } from '../../engine/equipment-slots'
import { handleEquipmentLost } from '../../engine/equipment'
import { isSkillSuppressed, suppressSkill } from '../../engine/skill-suppression'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest } from '../../engine/requests'
import { discardCardsByIds } from '../../engine/discard-all'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { giveCards } from '../../engine/hand-transfer'
import { equipmentSlotsOf } from '../../engine/equipment-slots'
import { useEquipmentFromSkill } from '../../engine/skill-equipment-use'
import { equipmentSlotsForSkillUse } from '../../engine/skill-equipment-use'
import type { CardEngineHost } from '../../engine/cards/host'
import { flipCharacter, isFaceDown } from '../../engine/character-state'
import { reshuffleDrawPile } from '../../engine/deck'
import { schedulePhaseSkipForPlayer } from '../../engine/turn'
import { cancelCardTargetForOwner } from '../../engine/target-cancellation'
import { forceDeath } from '../../engine/damage'
import { resumeTargetDamagePrevention } from '../../engine/damage'
import { queueExtraPhaseAfterTurnEnd } from '../../engine/extra-phase'
import { canTarget } from '../../engine/distance'
import { canUseSlash, canUseSlashAtTargets } from '../../engine/slash-rules'
import type { DamagePreventionContext } from '../../engine/skills/runtime'
import type { GameEvent } from '../../engine/events'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { legalPlayActions } from '../../engine/cards/basic'
import { loseHp, setCurrentHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { revealedGeneralCharacterIdsOf } from '../../engine/general-slots'
import { ALL_CHARACTERS, getCharacter } from './standard'

const B = '-b87'
const sid = (name: string) => `${name}${B}`
export const XIAHOU_EN_CHIJIAN = sid('chijian-xiahoun')
export const XIAHOU_EN_SHIWU = sid('shiwu-xiahoun')
export const HUAN_HUAIJIN_CILI = sid('cili-huanhuaijin')
export const HUAN_HUAIJIN_LIANYOU = sid('lianyou-huanhuaijin')
export const LIU_ZHEN_WUJUE = sid('wujue-liuzhen')
export const LIU_ZHEN_ZHENGU = sid('zhengu-liuzhen')
export const LI_ZHAOYI_MINGJIE = sid('mingjie-lizhaoyi')
export const LI_ZHAOYI_XIANFU = sid('xianfu-lizhaoyi')
export const XING_DONGYUN_ZHENGTING = sid('zhengting-xingdongyun')
export const XING_DONGYUN_BISHI = sid('bishi-xingdongyun')
export const WEI_ZHANG_XINGCAI_HUANGNU = sid('huangnu-wei-zhangxingcai')
export const WEI_ZHANG_XINGCAI_XIANKUANG = sid('xiankuang-wei-zhangxingcai')
export const XING_XIAHOU_BA_WEIGU = sid('weigu-xing-xiahouba')
export const XING_XIAHOU_BA_JUEFA = sid('juefa-xing-xiahouba')
export const SHEN_CAO_PI_YINZHI = sid('yin-zhi-shen-caopi')
export const SHEN_CAO_PI_KEMING = sid('ke-ming-shen-caopi')
export const LE_CAO_ZHI_FULE = sid('fu-le-le-caozhi')
export const LE_CAO_ZHI_WENLAN = sid('wen-lan-le-caozhi')
export const WEI_MA_TENG_HEQI = sid('he-qi-wei-mateng')
export const WEI_MA_TENG_HUIRUI = sid('hui-rui-wei-mateng')
export const WEI_MA_TENG_XIAOBEN = sid('xiao-ben-wei-mateng')

type DuelRecord = { targetId: PlayerId; cardId: CardId }
type Batch87State = {
  xiahouDuel?: Record<string, DuelRecord>
  temporaryChijianTargets?: Record<string, PlayerId[]>
  bishiUsedRound?: Record<string, number>
  bishiExtraPhases?: Record<string, { ownerId: PlayerId; targetId: PlayerId; roundNumber: number; usedCount: number; firstCardId?: CardId }>
  huangnu?: Record<string, { turnNumber: number; uses: number; disabled: boolean }>
  huangnuPendingSlash?: Record<CardId, { ownerId: PlayerId; turnNumber: number }>
  huangnuNextCard?: Record<string, { ownerId: PlayerId; turnNumber: number; cardId?: CardId }>
  xiankuang?: Record<string, { turnNumber: number; gained: number; disabled: boolean }>
  xiahoubaJuefa?: Record<string, { used: boolean; active: boolean; expiresOnTurn: number; killed: boolean }>
  xiahoubaCardResolution?: Record<CardId, { ownerId: PlayerId; damaged: boolean }>
  xiahoubaPrompted?: Record<CardId, PlayerId>
  xiahoubaPendingJuefaDamage?: Record<string, { targetId: PlayerId; cardId: CardId }>
  xiahoubaPendingDraw?: Record<string, number>
  shenCaopiYinzhiCount?: Record<string, number>
  shenCaopiYinzhi?: Record<string, { targetId: PlayerId; uses: number; gainedCardIds: CardId[]; restrictionTurn?: number; drawUntilTurnStart: boolean }>
  shenCaopiKemingWatch?: Record<string, { targetId: PlayerId; armedAtSeq: number }>
  leCaozhiFuCards?: Record<CardId, { alternateName: string }>
  leCaozhiPair?: Record<string, Array<{ cardId: CardId; cardName: string; fuNames: string[] }>>
  weiMaTengRides?: Record<PlayerId, number>
  weiMaTengExtraSlashes?: Record<PlayerId, { targetId: PlayerId; remaining: number }>
  weiMaTengLastCard?: Record<PlayerId, { turnNumber: number; damage: boolean; nonBasic: boolean }>
  weiMaTengDamageQueue?: Record<PlayerId, PlayerId[]>
}
function b87(state: SanguoshaState): Batch87State {
  const root = state as unknown as Record<string, unknown>
  return (root.paperSanguoshaB87 ??= {}) as Batch87State
}

type LiZhaoyiState = { partner?: Record<string, PlayerId>; shield?: Record<string, boolean>; xianfuTurn?: Record<string, number> }
function liZhaoyiState(state: SanguoshaState): LiZhaoyiState {
  const root = state as unknown as Record<string, unknown>
  return (root.paperSanguoshaB87 ??= {}) as LiZhaoyiState
}

const ZHENGTING_SUITS: readonly Suit[] = ['spade', 'heart', 'club', 'diamond']
type ZhengtingData = { targetId: PlayerId; actorIndex: number; suitIndex: number; kept: Record<string, CardId[]> }
function playerOf(state: SanguoshaState, playerId: PlayerId) { return state.players.find((p) => p.id === playerId) }

function yinZhiKey(ownerId: PlayerId, targetId: PlayerId): string { return `${ownerId}:${targetId}` }

function chooseFuName(host: SkillHost, cardId: CardId, excludeName?: string): string | undefined {
  const card = host.state.cards[cardId]
  if (!card) return undefined
  const names = [...new Set(Object.values(host.state.cards)
    .filter((candidate) => candidate.category !== 'equipment' && candidate.name !== card.name && candidate.name !== excludeName)
    .map((candidate) => candidate.name))]
  return names.length ? host.rng.pick(names) : undefined
}

function markFu(host: SkillHost, cardId: CardId, replace: boolean): void {
  const card = host.state.cards[cardId]
  if (!card || card.category === 'equipment') return
  const state = b87(host.state)
  state.leCaozhiFuCards ??= {}
  if (!replace && state.leCaozhiFuCards[cardId]) return
  const previousName = state.leCaozhiFuCards[cardId]?.alternateName
  const alternateName = chooseFuName(host, cardId, replace ? previousName : undefined)
  if (alternateName) state.leCaozhiFuCards[cardId] = { alternateName }
}

function fuNames(state: SanguoshaState, cardId: CardId): string[] {
  const card = state.cards[cardId]
  const alternate = b87(state).leCaozhiFuCards?.[cardId]?.alternateName
  return card && alternate ? [card.name, alternate] : []
}

registerSkillRuntime({
  id: LE_CAO_ZHI_FULE,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    for (const cardId of owner?.zones.hand ?? []) markFu(host, cardId, false)
  },
  handLimitExempt(state, ownerId, cardId) {
    return playerOf(state, ownerId)?.zones.hand.includes(cardId) === true
      && b87(state).leCaozhiFuCards?.[cardId] !== undefined
  },
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    return owner.zones.hand.flatMap((cardId) => {
      const alternateName = b87(state).leCaozhiFuCards?.[cardId]?.alternateName
      if (!alternateName) return []
      const card = state.cards[cardId]
      return card ? [{ asCardName: alternateName, cardId, label: `以【赋】将【${card.name}】当【${alternateName}】使用` }] : []
    })
  },
})

registerSkillRuntime({
  id: LE_CAO_ZHI_WENLAN,
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const cardId = payload.cardId
      if (!cardId || !payload.cardName) return
      recordLeCaozhiCard(host, ownerId, cardId, payload.cardName)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; cardName?: string; asking?: boolean }
      if (payload.asking || payload.playerId !== ownerId || !payload.cardName) return
      recordLeCaozhiCard(host, ownerId, payload.cardId ?? `virtual-response:${context.event.id}` as CardId, payload.cardName)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'gain-matching-fu') {
      for (const name of prompt.data.names as string[]) {
        const cardId = host.state.zones.drawPile.find((id) => host.state.cards[id]?.name === name)
        if (!cardId) continue
        moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        markFu(host, cardId, false)
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: LE_CAO_ZHI_WENLAN },
          { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      }
      return
    }
    if (prompt.step !== 'choose-fu-cards' || owner.zones.hand.length === 0) return
    const hand = [...owner.zones.hand]
    host.askSkill({ skillId: LE_CAO_ZHI_WENLAN, ownerId, step: 'choose-fu-cards', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId,
      prompt: '【文澜】：选择任意张手牌标记为“赋”或重新随机其“赋”牌名',
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: hand, viewOnlyCardIds: hand,
      hiddenCardSlots: [], min: 0, max: hand.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-fu-cards') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    for (const cardId of cardIds) {
      if (!owner.zones.hand.includes(cardId)) continue
      markFu(host, cardId, b87(host.state).leCaozhiFuCards?.[cardId] !== undefined)
    }
  },
})

function recordLeCaozhiCard(host: SkillHost, ownerId: PlayerId, cardId: CardId, cardName: string): void {
  const state = b87(host.state)
  const pair = state.leCaozhiPair ??= {}
  const cards = pair[ownerId] ??= []
  cards.push({ cardId, cardName, fuNames: fuNames(host.state, cardId) })
  if (cards.length < 2) return
  const [first, second] = cards.splice(0, 2)
  const sharedName = first.fuNames.some((name) => second.fuNames.includes(name))
  if (sharedName && first.fuNames.length && second.fuNames.length) {
    host.queueSkill({ skillId: LE_CAO_ZHI_WENLAN, ownerId, step: 'gain-matching-fu', data: { names: [first.cardName, second.cardName] } })
    return
  }
  host.queueSkill({ skillId: LE_CAO_ZHI_WENLAN, ownerId, step: 'choose-fu-cards', data: {} })
}

function rideCount(state: SanguoshaState, playerId: PlayerId): number {
  return Math.max(0, Math.trunc(b87(state).weiMaTengRides?.[playerId] ?? 0))
}

function setRideCount(state: SanguoshaState, playerId: PlayerId, count: number): void {
  const rides = b87(state).weiMaTengRides ??= {}
  const safeCount = Math.max(0, Math.trunc(count))
  if (safeCount) rides[playerId] = safeCount
  else delete rides[playerId]
  const target = playerOf(state, playerId)
  if (target) {
    if (safeCount) target.marks['骑'] = safeCount
    else delete target.marks['骑']
  }
}

function beginMaTengExtraSlash(host: SkillHost, ownerId: PlayerId): void {
  const extra = b87(host.state).weiMaTengExtraSlashes?.[ownerId]
  if (!extra || extra.remaining <= 0 || !playerOf(host.state, extra.targetId)?.alive) {
    delete b87(host.state).weiMaTengExtraSlashes?.[ownerId]
    return
  }
  extra.remaining -= 1
  const begun = host.beginVirtualSlash({ sourceId: ownerId, targetId: extra.targetId, sourceSkillId: WEI_MA_TENG_HEQI,
    ignoreDistance: true, damageSourceId: null })
  if (!begun) delete b87(host.state).weiMaTengExtraSlashes?.[ownerId]
}

function continueMaTengDamage(host: SkillHost, ownerId: PlayerId): void {
  const queue = b87(host.state).weiMaTengDamageQueue?.[ownerId]
  if (!queue?.length) { delete b87(host.state).weiMaTengDamageQueue?.[ownerId]; return }
  const targetId = queue.shift()!
  resolveDamage(host as never, { sourceId: null, targetId, amount: 1, nature: 'normal', sourceSkillId: WEI_MA_TENG_XIAOBEN })
}

registerSkillRuntime({
  id: WEI_MA_TENG_HEQI,
  onGameStart(host, ownerId) { setRideCount(host.state, ownerId, rideCount(host.state, ownerId) + 3) },
  ignoresDistanceTo(state, ownerId, targetId) { return rideCount(state, targetId) > 0 && ownerId !== targetId },
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; cancelled?: boolean; sourceSkillId?: string }
      if (context.event.sourceId !== ownerId || payload.sourceSkillId === WEI_MA_TENG_HEQI
        || payload.cardName !== '杀' || payload.cancelled || host.state.status !== 'playing') return
      const targets = host.state.players.filter((target) => target.alive && target.id !== ownerId && rideCount(host.state, target.id) > 0)
      if (!targets.length) return
      host.queueSkill({ skillId: WEI_MA_TENG_HEQI, ownerId, step: 'choose-target', data: {} })
    } },
    { event: 'CardResolved', priority: 100, handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId
        || (context.event.payload as { sourceSkillId?: string }).sourceSkillId !== WEI_MA_TENG_HEQI) return
      const extra = b87(host.state).weiMaTengExtraSlashes?.[ownerId]
      if (extra && extra.remaining > 0) beginMaTengExtraSlash(host, ownerId)
      else delete b87(host.state).weiMaTengExtraSlashes?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-target') return
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId && rideCount(host.state, target.id) > 0)
    if (!candidates.length || !playerOf(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: WEI_MA_TENG_HEQI, ownerId, step: 'choose-target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【合骑】：是否对一名拥有“骑”的其他角色使用等同其“骑”数的【杀】？',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map(({ id }) => id), min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
    const count = rideCount(host.state, targetId)
    if (count === 0) return
    const extraSlashes = b87(host.state).weiMaTengExtraSlashes ??= {}
    extraSlashes[ownerId] = { targetId, remaining: count }
    beginMaTengExtraSlash(host, ownerId)
  },
})

registerSkillRuntime({
  id: WEI_MA_TENG_HUIRUI,
  triggers: [
    { event: 'PlayPhase', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (playerId === ownerId) host.queueSkill({ skillId: WEI_MA_TENG_HUIRUI, ownerId, step: 'choose-mode', data: {} })
    } },
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId) host.queueSkill({ skillId: WEI_MA_TENG_HUIRUI, ownerId, step: 'choose-mode', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (!playerOf(host.state, ownerId)?.alive) return
    const options = [
      { id: 'gain', label: '获得2个“骑”' },
      ...(host.state.players.some((player) => rideCount(host.state, player.id) > 0)
        && host.state.players.some((player) => player.alive && player.id !== ownerId)
        ? [{ id: 'move', label: '移动场上1个“骑”至另一名角色处' }] : []),
      ...(host.state.players.some((player) => player.alive && player.id !== ownerId)
        ? [{ id: 'slash', label: '视为使用一张【杀】' }] : []),
    ]
    if (prompt.step === 'choose-mode') host.askSkill({ skillId: WEI_MA_TENG_HUIRUI, ownerId, step: 'choose-mode', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【挥锐】：选择一项', timeoutMs: 25_000, optional: true,
      options: [...options, { id: 'cancel', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const optionId = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'choose-mode') {
      if (optionId === 'gain') setRideCount(host.state, ownerId, rideCount(host.state, ownerId) + 2)
      else if (optionId === 'move') {
        const candidates = host.state.players.filter((player) => rideCount(host.state, player.id) > 0)
        host.askSkill({ skillId: WEI_MA_TENG_HUIRUI, ownerId, step: 'move-source', data: {}, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【挥锐】：选择拥有“骑”的角色', timeoutMs: 25_000,
          optional: false, candidateIds: candidates.map(({ id }) => id), min: 1, max: 1,
        }) })
      } else if (optionId === 'slash') {
        const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
          && canTarget(host.state, ownerId, target.id)
          && canUseSlashAtTargets(host.state, ownerId, false, [target.id])
          && !isTargetProhibited(host.state, ownerId, target.id, '杀', characterSkillIdsOf))
        host.askSkill({ skillId: WEI_MA_TENG_HUIRUI, ownerId, step: 'slash-target', data: {}, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【挥锐】：选择【杀】的目标', timeoutMs: 25_000,
          optional: false, candidateIds: candidates.map(({ id }) => id), min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'slash-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && playerOf(host.state, targetId)?.alive)
        host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: WEI_MA_TENG_HUIRUI, countUsage: true })
      return
    }
    if (resolution.step === 'move-source') {
      const sourceId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!sourceId || rideCount(host.state, sourceId) < 1) return
      const candidates = host.state.players.filter((player) => player.alive && player.id !== sourceId)
      host.askSkill({ skillId: WEI_MA_TENG_HUIRUI, ownerId, step: 'move-destination', data: { sourceId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【挥锐】：选择“骑”的移动目标', timeoutMs: 25_000,
        optional: false, candidateIds: candidates.map(({ id }) => id), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'move-destination') {
      const sourceId = resolution.data.sourceId as PlayerId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || targetId === sourceId || rideCount(host.state, sourceId) < 1 || !playerOf(host.state, targetId)?.alive) return
      setRideCount(host.state, sourceId, rideCount(host.state, sourceId) - 1)
      setRideCount(host.state, targetId, rideCount(host.state, targetId) + 1)
    }
  },
})

registerSkillRuntime({
  id: WEI_MA_TENG_XIAOBEN,
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; sourceSkillId?: string }
      if (context.event.sourceId !== ownerId || payload.sourceSkillId === WEI_MA_TENG_XIAOBEN) return
      if (!payload.cardId || !payload.cardName) return
      const card = host.state.cards[payload.cardId]
      if (!card) return
      const damage = payload.cardName === '杀' || DAMAGE_TRICKS.has(payload.cardName)
      const nonBasic = card.category !== 'basic'
      const state = b87(host.state)
      const previous = state.weiMaTengLastCard?.[ownerId]
      state.weiMaTengLastCard ??= {}
      state.weiMaTengLastCard[ownerId] = { turnNumber: host.state.turnNumber, damage, nonBasic }
      if (previous?.turnNumber === host.state.turnNumber && ((previous.damage && nonBasic) || (previous.nonBasic && damage)))
        host.queueSkill({ skillId: WEI_MA_TENG_XIAOBEN, ownerId, step: 'activate', data: {} })
    } },
    { event: 'DamageSettled', priority: -100, handle(host, ownerId, context) {
      if (context.event.sourceSkillId !== WEI_MA_TENG_XIAOBEN
        && (context.event.payload as { reason?: string }).reason !== WEI_MA_TENG_XIAOBEN) return
      continueMaTengDamage(host, ownerId)
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (playerId === ownerId) delete b87(host.state).weiMaTengLastCard?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'activate' || !playerOf(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: WEI_MA_TENG_XIAOBEN, ownerId, step: 'activate', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【骁贲】：是否移动1个“骑”，并移除所有其他角色的“骑”造成等量无来源伤害？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动【骁贲】' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { targetIds?: PlayerId[]; optionId?: string }
    if (resolution.step === 'activate') {
      if (payload.optionId !== 'yes') return
      const sources = host.state.players.filter((player) => player.alive && rideCount(host.state, player.id) > 0)
      if (!sources.length) return
      host.askSkill({ skillId: WEI_MA_TENG_XIAOBEN, ownerId, step: 'choose-source', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【骁贲】：选择移动哪一名角色的1个“骑”',
        timeoutMs: 25_000, optional: false, candidateIds: sources.map(({ id }) => id), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-source') {
      const sourceId = payload.targetIds?.[0]
      if (!sourceId || rideCount(host.state, sourceId) < 1) return
      const destinations = host.state.players.filter((player) => player.alive && player.id !== sourceId)
      host.askSkill({ skillId: WEI_MA_TENG_XIAOBEN, ownerId, step: 'choose-destination', data: { sourceId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【骁贲】：选择“骑”移动后的角色', timeoutMs: 25_000,
        optional: false, candidateIds: destinations.map(({ id }) => id), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-destination') {
      const sourceId = resolution.data.sourceId as PlayerId
      const destinationId = payload.targetIds?.[0]
      if (!destinationId || sourceId === destinationId || rideCount(host.state, sourceId) < 1
        || !playerOf(host.state, destinationId)?.alive) return
      setRideCount(host.state, sourceId, rideCount(host.state, sourceId) - 1)
      setRideCount(host.state, destinationId, rideCount(host.state, destinationId) + 1)
      const otherRideHolders = host.state.players.some((player) => player.alive && player.id !== ownerId && rideCount(host.state, player.id) > 0)
      if (!otherRideHolders) return
      host.askSkill({ skillId: WEI_MA_TENG_XIAOBEN, ownerId, step: 'choose-purge', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【骁贲】：是否移除所有其他角色的“骑”？每移除1个其便受到1点无来源伤害。',
        timeoutMs: 25_000, optional: true, options: [{ id: 'purge', label: '移除并造成伤害' }, { id: 'keep', label: '保留“骑”' }],
      }) })
      return
    }
    if (resolution.step === 'choose-purge' && payload.optionId === 'purge') {
      const queue: PlayerId[] = []
      for (const player of host.state.players) {
        if (!player.alive || player.id === ownerId) continue
        const count = rideCount(host.state, player.id)
        for (let index = 0; index < count; index += 1) queue.push(player.id)
        setRideCount(host.state, player.id, 0)
      }
      const damageQueues = b87(host.state).weiMaTengDamageQueue ??= {}
      damageQueues[ownerId] = queue
      continueMaTengDamage(host, ownerId)
    }
  },
})

registerSkillRuntime({
  id: SHEN_CAO_PI_YINZHI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId
      && !usedThisPhase(state, ownerId, SHEN_CAO_PI_YINZHI)
      && !!owner?.alive && state.players.some((player) => player.alive && player.id !== ownerId)
      ? [{ id: `${SHEN_CAO_PI_YINZHI}:activate`, label: '阴鸷' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${SHEN_CAO_PI_YINZHI}:activate` || host.state.phase !== 'play'
      || host.state.currentPlayerId !== ownerId || usedThisPhase(host.state, ownerId, SHEN_CAO_PI_YINZHI)) return
    host.queueSkill({ skillId: SHEN_CAO_PI_YINZHI, ownerId, step: 'choose-target', data: {} })
  },
  triggers: [
    { event: 'TurnStart', priority: 100, handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId) return
      const record = b87(host.state).shenCaopiYinzhi?.[yinZhiKey(ownerId, targetId)]
      if (record && record.restrictionTurn === undefined) {
        record.drawUntilTurnStart = false
        record.restrictionTurn = host.state.turnNumber
      }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId) return
      const state = b87(host.state)
      const key = yinZhiKey(ownerId, targetId)
      if (state.shenCaopiYinzhi?.[key]?.restrictionTurn === host.state.turnNumber) delete state.shenCaopiYinzhi[key]
    } },
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      const targetId = payload.playerId
      if (!targetId || host.state.currentPlayerId !== targetId) return
      const record = b87(host.state).shenCaopiYinzhi?.[yinZhiKey(ownerId, targetId)]
      if (!record || record.restrictionTurn !== host.state.turnNumber) return
      for (const cardId of payload.cardIds ?? []) if (!record.gainedCardIds.includes(cardId)) record.gainedCardIds.push(cardId)
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { fromKind?: string; playerId?: PlayerId }
      const targetId = context.event.sourceId ?? payload.playerId
      if (!targetId || payload.fromKind !== 'hand') return
      const record = b87(host.state).shenCaopiYinzhi?.[yinZhiKey(ownerId, targetId)]
      if (record?.drawUntilTurnStart && host.state.players.find((player) => player.id === ownerId)?.alive)
        drawCards(host.state, host.rng, ownerId, record.uses, (name, payload) => host.dispatch(name, payload))
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { fromKind?: string; playerId?: PlayerId }
      const targetId = context.event.sourceId ?? payload.playerId
      if (!targetId || payload.fromKind !== 'hand') return
      const record = b87(host.state).shenCaopiYinzhi?.[yinZhiKey(ownerId, targetId)]
      if (record?.drawUntilTurnStart && host.state.players.find((player) => player.id === ownerId)?.alive)
        drawCards(host.state, host.rng, ownerId, record.uses, (name, payload) => host.dispatch(name, payload))
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      const amount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      if (sourceId === undefined || !targetId || amount <= 0) return
      const key = yinZhiKey(ownerId, sourceId)
      const record = b87(host.state).shenCaopiYinzhi?.[key]
      if (targetId !== ownerId || !record) return
      delete b87(host.state).shenCaopiYinzhi?.[key]
      host.state.skillSuppressions = (host.state.skillSuppressions ?? []).filter((entry) =>
        !(entry.sourceId === ownerId && entry.targetId === sourceId && entry.sourceSkillId === SHEN_CAO_PI_YINZHI))
    } },
  ],
  prohibitsCardUse(state, ownerId, context: string | { userId: PlayerId; cardName: string; dyingPlayerId: PlayerId | null; cardIds?: readonly CardId[] }) {
    if (typeof context === 'string') return false
    const record = b87(state).shenCaopiYinzhi?.[yinZhiKey(ownerId, context.userId)]
    if (!record || record.restrictionTurn !== state.turnNumber || state.currentPlayerId !== context.userId) return false
    return !context.cardIds?.length || context.cardIds.some((cardId) => !record.gainedCardIds.includes(cardId))
  },
  prohibitsResponseCard(state, ownerId, responderId, responseCardId) {
    const record = b87(state).shenCaopiYinzhi?.[yinZhiKey(ownerId, responderId)]
    return !!record && record.restrictionTurn === state.turnNumber && state.currentPlayerId === responderId
      && !record.gainedCardIds.includes(responseCardId)
  },
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'choose-target' || !host.state.players.find((player) => player.id === ownerId)?.alive) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (!candidates.length) return
    host.askSkill({ skillId: SHEN_CAO_PI_YINZHI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【阴鸷】：选择一名其他角色', timeoutMs: 25_000,
      optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || targetId === ownerId || !playerOf(host.state, targetId)?.alive
      || !playerOf(host.state, ownerId)?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
    markUsedThisPhase(host.state, ownerId, SHEN_CAO_PI_YINZHI)
    const state = b87(host.state)
    const key = yinZhiKey(ownerId, targetId)
    const uses = state.shenCaopiYinzhiCount ??= {}
    uses[key] = (uses[key] ?? 0) + 1
    const drawCount = Math.min(3, uses[key]!)
    const records = state.shenCaopiYinzhi ??= {}
    const previousRestrictionTurn = records[key]?.restrictionTurn
    records[key] = { targetId, uses: drawCount, gainedCardIds: [], drawUntilTurnStart: true,
      ...(previousRestrictionTurn !== undefined ? { restrictionTurn: previousRestrictionTurn } : {}) }
    drawCards(host.state, host.rng, ownerId, drawCount, (name, payload) => host.dispatch(name, payload))
    suppressSkill(host.state, { targetId, scope: 'non-locked', sourceId: ownerId, sourceSkillId: SHEN_CAO_PI_YINZHI,
      expiresAt: 'turn-start', armedAtTurn: host.state.turnNumber })
  },
})

function caoclanDamagedSkillIds(): string[] {
  const ids = ALL_CHARACTERS.filter((character) => /^(?:(?:界|神|谋|威|势|星|SP|乐)·?)?曹/.test(character.name))
    .flatMap((character) => character.skills.map((skill) => skill.id))
  return [...new Set(ids)].filter((skillId) =>
    getSkillRuntime(skillId)?.triggers?.some((trigger) => trigger.event === 'Damaged'))
}

registerSkillRuntime({
  id: SHEN_CAO_PI_KEMING,
  triggers: [
  { event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !host.state.players.find((player) => player.id === ownerId)?.alive) return
    const sourceId = context.event.sourceId
    if (!sourceId || sourceId === ownerId || !playerOf(host.state, sourceId)?.alive) return
    const source = playerOf(host.state, sourceId)
    const printedSkills = source ? revealedGeneralCharacterIdsOf(source)
      .flatMap((characterId) => getCharacter(characterId)?.skills.map((skill) => skill.id) ?? []) : []
    const owned = new Set(ownedSkillIds(host.state, sourceId))
    const sourceSkillIds = [...new Set(printedSkills)].filter((skillId) => owned.has(skillId)
      && !isSkillSuppressed(host.state, sourceId, skillId)
      && getSkillRuntime(skillId)?.triggers?.some((trigger) => trigger.event === context.event.name))
    const fallbackSkillIds = sourceSkillIds.length ? [] : caoclanDamagedSkillIds()
    if (!sourceSkillIds.length && !fallbackSkillIds.length) return
    host.queueSkill({ skillId: SHEN_CAO_PI_KEMING, ownerId, step: 'offer-trigger', data: {
      sourceId, sourceSkillIds, fallbackSkillIds, event: structuredClone(context.event),
    } })
  } },
  { event: 'DamageSettled', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId
    const targetId = context.event.targetId
    const amount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
    if (sourceId !== ownerId || !targetId || targetId === ownerId || amount <= 0
      || !playerOf(host.state, targetId)?.alive) return
    const watches = b87(host.state).shenCaopiKemingWatch ??= {}
    watches[yinZhiKey(ownerId, targetId)] = { targetId, armedAtSeq: context.event.seq }
  } },
  { event: 'SkillEffectResolved', handle(host, ownerId, context) {
    const targetId = context.event.sourceId
    if (!targetId || host.state.currentPlayerId !== targetId || !['prepare', 'play', 'finish'].includes(host.state.phase)) return
    const watches = b87(host.state).shenCaopiKemingWatch
    const key = yinZhiKey(ownerId, targetId)
    const watch = watches?.[key]
    if (!watch || context.event.seq <= watch.armedAtSeq) return
    const payload = context.event.payload as { drawnCardNames?: string[]; usedCardNames?: string[] }
    const names = [...(payload.drawnCardNames ?? []), ...(payload.usedCardNames ?? [])]
      .filter((name): name is string => typeof name === 'string').slice(0, 5)
    delete watches[key]
    if (names.length) host.queueSkill({ skillId: SHEN_CAO_PI_KEMING, ownerId, step: 'offer-copy', data: { targetId, names } })
  } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'offer-copy') {
      const targetId = queued.data.targetId as PlayerId
      const names = (queued.data.names as string[]).slice(0, 5)
      if (!names.length || !playerOf(host.state, ownerId)?.alive) return
      host.askSkill({ skillId: SHEN_CAO_PI_KEMING, ownerId, step: 'copy-choice', data: { targetId, names },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: `【刻名】：${playerOf(host.state, targetId)?.nickname ?? '该角色'}于其技能效果中摸/使用了${names.length}张牌，是否摸取等量同名牌（至多五张）？`,
          timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '摸取这些牌的同名牌' }, { id: 'no', label: '不发动' }],
        }) })
      return
    }
    if (queued.step !== 'offer-trigger' || !playerOf(host.state, ownerId)?.alive) return
    const sourceId = queued.data.sourceId as PlayerId
    if (!playerOf(host.state, sourceId)?.alive) return
    const sourceSkillIds = queued.data.sourceSkillIds as string[]
    const fallbackSkillIds = queued.data.fallbackSkillIds as string[]
    const options = sourceSkillIds.map((skillId) => ({
      id: `source:${skillId}`,
      label: `触发${getCharacter(playerOf(host.state, sourceId)?.characterId ?? '')?.skills.find((skill) => skill.id === skillId)?.name ?? skillId}`,
    }))
    if (fallbackSkillIds.length) options.push({ id: 'fallback-random', label: '随机触发一个曹姓武将的此时机技能' })
    options.push({ id: 'decline', label: '不发动' })
    host.askSkill({ skillId: SHEN_CAO_PI_KEMING, ownerId, step: 'trigger-choice', data: queued.data,
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: sourceSkillIds.length
          ? `【刻名】：是否触发${playerOf(host.state, sourceId)?.nickname ?? '伤害来源'}的此时机技能？`
          : '【刻名】：是否随机触发一个曹姓武将的此时机技能？',
        timeoutMs: 25_000, optional: false, options,
      }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'copy-choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes'
        || !playerOf(host.state, ownerId)?.alive) return
      const names = (resolution.data.names as string[]).slice(0, 5)
      const gained: CardId[] = []
      for (const name of names) {
        const cardId = host.state.zones.drawPile.find((id) => host.state.cards[id]?.name === name)
        if (!cardId) continue
        moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        gained.push(cardId)
      }
      if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: SHEN_CAO_PI_KEMING, isDraw: true },
        { sourceId: ownerId, targetId: ownerId, cardIds: gained })
      return
    }
    if (resolution.step !== 'trigger-choice' || !playerOf(host.state, ownerId)?.alive) return
    const selected = (response.payload as { optionId?: string }).optionId
    if (!selected || selected === 'decline') return
    const data = resolution.data
    const sourceSkillIds = data.sourceSkillIds as string[]
    let skillId: string | undefined
    if (selected === 'fallback-random') {
      const candidates = (data.fallbackSkillIds as string[]).filter((id) =>
        getSkillRuntime(id)?.triggers?.some((trigger) => trigger.event === 'Damaged'))
      skillId = host.rng.shuffle(candidates)[0]
    } else if (selected.startsWith('source:')) {
      const candidate = selected.slice('source:'.length)
      if (sourceSkillIds.includes(candidate)) skillId = candidate
    }
    const runtime = skillId ? getSkillRuntime(skillId) : undefined
    const event = data.event as GameEvent
    if (!runtime || event.name !== 'Damaged' || event.targetId !== ownerId) return
    let cancelled = false
    const replay = { event, get cancelled() { return cancelled }, cancel() { cancelled = true } } as never
    for (const trigger of runtime.triggers ?? []) if (trigger.event === event.name) trigger.handle(host, ownerId, replay)
  },
})

function continueZhengtingDiscard(host: SkillHost, ownerId: PlayerId, data: ZhengtingData): void {
  const actors = [ownerId, data.targetId]
  while (data.actorIndex < actors.length) {
    const actorId = actors[data.actorIndex]!
    const actor = playerOf(host.state, actorId)
    if (!actor?.alive) { data.actorIndex += 1; data.suitIndex = 0; continue }
    if (data.suitIndex >= ZHENGTING_SUITS.length) { data.actorIndex += 1; data.suitIndex = 0; continue }
    const suit = ZHENGTING_SUITS[data.suitIndex]!
    const matching = actor.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === suit)
    if (matching.length <= 1) {
      if (matching[0]) (data.kept[actorId] ??= []).push(matching[0])
      data.suitIndex += 1
      continue
    }
    const observerId = actorId === ownerId ? data.targetId : ownerId
    const observer = playerOf(host.state, observerId)
    host.askSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId, step: 'choose-kept-card',
      data: structuredClone(data) as unknown as Record<string, unknown>, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: actorId, prompt: `【正听】：选择保留的一张${suit}手牌，其余此花色手牌弃置`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: matching,
        viewOnlyCardIds: observer?.alive ? [...observer.zones.hand] : [], hiddenCardSlots: [], min: 1, max: 1,
      }) })
    return
  }
  for (const actorId of actors) {
    const actor = playerOf(host.state, actorId)
    if (!actor?.alive) continue
    const keeps = new Set(data.kept[actorId] ?? [])
    const discard = actor.zones.hand.filter((cardId) => !keeps.has(cardId))
    if (discard.length) discardCardsByIds(host, actorId, discard, XING_DONGYUN_ZHENGTING)
  }
}

function drawMissingSuitCards(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const drawFor = (playerId: PlayerId) => {
    const player = playerOf(host.state, playerId)
    if (!player?.alive) return
    const ownedSuits = new Set(player.zones.hand.map((id) => host.state.cards[id]?.suit))
    const gained: CardId[] = []
    for (const suit of ZHENGTING_SUITS) {
      if (ownedSuits.has(suit)) continue
      const candidateIds = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.suit === suit)
      const cardId = host.rng.shuffle(candidateIds)[0]
      if (!cardId) continue
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
      gained.push(cardId)
      ownedSuits.add(suit)
    }
    if (gained.length) host.dispatch('GainCard', { playerId, cardIds: gained, reason: XING_DONGYUN_ZHENGTING },
      { sourceId: ownerId, targetId: playerId, cardIds: gained })
  }
  drawFor(ownerId)
  drawFor(targetId)
}

registerSkillRuntime({
  id: XING_DONGYUN_ZHENGTING,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, XING_DONGYUN_ZHENGTING)
      || !state.players.some((p) => p.alive && p.id !== ownerId)) return []
    return [{ id: `${XING_DONGYUN_ZHENGTING}:activate`, label: '正听' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${XING_DONGYUN_ZHENGTING}:activate` || host.state.phase !== 'play'
      || host.state.currentPlayerId !== ownerId || usedThisPhase(host.state, ownerId, XING_DONGYUN_ZHENGTING)) return
    host.queueSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId, step: 'choose-target', data: {} })
  },
  startQueued(host, ownerId, queued) {
    if (queued.step === 'choose-target') {
      const candidateIds = host.state.players.filter((p) => p.alive && p.id !== ownerId).map(({ id }) => id)
      if (!candidateIds.length) return
      host.askSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【正听】：选择一名其他角色并互相观看手牌',
        timeoutMs: 25_000, optional: true, candidateIds, min: 0, max: 1,
      }) })
      return
    }
    if (queued.step === 'reveal-owner' || queued.step === 'reveal-partner') {
      const targetId = queued.data.targetId as PlayerId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      const ownerViews = queued.step === 'reveal-owner'
      const viewerId = ownerViews ? ownerId : targetId
      const visibleIds = ownerViews ? target.zones.hand : owner.zones.hand
      host.askSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId, step: ownerViews ? 'view-target-hand' : 'view-owner-hand',
        data: { targetId }, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: viewerId,
          prompt: '【正听】：观看对方手牌（仅查看）', timeoutMs: 25_000, optional: false, purpose: 'skill',
          cardIds: [], viewOnlyCardIds: [...visibleIds], hiddenCardSlots: [], min: 0, max: 0 }) })
      return
    }
    if (queued.step === 'choose-mode') host.askSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId, step: 'mode', data: queued.data,
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【正听】：选择一项', timeoutMs: 25_000, optional: false,
        options: [{ id: 'discard', label: '双方分别保留每种花色各一张，其余弃置' },
          { id: 'draw', label: '双方各摸手牌中缺少的每种花色牌' }] }) })
    if (queued.step === 'discard-choice') continueZhengtingDiscard(host, ownerId, queued.data as unknown as ZhengtingData)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || targetId === ownerId || !playerOf(host.state, targetId)?.alive) return
      markUsedThisPhase(host.state, ownerId, XING_DONGYUN_ZHENGTING)
      host.queueSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId, step: 'reveal-owner', data: { targetId } })
      return
    }
    if (resolution.step === 'view-target-hand') {
      host.queueSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId, step: 'reveal-partner', data: resolution.data })
      return
    }
    if (resolution.step === 'view-owner-hand') {
      host.queueSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId, step: 'choose-mode', data: resolution.data })
      return
    }
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      const targetId = resolution.data.targetId as PlayerId
      if (!playerOf(host.state, targetId)?.alive) return
      if (mode === 'draw') drawMissingSuitCards(host, ownerId, targetId)
      else if (mode === 'discard') host.queueSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId,
        step: 'discard-choice', data: { targetId, actorIndex: 0, suitIndex: 0, kept: { [ownerId]: [], [targetId]: [] } } })
      return
    }
    if (resolution.step === 'choose-kept-card') {
      const data = resolution.data as unknown as ZhengtingData
      const actorId = [ownerId, data.targetId][data.actorIndex]
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const suit = ZHENGTING_SUITS[data.suitIndex]
      if (!actorId || !suit || !cardId || !playerOf(host.state, actorId)?.zones.hand.includes(cardId)
        || host.state.cards[cardId]?.suit !== suit) return
      ;(data.kept[actorId] ??= []).push(cardId)
      data.suitIndex += 1
      host.queueSkill({ skillId: XING_DONGYUN_ZHENGTING, ownerId, step: 'discard-choice', data: data as unknown as Record<string, unknown> })
    }
  },
})

registerSkillRuntime({
  id: XING_DONGYUN_BISHI,
  triggers: [
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId || !host.state.players.find((p) => p.id === ownerId)?.alive
        || !host.state.players.find((p) => p.id === targetId)?.alive
        || b87(host.state).bishiUsedRound?.[ownerId] === host.state.roundNumber) return
      host.queueSkill({ skillId: XING_DONGYUN_BISHI, ownerId, step: 'offer', data: { targetId, roundNumber: host.state.roundNumber } })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const phase = host.state.extraPhase
      if (!phase || phase.skillId !== XING_DONGYUN_BISHI || phase.playerId !== context.event.sourceId) return
      const record = b87(host.state).bishiExtraPhases?.[String(phase.instanceId)]
      if (!record || record.ownerId !== ownerId || record.targetId !== context.event.sourceId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const cardId = payload.cardId ?? context.event.cardIds?.[0]
      if (!cardId) return
      if (record.usedCount === 0) record.firstCardId = cardId
      record.usedCount += 1
      if (payload.cardName && (['杀', '火杀', '雷杀'].includes(payload.cardName)
        || DAMAGE_TRICKS.has(payload.cardName) || payload.cardName === '闪电'))
        drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const phase = host.state.extraPhase
      if (!phase || phase.skillId !== XING_DONGYUN_BISHI) return
      const record = b87(host.state).bishiExtraPhases?.[String(phase.instanceId)]
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      if (record && record.firstCardId === cardId) delete record.firstCardId
    } },
    { event: 'PhaseEnd', handle(host, _ownerId, context) {
      const phase = host.state.extraPhase
      if (!phase || phase.skillId !== XING_DONGYUN_BISHI || phase.phase !== (context.event.payload as { phase?: TurnPhase }).phase) return
      delete b87(host.state).bishiExtraPhases?.[String(phase.instanceId)]
    } },
  ],
  cardUnresponsiveToTarget(state, ownerId, sourceId, cardId) {
    const phase = state.extraPhase
    if (!phase || phase.skillId !== XING_DONGYUN_BISHI) return false
    const record = b87(state).bishiExtraPhases?.[String(phase.instanceId)]
    return record?.ownerId === ownerId && record.targetId === sourceId && record.firstCardId === cardId
  },
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'offer' || Number(queued.data.roundNumber) !== host.state.roundNumber) return
    const targetId = queued.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive || b87(host.state).bishiUsedRound?.[ownerId] === host.state.roundNumber) return
    const hand = [...owner.zones.hand]
    host.askSkill({ skillId: XING_DONGYUN_BISHI, ownerId, step: 'give-cards', data: { targetId, roundNumber: host.state.roundNumber, cardIds: hand }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【弼士】：选择交给${target.nickname}的手牌（可不交）`,
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: hand, hiddenCardSlots: [], min: 0, max: hand.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'give-cards' || Number(resolution.data.roundNumber) !== host.state.roundNumber) return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !target?.alive || cardIds.length !== new Set(cardIds).size
      || cardIds.some((id) => !owner.zones.hand.includes(id))) return
    b87(host.state).bishiUsedRound ??= {}
    b87(host.state).bishiUsedRound![ownerId] = host.state.roundNumber
    if (cardIds.length) giveCards(host, ownerId, targetId, cardIds, XING_DONGYUN_BISHI)
    const refreshedTarget = playerOf(host.state, targetId)
    if (!refreshedTarget?.alive || refreshedTarget.zones.hand.length !== refreshedTarget.hp) return
    const instanceId = queueExtraPhaseAfterTurnEnd(host.state, targetId, 'play', XING_DONGYUN_BISHI)
    b87(host.state).bishiExtraPhases ??= {}
    b87(host.state).bishiExtraPhases![String(instanceId)] = { ownerId, targetId, roundNumber: host.state.roundNumber, usedCount: 0 }
  },
})

function huangnuUseState(state: SanguoshaState, ownerId: PlayerId) {
  const table = b87(state).huangnu ??= {}
  const current = table[ownerId]
  if (!current || current.turnNumber !== state.turnNumber) table[ownerId] = { turnNumber: state.turnNumber, uses: 0, disabled: false }
  return table[ownerId]!
}

function discardableCardsOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  return [...player.zones.hand, ...Object.values(player.zones.equipment).filter((id): id is CardId => !!id)]
    .filter((cardId) => !isCardProtectedFromDiscard(state, playerId, cardId))
}

function queueHuangnuRestore(host: SkillHost, ownerId: PlayerId): void {
  const ledger = huangnuUseState(host.state, ownerId)
  host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'restore', data: { turnNumber: host.state.turnNumber, required: ledger.uses } })
}

registerSkillRuntime({
  id: WEI_ZHANG_XINGCAI_HUANGNU,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && !huangnuUseState(state, ownerId).disabled
      ? [{ id: `${WEI_ZHANG_XINGCAI_HUANGNU}:activate`, label: '煌怒' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${WEI_ZHANG_XINGCAI_HUANGNU}:activate` || host.state.phase !== 'play'
      || host.state.currentPlayerId !== ownerId || huangnuUseState(host.state, ownerId).disabled) return
    host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'choose-effect', data: { turnNumber: host.state.turnNumber, optional: true } })
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const amount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      if (context.event.targetId !== ownerId || amount <= 0 || huangnuUseState(host.state, ownerId).disabled) return
      host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'choose-effect', data: { turnNumber: host.state.turnNumber, optional: true } })
    } },
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const sourceId = context.event.sourceId
      if (!sourceId) return
      const pending = b87(host.state).huangnuNextCard?.[sourceId]
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      if (!pending || pending.turnNumber !== host.state.turnNumber || !cardId) return
      pending.cardId = cardId
      host.state.invalidatedCardUses ??= {}
      host.state.invalidatedCardUses[cardId] = { sourceId: pending.ownerId, skillId: WEI_ZHANG_XINGCAI_HUANGNU }
    } },
    { event: 'TurnEnd', handle(host, _ownerId, context) {
      const turnNumber = Number((context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber)
      for (const [targetId, pending] of Object.entries(b87(host.state).huangnuNextCard ?? {}))
        if (pending.turnNumber === turnNumber) delete b87(host.state).huangnuNextCard?.[targetId]
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      if (!cardId) return
      const pendingSlash = b87(host.state).huangnuPendingSlash?.[cardId]
      if (pendingSlash?.ownerId === ownerId) {
        delete b87(host.state).huangnuPendingSlash?.[cardId]
        queueHuangnuRestore(host, ownerId)
      }
      const invalidation = host.state.invalidatedCardUses?.[cardId]
      if (invalidation?.skillId === WEI_ZHANG_XINGCAI_HUANGNU) {
        delete host.state.invalidatedCardUses![cardId]
        for (const [targetId, pending] of Object.entries(b87(host.state).huangnuNextCard ?? {}))
          if (pending.cardId === cardId) delete b87(host.state).huangnuNextCard?.[targetId]
      }
    } },
  ],
  startQueued(host, ownerId, queued) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || Number(queued.data.turnNumber ?? host.state.turnNumber) !== host.state.turnNumber) return
    if (queued.step === 'choose-effect') {
      if (huangnuUseState(host.state, ownerId).disabled) return
      host.askSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'effect', data: { turnNumber: host.state.turnNumber }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【煌怒】：选择一项效果', timeoutMs: 25_000,
        optional: queued.data.optional === true, options: [
          { id: 'discard', label: '令一名角色随机弃置一张指定类型的牌' },
          { id: 'slash', label: '视为使用一张【杀】' },
          { id: 'invalidate', label: '令一名角色本回合下次使用的牌无效' },
        ],
      }) })
      return
    }
    if (queued.step === 'restore') {
      const required = Math.max(1, Number(queued.data.required))
      const abolished = abolishedSlotsOf(host.state, ownerId).filter((slot) => ABOLISHABLE_SLOTS.includes(slot))
      const count = Math.min(required, abolished.length)
      if (count < required) huangnuUseState(host.state, ownerId).disabled = true
      if (count === 0) return
      host.askSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'restore-slots', data: { turnNumber: host.state.turnNumber, available: abolished, count }, build: (id): ChooseOptionsRequest => ({
        id, kind: 'choose-options', playerId: ownerId, prompt: `【煌怒】：恢复${count}个装备栏`, timeoutMs: 25_000,
        optional: false, options: abolished.map((slot) => ({ id: slot, label: SLOT_LABELS[slot] })), min: count, max: count,
      }) })
      return
    }
    if (queued.step === 'discard-target') {
      const candidates = host.state.players.filter((p) => p.alive && discardableCardsOf(host.state, p.id).length > 0)
      if (!candidates.length) { queueHuangnuRestore(host, ownerId); return }
      host.askSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'discard-target', data: queued.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【煌怒】：选择一名有可弃置牌的角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates.map(({ id: playerId }) => playerId), min: 1, max: 1,
      }) })
      return
    }
    if (queued.step === 'discard-type') {
      const targetId = queued.data.targetId as PlayerId
      const types = [...new Set(discardableCardsOf(host.state, targetId).map((id) => host.state.cards[id]?.category).filter((x): x is CardCategory => !!x))]
      if (!types.length) { queueHuangnuRestore(host, ownerId); return }
      host.askSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'discard-type', data: queued.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【煌怒】：选择其随机弃置牌的类别', timeoutMs: 25_000,
        optional: false, options: types.map((type) => ({ id: type, label: type === 'basic' ? '基本牌' : type === 'trick' ? '锦囊牌' : '装备牌' })),
      }) })
      return
    }
    if (queued.step === 'slash-target' || queued.step === 'invalidate-target') {
      const targetIds = host.state.players.filter((p) => p.alive && (queued.step === 'invalidate-target' || p.id !== ownerId)
        && (queued.step !== 'slash-target' || (canTarget(host.state, ownerId, p.id)
          && !isTargetProhibited(host.state, ownerId, p.id, '杀', characterSkillIdsOf)
          && !isCardUseProhibited(host.state, ownerId, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null })
          && (canUseSlash(host.state, ownerId, false) || canUseSlashAtTargets(host.state, ownerId, false, [p.id])))))
        .map(({ id }) => id)
      if (!targetIds.length) { queueHuangnuRestore(host, ownerId); return }
      host.askSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: queued.step, data: queued.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId,
        prompt: queued.step === 'slash-target' ? '【煌怒】：选择【杀】的目标' : '【煌怒】：选择一名角色令其下次使用的牌无效',
        timeoutMs: 25_000, optional: false, candidateIds: targetIds, min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; optionIds?: string[]; targetIds?: PlayerId[] }
    if (resolution.step === 'effect') {
      const mode = payload.optionId
      const ledger = huangnuUseState(host.state, ownerId)
      if (!mode || ledger.disabled) return
      ledger.uses += 1
      if (mode === 'discard') host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'discard-target', data: { turnNumber: host.state.turnNumber } })
      else if (mode === 'slash') host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'slash-target', data: { turnNumber: host.state.turnNumber } })
      else if (mode === 'invalidate') host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'invalidate-target', data: { turnNumber: host.state.turnNumber } })
      else { ledger.uses -= 1; return }
      return
    }
    if (resolution.step === 'discard-target') {
      const targetId = payload.targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) { queueHuangnuRestore(host, ownerId); return }
      host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_HUANGNU, ownerId, step: 'discard-type', data: { targetId, turnNumber: host.state.turnNumber } })
      return
    }
    if (resolution.step === 'discard-type') {
      const targetId = resolution.data.targetId as PlayerId
      const category = payload.optionId as CardCategory | undefined
      const candidates = discardableCardsOf(host.state, targetId).filter((id) => host.state.cards[id]?.category === category)
      if (candidates.length) discardCardsByIds(host, targetId, [host.rng.shuffle(candidates)[0]!], WEI_ZHANG_XINGCAI_HUANGNU)
      queueHuangnuRestore(host, ownerId)
      return
    }
    if (resolution.step === 'invalidate-target') {
      const targetId = payload.targetIds?.[0]
      if (targetId && playerOf(host.state, targetId)?.alive)
        (b87(host.state).huangnuNextCard ??= {})[targetId] = { ownerId, turnNumber: host.state.turnNumber }
      queueHuangnuRestore(host, ownerId)
      return
    }
    if (resolution.step === 'slash-target') {
      const targetId = payload.targetIds?.[0]
      if (!targetId || !host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: WEI_ZHANG_XINGCAI_HUANGNU, countUsage: true })) {
        queueHuangnuRestore(host, ownerId)
        return
      }
      const cardId = host.state.cardResolution?.cardId
      if (cardId) (b87(host.state).huangnuPendingSlash ??= {})[cardId] = { ownerId, turnNumber: host.state.turnNumber }
      else queueHuangnuRestore(host, ownerId)
      return
    }
    if (resolution.step === 'restore-slots') {
      const available = resolution.data.available as EquipmentSlot[]
      const selected = payload.optionIds ?? []
      if (selected.length !== Number(resolution.data.count) || new Set(selected).size !== selected.length
        || selected.some((id) => !available.includes(id as EquipmentSlot)
          || !abolishedSlotsOf(host.state, ownerId).includes(id as EquipmentSlot))) return
      for (const id of selected) restoreSlot(host.state, ownerId, id as EquipmentSlot)
    }
  },
})

registerSkillRuntime({
  id: XING_XIAHOU_BA_JUEFA,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const record = b87(state).xiahoubaJuefa?.[ownerId]
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && !record?.used
      ? [{ id: `${XING_XIAHOU_BA_JUEFA}:activate`, label: '绝伐（限定技）' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${XING_XIAHOU_BA_JUEFA}:activate` || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
    const record = b87(host.state).xiahoubaJuefa?.[ownerId]
    if (record?.used) return
    ;(b87(host.state).xiahoubaJuefa ??= {})[ownerId] = { used: true, active: true, expiresOnTurn: host.state.turnNumber, killed: false }
  },
})

registerSkillRuntime({
  id: XING_XIAHOU_BA_WEIGU,
  interceptSourceTargetEach(host, ownerId, context) {
    return beginWeigu(host, ownerId, context)
  },
  interceptTarget(host, ownerId, context) {
    return beginWeigu(host, ownerId, context)
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const resolution = host.state.cardResolution
      const cardId = (context.event.payload as { cardId?: CardId | null }).cardId
      const finalAmount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      if (cardId && finalAmount > 0) {
        const record = b87(host.state).xiahoubaCardResolution?.[cardId]
        if (record?.ownerId === ownerId) record.damaged = true
      }
      if (context.event.sourceSkillId !== XING_XIAHOU_BA_WEIGU) return
      if (resolution) host.queueSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'resume-after-juefa-damage', data: { cardId: resolution.cardId } })
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!deadId) return
      if (deadId === ownerId) delete b87(host.state).xiahoubaPendingDraw?.[ownerId]
      if (context.event.sourceId !== ownerId) return
      const pendingDamage = b87(host.state).xiahoubaPendingJuefaDamage?.[ownerId]
      if (pendingDamage?.targetId === deadId) {
        const form = b87(host.state).xiahoubaJuefa?.[ownerId]
        if (form?.active) form.killed = true
        delete b87(host.state).xiahoubaPendingJuefaDamage?.[ownerId]
      }
      const form = b87(host.state).xiahoubaJuefa?.[ownerId]
      if (!pendingDamage || !form?.active) return
      form.killed = true
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      setCurrentHp(host as never, ownerId, owner.maxHp, XING_XIAHOU_BA_WEIGU)
      const handCount = owner.zones.hand.length
      if (handCount < owner.maxHp) drawCards(host.state, host.rng, ownerId, owner.maxHp - handCount, (name, payload) => host.dispatch(name, payload))
      else if (handCount > owner.maxHp) host.queueSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'discard-to-max', data: { count: handCount - owner.maxHp } })
    } },
    { event: 'QuitDying', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (b87(host.state).xiahoubaPendingJuefaDamage?.[ownerId]?.targetId === playerId)
        delete b87(host.state).xiahoubaPendingJuefaDamage?.[ownerId]
      if (playerId === ownerId) {
        const pendingDraw = b87(host.state).xiahoubaPendingDraw?.[ownerId]
        delete b87(host.state).xiahoubaPendingDraw?.[ownerId]
        if (pendingDraw && playerOf(host.state, ownerId)?.alive)
          drawCards(host.state, host.rng, ownerId, pendingDraw, (name, payload) => host.dispatch(name, payload))
      }
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      const record = cardId && b87(host.state).xiahoubaCardResolution?.[cardId]
      if (!cardId || !record) return
      delete b87(host.state).xiahoubaCardResolution?.[cardId]
      if (!record.damaged && playerOf(host.state, record.ownerId)?.alive) {
        loseHp(host as never, record.ownerId, 1, XING_XIAHOU_BA_WEIGU)
        if (host.state.dying?.playerId === record.ownerId)
          (b87(host.state).xiahoubaPendingDraw ??= {})[record.ownerId] = 2
        else drawCards(host.state, host.rng, record.ownerId, 2, (name, payload) => host.dispatch(name, payload))
      }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const endedPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId
      const form = b87(host.state).xiahoubaJuefa?.[ownerId]
      if (!form?.active || endedPlayerId !== ownerId || host.state.turnNumber <= form.expiresOnTurn) return
      form.active = false
      if (!form.killed) {
        const owner = playerOf(host.state, ownerId)
        if (owner?.alive && owner.hp > 0) loseHp(host as never, ownerId, owner.hp, XING_XIAHOU_BA_JUEFA)
      }
    } },
  ],
  startQueued(host, ownerId, queued) {
    const cardId = queued.data.cardId as CardId | undefined
    if (queued.step === 'discard-to-max') {
      const owner = playerOf(host.state, ownerId)
      const hand = owner?.zones.hand ?? []
      const count = owner ? Math.max(0, hand.length - owner.maxHp) : 0
      if (count) host.askSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'discard-to-max', data: { count }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【绝伐】：弃置手牌至手牌数等于体力上限', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...hand], hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (queued.step === 'resume-after-juefa-damage') {
      if (host.state.cardResolution?.cardId === queued.data.cardId) host.resumeCardTarget()
      return
    }
    if (!cardId || host.state.cardResolution?.cardId !== cardId) return
    if (queued.step === 'effect') {
      const sourceId = queued.data.sourceId as PlayerId
      const additions = xiahoubaEligibleExtraTargets(host.state, ownerId, sourceId, cardId)
      const canMove = fieldCards(host.state).some((fieldCard) => fieldMoveDestinations(host.state, fieldCard.cardId).length > 0)
      const form = b87(host.state).xiahoubaJuefa?.[ownerId]
      const options = [
        ...(canMove && !form?.active ? [{ id: 'move-field', label: '移动场上一张牌' }] : []),
        ...(additions.length ? [{ id: 'expand-targets', label: `令攻击范围内${additions.length}名角色也成为此牌目标` }] : []),
        ...(form?.active && host.state.players.some((p) => p.alive) ? [{ id: 'juefa-damage', label: '对一名角色造成2点伤害' }] : []),
      ]
      if (!options.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'effect-choice', data: queued.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【维谷】：选择一项', timeoutMs: 25_000, optional: false, options,
      }) })
      return
    }
    if (queued.step === 'move-card') {
      const cards = fieldCards(host.state).filter((fieldCard) => fieldMoveDestinations(host.state, fieldCard.cardId).length > 0).map(({ cardId: id }) => id)
      if (!cards.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'move-card', data: queued.data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【维谷】：选择移动的场上牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (queued.step === 'move-target') {
      const selected = queued.data.moveCardId as CardId
      const candidates = fieldMoveDestinations(host.state, selected)
      if (!candidates.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'move-target', data: queued.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【维谷】：选择移动目的角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (queued.step === 'juefa-target') {
      const candidates = host.state.players.filter((p) => p.alive).map(({ id }) => id)
      if (!candidates.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'juefa-target', data: queued.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【绝伐】：选择造成2点伤害的角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { cardId?: CardId; sourceId?: PlayerId; cardName?: string; moveCardId?: CardId; count?: number }
    if (resolution.step === 'discard-to-max') {
      const owner = playerOf(host.state, ownerId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner || cardIds.length !== Number(data.count) || new Set(cardIds).size !== cardIds.length
        || cardIds.some((id) => !owner.zones.hand.includes(id))) return
      discardCardsByIds(host, ownerId, cardIds, XING_XIAHOU_BA_WEIGU)
      const remainingExcess = Math.max(0, owner.zones.hand.length - owner.maxHp)
      if (remainingExcess) host.queueSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'discard-to-max', data: { count: remainingExcess } })
      return
    }
    const cardId = data.cardId
    if (!cardId || host.state.cardResolution?.cardId !== cardId) return
    if (resolution.step === 'cost') {
      const chosen = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!chosen) { delete b87(host.state).xiahoubaPrompted?.[cardId]; host.resumeCardTarget(); return }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.zones.hand.includes(chosen) || !xiahoubaSelfTargetingHandCards(host.state, ownerId).includes(chosen)) {
        delete b87(host.state).xiahoubaPrompted?.[cardId]; host.resumeCardTarget(); return
      }
      if (!discardCardsByIds(host, ownerId, [chosen], XING_XIAHOU_BA_WEIGU).includes(chosen)) {
        delete b87(host.state).xiahoubaPrompted?.[cardId]; host.resumeCardTarget(); return
      }
      host.queueSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'effect', data: { ...data, cardId } })
      return
    }
    if (resolution.step === 'effect-choice') {
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'move-field') host.queueSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'move-card', data })
      else if (option === 'juefa-damage') host.queueSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'juefa-target', data })
      else if (option === 'expand-targets') {
        const current = host.state.cardResolution!
        const additions = xiahoubaEligibleExtraTargets(host.state, ownerId, data.sourceId!, cardId)
        if (current.kind === 'slash') current.remainingTargetIds.push(...additions)
        else current.targetIds.push(...additions)
        ;(b87(host.state).xiahoubaCardResolution ??= {})[cardId] = { ownerId, damaged: false }
        delete b87(host.state).xiahoubaPrompted?.[cardId]
        host.resumeCardTarget()
      }
      return
    }
    if (resolution.step === 'move-card') {
      const moveCardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!moveCardId || !fieldMoveDestinations(host.state, moveCardId).length) { delete b87(host.state).xiahoubaPrompted?.[cardId]; host.resumeCardTarget(); return }
      host.queueSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'move-target', data: { ...data, moveCardId } })
      return
    }
    if (resolution.step === 'move-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !fieldMoveDestinations(host.state, data.moveCardId!).includes(targetId)) { delete b87(host.state).xiahoubaPrompted?.[cardId]; host.resumeCardTarget(); return }
      moveFieldCard(host as never, data.moveCardId!, targetId)
        ;(b87(host.state).xiahoubaCardResolution ??= {})[cardId] = { ownerId, damaged: false }
      delete b87(host.state).xiahoubaPrompted?.[cardId]
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'juefa-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const form = b87(host.state).xiahoubaJuefa?.[ownerId]
      if (!targetId || !playerOf(host.state, targetId)?.alive || !form?.active) { delete b87(host.state).xiahoubaPrompted?.[cardId]; host.resumeCardTarget(); return }
      ;(b87(host.state).xiahoubaPendingJuefaDamage ??= {})[ownerId] = { targetId, cardId }
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 2, sourceSkillId: XING_XIAHOU_BA_WEIGU, reason: XING_XIAHOU_BA_WEIGU })
      ;(b87(host.state).xiahoubaCardResolution ??= {})[cardId] = { ownerId, damaged: false }
      delete b87(host.state).xiahoubaPrompted?.[cardId]
    }
  },
})

function beginWeigu(host: SkillHost, ownerId: PlayerId, context: import('../../engine/skills/runtime').TargetedCardContext): boolean {
  const resolution = host.state.cardResolution
  if (!playerOf(host.state, ownerId)?.alive || context.cardId === undefined || !resolution
    || resolution.cardId !== context.cardId || !isDamageCardName(context.cardName)
    || !isSingleTargetCardResolution(resolution) || b87(host.state).xiahoubaPrompted?.[context.cardId]) return false
  const cardIds = xiahoubaSelfTargetingHandCards(host.state, ownerId)
  if (!cardIds.length) return false
  const sourceId = resolution.sourceId
  const form = b87(host.state).xiahoubaJuefa?.[ownerId]
  const hasMoveChoice = !form?.active && fieldCards(host.state).some((fieldCard) => fieldMoveDestinations(host.state, fieldCard.cardId).length > 0)
  const hasExpansionChoice = xiahoubaEligibleExtraTargets(host.state, ownerId, sourceId, context.cardId).length > 0
  const hasJuefaChoice = Boolean(form?.active && host.state.players.some((player) => player.alive))
  if (!hasMoveChoice && !hasExpansionChoice && !hasJuefaChoice) return false
  const prompted = b87(host.state).xiahoubaPrompted ??= {}
  prompted[context.cardId] = ownerId
  host.askSkill({ skillId: XING_XIAHOU_BA_WEIGU, ownerId, step: 'cost', data: {
    cardId: context.cardId, sourceId, cardName: context.cardName,
  }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【维谷】：弃置一张可指定自己为目标的牌', timeoutMs: 25_000,
    optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
  }) })
  return true
}

function isDamageCardName(cardName: string): boolean {
  return ['杀', '火杀', '雷杀'].includes(cardName) || DAMAGE_TRICKS.has(cardName)
}

function isSingleTargetCardResolution(resolution: NonNullable<SanguoshaState['cardResolution']>): boolean {
  return resolution.kind === 'slash'
    ? resolution.remainingTargetIds.length === 0
    : resolution.targetIds.length === 1
}

function xiahoubaSelfTargetingHandCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  const probe: SanguoshaState = {
    ...state,
    players: state.players.map((player) => player.id === ownerId
      ? { ...player, hp: Math.min(player.hp, Math.max(0, player.maxHp - 1)) }
      : player),
    currentPlayerId: ownerId, phase: 'play', pendingRequests: [], skillResolution: null, cardResolution: null,
  }
  return [...new Set(legalPlayActions(probe, ownerId)
    .filter((action): action is Extract<typeof action, { kind: 'use-card' }> => action.kind === 'use-card' && action.targetIds.includes(ownerId))
    .flatMap((action) => action.cardIds))].filter((cardId) => owner.zones.hand.includes(cardId))
}

function xiahoubaEligibleExtraTargets(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId, cardId: CardId): PlayerId[] {
  const resolution = state.cardResolution
  if (!resolution || resolution.cardId !== cardId) return []
  const current = resolution.kind === 'slash' ? [resolution.targetId, ...resolution.remainingTargetIds] : resolution.targetIds
  const cardName = resolution.kind === 'slash' ? '杀' : resolution.cardName
  return state.players.filter((candidate) => candidate.alive && candidate.id !== sourceId && !current.includes(candidate.id)
    && canTarget(state, ownerId, candidate.id)
    && !isTargetProhibited(state, sourceId, candidate.id, cardName, characterSkillIdsOf, cardId)).map(({ id }) => id)
}

registerSkillRuntime({
  id: WEI_ZHANG_XINGCAI_XIANKUANG,
  triggers: [{ event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; fromKind?: string; fromPlayerId?: PlayerId | null; reason?: string }
    const cardId = payload.cardId
    const card = cardId ? host.state.cards[cardId] : undefined
    const state = b87(host.state).xiankuang?.[ownerId]
    if (!cardId || card?.category !== 'basic' || payload.reason !== 'discard' || !payload.fromPlayerId
      || abolishedSlotsOf(host.state, ownerId).length >= ABOLISHABLE_SLOTS.length
      || (state?.turnNumber === host.state.turnNumber && state.disabled)
      || !playerOf(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_XIANKUANG, ownerId, step: 'offer', data: {
      cardId, targetId: payload.fromPlayerId, turnNumber: host.state.turnNumber,
    } })
  } }],
  startQueued(host, ownerId, queued) {
    if (Number(queued.data.turnNumber) !== host.state.turnNumber || !playerOf(host.state, ownerId)?.alive) return
    if (queued.step === 'offer') {
      if (b87(host.state).xiankuang?.[ownerId]?.disabled
        && b87(host.state).xiankuang?.[ownerId]?.turnNumber === host.state.turnNumber) return
      host.askSkill({ skillId: WEI_ZHANG_XINGCAI_XIANKUANG, ownerId, step: 'invoke', data: queued.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【贤贶】：是否废除一个装备栏并发动？', timeoutMs: 25_000,
        optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (queued.step === 'choose-slot') {
      const slots = abolishableSlotsOf(host.state, ownerId).filter((slot) => ABOLISHABLE_SLOTS.includes(slot))
      if (!slots.length) return
      host.askSkill({ skillId: WEI_ZHANG_XINGCAI_XIANKUANG, ownerId, step: 'slot', data: queued.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【贤贶】：选择废除的装备栏', timeoutMs: 25_000,
        optional: false, options: slots.map((slot) => ({ id: slot, label: SLOT_LABELS[slot] })),
      }) })
      return
    }
    if (queued.step === 'choose-mode') {
      const cardId = queued.data.cardId as CardId
      const targetId = queued.data.targetId as PlayerId
      const options = [
        ...(host.state.zones.discardPile.includes(cardId) ? [{ id: 'gain', label: '获得该基本牌' }] : []),
        ...(playerOf(host.state, targetId)?.alive ? [{ id: 'draw', label: `令其摸${abolishedSlotsOf(host.state, ownerId).length}张牌` }] : []),
      ]
      if (!options.length) return
      host.askSkill({ skillId: WEI_ZHANG_XINGCAI_XIANKUANG, ownerId, step: 'mode', data: queued.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【贤贶】：选择一项', timeoutMs: 25_000,
        optional: false, options,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string }
    if (resolution.step === 'invoke') {
      if (payload.optionId !== 'yes') return
      host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_XIANKUANG, ownerId, step: 'choose-slot', data: resolution.data })
      return
    }
    if (resolution.step === 'slot') {
      const slot = payload.optionId as EquipmentSlot | undefined
      if (!slot || !abolishableSlotsOf(host.state, ownerId).includes(slot)) return
      const player = playerOf(host.state, ownerId)
      if (!player) return
      const cardId = player.zones.equipment[slot]
      if (cardId) {
        moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
        handleEquipmentLost(host as never, ownerId, cardId)
      }
      abolishSlot(host.state, ownerId, slot)
      host.queueSkill({ skillId: WEI_ZHANG_XINGCAI_XIANKUANG, ownerId, step: 'choose-mode', data: resolution.data })
      return
    }
    if (Number(resolution.data.turnNumber) !== host.state.turnNumber || !playerOf(host.state, ownerId)?.alive) return
    if (resolution.step !== 'mode') return
    const targetId = resolution.data.targetId as PlayerId
    const cardId = resolution.data.cardId as CardId
    if (payload.optionId === 'gain') {
      if (!host.state.zones.discardPile.includes(cardId) || host.state.cards[cardId]?.category !== 'basic') return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WEI_ZHANG_XINGCAI_XIANKUANG },
        { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      const prior = b87(host.state).xiankuang?.[ownerId]
      const gained = (prior?.turnNumber === host.state.turnNumber ? prior.gained : 0) + 1
      ;(b87(host.state).xiankuang ??= {})[ownerId] = { turnNumber: host.state.turnNumber, gained, disabled: gained > 1 }
    } else if (payload.optionId === 'draw') {
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const count = abolishedSlotsOf(host.state, ownerId).length
      if (count) drawCards(host.state, host.rng, targetId, count, (name, data) => host.dispatch(name, data))
    }
  },
})

registerSkillRuntime({
  id: LI_ZHAOYI_MINGJIE,
  offersGlobalDamagePreventionAsk(host, ownerId, context: DamagePreventionContext) {
    const targetId = context.targetId
    if (!liZhaoyiState(host.state).shield?.[targetId]
      || !host.state.players.find((p) => p.id === ownerId)?.alive) return false
    host.queueSkill({ skillId: LI_ZHAOYI_MINGJIE, ownerId, step: 'consume-shield', data: { targetId } })
    return true
  },
  onGameStart(host, ownerId) {
    const candidates = host.state.players.filter((p) => p.alive && p.id !== ownerId).map(({ id }) => id)
    if (candidates.length) host.queueSkill({ skillId: LI_ZHAOYI_MINGJIE, ownerId, step: 'choose-partner', data: { candidates } })
  },
  triggers: [
    { event: 'CardMove', handle(host, ownerId, context) {
      const partnerId = liZhaoyiState(host.state).partner?.[ownerId]
      const p = context.event.payload as { sourcePlayerId?: PlayerId; cardIds?: CardId[]; destinationZone?: string; reason?: string; phaseInstanceId?: string }
      const ledger = host.state.discardPhaseLedger
      if (!partnerId || !p.sourcePlayerId || ![ownerId, partnerId].includes(p.sourcePlayerId)
        || p.destinationZone !== 'discardPile' || p.reason !== 'discard' || !ledger
        || p.phaseInstanceId !== ledger.phaseInstanceId || ledger.ownerPlayerId !== p.sourcePlayerId) return
      const recipientId = p.sourcePlayerId === ownerId ? partnerId : ownerId
      const gained: CardId[] = []
      const explicitlyDiscarded = new Set(ledger.records
        .filter((record) => record.sourcePlayerId === p.sourcePlayerId && record.moveReason === 'discard')
        .map((record) => record.cardId))
      for (const cardId of p.cardIds ?? []) if (explicitlyDiscarded.has(cardId) && host.state.zones.discardPile.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: recipientId })
        gained.push(cardId)
      }
      if (gained.length) host.dispatch('GainCard', { playerId: recipientId, cardIds: gained, reason: LI_ZHAOYI_MINGJIE },
        { sourceId: p.sourcePlayerId, targetId: recipientId, cardIds: gained })
    } },
    { event: 'PhaseSkipped', handle(host, ownerId, context) {
      const partnerId = liZhaoyiState(host.state).partner?.[ownerId]
      const p = context.event.payload as { playerId?: PlayerId }
      if (!partnerId || !p.playerId || ![ownerId, partnerId].includes(p.playerId)) return
      for (const targetId of [ownerId, partnerId]) if (host.state.players.find((entry) => entry.id === targetId)?.alive)
        drawCards(host.state, host.rng, targetId, 2, (name, payload) => host.dispatch(name, payload))
      const otherId = p.playerId === ownerId ? partnerId : ownerId
      if (!host.state.players.find((entry) => entry.id === ownerId)?.alive
        || !host.state.players.find((entry) => entry.id === otherId)?.alive) return
      host.queueSkill({ skillId: LI_ZHAOYI_MINGJIE, ownerId, step: 'offer-shield', data: { otherId } })
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (deadId && deadId === liZhaoyiState(host.state).partner?.[ownerId]) forceDeath(host, ownerId, deadId)
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'choose-partner') {
      const candidates = (queued.data.candidates as PlayerId[]).filter((id) => host.state.players.find((p) => p.id === id)?.alive)
      if (!candidates.length) return
      host.askSkill({ skillId: LI_ZHAOYI_MINGJIE, ownerId, step: 'partner', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【明节】：选择一名其他角色作为明节角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (queued.step === 'offer-shield') host.askSkill({ skillId: LI_ZHAOYI_MINGJIE, ownerId, step: 'shield', data: queued.data,
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【明节】：是否令另一名明节角色防止其下一次受到的伤害？', timeoutMs: 25_000, optional: true,
        options: [{ id: 'yes', label: '防止其下一次受到的伤害' }, { id: 'no', label: '不发动' }] }) })
    if (queued.step === 'consume-shield') {
      const targetId = queued.data.targetId as PlayerId
      const shields = liZhaoyiState(host.state).shield ?? {}
      if (shields[targetId]) {
        const next = { ...shields }
        delete next[targetId]
        liZhaoyiState(host.state).shield = next
        resumeTargetDamagePrevention(host as never, true, LI_ZHAOYI_MINGJIE)
      } else resumeTargetDamagePrevention(host as never, false)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'partner') {
      const partnerId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (partnerId && partnerId !== ownerId && host.state.players.find((p) => p.id === partnerId)?.alive)
        liZhaoyiState(host.state).partner = { ...(liZhaoyiState(host.state).partner ?? {}), [ownerId]: partnerId }
    } else if (resolution.step === 'shield' && (response.payload as { optionId?: string }).optionId === 'yes') {
      const otherId = resolution.data.otherId as PlayerId
      if (host.state.players.find((p) => p.id === otherId)?.alive)
        liZhaoyiState(host.state).shield = { ...(liZhaoyiState(host.state).shield ?? {}), [otherId]: true }
    }
  },
})

registerSkillRuntime({
  id: LI_ZHAOYI_XIANFU,
  interceptTarget(host, ownerId) {
    const partnerId = liZhaoyiState(host.state).partner?.[ownerId]
    if (!partnerId || !host.state.cardResolution || !host.state.players.find((p) => p.id === ownerId)?.alive
      || liZhaoyiState(host.state).xianfuTurn?.[ownerId] === host.state.turnNumber) return false
    host.askSkill({ skillId: LI_ZHAOYI_XIANFU, ownerId, step: 'choose-skip', data: { partnerId, turnNumber: host.state.turnNumber },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【娴辅】：选择你下回合跳过的一个阶段，令此牌对你无效，并观看双方手牌', timeoutMs: 25_000, optional: true,
        options: [{ id: 'no', label: '不发动' }, { id: 'judge', label: '判定阶段' }, { id: 'draw', label: '摸牌阶段' }, { id: 'play', label: '出牌阶段' }, { id: 'discard', label: '弃牌阶段' }] }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'show-owner-hand') { host.resumeCardTarget(); return }
    if (resolution.step === 'take-partner-cards') {
      const partnerId = resolution.data.partnerId as PlayerId
      const chosen = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const partner = host.state.players.find((p) => p.id === partnerId)
      const selectable = new Set((resolution.data.selectable as CardId[]) ?? [])
      if (partner?.alive) giveCards(host, partnerId, ownerId,
        chosen.filter((cardId) => selectable.has(cardId) && partner.zones.hand.includes(cardId)).slice(0, 3), LI_ZHAOYI_XIANFU)
      const owner = host.state.players.find((p) => p.id === ownerId)
      if (owner?.alive) host.askSkill({ skillId: LI_ZHAOYI_XIANFU, ownerId, step: 'show-owner-hand', data: {},
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: partnerId,
          prompt: '【娴辅】：观看李昭仪的手牌（仅查看）', timeoutMs: 25_000, optional: false, purpose: 'skill',
          cardIds: [], viewOnlyCardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 0 }) })
      else host.resumeCardTarget()
      return
    }
    if (resolution.step !== 'choose-skip') return
    const phase = (response.payload as { optionId?: string }).optionId
    if (phase === undefined) { host.resumeCardTarget(); return }
    if (phase === 'no' || !['judge', 'draw', 'play', 'discard'].includes(phase ?? '') || Number(resolution.data.turnNumber) !== host.state.turnNumber) {
      host.resumeCardTarget(); return
    }
    const partnerId = resolution.data.partnerId as PlayerId
    const partner = host.state.players.find((p) => p.id === partnerId)
    if (!partner?.alive || !cancelCardTargetForOwner(host, ownerId)) { host.resumeCardTarget(); return }
    schedulePhaseSkipForPlayer(host.state, ownerId, phase as 'judge' | 'draw' | 'play' | 'discard')
    liZhaoyiState(host.state).xianfuTurn = { ...(liZhaoyiState(host.state).xianfuTurn ?? {}), [ownerId]: host.state.turnNumber }
    const selectable = [...partner.zones.hand]
    const owner = host.state.players.find((p) => p.id === ownerId)
    if (!owner) { host.resumeCardTarget(); return }
    host.askSkill({ skillId: LI_ZHAOYI_XIANFU, ownerId, step: 'take-partner-cards', data: { partnerId, selectable },
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【娴辅】：观看双方手牌，获得明节角色至多三张手牌', timeoutMs: 25_000, optional: true,
        purpose: 'skill', cardIds: selectable, viewOnlyCardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(3, selectable.length) }) })
  },
})

function hasEquippedWeapon(state: SanguoshaState, playerId: PlayerId): boolean {
  return weaponCardsOf(state, playerId).length > 0
}

type LiuZhenState = {
  handCardUses?: Record<string, string>
  revealBonus?: Record<string, { roundNumber: number; count: number }>
  responseLockTurn?: Record<string, number>
}
function liuZhenState(state: SanguoshaState): LiuZhenState {
  const root = state as unknown as Record<string, unknown>
  return (root.paperSanguoshaB87 ??= {}) as LiuZhenState
}
function nameLength(name: string): number { return [...name].length }
function fiveJueSubsets(state: SanguoshaState, cardIds: CardId[]): CardId[][] {
  const results: CardId[][] = []
  for (let mask = 1; mask < (1 << cardIds.length); mask += 1) {
    const subset = cardIds.filter((_, index) => (mask & (1 << index)) !== 0)
    if (subset.reduce((sum, id) => sum + nameLength(state.cards[id]?.name ?? ''), 0) === 5) results.push(subset)
  }
  return results
}

registerSkillRuntime({
  id: LIU_ZHEN_WUJUE,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const { cardId, cardName, fromKind } = context.event.payload as { cardId?: CardId; cardName?: string; fromKind?: string }
      if (context.event.sourceId !== ownerId || fromKind !== 'hand' || !cardId || !cardName) return
      liuZhenState(host.state).handCardUses ??= {}
      liuZhenState(host.state).handCardUses![cardId] = cardName
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      const uses = liuZhenState(host.state).handCardUses
      const usedName = cardId ? uses?.[cardId] : undefined
      if (!cardId || !usedName || context.event.sourceId !== ownerId) return
      delete uses![cardId]
      const owner = host.state.players.find((entry) => entry.id === ownerId)
      if (!owner?.alive) return
      const count = (owner.marks['绝'] ?? 0) + nameLength(usedName)
      if (count % 5 !== 0) { owner.marks['绝'] = count; return }
      delete owner.marks['绝']
      const bonus = liuZhenState(host.state).revealBonus?.[ownerId]
      const extra = bonus?.roundNumber === host.state.roundNumber ? bonus.count : 0
      host.queueSkill({ skillId: LIU_ZHEN_WUJUE, ownerId, step: 'reveal-five-jue', data: {
        roundNumber: host.state.roundNumber, count: Math.min(5, 3 + extra),
      } })
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'choose-five-jue-recipient') {
      const candidateIds = host.state.players.filter((entry) => entry.alive).map(({ id }) => id)
      const revealed = queued.data.revealed as CardId[]
      if (!candidateIds.length) { discardRevealedFiveJue(host, revealed); return }
      host.askSkill({ skillId: LIU_ZHEN_WUJUE, ownerId, step: 'give-five-jue-set', data: { ...queued.data }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【五绝】：选择一名角色获得所选牌', timeoutMs: 25_000,
        optional: false, candidateIds, min: 1, max: 1,
      }) })
      return
    }
    if (queued.step !== 'reveal-five-jue' || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
    const need = Math.min(5, Math.max(0, Number(queued.data.count)))
    while (host.state.zones.drawPile.length < need && reshuffleDrawPile(host.state, host.rng,
      (name, payload) => host.dispatch(name, payload)) > 0) { /* recycle until enough cards or no discard remains */ }
    const revealed = host.state.zones.drawPile.slice(0, need)
    if (!revealed.length) return
    host.dispatch('CardMove', { cardIds: revealed, reason: LIU_ZHEN_WUJUE, revealed: true }, { sourceId: ownerId, cardIds: revealed })
    const subsets = fiveJueSubsets(host.state, revealed)
    const options: ChooseOptionRequest['options'] = [{ id: 'decline', label: '不交给角色' }, ...subsets.map((subset, index) => ({
      id: `set-${index}`, label: subset.map((id) => host.state.cards[id]?.name ?? '').join('、'),
    }))]
    host.askSkill({ skillId: LIU_ZHEN_WUJUE, ownerId, step: 'choose-five-jue-set', data: { roundNumber: host.state.roundNumber, revealed, subsets }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【五绝】：已亮出${revealed.map((cardId) => host.state.cards[cardId]?.name).join('、')}；选择牌名字数之和为5的牌交给一名角色`,
      timeoutMs: 25_000, optional: false, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'give-five-jue-set') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = host.state.players.find((entry) => entry.id === targetId)
      const revealed = resolution.data.revealed as CardId[]
      const chosen = resolution.data.chosen as CardId[]
      if (!targetId || !target?.alive || chosen.some((id) => !host.state.zones.drawPile.includes(id))) {
        discardRevealedFiveJue(host, revealed.filter((id) => host.state.zones.drawPile.includes(id)))
        return
      }
      for (const id of revealed.filter((cardId) => !chosen.includes(cardId) && host.state.zones.drawPile.includes(cardId)))
        moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'discardPile' }, { discardReason: 'other' })
      for (const id of chosen) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: chosen, reason: LIU_ZHEN_WUJUE },
        { sourceId: ownerId, targetId, cardIds: chosen })
      host.dispatch('CardGiven', { fromId: ownerId, toId: targetId, cardIds: chosen, reason: LIU_ZHEN_WUJUE },
        { sourceId: ownerId, targetId, cardIds: chosen })
      return
    }
    if (resolution.step !== 'choose-five-jue-set') return
    const optionId = (response.payload as { optionId?: string }).optionId
    const index = Number(optionId?.replace('set-', ''))
    const subsets = resolution.data.subsets as CardId[][]
    const chosen = optionId === 'decline' ? [] : Number.isInteger(index) ? subsets[index] ?? [] : []
    const revealed = resolution.data.revealed as CardId[]
    const stillInDeck = revealed.filter((id) => host.state.zones.drawPile.includes(id))
    if (!chosen.length || chosen.length !== chosen.filter((id) => stillInDeck.includes(id)).length) {
      for (const id of stillInDeck) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'discardPile' }, { discardReason: 'other' })
      return
    }
    host.queueSkill({ skillId: LIU_ZHEN_WUJUE, ownerId, step: 'choose-five-jue-recipient', data: {
      roundNumber: resolution.data.roundNumber, revealed: stillInDeck, chosen,
    } })
  },
})

registerSkillRuntime({
  id: LIU_ZHEN_ZHENGU,
  prohibitsCardResponse(state, ownerId, responderId) {
    const current = state.cardResolution
    return responderId === ownerId && liuZhenState(state).responseLockTurn?.[ownerId] === state.turnNumber
      && Boolean(current && current.sourceId !== ownerId)
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { finalAmount?: number }
    if (context.event.targetId !== ownerId || Number(payload.finalAmount ?? 0) <= 0
      || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
    host.queueSkill({ skillId: LIU_ZHEN_ZHENGU, ownerId, step: 'choose-zhengu-recipient', data: {
      sourceId: context.event.sourceId ?? null, turnNumber: host.state.turnNumber, roundNumber: host.state.roundNumber,
    } })
  } }],
  startQueued(host, ownerId, queued) {
    if (queued.step !== 'choose-zhengu-recipient' || Number(queued.data.turnNumber) !== host.state.turnNumber
      || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
    const candidates = host.state.players.filter((entry) => entry.alive)
    if (!ensureDifferentNameLengths(host)) return
    host.askSkill({ skillId: LIU_ZHEN_ZHENGU, ownerId, step: 'give-zhengu-cards', data: { ...queued.data }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【贞骨】：选择一名角色随机从牌堆获得两张牌名字数不同的牌，然后你翻面',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map(({ id: playerId }) => playerId), min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'give-zhengu-cards' || Number(resolution.data.turnNumber) !== host.state.turnNumber) return
    const recipientId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!recipientId) return
    const recipient = host.state.players.find((entry) => entry.id === recipientId)
    if (!recipient?.alive) return
    if (!ensureDifferentNameLengths(host)) return
    const first = host.rng.shuffle([...host.state.zones.drawPile])[0]
    if (!first) return
    const firstLength = nameLength(host.state.cards[first]?.name ?? '')
    const second = host.rng.shuffle(host.state.zones.drawPile.filter((id) => nameLength(host.state.cards[id]?.name ?? '') !== firstLength))[0]
    if (!second) return
    for (const cardId of [first, second]) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: recipientId })
    host.dispatch('GainCard', { playerId: recipientId, cardIds: [first, second], reason: LIU_ZHEN_ZHENGU },
      { sourceId: ownerId, targetId: recipientId, cardIds: [first, second] })
    flipCharacter(host, ownerId, LIU_ZHEN_ZHENGU)
    const sourceId = resolution.data.sourceId as PlayerId | null
    if (!sourceId || !host.state.players.some((entry) => entry.id === sourceId)) return
    if (isFaceDown(host.state, ownerId) !== isFaceDown(host.state, sourceId)) {
      const state = liuZhenState(host.state)
      const prior = state.revealBonus?.[ownerId]
      const count = Math.min(2, (prior?.roundNumber === host.state.roundNumber ? prior.count : 0) + 1)
      state.revealBonus ??= {}
      state.revealBonus[ownerId] = { roundNumber: host.state.roundNumber, count }
    } else {
      liuZhenState(host.state).responseLockTurn ??= {}
      liuZhenState(host.state).responseLockTurn![ownerId] = host.state.turnNumber
    }
  },
})

function hasDifferentNameLengths(state: SanguoshaState, cardIds: CardId[]): boolean {
  const lengths = new Set(cardIds.map((id) => nameLength(state.cards[id]?.name ?? '')))
  return lengths.size > 1
}

function ensureDifferentNameLengths(host: SkillHost): boolean {
  while (!hasDifferentNameLengths(host.state, host.state.zones.drawPile)
    && reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload)) > 0) { /* reshuffle discard cards into the draw pile */ }
  return hasDifferentNameLengths(host.state, host.state.zones.drawPile)
}

function discardRevealedFiveJue(host: SkillHost, cardIds: readonly CardId[]): void {
  for (const id of cardIds) if (host.state.zones.drawPile.includes(id))
    moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'discardPile' }, { discardReason: 'other' })
}

/**
 * 本批逐个实现并集中验证；正式注册仍等十名武将都闭环后一次接入 standard.ts。
 */
registerSkillRuntime({
  id: XIAHOU_EN_CHIJIAN,
  virtualWeapon(state, ownerId) {
    return hasEquippedWeapon(state, ownerId) ? null : '青釭剑'
  },
  attackRangeBonus(state, ownerId) {
    // 裸装时视为装备的青釭剑攻击范围为2；真实装备武器时不叠加。
    return hasEquippedWeapon(state, ownerId) ? 0 : 1
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (playerId !== ownerId || phase !== 'play') return
      const owner = host.state.players.find((entry) => entry.id === ownerId)
      if (!owner || owner.marks['b87-chijian-extra-slash-turn'] === host.state.turnNumber) return
      owner.marks['b87-chijian-extra-slash-turn'] = host.state.turnNumber
      grantTurnSlashBonus(host.state, ownerId, { extraUses: 1 })
    } },
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (sourceId !== ownerId || payload.cardName !== '杀' || !payload.cardId
        || hasEquippedWeapon(host.state, ownerId)) return
      for (const targetId of payload.targetIds ?? [])
        suppressArmorForCard(host.state, ownerId, targetId, payload.cardId, XIAHOU_EN_CHIJIAN)
    } },
  ],
})

type CiLiRecord = { roundNumber: number; targetId: PlayerId; threshold: number; turnNumber?: number; usedCards: number }
type CiLiState = { ciLi?: Record<string, CiLiRecord[]> }
type LianYouState = { lianYouUse?: Record<string, { roundNumber: number; options: number[] }> }
function ciLiState(state: SanguoshaState): CiLiState {
  const root = state as unknown as Record<string, unknown>
  return (root.paperSanguoshaB87 ??= {}) as CiLiState
}
function lianYouState(state: SanguoshaState): LianYouState {
  const root = state as unknown as Record<string, unknown>
  return (root.paperSanguoshaB87 ??= {}) as LianYouState
}

registerSkillRuntime({
  id: HUAN_HUAIJIN_LIANYOU,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      queueLianYou(host, ownerId, 'turn-start')
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const amount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      if (context.event.targetId === ownerId && amount > 0) queueLianYou(host, ownerId, 'damage')
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'choose-mode') {
      const used = lianYouState(host.state).lianYouUse?.[ownerId]
      const usedOptions = used?.roundNumber === host.state.roundNumber ? used.options : []
      const options = [
        { id: 'recover', label: '令一名角色回复1点体力' },
        { id: 'equipment', label: '令一名角色随机使用两张装备牌' },
        { id: 'draw', label: '摸三张牌并可交给一名其他角色三张牌' },
      ].filter((option) => !usedOptions.includes(['recover', 'equipment', 'draw'].indexOf(option.id) + 1))
      if (!options.length || !host.state.players.find((entry) => entry.id === ownerId)?.alive
        || Number(queued.data.roundNumber) !== host.state.roundNumber) return
      host.askSkill({ skillId: HUAN_HUAIJIN_LIANYOU, ownerId, step: 'choose-mode', data: { roundNumber: host.state.roundNumber }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【怜幼】：选择本轮尚未发动过的一项效果', timeoutMs: 25_000,
        optional: true, options,
      }) })
      return
    }
    if (queued.step === 'choose-recover-target') {
      const candidates = host.state.players.filter((entry) => entry.alive)
      host.askSkill({ skillId: HUAN_HUAIJIN_LIANYOU, ownerId, step: 'recover-target', data: { roundNumber: queued.data.roundNumber }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【怜幼】：选择一名角色回复1点体力', timeoutMs: 25_000,
        optional: false, candidateIds: candidates.map(({ id: playerId }) => playerId), min: 1, max: 1,
      }) })
      return
    }
    if (queued.step === 'choose-give-target') {
      const candidates = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId)
      if (!candidates.length || (host.state.players.find((entry) => entry.id === ownerId)?.zones.hand.length ?? 0) < 3) return
      host.askSkill({ skillId: HUAN_HUAIJIN_LIANYOU, ownerId, step: 'give-target', data: { roundNumber: queued.data.roundNumber }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【怜幼】：可选择一名其他角色交给其三张手牌', timeoutMs: 25_000,
        optional: true, candidateIds: candidates.map(({ id: playerId }) => playerId), min: 0, max: 1,
      }) })
      return
    }
    if (queued.step === 'choose-equip-target') {
      const candidates = host.state.players.filter((entry) => entry.alive)
      host.askSkill({ skillId: HUAN_HUAIJIN_LIANYOU, ownerId, step: 'equip-target', data: { roundNumber: queued.data.roundNumber }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【怜幼】：选择一名角色随机使用两张装备牌', timeoutMs: 25_000,
        optional: false, candidateIds: candidates.map(({ id: playerId }) => playerId), min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-mode') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!optionId) return
      const optionNumber = ({ recover: 1, equipment: 2, draw: 3 } as Record<string, number>)[optionId]
      if (!optionNumber || Number(resolution.data.roundNumber) !== host.state.roundNumber
        || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
      const previous = lianYouState(host.state).lianYouUse?.[ownerId]
      const used = previous?.roundNumber === host.state.roundNumber ? previous.options : []
      if (used.includes(optionNumber)) return
      lianYouState(host.state).lianYouUse ??= {}
      lianYouState(host.state).lianYouUse![ownerId] = { roundNumber: host.state.roundNumber, options: [...used, optionNumber] }
      if (optionId === 'recover') host.queueSkill({ skillId: HUAN_HUAIJIN_LIANYOU, ownerId, step: 'choose-recover-target', data: { roundNumber: host.state.roundNumber } })
      else if (optionId === 'equipment') host.queueSkill({ skillId: HUAN_HUAIJIN_LIANYOU, ownerId, step: 'choose-equip-target', data: { roundNumber: host.state.roundNumber } })
      else if (optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 3, (name, payload) => host.dispatch(name, payload))
        host.queueSkill({ skillId: HUAN_HUAIJIN_LIANYOU, ownerId, step: 'choose-give-target', data: { roundNumber: host.state.roundNumber } })
      }
      return
    }
    if (resolution.step === 'recover-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || Number(resolution.data.roundNumber) !== host.state.roundNumber
        || !host.state.players.find((entry) => entry.id === targetId)?.alive) return
      recover(host, targetId, 1, ownerId)
      return
    }
    if (resolution.step === 'equip-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = host.state.players.find((entry) => entry.id === targetId)
      if (!targetId || !target?.alive || Number(resolution.data.roundNumber) !== host.state.roundNumber) return
      const openSlots = equipmentSlotsOf(host.state, targetId)
      const candidates = [...host.state.zones.drawPile, ...host.state.zones.discardPile].filter((cardId) => {
        const card = host.state.cards[cardId]
        if (card?.category !== 'equipment' || !card.equipmentSlot
          || isCardUseProhibited(host.state, targetId, card.name, { dyingPlayerId: host.state.dying?.playerId ?? null })) return false
        return openSlots.some((slot) => card.equipmentSlot === 'weapon'
          ? slot === 'weapon' || slot === 'weapon2'
          : slot === card.equipmentSlot)
      })
      const selected = host.rng.shuffle(candidates).slice(0, 2)
      for (const cardId of selected) {
        const fromDraw = host.state.zones.drawPile.includes(cardId)
        const fromDiscard = host.state.zones.discardPile.includes(cardId)
        if (!fromDraw && !fromDiscard) continue
        moveCard(host.state, cardId, fromDraw ? { kind: 'drawPile' } : { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
        const slots = equipmentSlotsForSkillUse(host.state, targetId, cardId)
        if (!slots.length || !useEquipmentFromSkill(host as unknown as CardEngineHost, targetId, cardId, slots[0])) {
          moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, fromDiscard ? { kind: 'discardPile' } : { kind: 'drawPile' })
        }
      }
      return
    }
    if (resolution.step === 'give-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || targetId === ownerId || Number(resolution.data.roundNumber) !== host.state.roundNumber
        || !host.state.players.find((entry) => entry.id === targetId)?.alive) return
      const hand = host.state.players.find((entry) => entry.id === ownerId)?.zones.hand ?? []
      if (hand.length < 3) return
      host.askSkill({ skillId: HUAN_HUAIJIN_LIANYOU, ownerId, step: 'give-cards', data: { targetId, hand: [...hand], roundNumber: host.state.roundNumber }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【怜幼】：选择三张手牌交给该角色', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...hand], hiddenCardSlots: [], min: 3, max: 3,
      }) })
      return
    }
    if (resolution.step === 'give-cards') {
      if (Number(resolution.data.roundNumber) !== host.state.roundNumber) return
      const targetId = resolution.data.targetId as PlayerId
      const chosen = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const hand = host.state.players.find((entry) => entry.id === ownerId)?.zones.hand ?? []
      if (chosen.length !== 3 || new Set(chosen).size !== 3 || chosen.some((id) => !hand.includes(id))
        || !host.state.players.find((entry) => entry.id === targetId)?.alive) return
      giveCards(host, ownerId, targetId, chosen, HUAN_HUAIJIN_LIANYOU)
    }
  },
})

function queueLianYou(host: SkillHost, ownerId: PlayerId, trigger: string): void {
  if (!host.state.players.find((entry) => entry.id === ownerId)?.alive) return
  const used = lianYouState(host.state).lianYouUse?.[ownerId]
  if (used?.roundNumber === host.state.roundNumber && used.options.length === 3) return
  host.queueSkill({ skillId: HUAN_HUAIJIN_LIANYOU, ownerId, step: 'choose-mode', data: { roundNumber: host.state.roundNumber, trigger } })
}

registerSkillRuntime({
  id: HUAN_HUAIJIN_CILI,
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
      if (!host.state.players.find((entry) => entry.id === ownerId)?.alive) return
      host.queueSkill({ skillId: HUAN_HUAIJIN_CILI, ownerId, step: 'choose-record-target', data: { roundNumber: host.state.roundNumber } })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const records = ciLiState(host.state).ciLi?.[ownerId] ?? []
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      for (const record of records) if (record.turnNumber === undefined && record.targetId === targetId) {
        record.turnNumber = host.state.turnNumber
        record.usedCards = 0
      }
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const records = ciLiState(host.state).ciLi?.[ownerId] ?? []
      for (const record of records) if (record.turnNumber === host.state.turnNumber && record.targetId === context.event.sourceId)
        record.usedCards += 1
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const records = ciLiState(host.state).ciLi?.[ownerId] ?? []
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      const resolved = records.filter((record) => record.targetId === targetId && record.turnNumber === host.state.turnNumber)
      if (!resolved.length) return
      const target = host.state.players.find((entry) => entry.id === targetId)
      ciLiState(host.state).ciLi![ownerId] = records.filter((record) => !resolved.includes(record))
      if (!target?.alive || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
      for (const record of resolved) host.queueSkill({ skillId: HUAN_HUAIJIN_CILI, ownerId, step: 'offer-result', data: {
        targetId, threshold: record.threshold, usedCards: record.usedCards, turnNumber: record.turnNumber,
      } })
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
      const records = ciLiState(host.state).ciLi?.[ownerId]
      if (records) ciLiState(host.state).ciLi![ownerId] = records.filter((record) => record.targetId !== deadId)
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'offer-result') {
      const targetId = queued.data.targetId as PlayerId
      const target = host.state.players.find((entry) => entry.id === targetId)
      if (!target?.alive || !host.state.players.find((entry) => entry.id === ownerId)?.alive
        || Number(queued.data.turnNumber) !== host.state.turnNumber) return
      const threshold = Number(queued.data.threshold)
      const count = Math.min(5, threshold)
      const fewerUses = Number(queued.data.usedCards) < threshold
      if (fewerUses && !target.zones.hand.length) return
      host.askSkill({ skillId: HUAN_HUAIJIN_CILI, ownerId, step: 'apply-result', data: { ...queued.data }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId,
        prompt: `【慈厉】：是否令${target.nickname}${fewerUses ? `随机弃置${Math.min(count, target.zones.hand.length)}张手牌` : `摸${count}张牌`}？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (queued.step !== 'choose-record-target' || Number(queued.data.roundNumber) !== host.state.roundNumber
      || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
    const candidates = host.state.players.filter((entry) => entry.alive)
    if (!candidates.length) return
    host.askSkill({ skillId: HUAN_HUAIJIN_CILI, ownerId, step: 'record-target', data: { roundNumber: host.state.roundNumber }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【慈厉】：选择一名角色并记录其当前体力值，至其下回合结束结算',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map(({ id: playerId }) => playerId), min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'apply-result') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes'
        || Number(resolution.data.turnNumber) !== host.state.turnNumber
        || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
      const targetId = resolution.data.targetId as PlayerId
      const target = host.state.players.find((entry) => entry.id === targetId)
      if (!target?.alive) return
      const threshold = Number(resolution.data.threshold)
      const count = Math.min(5, threshold)
      if (Number(resolution.data.usedCards) < threshold) {
        const discarded = host.rng.shuffle([...target.zones.hand]).slice(0, Math.min(count, target.zones.hand.length))
        if (discarded.length) discardCardsByIds(host, targetId, discarded, HUAN_HUAIJIN_CILI)
      } else {
        drawCards(host.state, host.rng, targetId, count, (name, payload) => host.dispatch(name, payload))
      }
      return
    }
    if (resolution.step !== 'record-target' || Number(resolution.data.roundNumber) !== host.state.roundNumber) return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId) return
    const target = host.state.players.find((entry) => entry.id === targetId)
    if (!target?.alive || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
    ciLiState(host.state).ciLi ??= {}
    const records = ciLiState(host.state).ciLi![ownerId] ??= []
    records.push({ roundNumber: host.state.roundNumber, targetId, threshold: target.hp, usedCards: 0 })
  },
})

registerSkillRuntime({
  id: XIAHOU_EN_SHIWU,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId || targetId === ownerId || !host.state.players.find((entry) => entry.id === ownerId)?.alive
        || !host.state.players.find((entry) => entry.id === targetId)?.alive) return
      host.queueSkill({ skillId: XIAHOU_EN_SHIWU, ownerId, step: 'offer-duel', data: { targetId, turnNumber: host.state.turnNumber } })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const record = b87(host.state).xiahouDuel?.[ownerId]
      const event = context.event
      const payload = event.payload as { cardId?: CardId | null; cardName?: string | null; finalAmount?: number }
      const cardId = payload.cardId ?? event.cardIds?.[0]
      if (!record || cardId !== record.cardId || payload.cardName !== '决斗' || (payload.finalAmount ?? 0) <= 0) return
      if (event.sourceId === ownerId && event.targetId === record.targetId) {
        const candidates = host.state.zones.drawPile.filter((id) => {
          const card = host.state.cards[id]
          return card && (['杀', '火杀', '雷杀'].includes(card.name) || DAMAGE_TRICKS.has(card.name))
        })
        if (candidates.length) host.queueSkill({ skillId: XIAHOU_EN_SHIWU, ownerId, step: 'gain-damage-card',
          data: { candidates, duelCardId: record.cardId } })
        return
      }
      if (event.sourceId !== record.targetId || event.targetId !== ownerId) return
      const grantSource = `b87-xiahou-en-shiwu:${ownerId}`
      replaceTemporarySkill(host.state, record.targetId, grantSource, XIAHOU_EN_CHIJIAN)
      suppressSkill(host.state, {
        targetId: ownerId, skillId: XIAHOU_EN_CHIJIAN, scope: 'skill', sourceId: record.targetId,
        sourceSkillId: XIAHOU_EN_SHIWU, armedAtTurn: host.state.turnNumber, expiresAt: 'never',
      })
      b87(host.state).temporaryChijianTargets ??= {}
      const targets = b87(host.state).temporaryChijianTargets![ownerId] ??= []
      if (!targets.includes(record.targetId)) targets.push(record.targetId)
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const record = b87(host.state).xiahouDuel?.[ownerId]
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      if (record && record.cardId === cardId) delete b87(host.state).xiahouDuel?.[ownerId]
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId) return
      const targets = b87(host.state).temporaryChijianTargets?.[ownerId] ?? []
      if (!targets.includes(targetId)) return
      replaceTemporarySkill(host.state, targetId, `b87-xiahou-en-shiwu:${ownerId}`, null)
      host.state.skillSuppressions = (host.state.skillSuppressions ?? []).filter((entry) => !(
        entry.targetId === ownerId && entry.skillId === XIAHOU_EN_CHIJIAN
          && entry.sourceId === targetId && entry.sourceSkillId === XIAHOU_EN_SHIWU
      ))
      b87(host.state).temporaryChijianTargets![ownerId] = targets.filter((id) => id !== targetId)
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const { playerId, sourceId } = context.event.payload as { playerId?: PlayerId; sourceId?: PlayerId | null }
      if (playerId === ownerId && sourceId && sourceId !== ownerId
        && host.state.players.find((entry) => entry.id === sourceId)?.alive)
        grantSkill(host.state, sourceId, XIAHOU_EN_CHIJIAN)
    } },
  ],
  startQueued(host, ownerId, queued) {
    if (queued.step === 'gain-damage-card') {
      const candidates = queued.data.candidates as CardId[]
      const legal = candidates.filter((id) => host.state.zones.drawPile.includes(id))
      if (!legal.length || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
      host.askSkill({ skillId: XIAHOU_EN_SHIWU, ownerId, step: 'take-damage-card', data: { candidates: legal }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【恃武】：从牌堆中选择一张伤害牌获得',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: legal, viewOnlyCardIds: legal,
        hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (queued.step !== 'offer-duel') return
    const targetId = queued.data.targetId as PlayerId
    if (Number(queued.data.turnNumber) !== host.state.turnNumber
      || !host.state.players.find((entry) => entry.id === ownerId)?.alive
      || !host.state.players.find((entry) => entry.id === targetId)?.alive) return
    host.askSkill({ skillId: XIAHOU_EN_SHIWU, ownerId, step: 'duel-choice', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【恃武】：是否视为对${host.state.players.find((entry) => entry.id === targetId)?.nickname ?? '该角色'}使用【决斗】？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '视为使用【决斗】' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'take-damage-card') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const candidates = resolution.data.candidates as CardId[]
      if (!selected || !candidates.includes(selected) || !host.state.zones.drawPile.includes(selected)
        || !host.state.players.find((entry) => entry.id === ownerId)?.alive) return
      moveCard(host.state, selected, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: XIAHOU_EN_SHIWU },
        { sourceId: ownerId, targetId: ownerId, cardIds: [selected] })
      return
    }
    if (resolution.step !== 'duel-choice' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    if (!host.state.players.find((entry) => entry.id === ownerId)?.alive
      || !host.state.players.find((entry) => entry.id === targetId)?.alive) return
    if (!host.beginVirtualTrick({ sourceId: ownerId, targetId, cardName: '决斗', sourceSkillId: XIAHOU_EN_SHIWU })) return
    const current = host.state.cardResolution as { kind?: string; cardId?: CardId } | null
    if (current?.kind === 'trick' && current.cardId)
      (b87(host.state).xiahouDuel ??= {})[ownerId] = { targetId, cardId: current.cardId }
  },
})

const XIAHOU_EN_SKILLS: CharacterDefinition['skills'] = [
  { id: XIAHOU_EN_CHIJIAN, name: '持剑', locked: true,
    description: '锁定技，你出牌阶段可使用【杀】次数+1，若你装备区没有武器牌你视为装备【青釭剑】。' },
  { id: XIAHOU_EN_SHIWU, name: '恃武',
    description: '其他角色回合开始时，你可视为对其使用【决斗】。若你对其造成伤害，你从牌堆中选择一张伤害牌获得；若其对你造成伤害，其获得“持剑”，你失去“持剑”直至其回合结束。杀死你的角色获得“持剑”。' },
]

export const XING_XIAHOU_BA_B87: CharacterDefinition = {
  id: 'xing-xiahouba-b87', name: '星·夏侯霸', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [
    { id: XING_XIAHOU_BA_WEIGU, name: '维谷', description: '你使用伤害牌指定唯一目标或成为伤害牌唯一目标时，你可以弃置一张可指定自己为目标的牌，然后选择一项：1.移动场上一张牌；2.令你攻击范围内的所有角色也成为此牌目标（不包括此牌使用者）。此牌结算后若未造成伤害，你失去1点体力并摸两张牌。' },
    { id: XING_XIAHOU_BA_JUEFA, name: '绝伐', description: '限定技，出牌阶段，你可以将“维谷”中“移动场上一张牌”改为“对一名角色造成2点伤害”直到你的下个回合结束。若如此做，当你于此期间通过“维谷”杀死角色后，你将手牌和体力值调整至体力上限；若此效果结束时你未于此期间杀死角色，你失去体力至濒死状态。' },
  ],
}

export const WEI_ZHANG_XINGCAI_B87: CharacterDefinition = {
  id: 'wei-zhangxingcai-b87', name: '威·张星彩', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: WEI_ZHANG_XINGCAI_HUANGNU, name: '煌怒', description: '出牌阶段或受到伤害后，你可选择一项执行：1.选择一名角色令其随机弃置一张你指定类型的牌；2.你视为使用一张〖杀〗；3.令一名角色本回合下次使用的牌无效。执行后恢复X个装备栏，若恢复数不足X则此技能失效至本回合结束。（X为此技能本回合发动的次数）' },
    { id: WEI_ZHANG_XINGCAI_XIANKUANG, name: '贤贶', description: '有角色非因使用失去基本牌进入弃牌堆时，你可废除一个装备栏并选择一项发动：1.获得此牌；2.令此角色摸你已废除的装备栏数张牌。（单回合因此技能获得牌累计大于1张时此技能失效至本回合结束）' },
  ],
}

export const XIAHOU_EN_B87: CharacterDefinition = {
  id: 'xiahou-en-b87', name: '夏侯恩', kingdom: 'wei', gender: 'male', maxHp: 5, pack: 'sp',
  skills: XIAHOU_EN_SKILLS,
}

export const HUAN_HUAIJIN_B87: CharacterDefinition = {
  id: 'huan-huaijin-b87', name: '环怀瑾', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: HUAN_HUAIJIN_LIANYOU, name: '怜幼', description: '每轮每项限一次，你的回合开始或受到伤害后可选择一项执行：1.令一名角色回复1点体力；2.令一名角色随机使用牌堆或弃牌堆中2张装备牌；3.摸3张牌并可以交给一名其他角色3张牌。' },
    { id: HUAN_HUAIJIN_CILI, name: '慈厉', description: '每轮开始时，你可选择一名角色并记录其当前体力值，直到其下个回合结束，若其使用的牌数小于/大于等于记录值，你可令其随机弃置/摸记录值张牌（至多5张）。' },
  ],
}

export const LI_ZHAOYI_B87: CharacterDefinition = {
  id: 'li-zhaoyi-b87', name: '李昭仪', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: LI_ZHAOYI_MINGJIE, name: '明节', description: '游戏开始选择一名其他角色，你与其获得对方因弃牌阶段弃置的牌；你或其的阶段被跳过时各摸2张牌并可令对方防止下次受到的伤害。所选角色阵亡时，你立即阵亡。' },
    { id: LI_ZHAOYI_XIANFU, name: '娴辅', description: '每回合限一次，你成为牌目标时，可跳过你下个除准备阶段和结束阶段外的一个阶段令此牌对你无效，且你与明节角色互相观看手牌并可获得对方至多3张手牌。' },
  ],
}

export const XING_DONGYUN_B87: CharacterDefinition = {
  id: 'xing-dongyun-b87', name: '星·董允', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [
    { id: XING_DONGYUN_BISHI, name: '弼士', description: '每轮限一次，一名角色的回合结束时，你可以交给其任意张牌，然后若其手牌数与体力值相等，其执行一个出牌阶段，此阶段内其使用的第一张牌不能被响应，且每次使用伤害牌时你摸一张牌。' },
    { id: XING_DONGYUN_ZHENGTING, name: '正听', description: '出牌阶段限一次，你可以选择一名其他角色并与其依次互相观看手牌，然后选择一项：1.你与其分别保留手牌中每种花色各一张牌并弃置其余手牌；2.你与其分别摸手牌中每种没有的花色牌各一张。' },
  ],
}

export const LIU_ZHEN_B87: CharacterDefinition = {
  id: 'liu-zhen-b87', name: '刘桢', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: LIU_ZHEN_WUJUE, name: '五绝', description: '你使用手牌结算完毕后，获得此牌名字数个“绝”标记；当“绝”的数量为5的倍数时，你移去所有“绝”，然后亮出牌堆顶的3张牌，你可将其中牌名字数之和为5的任意张牌交给一名角色。' },
    { id: LIU_ZHEN_ZHENGU, name: '贞骨', description: '你受到伤害后，你可令一名角色随机从牌堆获得2张牌并将你的武将牌翻面，然后若你的翻面状态与伤害来源不同，本轮“五绝”亮出的牌数+1（至多为5）；若相同，你本回合无法响应其他角色使用的牌。' },
  ],
}

export const SHEN_CAO_PI_B87: CharacterDefinition = {
  id: 'shen-caopi-b87', name: '神·曹丕', kingdom: 'shen', gender: 'male', maxHp: 4, pack: 'god',
  skills: [
    { id: SHEN_CAO_PI_YINZHI, name: '阴鸷', description: '出牌阶段限一次，你可以选择一名其他角色并摸X张牌，该角色直至其回合开始所有非锁定技失效，且每次使用或打出手牌后你摸X张牌（X为本局游戏你对其发动“阴鸷”的次数且至多为3）。然后其回合内只能使用或打出本回合获得的牌，若其对你造成伤害，则此效果消失。' },
    { id: SHEN_CAO_PI_KEMING, name: '刻名', description: '当你受到其他角色造成的伤害后，若其武将牌上有此时机触发的技能，则你可以触发此技能；若没有，则你可从曹姓武将中随机触发一个此时机的技能。当你对其他角色造成伤害后，该角色下次于准备阶段、结束阶段或出牌阶段发动技能后，若其因此技能摸牌或使用了牌，你可以摸等量同名牌（至多为5）。' },
  ],
}

export const LE_CAO_ZHI_B87: CharacterDefinition = {
  id: 'le-cao-zhi-b87', name: '乐曹植', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: LE_CAO_ZHI_FULE, name: '赋乐', locked: true, description: '锁定技，你的初始手牌增加“赋”标记且不计入手牌上限。“赋”随机获得另一种非装备牌牌名，使用“赋”时可选择使用该牌所拥有的任意一种牌名。' },
    { id: LE_CAO_ZHI_WENLAN, name: '文澜', description: '你每使用或打出两张牌结算后：若为包含相同牌名的两张“赋”，你从牌堆中获得这两张“赋”所含牌名的牌各一张，并标记为“赋”；否则你选择任意张手牌标记为“赋”或替换“赋”牌名。' },
  ],
}

export const WEI_MA_TENG_B87: CharacterDefinition = {
  id: 'wei-ma-teng-b87', name: '威·马腾', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: WEI_MA_TENG_HEQI, name: '合骑', description: '游戏开始时，你获得3个“骑”，你不以此法使用【杀】结算后，可视为对一名拥有“骑”的其他角色使用X张【杀】（X为该角色“骑”的数量），此【杀】造成的伤害无伤害来源。你对拥有“骑”的角色使用牌无距离限制。' },
    { id: WEI_MA_TENG_HUIRUI, name: '挥锐', description: '出牌阶段开始或受到伤害后，你可选择一项发动：1.获得两个“骑”；2.移动场上任意一个“骑”至任意其他角色处；3.你视为使用一张【杀】。' },
    { id: WEI_MA_TENG_XIAOBEN, name: '骁贲', description: '连招技（伤害牌+非基本牌）：你可移动一个“骑”并可移除所有其他角色的“骑”，其他角色每失去一个“骑”便受到一点伤害。' },
  ],
}

export const HISTORICAL_BATCH87_CHARACTERS: readonly CharacterDefinition[] = [
  WEI_ZHANG_XINGCAI_B87,
  XING_XIAHOU_BA_B87,
  XING_DONGYUN_B87,
  XIAHOU_EN_B87,
  LIU_ZHEN_B87,
  LI_ZHAOYI_B87,
  HUAN_HUAIJIN_B87,
  SHEN_CAO_PI_B87,
  LE_CAO_ZHI_B87,
  WEI_MA_TENG_B87,
]

