import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'
import { registerSkillRuntime, effectiveCardSuit, effectiveCardColor, isTargetProhibited, type SkillHost } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { discardCardsByIds } from '../../engine/discard-all'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { giveCards } from '../../engine/hand-transfer'
import { resolveDamageSequence } from '../../engine/damage'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { schedulePhaseSkipForPlayer } from '../../engine/turn'
import { getDistance, getAttackRange, canTarget } from '../../engine/distance'
import { fieldCards } from '../../engine/field-move'
import { ALL_CHARACTERS, skillIdsOf } from './standard'
import { declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { DELAYED_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { handleEquipmentLost } from '../../engine/equipment'
import { gainMaxHp } from '../../engine/hp'
import { FACTION_ORDER } from '../../shared/factions'
import { effectiveDamageNature } from '../../engine/zones'
import { conversionStateOf, setConversionState } from '../../engine/conversion'
import { lockHandUseAndResponseUntilTurnEnd } from '../../engine/card-play-lock'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'

const B = '-b78'
const sid = (name: string) => `${name}${B}`
const YUANSHU_CANXI = sid('canxi-star-yuanshu')
const YUANSHU_PIZHI = sid('pizhi-star-yuanshu')
const YUANSHU_ZHONGGU = sid('zhonggu-star-yuanshu')
const XIAHOU_MAO_TONGWEI = sid('tongwei-xiahoumao')
const XIAHOU_MAO_CUGUO = sid('cuguo-xiahoumao')
const DAQIAO_QIQIN = sid('qiqin-ledaqiao')
const DAQIAO_ZIXI = sid('zixi-ledaqiao')
const XIAOQIAO_QIQIN = sid('qiqin-lexiaoqiao')
const XIAOQIAO_WEIWAN = sid('weiwan-lexiaoqiao')
const CAOXIAN_LINGXI = sid('lingxi-caoxian')
const CAOXIAN_ZHIFOU = sid('zhifou-caoxian')
const YUANSHAO_XIAOYAN = sid('xiaoyan-star-yuanshao')
const YUANSHAO_ZONGSHI = sid('zongshi-star-yuanshao')
const YUANSHAO_JIAOWANG = sid('jiaowang-star-yuanshao')
const YUANSHAO_AOSHI = sid('aoshi-star-yuanshao')
const ZHANGCHUNHUA_LIANGYAN = sid('liangyan-star-zhangchunhua')
const ZHANGCHUNHUA_MINGHUI = sid('minghui-star-zhangchunhua')
const XUCHU_ZHENGQING = sid('zhengqing-god-xuchu')
const XUCHU_ZHUANGPO = sid('zhuangpo-god-xuchu')
const SIMAYI_QUANMOU = sid('quanmu-mou-simayi')
const SIMAYI_PINGLIAO = sid('pingliao-mou-simayi')
const JIANGJI_SHIJU = sid('shiju-mou-jiangji')
const JIANGJI_YINGSHI = sid('yingshi-mou-jiangji')
const XUCHU_QING_MARK = 'zhengqing-god-xuchu:b78'

type B78State = SanguoshaState & { b78?: Record<string, any> }
function s78(state: SanguoshaState): Record<string, any> { const target = state as B78State; target.b78 ??= {}; return target.b78 }
function player(state: SanguoshaState, id: PlayerId) { return state.players.find((entry) => entry.id === id) }
function living(state: SanguoshaState) { return state.players.filter((entry) => entry.alive) }
function cardsInHandAndEquipment(state: SanguoshaState, id: PlayerId): CardId[] {
  const owner = player(state, id)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))] : []
}
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId,
    prompt, timeoutMs: 25_000, optional, options }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  cardIds: CardId[], prompt: string, data: Record<string, unknown> = {}, min = 1, max = min) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId,
    prompt, timeoutMs: 25_000, optional: min === 0, purpose: 'skill', hiddenCardSlots: [], cardIds, min, max }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  targetIds: PlayerId[], prompt: string, data: Record<string, unknown> = {}, min = 1, max = min) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId,
    prompt, timeoutMs: 25_000, optional: min === 0, min, max, candidateIds: targetIds }) })
}
function discard(host: SkillHost, ownerId: PlayerId, cardIds: CardId[], reason: string) {
  if (cardIds.length) discardCardsByIds(host as never, ownerId, cardIds, reason)
}
function factionOf(state: SanguoshaState, playerId: PlayerId) {
  const target = player(state, playerId)
  return target?.nationalWarFaction ?? target?.kingdomOverride
    ?? ALL_CHARACTERS.find((character) => character.id === target?.characterId)?.kingdom ?? null
}
function sealMark(faction: string) { return `canxi-star-yuanshu:${faction}` }

export const HISTORICAL_BATCH78_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'star-yuanshu-b78', name: '星·袁术', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: YUANSHU_CANXI, name: '残玺', description: '锁定技，游戏开始时，你获得场上各势力的“玺角”标记（每少一个“玺角”则加1点体力上限）。每轮开始时，你选择一个“玺角”并选择一个效果生效直到下轮开始。1.妄生：与生效“玺角”势力相同的角色每回合首次造成的伤害+1；计算与其他角色的距离-1。2.向死：与生效“玺角”势力相同的其他角色每回合首次回复体力后，失去1点体力；每回合对你使用的第一张牌对你无效。' },
    { id: YUANSHU_PIZHI, name: '圮秩', description: '锁定技，结束阶段，你摸X张牌；有角色死亡时，若其势力与生效“玺角”的势力相同或是该势力最后一名角色，失去该“玺角”，然后摸X张牌并回复1点体力（X为你失去的“玺角”数）。' },
    { id: YUANSHU_ZHONGGU, name: '冢骨', description: '主公技，锁定技，游戏轮数大于等于群势力角色数时，你摸牌阶段摸牌数+2，反之-1。' },
  ] },
  { id: 'xiahoumao-b78', name: '夏侯楙', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: XIAHOU_MAO_TONGWEI, name: '统围', description: '出牌阶段限一次，你可以选择一名其他角色，然后你重铸两张牌。若如此做，其使用下一张牌结算后，若此牌点数为你上次此法重铸牌点数之间，你视为对其使用一张【杀】或【过河拆桥】。' },
    { id: XIAHOU_MAO_CUGUO, name: '蹙国', description: '锁定技，当你每回合使用牌首次被抵消后，你弃置一张牌，令此牌对目标角色再结算一次，此牌结算后，若仍被抵消，你失去1点体力。' },
  ] },
  { id: 'ledaqiao-b78', name: '乐大乔', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: DAQIAO_QIQIN, name: '绮琴', description: '锁定技，游戏开始时，你的初始手牌增加“琴”标记且不计入手牌上限。准备阶段，你获得弃牌堆中所有“琴”。' },
    { id: DAQIAO_ZIXI, name: '姊希', description: '出牌阶段开始时和结束时，你可以将至多2张“琴”放置在一名角色的判定区。你使用【杀】或普通锦囊牌指定唯一目标后，可根据其判定区牌的张数获得以下效果：1张：此牌对其额外结算1次；2张：你摸2张牌；3张：获得其判定区和装备区所有牌并对其造成3点伤害。' },
  ] },
  { id: 'lexiaoqiao-b78', name: '乐小乔', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: XIAOQIAO_QIQIN, name: '绮琴', description: '锁定技，游戏开始时，你的初始手牌增加“琴”标记且不计入手牌上限。准备阶段，你获得弃牌堆中所有“琴”。' },
    { id: XIAOQIAO_WEIWAN, name: '媦婉', description: '出牌阶段限一次，你可以弃置一张“琴”并选择一名其他角色，随机获得其区域内与该“琴”不同花色的牌各一张。若你获得牌的张数为：1张：其失去1点体力；2张：你本回合对其使用牌无距离和次数限制；3张：你本回合无法对其使用牌。' },
  ] },
  { id: 'caoxian-b78', name: '曹宪', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: CAOXIAN_LINGXI, name: '灵犀', description: '出牌阶段开始或结束时，你可以将至多体力上限张牌置于武将牌上称之为“翼”。“翼”被移去后，你将手牌调整至等于“翼”花色数的两倍。' },
    { id: CAOXIAN_ZHIFOU, name: '知否', description: '你使用牌结算完成后，你可移去至少X张“翼”（X为你本回合发动此技能的次数）并令一名角色执行以下一项（每回合每项各限一次）：1.将一张牌置于“翼”中；2.弃两张牌；3.失去1点体力。' },
  ] },
  { id: 'star-yuanshao-b78', name: '星·袁绍', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: YUANSHAO_XIAOYAN, name: '硝焰', description: '游戏开始时，所有其他角色各受到你造成的1点火焰伤害，然后这些角色可依次交给你一张牌并回复1点体力。' },
    { id: YUANSHAO_ZONGSHI, name: '纵势', description: '出牌阶段，你可展示一张基本牌或普通锦囊牌，然后将此花色的所有其他手牌当这张牌使用。此牌可指定的目标数改为以此法使用的牌数。' },
    { id: YUANSHAO_JIAOWANG, name: '骄妄', description: '锁定技，每轮结束时，若本轮没有角色死亡，则你失去1点体力并发动“硝焰”。' },
    { id: YUANSHAO_AOSHI, name: '傲势', description: '主公技，其他群势力角色的出牌阶段限一次，其可以交给你一张手牌，然后你可以发动一次“纵势”。' },
  ] },
  { id: 'star-zhangchunhua-b78', name: '星·张春华', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANGCHUNHUA_LIANGYAN, name: '梁燕', description: '出牌阶段限一次，你可以选择一名其他角色，你摸/弃至多两张牌，该角色弃/摸等量的牌。然后若你与其手牌数相同，以此法摸牌的角色跳过下一个弃牌阶段。' },
    { id: ZHANGCHUNHUA_MINGHUI, name: '明慧', description: '每个回合结束时，若你手牌数全场最少，你可以视为使用一张无距离限制的【杀】；若你手牌数全场最多，你可以将手牌弃置至不为全场最多，然后令一名角色回复1点体力。' },
  ] },
  { id: 'god-xuchu-b78', name: '神·许褚', kingdom: 'shen', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: XUCHU_ZHENGQING, name: '争擎', description: '锁定技，每轮结束时，移去所有“擎”标记，然后本轮单回合内造成伤害值最多的角色获得X个“擎”标记并与你各摸一张牌（X为其该回合造成的伤害数）。若是你获得“擎”，你改为摸X张牌（最多摸5）。' },
    { id: XUCHU_ZHUANGPO, name: '壮魄', description: '你可将牌面信息中有【杀】字的牌当【决斗】使用。若你拥有“擎”，则此【决斗】指定目标后，你可以移去任意个“擎”，然后令其弃置等量的牌；若此【决斗】指定了有“擎”的角色为目标，则你摸一张牌且此牌伤害+1。' },
  ] },
  { id: 'mou-simayi-b78', name: '谋·司马懿', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SIMAYI_QUANMOU, name: '权谋', description: '转换技，游戏开始时可自选阴阳状态，出牌阶段每名角色限一次，你可以令攻击范围内一名其他角色交给你一张牌，阳：防止你此阶段下次对其造成的伤害；阴：此阶段你下次对其造成伤害后，可以对至多三名其他角色（该角色除外）各造成1点伤害。' },
    { id: SIMAYI_PINGLIAO, name: '平辽', description: '锁定技，当你使用【杀】指定目标时，不公开指定的目标。你攻击范围内的其他角色依次选择是否打出一张红色基本牌。若此【杀】的目标未打出基本牌，其本回合无法使用或打出手牌；若有至少一名非目标打出基本牌，你摸两张牌且此阶段出【杀】次数+1。' },
  ] },
  { id: 'mou-jiangji-b78', name: '谋·蒋济', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: JIANGJI_SHIJU, name: '势举', description: '每名角色的出牌阶段限一次，其可以交给你一张牌。你可以使用此牌，然后其本回合攻击范围+X（X为你装备区内牌的数量）。若此牌是装备牌或此牌造成了伤害，你与其各摸两张牌。' },
    { id: JIANGJI_YINGSHI, name: '应时', description: '当你使用普通锦囊牌指定目标后，你可令其中一个目标选择一项：令此牌对其额外结算一次；弃置X张牌（X为你装备区内牌的数量+1），然后此技能本回合失效。' },
  ] },
]

