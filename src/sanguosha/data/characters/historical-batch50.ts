import { handleEquipmentLost } from '../../engine/equipment'
import { gainArmor } from '../../engine/armor'
import { drawCards } from '../../engine/draw'
import { revealTopCards } from '../../engine/draw'
import { createVirtualSlashCard, declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { resolveDamage } from '../../engine/damage'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { loseMaxHp } from '../../engine/hp'
import { effectiveKingdomOf } from '../../engine/huashen'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { effectiveCardName, locateOwnedCard, moveCard } from '../../engine/zones'
import { isSoleTargetOf } from '../../engine/card-use-targets'
import { canTarget } from '../../engine/distance'
import { effectiveCardColor, effectiveCardSuit, isCardUseProhibited, isTargetProhibited, registerSkillRuntime, type SkillHost, type ViewAsOption } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerGeneralRevealProhibition, revealedGeneralCharacterIdsOf, setGeneralRevealed } from '../../engine/general-slots'
import { revealNationalWarGeneral } from '../../engine/modes/national-war'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { LegalAction } from '../../engine/actions'
import { skillIdsOf } from './standard'
import type { CharacterDefinition } from './types'

const B50 = ':b50'
const JIE_QUANZONG_YAOMING = `yaoming-jie-quanzong${B50}`
const MOU_YANGWAN_MINGXUAN = `mingxuan-mou-yangwan${B50}`
const MOU_YANGWAN_XIANCHOU = `xianchou-mou-yangwan${B50}`
const FUQIAN_POJIANG = `pojiang-fuqian${B50}`
const FUQIAN_JUEYONG = `jueyong-fuqian${B50}`
const MOU_XIAHOU_YANYU = `yanyu-mou-xiahoushi${B50}`
const MOU_XIAHOU_QIAOSHI = `qiaoshi-mou-xiahoushi${B50}`
const JIE_JUSHOU_JIANYING = `jiying-jie-jushou${B50}`
const JIE_JUSHOU_SHIBEI = `shibei-jie-jushou${B50}`
const ZOUSHI_HUOSHUI = `huoshui-zoushi${B50}`
const ZOUSHI_QINGCHENG = `qingcheng-zoushi${B50}`
const MOU_HUANGZHONG_LIEGONG = `liegong-mou-huangzhong${B50}`
const JIE_CAOZHEN_SIDI = `sidi-jie-caozhen${B50}`
const MOU_SUNSHANGXIANG_JIEYIN = `jieyin-mou-sunshangxiang${B50}`
const MOU_SUNSHANGXIANG_LIANGZHU = `liangzhu-mou-sunshangxiang${B50}`
const MOU_SUNSHANGXIANG_XIAOJI = `xiaoji-mou-sunshangxiang${B50}`
const MOU_ZHAOYUN_LONGDAN = `longdan-mou-zhaoyun${B50}`
const MOU_ZHAOYUN_JIZHU = `jizhu-mou-zhaoyun${B50}`

registerGeneralRevealProhibition((state, playerId) => {
  const owner = state.players.find((player) => player.alive && player.id === state.currentPlayerId)
  return Boolean(owner && owner.id !== playerId && revealedGeneralCharacterIdsOf(owner).includes('zoushi-b50'))
})

function playerOf(state: SanguoshaState, id: PlayerId) {
  return state.players.find((player) => player.id === id)
}

function livingOthers(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
}

function markNumber(state: SanguoshaState, ownerId: PlayerId, mark: string): number {
  return playerOf(state, ownerId)?.marks[mark] ?? 0
}

function setMark(state: SanguoshaState, ownerId: PlayerId, mark: string, value: number): void {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  if (value > 0) owner.marks[mark] = value
  else delete owner.marks[mark]
}

function yaomingCharges(state: SanguoshaState, ownerId: PlayerId): number {
  return playerOf(state, ownerId)?.marks[YAOMING_CHARGES] ?? 2
}

function handCardCount(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.zones.hand.length ?? 0
}

function discardableCardIds(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  return [...player.zones.hand,
    ...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id)),
    ...player.zones.judgingArea,
  ]
}

function yaomingEligibleOptions(state: SanguoshaState, ownerId: PlayerId): Array<{ id: string; label: string }> {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return [
    ...(state.players.some((target) => target.alive && target.id !== ownerId
      && handCardCount(state, target.id) >= owner.zones.hand.length && discardableCardIds(state, target.id).length)
      ? [{ id: 'discard', label: '弃置一名手牌数不小于你的其他角色的一张牌' }] : []),
    ...(state.players.some((target) => target.alive && handCardCount(state, target.id) <= owner.zones.hand.length)
      ? [{ id: 'draw', label: '令一名手牌数不大于你的角色摸一张牌' }] : []),
  ]
}

function askYaomingOption(host: SkillHost, ownerId: PlayerId, step: string, optional: boolean): void {
  const options = yaomingEligibleOptions(host.state, ownerId)
  if (!options.length) return
  host.askSkill({ skillId: JIE_QUANZONG_YAOMING, ownerId, step, data: {},
    build: (id) => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【邀名】：选择一项', timeoutMs: 20_000, optional,
      options: optional ? [{ id: 'no', label: '不发动' }, ...options] : options,
    }),
  })
}

// —— 界全琮【邀名】——
const YAOMING_CHARGES = '邀名·次数'
const YAOMING_PREVIOUS = '邀名·选项'

