import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'
import { registerSkillRuntime, effectiveCardSuit, isTargetProhibited, type SkillHost } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { giveOwnedCards } from '../../engine/hand-transfer'
import { discardCardsByIds } from '../../engine/discard-all'
import { loseHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { clearUsedThisPhase, markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { startPindian, registerPindianContinuation } from '../../engine/pindian'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { fieldCards } from '../../engine/field-move'
import { getDistance, getAttackRange } from '../../engine/distance'
import { reshuffleDrawPile } from '../../engine/deck'
import { DAMAGE_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { legalPlayActions, beginSkillCardUseFromProcessing } from '../../engine/cards/basic'
import { handleEquipmentLost } from '../../engine/equipment'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { skillOtherHandCardUseActions } from '../../engine/cards/basic'
import { getCharacter } from './standard'

const B = '-b80'
const sid = (name: string) => `${name}${B}`
const ZHANG_LIAO_YUXI = sid('yuxi-wei-zhangliao')
const ZHANG_LIAO_PORONG = sid('porong-wei-zhangliao')
const MO_QIONGSHU_WANCHAN = sid('wanchan-mo-qiongshu')
const MO_QIONGSHU_JIANGZHI = sid('jiangzhi-mo-qiongshu')
const SHEN_PANGTONG_LUANSUO = sid('luansuo-shen-pangtong')
const SHEN_PANGTONG_FENGLIAO = sid('fengliao-shen-pangtong')
const SHEN_PANGTONG_KUNYU = sid('kunyu-shen-pangtong')
const ZHANG_HUAI_LAOYAN = sid('laoyan-zhanghuai')
const ZHANG_HUAI_JUEYAN = sid('jueyan-zhanghuai')
const ZHURONG_MANHOU = sid('manhou-sp-zhurong')
const ZHURONG_TANLUAN = sid('tanluan-sp-zhurong')
const HOUCHENG_XIANGLIANG = sid('xianliang-houcheng')
const PANGHONG_PINGZHI = sid('pingzhi-panghong')
const PANGHONG_GANGJIAN = sid('gangjian-panghong')
const CAOYUAN_WUYAN = sid('wuyan-caoyuan')
const CAOYUAN_ZHANYU = sid('zhanyu-caoyuan')
const LEZHOUYU_GUYIN = sid('guyin-le-zhouyu')
const LEZHOUYU_PINGLU = sid('pinglu-le-zhouyu')
const XUXIN_YUXIAN = sid('yuxian-xu-xin')
const XUXIN_MINSHAN = sid('minshan-xu-xin')

type B80State = SanguoshaState & { b80?: Record<string, any> }
function s80(state: SanguoshaState): Record<string, any> { const value = state as B80State; value.b80 ??= {}; return value.b80 }
function p(state: SanguoshaState, id: PlayerId) { return state.players.find((entry) => entry.id === id) }
function living(state: SanguoshaState) { return state.players.filter((entry) => entry.alive) }
function cardsOnPlayer(state: SanguoshaState, id: PlayerId) {
  const owner = p(state, id)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => !!cardId)] : []
}
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, prompt: string,
  options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId,
    prompt, timeoutMs: 25_000, optional, options }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, cardIds: CardId[],
  prompt: string, data: Record<string, unknown> = {}, min = 1, max = min) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId,
    prompt, timeoutMs: 25_000, optional: min === 0, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, targetIds: PlayerId[],
  prompt: string, data: Record<string, unknown> = {}, min = 1, max = min) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId,
    prompt, timeoutMs: 25_000, optional: min === 0, min, max, candidateIds: targetIds }) })
}
function discard(host: SkillHost, playerId: PlayerId, ids: CardId[], reason: string) {
  if (ids.length) discardCardsByIds(host as never, playerId, ids, reason)
}
function eventPlayer(context: { event: { payload: Record<string, unknown> } }) { return context.event.payload.playerId as PlayerId | undefined }
function luansuoConversions(state: SanguoshaState, actorId: PlayerId) {
  const record = s80(state).luansuoDiscardSuits
  if (!record || state.currentPlayerId !== record.ownerId || !p(state, record.ownerId)?.alive || record.turn !== state.turnNumber) return []
  const actor = p(state, actorId)
  if (!actor?.alive) return []
  const discardedSuits = new Set<string>(record.suits as string[])
  return actor.zones.hand.flatMap((id) => {
    const suit = effectiveCardSuit(state, actorId, id)
    if (actor.zones.hand.some((other) => other !== id && effectiveCardSuit(state, actorId, other) === suit) || discardedSuits.has(suit)) return []
    return [{ cardId: id, asCardName: '铁索连环', label: '鸾锁：将此牌当【铁索连环】使用' }]
  })
}

export const HISTORICAL_BATCH80_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'wei-zhangliao-b80', name: '威·张辽', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHANG_LIAO_YUXI, name: '驭袭', description: '你造成或受到伤害时，摸一张牌，以此法获得的牌无次数限制。' },
    { id: ZHANG_LIAO_PORONG, name: '破戎', description: '连招技（伤害牌+【杀】），你可获得此【杀】目标与其相邻角色各一张手牌，并令此【杀】对其额外结算一次。' },
  ] },
  { id: 'mo-qiongshu-b80', name: '莫琼树', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: MO_QIONGSHU_WANCHAN, name: '宛蝉', description: '出牌阶段限一次，你可以选择一名角色，令其摸X张牌（X为你与其距离且至多为3），然后其可以使用一张基本牌或普通锦囊牌（无距离和次数限制），且此牌目标的相邻角色也成为目标。' },
    { id: MO_QIONGSHU_JIANGZHI, name: '绛脂', description: '当你成为基本牌或普通锦囊牌的目标后，若你不是唯一目标，你可以判定：红色，摸三张牌；黑色，弃置一名其他角色至多两张牌。' },
  ] },
  { id: 'shen-pangtong-b80', name: '神·庞统', kingdom: 'shen', gender: 'male', maxHp: 1, pack: 'sp', skills: [
    { id: SHEN_PANGTONG_LUANSUO, name: '鸾锁', description: '锁定技，你的回合内，所有角色不能弃置手牌；本回合进入弃牌堆的牌花色与其当前手牌花色均不同的牌视为【铁索连环】。' },
    { id: SHEN_PANGTONG_FENGLIAO, name: '凤燎', description: '锁定技，转换技，当你使用牌指定唯一目标后，阳：令其摸一张牌；阴：对其造成一点火焰伤害。' },
    { id: SHEN_PANGTONG_KUNYU, name: '鹍浴', description: '锁定技，你的体力上限始终为1；当你死亡时，移去牌堆中一张火属性伤害牌，然后复活并将体力回复至1。' },
  ] },
  { id: 'zhang-huai-b80', name: '张怀', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANG_HUAI_LAOYAN, name: '劳燕', description: '锁定技，其他角色使用牌指定包括你的多个目标后，此牌对其他目标无效；你获得牌堆中点数小于此牌的每个点数各一张牌，此回合结束时弃置这些牌。' },
    { id: ZHANG_HUAI_JUEYAN, name: '诀言', description: '你使用单目标手牌结算后，可选择：摸1张牌、随机获得弃牌堆1张牌、或与一名角色拼点，赢的角色对没赢的角色造成1点伤害。此后所选项数值变为1，未选项数值+1（至多3）；每回合每种类型的牌限一次。' },
  ] },
  { id: 'sp-zhurong-b80', name: 'SP·祝融', kingdom: 'qun', gender: 'female', maxHp: 4, pack: 'sp', skills: [
    { id: ZHURONG_MANHOU, name: '蛮后', description: '出牌阶段限一次，你可以摸任意张牌并依次执行等量的选项（至多4）：1.失去“探乱”；2.弃置一张手牌；3.弃置场上一张牌；4.失去1点体力并获得“探乱”。' },
    { id: ZHURONG_TANLUAN, name: '探乱', description: '出牌阶段限一次，你可以使用一张本回合因弃置进入弃牌堆的牌；若此牌被【无懈可击】抵消或对其他角色造成伤害，“蛮后”视为未发动过。' },
  ] },
  { id: 'hou-cheng-b80', name: '侯成', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: HOUCHENG_XIANGLIANG, name: '献酿', description: '每轮每项限一次，当你的牌被其他角色弃置或你受到伤害后，可获得一名手牌数不小于你的角色至多两张牌，并可将至多等量张牌交给另一名其他角色；因此获得或交出的基本牌只能当【酒】使用。若本轮因此获得的牌超过两张，你失去1点体力。' },
  ] },
  { id: 'pang-hong-b80', name: '庞宏', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: PANGHONG_PINGZHI, name: '评骘', description: '转换技，出牌阶段限一次，你观看一名角色手牌并展示其中一张牌。阳：你弃置此牌，其视为对你使用【火攻】，若未造成伤害则此技能视为未使用；阴：其使用此牌，若造成伤害则此技能视为未使用。' },
    { id: PANGHONG_GANGJIAN, name: '刚简', description: '锁定技，每个回合结束时，若你本回合未受到伤害，你摸X张牌（X为本回合展示过的牌数，至多5）。' },
  ] },
  { id: 'cao-yuan-b80', name: '曹媛', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: CAOYUAN_WUYAN, name: '妩艳', description: '出牌阶段或受到伤害后，你选择一名男性角色，令其可对你选择的另一名其他角色使用一张手牌。若其使用牌，你摸两张牌；若其未使用牌或未造成伤害，你可令其失去1点体力。此技能本阶段失效。' },
    { id: CAOYUAN_ZHANYU, name: '占欲', description: '回合开始时，选择并展示一张手牌，所有其他角色随机弃置一张相同花色的手牌；你可以获得其中一张牌。' },
  ] },
  { id: 'le-zhouyu-b80', name: '乐周瑜', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: LEZHOUYU_GUYIN, name: '顾音', description: '锁定技，你没有初始手牌，其他角色初始手牌+1。其他角色的初始手牌被使用或弃置进入弃牌堆后，你摸一张牌。' },
    { id: LEZHOUYU_PINGLU, name: '平虏', description: '出牌阶段，你可以随机获得攻击范围内每名其他角色一张手牌；直到这些牌离开你的手牌前，你不能再次发动此技能。' },
  ] },
  { id: 'xu-xin-b80', name: '徐馨', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: XUXIN_YUXIAN, name: '育贤', description: '每轮开始时，你可依次展示至多四张手牌并记录花色。其他角色回合内使用前四张牌时，每当花色与对应记录相同，你可与其各摸一张牌。' },
    { id: XUXIN_MINSHAN, name: '愍善', description: '当你受到1点伤害后，可令一名角色从牌堆获得两张牌（优先获得你记录花色的牌）。' },
  ] },
]