registerSkillRuntime({ id: YUANSHU_CANXI,
  onGameStart(host, ownerId) {
    const owner = player(host.state, ownerId)
    if (!owner) return
    const present = [...new Set(host.state.players.filter((candidate) => candidate.alive)
      .map((candidate) => factionOf(host.state, candidate.id)).filter((faction) => faction !== null))]
    s78(host.state).yuanshuSeals ??= {}
    s78(host.state).yuanshuSeals[ownerId] = present
    for (const faction of present) owner.marks[sealMark(faction)] = 1
    const absentCount = FACTION_ORDER.filter((faction) => !present.includes(faction)).length
    if (absentCount) gainMaxHp(host as never, ownerId, absentCount, YUANSHU_CANXI)
  },
  globalOutgoingDamage(state, ownerId, sourceId, context) {
    const active = s78(state).yuanshuActive?.[ownerId]
    if (!active || active.mode !== '妄生' || factionOf(state, sourceId) !== active.faction) return null
    s78(state).yuanshuDamageTurn ??= {}
    if (s78(state).yuanshuDamageTurn[sourceId] === state.turnNumber) return null
    s78(state).yuanshuDamageTurn[sourceId] = state.turnNumber
    return { amount: context.amount + 1 }
  },
  globalDistanceModifier(state, ownerId, sourceId) {
    const active = s78(state).yuanshuActive?.[ownerId]
    return active?.mode === '妄生' && factionOf(state, sourceId) === active.faction ? -1 : 0
  },
  cardIneffectiveForTarget(state, ownerId, sourceId, _cardName, cardId) {
    const active = s78(state).yuanshuActive?.[ownerId]
    const blocked = s78(state).yuanshuFirstCard?.[ownerId]
    return active?.mode === '向死' && blocked?.turn === state.turnNumber && blocked.cardId === cardId
      && sourceId !== ownerId
  },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
      if (!player(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: YUANSHU_CANXI, ownerId, step: 'choose-seal', data: { round: host.state.roundNumber } })
    } },
    { event: 'TargetConfirmed', handle(host, ownerId, context) {
      const targetId = context.event.targetId ?? (context.event.payload as { targetId?: PlayerId }).targetId
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const active = s78(host.state).yuanshuActive?.[ownerId]
      const prior = s78(host.state).yuanshuFirstCard?.[ownerId]
      if (targetId !== ownerId || !cardId || active?.mode !== '向死' || !player(host.state, ownerId)?.alive
        || prior?.turn === host.state.turnNumber) return
      s78(host.state).yuanshuFirstCard ??= {}
      s78(host.state).yuanshuFirstCard[ownerId] = { turn: host.state.turnNumber, cardId }
    } },
    { event: 'Recover', handle(host, ownerId, context) {
      const targetId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
      const active = s78(host.state).yuanshuActive?.[ownerId]
      if (!targetId || targetId === ownerId || active?.mode !== '向死' || factionOf(host.state, targetId) !== active.faction) return
      s78(host.state).yuanshuRecoverTurn ??= {}
      if (s78(host.state).yuanshuRecoverTurn[targetId] === host.state.turnNumber) return
      s78(host.state).yuanshuRecoverTurn[targetId] = host.state.turnNumber
      loseHp(host as never, targetId, 1, YUANSHU_CANXI)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-seal') return
    const seals = s78(host.state).yuanshuSeals?.[ownerId] as string[] | undefined
    const available = (seals ?? []).filter((faction) => (player(host.state, ownerId)?.marks[sealMark(faction)] ?? 0) > 0)
    if (!available.length) { delete s78(host.state).yuanshuActive?.[ownerId]; return }
    askOption(host, YUANSHU_CANXI, ownerId, 'seal', ownerId, '【残玺】：选择一个“玺角”',
      available.map((faction) => ({ id: faction, label: `${faction}势力“玺角”` })), { round: prompt.data.round }, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'seal') {
      const faction = (response.payload as { optionId?: string }).optionId
      const available = (s78(host.state).yuanshuSeals?.[ownerId] as string[] | undefined) ?? []
      if (!faction || !available.includes(faction) || (player(host.state, ownerId)?.marks[sealMark(faction)] ?? 0) < 1) return
      askOption(host, YUANSHU_CANXI, ownerId, 'mode', ownerId, `【残玺】：选择${faction}势力“玺角”的效果`, [
        { id: '妄生', label: '妄生：该势力角色本回合首次造成伤害+1，计算距离-1' },
        { id: '向死', label: '向死：该势力其他角色首次回复后失去体力；对你本回合首张牌无效' },
      ], { faction, round: resolution.data.round }, false)
      return
    }
    if (resolution.step !== 'mode') return
    const { faction, round } = resolution.data as { faction?: string; round?: number }
    const mode = (response.payload as { optionId?: string }).optionId
    if (!faction || !['妄生', '向死'].includes(mode ?? '') || round !== host.state.roundNumber
      || (player(host.state, ownerId)?.marks[sealMark(faction)] ?? 0) < 1) return
    s78(host.state).yuanshuActive ??= {}
    s78(host.state).yuanshuActive[ownerId] = { faction, mode, round }
    host.dispatch('SkillActivated', { playerId: ownerId, skillId: YUANSHU_CANXI, skillName: '残玺',
      logText: `${player(host.state, ownerId)?.nickname ?? '角色'}发动【残玺】，令${faction}势力“玺角”生效：${mode}` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({ id: YUANSHU_PIZHI,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId; phase?: string }
      const lost = Number(s78(host.state).yuanshuLostSeals?.[ownerId] ?? 0)
      if (data.playerId === ownerId && data.phase === 'finish' && lost > 0)
        drawCards(host.state, host.rng, ownerId, lost, (name, payload) => host.dispatch(name, payload))
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
      const deadFaction = deadId ? factionOf(host.state, deadId) : null
      const owner = player(host.state, ownerId)
      if (!owner?.alive || !deadId || !deadFaction) return
      const seals = (s78(host.state).yuanshuSeals?.[ownerId] as string[] | undefined) ?? []
      if (!seals.includes(deadFaction) || (owner.marks[sealMark(deadFaction)] ?? 0) < 1) return
      const activeFaction = s78(host.state).yuanshuActive?.[ownerId]?.faction
      const isLastOfFaction = !host.state.players.some((candidate) => candidate.alive && candidate.id !== deadId
        && factionOf(host.state, candidate.id) === deadFaction)
      if (deadFaction !== activeFaction && !isLastOfFaction) return
      owner.marks[sealMark(deadFaction)] = 0
      s78(host.state).yuanshuSeals[ownerId] = seals.filter((faction) => faction !== deadFaction)
      if (activeFaction === deadFaction) delete s78(host.state).yuanshuActive[ownerId]
      s78(host.state).yuanshuLostSeals ??= {}
      const count = (s78(host.state).yuanshuLostSeals[ownerId] ?? 0) + 1
      s78(host.state).yuanshuLostSeals[ownerId] = count
      drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
      if (owner.alive) recover(host as never, ownerId, 1, ownerId, YUANSHU_PIZHI)
    } },
  ],
})

registerSkillRuntime({ id: YUANSHU_ZHONGGU, triggers: [{ event: 'DrawPhase', handle(host, ownerId, context) {
  const payload = context.event.payload as { playerId?: PlayerId; count?: number }
  const owner = player(host.state, ownerId)
  if (payload.playerId !== ownerId || owner?.identity !== 'lord') return
  const qunCount = host.state.players.filter((candidate) => candidate.alive
    && (candidate.nationalWarFaction ?? candidate.kingdomOverride
      ?? ALL_CHARACTERS.find((character) => character.id === candidate.characterId)?.kingdom) === 'qun').length
  payload.count = Math.max(0, Number(payload.count ?? 2) + (host.state.roundNumber >= qunCount ? 2 : -1))
} }] })

const YI_PILE = 'yi-caoxian'

function taggedQin(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return s78(state).qinCards?.[ownerId] ?? []
}

function registerQiqin(skillId: string) {
  registerSkillRuntime({
    id: skillId,
    onGameStart(host, ownerId) {
      const owner = player(host.state, ownerId)
      if (!owner) return
      s78(host.state).qinCards ??= {}
      s78(host.state).qinCards[ownerId] = [...owner.zones.hand]
    },
    handLimitExempt(state, ownerId, cardId) {
      return taggedQin(state, ownerId).includes(cardId)
    },
    triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
      const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (playerId !== ownerId || phase !== 'prepare') return
      const owner = player(host.state, ownerId)
      if (!owner) return
      const recoverable = taggedQin(host.state, ownerId).filter((id) => host.state.zones.discardPile.includes(id))
      for (const cardId of recoverable) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      if (recoverable.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: recoverable, reason: skillId },
        { targetId: ownerId, cardIds: recoverable })
    } }],
  })
}

registerQiqin(DAQIAO_QIQIN)
registerQiqin(XIAOQIAO_QIQIN)

registerSkillRuntime({ id: DAQIAO_ZIXI,
  repeatTargetEffectCount(state, _ownerId, targetId, cardId) {
    const source = player(state, _ownerId)
    const target = player(state, targetId)
    const cardName = state.cards[cardId]?.name
    if (!source || !target || (cardName !== '杀' && (!cardName || !INSTANT_TRICKS.has(cardName)))) return 0
    return target.zones.judgingArea.length === 1 && (s78(state).zixiRepeatCards ?? []).includes(cardId) ? 1 : 0
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (playerId === ownerId && phase === 'play') host.queueSkill({ skillId: DAQIAO_ZIXI, ownerId, step: 'place', data: { window: 'start' } })
  } }, { event: 'PhaseEnd', handle(host, ownerId, context) {
    const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (playerId === ownerId && phase === 'play') host.queueSkill({ skillId: DAQIAO_ZIXI, ownerId, step: 'place', data: { window: 'end' } })
  } }, { event: 'TargetSpecified', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    const targetId = payload.targetIds?.length === 1 ? payload.targetIds[0] : undefined
    const owner = player(host.state, ownerId)
    const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
    if (context.event.sourceId !== ownerId || !targetId || !owner?.alive || !card) return
    if (payload.cardName !== '杀' && !INSTANT_TRICKS.has(payload.cardName ?? '')) return
    const count = player(host.state, targetId)?.zones.judgingArea.length ?? 0
    if (count >= 1 && count <= 3) host.queueSkill({ skillId: DAQIAO_ZIXI, ownerId, step: 'resolve-mark',
      data: { targetId, cardId: payload.cardId, count } })
  } }, { event: 'CardResolved', handle(host, _ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (cardId && s78(host.state).zixiRepeatCards) {
      s78(host.state).zixiRepeatCards = s78(host.state).zixiRepeatCards.filter((id: CardId) => id !== cardId)
    }
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'place') {
      const qin = taggedQin(host.state, ownerId).filter((id) => player(host.state, ownerId)?.zones.hand.includes(id))
      if (!qin.length) return
      askCards(host, DAQIAO_ZIXI, ownerId, 'place-cards', ownerId, qin, `【姊希】（${prompt.data.window === 'start' ? '出牌阶段开始' : '出牌阶段结束'}）：选择至多两张“琴”置入一名角色的判定区`,
        { window: prompt.data.window }, 0, Math.min(2, qin.length))
      return
    }
    if (prompt.step === 'resolve-mark') {
      askOption(host, DAQIAO_ZIXI, ownerId, 'resolve-choice', ownerId,
        `【姊希】：目标判定区有${prompt.data.count}张牌，是否发动？`,
        [{ id: 'yes', label: '发动姊希' }, { id: 'no', label: '不发动' }], prompt.data)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'place-cards') {
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((id) => taggedQin(host.state, ownerId).includes(id) && player(host.state, ownerId)?.zones.hand.includes(id)).slice(0, 2)
      if (!cardIds.length) return
      const targetIds = living(host.state).map((entry) => entry.id)
      askTargets(host, DAQIAO_ZIXI, ownerId, 'place-target', ownerId, targetIds,
        '【姊希】：选择放置“琴”的角色', { cardIds }, 1, 1)
      return
    }
    if (resolution.step === 'place-target') {
      const cardIds = (resolution.data.cardIds as CardId[]).filter((id) => player(host.state, ownerId)?.zones.hand.includes(id))
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!target?.alive || !cardIds.length) return
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'judgingArea', playerId: target.id })
      host.dispatch('SkillActivated', { playerId: ownerId, skillId: DAQIAO_ZIXI, skillName: '姊希',
        logText: `${player(host.state, ownerId)?.nickname ?? '角色'}发动【姊希】，将${cardIds.length}张“琴”置入${target.nickname}的判定区` }, { sourceId: ownerId, targetId: target.id, cardIds })
      return
    }
    if (resolution.step !== 'resolve-choice' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const { targetId, cardId, count } = resolution.data as { targetId: PlayerId; cardId: CardId; count: number }
    const target = player(host.state, targetId)
    if (!target?.alive || target.zones.judgingArea.length !== count || !player(host.state, ownerId)?.alive) return
    host.dispatch('SkillActivated', { playerId: ownerId, skillId: DAQIAO_ZIXI, skillName: '姊希',
      logText: `${player(host.state, ownerId)?.nickname ?? '角色'}发动【姊希】` }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    if (count === 1) {
      s78(host.state).zixiRepeatCards ??= []
      s78(host.state).zixiRepeatCards.push(cardId)
      return
    }
    if (count === 2) {
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      return
    }
    if (count === 3) {
      const field = fieldCards(host.state).filter((entry) => entry.ownerId === targetId)
      const gained: CardId[] = []
      for (const entry of field) {
        if (entry.slot) handleEquipmentLost(host as never, targetId, entry.cardId)
        const from = entry.slot
          ? { kind: 'equipment' as const, playerId: targetId, slot: entry.slot }
          : { kind: 'judgingArea' as const, playerId: targetId }
        moveCard(host.state, entry.cardId, from, { kind: 'hand', playerId: ownerId })
        gained.push(entry.cardId)
      }
      if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: DAQIAO_ZIXI },
        { sourceId: ownerId, targetId: ownerId, cardIds: gained })
      resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: [targetId], amount: 3, nature: 'normal', cardId: null,
        cardName: null, sourceSkillId: DAQIAO_ZIXI })
    }
  },
})