registerSkillRuntime({
  id: JIE_QUANZONG_YAOMING,
  onGameStart(host, ownerId) {
    setMark(host.state, ownerId, YAOMING_CHARGES, 2)
    setMark(host.state, ownerId, YAOMING_PREVIOUS, 0)
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const event = context.event.payload as { finalAmount?: number }
    if (context.event.targetId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
    const amount = Math.max(0, Math.trunc(event.finalAmount ?? 0))
    if (!amount) return
    setMark(host.state, ownerId, YAOMING_CHARGES, Math.min(4, markNumber(host.state, ownerId, YAOMING_CHARGES) + amount))
    host.queueSkill({ skillId: JIE_QUANZONG_YAOMING, ownerId, step: 'damage-invoke', data: { amount } })
  } }],
  activeActions(state, ownerId) {
    if (!playerOf(state, ownerId)?.alive || yaomingCharges(state, ownerId) <= 0) return []
    const play = state.phase === 'play' && state.currentPlayerId === ownerId
    return play ? [{ id: `skill:${JIE_QUANZONG_YAOMING}`, label: `邀名（剩余${yaomingCharges(state, ownerId)}次）` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIE_QUANZONG_YAOMING}` || markNumber(host.state, ownerId, YAOMING_CHARGES) <= 0) return
    if (actionId === `skill:${JIE_QUANZONG_YAOMING}` && yaomingCharges(host.state, ownerId) > 0)
      askYaomingOption(host, ownerId, 'choose-option', false)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'damage-invoke' && playerOf(host.state, ownerId)?.alive
      && yaomingCharges(host.state, ownerId) > 0) askYaomingOption(host, ownerId, 'damage-invoke', true)
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'damage-invoke') {
      if ((response.payload as { optionId?: string }).optionId === 'no') return
      if ((response.payload as { optionId?: string }).optionId !== 'discard'
        && (response.payload as { optionId?: string }).optionId !== 'draw') return
    }
    if (resolution.step === 'choose-option' || resolution.step === 'damage-invoke') {
      const option = (response.payload as { optionId?: string }).optionId
      if (option !== 'discard' && option !== 'draw') return
      const legalTargets = host.state.players.filter((target) => target.alive
        && (option === 'discard'
          ? target.id !== ownerId && handCardCount(host.state, target.id) >= owner.zones.hand.length && discardableCardIds(host.state, target.id).length > 0
          : handCardCount(host.state, target.id) <= owner.zones.hand.length)).map((target) => target.id)
      if (!legalTargets.length) return
      host.askSkill({ skillId: JIE_QUANZONG_YAOMING, ownerId, step: 'choose-target', data: { option },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【邀名】：选择目标', timeoutMs: 20_000,
          optional: false, candidateIds: legalTargets, min: 1, max: 1 }),
      })
      return
    }
    if (resolution.step === 'choose-target') {
      const option = resolution.data.option as 'discard' | 'draw'
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const legal = target?.alive && (option === 'discard'
        ? target.id !== ownerId && handCardCount(host.state, target.id) >= owner.zones.hand.length && discardableCardIds(host.state, target.id).length > 0
        : handCardCount(host.state, target.id) <= owner.zones.hand.length)
      if (!legal || !targetId) return
      const charges = yaomingCharges(host.state, ownerId)
      if (charges <= 0) return
      setMark(host.state, ownerId, YAOMING_CHARGES, charges - 1)
      const previous = markNumber(host.state, ownerId, YAOMING_PREVIOUS)
      const selectedMark = option === 'discard' ? 1 : 2
      if (previous > 0 && previous !== selectedMark) {
        setMark(host.state, ownerId, YAOMING_CHARGES, Math.min(4, markNumber(host.state, ownerId, YAOMING_CHARGES) + 1))
        setMark(host.state, ownerId, YAOMING_PREVIOUS, 0)
      } else setMark(host.state, ownerId, YAOMING_PREVIOUS, selectedMark)
      if (option === 'draw') {
        drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      const candidates = discardableCardIds(host.state, targetId)
      if (!candidates.length) return
      host.askSkill({ skillId: JIE_QUANZONG_YAOMING, ownerId, step: 'discard-card', data: { targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【邀名】：弃置${target!.nickname}的一张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1 }),
      })
      return
    }
    if (resolution.step === 'discard-card') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const from = cardId && target?.alive ? locateOwnedCard(host.state, targetId, cardId) : null
      if (!target?.alive || !cardId || !from || from.kind === 'characterPile') return
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JIE_QUANZONG_YAOMING },
        { sourceId: ownerId, targetId, cardIds: [cardId] })
    }
  },
})

export const B50_JIE_QUANZONG: CharacterDefinition = {
  id: 'jie-quanzong-b50', name: '界·全琮', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [{ id: JIE_QUANZONG_YAOMING, name: '邀名', description: '剩余可用X次（X初始为2且最大为4），出牌阶段或你受到伤害后，你可以选择一项：1.弃置手牌数不小于你的一名其他角色的一张牌；2.令手牌数不大于你的一名角色摸一张牌。若与你上次选择的选项不同，则剩余可用次数+1，并清除已记录的选项。每当你受到1点伤害后剩余可用次数+1。' }],
}

type YangwanSlashState = SanguoshaState & {
  b50YangwanSlashOwners?: Record<CardId, PlayerId>
  b50YangwanResume?: Record<CardId, { recipients: PlayerId[]; index: number }>
}
type FQState = SanguoshaState & {
  b50FuqianJueSources?: Record<CardId, PlayerId>
  b50FuqianExempt?: Record<PlayerId, { turnNumber: number; cardIds: CardId[] }>
  b50FuqianResume?: Record<CardId, { ownerId: PlayerId; cardIds: CardId[]; index: number }>
}
type XiahouShiState = SanguoshaState & {
  b50XiahouSlashDiscard?: Record<PlayerId, { turnNumber: number; count: number }>
  b50XiahouQiaoshiTurn?: Record<PlayerId, number>
}
type JushouState = SanguoshaState & {
  b50JushouLast?: Record<PlayerId, { turnNumber: number; suit: string | null; rank: number | null }>
  b50JushouSuitOverride?: Record<CardId, string>
  b50JushouDamageTurn?: Record<PlayerId, number>
}
type HuangzhongState = SanguoshaState & {
  b50HuangzhongSuits?: Record<PlayerId, string[]>
  b50HuangzhongSlash?: Record<CardId, { ownerId: PlayerId; suits: string[]; bonus: number }>
}
type CaozhenState = SanguoshaState & {
  /** Server-only, never projected into PlayerView: actor -> predicted unique target. */
  b50CaozhenPredictions?: Record<PlayerId, { ownerId: PlayerId; targetId: PlayerId }>
  b50CaozhenMatchedCard?: Record<CardId, { ownerId: PlayerId; actorId: PlayerId; targetId: PlayerId }>
}
type SunshangxiangState = SanguoshaState & {
  b50SunAssistTarget?: Record<PlayerId, PlayerId>
  b50SunReceipts?: Record<PlayerId, Record<PlayerId, number>>
}
type ZhaoyunState = SanguoshaState & {
  b50ZhaoyunCharges?: Record<PlayerId, number>
  b50ZhaoyunCooperation?: Record<PlayerId, { targetId: PlayerId; mode: 'damage' | 'draw' | 'discard' | 'use'; damage: number; draw: number; discardSuits: string[]; useSuits: string[] }>
  b50ZhaoyunUpgrade?: Record<PlayerId, boolean>
  b50ZhaoyunConverted?: Record<CardId, PlayerId>
}

function xiahouDiscardCount(state: SanguoshaState, ownerId: PlayerId): number {
  const entry = (state as XiahouShiState).b50XiahouSlashDiscard?.[ownerId]
  return entry?.turnNumber === state.turnNumber ? entry.count : 0
}

function yangwanSlashAction(host: SkillHost, sourceId: PlayerId, targetId: PlayerId, skillId: string): { cardId: CardId; action: Extract<LegalAction, { kind: 'use-card' }> } | null {
  if (!canTarget(host.state, sourceId, targetId)
    || isTargetProhibited(host.state, sourceId, targetId, '杀', skillIdsOf)
    || isCardUseProhibited(host.state, sourceId, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null })) return null
  const cardId = createVirtualSlashCard(host.state, sourceId, skillId)
  const action = declaredCardActions(host.state, sourceId, cardId, '杀', `【${skillId === MOU_YANGWAN_XIANCHOU ? '陷仇' : '暝眩'}】：视为使用【杀】`)
    .find((candidate): candidate is Extract<LegalAction, { kind: 'use-card' }> => candidate.kind === 'use-card'
      && candidate.targetIds.length === 1 && candidate.targetIds[0] === targetId)
  if (!action) {
    const source = playerOf(host.state, sourceId)
    if (source) source.zones.hand = source.zones.hand.filter((id) => id !== cardId)
    delete host.state.cards[cardId]
    return null
  }
  ;(host.state as YangwanSlashState).b50YangwanSlashOwners ??= {}
  ;(host.state as YangwanSlashState).b50YangwanSlashOwners![cardId] = sourceId
  return { cardId, action }
}

function startYangwanSlash(host: SkillHost, sourceId: PlayerId, targetId: PlayerId, skillId: string, resume?: { recipients: PlayerId[]; index: number }): boolean {
  const prepared = yangwanSlashAction(host, sourceId, targetId, skillId)
  if (!prepared) return false
  if (resume) {
    ;(host.state as YangwanSlashState).b50YangwanResume ??= {}
    ;(host.state as YangwanSlashState).b50YangwanResume![prepared.cardId] = resume
  }
  executeUseCardAction(host as never, sourceId, prepared.action)
  return true
}

function seatOrder(state: SanguoshaState, ownerId: PlayerId, playerIds: PlayerId[]): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const count = state.players.length
  return [...new Set(playerIds)].filter((id) => playerOf(state, id)?.alive).sort((a, b) => {
    const left = playerOf(state, a)!
    const right = playerOf(state, b)!
    return ((left.seat - owner.seat + count) % count) - ((right.seat - owner.seat + count) % count)
  })
}

registerSkillRuntime({
  id: MOU_YANGWAN_MINGXUAN,
  triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    if (event.playerId === ownerId && event.phase === 'play' && owner?.alive
      && owner.zones.hand.length && livingOthers(host.state, ownerId).length)
      host.queueSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'select-cards', data: {} })
  } },
  { event: 'CardResolved', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const continuation = cardId && (host.state as YangwanSlashState).b50YangwanResume?.[cardId]
    if (!cardId || !continuation) return
    delete (host.state as YangwanSlashState).b50YangwanResume![cardId]
    if (playerOf(host.state, ownerId)?.alive)
      host.queueSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'resolve-recipient', data: { ...continuation, index: continuation.index + 1 } })
  } }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'select-cards') host.askSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'select-cards', data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【暝眩】：选择要随机交给其他角色的手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length }),
    })
    if (prompt.step === 'resolve-recipient') resolveYangwanRecipient(host, ownerId, prompt.data as { recipients: PlayerId[]; index: number })
    if (prompt.step === 'retaliation-invoke') {
      const sourceId = prompt.data.sourceId as PlayerId
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.id !== sourceId
        && yangwanSlashActionLegal(host.state, player.id, sourceId)).map((player) => player.id)
      if (candidates.length) host.askSkill({ skillId: MOU_YANGWAN_XIANCHOU, ownerId, step: 'retaliation-target', data: { sourceId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【陷仇】：选择一名可以对伤害来源使用【杀】的角色', timeoutMs: 20_000, optional: true,
          candidateIds: candidates, min: 1, max: 1 }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'select-cards') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const selected = cardIds.filter((id) => owner.zones.hand.includes(id))
      const candidates = livingOthers(host.state, ownerId)
      if (!selected.length || !candidates.length) return
      const assigned = new Map<PlayerId, CardId[]>()
      for (const cardId of selected) {
        const targetId = host.rng.pick(candidates)
        const list = assigned.get(targetId) ?? []
        list.push(cardId)
        assigned.set(targetId, list)
      }
      for (const [targetId, ids] of assigned) {
        const recipient = playerOf(host.state, targetId)
        if (!recipient?.alive) continue
        for (const cardId of ids) {
          moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
          host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: MOU_YANGWAN_MINGXUAN },
            { sourceId: ownerId, targetId, cardIds: [cardId] })
          host.dispatch('CardGiven', { fromId: ownerId, toId: targetId, cardIds: [cardId], reason: MOU_YANGWAN_MINGXUAN },
            { sourceId: ownerId, targetId, cardIds: [cardId] })
          host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: MOU_YANGWAN_MINGXUAN },
            { sourceId: ownerId, targetId, cardIds: [cardId] })
        }
      }
      const recipients = seatOrder(host.state, ownerId, [...assigned.keys()])
      if (recipients.length) host.queueSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'resolve-recipient', data: { recipients, index: 0 } })
      return
    }
    if (resolution.step === 'recipient-choice') {
      const { recipients, index } = resolution.data as { recipients: PlayerId[]; index: number }
      const targetId = recipients[index]
      const option = (response.payload as { optionId?: string }).optionId
      if (!targetId || !playerOf(host.state, targetId)?.alive) {
        host.queueSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'resolve-recipient', data: { recipients, index: index + 1 } })
        return
      }
      if (option === 'slash') {
        startYangwanSlash(host, targetId, ownerId, MOU_YANGWAN_MINGXUAN, { recipients, index })
        return
      }
      if (option === 'give') {
        const target = playerOf(host.state, targetId)!
        const hand = [...target.zones.hand]
        if (hand.length) {
          host.askSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'give-card', data: { targetId, recipients, index },
            build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
              prompt: '【暝眩】：交给杨婉一张手牌并令其摸一张牌', timeoutMs: 20_000, optional: false,
              purpose: 'skill', cardIds: hand, hiddenCardSlots: [], min: 1, max: 1 }),
          })
          return
        }
      }
      host.queueSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'resolve-recipient', data: { recipients, index: index + 1 } })
      return
    }
    if (resolution.step === 'give-card') {
      const { targetId, recipients, index } = resolution.data as { targetId: PlayerId; recipients: PlayerId[]; index: number }
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const target = playerOf(host.state, targetId)
      if (cardId && target?.alive && target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: MOU_YANGWAN_MINGXUAN }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
        host.dispatch('CardGiven', { fromId: targetId, toId: ownerId, cardIds: [cardId], reason: MOU_YANGWAN_MINGXUAN }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MOU_YANGWAN_MINGXUAN }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      }
      host.queueSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'resolve-recipient', data: { recipients, index: index + 1 } })
    }
  },
})

function resolveYangwanRecipient(host: SkillHost, ownerId: PlayerId, data: { recipients: PlayerId[]; index: number }): void {
  const targetId = data.recipients[data.index]
  const target = targetId ? playerOf(host.state, targetId) : undefined
  const owner = playerOf(host.state, ownerId)
  if (!targetId || !owner?.alive) return
  if (!target?.alive) {
    host.queueSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'resolve-recipient', data: { ...data, index: data.index + 1 } })
    return
  }
  const hasSlash = yangwanSlashActionLegal(host.state, targetId, ownerId)
  const options = [
    ...(hasSlash ? [{ id: 'slash', label: '视为对杨婉使用【杀】' }] : []),
    ...(target.zones.hand.length ? [{ id: 'give', label: '交给杨婉一张手牌，然后杨婉摸一张牌' }] : []),
  ]
  if (!options.length) {
    host.queueSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'resolve-recipient', data: { ...data, index: data.index + 1 } })
    return
  }
  host.askSkill({ skillId: MOU_YANGWAN_MINGXUAN, ownerId, step: 'recipient-choice', data,
    build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: targetId, prompt: '【暝眩】：选择一项', timeoutMs: 20_000, optional: false, options }),
  })
}

function yangwanSlashActionLegal(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): boolean {
  return canTarget(state, sourceId, targetId)
    && !isTargetProhibited(state, sourceId, targetId, '杀', skillIdsOf)
    && !isCardUseProhibited(state, sourceId, '杀', { dyingPlayerId: state.dying?.playerId ?? null })
}

registerSkillRuntime({
  id: MOU_YANGWAN_XIANCHOU,
  triggers: [
    { event: 'AfterDamage', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
      const sourceId = context.event.sourceId
      if (sourceId && sourceId !== ownerId && playerOf(host.state, sourceId)?.alive)
        host.queueSkill({ skillId: MOU_YANGWAN_XIANCHOU, ownerId, step: 'retaliation-invoke', data: { sourceId } })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId | null }).cardId
      const pending = (host.state as YangwanSlashState).b50YangwanSlashOwners
      if (!cardId || !pending?.[cardId]) return
      const amount = (context.event.payload as { finalAmount?: number }).finalAmount ?? 0
      const recipientId = pending[cardId]
      if (amount > 0 && playerOf(host.state, recipientId)?.alive) recover(host as never, ownerId, 1, recipientId, cardId)
    } },
    { event: 'CardResolved', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (cardId) delete (host.state as YangwanSlashState).b50YangwanSlashOwners?.[cardId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'retaliation-invoke') return
    const sourceId = prompt.data.sourceId as PlayerId
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
      && yangwanSlashActionLegal(host.state, player.id, sourceId)).map((player) => player.id)
    if (candidates.length) host.askSkill({ skillId: MOU_YANGWAN_XIANCHOU, ownerId, step: 'retaliation-target', data: { sourceId },
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【陷仇】：选择一名可以对伤害来源使用【杀】的角色', timeoutMs: 20_000, optional: true,
        candidateIds: candidates, min: 1, max: 1 }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'retaliation-target') {
      const sourceId = resolution.data.sourceId as PlayerId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const handAndEquipment = target ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (!target?.alive || !yangwanSlashActionLegal(host.state, target.id, sourceId) || !handAndEquipment.length) return
      host.askSkill({ skillId: MOU_YANGWAN_XIANCHOU, ownerId, step: 'retaliation-cost', data: { sourceId, targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: target.id,
          prompt: '【陷仇】：可以弃置一张牌，视为对伤害来源使用【杀】', timeoutMs: 20_000,
          optional: true, purpose: 'skill', cardIds: handAndEquipment, hiddenCardSlots: [], min: 0, max: 1 }),
      })
      return
    }
    if (resolution.step !== 'retaliation-cost') return
    const sourceId = resolution.data.sourceId as PlayerId
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId) return
    const from = locateOwnedCard(host.state, targetId, cardId)
    if (!from || (from.kind !== 'hand' && from.kind !== 'equipment')) return
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: MOU_YANGWAN_XIANCHOU },
      { sourceId: ownerId, targetId, cardIds: [cardId] })
    startYangwanSlash(host, targetId, sourceId, MOU_YANGWAN_XIANCHOU)
  },
})

export const B50_MOU_YANGWAN: CharacterDefinition = {
  id: 'mou-yangwan-b50', name: '谋·杨婉', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: MOU_YANGWAN_MINGXUAN, name: '暝眩', description: '出牌阶段开始时，选择数张牌然后随机交给其他角色，然后其选择一项：对你使用一张【杀】；交给你一张牌，且你摸一张牌。' },
    { id: MOU_YANGWAN_XIANCHOU, name: '陷仇', description: '当你受到伤害后，可以选择另一名角色，其可以弃置一张牌，视为对伤害来源使用一张【杀】。若此【杀】造成伤害，则你回复1点体力值。' },
  ],
}

function captureFuqianJue(host: SkillHost, ownerId: PlayerId, context: { sourceId: PlayerId; targetId: PlayerId; cardId: CardId; cardName: string; category: string }): boolean {
  const owner = playerOf(host.state, ownerId)
  const card = host.state.cards[context.cardId]
  if (!owner?.alive || context.targetId !== ownerId || !card || card.virtual || card.name !== context.cardName
    || context.cardName === '桃' || context.cardName === '酒' || context.category !== card.category
    // Delayed tricks leave the target ledger when placed into the judging area;
    // their rules-defined target is inherently singular.
    || (!DELAYED_TRICKS.has(context.cardName) && !isSoleTargetOf(host.state, context.cardId, ownerId))
    || (owner.characterPiles['绝'] ?? []).length >= owner.hp) return false
  const from = locateOwnedCard(host.state, ownerId, context.cardId, { includeCharacterPiles: true })
  if (!from || from.kind !== 'processingArea') return false
  ;(host.state as FQState).b50FuqianJueSources ??= {}
  ;(host.state as FQState).b50FuqianJueSources![context.cardId] = context.sourceId
  moveCard(host.state, context.cardId, from, { kind: 'characterPile', playerId: ownerId, pile: '绝' })
  host.dispatch('CardMove', { cardIds: [context.cardId], reason: FUQIAN_JUEYONG, from: 'processingArea', to: 'characterPile' },
    { sourceId: context.sourceId, targetId: ownerId, cardIds: [context.cardId] })
  return true
}

function fuqianPojangStart(host: SkillHost, ownerId: PlayerId): void {
  if (usedThisPhase(host.state, ownerId, FUQIAN_POJIANG)) return
  const candidateIds = livingOthers(host.state, ownerId)
  if (!candidateIds.length || !playerOf(host.state, ownerId)?.zones.hand.length) return
  markUsedThisPhase(host.state, ownerId, FUQIAN_POJIANG)
  host.askSkill({ skillId: FUQIAN_POJIANG, ownerId, step: 'target', data: {},
    build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
      prompt: '【破降】：选择一名其他角色并交给其一张牌', timeoutMs: 20_000,
      optional: false, candidateIds, min: 1, max: 1 }),
  })
}

function queueFuqianAbsolute(host: SkillHost, ownerId: PlayerId, cardIds: CardId[], index: number): void {
  if (index >= cardIds.length) return
  host.queueSkill({ skillId: FUQIAN_JUEYONG, ownerId, step: 'use-absolute', data: { cardIds, index } })
}

registerSkillRuntime({
  id: FUQIAN_POJIANG,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && owner.zones.hand.length > 0 && livingOthers(state, ownerId).length > 0 && !usedThisPhase(state, ownerId, FUQIAN_POJIANG)
      ? [{ id: `skill:${FUQIAN_POJIANG}`, label: '破降：交给一名角色一张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId === `skill:${FUQIAN_POJIANG}`) fuqianPojangStart(host, ownerId)
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.id === ownerId || !owner.zones.hand.length) return
      host.askSkill({ skillId: FUQIAN_POJIANG, ownerId, step: 'give', data: { targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【破降】：交给${target.nickname}一张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1 }),
      })
      return
    }
    if (resolution.step !== 'give') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!target?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: FUQIAN_POJIANG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('CardGiven', { fromId: ownerId, toId: targetId, cardIds: [cardId], reason: FUQIAN_POJIANG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: FUQIAN_POJIANG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    const drawn = drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
    const state = host.state as FQState
    state.b50FuqianExempt ??= {}
    state.b50FuqianExempt[ownerId] = { turnNumber: host.state.turnNumber, cardIds: drawn }
    const absolutes = [...(owner.characterPiles['绝'] ?? [])]
    for (const absoluteId of absolutes) {
      moveCard(host.state, absoluteId, { kind: 'characterPile', playerId: ownerId, pile: '绝' }, { kind: 'discardPile' })
      delete state.b50FuqianJueSources?.[absoluteId]
    }
    if (absolutes.length) host.dispatch('CardMove', { cardIds: absolutes, reason: FUQIAN_POJIANG }, { sourceId: ownerId, cardIds: absolutes })
    loseHp(host as never, ownerId, 1, FUQIAN_POJIANG)
  },
})

registerSkillRuntime({
  id: FUQIAN_JUEYONG,
  cancelsBecomingTarget(host, ownerId, context) {
    return captureFuqianJue(host, ownerId, context)
  },
  interceptTarget(host, ownerId, context) {
    if (!captureFuqianJue(host, ownerId, context)) return false
    const resolution = host.state.cardResolution
    if (resolution?.kind === 'slash' && resolution.targetId === ownerId) resolution.targetCancelled = true
    return false
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = playerOf(host.state, ownerId)
      const cardIds = [...(owner?.characterPiles['绝'] ?? [])]
      if (event.playerId === ownerId && event.phase === 'finish' && owner?.alive && cardIds.length)
        queueFuqianAbsolute(host, ownerId, cardIds, 0)
    } },
    { event: 'CardResolved', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      const pending = (host.state as FQState).b50FuqianResume?.[cardId]
      if (!pending) return
      delete (host.state as FQState).b50FuqianResume![cardId]
      queueFuqianAbsolute(host, pending.ownerId, pending.cardIds, pending.index + 1)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'use-absolute') return
    const { cardIds, index } = prompt.data as { cardIds: CardId[]; index: number }
    const cardId = cardIds[index]
    const owner = playerOf(host.state, ownerId)
    if (!cardId || !owner?.alive || !owner.characterPiles['绝']?.includes(cardId)) return
    const sourceId = (host.state as FQState).b50FuqianJueSources?.[cardId]
    const source = sourceId ? playerOf(host.state, sourceId) : undefined
    if (!source?.alive) {
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: '绝' }, { kind: 'discardPile' })
      delete (host.state as FQState).b50FuqianJueSources?.[cardId]
      queueFuqianAbsolute(host, ownerId, cardIds, index + 1)
      return
    }
    moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: '绝' }, { kind: 'hand', playerId: sourceId! })
    delete (host.state as FQState).b50FuqianJueSources?.[cardId]
    const name = effectiveCardName(host.state, cardId)
    const action = declaredCardActions(host.state, sourceId!, cardId, name, '【绝勇】：按原使用者对傅佥使用此牌')
      .find((candidate): candidate is Extract<LegalAction, { kind: 'use-card' }> => candidate.kind === 'use-card'
        && candidate.targetIds.length === 1 && candidate.targetIds[0] === ownerId)
    if (!action) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId! }, { kind: 'discardPile' })
      queueFuqianAbsolute(host, ownerId, cardIds, index + 1)
      return
    }
    ;(host.state as FQState).b50FuqianResume ??= {}
    ;(host.state as FQState).b50FuqianResume![cardId] = { ownerId, cardIds, index }
    executeUseCardAction(host as never, sourceId!, action)
    if (!(host.state as FQState).b50FuqianResume?.[cardId]) return
    if (host.state.cardResolution?.cardId === cardId) return
    delete (host.state as FQState).b50FuqianResume![cardId]
    queueFuqianAbsolute(host, ownerId, cardIds, index + 1)
  },
  handLimitExempt(state, ownerId, cardId) {
    const exemption = (state as FQState).b50FuqianExempt?.[ownerId]
    return exemption?.turnNumber === state.turnNumber && exemption.cardIds.includes(cardId)
  },
})

export const B50_FUQIAN: CharacterDefinition = {
  id: 'fuqian-b50', name: '傅佥', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: FUQIAN_POJIANG, name: '破降', description: '出牌阶段限一次，你可以交给一名其他角色一张牌，然后你摸三张牌，移除所有“绝”并流失1点体力，你以此法获得的牌本回合不计入手牌上限。' },
    { id: FUQIAN_JUEYONG, name: '绝勇', description: '锁定技。当你成为一张非因“绝勇”使用的、非转化和非虚拟的牌（【桃】和【酒】除外)指定的目标后，若你是此牌的唯一目标，且此时“绝”的数量小于你的体力值，你取消之。然后将此牌置于你的武将牌上，称为“绝”。结束阶段，若你有“绝”，则按照置入顺序从前到后依次结算“绝”，令其原使用者对你使用此牌（若此牌使用者不在场，则将此牌置入弃牌堆）。' },
  ],
}

registerSkillRuntime({
  id: MOU_XIAHOU_YANYU,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const count = xiahouDiscardCount(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive && count < 2
      && owner.zones.hand.some((cardId) => state.cards[cardId]?.name === '杀')
      ? [{ id: `skill:${MOU_XIAHOU_YANYU}`, label: '燕语：弃置一张【杀】并摸一张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = playerOf(host.state, ownerId)
    if (actionId !== `skill:${MOU_XIAHOU_YANYU}` || !owner?.alive || xiahouDiscardCount(host.state, ownerId) >= 2) return
    const cards = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
    if (!cards.length) return
    host.askSkill({ skillId: MOU_XIAHOU_YANYU, ownerId, step: 'discard-slash', data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【燕语】：弃置一张【杀】并摸一张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1 }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard-slash') return
    const owner = playerOf(host.state, ownerId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.name !== '杀'
      || xiahouDiscardCount(host.state, ownerId) >= 2) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    const state = host.state as XiahouShiState
    state.b50XiahouSlashDiscard ??= {}
    state.b50XiahouSlashDiscard[ownerId] = { turnNumber: host.state.turnNumber, count: xiahouDiscardCount(host.state, ownerId) + 1 }
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: MOU_XIAHOU_YANYU }, { sourceId: ownerId, cardIds: [cardId] })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    const count = xiahouDiscardCount(host.state, ownerId)
    if (event.playerId === ownerId && event.phase === 'play' && count > 0 && playerOf(host.state, ownerId)?.alive)
      host.queueSkill({ skillId: MOU_XIAHOU_YANYU, ownerId, step: 'choose-recipient', data: { count } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-recipient' || !playerOf(host.state, ownerId)?.alive) return
    const candidates = livingOthers(host.state, ownerId)
    if (!candidates.length) return
    const count = prompt.data.count as number
    host.askSkill({ skillId: MOU_XIAHOU_YANYU, ownerId, step: 'recipient', data: { count },
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: `【燕语】：令一名其他角色摸${count * 3}张牌`, timeoutMs: 20_000, optional: true,
        candidateIds: candidates, min: 1, max: 1 }),
    })
  },
})

registerSkillRuntime({
  id: MOU_XIAHOU_QIAOSHI,
  triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
    const state = host.state as XiahouShiState
    if (state.b50XiahouQiaoshiTurn?.[ownerId] === host.state.turnNumber) return
    const sourceId = context.event.sourceId
    if (!sourceId || sourceId === ownerId || !playerOf(host.state, sourceId)?.alive) return
    const amount = (context.event.payload as { amount?: number }).amount ?? 1
    state.b50XiahouQiaoshiTurn ??= {}
    state.b50XiahouQiaoshiTurn[ownerId] = host.state.turnNumber
    host.queueSkill({ skillId: MOU_XIAHOU_QIAOSHI, ownerId, step: 'source-choice', data: { sourceId, amount } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'source-choice') return
    const sourceId = prompt.data.sourceId as PlayerId
    const source = playerOf(host.state, sourceId)
    if (!playerOf(host.state, ownerId)?.alive || !source?.alive) return
    host.askSkill({ skillId: MOU_XIAHOU_QIAOSHI, ownerId, step: 'source-choice', data: prompt.data,
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: sourceId,
        prompt: `【樵拾】：是否令${playerOf(host.state, ownerId)?.nickname ?? '夏侯氏'}回复${String(prompt.data.amount)}点体力并摸两张牌？`,
        timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '令其回复体力，你摸两张牌' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'source-choice' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    const sourceId = resolution.data.sourceId as PlayerId
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || !source?.alive) return
    const amount = Math.max(1, Math.trunc(resolution.data.amount as number))
    recover(host as never, ownerId, amount, sourceId)
    drawCards(host.state, host.rng, sourceId, 2, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const B50_MOU_XIAHOU_SHI: CharacterDefinition = {
  id: 'mou-xiahou-shi-b50', name: '谋·夏侯氏', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: MOU_XIAHOU_YANYU, name: '燕语', description: '出牌阶段限两次，你可以弃置一张【杀】并摸一张牌。出牌阶段结束时，你可以令一名其他角色摸X张牌（X为你本回合以此法弃置的【杀】的数量的三倍）。' },
    { id: MOU_XIAHOU_QIAOSHI, name: '樵拾', description: '每回合限一次，你受到其他角色造成的伤害后，伤害来源可选择令你回复等同此次伤害值的体力，若如此做，其摸两张牌。' },
  ],
}

// 界沮授【渐营】【矢北】
const JUSHOU_BASIC_NAMES = ['杀', '闪', '桃', '酒'] as const
registerSkillRuntime({
  id: JIE_JUSHOU_JIANYING,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, JIE_JUSHOU_JIANYING)) return []
    return owner.zones.hand.flatMap((cardId) => JUSHOU_BASIC_NAMES.map((asCardName) => ({
      cardId, asCardName, label: `渐营：将此牌当【${asCardName}】使用`,
    })))
  },
  interceptPlayAction(host, ownerId, action) {
    const cardId = action.cardIds[0]
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !cardId || !JUSHOU_BASIC_NAMES.includes(action.asCardName as typeof JUSHOU_BASIC_NAMES[number])
      || !owner.zones.hand.includes(cardId) || usedThisPhase(host.state, ownerId, JIE_JUSHOU_JIANYING)) return false
    const previous = (host.state as JushouState).b50JushouLast?.[ownerId]
    markUsedThisPhase(host.state, ownerId, JIE_JUSHOU_JIANYING)
    if (previous?.turnNumber === host.state.turnNumber && previous.suit)
      ((host.state as JushouState).b50JushouSuitOverride ??= {})[cardId] = previous.suit
    return false
  },
  cardSuit(state, _ownerId, cardId, printedSuit) {
    return ((state as JushouState).b50JushouSuitOverride?.[cardId] as typeof printedSuit | undefined) ?? printedSuit
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || host.state.phase !== 'play') return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId
    const physical = cardId ? host.state.cards[cardId] : undefined
    const override = cardId ? (host.state as JushouState).b50JushouSuitOverride?.[cardId] : undefined
    const previous = (host.state as JushouState).b50JushouLast?.[ownerId]
    const suit = override ?? physical?.suit ?? null
    const rank = physical?.rank ?? null
    if (previous?.turnNumber === host.state.turnNumber && previous.suit && suit === previous.suit
      || previous?.turnNumber === host.state.turnNumber && previous.rank != null && rank === previous.rank) {
      host.queueSkill({ skillId: JIE_JUSHOU_JIANYING, ownerId, step: 'draw-invoke', data: {} })
    }
    ;((host.state as JushouState).b50JushouLast ??= {})[ownerId] = { turnNumber: host.state.turnNumber, suit, rank }
  } }, { event: 'AfterCardUse', handle(host, _ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (cardId) delete (host.state as JushouState).b50JushouSuitOverride?.[cardId]
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw-invoke' || !playerOf(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: JIE_JUSHOU_JIANYING, ownerId, step: prompt.step, data: {},
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【渐营】：是否摸一张牌？',
        timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '摸一张牌' }, { id: 'no', label: '不摸' }] }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw-invoke' && (response.payload as { optionId?: string }).optionId === 'yes'
      && playerOf(host.state, ownerId)?.alive)
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: JIE_JUSHOU_SHIBEI,
  triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
    const state = host.state as JushouState
    const first = state.b50JushouDamageTurn?.[ownerId] !== host.state.turnNumber
    state.b50JushouDamageTurn ??= {}
    state.b50JushouDamageTurn[ownerId] = host.state.turnNumber
    if (first) recover(host as never, ownerId, 1, context.event.sourceId ?? undefined)
    else loseHp(host as never, ownerId, 1, JIE_JUSHOU_SHIBEI)
  } }],
})

export const B50_JIE_JUSHOU: CharacterDefinition = {
  id: 'jie-jushou-b50', name: '界·沮授', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: JIE_JUSHOU_JIANYING, name: '渐营', description: '当你于出牌阶段使用牌时，若此牌与你于此阶段使用的上一张牌花色或点数相同，则你可以摸一张牌。出牌阶段限一次，你可以将一张牌当做任意一张基本牌使用，若你于本阶段使用的上一张牌有花色，则此牌的花色视为与上一张牌的花色相同。' },
    { id: JIE_JUSHOU_SHIBEI, name: '矢北', description: '锁定技，当你受到伤害后：若此伤害是你本回合第一次受到伤害，则你回复1点体力；若不是你本回合第一次受到伤害，则你失去1点体力。' },
  ],
}

// 邹氏为国战武将：祸水在明置后约束全局明置入口；倾城暗置完整的一张武将牌。
function fullyRevealedOthers(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((player) => player.alive && player.id !== ownerId
    && Boolean(player.characterId) && player.primaryGeneralRevealed !== false
    && (!player.deputyCharacterId || player.deputyGeneralRevealed === true)).map((player) => player.id)
}

function revealSlotOptions(player: NonNullable<ReturnType<typeof playerOf>>): Array<{ id: string; label: string }> {
  return [
    { id: 'primary', label: '暗置主将' },
    ...(player.deputyCharacterId ? [{ id: 'deputy', label: '暗置副将' }] : []),
  ]
}

registerSkillRuntime({
  id: ZOUSHI_HUOSHUI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const hasZoushi = owner && revealedGeneralCharacterIdsOf(owner).includes('zoushi-b50')
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive && !hasZoushi
      ? [{ id: `skill:${ZOUSHI_HUOSHUI}`, label: '祸水：明置邹氏' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${ZOUSHI_HUOSHUI}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const slot = owner.characterId === 'zoushi-b50' ? 'primary' : owner.deputyCharacterId === 'zoushi-b50' ? 'deputy' : null
    if (slot) revealNationalWarGeneral(host.state, ownerId, slot)
  },
})

registerSkillRuntime({
  id: ZOUSHI_QINGCHENG,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const hasBlack = owner && [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .some((id) => effectiveCardColor(state, ownerId, id) === 'black')
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive && hasBlack && fullyRevealedOthers(state, ownerId).length > 0
      ? [{ id: `skill:${ZOUSHI_QINGCHENG}`, label: '倾城：弃置黑色牌并暗置武将' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${ZOUSHI_QINGCHENG}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((id) => effectiveCardColor(host.state, ownerId, id) === 'black')
    if (!cards.length) return
    host.askSkill({ skillId: ZOUSHI_QINGCHENG, ownerId, step: 'cost', data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId, prompt: '【倾城】：弃置一张黑色牌',
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1 }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const from = cardId && locateOwnedCard(host.state, ownerId, cardId)
      if (!cardId || !from || (from.kind !== 'hand' && from.kind !== 'equipment') || effectiveCardColor(host.state, ownerId, cardId) !== 'black') return
      const equipment = from.kind === 'equipment'
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (equipment) handleEquipmentLost(host as never, ownerId, cardId)
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ZOUSHI_QINGCHENG }, { sourceId: ownerId, cardIds: [cardId] })
      host.askSkill({ skillId: ZOUSHI_QINGCHENG, ownerId, step: 'target', data: { equipment },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【倾城】：选择一名武将牌均明置的其他角色',
          timeoutMs: 20_000, optional: false, candidateIds: fullyRevealedOthers(host.state, ownerId), min: 1, max: 1 }),
      })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId && playerOf(host.state, targetId)
      if (!target || !fullyRevealedOthers(host.state, ownerId).includes(targetId!)) return
      host.askSkill({ skillId: ZOUSHI_QINGCHENG, ownerId, step: 'slot', data: { targetId, equipment: resolution.data.equipment },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【倾城】：选择暗置其一张武将牌', timeoutMs: 20_000, optional: false,
          options: revealSlotOptions(target) }),
      })
      return
    }
    if (resolution.step === 'slot') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const slot = (response.payload as { optionId?: string }).optionId
      if (!target || (slot !== 'primary' && slot !== 'deputy') || (slot === 'deputy' && !target.deputyCharacterId)) return
      setGeneralRevealed(target, slot, false)
      if (resolution.data.equipment) host.queueSkill({ skillId: ZOUSHI_QINGCHENG, ownerId, step: 'second-target', data: { firstTargetId: targetId } })
      return
    }
    if (resolution.step === 'second-target') {
      const candidates = fullyRevealedOthers(host.state, ownerId).filter((id) => id !== resolution.data.firstTargetId)
      if (!candidates.length) return
      host.askSkill({ skillId: ZOUSHI_QINGCHENG, ownerId, step: 'second-choice', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【倾城】：可以选择另一名目标继续暗置', timeoutMs: 20_000,
          optional: true, candidateIds: candidates, min: 0, max: 1 }),
      })
      return
    }
    if (resolution.step === 'second-choice') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId && playerOf(host.state, targetId)
      if (!target || !fullyRevealedOthers(host.state, ownerId).includes(targetId!)) return
      host.askSkill({ skillId: ZOUSHI_QINGCHENG, ownerId, step: 'second-slot', data: { targetId },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【倾城】：选择暗置其一张武将牌', timeoutMs: 20_000, optional: false,
          options: revealSlotOptions(target) }),
      })
      return
    }
    if (resolution.step === 'second-slot') {
      const target = playerOf(host.state, resolution.data.targetId as PlayerId)
      const slot = (response.payload as { optionId?: string }).optionId
      if (target && (slot === 'primary' || slot === 'deputy') && (slot !== 'deputy' || target.deputyCharacterId)) setGeneralRevealed(target, slot, false)
    }
  },
})

export const B50_ZOUSHI: CharacterDefinition = {
  id: 'zoushi-b50', name: '邹氏', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: ZOUSHI_HUOSHUI, name: '祸水', description: '出牌阶段，你可以明置此武将牌；你的回合内，其他角色不能明置其武将牌。' },
    { id: ZOUSHI_QINGCHENG, name: '倾城', description: '出牌阶段，你可以弃置一张黑色牌并选择一名武将牌均明置的其他角色，然后你暗置其一张武将牌。然后若你以此法弃置的牌是装备牌，则你可以再选择另一名武将牌均明置的其他角色，暗置其一张武将牌。' },
  ],
}

registerSkillRuntime({
  id: MOU_HUANGZHONG_LIEGONG,
  slashNatureOverride(state, ownerId) {
    return playerOf(state, ownerId)?.zones.equipment.weapon ? null : 'normal'
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const suit = cardId ? host.state.cards[cardId]?.suit : undefined
      if (suit) {
        const state = host.state as HuangzhongState
        const suits = state.b50HuangzhongSuits?.[ownerId] ?? []
        if (!suits.includes(suit)) (state.b50HuangzhongSuits ??= {})[ownerId] = [...suits, suit]
      }
    } },
    { event: 'TargetConfirmed', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || context.event.sourceId === ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const suit = cardId ? host.state.cards[cardId]?.suit : undefined
      if (suit) {
        const state = host.state as HuangzhongState
        const suits = state.b50HuangzhongSuits?.[ownerId] ?? []
        if (!suits.includes(suit)) (state.b50HuangzhongSuits ??= {})[ownerId] = [...suits, suit]
      }
    } },
    { event: 'CardResolved', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      const state = host.state as HuangzhongState
      const pending = state.b50HuangzhongSlash?.[cardId]
      if (pending) {
        delete state.b50HuangzhongSlash![cardId]
        delete state.b50HuangzhongSuits?.[pending.ownerId]
      }
    } },
  ],
  interceptPlayAction(host, ownerId, action) {
    const owner = playerOf(host.state, ownerId)
    const cardId = action.cardIds[0]
    const card = cardId && host.state.cards[cardId]
    const suits = (host.state as HuangzhongState).b50HuangzhongSuits?.[ownerId] ?? []
    if (!owner?.alive || action.asCardName !== '杀' || action.targetIds.length !== 1 || !card || !suits.length) return false
    const x = Math.max(0, suits.length - 1)
    host.askSkill({ skillId: MOU_HUANGZHONG_LIEGONG, ownerId, step: 'invoke', data: { action, x, suits },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: `【烈弓】：是否亮出牌堆顶${x}张牌？`, timeoutMs: 20_000,
        optional: true, options: [{ id: 'yes', label: `亮出${x}张并强化此【杀】` }, { id: 'no', label: '不发动' }] }),
    })
    return true
  },
  prohibitsResponseCard(state, ownerId, responderId, responseCardId) {
    const resolution = state.cardResolution
    if (resolution?.kind !== 'slash' || resolution.sourceId !== ownerId || resolution.targetId !== responderId) return false
    const pending = (state as HuangzhongState).b50HuangzhongSlash?.[resolution.cardId]
    const suit = state.cards[responseCardId] ? effectiveCardSuit(state, responderId, responseCardId, skillIdsOf) : undefined
    return Boolean(pending && suit && pending.suits.includes(suit))
  },
  outgoingDamage(state, ownerId, context) {
    const pending = context.cardId ? (state as HuangzhongState).b50HuangzhongSlash?.[context.cardId] : undefined
    return pending?.ownerId === ownerId ? { amount: context.amount + pending.bonus } : null
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke') return
    const { action, x, suits } = resolution.data as { action: Extract<LegalAction, { kind: 'use-card' }>; x: number; suits: string[] }
    const cardId = action.cardIds[0]
    if (!cardId || !playerOf(host.state, ownerId)?.alive || !playerOf(host.state, ownerId)?.zones.hand.includes(cardId)) return
    if ((response.payload as { optionId?: string }).optionId === 'yes') {
      const revealed = revealTopCards(host.state, host.rng, x, MOU_HUANGZHONG_LIEGONG, (name, payload) => { host.dispatch(name, payload) })
      const bonus = revealed.reduce((count, id) => count + (suits.includes(host.state.cards[id]?.suit ?? '') ? 1 : 0), 0)
      for (const id of revealed) if (host.state.zones.processingArea.includes(id)) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
      const state = host.state as HuangzhongState
      state.b50HuangzhongSlash ??= {}
      state.b50HuangzhongSlash[cardId] = { ownerId, suits, bonus }
    }
    executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
  },
})

export const B50_MOU_HUANGZHONG: CharacterDefinition = {
  id: 'mou-huangzhong-b50', name: '谋·黄忠', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [{ id: MOU_HUANGZHONG_LIEGONG, name: '烈弓', description: '若你未装备武器，你的【杀】只能当作普通【杀】使用或打出。你使用牌时或成为其他角色使用牌的目标后，若此牌的花色未被“烈弓”记录，则记录此种花色。当你使用【杀】指定唯一目标后，你可以展示牌堆顶的X张牌（X为你记录的花色数-1，且至少为0），然后每有一张牌花色与“烈弓”记录的花色相同，你令此【杀】伤害+1，且其不能使用“烈弓”记录花色的牌响应此【杀】。若如此做，此【杀】结算结束后，清除“烈弓”记录的花色。' }],
}

function nonDelayedCard(cardId: CardId | undefined, cardName: string | undefined): boolean {
  if (!cardId || !cardName || DELAYED_TRICKS.has(cardName)) return false
  return true
}

function queueCaozhenActor(host: SkillHost, ownerId: PlayerId): void {
  const state = host.state as CaozhenState
  const assigned = new Set(Object.keys(state.b50CaozhenPredictions ?? {}))
  const candidates = livingOthers(host.state, ownerId).filter((id) => !assigned.has(id))
  if (candidates.length) host.queueSkill({ skillId: JIE_CAOZHEN_SIDI, ownerId, step: 'choose-actor', data: {} })
}

function resolveCaozhenMatch(host: SkillHost, ownerId: PlayerId, context: { sourceId: PlayerId; targetId: PlayerId; cardId: CardId }): boolean {
  const state = host.state as CaozhenState
  const pending = state.b50CaozhenMatchedCard?.[context.cardId]
  if (!pending || pending.ownerId !== ownerId || pending.actorId !== context.sourceId || pending.targetId !== context.targetId) return false
  delete state.b50CaozhenMatchedCard![context.cardId]
  if (context.targetId === ownerId) {
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    return false
  }
  host.askSkill({ skillId: JIE_CAOZHEN_SIDI, ownerId, step: 'matched', data: { ...pending, cardId: context.cardId },
    build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
      prompt: '【司敌】：取消此牌对目标的效果，然后无濒死角色时对其造成1点伤害；或摸两张牌',
      timeoutMs: 20_000, optional: false, options: [
        { id: 'cancel', label: '取消此目标；若无人濒死，对出牌角色造成1点伤害' },
        { id: 'draw', label: '摸两张牌' },
      ],
    }),
  })
  return true
}

registerSkillRuntime({
  id: JIE_CAOZHEN_SIDI,
  triggers: [
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string }
      if (playerOf(host.state, ownerId)?.alive && payload.cardName && !DELAYED_TRICKS.has(payload.cardName)) queueCaozhenActor(host, ownerId)
    } },
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const actorId = context.event.sourceId
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const state = host.state as CaozhenState
      const predicted = actorId && state.b50CaozhenPredictions?.[actorId]
      if (!actorId || !predicted || predicted.ownerId !== _ownerId || !nonDelayedCard(payload.cardId, payload.cardName)) return
      delete state.b50CaozhenPredictions![actorId]
      const targets = payload.targetIds ?? []
      if (targets.length === 1 && targets[0] === predicted.targetId && payload.cardId) {
        state.b50CaozhenMatchedCard ??= {}
        state.b50CaozhenMatchedCard[payload.cardId] = { ownerId: _ownerId, actorId, targetId: predicted.targetId }
      }
    } },
    { event: 'CardResolved', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (cardId) delete (host.state as CaozhenState).b50CaozhenMatchedCard?.[cardId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const state = host.state as CaozhenState
    if (!playerOf(host.state, ownerId)?.alive) return
    if (prompt.step === 'choose-actor') {
      const assigned = new Set(Object.keys(state.b50CaozhenPredictions ?? {}))
      const candidates = livingOthers(host.state, ownerId).filter((id) => !assigned.has(id))
      if (!candidates.length) return
      host.askSkill({ skillId: JIE_CAOZHEN_SIDI, ownerId, step: 'actor', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【司敌】：选择尚未指定目标的一名其他角色',
          timeoutMs: 20_000, optional: true, candidateIds: candidates, min: 1, max: 1 }),
      })
    }
  },
  interceptTarget(host, ownerId, context) { return resolveCaozhenMatch(host, ownerId, context) },
  interceptBystanderTarget(host, ownerId, context) { return resolveCaozhenMatch(host, ownerId, context) },
  resume(host, ownerId, resolution, response) {
    const state = host.state as CaozhenState
    if (resolution.step === 'actor') {
      const actorId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!actorId || !livingOthers(host.state, ownerId).includes(actorId) || state.b50CaozhenPredictions?.[actorId]) return
      const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
      host.askSkill({ skillId: JIE_CAOZHEN_SIDI, ownerId, step: 'prediction', data: { actorId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: `【司敌】：预测${playerOf(host.state, actorId)?.nickname ?? '其'}下一张非延时锦囊牌的唯一目标`,
          timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1 }),
      })
      return
    }
    if (resolution.step === 'prediction') {
      const actorId = resolution.data.actorId as PlayerId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!playerOf(host.state, actorId)?.alive || !targetId || !playerOf(host.state, targetId)?.alive) return
      ;(state.b50CaozhenPredictions ??= {})[actorId] = { ownerId, targetId }
      return
    }
    if (resolution.step === 'matched') {
      const pending = resolution.data as { cardId: CardId; actorId: PlayerId; targetId: PlayerId }
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'cancel') {
        const current = host.state.cardResolution
        if (current?.kind === 'slash' && current.cardId === pending.cardId && current.targetId === pending.targetId)
          current.targetCancelled = true
        else if (current?.kind === 'trick' && current.cardId === pending.cardId && !current.cancelledTargetIds.includes(pending.targetId))
          current.cancelledTargetIds.push(pending.targetId)
        if (!host.state.dying) resolveDamage(host as never, { sourceId: ownerId, targetId: pending.actorId, amount: 1, nature: 'normal' })
      } else if (option === 'draw') drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      host.resumeCardTarget()
    }
  },
})

export const B50_JIE_CAOZHEN: CharacterDefinition = {
  id: 'jie-caozhen-b50', name: '界·曹真', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [{ id: JIE_CAOZHEN_SIDI, name: '司敌', description: '你使用除延时锦囊以外的牌结算结束后，可以选择一名还未指定“司敌”目标的其他角色，并为其指定一名“司敌”目标角色（仅你可见）。其使用的第一张除延时锦囊以外的牌仅指定“司敌”目标为唯一目标时（否则清除你为其指定的“司敌”目标角色。），你根据以下情况执行效果：若目标为你，你摸一张牌；若目标不为你，你选择一项，1.取消之，然后若此时场上没有任何角色处于濒死状态，你对其造成1点伤害，或2.你摸两张牌。然后清除你为其指定的“司敌”目标角色。' }],
}

const SUN_ASSIST_MARK = '助'
const SUN_MAKEUP_PILE = '妆'

function sunAssistTarget(state: SanguoshaState, ownerId: PlayerId): PlayerId | null {
  const targetId = (state as SunshangxiangState).b50SunAssistTarget?.[ownerId]
  const target = targetId ? playerOf(state, targetId) : undefined
  if (!targetId || !target?.alive || markNumber(state, targetId, SUN_ASSIST_MARK) <= 0) return null
  return targetId
}

function sunMakeupCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return [...(playerOf(state, ownerId)?.characterPiles[SUN_MAKEUP_PILE] ?? [])]
}

function finishSunShangxiangMission(host: SkillHost, ownerId: PlayerId, markedTargetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const state = host.state as SunshangxiangState
  if (!owner?.alive || state.b50SunAssistTarget?.[ownerId] !== markedTargetId) return
  setMark(host.state, markedTargetId, SUN_ASSIST_MARK, Math.max(0, markNumber(host.state, markedTargetId, SUN_ASSIST_MARK) - 1))
  delete (host.state as SunshangxiangState).b50SunAssistTarget?.[ownerId]
  recover(host as never, ownerId, 1, ownerId)
  const makeup = sunMakeupCards(host.state, ownerId)
  for (const cardId of makeup) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: SUN_MAKEUP_PILE }, { kind: 'hand', playerId: ownerId })
  if (makeup.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: makeup, reason: MOU_SUNSHANGXIANG_JIEYIN }, { targetId: ownerId, cardIds: makeup })
  owner.kingdomOverride = 'wu'
  loseMaxHp(host as never, ownerId, 1, MOU_SUNSHANGXIANG_JIEYIN)
}

registerSkillRuntime({
  id: MOU_SUNSHANGXIANG_JIEYIN,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    owner.kingdomOverride = 'shu'
    host.queueSkill({ skillId: MOU_SUNSHANGXIANG_JIEYIN, ownerId, step: 'initial-mark', data: {} })
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (event.playerId === ownerId && event.phase === 'play' && sunAssistTarget(host.state, ownerId))
      host.queueSkill({ skillId: MOU_SUNSHANGXIANG_JIEYIN, ownerId, step: 'marked-choice', data: { targetId: sunAssistTarget(host.state, ownerId) } })
  } }, { event: 'Death', handle(host, ownerId, context) {
    const deadId = context.event.targetId
    if (deadId && (host.state as SunshangxiangState).b50SunAssistTarget?.[ownerId] === deadId)
      finishSunShangxiangMission(host, ownerId, deadId)
  } }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'initial-mark') {
      const candidates = livingOthers(host.state, ownerId)
      if (candidates.length) host.askSkill({ skillId: MOU_SUNSHANGXIANG_JIEYIN, ownerId, step: 'initial-mark', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【结姻】：选择一名其他角色获得“助”标记',
          timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1 }),
      })
      return
    }
    if (prompt.step === 'marked-choice') {
      const targetId = prompt.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive || markNumber(host.state, targetId, SUN_ASSIST_MARK) <= 0) return
      const firstTime = ((host.state as SunshangxiangState).b50SunReceipts?.[ownerId]?.[targetId] ?? 0) <= 1
      host.askSkill({ skillId: MOU_SUNSHANGXIANG_JIEYIN, ownerId, step: 'marked-choice', data: { targetId, firstTime },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: targetId, prompt: '【结姻】：选择一项', timeoutMs: 20_000, optional: false,
          options: [
            ...(target.zones.hand.length ? [{ id: 'give', label: `交给孙尚香${Math.min(2, target.zones.hand.length)}张手牌，然后获得1点护甲` }] : []),
            { id: 'mark', label: firstTime ? '令孙尚香移动或移除“助”标记' : '令孙尚香移除“助”标记' },
          ],
        }),
      })
      return
    }
    if (prompt.step === 'ask-recipient-reward') {
      const targetId = prompt.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      host.askSkill({ skillId: MOU_SUNSHANGXIANG_JIEYIN, ownerId, step: 'recipient-reward', data: prompt.data,
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: targetId, prompt: '【结姻】：选择一项', timeoutMs: 20_000, optional: false,
          options: [{ id: 'move', label: '令孙尚香移动“助”标记' }, { id: 'remove', label: '移除“助”标记' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'initial-mark') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !livingOthers(host.state, ownerId).includes(targetId)) return
      setMark(host.state, targetId, SUN_ASSIST_MARK, markNumber(host.state, targetId, SUN_ASSIST_MARK) + 1)
      ;((host.state as SunshangxiangState).b50SunAssistTarget ??= {})[ownerId] = targetId
      const receipts = ((host.state as SunshangxiangState).b50SunReceipts ??= {})[ownerId] ??= {}
      receipts[targetId] = (receipts[targetId] ?? 0) + 1
      return
    }
    if (resolution.step === 'marked-choice') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const option = (response.payload as { optionId?: string }).optionId
      if (!target?.alive || sunAssistTarget(host.state, ownerId) !== targetId) return
      if (option === 'give' && target.zones.hand.length) {
        const count = Math.min(2, target.zones.hand.length)
        host.askSkill({ skillId: MOU_SUNSHANGXIANG_JIEYIN, ownerId, step: 'give-cards', data: { targetId, count },
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId, prompt: `【结姻】：交给孙尚香${count}张手牌`,
            timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: count, max: count }),
        })
      } else if (option === 'mark') {
        if (resolution.data.firstTime) host.queueSkill({ skillId: MOU_SUNSHANGXIANG_JIEYIN, ownerId, step: 'choose-mark-fate', data: { targetId } })
        else finishSunShangxiangMission(host, ownerId, targetId)
      }
      return
    }
    if (resolution.step === 'give-cards') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const count = resolution.data.count as number
      const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => target?.zones.hand.includes(id)).slice(0, count)
      if (!target?.alive || cardIds.length !== count || sunAssistTarget(host.state, ownerId) !== targetId) return
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds, reason: MOU_SUNSHANGXIANG_JIEYIN }, { sourceId: targetId, targetId: ownerId, cardIds })
      host.dispatch('CardGiven', { fromId: targetId, toId: ownerId, cardIds, reason: MOU_SUNSHANGXIANG_JIEYIN }, { sourceId: targetId, targetId: ownerId, cardIds })
      host.dispatch('GainCard', { playerId: ownerId, cardIds, reason: MOU_SUNSHANGXIANG_JIEYIN }, { sourceId: targetId, targetId: ownerId, cardIds })
      gainArmor(host as never, targetId, 1, MOU_SUNSHANGXIANG_JIEYIN)
      return
    }
    if (resolution.step === 'choose-mark-fate') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive || sunAssistTarget(host.state, ownerId) !== targetId
        || ((host.state as SunshangxiangState).b50SunReceipts?.[ownerId]?.[targetId] ?? 0) > 1) return
      const candidates = livingOthers(host.state, ownerId).filter((id) => id !== targetId)
      if (!candidates.length) return finishSunShangxiangMission(host, ownerId, targetId)
      host.askSkill({ skillId: MOU_SUNSHANGXIANG_JIEYIN, ownerId, step: 'move-mark', data: { targetId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【结姻】：选择新的“助”标记角色；取消则移除标记',
          timeoutMs: 20_000, optional: true, candidateIds: candidates, min: 0, max: 1 }),
      })
      return
    }
    if (resolution.step === 'move-mark') {
      const oldId = resolution.data.targetId as PlayerId
      const newId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (sunAssistTarget(host.state, ownerId) !== oldId) return
      if (!newId) return finishSunShangxiangMission(host, ownerId, oldId)
      if (!livingOthers(host.state, ownerId).includes(newId) || newId === oldId) return
      setMark(host.state, oldId, SUN_ASSIST_MARK, Math.max(0, markNumber(host.state, oldId, SUN_ASSIST_MARK) - 1))
      setMark(host.state, newId, SUN_ASSIST_MARK, markNumber(host.state, newId, SUN_ASSIST_MARK) + 1)
      ;((host.state as SunshangxiangState).b50SunAssistTarget ??= {})[ownerId] = newId
      const receipts = ((host.state as SunshangxiangState).b50SunReceipts ??= {})[ownerId] ??= {}
      receipts[newId] = (receipts[newId] ?? 0) + 1
      return
    }
  },
})

registerSkillRuntime({
  id: MOU_SUNSHANGXIANG_LIANGZHU,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && effectiveKingdomOf(state, ownerId) === 'shu' && !usedThisPhase(state, ownerId, MOU_SUNSHANGXIANG_LIANGZHU)
      && sunAssistTarget(state, ownerId) !== null
      && state.players.some((target) => target.alive && target.id !== ownerId && Object.values(target.zones.equipment).some(Boolean))
      ? [{ id: `skill:${MOU_SUNSHANGXIANG_LIANGZHU}`, label: '良助：将一名角色装备区的牌置于“妆”' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MOU_SUNSHANGXIANG_LIANGZHU}` || usedThisPhase(host.state, ownerId, MOU_SUNSHANGXIANG_LIANGZHU)) return
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId && Object.values(target.zones.equipment).some(Boolean)).map((target) => target.id)
    if (!candidates.length || !sunAssistTarget(host.state, ownerId)) return
    markUsedThisPhase(host.state, ownerId, MOU_SUNSHANGXIANG_LIANGZHU)
    host.askSkill({ skillId: MOU_SUNSHANGXIANG_LIANGZHU, ownerId, step: 'equipment-owner', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【良助】：选择一名有装备的其他角色', timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1 }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'equipment-owner') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const equipment = target ? Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)) : []
      if (!target?.alive || !equipment?.length || target.id === ownerId) return
      host.askSkill({ skillId: MOU_SUNSHANGXIANG_LIANGZHU, ownerId, step: 'equipment-card', data: { targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId, prompt: `【良助】：选择${target.nickname}装备区一张牌置于“妆”`,
          timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: equipment, hiddenCardSlots: [], min: 1, max: 1 }),
      })
      return
    }
    if (resolution.step === 'equipment-card') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const from = cardId ? locateOwnedCard(host.state, targetId, cardId) : null
      const slot = from?.kind === 'equipment' ? from.slot : null
      const assistId = sunAssistTarget(host.state, ownerId)
      if (!target?.alive || !cardId || !slot || !assistId || !Object.values(target.zones.equipment).includes(cardId)) return
      moveCard(host.state, cardId, from!, { kind: 'characterPile', playerId: ownerId, pile: SUN_MAKEUP_PILE })
      handleEquipmentLost(host as never, targetId, cardId)
      host.dispatch('CardMove', { cardIds: [cardId], reason: MOU_SUNSHANGXIANG_LIANGZHU, from: 'equipment', to: 'characterPile' }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.queueSkill({ skillId: MOU_SUNSHANGXIANG_LIANGZHU, ownerId, step: 'assist-reward', data: { assistId } })
      return
    }
    if (resolution.step === 'assist-reward') {
      const assistId = resolution.data.assistId as PlayerId
      if (sunAssistTarget(host.state, ownerId) !== assistId || !playerOf(host.state, assistId)?.alive) return
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'recover') recover(host as never, assistId, 1, ownerId)
      else if (option === 'draw') drawCards(host.state, host.rng, assistId, 2, (name, payload) => { host.dispatch(name, payload) })
    }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'assist-reward') return
    const assistId = prompt.data.assistId as PlayerId
    const assist = playerOf(host.state, assistId)
    if (!assist?.alive || !sunAssistTarget(host.state, ownerId)) return
    host.askSkill({ skillId: MOU_SUNSHANGXIANG_LIANGZHU, ownerId, step: 'assist-reward', data: { assistId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: assistId, prompt: '【良助】：选择一项', timeoutMs: 20_000, optional: false,
        options: [{ id: 'recover', label: '回复1点体力' }, { id: 'draw', label: '摸两张牌' }] }),
    })
  },
})