function seatNeighbors(state: SanguoshaState, id: PlayerId): PlayerId[] {
  const owner = p(state, id)
  if (!owner) return []
  const livingPlayers = living(state).sort((a, b) => a.seat - b.seat)
  const index = livingPlayers.findIndex((entry) => entry.id === id)
  if (index < 0 || livingPlayers.length < 2) return []
  return [...new Set([livingPlayers[(index - 1 + livingPlayers.length) % livingPlayers.length]!.id,
    livingPlayers[(index + 1) % livingPlayers.length]!.id])].filter((targetId) => targetId !== id)
}

registerSkillRuntime({ id: ZHANG_LIAO_YUXI,
  unlimitedCardUses(state, ownerId, cardId) {
    const held = p(state, ownerId)?.zones.hand ?? []
    return Boolean(cardId && held.includes(cardId) && s80(state).yuxiFreeCards?.[ownerId]?.includes(cardId))
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const { sourceId, targetId } = context.event
      if (sourceId !== ownerId && targetId !== ownerId) return
      const drawn = drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload)) as CardId[]
      s80(host.state).yuxiFreeCards ??= {}
      s80(host.state).yuxiFreeCards[ownerId] = [...new Set([...(s80(host.state).yuxiFreeCards[ownerId] ?? []), ...drawn])]
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId === ownerId && s80(host.state).yuxiFreeCards?.[ownerId])
        s80(host.state).yuxiFreeCards[ownerId] = s80(host.state).yuxiFreeCards[ownerId].filter((id: CardId) => !payload.cardIds?.includes(id))
    } },
  ],
})

registerSkillRuntime({ id: ZHANG_LIAO_PORONG,
  repeatSlashTarget(state, _ownerId, targetId, cardId) {
    return s80(state).porongRepeat?.[cardId]?.includes(targetId) ?? false
  },
  interceptSourceTargetEach(host, ownerId, context) {
    if (context.cardName !== '杀' || context.targetId === ownerId) return false
    const ready = s80(host.state).porongReady?.[ownerId]
    if (!ready || ready.turn !== host.state.turnNumber || ready.cardId === context.cardId) return false
    host.askSkill({ skillId: ZHANG_LIAO_PORONG, ownerId, step: 'invoke', data: { cardId: context.cardId, targetId: context.targetId, cardName: ready.cardName },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【破戎】：是否发动连招，获得此【杀】目标及其相邻角色各一张手牌，并令此【杀】对其额外结算一次？', timeoutMs: 25_000,
        optional: true, options: [{ id: 'yes', label: '发动破戎' }, { id: 'no', label: '不发动' }] }) })
    return true
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    if (context.event.sourceId !== ownerId || !payload.cardId || !payload.cardName) return
    const card = host.state.cards[payload.cardId]
    if (payload.cardName !== '杀' && (card?.damageNature || DAMAGE_TRICKS.has(payload.cardName))) {
      s80(host.state).porongReady ??= {}
      s80(host.state).porongReady[ownerId] = { turn: host.state.turnNumber, cardId: payload.cardId, cardName: payload.cardName }
    }
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const targetId = resolution.data.targetId as PlayerId
      const ids = [targetId, ...seatNeighbors(host.state, targetId)].filter((id) => p(host.state, id)?.alive)
      const targets = ids.map((id) => ({ id, cards: p(host.state, id)?.zones.hand ?? [] })).filter((x) => x.cards.length)
      if (!targets.length) { host.resumeCardTarget(); return }
      s80(host.state).porongPending = { cardId: resolution.data.cardId, targetId, targets, index: 0 }
      askCards(host, ZHANG_LIAO_PORONG, ownerId, 'steal', ownerId, targets[0]!.cards, '【破戎】：选择获得目标角色的一张手牌', { target: targets[0]!.id }, 1, 1)
      return
    }
    if (resolution.step !== 'steal') return
    const pending = s80(host.state).porongPending
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const currentTarget = pending?.targets[pending.index]
    if (cardId && currentTarget?.cards.includes(cardId) && p(host.state, currentTarget.id)?.zones.hand.includes(cardId)) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: currentTarget.id }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHANG_LIAO_PORONG }, { sourceId: currentTarget.id, targetId: ownerId, cardIds: [cardId] })
    }
    if (!pending) { host.resumeCardTarget(); return }
    pending.index += 1
    const next = pending.targets[pending.index]
    if (next) askCards(host, ZHANG_LIAO_PORONG, ownerId, 'steal', ownerId, next.cards, '【破戎】：选择获得相邻角色的一张手牌', { target: next.id }, 1, 1)
    else {
      s80(host.state).porongRepeat ??= {}
      s80(host.state).porongRepeat[pending.cardId] = [pending.targetId]
      delete s80(host.state).porongPending
      delete s80(host.state).porongReady[ownerId]
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({ id: SHEN_PANGTONG_LUANSUO,
  protectsCardFromDiscard(state, ownerId, cardId) {
    return state.currentPlayerId === ownerId && state.players.some((entry) => entry.zones.hand.includes(cardId))
  },
  viewAs(state, ownerId) { return luansuoConversions(state, ownerId) },
  globalViewAs(state, ownerId, actorId) {
    return state.currentPlayerId === ownerId ? luansuoConversions(state, actorId) : []
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if (eventPlayer(context) !== ownerId) return
      s80(host.state).luansuoDiscardSuits = { ownerId, turn: host.state.turnNumber, suits: [] }
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      if (host.state.currentPlayerId !== ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const suit = cardId ? host.state.cards[cardId]?.suit : undefined
      if (!suit) return
      const record = s80(host.state).luansuoDiscardSuits ?? { ownerId, turn: host.state.turnNumber, suits: [] }
      if (record.turn !== host.state.turnNumber || record.ownerId !== ownerId) Object.assign(record, { ownerId, turn: host.state.turnNumber, suits: [] })
      record.suits.push(suit)
      s80(host.state).luansuoDiscardSuits = record
    } },
  ],
})

registerSkillRuntime({ id: SHEN_PANGTONG_FENGLIAO,
  onGameStart(host, ownerId) { s80(host.state).fengliaoYang ??= {}, s80(host.state).fengliaoYang[ownerId] = true },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { targetIds?: PlayerId[] }
    const targets = payload.targetIds ?? []
    if (targets.length !== 1) return
    s80(host.state).fengliaoYang ??= {}
    if (s80(host.state).fengliaoYang[ownerId] !== false) {
      const target = p(host.state, targets[0]!)
      if (target?.alive) drawCards(host.state, host.rng, target.id, 1, (name, event) => host.dispatch(name, event))
      s80(host.state).fengliaoYang[ownerId] = false
    } else {
      resolveDamage(host as never, { sourceId: ownerId, targetId: targets[0]!, amount: 1, nature: 'fire', reason: SHEN_PANGTONG_FENGLIAO })
      s80(host.state).fengliaoYang[ownerId] = true
    }
  } }],
})