registerSkillRuntime({ id: CAOXIAN_LINGXI,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (playerId === ownerId && phase === 'play') host.queueSkill({ skillId: CAOXIAN_LINGXI, ownerId, step: 'place', data: { window: 'start' } })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (playerId === ownerId && phase === 'play') host.queueSkill({ skillId: CAOXIAN_LINGXI, ownerId, step: 'place', data: { window: 'end' } })
    } },
    { event: 'CharacterPileMoved', handle(host, ownerId, context) {
      const movement = context.event.payload as { ownerId?: PlayerId; pile?: string; direction?: string }
      if (movement.ownerId === ownerId && movement.pile === YI_PILE && movement.direction === 'leave') {
        host.queueSkill({ skillId: CAOXIAN_LINGXI, ownerId, step: 'adjust-hand', data: {} })
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'place') {
      const owner = player(host.state, ownerId)
      if (!owner?.alive || !owner.zones.hand.length) return
      const amount = Math.min(owner.maxHp, owner.zones.hand.length)
      askCards(host, CAOXIAN_LINGXI, ownerId, 'place-cards', ownerId,
        [...owner.zones.hand], `【灵犀】（出牌阶段${prompt.data.window === 'start' ? '开始' : '结束'}）：选择至多${amount}张牌置于武将牌上作为“翼”`,
        { window: prompt.data.window, amount }, 0, amount)
      return
    }
    if (prompt.step !== 'adjust-hand') return
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    const wing = owner.characterPiles[YI_PILE] ?? []
    const suits = new Set(wing.map((id) => effectiveCardSuit(host.state, ownerId, id)))
    const desired = suits.size * 2
    const difference = desired - owner.zones.hand.length
    if (difference > 0) {
      drawCards(host.state, host.rng, ownerId, difference, (name, payload) => host.dispatch(name, payload))
    } else if (difference < 0) {
      askCards(host, CAOXIAN_LINGXI, ownerId, 'discard-to-count', ownerId, [...owner.zones.hand],
        `【灵犀】：弃置${-difference}张手牌，使手牌数等于“翼”花色数的两倍`, { count: -difference }, -difference, -difference)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'place-cards') {
      const owner = player(host.state, ownerId)
      if (!owner?.alive) return
      const amount = Math.min(owner.maxHp, Number(resolution.data.amount ?? 0))
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((id) => owner.zones.hand.includes(id)).slice(0, amount)
      if (!cardIds.length) return
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId },
        { kind: 'characterPile', playerId: ownerId, pile: YI_PILE })
      host.dispatch('SkillActivated', { playerId: ownerId, skillId: CAOXIAN_LINGXI, skillName: '灵犀',
        logText: `${owner.nickname}发动【灵犀】，将${cardIds.length}张牌置为“翼”` }, { sourceId: ownerId, cardIds })
      return
    }
    if (resolution.step !== 'discard-to-count') return
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    const count = Math.min(owner.zones.hand.length, Number(resolution.data.count ?? 0))
    const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((id) => owner.zones.hand.includes(id)).slice(0, count)
    if (cardIds.length !== count) return
    discard(host, ownerId, cardIds, CAOXIAN_LINGXI)
  },
})

registerSkillRuntime({ id: CAOXIAN_ZHIFOU,
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || !player(host.state, ownerId)?.alive) return
      const wings = player(host.state, ownerId)?.characterPiles[YI_PILE] ?? []
      if (!wings.length) return
      const state = s78(host.state)
      state.zhifouUses ??= {}
      const prior = state.zhifouUses[ownerId]
      const record = prior?.turn === host.state.turnNumber ? prior : { turn: host.state.turnNumber, count: 0, options: [] }
      host.queueSkill({ skillId: CAOXIAN_ZHIFOU, ownerId, step: 'invoke', data: { count: record.count + 1,
        cardId: (context.event.payload as { cardId?: CardId }).cardId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const owner = player(host.state, ownerId)
    if (!owner?.alive || !(owner.characterPiles[YI_PILE]?.length)) return
    askOption(host, CAOXIAN_ZHIFOU, ownerId, 'invoke', ownerId,
      `【知否】：是否至少移去${prompt.data.count}张“翼”并令一名角色执行一项效果？`,
      [{ id: 'yes', label: `移去至少${prompt.data.count}张“翼”并执行效果` }, { id: 'no', label: '不发动' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = player(host.state, ownerId)
      const count = Math.trunc(Number(resolution.data.count ?? 0))
      const wings = owner?.characterPiles[YI_PILE] ?? []
      if (!owner?.alive || count < 1 || wings.length < count) return
      const state = s78(host.state)
      state.zhifouUses ??= {}
      const previous = state.zhifouUses[ownerId]
      const record = previous?.turn === host.state.turnNumber ? previous : { turn: host.state.turnNumber, count: 0, options: [] }
      record.count = count
      state.zhifouUses[ownerId] = record
      askCards(host, CAOXIAN_ZHIFOU, ownerId, 'remove-wings', ownerId, [...wings],
        `【知否】：移去至少${count}张“翼”`, { count }, count, wings.length)
      return
    }
    if (resolution.step === 'remove-wings') {
      const count = Math.trunc(Number(resolution.data.count ?? 0))
      const owner = player(host.state, ownerId)
      const wings = owner?.characterPiles[YI_PILE] ?? []
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((id) => wings.includes(id))
      if (!owner?.alive || selected.length < count) return
      for (const cardId of selected) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YI_PILE },
        { kind: 'discardPile' })
      const candidates = living(host.state).filter((target) => {
        const available = cardsInHandAndEquipment(host.state, target.id).length
        return available > 0 || target.hp > 0
      }).map((target) => target.id)
      if (!candidates.length) return
      askTargets(host, CAOXIAN_ZHIFOU, ownerId, 'target', ownerId, candidates,
        '【知否】：选择执行效果的角色', { count }, 1, 1)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!target?.alive) return
      const actualTargetId = target.id
      const use = s78(host.state).zhifouUses?.[ownerId]
      const usedOptions = use?.turn === host.state.turnNumber ? use.options as string[] : []
      const available: Array<{ id: string; label: string }> = []
      if (!usedOptions.includes('put-wing') && cardsInHandAndEquipment(host.state, actualTargetId).length)
        available.push({ id: 'put-wing', label: '将一张牌置于“翼”中' })
      if (!usedOptions.includes('discard-two') && cardsInHandAndEquipment(host.state, actualTargetId).length >= 2)
        available.push({ id: 'discard-two', label: '弃置两张牌' })
      if (!usedOptions.includes('lose-hp')) available.push({ id: 'lose-hp', label: '失去1点体力' })
      if (!available.length) return
      askOption(host, CAOXIAN_ZHIFOU, ownerId, 'effect', ownerId,
        `【知否】：令${target.nickname}执行一项（本回合每项各限一次）`, available, { targetId: actualTargetId })
      return
    }
    if (resolution.step === 'target-put-wing' || resolution.step === 'target-discard-two') {
      const { ownerId: sourceId, targetId: targetPlayerId, optionId } = resolution.data as { ownerId: PlayerId; targetId: PlayerId; optionId: string }
      const source = player(host.state, sourceId)
      const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const available = cardsInHandAndEquipment(host.state, targetPlayerId)
      const needed = resolution.step === 'target-put-wing' ? 1 : 2
      const selected = ids.filter((id) => available.includes(id)).slice(0, needed)
      if (!source?.alive || selected.length !== needed) return
      const use = s78(host.state).zhifouUses?.[sourceId]
      if (!use || use.turn !== host.state.turnNumber || (use.options as string[]).includes(optionId)) return
      if (optionId === 'put-wing') {
        const slot = Object.entries(player(host.state, targetPlayerId)?.zones.equipment ?? {}).find(([, id]) => id === selected[0])?.[0]
        if (slot) handleEquipmentLost(host as never, targetPlayerId, selected[0]!)
        const from = slot
          ? { kind: 'equipment' as const, playerId: targetPlayerId, slot: slot as EquipmentSlot }
          : { kind: 'hand' as const, playerId: targetPlayerId }
        moveCard(host.state, selected[0]!, from, { kind: 'characterPile', playerId: sourceId, pile: YI_PILE })
      } else {
        discard(host, targetPlayerId, selected, CAOXIAN_ZHIFOU)
      }
      use.options.push(optionId)
      return
    }
    if (resolution.step !== 'effect') return
    const optionId = (response.payload as { optionId?: string }).optionId
    const targetId = (resolution.data as { targetId?: PlayerId }).targetId
    const target = targetId ? player(host.state, targetId) : undefined
    const owner = player(host.state, ownerId)
    if (!target?.alive || !owner?.alive || !optionId) return
    const cards = cardsInHandAndEquipment(host.state, target.id)
    if ((optionId === 'put-wing' && !cards.length) || (optionId === 'discard-two' && cards.length < 2)
      || !['put-wing', 'discard-two', 'lose-hp'].includes(optionId)) return
    const state = s78(host.state)
    const use = state.zhifouUses?.[ownerId]
    if (!use || use.turn !== host.state.turnNumber || (use.options as string[]).includes(optionId)) return
    if (optionId === 'put-wing') {
      askCards(host, CAOXIAN_ZHIFOU, ownerId, 'target-put-wing', target.id, cards,
        '【知否】：选择一张牌置于曹宪的“翼”中', { ownerId, targetId: target.id, optionId }, 1, 1)
      return
    }
    if (optionId === 'discard-two') {
      askCards(host, CAOXIAN_ZHIFOU, ownerId, 'target-discard-two', target.id, cards,
        '【知否】：选择弃置两张牌', { ownerId, targetId: target.id, optionId }, 2, 2)
      return
    }
    use.options.push(optionId)
    loseHp(host as never, target.id, 1, CAOXIAN_ZHIFOU)
    return
  },
})

registerSkillRuntime({ id: XIAOQIAO_WEIWAN,
  activeActions(state, ownerId) {
    const qin = taggedQin(state, ownerId).filter((id) => player(state, ownerId)?.zones.hand.includes(id))
    return state.phase === 'play' && player(state, ownerId)?.alive && !usedThisPhase(state, ownerId, XIAOQIAO_WEIWAN) && qin.length
      ? [{ id: 'weiwan:activate', label: '媦婉：弃置一张“琴”并随机获得目标区域中异花色的牌' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'weiwan:activate' || usedThisPhase(host.state, ownerId, XIAOQIAO_WEIWAN)) return
    const qin = taggedQin(host.state, ownerId).filter((id) => player(host.state, ownerId)?.zones.hand.includes(id))
    if (!qin.length) return
    markUsedThisPhase(host.state, ownerId, XIAOQIAO_WEIWAN)
    askCards(host, XIAOQIAO_WEIWAN, ownerId, 'cost', ownerId, qin, '【媦婉】：选择弃置一张“琴”', {}, 1, 1)
  },
  globalIgnoresDistanceTo(state, ownerId, actorId, targetId) {
    const effect = s78(state).weiwanFreedom?.[ownerId]
    return actorId === ownerId && effect?.targetId === targetId && effect.turn === state.turnNumber
  },
  ignoresSlashUsesTo(state, ownerId, targetId) {
    const effect = s78(state).weiwanFreedom?.[ownerId]
    return effect?.targetId === targetId && effect.turn === state.turnNumber
  },
  prohibitsSourceTarget(state, ownerId, targetId, _cardName) {
    const effect = s78(state).weiwanLock?.[ownerId]
    return effect?.targetId === targetId && effect.turn === state.turnNumber
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId)
      if (!cardId || !owner?.zones.hand.includes(cardId) || !taggedQin(host.state, ownerId).includes(cardId)) return
      const suit = effectiveCardSuit(host.state, ownerId, cardId)
      discard(host, ownerId, [cardId], XIAOQIAO_WEIWAN)
      const candidates = living(host.state).filter((target) => target.id !== ownerId && [
        ...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea,
      ].some((id) => effectiveCardSuit(host.state, ownerId, id) !== suit)).map((target) => target.id)
      if (!candidates.length) return
      askTargets(host, XIAOQIAO_WEIWAN, ownerId, 'target', ownerId, candidates,
        '【媦婉】：选择一名其他角色', { suit }, 1, 1)
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host.state, targetId) : undefined
    const suit = (resolution.data as { suit?: string }).suit
    if (!target?.alive || target.id === ownerId || !suit) return
    const moved: CardId[] = []
    const choices = [
      { kind: 'hand' as const, ids: target.zones.hand },
      { kind: 'equipment' as const, ids: Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)) },
      { kind: 'judgingArea' as const, ids: target.zones.judgingArea },
    ]
    for (const zone of choices) {
      const eligible = zone.ids.filter((id) => effectiveCardSuit(host.state, ownerId, id) !== suit)
      const cardId = host.rng.shuffle(eligible)[0]
      if (!cardId) continue
      if (zone.kind === 'equipment') handleEquipmentLost(host as never, target.id, cardId)
      const from = zone.kind === 'equipment'
        ? { kind: 'equipment' as const, playerId: target.id,
          slot: Object.entries(target.zones.equipment).find(([, id]) => id === cardId)?.[0] as EquipmentSlot }
        : zone.kind === 'judgingArea'
          ? { kind: 'judgingArea' as const, playerId: target.id }
          : { kind: 'hand' as const, playerId: target.id }
      moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
      moved.push(cardId)
    }
    if (moved.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: moved, reason: XIAOQIAO_WEIWAN },
      { sourceId: ownerId, targetId: ownerId, cardIds: moved })
    host.dispatch('SkillActivated', { playerId: ownerId, skillId: XIAOQIAO_WEIWAN, skillName: '媦婉',
      logText: `${player(host.state, ownerId)?.nickname ?? '角色'}发动【媦婉】，从${target.nickname}处获得${moved.length}张牌` },
      { sourceId: ownerId, targetId: target.id, cardIds: moved })
    if (moved.length === 1) loseHp(host as never, target.id, 1, XIAOQIAO_WEIWAN)
    if (moved.length === 2) {
      s78(host.state).weiwanFreedom ??= {}
      s78(host.state).weiwanFreedom[ownerId] = { targetId: target.id, turn: host.state.turnNumber }
    }
    if (moved.length === 3) {
      s78(host.state).weiwanLock ??= {}
      s78(host.state).weiwanLock[ownerId] = { targetId: target.id, turn: host.state.turnNumber }
    }
  },
})