registerSkillRuntime({
  id: MOU_SUNSHANGXIANG_XIAOJI,
  triggers: [{ event: 'LoseEquipment', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !playerOf(host.state, ownerId)?.alive || effectiveKingdomOf(host.state, ownerId) !== 'wu') return
    host.queueSkill({ skillId: MOU_SUNSHANGXIANG_XIAOJI, ownerId, step: 'draw-and-discard', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw-and-discard' || !playerOf(host.state, ownerId)?.alive) return
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
    const all = host.state.players.filter((player) => player.alive).map((player) => ({ player,
      pickable: pickableCardsOf(host.state, player.id, { includeJudgingArea: true }),
    }))
    const cardIds = all.flatMap(({ pickable }) => pickable.cardIds)
    const hiddenCardSlots = all.flatMap(({ pickable }) => pickable.hiddenCardSlots)
    if (!cardIds.length && !hiddenCardSlots.length) return
    host.askSkill({ skillId: MOU_SUNSHANGXIANG_XIAOJI, ownerId, step: 'discard-field', data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId, prompt: '【枭姬】：可以弃置场上一张牌',
        timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots, min: 0, max: 1 }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard-field') return
    const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    if (!picked) return
    for (const target of host.state.players) {
      const cardId = resolvePickedCard(host.state, target.id, picked)
      if (!cardId) continue
      if (movePickedCard(host as never, target.id, cardId, { kind: 'discardPile' }))
        host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: MOU_SUNSHANGXIANG_XIAOJI }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
      return
    }
  },
})

export const B50_MOU_SUNSHANGXIANG: CharacterDefinition = {
  id: 'mou-sunshangxiang-b50', name: '谋·孙尚香', kingdom: 'shu', gender: 'female', maxHp: 4, pack: 'sp',
  skills: [
    { id: MOU_SUNSHANGXIANG_JIEYIN, name: '结姻', description: '使命技，你的登场势力为“蜀”。游戏开始时，你选择一名其他角色，令其获得“助”标记。出牌阶段开始时，有“助”标记的角色选择一项：1.若其有手牌，交给你两张手牌（若其手牌不足两张则交给你所有手牌），然后其获得一点“护甲”；2.令你移动或移除助标记（若其不是第一次获得“助”标记，则你只能移除“助”标记。）失败：当“助”标记被移除时，你回复1点体力并获得你武将牌上所有“妆”牌，移除“助”标记，你将势力修改为“吴”，减1点体力上限。' },
    { id: MOU_SUNSHANGXIANG_LIANGZHU, name: '良助', description: '蜀势力技，出牌阶段限一次，你可以将其他角色装备区内的一张牌置于你的武将牌上，称为“妆”，然后令拥有“助”标记的角色选择一项：1.回复1点体力值；2.摸两张牌。' },
    { id: MOU_SUNSHANGXIANG_XIAOJI, name: '枭姬', description: '吴势力技，当你失去装备区内的一张牌时，你摸两张牌，然后可以弃置场上的一张牌。' },
  ],
}

const ZHAOYUN_CHARGES = '龙胆·次数'
const BASIC_NAMES = ['杀', '闪', '桃', '酒'] as const

function zhaoyunCharges(state: SanguoshaState, ownerId: PlayerId): number {
  const recorded = (state as ZhaoyunState).b50ZhaoyunCharges?.[ownerId]
  return Math.max(0, Math.min(3, recorded ?? (markNumber(state, ownerId, ZHAOYUN_CHARGES) || 1)))
}

function consumeZhaoyunCharge(host: SkillHost, ownerId: PlayerId): void {
  const charges = Math.max(0, zhaoyunCharges(host.state, ownerId) - 1)
  ;((host.state as ZhaoyunState).b50ZhaoyunCharges ??= {})[ownerId] = charges
  setMark(host.state, ownerId, ZHAOYUN_CHARGES, charges)
  drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
}

function zhaoyunViewAs(state: SanguoshaState, ownerId: PlayerId): ViewAsOption[] {
  if (!playerOf(state, ownerId)?.alive || zhaoyunCharges(state, ownerId) <= 0) return []
  const upgraded = (state as ZhaoyunState).b50ZhaoyunUpgrade?.[ownerId] === true
  return (playerOf(state, ownerId)?.zones.hand ?? []).flatMap((cardId) => {
    const card = state.cards[cardId]
    if (!card || (upgraded ? card.category !== 'basic' : card.name !== '杀' && card.name !== '闪')) return []
    const names = upgraded ? BASIC_NAMES : card.name === '杀' ? ['闪'] as const : ['杀'] as const
    return names.filter((name) => name !== card.name).map((asCardName) => ({
      cardId, asCardName, label: `龙胆：将【${card.name}】当【${asCardName}】使用或打出`,
    }))
  })
}

function zhaoyunCanConvert(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, asCardName: string): boolean {
  if (zhaoyunCharges(state, ownerId) <= 0) return false
  const card = state.cards[cardId]
  if (!card) return false
  const upgraded = (state as ZhaoyunState).b50ZhaoyunUpgrade?.[ownerId] === true
  if (!BASIC_NAMES.includes(asCardName as typeof BASIC_NAMES[number]) || card.name === asCardName) return false
  if (upgraded) return card.category === 'basic'
  return (card.name === '杀' && asCardName === '闪') || (card.name === '闪' && asCardName === '杀')
}

function cooperationSucceeded(entry: NonNullable<ZhaoyunState['b50ZhaoyunCooperation']>[PlayerId]): boolean {
  if (entry.mode === 'damage') return entry.damage >= 4
  if (entry.mode === 'draw') return entry.draw >= 8
  if (entry.mode === 'discard') return entry.discardSuits.length >= 4
  return entry.useSuits.length >= 4
}

registerSkillRuntime({
  id: MOU_ZHAOYUN_LONGDAN,
  onGameStart(host, ownerId) {
    setMark(host.state, ownerId, ZHAOYUN_CHARGES, 1)
    ;((host.state as ZhaoyunState).b50ZhaoyunCharges ??= {})[ownerId] = 1
    ;((host.state as ZhaoyunState).b50ZhaoyunUpgrade ??= {})[ownerId] = false
  },
  viewAs: zhaoyunViewAs,
  interceptPlayAction(host, ownerId, action) {
    const cardId = action.cardIds[0]
    const converted = zhaoyunViewAs(host.state, ownerId).some((option) => option.cardId === cardId && option.asCardName === action.asCardName)
    if (!converted || !cardId) return false
    ;((host.state as ZhaoyunState).b50ZhaoyunConverted ??= {})[cardId] = ownerId
    return false
  },
  triggers: [
    { event: 'TurnEnd', handle(host, ownerId) {
      if (!playerOf(host.state, ownerId)?.alive) return
      const charges = Math.min(3, zhaoyunCharges(host.state, ownerId) + 1)
      ;((host.state as ZhaoyunState).b50ZhaoyunCharges ??= {})[ownerId] = charges
      setMark(host.state, ownerId, ZHAOYUN_CHARGES, charges)
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const { cardId, cardName } = context.event.payload as { cardId?: CardId; cardName?: string }
      if (!cardId || (host.state as ZhaoyunState).b50ZhaoyunConverted?.[cardId] !== ownerId) return
      delete (host.state as ZhaoyunState).b50ZhaoyunConverted![cardId]
      if (cardName && zhaoyunCanConvert(host.state, ownerId, cardId, cardName)) consumeZhaoyunCharge(host, ownerId)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId | null; cardName?: string; asking?: boolean }
      const cardId = payload.cardId
      if ((payload.playerId ?? context.event.sourceId) !== ownerId || !cardId || !payload.cardName || payload.asking === true) return
      const card = host.state.cards[cardId]
      if (!card || !zhaoyunCanConvert(host.state, ownerId, cardId, payload.cardName)) return
      consumeZhaoyunCharge(host, ownerId)
    } },
  ],
})

registerSkillRuntime({
  id: MOU_ZHAOYUN_JIZHU,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (event.playerId === ownerId && event.phase === 'prepare' && playerOf(host.state, ownerId)?.alive)
        host.queueSkill({ skillId: MOU_ZHAOYUN_JIZHU, ownerId, step: 'choose-partner', data: {} })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const entry = (host.state as ZhaoyunState).b50ZhaoyunCooperation?.[ownerId]
      const amount = Math.max(0, Math.trunc((context.event.payload as { finalAmount?: number }).finalAmount ?? 0))
      if (entry && amount > 0 && (context.event.sourceId === ownerId || context.event.sourceId === entry.targetId)) entry.damage += amount
    } },
    { event: 'GainCard', handle(host, ownerId, context) {
      const entry = (host.state as ZhaoyunState).b50ZhaoyunCooperation?.[ownerId]
      const payload = context.event.payload as { playerId?: PlayerId; reason?: string; cardIds?: CardId[] }
      if (entry && (payload.playerId === ownerId || payload.playerId === entry.targetId) && payload.reason === 'draw') entry.draw += payload.cardIds?.length ?? 0
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const entry = (host.state as ZhaoyunState).b50ZhaoyunCooperation?.[ownerId]
      const payload = context.event.payload as { cardIds?: CardId[]; playerId?: PlayerId }
      if (!entry || (payload.playerId !== ownerId && payload.playerId !== entry.targetId)) return
      for (const cardId of payload.cardIds ?? []) {
        const provenance = host.state.discardProvenance?.[cardId]
        if (!host.state.zones.discardPile.includes(cardId) || provenance?.reason !== 'discard'
          || (provenance.ownerId !== ownerId && provenance.ownerId !== entry.targetId)) continue
        const suit = host.state.cards[cardId]?.suit
        if (suit && !entry.discardSuits.includes(suit)) entry.discardSuits.push(suit)
      }
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const entry = (host.state as ZhaoyunState).b50ZhaoyunCooperation?.[ownerId]
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      if (!entry || (sourceId !== ownerId && sourceId !== entry.targetId)) return
      for (const cardId of payload.cardIds ?? (payload.cardId ? [payload.cardId] : [])) {
        const suit = host.state.cards[cardId]?.suit
        if (suit && !entry.useSuits.includes(suit)) entry.useSuits.push(suit)
      }
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const entry = (host.state as ZhaoyunState).b50ZhaoyunCooperation?.[ownerId]
      const sourceId = context.event.sourceId
      const cardId = (context.event.payload as { cardId?: CardId | null }).cardId
      if (!entry || !cardId || (sourceId !== ownerId && sourceId !== entry.targetId)
        || (context.event.payload as { asking?: boolean }).asking === true) return
      const suit = host.state.cards[cardId]?.suit
      if (suit && !entry.useSuits.includes(suit)) entry.useSuits.push(suit)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const state = host.state as ZhaoyunState
      const entry = state.b50ZhaoyunCooperation?.[ownerId]
      const endedPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!entry || endedPlayerId !== entry.targetId) return
      if (playerOf(host.state, ownerId)?.alive && cooperationSucceeded(entry))
        (state.b50ZhaoyunUpgrade ??= {})[ownerId] = true
      delete state.b50ZhaoyunCooperation![ownerId]
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const state = host.state as ZhaoyunState
      if (state.b50ZhaoyunCooperation?.[ownerId]?.targetId === context.event.targetId)
        delete state.b50ZhaoyunCooperation![ownerId]
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (event.playerId === ownerId && event.phase === 'finish')
        (host.state as ZhaoyunState).b50ZhaoyunUpgrade![ownerId] = false
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'choose-partner') {
      const candidates = livingOthers(host.state, ownerId)
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_ZHAOYUN_JIZHU, ownerId, step: 'partner', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【积著】：选择一名其他角色进行协力',
          timeoutMs: 20_000, optional: true, candidateIds: candidates, min: 1, max: 1 }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'partner') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !livingOthers(host.state, ownerId).includes(targetId)) return
      host.askSkill({ skillId: MOU_ZHAOYUN_JIZHU, ownerId, step: 'choose-mode', data: { targetId },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【积著】：选择一项协力条件', timeoutMs: 20_000, optional: false,
          options: [
            { id: 'damage', label: '同仇：你们共计造成至少4点伤害' },
            { id: 'draw', label: '并进：你们共计摸至少8张牌' },
            { id: 'discard', label: '疏财：你们弃置的牌包含四种花色' },
            { id: 'use', label: '勠力：你们使用或打出的牌包含四种花色' },
          ],
        }),
      })
      return
    }
    if (resolution.step !== 'choose-mode') return
    const targetId = resolution.data.targetId as PlayerId
    const mode = (response.payload as { optionId?: string }).optionId
    if (!playerOf(host.state, targetId)?.alive || !['damage', 'draw', 'discard', 'use'].includes(mode ?? '')) return
    ;((host.state as ZhaoyunState).b50ZhaoyunCooperation ??= {})[ownerId] = {
      targetId, mode: mode as 'damage' | 'draw' | 'discard' | 'use', damage: 0, draw: 0, discardSuits: [], useSuits: [],
    }
  },
})