registerSkillRuntime({ id: SHEN_PANGTONG_KUNYU,
  triggers: [
    { event: 'MaxHpChange', handle(host, ownerId) {
      const owner = p(host.state, ownerId)
      if (owner && (owner.maxHp !== 1 || owner.hp > 1)) { owner.maxHp = 1; owner.hp = Math.min(owner.hp, 1) }
    } },
    { event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
      if (eventPlayer(context) !== ownerId) return
      const owner = p(host.state, ownerId)
      if (!owner) return
      const fireCard = host.state.zones.drawPile.find((id) => {
        const card = host.state.cards[id]
        return card?.damageNature === 'fire'
      })
      if (!fireCard) return
      moveCard(host.state, fireCard, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: `${SHEN_PANGTONG_KUNYU}:removed` })
      owner.alive = true
      owner.maxHp = 1
      owner.hp = 1
      owner.restingUntilRound = undefined
    } },
  ],
})

const JIANGZHI_JUDGE_TAG = `${MO_QIONGSHU_JIANGZHI}:judge`
const JUEYAN_PINDIAN_TAG = `${ZHANG_HUAI_JUEYAN}:pindian`
registerPindianContinuation(JUEYAN_PINDIAN_TAG, (host, result) => {
  const winnerId = result.outcome === 'initiator-win' ? result.initiatorId
    : result.outcome === 'opponent-win' ? result.opponentId : null
  const loserId = result.outcome === 'initiator-win' ? result.opponentId
    : result.outcome === 'opponent-win' ? result.initiatorId : null
  if (winnerId && loserId && p(host.state, winnerId)?.alive && p(host.state, loserId)?.alive)
    resolveDamage(host as never, { sourceId: winnerId, targetId: loserId, amount: 1, reason: ZHANG_HUAI_JUEYAN })
})
registerJudgmentContinuation(JIANGZHI_JUDGE_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  if (!p(host.state, ownerId)?.alive) return
  if (judged.color === 'red') drawCards(host.state, host.rng, ownerId, 3, (name, payload) => host.dispatch(name, payload))
  else {
    const candidates = living(host.state).filter((entry) => entry.id !== ownerId && cardsOnPlayer(host.state, entry.id).length)
    if (candidates.length) host.queueSkill({ skillId: MO_QIONGSHU_JIANGZHI, ownerId, step: 'discard-target', data: { candidateIds: candidates.map(({ id }) => id) } })
    else host.resumeCardTarget()
  }
})

registerSkillRuntime({ id: ZHANG_HUAI_LAOYAN,
  cardIneffectiveForTarget(state, ownerId, sourceId, _cardName, cardId) {
    const mark = cardId ? s80(state).laoyanCards?.[cardId] : undefined
    return !!mark && mark.ownerId === ownerId && sourceId !== ownerId
      && (mark.targets as PlayerId[]).includes(sourceId as PlayerId) && sourceId !== ownerId
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      const sourceId = context.event.sourceId
      const cardId = payload.cardId
      const targets = payload.targetIds ?? []
      if (!sourceId || sourceId === ownerId || !cardId || !targets.includes(ownerId) || targets.length < 2) return
      const rank = host.state.cards[cardId]?.rank
      if (!rank) return
      s80(host.state).laoyanCards ??= {}
      s80(host.state).laoyanCards[cardId] = { ownerId, targets: targets.filter((id) => id !== ownerId) }
      const deck = host.state.zones.drawPile
      const chosen: CardId[] = []
      for (let point = 1; point < rank; point += 1) {
        const candidates = deck.filter((id) => host.state.cards[id]?.rank === point)
        if (!candidates.length) continue
        const id = candidates[host.rng.nextInt(candidates.length)]!
        moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        chosen.push(id)
      }
      if (chosen.length) {
        s80(host.state).laoyanOwned ??= {}
        s80(host.state).laoyanOwned[ownerId] ??= {}
        s80(host.state).laoyanOwned[ownerId][host.state.turnNumber] = [
          ...(s80(host.state).laoyanOwned[ownerId][host.state.turnNumber] ?? []), ...chosen,
        ]
        host.dispatch('GainCard', { playerId: ownerId, cardIds: chosen, reason: ZHANG_HUAI_LAOYAN }, { sourceId, targetId: ownerId, cardIds: chosen })
      }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const ended = eventPlayer(context)
      if (!ended) return
      const owned = s80(host.state).laoyanOwned?.[ownerId]?.[host.state.turnNumber] as CardId[] | undefined
      const stillHeld = (owned ?? []).filter((id) => p(host.state, ownerId)?.zones.hand.includes(id))
      if (stillHeld.length) discard(host, ownerId, stillHeld, ZHANG_HUAI_LAOYAN)
      if (s80(host.state).laoyanOwned?.[ownerId]) delete s80(host.state).laoyanOwned[ownerId][host.state.turnNumber]
    } },
  ],
})