registerSkillRuntime({ id: ZHANGCHUNHUA_LIANGYAN,
  activeActions(state, ownerId) {
    return state.phase === 'play' && player(state, ownerId)?.alive && !usedThisPhase(state, ownerId, ZHANGCHUNHUA_LIANGYAN)
      && living(state).some((target) => target.id !== ownerId)
      ? [{ id: 'liangyan:activate', label: '梁燕：选择角色并摸/弃至多两张牌' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'liangyan:activate' || usedThisPhase(host.state, ownerId, ZHANGCHUNHUA_LIANGYAN)) return
    const targets = living(host.state).filter((target) => target.id !== ownerId).map((target) => target.id)
    if (!targets.length) return
    markUsedThisPhase(host.state, ownerId, ZHANGCHUNHUA_LIANGYAN)
    askTargets(host, ZHANGCHUNHUA_LIANGYAN, ownerId, 'target', ownerId, targets,
      '【梁燕】：选择一名其他角色', {}, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || targetId === ownerId || !player(host.state, targetId)?.alive) return
      askOption(host, ZHANGCHUNHUA_LIANGYAN, ownerId, 'mode', ownerId, '【梁燕】：选择你摸牌还是弃牌', [
        { id: 'draw', label: '你摸牌，该角色弃等量的牌' },
        { id: 'discard', label: '你弃牌，该角色摸等量的牌' },
      ], { targetId }, false)
      return
    }
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      const targetId = (resolution.data as { targetId?: PlayerId }).targetId
      if (!targetId || !player(host.state, targetId)?.alive || !['draw', 'discard'].includes(mode ?? '')) return
      const owner = player(host.state, ownerId)
      if (!owner?.alive) return
      const max = Math.min(2, mode === 'draw'
        ? host.state.zones.drawPile.length + host.state.zones.discardPile.length
        : cardsInHandAndEquipment(host.state, ownerId).length)
      if (max < 1) return
      askOption(host, ZHANGCHUNHUA_LIANGYAN, ownerId, 'amount', ownerId,
        `【梁燕】：选择${mode === 'draw' ? '摸' : '弃'}牌数量（至多2张）`,
        Array.from({ length: max }, (_, index) => ({ id: String(index + 1), label: `${index + 1}张` })), { targetId, mode }, false)
      return
    }
    if (resolution.step === 'amount') {
      const data = resolution.data as { targetId?: PlayerId; mode?: 'draw' | 'discard' }
      const target = data.targetId ? player(host.state, data.targetId) : undefined
      const owner = player(host.state, ownerId)
      const count = Number((response.payload as { optionId?: string }).optionId)
      if (!owner?.alive || !target?.alive || !Number.isInteger(count) || count < 1 || count > 2) return
      if (data.mode === 'draw') {
        drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
        const cards = cardsInHandAndEquipment(host.state, target.id)
        const discardCount = Math.min(count, cards.length)
        if (discardCount) askCards(host, ZHANGCHUNHUA_LIANGYAN, ownerId, 'target-discard', target.id, cards,
          `【梁燕】：选择弃置${discardCount}张牌`, { targetId: target.id, drawPlayerId: ownerId, count: discardCount }, discardCount, discardCount)
        else finishLiangyan(host, ownerId, target.id, ownerId)
      } else if (data.mode === 'discard') {
        const cards = cardsInHandAndEquipment(host.state, ownerId)
        const discardCount = Math.min(count, cards.length)
        if (!discardCount) return
        askCards(host, ZHANGCHUNHUA_LIANGYAN, ownerId, 'owner-discard', ownerId, cards,
          `【梁燕】：选择弃置${discardCount}张牌`, { targetId: target.id, drawPlayerId: target.id, count: discardCount }, discardCount, discardCount)
      }
      return
    }
    if (resolution.step === 'owner-discard' || resolution.step === 'target-discard') {
      const { targetId, drawPlayerId, count } = resolution.data as { targetId: PlayerId; drawPlayerId: PlayerId; count: number }
      const discarderId = resolution.step === 'owner-discard' ? ownerId : targetId
      const cards = cardsInHandAndEquipment(host.state, discarderId)
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((id) => cards.includes(id)).slice(0, count)
      if (selected.length !== count) return
      discard(host, discarderId, selected, ZHANGCHUNHUA_LIANGYAN)
      const recipientId = resolution.step === 'owner-discard' ? targetId : ownerId
      drawCards(host.state, host.rng, recipientId, count, (name, payload) => host.dispatch(name, payload))
      finishLiangyan(host, ownerId, targetId, drawPlayerId)
    }
  },
})

function finishLiangyan(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, drawPlayerId: PlayerId) {
  const owner = player(host.state, ownerId)
  const target = player(host.state, targetId)
  if (!owner?.alive || !target?.alive || owner.zones.hand.length !== target.zones.hand.length) return
  schedulePhaseSkipForPlayer(host.state, drawPlayerId, 'discard')
  host.dispatch('SkillActivated', { playerId: ownerId, skillId: ZHANGCHUNHUA_LIANGYAN, skillName: '梁燕',
    logText: `【梁燕】：${player(host.state, drawPlayerId)?.nickname ?? '角色'}跳过下一个弃牌阶段` }, { sourceId: ownerId, targetId: drawPlayerId })
}

registerSkillRuntime({ id: ZHANGCHUNHUA_MINGHUI,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    const others = living(host.state).filter((entry) => entry.id !== ownerId)
    const counts = living(host.state).map((entry) => entry.zones.hand.length)
    const hand = owner.zones.hand.length
    const isMinimum = counts.length > 0 && hand === Math.min(...counts)
    const isMaximum = counts.length > 0 && hand === Math.max(...counts)
    if (isMinimum) host.queueSkill({ skillId: ZHANGCHUNHUA_MINGHUI, ownerId, step: 'minimum-offer',
      data: { turn: host.state.turnNumber, checkMaximumAfter: isMaximum } })
    else if (isMaximum) host.queueSkill({ skillId: ZHANGCHUNHUA_MINGHUI, ownerId, step: 'maximum-offer',
      data: { turn: host.state.turnNumber } })
    void others
  } }, { event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceSkillId?: string }
    const pending = s78(host.state).minghuiPendingMaximum?.[ownerId]
    if (payload.sourceSkillId !== ZHANGCHUNHUA_MINGHUI || pending?.turn !== host.state.turnNumber) return
    delete s78(host.state).minghuiPendingMaximum[ownerId]
    host.queueSkill({ skillId: ZHANGCHUNHUA_MINGHUI, ownerId, step: 'maximum-offer', data: { turn: pending.turn } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'minimum-offer') {
      const owner = player(host.state, ownerId)
      const handCounts = living(host.state).map((entry) => entry.zones.hand.length)
      if (!owner?.alive || owner.zones.hand.length !== Math.min(...handCounts)) return
      askOption(host, ZHANGCHUNHUA_MINGHUI, ownerId, 'minimum-invoke', ownerId,
        '【明慧】：你手牌数全场最少，是否视为使用一张无距离限制的【杀】？',
        [{ id: 'yes', label: '视为使用无距离限制的【杀】' }, { id: 'no', label: '不发动' }], prompt.data)
      return
    }
    if (prompt.step !== 'maximum-offer') return
    const owner = player(host.state, ownerId)
    const counts = living(host.state).map((entry) => entry.zones.hand.length)
    if (!owner?.alive || owner.zones.hand.length !== Math.max(...counts)) return
    const otherMaximum = Math.max(-1, ...living(host.state).filter((entry) => entry.id !== ownerId).map((entry) => entry.zones.hand.length))
    if (otherMaximum < 1) return
    const discardCount = owner.zones.hand.length - (otherMaximum - 1)
    if (discardCount < 1 || discardCount > owner.zones.hand.length) return
    askOption(host, ZHANGCHUNHUA_MINGHUI, ownerId, 'maximum-invoke', ownerId,
      `【明慧】：你手牌数全场最多，是否弃置${discardCount}张手牌后令一名角色回复1点体力？`,
      [{ id: 'yes', label: `弃置${discardCount}张手牌并令一名角色回复1点体力` }, { id: 'no', label: '不发动' }],
      { turn: prompt.data.turn, discardCount })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'minimum-invoke') {
      const data = resolution.data as { turn?: number; checkMaximumAfter?: boolean }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        if (data.checkMaximumAfter) host.queueSkill({ skillId: ZHANGCHUNHUA_MINGHUI, ownerId, step: 'maximum-offer', data: { turn: data.turn } })
        return
      }
      const targets = living(host.state).filter((target) => target.id !== ownerId
        && !isTargetProhibited(host.state, ownerId, target.id, '杀', skillIdsOf)).map((target) => target.id)
      if (!targets.length) {
        if (data.checkMaximumAfter) host.queueSkill({ skillId: ZHANGCHUNHUA_MINGHUI, ownerId, step: 'maximum-offer', data: { turn: data.turn } })
        return
      }
      askTargets(host, ZHANGCHUNHUA_MINGHUI, ownerId, 'minimum-target', ownerId, targets,
        '【明慧】：选择【杀】的目标', { checkMaximumAfter: data.checkMaximumAfter, turn: data.turn }, 1, 1)
      return
    }
    if (resolution.step === 'minimum-target') {
      const data = resolution.data as { checkMaximumAfter?: boolean; turn?: number }
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !player(host.state, targetId)?.alive) return
      const success = host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: ZHANGCHUNHUA_MINGHUI, ignoreDistance: true })
      if (!success && data.checkMaximumAfter) host.queueSkill({ skillId: ZHANGCHUNHUA_MINGHUI, ownerId,
        step: 'maximum-offer', data: { turn: data.turn } })
      else if (success && data.checkMaximumAfter) {
        s78(host.state).minghuiPendingMaximum ??= {}
        s78(host.state).minghuiPendingMaximum[ownerId] = { turn: host.state.turnNumber }
      }
      return
    }
    if (resolution.step === 'maximum-invoke') {
      const data = resolution.data as { turn?: number; discardCount?: number }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = player(host.state, ownerId)
      const count = Math.trunc(Number(data.discardCount ?? 0))
      if (!owner?.alive || count < 1 || owner.zones.hand.length < count) return
      askCards(host, ZHANGCHUNHUA_MINGHUI, ownerId, 'maximum-discard', ownerId, [...owner.zones.hand],
        `【明慧】：选择弃置${count}张手牌`, { count, turn: data.turn }, count, count)
      return
    }
    if (resolution.step === 'maximum-discard') {
      const owner = player(host.state, ownerId)
      const count = Math.trunc(Number(resolution.data.count ?? 0))
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((id) => owner?.zones.hand.includes(id)).slice(0, count)
      if (!owner?.alive || selected.length !== count) return
      discard(host, ownerId, selected, ZHANGCHUNHUA_MINGHUI)
      const otherMaximum = Math.max(-1, ...living(host.state).filter((entry) => entry.id !== ownerId).map((entry) => entry.zones.hand.length))
      if (owner.zones.hand.length >= otherMaximum) return
      const targets = living(host.state).map((entry) => entry.id)
      if (targets.length) askTargets(host, ZHANGCHUNHUA_MINGHUI, ownerId, 'maximum-recover', ownerId, targets,
        '【明慧】：选择一名角色回复1点体力', {}, 1, 1)
      return
    }
    if (resolution.step === 'maximum-recover') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive) recover(host as never, targetId, 1, ownerId, ZHANGCHUNHUA_MINGHUI)
    }
  },
})

