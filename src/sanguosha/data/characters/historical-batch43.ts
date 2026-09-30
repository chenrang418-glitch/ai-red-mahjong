import { registerPindianContinuation, canPindian, startPindian } from '../../engine/pindian'
import { usedThisPhase, markUsedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { effectiveCardName, locateOwnedCard, moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { flipCharacter } from '../../engine/character-state'
import { recover } from '../../engine/recover'
import { useVirtualWine, applyWineEffect, canUseWineThisTurn } from '../../engine/virtual-wine'
import { isCardUseProhibited } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

const B45 = '-b45'
const XIANZHEN = `xianzhen${B45}`
const JINJIU = `jinjiu${B45}`
const XIANZHEN_ACTION = `${XIANZHEN}:invoke`
const XIANZHEN_PINDIAN = `${XIANZHEN}:pindian`
const FAILED_MARK = `${XIANZHEN}:failed`
const XIANZHEN_CONTINUATION = XIANZHEN_PINDIAN
const JIANGCHI = `jiangchi${B45}`
const JIE_JIUSHI = `jiushi${B45}`
const CHENGZHANG = `chengzhang${B45}`
const CHENGZHAO = `chengzhao${B45}`
const JIUSHI_LEVEL = `${JIE_JIUSHI}:level`
const CHENGZHANG_DAMAGE = `${CHENGZHANG}:damage`
const LUOYING = 'luoying'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function targetsForPindian(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  if (!canPindian(state, ownerId)) return []
  return state.players.filter((target) => target.alive && target.id !== ownerId && canPindian(state, target.id)).map((target) => target.id)
}

function wonAgainst(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean {
  return usedThisPhase(state, ownerId, `${XIANZHEN}:won:${targetId}`)
}

registerSkillRuntime({
  id: XIANZHEN,
  announcesSelf: true,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, XIANZHEN)) return []
    return targetsForPindian(state, ownerId).length ? [{ id: XIANZHEN_ACTION, label: '陷阵：与一名角色拼点' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== XIANZHEN_ACTION) return
    const candidateIds = targetsForPindian(host.state, ownerId)
    if (!candidateIds.length) return
    host.askSkill({ skillId: XIANZHEN, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【陷阵】：选择一名角色与其拼点',
      timeoutMs: 25_000, optional: false, candidateIds, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !targetsForPindian(host.state, ownerId).includes(targetId)) return
    markUsedThisPhase(host.state, ownerId, XIANZHEN)
    startPindian(host, { id: `${XIANZHEN}:${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
      reason: XIANZHEN, continuationTag: XIANZHEN_CONTINUATION })
  },
  ignoresDistanceTo(state, ownerId, targetId) { return wonAgainst(state, ownerId, targetId) },
  ignoresSlashUsesTo(state, ownerId, targetId) { return wonAgainst(state, ownerId, targetId) },
  ignoresArmorFor(state, ownerId, targetId) { return wonAgainst(state, ownerId, targetId) },
  prohibitsCardUse(state, ownerId, context) {
    return context.userId === ownerId && context.cardName === '杀' && usedThisPhase(state, ownerId, FAILED_MARK)
  },
  handLimitExempt(state, ownerId, cardId) {
    return playerOf(state, ownerId)?.marks[`${XIANZHEN}:slash-exempt-turn`] === state.turnNumber
      && effectiveCardName(state, cardId) === '杀'
  },
})

registerSkillRuntime({
  id: JIANGCHI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    if (payload.playerId !== ownerId || payload.phase !== 'play' || !owner?.alive) return
    const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (!cards.length) return
    host.askSkill({ skillId: JIANGCHI, ownerId, step: 'choice', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【将驰】：选择一项', timeoutMs: 20_000,
      optional: true, options: [{ id: 'draw', label: '摸一张牌，本阶段不能使用【杀】' }, { id: 'discard', label: '弃置一张牌，本阶段使用【杀】无距离限制且次数+1' }],
    }) })
  } }],
  prohibitsCardUse(state, ownerId, context) {
    return context.userId === ownerId && context.cardName === '杀' && usedThisPhase(state, ownerId, `${JIANGCHI}:no-slash`)
  },
  slashIgnoresDistance(state, ownerId) { return usedThisPhase(state, ownerId, `${JIANGCHI}:slash-bonus`) },
  globalSlashUses(state, ownerId) { return usedThisPhase(state, ownerId, `${JIANGCHI}:slash-bonus`) ? 1 : 0 },
  resume(host, ownerId, resolution, response) {
    const option = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'choice') {
      if (option === 'draw') {
        markUsedThisPhase(host.state, ownerId, `${JIANGCHI}:no-slash`)
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      } else if (option === 'discard') {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
        if (!cardIds.length) return
        host.askSkill({ skillId: JIANGCHI, ownerId, step: 'cost', build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【将驰】：弃置一张牌', timeoutMs: 20_000,
          optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step !== 'cost') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const from = cardId ? locateOwnedCard(host.state, ownerId, cardId) : null
    if (!cardId || !from || (from.kind !== 'hand' && from.kind !== 'equipment')) return
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') handleEquipmentLost(host, ownerId, cardId)
    else host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIANGCHI }, { sourceId: ownerId, cardIds: [cardId] })
    markUsedThisPhase(host.state, ownerId, `${JIANGCHI}:slash-bonus`)
  },
})

function gainRandomTrick(host: SkillHost, ownerId: PlayerId, reason: string): boolean {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return false
  const candidates = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.category === 'trick')
  if (!candidates.length) return false
  const cardId = host.rng.pick(candidates)
  const index = host.state.zones.drawPile.indexOf(cardId)
  if (index < 0) return false
  host.state.zones.drawPile.splice(index, 1)
  owner.zones.hand.push(cardId)
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason }, { targetId: ownerId, cardIds: [cardId] })
  return true
}

function canUseJieJiushi(state: SanguoshaState, ownerId: PlayerId, dyingPlayerId: PlayerId | null = null): boolean {
  const owner = playerOf(state, ownerId)
  return Boolean(owner?.alive && !owner.faceDown && !isCardUseProhibited(state, ownerId, '酒', { dyingPlayerId }))
}

registerSkillRuntime({
  id: JIE_JIUSHI,
  activeActionUsesCard: true,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !canUseJieJiushi(state, ownerId) || !canUseWineThisTurn({ state } as SkillHost)) return []
    return [{ id: JIE_JIUSHI, label: '酒诗：翻面视为使用【酒】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIE_JIUSHI || !canUseJieJiushi(host.state, ownerId) || !canUseWineThisTurn(host)) return
    if (!useVirtualWine(host, ownerId, JIE_JIUSHI)) return
    flipCharacter(host, ownerId, JIE_JIUSHI, true)
    applyWineEffect(host)
  },
  rescueActions(state, ownerId, dyingPlayerId) {
    if (ownerId !== dyingPlayerId || !canUseJieJiushi(state, ownerId, dyingPlayerId)) return []
    return [{ id: `${JIE_JIUSHI}:rescue`, label: '酒诗：翻面视为使用【酒】自救' }]
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== `${JIE_JIUSHI}:rescue` || ownerId !== dyingPlayerId || !canUseJieJiushi(host.state, ownerId, dyingPlayerId)) return false
    if (!useVirtualWine(host, ownerId, JIE_JIUSHI)) return false
    flipCharacter(host, ownerId, JIE_JIUSHI, true)
    recover(host as never, ownerId, 1, ownerId)
    return true
  },
  triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    const owner = playerOf(host.state, ownerId)
    if (owner?.alive && owner.faceDown) host.queueSkill({ skillId: JIE_JIUSHI, ownerId, step: 'restore', data: {} })
  } }, {
    event: 'CharacterFlip', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId || (playerOf(host.state, ownerId)?.marks[JIUSHI_LEVEL] ?? 1) < 2) return
      gainRandomTrick(host, ownerId, JIE_JIUSHI)
    } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'restore' || !playerOf(host.state, ownerId)?.faceDown) return
    host.askSkill({ skillId: JIE_JIUSHI, ownerId, step: 'restore-choice', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【酒诗】：是否将武将牌翻回正面？', timeoutMs: 20_000,
      optional: true, options: [{ id: 'yes', label: '翻回正面' }, { id: 'no', label: '保持背面朝上' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'restore-choice' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    flipCharacter(host, ownerId, JIE_JIUSHI, false)
    if ((playerOf(host.state, ownerId)?.marks[JIUSHI_LEVEL] ?? 1) === 1) gainRandomTrick(host, ownerId, JIE_JIUSHI)
  },
})

registerSkillRuntime({
  id: CHENGZHANG,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) { return (playerOf(state, ownerId)?.marks[CHENGZHANG_DAMAGE] ?? 0) >= 7 },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      recover(host as never, ownerId, 1, ownerId)
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      owner.marks[JIUSHI_LEVEL] = 2
      host.dispatch('SkillActivated', { skillId: CHENGZHANG, skillName: '成章', playerId: ownerId,
        logText: `${owner.nickname}觉醒【成章】，升级【酒诗】` }, { sourceId: ownerId })
    },
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const amount = Number((context.event.payload as { finalAmount?: unknown }).finalAmount ?? 0)
    if (amount <= 0) return
    const source = context.event.sourceId === ownerId ? amount : 0
    const target = context.event.targetId === ownerId ? amount : 0
    const owner = playerOf(host.state, ownerId)
    if (owner) owner.marks[CHENGZHANG_DAMAGE] = (owner.marks[CHENGZHANG_DAMAGE] ?? 0) + source + target
  } }],
})

function chengzhaoTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  if (!canPindian(state, ownerId)) return []
  return state.players.filter((target) => target.alive && target.id !== ownerId && canPindian(state, target.id)).map((target) => target.id)
}

registerSkillRuntime({
  id: CHENGZHAO,
  triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (payload.playerId !== ownerId || !payload.cardIds?.length) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (owner.marks[`${CHENGZHAO}:turn`] !== host.state.turnNumber) {
      owner.marks[`${CHENGZHAO}:turn`] = host.state.turnNumber
      owner.marks[`${CHENGZHAO}:gained`] = 0
    }
    owner.marks[`${CHENGZHAO}:gained`] = (owner.marks[`${CHENGZHAO}:gained`] ?? 0) + payload.cardIds.length
  } }, {
    event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string }
      const owner = playerOf(host.state, ownerId)
      if (payload.phase !== 'finish' || !owner?.alive
        || owner.marks[`${CHENGZHAO}:turn`] !== host.state.turnNumber
        || (owner.marks[`${CHENGZHAO}:gained`] ?? 0) < 2) return
      const candidateIds = chengzhaoTargets(host.state, ownerId)
      if (!candidateIds.length) return
      host.askSkill({ skillId: CHENGZHAO, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【承诏】：选择一名角色与其拼点；若赢，视为对其使用无视防具的普通【杀】',
        timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }) })
    } }],
  ignoresArmorFor(state, ownerId, targetId) {
    return state.cardResolution?.kind === 'slash'
      && state.cardResolution.sourceId === ownerId
      && state.cardResolution.targetId === targetId
      && state.cards[state.cardResolution.cardId]?.sourceSkillId === CHENGZHAO
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !chengzhaoTargets(host.state, ownerId).includes(targetId)) return
    startPindian(host, { id: `${CHENGZHAO}:${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
      reason: CHENGZHAO, continuationTag: CHENGZHAO, data: {} })
  },
})

registerPindianContinuation(CHENGZHAO, (host, result) => {
  if (result.outcome !== 'initiator-win') return
  const actor = playerOf(host.state, result.initiatorId)
  if (!actor?.alive || !playerOf(host.state, result.opponentId)?.alive) return
  ;(host as unknown as SkillHost).beginVirtualSlash({
    sourceId: result.initiatorId, targetId: result.opponentId, sourceSkillId: CHENGZHAO,
  })
})

registerPindianContinuation(XIANZHEN_CONTINUATION, (host, result) => {
  const state = host.state
  const actor = playerOf(state, result.initiatorId)
  if (!actor?.alive) return
  if (result.outcome === 'initiator-win') {
    markUsedThisPhase(state, result.initiatorId, `${XIANZHEN}:won:${result.opponentId}`)
    ;(host as unknown as SkillHost).dispatch('SkillActivated', {
      skillId: XIANZHEN, skillName: '陷阵', playerId: result.initiatorId, targetId: result.opponentId,
      logText: `${actor.nickname}拼点赢了，本出牌阶段对该角色无距离限制、无视其防具且出杀不计次数`,
    }, { sourceId: result.initiatorId, targetId: result.opponentId })
  } else {
    markUsedThisPhase(state, result.initiatorId, FAILED_MARK)
  }
  const usedSlash = effectiveCardName(state, result.initiatorCardId) === '杀'
  if (usedSlash) actor.marks[`${XIANZHEN}:slash-exempt-turn`] = state.turnNumber
})

registerSkillRuntime({
  id: JINJIU,
  forcedCardIdentity(state, _ownerId, cardId) {
    return state.cards[cardId]?.name === '酒' ? { asCardName: '杀', nature: 'normal' } : null
  },
  prohibitsCardUse(state, ownerId, context) {
    return state.currentPlayerId === ownerId && context.userId !== ownerId && context.cardName === '酒'
  },
  incomingDamage(state, _ownerId, context) {
    if (!context.cardId || !state.wineBoostedSlashCardIds?.includes(context.cardId)) return null
    return { amount: Math.max(0, context.amount - 1) }
  },
})

export const HISTORICAL_BATCH43_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'jie-gaoshun-b45', name: '界·高顺', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'wind', skills: [
    { id: XIANZHEN, name: '陷阵', description: '出牌阶段限一次，你可以与一名角色拼点：若你赢，此出牌阶段你无视该角色的防具，对其使用牌没有距离和次数限制；若你没赢，此出牌阶段你不能使用【杀】。若你发动“陷阵”拼点的牌为【杀】，则本回合你的【杀】不计入手牌上限。' },
    { id: JINJIU, name: '禁酒', description: '锁定技，你的【酒】均视为普通【杀】；当你受到【酒】【杀】造成的伤害时，此伤害-X（X为增加此【杀】伤害的【酒】张数）；你的回合内，其他角色无法使用【酒】。', locked: true },
  ] },
  { id: 'jie-caozhang-b45', name: '界·曹彰', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'wind', skills: [
    { id: JIANGCHI, name: '将驰', description: '出牌阶段开始时，你可以选择一项：1.摸一张牌，本阶段你不能使用【杀】；2.弃置一张牌，本阶段你使用【杀】无距离限制且可以多使用一张【杀】。' },
  ] },
  { id: 'jie-caozhi-b45', name: '界·曹植', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'wind', skills: [
    { id: LUOYING, name: '落英', description: '当其他角色的一张梅花牌因弃置或判定而置入弃牌堆时，你可以获得之。' },
    { id: JIE_JIUSHI, name: '酒诗', description: '1级：当你需要使用【酒】时，若你的武将牌正面向上，你可以翻面，视为使用一张【酒】。当你受到伤害后，若你的武将牌背面向上，你可以翻面并随机获得牌堆中的一张普通锦囊牌或延时锦囊牌。2级：当你需要使用【酒】时，若你的武将牌正面向上，你可以翻面，视为使用一张【酒】。当你受到伤害后，若你的武将牌背面向上，你可以翻面。当你翻面时，你随机获得牌堆中的一张普通锦囊牌或延时锦囊牌。' },
    { id: CHENGZHANG, name: '成章', description: '觉醒技，准备阶段，若你造成伤害与受到伤害值之和累计7点或以上，则你回复1点体力并摸1张牌，然后升级“酒诗”。' },
  ] },
  { id: 'dongcheng-b45', name: '董承', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard', skills: [
    { id: CHENGZHAO, name: '承诏', description: '一名角色的结束阶段，若你于此回合获得过两张或更多张手牌，则你可以与一名角色拼点：若你赢，则视为你对其使用一张无视防具的普通【杀】。' },
  ] },
]