registerSkillRuntime({ id: ZHANG_HUAI_JUEYAN,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if (eventPlayer(context) !== ownerId) return
      s80(host.state).jueyanUsed ??= {}; s80(host.state).jueyanUsed[ownerId] = []
      s80(host.state).jueyanPending ??= {}; delete s80(host.state).jueyanPending[ownerId]
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[]; fromKind?: string }
      const cardId = payload.cardId
      if (!cardId || payload.fromKind !== 'hand' || payload.targetIds?.length !== 1) return
      const category = host.state.cards[cardId]?.category
      if (!category || (s80(host.state).jueyanUsed?.[ownerId] ?? []).includes(category)) return
      s80(host.state).jueyanPending ??= {}
      s80(host.state).jueyanPending[ownerId] = { cardId, category, targetIds: payload.targetIds }
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      const pending = s80(host.state).jueyanPending?.[ownerId]
      if (!pending || pending.cardId !== payload.cardId || payload.targetIds?.length !== 1) return
      delete s80(host.state).jueyanPending[ownerId]
      const used = new Set<string>(s80(host.state).jueyanUsed?.[ownerId] ?? [])
      used.add(pending.category); s80(host.state).jueyanUsed[ownerId] = [...used]
      host.queueSkill({ skillId: ZHANG_HUAI_JUEYAN, ownerId, step: 'choose', data: { category: pending.category, targetId: payload.targetIds[0] } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const levels = s80(host.state).jueyanLevels?.[ownerId] ?? [1, 1, 1]
    askOption(host, ZHANG_HUAI_JUEYAN, ownerId, 'choose', ownerId, '【诀言】：选择一项（数值按当前选项等级）', [
      { id: 'draw', label: `摸${levels[0]}张牌` },
      { id: 'gain', label: `随机获得弃牌堆${levels[1]}张牌` },
      { id: 'pindian', label: '与一名角色拼点，赢者对败者造成1点伤害' },
    ], { ...prompt.data, levels })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose') {
      const option = (response.payload as { optionId?: string }).optionId
      if (!['draw', 'gain', 'pindian'].includes(option ?? '')) return
      const levels = [...((resolution.data.levels as number[]) ?? [1, 1, 1])]
      const chosen = ['draw', 'gain', 'pindian'].indexOf(option!)
      levels.forEach((value, index) => { levels[index] = index === chosen ? 1 : Math.min(3, value + 1) })
      s80(host.state).jueyanLevels ??= {}; s80(host.state).jueyanLevels[ownerId] = levels
      if (option === 'draw') drawCards(host.state, host.rng, ownerId, Number((resolution.data.levels as number[])[0] ?? 1), (name, payload) => host.dispatch(name, payload))
      else if (option === 'gain') {
        reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
        const pile = [...host.state.zones.discardPile]
        const chosenIds = host.rng.shuffle(pile).slice(0, Number((resolution.data.levels as number[])[1] ?? 1))
        for (const id of chosenIds) moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        if (chosenIds.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: chosenIds, reason: ZHANG_HUAI_JUEYAN }, { targetId: ownerId, cardIds: chosenIds })
      } else {
        const candidates = living(host.state).filter((entry) => entry.id !== ownerId && entry.zones.hand.length)
        if (candidates.length) askTargets(host, ZHANG_HUAI_JUEYAN, ownerId, 'pindian-target', ownerId,
          candidates.map(({ id }) => id), '【诀言】：选择一名有手牌的角色拼点', resolution.data, 1, 1)
      }
      return
    }
    if (resolution.step !== 'pindian-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !p(host.state, ownerId)?.zones.hand.length || !p(host.state, targetId)?.zones.hand.length) return
    startPindian(host as never, { id: `${ZHANG_HUAI_JUEYAN}:${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
      reason: ZHANG_HUAI_JUEYAN, continuationTag: JUEYAN_PINDIAN_TAG })
  },
})
registerSkillRuntime({ id: MO_QIONGSHU_JIANGZHI,
  interceptTarget(host, ownerId, context) {
    if (context.targetId !== ownerId || (context.category !== 'basic' && context.category !== 'trick')) return false
    const resolution = host.state.cardResolution
    if (!resolution || !('targetIds' in resolution) || resolution.targetIds.length < 2 || !resolution.targetIds.includes(ownerId)) return false
    host.askSkill({ skillId: MO_QIONGSHU_JIANGZHI, ownerId, step: 'judge-offer', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【绛脂】：是否判定？红色摸三张，黑色弃置一名其他角色至多两张牌。', timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '判定' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-target') return
    const candidates = (prompt.data.candidateIds as PlayerId[]).filter((id) => p(host.state, id)?.alive && cardsOnPlayer(host.state, id).length)
    if (candidates.length) askTargets(host, MO_QIONGSHU_JIANGZHI, ownerId, 'discard-target', ownerId, candidates,
      '【绛脂】：选择一名其他角色弃置至多两张牌', {}, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'judge-offer') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') performJudgment(host as never, ownerId, '绛脂', { tag: JIANGZHI_JUDGE_TAG, data: { ownerId } })
      return
    }
    if (resolution.step === 'discard-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const ids = targetId ? cardsOnPlayer(host.state, targetId) : []
      if (targetId && ids.length) askCards(host, MO_QIONGSHU_JIANGZHI, ownerId, 'discard-cards', ownerId, ids,
        '【绛脂】：选择弃置至多两张牌', { targetId }, 0, Math.min(2, ids.length))
      return
    }
    if (resolution.step === 'discard-cards') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      discard(host, targetId, selected.filter((id) => cardsOnPlayer(host.state, targetId).includes(id)), MO_QIONGSHU_JIANGZHI)
    }
  },
})

registerSkillRuntime({ id: MO_QIONGSHU_WANCHAN,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && p(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, MO_QIONGSHU_WANCHAN)
      ? [{ id: 'wanchan:activate', label: '宛蝉：令一名角色摸牌并使用一张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'wanchan:activate' || usedThisPhase(host.state, ownerId, MO_QIONGSHU_WANCHAN)) return
    markUsedThisPhase(host.state, ownerId, MO_QIONGSHU_WANCHAN)
    askTargets(host, MO_QIONGSHU_WANCHAN, ownerId, 'target', ownerId,
      living(host.state).map(({ id }) => id), '【宛蝉】：选择摸牌并使用牌的角色', {}, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const actorId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const actor = actorId ? p(host.state, actorId) : undefined
      if (!actor?.alive) return
      const count = Math.min(3, getDistance(host.state, ownerId, actorId!))
      if (count > 0) drawCards(host.state, host.rng, actorId!, count, (name, payload) => host.dispatch(name, payload))
      s80(host.state).wanchanPermit ??= {}
      s80(host.state).wanchanPermit[actorId!] = { ownerId, turn: host.state.turnNumber }
      const usable = actor.zones.hand.filter((id) => {
        const card = host.state.cards[id]
        return card?.category === 'basic' || (card?.category === 'trick' && INSTANT_TRICKS.has(card.name))
      })
      if (usable.length) askCards(host, MO_QIONGSHU_WANCHAN, ownerId, 'card', actorId!, usable, '【宛蝉】：选择使用一张基本牌或普通锦囊牌', { actorId }, 0, 1)
      return
    }
    if (resolution.step === 'card') {
      const actorId = resolution.data.actorId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const actor = p(host.state, actorId)
      const card = cardId ? host.state.cards[cardId] : undefined
      if (!cardId || !actor?.zones.hand.includes(cardId) || !card || !(card.category === 'basic' || card.category === 'trick')) return
      const actions = skillOtherHandCardUseActions(host.state, actorId, actorId, cardId, undefined, MO_QIONGSHU_WANCHAN,
        undefined, { allowSelf: true, ignoreDistance: true, ignoreUsageLimits: true })
      if (!actions.length) return
      askOption(host, MO_QIONGSHU_WANCHAN, ownerId, 'use-action', actorId, '【宛蝉】：选择合法的牌与目标',
        actions.map((action) => ({ id: action.id, label: action.label })), { actorId, cardId, actions: actions.map((item) => item.id) }, false)
      return
    }
    if (resolution.step === 'use-action') {
      const actorId = resolution.data.actorId as PlayerId
      const cardId = resolution.data.cardId as CardId
      const actionId = (response.payload as { optionId?: string }).optionId
      if (!actionId || !(resolution.data.actions as string[]).includes(actionId)) return
      const success = host.beginSkillCardUseFromOtherHand(actorId, actorId, cardId, MO_QIONGSHU_WANCHAN, actionId,
        undefined, undefined, { allowSelf: true, ignoreDistance: true, ignoreUsageLimits: true })
      if (!success) delete s80(host.state).wanchanPermit[actorId]
      return
    }
  },
  forcedAdditionalTargetsOnUse(state, ownerId, sourceId, cardId, cardName, currentTargetIds, skillIdsOf) {
    const permit = s80(state).wanchanPermit?.[sourceId]
    if (!permit || permit.turn !== state.turnNumber || permit.ownerId !== ownerId) return []
    const card = state.cards[cardId]
    if (!card || !(card.category === 'basic' || card.category === 'trick')) return []
    const existing = new Set(currentTargetIds)
    return [...new Set(currentTargetIds.flatMap((id) => seatNeighbors(state, id)))].filter((id) => !existing.has(id) && id !== sourceId
      && !isTargetProhibited(state, sourceId, id, cardName, skillIdsOf, cardId, MO_QIONGSHU_WANCHAN))
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const actorId = context.event.sourceId
    if (!actorId || s80(host.state).wanchanPermit?.[actorId]?.ownerId !== ownerId) return
    delete s80(host.state).wanchanPermit[actorId]
  } }],
})

registerSkillRuntime({ id: LEZHOUYU_GUYIN,
  initialHandCount(_state, ownerId, normalCount) { return p(_state, ownerId)?.characterId === 'le-zhouyu-b80' ? 0 : normalCount },
  globalInitialHandModifier(state, ownerId, targetId) { return p(state, ownerId)?.characterId === 'le-zhouyu-b80' && targetId !== ownerId ? 1 : 0 },
  onGameStart(host, ownerId) {
    s80(host.state).guyinEligible ??= {}
    s80(host.state).guyinEligible[ownerId] = host.state.players.filter((entry) => entry.id !== ownerId)
      .flatMap((entry) => entry.zones.hand)
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const eligible = s80(host.state).guyinEligible?.[ownerId] as CardId[] | undefined
      if (!cardId || !eligible?.includes(cardId) || context.event.sourceId === ownerId) return
      s80(host.state).guyinEligible[ownerId] = eligible.filter((id) => id !== cardId)
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const eligible = s80(host.state).guyinEligible?.[ownerId] as CardId[] | undefined
      if (!cardId || !eligible?.includes(cardId)) return
      s80(host.state).guyinEligible[ownerId] = eligible.filter((id) => id !== cardId)
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    } },
  ],
})

registerSkillRuntime({ id: LEZHOUYU_PINGLU,
  activeActions(state, ownerId) {
    const retained = ((s80(state).pingluCards?.[ownerId] ?? []) as CardId[]).some((id) => p(state, ownerId)?.zones.hand.includes(id))
    return state.currentPlayerId === ownerId && state.phase === 'play' && p(state, ownerId)?.alive && !retained
      ? [{ id: 'pinglu:activate', label: '平虏：随机获得攻击范围内角色各一张手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'pinglu:activate') return
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    const targets = living(host.state).filter((entry) => entry.id !== ownerId && entry.zones.hand.length
      && getDistance(host.state, ownerId, entry.id) <= getAttackRange(host.state, ownerId))
    const taken: CardId[] = []
    for (const target of targets) {
      const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]!
      moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: LEZHOUYU_PINGLU }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: LEZHOUYU_PINGLU }, { sourceId: target.id, targetId: ownerId, cardIds: [cardId] })
      taken.push(cardId)
    }
    s80(host.state).pingluCards ??= {}
    s80(host.state).pingluCards[ownerId] = taken
  },
  triggers: [{ event: 'LoseCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (payload.playerId !== ownerId) return
    const tracked = s80(host.state).pingluCards?.[ownerId] as CardId[] | undefined
    if (tracked) s80(host.state).pingluCards[ownerId] = tracked.filter((id) => !payload.cardIds?.includes(id))
  } }],
})

registerSkillRuntime({ id: XUXIN_YUXIAN,
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
      const hand = p(host.state, ownerId)?.zones.hand ?? []
      if (!hand.length) { s80(host.state).yuxianSuits ??= {}, s80(host.state).yuxianSuits[ownerId] = []; return }
      askCards(host, XUXIN_YUXIAN, ownerId, 'record', ownerId, hand, '【育贤】：展示并记录至多四张手牌的花色（可少选）', { round: host.state.roundNumber }, 0, Math.min(4, hand.length))
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const actor = eventPlayer(context)
      if (actor && actor !== ownerId) { s80(host.state).yuxianUseIndex ??= {}; s80(host.state).yuxianUseIndex[actor] = 0 }
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const actor = context.event.sourceId
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!actor || actor === ownerId || actor !== host.state.currentPlayerId || !cardId) return
      s80(host.state).yuxianUseIndex ??= {}
      const index = s80(host.state).yuxianUseIndex[actor] ?? 0
      s80(host.state).yuxianUseIndex[actor] = index + 1
      if (index >= 4) return
      const suits = s80(host.state).yuxianSuits?.[ownerId] as string[] | undefined
      if (!suits?.[index] || effectiveCardSuit(host.state, actor, cardId) !== suits[index]) return
      host.queueSkill({ skillId: XUXIN_YUXIAN, ownerId, step: 'matched', data: { actor, index } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'matched') askOption(host, XUXIN_YUXIAN, ownerId, 'matched', ownerId,
      `【育贤】：${p(host.state, prompt.data.actor as PlayerId)?.nickname ?? '角色'}使用的第${Number(prompt.data.index) + 1}张牌花色与你记录相同，是否各摸一张？`,
      [{ id: 'yes', label: '你与其各摸一张' }, { id: 'no', label: '不发动' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'record') {
      const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const own = p(host.state, ownerId)
      const valid = cards.slice(0, 4).filter((id) => own?.zones.hand.includes(id))
      const suits = valid.map((id) => effectiveCardSuit(host.state, ownerId, id))
      s80(host.state).yuxianSuits ??= {}; s80(host.state).yuxianSuits[ownerId] = suits
      host.dispatch('SkillActivated', { skillId: XUXIN_YUXIAN, skillName: '育贤', playerId: ownerId,
        cardIds: valid, logText: `【育贤】：展示并记录了${valid.length}张手牌的花色` }, { sourceId: ownerId, cardIds: valid })
      return
    }
    if (resolution.step === 'matched' && (response.payload as { optionId?: string }).optionId === 'yes') {
      const actor = resolution.data.actor as PlayerId
      if (p(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      if (p(host.state, actor)?.alive) drawCards(host.state, host.rng, actor, 1, (name, payload) => host.dispatch(name, payload))
    }
  },
})

registerSkillRuntime({ id: XUXIN_MINSHAN,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { finalAmount?: number }
    if (context.event.targetId !== ownerId || payload.finalAmount !== 1 || !p(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: XUXIN_MINSHAN, ownerId, step: 'target', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'target') askTargets(host, XUXIN_MINSHAN, ownerId, 'target', ownerId,
      living(host.state).map(({ id }) => id), '【愍善】：选择一名角色从牌堆获得两张牌（优先已记录花色）', {}, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? p(host.state, targetId) : undefined
    if (!target?.alive) return
    reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
    const suits = new Set<string>((s80(host.state).yuxianSuits?.[ownerId] as string[] | undefined) ?? [])
    const preferred = host.state.zones.drawPile.filter((id) => suits.has(host.state.cards[id]?.suit ?? '')).slice(0, 2)
    for (const id of preferred) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const rest = Math.max(0, 2 - preferred.length)
    if (rest) drawCards(host.state, host.rng, target.id, rest, (name, payload) => host.dispatch(name, payload))
    if (preferred.length) host.dispatch('GainCard', { playerId: target.id, cardIds: preferred, reason: XUXIN_MINSHAN }, { sourceId: ownerId, targetId: target.id, cardIds: preferred })
  },
})

registerSkillRuntime({ id: HOUCHENG_XIANGLIANG,
  viewAs(state, ownerId) {
    return (p(state, ownerId)?.zones.hand ?? []).filter((id) => s80(state).houWineCards?.includes(id))
      .map((cardId) => ({ cardId, asCardName: '酒', label: '献酿：将此牌当【酒】使用' }))
  },
  prohibitsCardUse(state, _ownerId, context) {
    return (context.cardIds ?? []).some((id) => s80(state).houWineCards?.includes(id)) && context.cardName !== '酒'
  },
  prohibitsResponseCard(state, _ownerId, _responderId, cardId, cardName) {
    return (s80(state).houWineCards as CardId[] | undefined)?.includes(cardId) === true && cardName !== '酒'
  },
  globalViewAs(state, _ownerId, actorId) {
    return (p(state, actorId)?.zones.hand ?? []).filter((id) => s80(state).houWineCards?.includes(id))
      .map((cardId) => ({ cardId, asCardName: '酒', label: '献酿：将此牌当【酒】使用' }))
  },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
      s80(host.state).xianliangUsed ??= {}; s80(host.state).xianliangUsed[ownerId] = {}
      s80(host.state).xianliangGainCount ??= {}; s80(host.state).xianliangGainCount[ownerId] = 0
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; reason?: string }
      if (payload.playerId !== ownerId || context.event.sourceId === ownerId || !context.event.sourceId) return
      const isDiscarded = (payload.cardIds ?? []).some((id) => host.state.zones.discardPile.includes(id))
      if (isDiscarded) queueXianliang(host, ownerId, 'discard', context.event.sourceId)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      queueXianliang(host, ownerId, 'damage', context.event.sourceId)
    } },
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId || context.event.sourceId === ownerId
        || (payload as { reason?: string }).reason !== HOUCHENG_XIANGLIANG) return
      const ids = (payload.cardIds ?? []).filter((id) => host.state.cards[id]?.category === 'basic')
      if (ids.length) {
        s80(host.state).houWineCards ??= []
        s80(host.state).houWineCards = [...new Set([...(s80(host.state).houWineCards as CardId[]), ...ids])]
      }
    } },
    { event: 'CardGiven', handle(host, ownerId, context) {
      const payload = context.event.payload as { fromId?: PlayerId; cardIds?: CardId[] }
      if (payload.fromId !== ownerId || (payload as { reason?: string }).reason !== HOUCHENG_XIANGLIANG) return
      const ids = (payload.cardIds ?? []).filter((id) => host.state.cards[id]?.category === 'basic')
      if (ids.length) {
        s80(host.state).houWineCards ??= []
        s80(host.state).houWineCards = [...new Set([...(s80(host.state).houWineCards as CardId[]), ...ids])]
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      askOption(host, HOUCHENG_XIANGLIANG, ownerId, 'offer', ownerId, '【献酿】：是否获得一名手牌数不小于你的角色至多两张牌？',
        [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], prompt.data)
      return
    }
    if (prompt.step === 'source') {
      const targets = living(host.state).filter((entry) => entry.id !== ownerId && entry.zones.hand.length >= (p(host.state, ownerId)?.zones.hand.length ?? 0))
      if (targets.length) askTargets(host, HOUCHENG_XIANGLIANG, ownerId, 'source', ownerId, targets.map(({ id }) => id),
        '【献酿】：选择牌的来源', prompt.data, 1, 1)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        const key = resolution.data.kind as 'discard' | 'damage'
        if (s80(host.state).xianliangQueued?.[ownerId]?.[key] === host.state.roundNumber)
          delete s80(host.state).xianliangQueued[ownerId][key]
        return
      }
      const key = resolution.data.kind as 'discard' | 'damage'
      s80(host.state).xianliangUsed ??= {}; s80(host.state).xianliangUsed[ownerId] ??= {}
      if (s80(host.state).xianliangUsed[ownerId][key]) return
      s80(host.state).xianliangUsed[ownerId][key] = true
      const targets = living(host.state).filter((entry) => entry.id !== ownerId && entry.zones.hand.length >= (p(host.state, ownerId)?.zones.hand.length ?? 0))
      if (targets.length) askTargets(host, HOUCHENG_XIANGLIANG, ownerId, 'source', ownerId, targets.map(({ id }) => id), '【献酿】：选择牌的来源', {}, 1, 1)
      return
    }
    if (resolution.step === 'source') {
      const sourceId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const source = sourceId ? p(host.state, sourceId) : undefined
      if (!source?.alive || source.zones.hand.length < (p(host.state, ownerId)?.zones.hand.length ?? 0)) return
      askCards(host, HOUCHENG_XIANGLIANG, ownerId, 'gain', ownerId, cardsOnPlayer(host.state, source.id),
        '【献酿】：选择获得至多两张牌', { sourceId }, 0, Math.min(2, cardsOnPlayer(host.state, source.id).length))
      return
    }
    if (resolution.step === 'gain') {
      const sourceId = resolution.data.sourceId as PlayerId
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const gained = giveOwnedCards(host as never, sourceId, ownerId, selected, HOUCHENG_XIANGLIANG)
      const basic = gained.filter((id) => host.state.cards[id]?.category === 'basic')
      if (basic.length) { s80(host.state).houWineCards ??= []; s80(host.state).houWineCards = [...new Set([...(s80(host.state).houWineCards as CardId[]), ...basic])] }
      const total = Number(s80(host.state).xianliangGainCount?.[ownerId] ?? 0) + gained.length
      s80(host.state).xianliangGainCount ??= {}; s80(host.state).xianliangGainCount[ownerId] = total
      if (total > 2) loseHp(host as never, ownerId, 1, HOUCHENG_XIANGLIANG)
      if (!gained.length) return
      const targets = living(host.state).filter((entry) => entry.id !== ownerId && entry.id !== sourceId)
      if (targets.length) askTargets(host, HOUCHENG_XIANGLIANG, ownerId, 'recipient', ownerId, targets.map(({ id }) => id),
        '【献酿】：是否交给另一名其他角色至多等量张牌？', { gained, sourceId }, 0, 1)
      return
    }
    if (resolution.step === 'recipient') {
      const recipientId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!recipientId) return
      const gained = resolution.data.gained as CardId[]
      const available = gained.filter((id) => p(host.state, ownerId)?.zones.hand.includes(id))
      if (!available.length) return
      askCards(host, HOUCHENG_XIANGLIANG, ownerId, 'give', ownerId, available, '【献酿】：选择交出的牌', { recipientId }, 0, Math.min(gained.length, available.length))
      return
    }
    if (resolution.step === 'give') {
      const recipientId = resolution.data.recipientId as PlayerId
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const given = giveOwnedCards(host as never, ownerId, recipientId, selected, HOUCHENG_XIANGLIANG)
      const basic = given.filter((id) => host.state.cards[id]?.category === 'basic')
      if (basic.length) { s80(host.state).houWineCards ??= []; s80(host.state).houWineCards = [...new Set([...(s80(host.state).houWineCards as CardId[]), ...basic])] }
    }
  },
})

function queueXianliang(host: SkillHost, ownerId: PlayerId, kind: 'discard' | 'damage', sourceId?: PlayerId) {
  const round = host.state.roundNumber
  s80(host.state).xianliangUsed ??= {}; s80(host.state).xianliangUsed[ownerId] ??= {}
  if (s80(host.state).xianliangUsed[ownerId][kind] || s80(host.state).xianliangQueued?.[ownerId]?.[kind] === round) return
  s80(host.state).xianliangQueued ??= {}; s80(host.state).xianliangQueued[ownerId] ??= {}; s80(host.state).xianliangQueued[ownerId][kind] = round
  host.queueSkill({ skillId: HOUCHENG_XIANGLIANG, ownerId, step: 'offer', data: { kind, sourceId } })
}

registerSkillRuntime({ id: ZHURONG_MANHOU,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && p(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, ZHURONG_MANHOU)
      ? [{ id: 'manhou:activate', label: '蛮后：摸牌并依次执行选项' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'manhou:activate' || usedThisPhase(host.state, ownerId, ZHURONG_MANHOU)) return
    markUsedThisPhase(host.state, ownerId, ZHURONG_MANHOU)
    askOption(host, ZHURONG_MANHOU, ownerId, 'count', ownerId, '【蛮后】：选择摸牌张数并执行等量不同选项（至多四项）',
      [1, 2, 3, 4].map((value) => ({ id: String(value), label: `摸${value}张牌` })), {})
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'next-option') askManhouOption(host, ownerId, prompt.data as { count: number; done: string[]; index: number })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'count') {
      const count = Number((response.payload as { optionId?: string }).optionId)
      if (!Number.isInteger(count) || count < 1 || count > 4 || !p(host.state, ownerId)?.alive) return
      drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
      host.queueSkill({ skillId: ZHURONG_MANHOU, ownerId, step: 'next-option', data: { count, done: [], index: 0 } })
      return
    }
    if (resolution.step === 'option') {
      const data = resolution.data as { count: number; done: string[]; index: number }
      const option = (response.payload as { optionId?: string }).optionId
      if (!option || !manhouAvailable(host.state, ownerId).includes(option)) return
      const done = [...data.done, option]
      const next = { ...data, done, index: data.index + 1 }
      if (option === 'lose-tanluan') s80(host.state).tanluanAvailable ??= {}, s80(host.state).tanluanAvailable[ownerId] = false
      if (option === 'gain-tanluan') s80(host.state).tanluanAvailable ??= {}, s80(host.state).tanluanAvailable[ownerId] = true
      if (option === 'lose-hp') {
        loseHp(host as never, ownerId, 1, ZHURONG_MANHOU)
      }
      if (option === 'gain-tanluan') loseHp(host as never, ownerId, 1, ZHURONG_MANHOU)
      if (option === 'discard-hand') {
        const hand = p(host.state, ownerId)?.zones.hand ?? []
        if (hand.length) { askCards(host, ZHURONG_MANHOU, ownerId, 'discard-hand', ownerId, hand, '【蛮后】：弃置一张手牌', { ...next, option }, 1, 1); return }
      }
      if (option === 'discard-field') {
        const fields = fieldCards(host.state)
        if (fields.length) { askCards(host, ZHURONG_MANHOU, ownerId, 'discard-field', ownerId, fields.map(({ cardId }) => cardId), '【蛮后】：弃置场上一张牌', { ...next, option }, 1, 1); return }
      }
      continueManhou(host, ownerId, next)
      return
    }
    if (resolution.step === 'discard-hand') {
      const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (id && p(host.state, ownerId)?.zones.hand.includes(id)) discard(host, ownerId, [id], ZHURONG_MANHOU)
      continueManhou(host, ownerId, resolution.data as { count: number; done: string[]; index: number })
      return
    }
    if (resolution.step === 'discard-gain-tanluan') {
      const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (id) discard(host, ownerId, [id], ZHURONG_MANHOU)
      continueManhou(host, ownerId, resolution.data as { count: number; done: string[]; index: number })
      return
    }
    if (resolution.step === 'discard-field') {
      const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const field = id ? fieldCards(host.state).find((entry) => entry.cardId === id) : undefined
      if (field) {
        if (field.slot) handleEquipmentLost(host as never, field.ownerId, id!)
        moveCard(host.state, id!, { kind: field.slot ? 'equipment' : 'judgingArea', playerId: field.ownerId, ...(field.slot ? { slot: field.slot } : {}) } as never,
          { kind: 'discardPile' }, { discardReason: 'discard' })
        host.dispatch('LoseCard', { playerId: field.ownerId, cardIds: [id!], reason: ZHURONG_MANHOU }, { sourceId: ownerId, targetId: field.ownerId, cardIds: [id!] })
      }
      continueManhou(host, ownerId, resolution.data as { count: number; done: string[]; index: number })
    }
  },
})

function manhouAvailable(state: SanguoshaState, ownerId: PlayerId): string[] {
  const owner = p(state, ownerId)
  const available: string[] = []
  if (s80(state).tanluanAvailable?.[ownerId] !== false) available.push('lose-tanluan')
  if (owner?.zones.hand.length) available.push('discard-hand')
  if (fieldCards(state).length) available.push('discard-field')
  if (s80(state).tanluanAvailable?.[ownerId] === false) available.push('gain-tanluan')
  return available
}
function askManhouOption(host: SkillHost, ownerId: PlayerId, data: { count: number; done: string[]; index: number }) {
  if (data.index >= data.count || !p(host.state, ownerId)?.alive) return
  const names: Record<string, string> = { 'lose-tanluan': '失去“探乱”', 'discard-hand': '弃置一张手牌', 'discard-field': '弃置场上一张牌', 'gain-tanluan': '失去1点体力并获得“探乱”' }
  const options = manhouAvailable(host.state, ownerId).map((id) => ({ id, label: names[id]! }))
  if (!options.length) return
  askOption(host, ZHURONG_MANHOU, ownerId, 'option', ownerId, '【蛮后】：执行下一项不同选项', options, data, false)
}
function continueManhou(host: SkillHost, ownerId: PlayerId, data: { count: number; done: string[]; index: number }) {
  if (data.index < data.count && p(host.state, ownerId)?.alive) host.queueSkill({ skillId: ZHURONG_MANHOU, ownerId, step: 'next-option', data })
}

registerSkillRuntime({ id: ZHURONG_TANLUAN,
  activeActions(state, ownerId) {
    const discarded = ((s80(state).tanluanDiscarded?.[ownerId] ?? []) as Array<{ cardId: CardId; turn: number }>)
      .filter((entry) => state.zones.discardPile.includes(entry.cardId) && entry.turn === state.turnNumber).map((entry) => entry.cardId)
    return state.currentPlayerId === ownerId && state.phase === 'play' && p(state, ownerId)?.alive
      && s80(state).tanluanAvailable?.[ownerId] !== false && !usedThisPhase(state, ownerId, ZHURONG_TANLUAN) && discarded.length
      ? [{ id: 'tanluan:activate', label: '探乱：使用本回合因弃置进入弃牌堆的牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'tanluan:activate') return
    const ids = ((s80(host.state).tanluanDiscarded?.[ownerId] ?? []) as Array<{ cardId: CardId; turn: number }>)
      .filter((entry) => host.state.zones.discardPile.includes(entry.cardId) && entry.turn === host.state.turnNumber).map((entry) => entry.cardId)
    if (!ids.length) return
    markUsedThisPhase(host.state, ownerId, ZHURONG_TANLUAN)
    askCards(host, ZHURONG_TANLUAN, ownerId, 'card', ownerId, ids, '【探乱】：选择本回合弃置且仍在弃牌堆中的牌', {}, 1, 1)
  },
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; reason?: string }
      if (!payload.cardId || payload.reason !== 'discard' || !host.state.cards[payload.cardId]) return
      s80(host.state).tanluanDiscarded ??= {}; s80(host.state).tanluanDiscarded[ownerId] ??= []
      s80(host.state).tanluanDiscarded[ownerId].push({ cardId: payload.cardId, turn: host.state.turnNumber })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId }
      if (payload.cardId && context.event.sourceSkillId === ZHURONG_TANLUAN) {
        s80(host.state).tanluanUseCards ??= {}; s80(host.state).tanluanUseCards[payload.cardId] = ownerId
      }
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean; sourceSkillId?: string }
      if (!payload.cardId || payload.sourceSkillId !== ZHURONG_TANLUAN || s80(host.state).tanluanUseCards?.[payload.cardId] !== ownerId) return
      if (payload.cancelled) clearUsedThisPhase(host.state, ownerId, ZHURONG_MANHOU)
      delete s80(host.state).tanluanUseCards[payload.cardId]
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId || context.event.targetId === ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) < 1
        || s80(host.state).tanluanUseCards?.[cardId] !== ownerId) return
      clearUsedThisPhase(host.state, ownerId, ZHURONG_MANHOU)
      delete s80(host.state).tanluanUseCards[cardId]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'use') {
      const cardId = resolution.data.cardId as CardId
      const actionId = (response.payload as { optionId?: string }).optionId
      if (!actionId || !host.state.zones.discardPile.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'processingArea' })
      if (!beginSkillCardUseFromProcessing(host as never, ownerId, cardId, ZHURONG_TANLUAN, actionId)
        && host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      return
    }
    if (resolution.step !== 'card') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !host.state.zones.discardPile.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    const actions = legalPlayActions(host.state, ownerId).filter((item) => item.kind === 'use-card' && item.cardIds.includes(cardId) && !item.id.startsWith('play:recast:'))
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    if (actions.length) askOption(host, ZHURONG_TANLUAN, ownerId, 'use', ownerId, '【探乱】：选择合法使用方式',
      actions.map((item) => ({ id: item.id, label: item.label })), { cardId }, false)
  },
})

registerSkillRuntime({ id: PANGHONG_PINGZHI,
  onGameStart(host, ownerId) { s80(host.state).pingzhiYang ??= {}, s80(host.state).pingzhiYang[ownerId] = true },
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && p(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, PANGHONG_PINGZHI)
      ? [{ id: 'pingzhi:activate', label: '评骘：展示一名角色手牌并按阴阳使用' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'pingzhi:activate' || usedThisPhase(host.state, ownerId, PANGHONG_PINGZHI)) return
    const candidates = living(host.state).filter((entry) => entry.zones.hand.length)
    if (!candidates.length) return
    markUsedThisPhase(host.state, ownerId, PANGHONG_PINGZHI)
    askTargets(host, PANGHONG_PINGZHI, ownerId, 'target', ownerId, candidates.map(({ id }) => id), '【评骘】：选择一名有手牌的角色', {}, 1, 1)
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceSkillId !== PANGHONG_PINGZHI) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      s80(host.state).pingzhiCards ??= {}; s80(host.state).pingzhiCards[cardId] = ownerId
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; finalAmount?: number }
      if (context.event.sourceSkillId !== PANGHONG_PINGZHI || Number(payload.finalAmount ?? 0) <= 0) return
      const cardId = payload.cardId
      if (cardId && s80(host.state).pingzhiCards?.[cardId] === ownerId) s80(host.state).pingzhiDamaged ??= {}, s80(host.state).pingzhiDamaged[cardId] = true
      else s80(host.state).pingzhiDirectDamage ??= {}, s80(host.state).pingzhiDirectDamage[ownerId] = true
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      if (context.event.sourceSkillId !== PANGHONG_PINGZHI) return
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      const cardId = payload.cardId
      const damaged = (cardId && s80(host.state).pingzhiDamaged?.[cardId]) || s80(host.state).pingzhiDirectDamage?.[ownerId]
      if (!damaged && (payload.cancelled || cardId)) clearUsedThisPhase(host.state, ownerId, PANGHONG_PINGZHI)
      if (cardId) { delete s80(host.state).pingzhiCards?.[cardId]; delete s80(host.state).pingzhiDamaged?.[cardId] }
      delete s80(host.state).pingzhiDirectDamage?.[ownerId]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const hand = targetId ? p(host.state, targetId)?.zones.hand ?? [] : []
      if (!targetId || !hand.length) return
      askCards(host, PANGHONG_PINGZHI, ownerId, 'show-card', ownerId, hand, '【评骘】：观看并展示其中一张牌', { targetId }, 1, 1)
      return
    }
    if (resolution.step === 'show-card') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const target = p(host.state, targetId)
      if (!cardId || !target?.zones.hand.includes(cardId)) return
      s80(host.state).gangjianRevealed ??= {}
      s80(host.state).gangjianRevealed[ownerId] = Number(s80(host.state).gangjianRevealed[ownerId] ?? 0) + 1
      const yang = s80(host.state).pingzhiYang?.[ownerId] !== false
      s80(host.state).pingzhiYang ??= {}; s80(host.state).pingzhiYang[ownerId] = !yang
      host.dispatch('SkillActivated', { skillId: PANGHONG_PINGZHI, skillName: '评骘', playerId: ownerId,
        targetIds: [targetId], cardIds: [cardId], logText: `【评骘】：展示了${target.nickname}的【${host.state.cards[cardId]?.name ?? '牌'}】` },
      { sourceId: ownerId, targetId, cardIds: [cardId] })
      if (yang) {
        discard(host, targetId, [cardId], PANGHONG_PINGZHI)
        if (!host.beginVirtualTrick({ sourceId: targetId, targetId: ownerId, cardName: '火攻', sourceSkillId: PANGHONG_PINGZHI }))
          clearUsedThisPhase(host.state, ownerId, PANGHONG_PINGZHI)
      } else {
        const actions = skillOtherHandCardUseActions(host.state, targetId, targetId, cardId, undefined, PANGHONG_PINGZHI,
          undefined, { allowSelf: true })
        if (!actions.length) { clearUsedThisPhase(host.state, ownerId, PANGHONG_PINGZHI); return }
        askOption(host, PANGHONG_PINGZHI, ownerId, 'yin-use', targetId, '【评骘】：使用所展示的牌',
          actions.map((item) => ({ id: item.id, label: item.label })), { targetId, cardId, actions: actions.map(({ id }) => id) }, false)
      }
      return
    }
    if (resolution.step === 'yin-use') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = resolution.data.cardId as CardId
      const actionId = (response.payload as { optionId?: string }).optionId
      if (!actionId || !(resolution.data.actions as string[]).includes(actionId)) return
      if (!host.beginSkillCardUseFromOtherHand(targetId, targetId, cardId, PANGHONG_PINGZHI, actionId,
        undefined, undefined, { allowSelf: true })) clearUsedThisPhase(host.state, ownerId, PANGHONG_PINGZHI)
    }
  },
})

registerSkillRuntime({ id: PANGHONG_GANGJIAN,
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    if (eventPlayer(context) === ownerId) s80(host.state).gangjianDamaged ??= {}, s80(host.state).gangjianDamaged[ownerId] = false,
      s80(host.state).gangjianRevealed ??= {}, s80(host.state).gangjianRevealed[ownerId] = 0
  } }, { event: 'DamageSettled', handle(host, ownerId, context) {
    if (context.event.targetId === ownerId && Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) > 0)
      s80(host.state).gangjianDamaged ??= {}, s80(host.state).gangjianDamaged[ownerId] = true
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    if (eventPlayer(context) !== ownerId || s80(host.state).gangjianDamaged?.[ownerId]) return
    const count = Math.min(5, Number(s80(host.state).gangjianRevealed?.[ownerId] ?? 0))
    if (count) drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
    s80(host.state).gangjianRevealed[ownerId] = 0
  } }],
})

registerSkillRuntime({ id: CAOYUAN_WUYAN,
  activeActions(state, ownerId) {
    const key = wuyanPhaseKey(state)
    return state.currentPlayerId === ownerId && state.phase === 'play' && p(state, ownerId)?.alive
      && s80(state).wuyanUsed?.[ownerId] !== key
      ? [{ id: 'wuyan:activate', label: '妩艳：令一名男性角色对另一角色使用手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'wuyan:activate') return
    queueWuyan(host, ownerId, wuyanPhaseKey(host.state))
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId && Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) > 0)
        queueWuyan(host, ownerId, wuyanPhaseKey(host.state))
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const pending = cardId ? s80(host.state).wuyanPending?.[cardId] : undefined
      if (pending?.ownerId === ownerId && context.event.sourceId === pending.maleId
        && Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) > 0) pending.damaged = true
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      const pending = payload.cardId ? s80(host.state).wuyanPending?.[payload.cardId] : undefined
      if (!pending || pending.ownerId !== ownerId) return
      const male = p(host.state, pending.maleId)
      if (male?.alive) drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
      delete s80(host.state).wuyanPending[payload.cardId!]
      if (!pending.damaged && male?.alive) askOption(host, CAOYUAN_WUYAN, ownerId, 'punish', ownerId,
        `【妩艳】：${male.nickname}未造成伤害，是否令其失去1点体力？`,
        [{ id: 'yes', label: '令其失去1点体力' }, { id: 'no', label: '不令其失去体力' }], { maleId: pending.maleId })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-male') {
      const candidates = living(host.state).filter((entry) => entry.id !== ownerId && getCharacter(entry.characterId ?? '')?.gender === 'male')
      if (candidates.length) askTargets(host, CAOYUAN_WUYAN, ownerId, 'male', ownerId, candidates.map(({ id }) => id), '【妩艳】：选择一名男性角色', prompt.data, 1, 1)
      return
    }
    if (prompt.step === 'choose-victim') {
      const maleId = prompt.data.maleId as PlayerId
      const candidates = living(host.state).filter((entry) => entry.id !== ownerId && entry.id !== maleId)
      if (candidates.length) askTargets(host, CAOYUAN_WUYAN, ownerId, 'victim', ownerId, candidates.map(({ id }) => id), '【妩艳】：选择另一名其他角色', prompt.data, 1, 1)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'male') {
      const maleId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const male = maleId ? p(host.state, maleId) : undefined
      if (!male?.alive || getCharacter(male.characterId ?? '')?.gender !== 'male') return
      host.queueSkill({ skillId: CAOYUAN_WUYAN, ownerId, step: 'choose-victim', data: { maleId, key: resolution.data.key } })
      return
    }
    if (resolution.step === 'victim') {
      const maleId = resolution.data.maleId as PlayerId
      const victimId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!victimId || !p(host.state, maleId)?.alive || !p(host.state, victimId)?.alive || victimId === ownerId || victimId === maleId) return
      const hand = p(host.state, maleId)!.zones.hand
      const actions = hand.flatMap((cardId) => skillOtherHandCardUseActions(host.state, maleId, maleId, cardId, undefined,
        CAOYUAN_WUYAN, undefined, { allowSelf: true }).filter((action) => action.targetIds.includes(victimId)))
      s80(host.state).wuyanUsed ??= {}; s80(host.state).wuyanUsed[ownerId] = resolution.data.key
      if (!actions.length) {
        askOption(host, CAOYUAN_WUYAN, ownerId, 'punish-no-use', ownerId, '【妩艳】：其没有可对所选角色使用的手牌，是否令其失去1点体力？',
          [{ id: 'yes', label: '令其失去1点体力' }, { id: 'no', label: '不发动' }], { maleId })
        return
      }
      askOption(host, CAOYUAN_WUYAN, ownerId, 'use', maleId, '【妩艳】：选择一张手牌及其合法用法对所选角色使用',
        [...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'pass', label: '不使用' }],
        { maleId, victimId, actions: actions.map(({ id, cardIds }) => ({ id, cardId: cardIds[0] })) }, false)
      return
    }
    if (resolution.step === 'use') {
      const maleId = resolution.data.maleId as PlayerId
      const actionId = (response.payload as { optionId?: string }).optionId
      const selected = (resolution.data.actions as Array<{ id: string; cardId: CardId }>).find(({ id }) => id === actionId)
      if (!actionId || actionId === 'pass' || !selected) {
        askOption(host, CAOYUAN_WUYAN, ownerId, 'punish-no-use', ownerId, '【妩艳】：其未使用牌，是否令其失去1点体力？',
          [{ id: 'yes', label: '令其失去1点体力' }, { id: 'no', label: '不发动' }], { maleId })
        return
      }
      const cardId = selected.cardId
      s80(host.state).wuyanPending ??= {}
      s80(host.state).wuyanPending[cardId] = { ownerId, maleId, damaged: false }
      if (!p(host.state, maleId)?.zones.hand.includes(cardId) || !host.beginSkillCardUseFromOtherHand(maleId, maleId, cardId, CAOYUAN_WUYAN, actionId,
        undefined, undefined, { allowSelf: true })) {
        delete s80(host.state).wuyanPending[cardId]
        askOption(host, CAOYUAN_WUYAN, ownerId, 'punish-no-use', ownerId, '【妩艳】：其未使用牌，是否令其失去1点体力？',
          [{ id: 'yes', label: '令其失去1点体力' }, { id: 'no', label: '不发动' }], { maleId })
      }
      return
    }
    if (resolution.step === 'punish' || resolution.step === 'punish-no-use') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') {
        const maleId = resolution.data.maleId as PlayerId
        if (p(host.state, maleId)?.alive) loseHp(host as never, maleId, 1, CAOYUAN_WUYAN)
      }
    }
  },
})

function wuyanPhaseKey(state: SanguoshaState) { return `${state.turnNumber}:${state.currentPlayerId}:${state.phase}` }
function queueWuyan(host: SkillHost, ownerId: PlayerId, key: string) {
  if (!p(host.state, ownerId)?.alive || s80(host.state).wuyanUsed?.[ownerId] === key
    || s80(host.state).wuyanQueued?.[ownerId] === key) return
  s80(host.state).wuyanQueued ??= {}; s80(host.state).wuyanQueued[ownerId] = key
  host.queueSkill({ skillId: CAOYUAN_WUYAN, ownerId, step: 'choose-male', data: { key } })
}

registerSkillRuntime({ id: CAOYUAN_ZHANYU,
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    if (eventPlayer(context) !== ownerId) return
    const hand = p(host.state, ownerId)?.zones.hand ?? []
    if (hand.length) host.queueSkill({ skillId: CAOYUAN_ZHANYU, ownerId, step: 'show', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'show') {
      const hand = p(host.state, ownerId)?.zones.hand ?? []
      if (hand.length) askCards(host, CAOYUAN_ZHANYU, ownerId, 'show', ownerId, hand, '【占欲】：选择并展示一张手牌', {}, 1, 1)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'show') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !p(host.state, ownerId)?.zones.hand.includes(cardId)) return
      const suit = effectiveCardSuit(host.state, ownerId, cardId)
      host.dispatch('SkillActivated', { skillId: CAOYUAN_ZHANYU, skillName: '占欲', playerId: ownerId,
        cardIds: [cardId], logText: `【占欲】：展示【${host.state.cards[cardId]?.name ?? '牌'}】` }, { sourceId: ownerId, cardIds: [cardId] })
      const discarded: CardId[] = []
      for (const target of living(host.state).filter((entry) => entry.id !== ownerId)) {
        const candidates = target.zones.hand.filter((id) => effectiveCardSuit(host.state, target.id, id) === suit)
        if (!candidates.length) continue
        const chosen = candidates[host.rng.nextInt(candidates.length)]!
        discard(host, target.id, [chosen], CAOYUAN_ZHANYU)
        if (host.state.zones.discardPile.includes(chosen)) discarded.push(chosen)
      }
      if (discarded.length) askCards(host, CAOYUAN_ZHANYU, ownerId, 'gain', ownerId, discarded, '【占欲】：选择获得其中一张牌', {}, 0, 1)
      return
    }
    if (resolution.step === 'gain') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !host.state.zones.discardPile.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CAOYUAN_ZHANYU }, { targetId: ownerId, cardIds: [cardId] })
    }
  },
})