registerSkillRuntime({ id: XIAHOU_MAO_TONGWEI,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return state.phase === 'play' && owner?.alive && !usedThisPhase(state, ownerId, XIAHOU_MAO_TONGWEI)
      && owner.zones.hand.length >= 2 && living(state).some((target) => target.id !== ownerId)
      ? [{ id: 'tongwei:activate', label: '统围：选择角色并重铸两张手牌' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'tongwei:activate' || usedThisPhase(host.state, ownerId, XIAHOU_MAO_TONGWEI)) return
    const targets = living(host.state).filter((target) => target.id !== ownerId).map((target) => target.id)
    if (!targets.length || (player(host.state, ownerId)?.zones.hand.length ?? 0) < 2) return
    markUsedThisPhase(host.state, ownerId, XIAHOU_MAO_TONGWEI)
    askTargets(host, XIAHOU_MAO_TONGWEI, ownerId, 'target', ownerId, targets,
      '【统围】：选择一名其他角色', {}, 1, 1)
  },
  triggers: [
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const targetId = context.event.sourceId
      const pending = targetId ? s78(host.state).tongweiPending?.[targetId] : undefined
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (pending && cardId && !pending.usedCardId) pending.usedCardId = cardId
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const targetId = context.event.sourceId
      const payload = context.event.payload as { cardId?: CardId }
      const pending = targetId ? s78(host.state).tongweiPending?.[targetId] : undefined
      if (!pending || pending.usedCardId !== payload.cardId) return
      delete s78(host.state).tongweiPending[targetId!]
      const target = player(host.state, targetId!)
      const rank = payload.cardId ? host.state.cards[payload.cardId]?.rank : undefined
      if (!target?.alive || !Number.isInteger(rank) || !(rank! > pending.low && rank! < pending.high)) return
      const options: Array<{ id: string; label: string }> = []
      if (canTarget(host.state, ownerId, target.id, getAttackRange(host.state, ownerId))
        && !isTargetProhibited(host.state, ownerId, target.id, '杀', skillIdsOf))
        options.push({ id: 'slash', label: '视为对其使用【杀】' })
      if (getDistance(host.state, ownerId, target.id) <= 1
        && !isTargetProhibited(host.state, ownerId, target.id, '顺手牵羊', skillIdsOf))
        options.push({ id: 'snatch', label: '视为对其使用【顺手牵羊】' })
      if (options.length) host.queueSkill({ skillId: XIAHOU_MAO_TONGWEI, ownerId, step: 'choose-counter',
        data: { targetId: target.id, options: options.map(({ id }) => id) } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-counter') return
    const targetId = prompt.data.targetId as PlayerId
    const target = player(host.state, targetId)
    if (!target?.alive) return
    const legal = (prompt.data.options as string[]).filter((option) => option === 'slash'
      ? canTarget(host.state, ownerId, targetId, getAttackRange(host.state, ownerId))
        && !isTargetProhibited(host.state, ownerId, targetId, '杀', skillIdsOf)
      : getDistance(host.state, ownerId, targetId) <= 1
        && !isTargetProhibited(host.state, ownerId, targetId, '顺手牵羊', skillIdsOf))
    if (!legal.length) return
    askOption(host, XIAHOU_MAO_TONGWEI, ownerId, 'counter', ownerId, `【统围】：对${target.nickname}使用一张牌`,
      legal.map((id) => ({ id, label: id === 'slash' ? '【杀】' : '【顺手牵羊】' })), { targetId }, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = player(host.state, ownerId)
      if (!targetId || targetId === ownerId || !player(host.state, targetId)?.alive || !owner?.alive || owner.zones.hand.length < 2) return
      askCards(host, XIAHOU_MAO_TONGWEI, ownerId, 'recast', ownerId, [...owner.zones.hand],
        '【统围】：选择两张手牌重铸', { targetId }, 2, 2)
      return
    }
    if (resolution.step === 'recast') {
      const targetId = (resolution.data as { targetId?: PlayerId }).targetId
      const owner = player(host.state, ownerId)
      const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const selected = ids.filter((id) => owner?.zones.hand.includes(id)).slice(0, 2)
      if (!targetId || !player(host.state, targetId)?.alive || selected.length !== 2) return
      const ranks = selected.map((id) => host.state.cards[id]?.rank ?? 0)
      discardCardsByIds(host as never, ownerId, selected, `${XIAHOU_MAO_TONGWEI}:recast`, 'other')
      s78(host.state).tongweiPending ??= {}
      s78(host.state).tongweiPending[targetId] = { targetId, low: Math.min(...ranks), high: Math.max(...ranks), usedCardId: null }
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      return
    }
    if (resolution.step !== 'counter') return
    const optionId = (response.payload as { optionId?: string }).optionId
    const targetId = (resolution.data as { targetId?: PlayerId }).targetId
    if (!targetId || !player(host.state, targetId)?.alive) return
    if (optionId === 'slash') host.beginVirtualSlash({ sourceId: ownerId, targetId,
      sourceSkillId: XIAHOU_MAO_TONGWEI, countUsage: true })
    else if (optionId === 'snatch') host.beginVirtualTrick({ sourceId: ownerId, targetId,
      cardName: '顺手牵羊', sourceSkillId: XIAHOU_MAO_TONGWEI })
  },
})

registerSkillRuntime({ id: XIAHOU_MAO_CUGUO,
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceSkillId?: string; nullifiedTargetIds?: PlayerId[]; cancelledTargetIds?: PlayerId[];
      cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    const cancelledTargets = [...new Set([...(payload.nullifiedTargetIds ?? []), ...(payload.cancelledTargetIds ?? [])])]
    if (payload.sourceSkillId === XIAHOU_MAO_CUGUO) {
      if (cancelledTargets.length && player(host.state, ownerId)?.alive) loseHp(host as never, ownerId, 1, XIAHOU_MAO_CUGUO)
      return
    }
    if (context.event.sourceId !== ownerId || !cancelledTargets.length || !player(host.state, ownerId)?.alive) return
    s78(host.state).cuguoUsed ??= {}
    if (s78(host.state).cuguoUsed[ownerId] === host.state.turnNumber) return
    s78(host.state).cuguoUsed[ownerId] = host.state.turnNumber
    host.queueSkill({ skillId: XIAHOU_MAO_CUGUO, ownerId, step: 'pay-recast', data: {
      targetIds: cancelledTargets, cardName: payload.cardName, cardId: payload.cardId,
    } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pay-recast') return
    const costs = cardsInHandAndEquipment(host.state, ownerId)
    if (!costs.length) return
    askCards(host, XIAHOU_MAO_CUGUO, ownerId, 'cost', ownerId, costs,
      '【蹙国】：弃置一张牌，令此牌对一个被抵消的目标再结算一次', prompt.data, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId)
      const candidates = ((resolution.data.targetIds as PlayerId[]) ?? [])
        .filter((id) => player(host.state, id)?.alive)
      if (!owner?.alive || !cardId || !cardsInHandAndEquipment(host.state, ownerId).includes(cardId) || !candidates.length) return
      discardCardsByIds(host as never, ownerId, [cardId], XIAHOU_MAO_CUGUO)
      const data = { cardName: resolution.data.cardName as string, cardId: resolution.data.cardId as CardId | undefined }
      if (candidates.length === 1) repeatXiahouCard(host, ownerId, candidates[0]!, data)
      else askTargets(host, XIAHOU_MAO_CUGUO, ownerId, 'repeat-target', ownerId, candidates,
        '【蹙国】：选择令此牌再结算一次的目标', data, 1, 1)
      return
    }
    if (resolution.step !== 'repeat-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !player(host.state, targetId)?.alive) return
    repeatXiahouCard(host, ownerId, targetId, resolution.data as { cardName: string; cardId?: CardId })
  },
})

function repeatXiahouCard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId,
  data: { cardName: string; cardId?: CardId }) {
  if (data.cardName === '杀') {
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: XIAHOU_MAO_CUGUO,
      nature: data.cardId ? effectiveDamageNature(host.state, data.cardId) : 'normal' })
  } else if (DELAYED_TRICKS.has(data.cardName)) {
    host.beginVirtualDelayedTrick({ sourceId: ownerId, targetId, cardName: data.cardName, sourceSkillId: XIAHOU_MAO_CUGUO })
  } else if (INSTANT_TRICKS.has(data.cardName)) {
    host.beginVirtualTrick({ sourceId: ownerId, targetId, cardName: data.cardName, sourceSkillId: XIAHOU_MAO_CUGUO })
  }
}

// 争擎 uses completed damage events, not damage intents: prevented damage and
// damage that never settled must not enter the round leaderboard.
registerSkillRuntime({ id: XUCHU_ZHENGQING,
  triggers: [
    { event: 'DamageSettled', handle(host, _ownerId, context) {
      const payload = context.event.payload as { finalAmount?: number }
      const sourceId = context.event.sourceId
      if (!sourceId || !Number.isFinite(payload.finalAmount) || Number(payload.finalAmount) <= 0) return
      const state = s78(host.state)
      const key = `${host.state.roundNumber}:${host.state.turnNumber}`
      state.zhengqingTurnDamage ??= {}
      const row = state.zhengqingTurnDamage[key] ??= { round: host.state.roundNumber, totals: {} }
      row.totals[sourceId] = Number(row.totals[sourceId] ?? 0) + Number(payload.finalAmount)
    } },
    { event: 'RoundEnd', handle(host, ownerId) {
      const owner = player(host.state, ownerId)
      if (!owner?.alive) return
      const state = s78(host.state)
      const round = host.state.roundNumber
      const rows = Object.values(state.zhengqingTurnDamage ?? {}) as Array<{ round: number; totals: Record<PlayerId, number> }>
      const roundRows = rows.filter((row) => row.round === round)
      const maximum = Math.max(0, ...roundRows.flatMap((row) => Object.values(row.totals)))
      for (const candidate of host.state.players) candidate.marks[XUCHU_QING_MARK] = 0
      if (maximum > 0) {
        const winners = [...new Set(roundRows.flatMap((row) => Object.entries(row.totals)
          .filter(([, amount]) => amount === maximum).map(([id]) => id as PlayerId)))].filter((id) => player(host.state, id)?.alive)
        for (const winnerId of winners) {
          const winner = player(host.state, winnerId)!
          winner.marks[XUCHU_QING_MARK] = maximum
          if (winnerId === ownerId) {
            drawCards(host.state, host.rng, ownerId, Math.min(5, maximum), (name, payload) => host.dispatch(name, payload))
          } else {
            winner.marks[XUCHU_QING_MARK] = maximum
            drawCards(host.state, host.rng, winnerId, 1, (name, payload) => host.dispatch(name, payload))
            drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
          }
        }
      }
      for (const [key, row] of Object.entries(state.zhengqingTurnDamage ?? {}))
        if ((row as { round: number }).round <= round) delete state.zhengqingTurnDamage[key]
    } },
  ],
})