export const B50_MOU_ZHAOYUN: CharacterDefinition = {
  id: 'mou-zhaoyun-b50', name: '谋·赵云', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: MOU_ZHAOYUN_LONGDAN, name: '龙胆', description: '剩余可用X次（X初始为1且最大为3，每名角色的回合结束后X加1)，你可以将一张【杀】当【闪】、【闪】当普通【杀】使用或打出，若如此做，你摸一张牌。积著协力成功后，直到你的下个结束阶段，修改为可以将一张基本牌当任意基本牌使用或打出。' },
    { id: MOU_ZHAOYUN_JIZHU, name: '积著', description: '准备阶段，你可以选择一名其他角色，与其进行“协力”。其回合结束后，若你与其“协力”成功，则直到你的下个结束阶段，你修改龙胆为“剩余可用X次（X初始为1且最大为3，每名角色的回合结束后X加一），你可以将一张基本牌当做任意基本牌使用或打出，若如此做，你摸一张牌”。' },
  ],
}

export const HISTORICAL_BATCH50_CHARACTERS: readonly CharacterDefinition[] = [
  B50_ZOUSHI, B50_JIE_CAOZHEN, B50_JIE_QUANZONG, B50_MOU_YANGWAN, B50_MOU_SUNSHANGXIANG, B50_MOU_ZHAOYUN, B50_FUQIAN, B50_MOU_XIAHOU_SHI, B50_JIE_JUSHOU, B50_MOU_HUANGZHONG,
]