registerSkillRuntime({ id: XUCHU_ZHUANGPO,
  viewAs(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive || state.phase !== 'play') return []
    return owner.zones.hand.filter((cardId) => (state.cards[cardId]?.name ?? '').includes('杀'))
      .map((cardId) => ({ asCardName: '决斗', cardId, label: `将【${state.cards[cardId]?.name}】当【决斗】使用` }))
  },
  triggers: [{ event: 'TargetSpecified', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceId?: PlayerId; cardName?: string; cardId?: CardId; targetIds?: PlayerId[] }
    if (context.event.sourceId !== ownerId || payload.cardName !== '决斗' || !payload.cardId) return
    if (host.state.cardUseSourceSkills?.[payload.cardId] !== XUCHU_ZHUANGPO) return
    const markedTargets = (payload.targetIds ?? []).filter((id) => (player(host.state, id)?.marks[XUCHU_QING_MARK] ?? 0) > 0)
    s78(host.state).zhuangpoTargeted ??= {}
    s78(host.state).zhuangpoTargeted[payload.cardId] = { markedTargets }
    const qing = Math.max(0, Math.trunc(Number(player(host.state, ownerId)?.marks[XUCHU_QING_MARK] ?? 0)))
    const maxDiscard = Math.min(qing, Math.max(0, ...(payload.targetIds ?? []).map((id) => cardsInHandAndEquipment(host.state, id).length)))
    const discardable = maxDiscard > 0
    if (qing > 0 && discardable) askOption(host, XUCHU_ZHUANGPO, ownerId, 'spend-qing', ownerId,
      '【壮魄】：是否移去“擎”并令此【决斗】目标弃置等量的牌？',
      [{ id: '0', label: '不移去“擎”' }, ...Array.from({ length: maxDiscard }, (_, index) => ({ id: String(index + 1), label: `移去${index + 1}个“擎”` }))],
      { cardId: payload.cardId, targetIds: payload.targetIds ?? [] })
  } }, { event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceId?: PlayerId; cardId?: CardId; cardName?: string; sourceSkillId?: string }
    const tagged = payload.cardId ? s78(host.state).zhuangpoTargeted?.[payload.cardId] : undefined
    if (!tagged) return
    delete s78(host.state).zhuangpoTargeted[payload.cardId!]
    if (context.event.sourceId !== ownerId || payload.cardName !== '决斗') return
    if ((tagged.markedTargets as PlayerId[]).length) drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'spend-qing') {
      const count = Number((response.payload as { optionId?: string }).optionId)
      const cardId = (resolution.data as { cardId?: CardId }).cardId
      const targetIds = (resolution.data as { targetIds?: PlayerId[] }).targetIds ?? []
      const availableMark = Math.max(0, Math.trunc(Number(player(host.state, ownerId)?.marks[XUCHU_QING_MARK] ?? 0)))
      if (!cardId || !Number.isInteger(count) || count < 0 || count > availableMark || !count) return
      const candidates = targetIds.filter((id) => cardsInHandAndEquipment(host.state, id).length >= count)
      if (candidates.length === 1) askCards(host, XUCHU_ZHUANGPO, ownerId, 'discard-target', candidates[0]!,
        cardsInHandAndEquipment(host.state, candidates[0]!), `【壮魄】：选择${count}张牌弃置`, { cardId, count, targetId: candidates[0] }, count, count)
      else if (candidates.length > 1) askTargets(host, XUCHU_ZHUANGPO, ownerId, 'discard-target-choice', ownerId, candidates,
        '【壮魄】：选择弃置牌的角色', { cardId, count }, 1, 1)
      return
    }
    if (resolution.step === 'discard-target-choice') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const { cardId, count } = resolution.data as { cardId?: CardId; count?: number }
      const cards = targetId ? cardsInHandAndEquipment(host.state, targetId) : []
      if (!targetId || !cardId || cards.length < Number(count)) return
      askCards(host, XUCHU_ZHUANGPO, ownerId, 'discard-target', targetId, cards,
        `【壮魄】：选择${count}张牌弃置`, { cardId, count, targetId }, Number(count), Number(count))
      return
    }
    if (resolution.step !== 'discard-target') return
    const { cardId, count, targetId } = resolution.data as { cardId?: CardId; count?: number; targetId?: PlayerId }
    if (!targetId) return
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    const currentCards = cardsInHandAndEquipment(host.state, targetId)
    const currentMark = Math.max(0, Math.trunc(Number(player(host.state, ownerId)?.marks[XUCHU_QING_MARK] ?? 0)))
    if (!cardId || !Number.isInteger(count) || Number(count) < 1 || currentMark < Number(count)
      || selected.length !== Number(count) || selected.some((id) => !currentCards.includes(id))) return
    const owner = player(host.state, ownerId)
    if (!owner) return
    owner.marks[XUCHU_QING_MARK] = currentMark - Number(count)
    discard(host, targetId, selected, XUCHU_ZHUANGPO)
  },
  outgoingDamage(state, _ownerId, context) {
    if (context.cardName !== '决斗' || !context.cardId) return null
    const tagged = s78(state).zhuangpoTargeted?.[context.cardId]
    return (tagged?.markedTargets as PlayerId[] | undefined)?.includes(context.targetId) ? { amount: context.amount + 1 } : null
  },
})

registerSkillRuntime({ id: YUANSHAO_JIAOWANG,
  triggers: [{ event: 'Death', handle(host) {
    s78(host.state).yuanshaoRoundDeaths ??= {}
    s78(host.state).yuanshaoRoundDeaths[host.state.roundNumber] = true
  } }, { event: 'RoundEnd', handle(host, ownerId) {
    const state = s78(host.state)
    const round = host.state.roundNumber
    if (state.yuanshaoRoundDeaths?.[round]) { delete state.yuanshaoRoundDeaths[round]; return }
    if (!player(host.state, ownerId)?.alive) return
    loseHp(host as never, ownerId, 1, YUANSHAO_JIAOWANG)
    if (player(host.state, ownerId)?.alive) host.queueSkill({ skillId: YUANSHAO_XIAOYAN, ownerId, step: 'xiaoyan-start', data: { roundEnd: true } })
  } }],
})

registerSkillRuntime({ id: YUANSHAO_XIAOYAN,
  onGameStart(host, ownerId) {
    const targets = living(host.state).filter((target) => target.id !== ownerId).sort((a, b) => a.seat - b.seat).map((target) => target.id)
    if (targets.length) host.queueSkill({ skillId: YUANSHAO_XIAOYAN, ownerId, step: 'ignite', data: { targetIds: targets, index: 0 } })
  },
  triggers: [{ event: 'DamageSequenceResolved', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== YUANSHAO_XIAOYAN) return
    const targets = (context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    host.queueSkill({ skillId: YUANSHAO_XIAOYAN, ownerId, step: 'offer-gifts', data: { targetIds: targets, index: 0 } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ignite') {
      const ids = ((prompt.data.targetIds as PlayerId[]) ?? []).filter((id) => player(host.state, id)?.alive)
      if (ids.length) resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: ids, amount: 1, nature: 'fire',
        cardId: null, cardName: null, sourceSkillId: YUANSHAO_XIAOYAN })
      else host.queueSkill({ skillId: YUANSHAO_XIAOYAN, ownerId, step: 'offer-gifts', data: { targetIds: [], index: 0 } })
      return
    }
    if (prompt.step !== 'offer-gifts') return
    const targetIds = (prompt.data.targetIds as PlayerId[]) ?? []
    const index = Number(prompt.data.index ?? 0)
    while (index < targetIds.length) {
      const targetId = targetIds[index]!
      const target = player(host.state, targetId)
      const owner = player(host.state, ownerId)
      if (!target?.alive || !owner?.alive || target.zones.hand.length === 0) { host.queueSkill({ skillId: YUANSHAO_XIAOYAN, ownerId,
        step: 'offer-gifts', data: { targetIds, index: index + 1 } }); return }
      askOption(host, YUANSHAO_XIAOYAN, ownerId, 'give-or-pass', targetId,
        `【硝焰】：是否交给${owner.nickname}一张手牌并回复1点体力？`,
        [{ id: 'give', label: '交给一张手牌并回复1点体力' }, { id: 'pass', label: '不交' }],
        { targetIds, index, targetId })
      return
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'give-or-pass') {
      const { targetIds, index, targetId } = resolution.data as { targetIds: PlayerId[]; index: number; targetId: PlayerId }
      const target = player(host.state, targetId)
      const owner = player(host.state, ownerId)
      if ((response.payload as { optionId?: string }).optionId === 'give' && target?.alive && owner?.alive && target.zones.hand.length) {
        askCards(host, YUANSHAO_XIAOYAN, ownerId, 'choose-gift', targetId, [...target.zones.hand],
          '【硝焰】：选择交给袁绍的一张手牌', { targetIds, index, targetId }, 1, 1)
        return
      }
      host.queueSkill({ skillId: YUANSHAO_XIAOYAN, ownerId, step: 'offer-gifts', data: { targetIds, index: index + 1 } })
      return
    }
    if (resolution.step !== 'choose-gift') return
    const { targetIds, index, targetId } = resolution.data as { targetIds: PlayerId[]; index: number; targetId: PlayerId }
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const target = player(host.state, targetId)
    const owner = player(host.state, ownerId)
    if (cardId && target?.alive && owner?.alive && target.zones.hand.includes(cardId)) {
      const given = giveCards(host as never, targetId, ownerId, [cardId], YUANSHAO_XIAOYAN)
      if (given.length) recover(host as never, targetId, 1, ownerId)
    }
    host.queueSkill({ skillId: YUANSHAO_XIAOYAN, ownerId, step: 'offer-gifts', data: { targetIds, index: index + 1 } })
  },
})

registerSkillRuntime({ id: YUANSHAO_ZONGSHI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !player(state, ownerId)?.alive) return []
    return zongshiPrototypes(state, ownerId).length
      ? [{ id: 'zongshi:activate', label: '纵势：展示一张基本牌或普通锦囊牌' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'zongshi:activate' || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
    const prototypes = zongshiPrototypes(host.state, ownerId)
    if (prototypes.length) askCards(host, YUANSHAO_ZONGSHI, ownerId, 'prototype', ownerId, prototypes,
      '【纵势】：选择展示一张基本牌或普通锦囊牌', {}, 1, 1)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'granted-use') return
    const prototypes = zongshiPrototypes(host.state, ownerId)
    if (prototypes.length) askCards(host, YUANSHAO_ZONGSHI, ownerId, 'prototype', ownerId, prototypes,
      '【傲势】：选择展示一张基本牌或普通锦囊牌以发动【纵势】', { granted: true }, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'prototype') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !zongshiPrototypes(host.state, ownerId).includes(cardId)) return
      askZongshiTargets(host, ownerId, cardId, Boolean(resolution.data.granted))
      return
    }
    if (resolution.step !== 'targets') return
    const data = resolution.data as { prototypeCardId?: CardId; materialIds?: CardId[]; cardName?: string; granted?: boolean }
    if (!data.prototypeCardId || !data.cardName || !Array.isArray(data.materialIds)) return
    const selected = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
    executeZongshiUse(host, ownerId, { prototypeCardId: data.prototypeCardId, materialIds: data.materialIds,
      cardName: data.cardName, granted: Boolean(data.granted) }, selected)
  },
})

function zongshiPrototypes(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = player(state, ownerId)
  return owner?.zones.hand.filter((id) => {
    const card = state.cards[id]
    if (!(card?.category === 'basic' || (card?.category === 'trick' && INSTANT_TRICKS.has(card.name)))) return false
    if (!owner.zones.hand.some((materialId) => materialId !== id
      && effectiveCardSuit(state, ownerId, materialId) === effectiveCardSuit(state, ownerId, id))) return false
    return declaredCardActions(state, ownerId, id, card.name, `【纵势】：使用【${card.name}】`)
      .some((action) => action.kind === 'use-card' && action.asCardName === card.name)
  }) ?? []
}

function askZongshiTargets(host: SkillHost, ownerId: PlayerId, prototypeCardId: CardId, granted: boolean) {
  const card = host.state.cards[prototypeCardId]
  const owner = player(host.state, ownerId)
  if (!card || !owner?.alive || !owner.zones.hand.includes(prototypeCardId)) return
  const suit = effectiveCardSuit(host.state, ownerId, prototypeCardId)
  const materialIds = owner.zones.hand.filter((id) => id !== prototypeCardId && effectiveCardSuit(host.state, ownerId, id) === suit)
  if (!materialIds.length) return
  const actions = declaredCardActions(host.state, ownerId, prototypeCardId, card.name, `【纵势】：使用【${card.name}】`)
    .filter((action): action is Extract<ReturnType<typeof declaredCardActions>[number], { kind: 'use-card' }> =>
      action.kind === 'use-card' && action.asCardName === card.name && !action.id.startsWith('play:recast:'))
  if (!actions.length) return
  const candidateIds = [...new Set(actions.flatMap((action) => action.targetIds))]
    .filter((id) => player(host.state, id)?.alive)
  const allowsNoTarget = actions.some((action) => action.targetIds.length === 0)
  const maxTargets = Math.min(materialIds.length, candidateIds.length)
  const minTargets = allowsNoTarget ? 0 : Math.min(...actions.map((action) => action.targetIds.length))
  const data = { prototypeCardId, materialIds, cardName: card.name, granted }
  if (minTargets > maxTargets) return
  if (maxTargets === 0) {
    if (allowsNoTarget) executeZongshiUse(host, ownerId, data, [])
    return
  }
  askTargets(host, YUANSHAO_ZONGSHI, ownerId, 'targets', ownerId, candidateIds,
    `【纵势】：选择至多${maxTargets}名角色为目标`, data, minTargets, maxTargets)
}

function executeZongshiUse(host: SkillHost, ownerId: PlayerId,
  data: { prototypeCardId: CardId; materialIds: CardId[]; cardName: string; granted: boolean }, targetIds: PlayerId[]) {
  const owner = player(host.state, ownerId)
  const prototype = host.state.cards[data.prototypeCardId]
  if (!owner?.alive || !prototype || !owner.zones.hand.includes(data.prototypeCardId)) return
  const suit = effectiveCardSuit(host.state, ownerId, data.prototypeCardId)
  const materials = owner.zones.hand.filter((id) => id !== data.prototypeCardId && effectiveCardSuit(host.state, ownerId, id) === suit)
  if (!materials.length || materials.length !== data.materialIds.length || materials.some((id) => !data.materialIds.includes(id))) return
  const actions = declaredCardActions(host.state, ownerId, data.prototypeCardId, data.cardName, `【纵势】：使用【${data.cardName}】`)
    .filter((action): action is Extract<ReturnType<typeof declaredCardActions>[number], { kind: 'use-card' }> =>
      action.kind === 'use-card' && action.asCardName === data.cardName && !action.id.startsWith('play:recast:'))
  const candidates = new Set(actions.flatMap((action) => action.targetIds))
  const selected = [...new Set(targetIds)]
  if (selected.length > Math.min(materials.length, candidates.size)
    || selected.some((id) => !candidates.has(id) || !player(host.state, id)?.alive)
    || (!selected.length && !actions.some((action) => action.targetIds.length === 0))) return
  const minTargets = Math.min(...actions.map((action) => action.targetIds.length))
  if (selected.length < minTargets) return
  const actionsWithMultiTargets = actions.filter((action) => action.targetIds.length > 1)
  if (selected.length > 1 && actionsWithMultiTargets.length) {
    for (let left = 0; left < selected.length; left += 1) for (let right = left + 1; right < selected.length; right += 1) {
      if (!actionsWithMultiTargets.some((action) => selected[left] !== selected[right]
        && action.targetIds.includes(selected[left]!) && action.targetIds.includes(selected[right]!))) return
    }
  }
  const representative = actions.find((action) => action.targetIds.length === 0)
    ?? actions.find((action) => action.targetIds.length === 1 && selected.includes(action.targetIds[0]!))
    ?? actions[0]
  if (!representative) return
  const virtualId = `virtual:${YUANSHAO_ZONGSHI}:${host.state.seq + 1}:${host.state.decisions.length}` as CardId
  host.state.cards[virtualId] = { ...prototype, id: virtualId, virtual: true, sourceSkillId: YUANSHAO_ZONGSHI }
  owner.zones.hand.push(virtualId)
  const action = { ...representative, id: `skill:${YUANSHAO_ZONGSHI}:${virtualId}`,
    cardIds: [virtualId, ...materials], targetIds: selected, sourceSkillId: YUANSHAO_ZONGSHI,
    label: `将${materials.length}张同花色手牌当【${data.cardName}】使用` }
  executeUseCardAction(host as never, ownerId, action)
}

registerSkillRuntime({ id: YUANSHAO_AOSHI,
  grantsPlayActions(state, ownerId, actorId) {
    const actor = player(state, actorId)
    const owner = player(state, ownerId)
    const usedTurn = s78(state).aoshiGranted?.[actorId]
    if (!owner?.alive || owner.identity !== 'lord' || !actor?.alive || actor.id === ownerId || factionOf(state, actorId) !== 'qun'
      || state.currentPlayerId !== actorId || state.phase !== 'play' || !actor.zones.hand.length
      || usedTurn === state.turnNumber) return []
    return [{ id: `aoshi:give:${actorId}`, label: '傲势：交给袁绍一张手牌' }]
  },
  invokeGrantedAction(host, ownerId, actorId, actionId) {
    if (actionId !== `aoshi:give:${actorId}`) return
    const actor = player(host.state, actorId)
    const owner = player(host.state, ownerId)
    if (!actor?.alive || !owner?.alive || owner.identity !== 'lord' || factionOf(host.state, actorId) !== 'qun' || actor.id === ownerId
      || host.state.currentPlayerId !== actorId || host.state.phase !== 'play' || !actor.zones.hand.length) return
    s78(host.state).aoshiGranted ??= {}
    s78(host.state).aoshiGranted[actorId] = host.state.turnNumber
    askCards(host, YUANSHAO_AOSHI, ownerId, 'give-card', actorId, [...actor.zones.hand],
      '【傲势】：选择交给袁绍的一张手牌', { actorId }, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke-zongshi') {
      if ((response.payload as { optionId?: string }).optionId === 'yes')
        host.queueSkill({ skillId: YUANSHAO_ZONGSHI, ownerId, step: 'granted-use', data: { fromAoshi: true } })
      return
    }
    if (resolution.step !== 'give-card') return
    const actorId = (resolution.data as { actorId?: PlayerId }).actorId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const actor = actorId ? player(host.state, actorId) : undefined
    const owner = player(host.state, ownerId)
    if (!actorId || !cardId || !actor?.alive || !owner?.alive || !actor.zones.hand.includes(cardId)) return
    if (!giveCards(host as never, actorId, ownerId, [cardId], YUANSHAO_AOSHI).length) return
    askOption(host, YUANSHAO_AOSHI, ownerId, 'invoke-zongshi', ownerId,
      '【傲势】：是否发动一次【纵势】？', [{ id: 'yes', label: '发动【纵势】' }, { id: 'no', label: '不发动' }],
      { actorId, cardId })
  },
})

registerSkillRuntime({ id: SIMAYI_QUANMOU,
  onGameStart(host, ownerId) {
    askOption(host, SIMAYI_QUANMOU, ownerId, 'initial-state', ownerId, '【权谋】：选择初始状态',
      [{ id: 'yang', label: '阳' }, { id: 'yin', label: '阴' }], {}, false)
  },
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !player(state, ownerId)?.alive) return []
    const entries = living(state).filter((target) => target.id !== ownerId && getDistance(state, ownerId, target.id) <= getAttackRange(state, ownerId))
      .filter((target) => s78(state).quanMouUsed?.[ownerId]?.[target.id] !== state.turnNumber)
    return entries.length ? [{ id: 'quan-mou:activate', label: '权谋：令攻击范围内一名角色交给你一张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'quan-mou:activate') return
    const candidates = living(host.state).filter((target) => target.id !== ownerId
      && getDistance(host.state, ownerId, target.id) <= getAttackRange(host.state, ownerId)
      && (s78(host.state).quanMouUsed?.[ownerId]?.[target.id] !== host.state.turnNumber))
      .map((target) => target.id)
    if (candidates.length) askTargets(host, SIMAYI_QUANMOU, ownerId, 'target', ownerId, candidates,
      '【权谋】：选择一名攻击范围内的其他角色', {}, 1, 1)
  },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (playerId === ownerId && phase === 'play') delete s78(host.state).quanMouPending?.[ownerId]
  } }, { event: 'DamageSettled', handle(host, ownerId, context) {
    const targetId = context.event.targetId
    const pending = s78(host.state).quanMouPending?.[ownerId]
    if (!pending || pending.turn !== host.state.turnNumber || pending.targetId !== targetId
      || context.event.sourceId !== ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) < 1) return
    delete s78(host.state).quanMouPending[ownerId]
    if (pending.state === 'yin') host.queueSkill({ skillId: SIMAYI_QUANMOU, ownerId, step: 'splash', data: { excluded: targetId } })
  } }],
  preventsDamage(state, ownerId, side, context) {
    const pending = s78(state).quanMouPending?.[ownerId]
    if (side !== 'source' || pending?.turn !== state.turnNumber || pending.targetId !== context.targetId || pending.state !== 'yang') return false
    delete s78(state).quanMouPending[ownerId]
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'splash') return
    const excluded = (prompt.data as { excluded?: PlayerId }).excluded
    const candidates = living(host.state).filter((target) => target.id !== ownerId && target.id !== excluded).map((target) => target.id)
    if (candidates.length) askTargets(host, SIMAYI_QUANMOU, ownerId, 'splash-targets', ownerId, candidates,
      '【权谋】：选择至多三名其他角色各受到1点伤害（可少选）', prompt.data, 0, Math.min(3, candidates.length))
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'initial-state') {
      const choice = (response.payload as { optionId?: 'yang' | 'yin' }).optionId
      if (choice === 'yang' || choice === 'yin') {
        setConversionState(host.state, ownerId, SIMAYI_QUANMOU, choice)
        host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: SIMAYI_QUANMOU, state: choice }, { sourceId: ownerId })
      }
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      const owner = player(host.state, ownerId)
      if (!target?.alive || !owner?.alive || getDistance(host.state, ownerId, target.id) > getAttackRange(host.state, ownerId) || !target.zones.hand.length) return
      askCards(host, SIMAYI_QUANMOU, ownerId, 'give-card', target.id, [...target.zones.hand],
        '【权谋】：交给司马懿一张手牌', { targetId }, 1, 1)
      return
    }
    if (resolution.step === 'give-card') {
      const targetId = (resolution.data as { targetId?: PlayerId }).targetId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      const owner = player(host.state, ownerId)
      if (!targetId || !cardId || !target?.alive || !owner?.alive || !target.zones.hand.includes(cardId)
        || getDistance(host.state, ownerId, targetId) > getAttackRange(host.state, ownerId)) return
      giveCards(host as never, targetId, ownerId, [cardId], SIMAYI_QUANMOU)
      s78(host.state).quanMouUsed ??= {}; s78(host.state).quanMouUsed[ownerId] ??= {}
      s78(host.state).quanMouUsed[ownerId][targetId] = host.state.turnNumber
      s78(host.state).quanMouPending ??= {}
      s78(host.state).quanMouPending[ownerId] = { targetId, turn: host.state.turnNumber,
        state: conversionStateOf(host.state, ownerId, SIMAYI_QUANMOU) }
      return
    }
    if (resolution.step === 'splash-targets') {
      const chosen = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      const excluded = (resolution.data as { excluded?: PlayerId }).excluded
      const legal = chosen.filter((id) => id !== ownerId && id !== excluded && player(host.state, id)?.alive).slice(0, 3)
      if (legal.length) resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: legal,
        amount: 1, nature: 'normal', cardId: null, cardName: null, sourceSkillId: SIMAYI_QUANMOU })
    }
  },
})

registerSkillRuntime({ id: SIMAYI_PINGLIAO,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play') {
        s78(host.state).pingliaoPlayBonus ??= {}
        s78(host.state).pingliaoPlayBonus[ownerId] = { turn: host.state.turnNumber, amount: 0 }
      }
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play') delete s78(host.state).pingliaoPlayBonus?.[ownerId]
    } },
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || !payload.cardId) return
      const owner = player(host.state, ownerId)
      if (!owner?.alive) return
      const responders = host.state.players.filter((target) => target.alive && target.id !== ownerId
        && getDistance(host.state, ownerId, target.id) <= getAttackRange(host.state, ownerId))
        .sort((a, b) => a.seat - b.seat)
      const ownerIndex = responders.findIndex((target) => target.seat > owner.seat)
      const ordered = ownerIndex <= 0 ? responders : [...responders.slice(ownerIndex), ...responders.slice(0, ownerIndex)]
      host.queueSkill({ skillId: SIMAYI_PINGLIAO, ownerId, step: 'ask-red-basic', data: {
        cardId: payload.cardId, targetIds: payload.targetIds ?? [], responderIds: ordered.map(({ id }) => id), index: 0, playedIds: [],
      } })
    } },
  ],
  globalSlashUses(state, ownerId, actorId) {
    const bonus = s78(state).pingliaoPlayBonus?.[ownerId]
    return actorId === ownerId && state.currentPlayerId === ownerId && state.phase === 'play'
      && bonus?.turn === state.turnNumber ? Math.max(0, Math.trunc(Number(bonus.amount ?? 0))) : 0
  },
  concealsSlashTargets(state, ownerId) { return player(state, ownerId)?.alive === true },
  startQueued(host, ownerId, prompt) {
    const data = prompt.data as { cardId: CardId; targetIds: PlayerId[]; responderIds: PlayerId[]; index: number; playedIds: PlayerId[] }
    if (prompt.step === 'ask-red-basic') {
      let index = Number(data.index ?? 0)
      while (index < data.responderIds.length) {
        const responderId = data.responderIds[index]!
        const responder = player(host.state, responderId)
        const options = responder?.zones.hand.filter((id) => host.state.cards[id]?.category === 'basic'
          && effectiveCardColor(host.state, responderId, id) === 'red') ?? []
        if (!responder?.alive || options.length === 0) {
          host.queueSkill({ skillId: SIMAYI_PINGLIAO, ownerId, step: 'ask-red-basic', data: { ...data, index: index + 1 } })
          return
        }
        askOption(host, SIMAYI_PINGLIAO, ownerId, 'choose-red-basic', responderId,
          '【平辽】：是否打出一张红色基本牌？',
          [{ id: 'yes', label: '打出一张红色基本牌' }, { id: 'no', label: '不打出' }],
          { ...data, index, responderId })
        return
      }
      host.queueSkill({ skillId: SIMAYI_PINGLIAO, ownerId, step: 'finish-responses', data })
      return
    }
    if (prompt.step !== 'finish-responses') return
    for (const targetId of data.targetIds) if (!data.playedIds.includes(targetId) && player(host.state, targetId)?.alive)
      lockHandUseAndResponseUntilTurnEnd(host.state, targetId)
    if (data.playedIds.some((id) => !data.targetIds.includes(id)) && player(host.state, ownerId)?.alive) {
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      const bonus = s78(host.state).pingliaoPlayBonus?.[ownerId]
      if (bonus?.turn === host.state.turnNumber) bonus.amount = Math.max(0, Number(bonus.amount ?? 0)) + 1
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-red-basic') {
      const data = resolution.data as { cardId: CardId; targetIds: PlayerId[]; responderIds: PlayerId[]; index: number; playedIds: PlayerId[]; responderId: PlayerId }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        host.queueSkill({ skillId: SIMAYI_PINGLIAO, ownerId, step: 'ask-red-basic', data: { ...data, index: data.index + 1 } })
        return
      }
      const responder = player(host.state, data.responderId)
      const cards = responder?.zones.hand.filter((id) => host.state.cards[id]?.category === 'basic'
        && effectiveCardColor(host.state, data.responderId, id) === 'red') ?? []
      if (cards.length) askCards(host, SIMAYI_PINGLIAO, ownerId, 'play-red-basic', data.responderId, cards,
        '【平辽】：选择打出一张红色基本牌', data, 1, 1)
      else host.queueSkill({ skillId: SIMAYI_PINGLIAO, ownerId, step: 'ask-red-basic', data: { ...data, index: data.index + 1 } })
      return
    }
    if (resolution.step !== 'play-red-basic') return
    const data = resolution.data as { cardId: CardId; targetIds: PlayerId[]; responderIds: PlayerId[]; index: number; playedIds: PlayerId[]; responderId: PlayerId }
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const responder = player(host.state, data.responderId)
    const card = cardId ? host.state.cards[cardId] : undefined
    if (!cardId || !responder?.alive || !responder.zones.hand.includes(cardId) || card?.category !== 'basic'
      || effectiveCardColor(host.state, data.responderId, cardId) !== 'red') {
      host.queueSkill({ skillId: SIMAYI_PINGLIAO, ownerId, step: 'ask-red-basic', data: { ...data, index: data.index + 1 } })
      return
    }
    moveCard(host.state, cardId, { kind: 'hand', playerId: data.responderId }, { kind: 'processingArea' })
    host.dispatch('CardResponded', { asking: false, playerId: data.responderId, cardId, cardName: card.name, reason: '平辽' },
      { sourceId: data.responderId, targetId: ownerId, cardIds: [cardId] })
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    host.dispatch('CardEnteredDiscard', { playerId: data.responderId, cardId, fromKind: 'hand', reason: 'response' },
      { sourceId: data.responderId, cardIds: [cardId] })
    host.queueSkill({ skillId: SIMAYI_PINGLIAO, ownerId, step: 'ask-red-basic', data: {
      ...data, index: data.index + 1, playedIds: [...new Set([...data.playedIds, data.responderId])],
    } })
  },
})

registerSkillRuntime({ id: JIANGJI_SHIJU,
  grantsPlayActions(state, ownerId, actorId) {
    const actor = player(state, actorId)
    if (actorId === ownerId || !actor?.alive || state.currentPlayerId !== actorId || state.phase !== 'play'
      || !actor.zones.hand.length || s78(state).shijuUsed?.[ownerId]?.[actorId] === state.turnNumber) return []
    return [{ id: `shiju:give:${actorId}`, label: '势举：交给谋蒋济一张牌' }]
  },
  invokeGrantedAction(host, ownerId, actorId, actionId) {
    if (actionId !== `shiju:give:${actorId}`) return
    const actor = player(host.state, actorId)
    const owner = player(host.state, ownerId)
    if (actorId === ownerId || !actor?.alive || !owner?.alive || host.state.currentPlayerId !== actorId
      || host.state.phase !== 'play' || !actor.zones.hand.length) return
    s78(host.state).shijuUsed ??= {}; s78(host.state).shijuUsed[ownerId] ??= {}
    if (s78(host.state).shijuUsed[ownerId][actorId] === host.state.turnNumber) return
    s78(host.state).shijuUsed[ownerId][actorId] = host.state.turnNumber
    askCards(host, JIANGJI_SHIJU, ownerId, 'give-card', actorId, [...actor.zones.hand],
      '【势举】：选择交给蒋济的一张牌', { actorId }, 1, 1)
  },
  globalAttackRangeBonus(state, ownerId, actorId) {
    const active = s78(state).shijuRangeBonus?.[ownerId]?.[actorId]
    return active?.turn === state.turnNumber ? Math.max(0, Math.trunc(Number(active.amount ?? 0))) : 0
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; finalAmount?: number }
    const pending = payload.cardId ? s78(host.state).shijuPendingUse?.[payload.cardId] : undefined
    if (context.event.sourceId !== ownerId || !pending || Number(payload.finalAmount ?? 0) <= 0) return
    pending.dealtDamage = true
  } }, { event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; sourceId?: PlayerId }
    const cardId = payload.cardId
    const pending = cardId ? s78(host.state).shijuPendingUse?.[cardId] : undefined
    if (!cardId || !pending || context.event.sourceId !== ownerId) return
    delete s78(host.state).shijuPendingUse[cardId]
    const actor = player(host.state, pending.actorId)
    if (actor?.alive) {
      const equipmentCount = Object.values(actor.zones.equipment).filter(Boolean).length
      s78(host.state).shijuRangeBonus ??= {}; s78(host.state).shijuRangeBonus[ownerId] ??= {}
      s78(host.state).shijuRangeBonus[ownerId][pending.actorId] = { turn: host.state.turnNumber, amount: equipmentCount }
    }
    const card = host.state.cards[cardId]
    if (card?.category === 'equipment' || pending.dealtDamage) {
      if (player(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
      if (actor?.alive) drawCards(host.state, host.rng, actor.id, 2, (name, data) => host.dispatch(name, data))
    }
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'give-card') {
      const actorId = (resolution.data as { actorId?: PlayerId }).actorId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const actor = actorId ? player(host.state, actorId) : undefined
      const owner = player(host.state, ownerId)
      if (!actorId || !cardId || !actor?.alive || !owner?.alive || !actor.zones.hand.includes(cardId)) return
      if (!giveCards(host as never, actorId, ownerId, [cardId], JIANGJI_SHIJU).length) return
      const card = host.state.cards[cardId]
      if (!card) return
      askOption(host, JIANGJI_SHIJU, ownerId, 'choose-use', ownerId,
        '【势举】：是否使用此牌？', [{ id: 'yes', label: '使用此牌' }, { id: 'no', label: '不使用' }],
        { actorId, cardId })
      return
    }
    if (resolution.step === 'choose-use') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const { actorId, cardId } = resolution.data as { actorId: PlayerId; cardId: CardId }
      const card = host.state.cards[cardId]
      const owner = player(host.state, ownerId)
      if (!card || !owner?.alive || !owner.zones.hand.includes(cardId)) return
      const actions = declaredCardActions(host.state, ownerId, cardId, card.name, `【势举】：使用【${card.name}】`)
        .filter((action): action is Extract<ReturnType<typeof declaredCardActions>[number], { kind: 'use-card' }> => action.kind === 'use-card')
      if (!actions.length) return
      askOption(host, JIANGJI_SHIJU, ownerId, 'select-use-action', ownerId, '【势举】：选择此牌的合法用法',
        actions.map((action, index) => ({ id: String(index), label: action.label })), { actorId, cardId })
      return
    }
    if (resolution.step !== 'select-use-action') return
    const { actorId, cardId } = resolution.data as { actorId: PlayerId; cardId: CardId }
    const selectedIndex = Number((response.payload as { optionId?: string }).optionId)
    const card = host.state.cards[cardId]
    const owner = player(host.state, ownerId)
    if (!card || !owner?.alive || !owner.zones.hand.includes(cardId) || !Number.isInteger(selectedIndex)) return
    const actions = declaredCardActions(host.state, ownerId, cardId, card.name, `【势举】：使用【${card.name}】`)
      .filter((action): action is Extract<ReturnType<typeof declaredCardActions>[number], { kind: 'use-card' }> => action.kind === 'use-card')
    const action = actions[selectedIndex]
    const actor = player(host.state, actorId)
    if (!action || !actor?.alive) return
    s78(host.state).shijuPendingUse ??= {}
    s78(host.state).shijuPendingUse[cardId] = { actorId, dealtDamage: false }
    executeUseCardAction(host as never, ownerId, action)
  },
})

registerSkillRuntime({ id: JIANGJI_YINGSHI,
  triggers: [{ event: 'TargetSpecified', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    const cardId = payload.cardId
    if (context.event.sourceId !== ownerId || !cardId || !INSTANT_TRICKS.has(payload.cardName ?? '')
      || (s78(host.state).yingshiDisabled?.[ownerId] === host.state.turnNumber)) return
    const targets = (payload.targetIds ?? []).filter((id) => player(host.state, id)?.alive)
    if (!targets.length) return
    const X = Object.values(player(host.state, ownerId)?.zones.equipment ?? {}).filter(Boolean).length + 1
    const canDiscard = targets.some((id) => cardsInHandAndEquipment(host.state, id).length >= X)
    s78(host.state).yingshiCardTags ??= {}
    s78(host.state).yingshiCardTags[cardId] = { targetIds: targets, repeatTargetId: null }
    const selectTarget = (targetId: PlayerId) => {
      const options: Array<{ id: string; label: string }> = [{ id: 'repeat', label: '此牌对你额外结算一次' }]
      if (canDiscard && cardsInHandAndEquipment(host.state, targetId).length >= X)
        options.push({ id: 'discard', label: `弃置${X}张牌，本回合【应时】失效` })
      askOption(host, JIANGJI_YINGSHI, ownerId, 'target-choice', targetId,
        '【应时】：选择一项', options, { cardId, targetId, X })
    }
    if (targets.length === 1) selectTarget(targets[0]!)
    else askTargets(host, JIANGJI_YINGSHI, ownerId, 'select-target', ownerId, targets,
      '【应时】：选择其中一个目标', { cardId, X }, 1, 1)
  } }, { event: 'CardResolved', handle(host, _ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (cardId) delete s78(host.state).yingshiCardTags?.[cardId]
  } }],
  repeatTargetEffectCount(state, _ownerId, targetId, cardId) {
    return s78(state).yingshiCardTags?.[cardId]?.repeatTargetId === targetId ? 1 : 0
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'select-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const { cardId, X } = resolution.data as { cardId?: CardId; X?: number }
      const tag = cardId ? s78(host.state).yingshiCardTags?.[cardId] : undefined
      if (!targetId || !tag?.targetIds.includes(targetId) || !player(host.state, targetId)?.alive) return
      const count = Number(X)
      const options: Array<{ id: string; label: string }> = [{ id: 'repeat', label: '此牌对其额外结算一次' }]
      if (cardsInHandAndEquipment(host.state, targetId).length >= count)
        options.push({ id: 'discard', label: `弃置${count}张牌，本回合【应时】失效` })
      askOption(host, JIANGJI_YINGSHI, ownerId, 'target-choice', targetId, '【应时】：选择一项', options,
        { cardId, targetId, X: count })
      return
    }
    if (resolution.step === 'target-choice') {
      const choice = (response.payload as { optionId?: string }).optionId
      const { cardId, targetId, X } = resolution.data as { cardId?: CardId; targetId?: PlayerId; X?: number }
      if (!cardId || !targetId || !player(host.state, targetId)?.alive) return
      if (choice === 'repeat') {
        const tag = s78(host.state).yingshiCardTags?.[cardId]
        if (tag) tag.repeatTargetId = targetId
        return
      }
      if (choice !== 'discard' || s78(host.state).yingshiDisabled?.[ownerId] === host.state.turnNumber) return
      const count = Number(X)
      const cards = cardsInHandAndEquipment(host.state, targetId)
      if (!Number.isInteger(count) || count < 1 || cards.length < count) return
      askCards(host, JIANGJI_YINGSHI, ownerId, 'discard-cost', targetId, cards,
        `【应时】：选择弃置${count}张牌`, { targetId, count }, count, count)
      return
    }
    if (resolution.step !== 'discard-cost') return
    const { targetId, count } = resolution.data as { targetId?: PlayerId; count?: number }
    const cards = cardsInHandAndEquipment(host.state, targetId!)
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => cards.includes(id))
    if (!targetId || !player(host.state, targetId)?.alive || !Number.isInteger(count) || selected.length !== count) return
    discard(host, targetId, selected, JIANGJI_YINGSHI)
    s78(host.state).yingshiDisabled ??= {}
    s78(host.state).yingshiDisabled[ownerId] = host.state.turnNumber
  },
})

// Remaining active/interactive adapters are intentionally not registered as
// no-op placeholders: they require the shared target-selection and multi-card
// resolution paths before the roster batch can be safely integrated.
