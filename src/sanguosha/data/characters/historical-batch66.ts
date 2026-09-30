import type { CharacterDefinition } from './types'
import { getCharacter, skillIdsOf } from './standard'
import type { CardId, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { drawCards } from '../../engine/draw'
import { grantSkill, replaceTemporarySkill, isTargetProhibited, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { loseHp, loseMaxHp, gainMaxHp, exchangeHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { discardCardsByIds } from '../../engine/discard-all'
import { giveCards } from '../../engine/hand-transfer'
import { moveCard, setCardAlias, setCardNature } from '../../engine/zones'
import { suppressSkill } from '../../engine/skill-suppression'
import { isLockedSkill } from '../../engine/locked-skills'
import { skipPhase } from '../../engine/turn'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { getDistance } from '../../engine/distance'
import { DAMAGE_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { effectiveCardColor } from '../../engine/skills/runtime'
import { setChained } from '../../engine/character-state'
import { abolishJudgmentArea } from '../../engine/judgment-area'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { openPrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, privateZoneCards } from '../../engine/private-zone'
import { createVirtualSlashCard, declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { createVirtualTrick, virtualTrickChoices } from '../../engine/virtual-trick'
import { resolveDamage } from '../../engine/damage'
import { conversionStateOf as engineConversionStateOf, toggleConversionState as engineToggleConversionState } from '../../engine/conversion'

const B66 = '-b66'
const id = (name: string) => `${name}${B66}`
const DENGAI = 'mou-dengai-b66'
const LUSU = 'mou-lusu-b66'
const XUYOU = 'mou-xuyou-b66'
const XIZHICAI = 'mou-xizhicai-b66'
const ZHANGRANG = 'mou-zhangrang-b66'
const DONGZHAO = 'mou-dongzhao-b66'
const CHENGYU = 'mou-chengyu-b66'
const XUNSHU = 'clan-xunshu-b66'
const XUNCHEN = 'clan-xunchen-b66'
const XUNCAI = 'clan-xuncai-b66'
const GU = 'mou-dengai-gu'
const LU = 'mou-zhangrang-lu'
const playerOf = (state: SanguoshaState, playerId: PlayerId) => state.players.find((player) => player.id === playerId)
type Batch66State = SanguoshaState & {
  b66?: {
    luSuPhaseUsed?: Record<PlayerId, number>
    luSuSkipUsed?: Record<PlayerId, TurnPhase[]>
    luSuDrawBonus?: Record<PlayerId, number>
    luSuDiscardPenalty?: Record<PlayerId, number>
    luSuYinglue?: Record<PlayerId, { phaseInstanceId: string; used: string[] }>
    mengshi?: Record<PlayerId, { pair: [PlayerId, PlayerId]; skillId: string }>
    xuyouYin?: Record<PlayerId, boolean>
    xuyouDiscarded?: Record<PlayerId, Record<CardId, true>>
    xuyouActiveCard?: Record<PlayerId, CardId>
    xuyouYushiRound?: Record<PlayerId, number>
    xuyouJiebianRound?: Record<PlayerId, { roundNumber: number; count: number }>
    jinjinPending?: Record<PlayerId, { cardIds: CardId[]; damageTurn?: number }>
    xinjuanRun?: Record<PlayerId, { amount: number; playerIds: PlayerId[]; index: number }>
    shenjun?: Record<PlayerId, { cardIds: CardId[]; names: string[]; phaseKey: string }>
    shenjunPhaseUsed?: Record<PlayerId, { phaseKey: string; remaining: number }>
    zhangrangNames?: Record<PlayerId, string[]>
    zhangrangUsedNames?: Record<PlayerId, string[]>
    bishiTarget?: Record<PlayerId, PlayerId>
    bishiUsed?: Record<PlayerId, boolean>
    balongTurn?: Record<PlayerId, number>
    chengyuDanchiUsed?: Record<PlayerId, number>
    lieshiFirst?: Record<PlayerId, { option: string }>
    fenchaoUsed?: Record<PlayerId, boolean>
    tuishengUsed?: Record<PlayerId, boolean>
    xizhicaiBuried?: Record<PlayerId, { cardIds: CardId[]; skillOwnerId: PlayerId }>
    zhangrangLu?: Record<PlayerId, CardId[]>
    dongzhaoNames?: Record<PlayerId, string[]>
    dongzhaoSuitFollow?: Record<PlayerId, { suit: string; untilTurn: number }>
    chengyuNext?: Record<PlayerId, 'trick' | 'slash' | null>
    chengyuDanchi?: Record<PlayerId, { victimId: PlayerId; sourceId: PlayerId; category: string; turnNumber: number }>
    xunUsedTrick?: Record<PlayerId, number>
    xunTripletUsed?: Record<PlayerId, { round: number; category: string }>
    xunEmptyHandTarget?: Record<PlayerId, PlayerId>
  chengyuDanchiFlow?: Record<PlayerId, { category: string; usedCategory: string; stage: 'wuzhong' | 'slash' }>
    discardSuitLedger?: { turnNumber: number; suits: string[] }
    xinjuanVisited?: Record<PlayerId, PlayerId[]>
    xunColorUsed?: Record<PlayerId, { round: number; suits: string[] }>
    xunDengjieUsed?: Record<PlayerId, number>
    dengaiSnatchRange?: Record<PlayerId, number>
    luSuDuduanTurn?: Record<PlayerId, number>
    dongzhaoShunjiUsed?: Record<PlayerId, PlayerId[]>
  }
}
const stateOf = (host: SkillHost) => (host.state as Batch66State).b66 ??= {}

function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true, requestPlayerId = ownerId): void {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseOptionRequest => ({
    id: requestId, kind: 'choose-option', playerId: requestPlayerId, prompt, timeoutMs: 25_000, optional, options,
  }) })
}

function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  cardIds: CardId[], min: number, max: number, data: Record<string, unknown> = {}, optional = true): void {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseCardsRequest => ({
    id: requestId, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 25_000,
    optional, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max,
  }) })
}

function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  targetIds: PlayerId[], min = 1, max = 1, data: Record<string, unknown> = {}, optional = true): void {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseTargetsRequest => ({
    id: requestId, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000,
    optional, candidateIds: targetIds, min, max,
  }) })
}

function say(host: SkillHost, ownerId: PlayerId, skillId: string, skillName: string, text: string, targetIds: PlayerId[] = []): void {
  host.dispatch('SkillActivated', { skillId, skillName, playerId: ownerId, ...(targetIds.length === 1 ? { targetId: targetIds[0] } : { targetIds }), logText: text }, { sourceId: ownerId, targetId: targetIds[0] })
}

function hand(state: SanguoshaState, ownerId: PlayerId): CardId[] { return playerOf(state, ownerId)?.zones.hand ?? [] }
function turnRecord<T>(record: Record<PlayerId, T> | undefined, playerId: PlayerId): T | undefined { return record?.[playerId] }
function validChosenCards(state: SanguoshaState, ownerId: PlayerId, cardIds: readonly CardId[]): CardId[] {
  return [...new Set(cardIds)].filter((cardId) => hand(state, ownerId).includes(cardId))
}
function phaseKey(state: SanguoshaState): string { return `${state.turnNumber}:${state.phase}` }

const skill = (skillId: string, name: string, description: string) => ({ id: id(skillId), name, description })

export const MOU_DENGAI_B66: CharacterDefinition = {
  id: DENGAI, name: '谋·邓艾', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    skill('jigu-mou-dengai', '积谷', '锁定技，一名角色于其出牌阶段外使用的牌置入弃牌堆后，若“谷”数量小于你的体力上限，将其中的非红桃牌置于你的武将牌上，称为“谷”。体力上限与你相同的角色的回合开始时，你用任意张手牌替换等量“谷”。'),
    skill('jiewan-mou-dengai', '解腕', '每个准备阶段，你可以减少1点体力上限或移除两张“谷”，将一张手牌当距离为X的【顺手牵羊】使用（X为你“谷”的数量且至少为1）。每个结束阶段，若你的“谷”与手牌数量相同且你的体力上限不为全场唯一最多，你增加1点体力上限。'),
  ],
}

export const MOU_LUSU_B66: CharacterDefinition = {
  id: LUSU, name: '谋·鲁肃', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    skill('duduan-mou-lusu', '独断', '回合开始时，你可以摸一张牌，令你本回合跳过判定、摸牌、出牌、弃牌中的一个阶段，然后交换另外两个阶段的顺序（每阶段限跳过一次）。'),
    skill('yinglue-mou-lusu', '英略', '出牌阶段各限一次，你可以令一名角色：1.失去1点体力，下个摸牌阶段摸牌数+2；2.摸两张牌，下个弃牌阶段手牌上限-2。'),
    skill('mengshi-mou-lusu', '盟势', '限定技，结束阶段，你可失去X点体力，然后交换两名其他角色的体力值（X为两者体力值的差）。每个回合结束时，你摸一张牌并回复1点体力，直到“盟势”一方死亡。'),
  ],
}

export const MOU_XUYOU_B66: CharacterDefinition = {
  id: XUYOU, name: '谋·许攸', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    skill('qianfu-mou-xuyou', '迁附', '转换技，出牌阶段，阳：你可以将一张黑色牌当【过河拆桥】使用；阴：你可以将一张红色牌当【火攻】使用。结算后，你可将因此弃置的牌置于牌堆顶。'),
    skill('yushi-mou-xuyou', '驭势', '你造成或受到伤害后，你可令一名：有转换技的角色切换其转换技状态；无转换技的角色获得出牌阶段各限一次的“迁附”，直到其失去最后的手牌。每轮前X次，全场有转换技切换状态后，你摸1张牌（X为你的体力上限）。'),
    skill('fenchao-mou-xuyou', '焚巢', '限定技，结束阶段，你可以令一名角色获得弃牌堆中的伤害牌（不超过存活人数）且令这些牌造成伤害时伤害属性改为火焰。'),
  ],
}

export const MOU_XIZHICAI_B66: CharacterDefinition = {
  id: XIZHICAI, name: '谋·戏志才', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    skill('xinjuan-mou-xizhicai', '薪传', '当你使用的锦囊牌置入弃牌堆后，你可以令一名角色依次摸X张牌并依次弃置X张牌（X为本回合弃牌堆缺失的花色数），若其手牌数变为体力值，其下家继续执行剩余流程。'),
    skill('jinjin-mou-xizhicai', '金烬', '你可以移出本回合弃牌堆中任意张不同花色的牌并失去本技能，视为使用一张普通锦囊牌，然后你下次受到伤害的回合结束时令一名角色获得移出牌和本技能。'),
  ],
}

export const MOU_ZHANGRANG_B66: CharacterDefinition = {
  id: ZHANGRANG, name: '谋·张让', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    skill('lucun-mou-zhangrang', '赂存', '每轮各限一次，你可视为使用一张有目标角色的基本或普通锦囊牌（未以此法使用），然后目标中手牌最多的随机一名角色将一张手牌置为“赂”。一个回合结束时，随机移去一张“赂”，你摸一张牌。'),
    skill('tuisheng-mou-zhangrang', '蜕生', '限定技，准备阶段或当你进入濒死状态时，你可重置本局使用过的牌名，然后选择一项并回复1点体力：将你所有手牌置为“赂”；你随机从弃牌堆中获得游戏轮数张重置前“赂存”使用牌名的牌。'),
  ],
}

export const MOU_DONGZHAO_B66: CharacterDefinition = {
  id: DONGZHAO, name: '谋·董昭', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    skill('shunji-mou-dongzhao', '顺机', '每轮每名角色限一次，当一名角色受到伤害后，你可摸至多两张牌，然后交给其等量牌。若你因此失去了一个牌名的所有牌（每个牌名限一次），你对其造成一点伤害。'),
    skill('yishi-mou-dongzhao', '移势', '出牌阶段限一次，你可保留手牌中每个花色各一张并展示，将其余牌置入弃牌堆，然后移动场上一张牌。若你未因此失去手牌，直到你的下个回合开始，你不因使用而失去与移动牌花色相同的牌后，摸一张牌。'),
  ],
}

export const MOU_CHENGYU_B66: CharacterDefinition = {
  id: CHENGYU, name: '谋·程昱', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    skill('lidan-mou-chengyu', '戾断', '你使用【杀】后，令你使用的下一张锦囊牌可以多指定一个目标；你使用锦囊牌后，令你使用的下一张【杀】可以多指定一个目标。'),
    skill('danchi-mou-chengyu', '胆持', '每回合限一次，距离1以内的角色受到伤害后，你可令受到伤害的角色选择一个类型。然后伤害来源本回合使用下一张牌后，你视为使用一张【无中生有】，若与“胆持”选择的类型不同，你可额外视为使用一张【杀】。'),
  ],
}

export const CLAN_XUNSHU_B66: CharacterDefinition = {
  id: XUNSHU, name: '族·荀淑', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', clan: 'xun', skills: [
    skill('daojie-clan-xun', '蹈节', '宗族技，锁定技，当你每回合首次使用非伤害锦囊牌后，你失去1点体力或一个锁定技令一名同族角色获得此牌。'),
    skill('shenjun-clan-xunshu', '神君', '当一名角色使用【杀】或普通锦囊牌时，你展示所有同名手牌记为“神君”，本阶段结束时，你可以将X张牌当任意“神君”牌使用（X为“神君”牌数）。'),
    skill('balong-clan-xunshu', '八龙', '锁定技，当你每回合体力值首次变化后，若你手牌中锦囊牌为唯一最多的类型，你展示手牌并摸至与存活角色数相同。'),
  ],
}

export const CLAN_XUNCHEN_B66: CharacterDefinition = {
  id: XUNCHEN, name: '族·荀谌', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', clan: 'xun', skills: [
    skill('daojie-clan-xun', '蹈节', '宗族技，锁定技，当你每回合首次使用非伤害锦囊牌后，你失去1点体力或一个锁定技令一名同族角色获得此牌。'),
    skill('sanhuang-clan-xunchen', '三恇', '锁定技，当你每轮首次使用一种类型的牌后，你令一名其他角色交给你至少X张牌，然后获得你使用的牌（X为其满足的项数：1.场上有牌；2.已受伤；3.体力值小于手牌数）。'),
    skill('beishi-clan-xunchen', '卑势', '锁定技，当首次被“三恇”的角色失去所有手牌后，你回复1点体力。'),
  ],
}

export const CLAN_XUNCAI_B66: CharacterDefinition = {
  id: XUNCAI, name: '族·荀采', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', clan: 'xun', skills: [
    skill('daojie-clan-xun', '蹈节', '宗族技，锁定技，当你每回合首次使用非伤害锦囊牌后，你失去1点体力或一个锁定技令一名同族角色获得此牌。'),
    skill('lieshi-clan-xuncai', '烈誓', '出牌阶段，你可以选择一项：1.废除判定区并受到你造成的1点火焰伤害；2.弃置所有【闪】；3.弃置所有【杀】。然后令一名角色选择另一项。'),
    skill('dianzhan-clan-xuncai', '点盏', '锁定技，当你每轮首次使用一种花色的牌后，你令此牌唯一目标进入连环状态并重铸此花色所有手牌，若皆如此做，你摸一张牌。'),
    skill('huanyin-clan-xuncai', '还阴', '锁定技，当你进入濒死状态时，你将手牌摸至四张。'),
  ],
}

const QIANFU = id('qianfu-mou-xuyou')
const YUSHI = id('yushi-mou-xuyou')
const FENCHAO = id('fenchao-mou-xuyou')
const JINJIN = id('jinjin-mou-xizhicai')
const BALONG = id('balong-clan-xunshu')
const DAOJIE = id('daojie-clan-xun')
const SANHUANG = id('sanhuang-clan-xunchen')
const BEISHI = id('beishi-clan-xunchen')
const LIESHI = id('lieshi-clan-xuncai')
const DIANZHAN = id('dianzhan-clan-xuncai')
const HUANYIN = id('huanyin-clan-xuncai')
const XINJUAN = id('xinjuan-mou-xizhicai')
const DANCHI = id('danchi-mou-chengyu')
const LIDAN = id('lidan-mou-chengyu')
const SHENJUN_SKILL = id('shenjun-clan-xunshu')
const LUCUN = id('lucun-mou-zhangrang')
const TUISHENG = id('tuisheng-mou-zhangrang')

function conversionStateOf(state: SanguoshaState, ownerId: PlayerId, skillId: string): 'yang' | 'yin' {
  return engineConversionStateOf(state, ownerId, skillId)
}

function toggleConversionState(host: SkillHost, ownerId: PlayerId, skillId: string, sourceSkillId: string): void {
  const next = engineToggleConversionState(host.state, ownerId, skillId)
  host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId, state: next, sourceSkillId }, { sourceId: ownerId, sourceSkillId })
}

registerSkillRuntime({ id: QIANFU,
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const yang = conversionStateOf(state, ownerId, QIANFU) === 'yang'
    return hand(state, ownerId).flatMap((cardId) => {
      const color = effectiveCardColor(state, ownerId, cardId, skillIdsOf)
      if (yang && color === 'black') return [{ cardId, asCardName: '过河拆桥', label: '【迁附·阳】：黑色牌当【过河拆桥】' }]
      if (!yang && color === 'red') return [{ cardId, asCardName: '火攻', label: '【迁附·阴】：红色牌当【火攻】' }]
      return []
    })
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== QIANFU || !payload.cardId) return
      toggleConversionState(host, ownerId, QIANFU, QIANFU)
      stateOf(host).xuyouActiveCard ??= {}
      stateOf(host).xuyouActiveCard![ownerId] = payload.cardId
      stateOf(host).xuyouDiscarded ??= {}
      stateOf(host).xuyouDiscarded![ownerId] = {}
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; reason?: string }
      if (!stateOf(host).xuyouActiveCard?.[ownerId] || payload.reason !== 'discard' || !payload.cardId) return
      stateOf(host).xuyouDiscarded ??= {}
      stateOf(host).xuyouDiscarded![ownerId] ??= {}
      stateOf(host).xuyouDiscarded![ownerId]![payload.cardId] = true
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId || stateOf(host).xuyouActiveCard?.[ownerId] !== cardId) return
      const discarded = Object.keys(stateOf(host).xuyouDiscarded?.[ownerId] ?? {}) as CardId[]
      delete stateOf(host).xuyouActiveCard?.[ownerId]
      delete stateOf(host).xuyouDiscarded?.[ownerId]
      const valid = discarded.filter((id) => host.state.zones.discardPile.includes(id))
      if (valid.length) host.queueSkill({ skillId: QIANFU, ownerId, step: 'top', data: { cardIds: valid } })
    } },
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (playerId === ownerId && hand(host.state, ownerId).length === 0)
        replaceTemporarySkill(host.state, ownerId, `${YUSHI}:${ownerId}`, null)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'top') return
    const ids = (prompt.data.cardIds as CardId[]).filter((cardId) => host.state.zones.discardPile.includes(cardId))
    if (ids.length) askCards(host, QIANFU, ownerId, 'top', '【迁附】：可将本次结算中因此弃置的牌按所选顺序置于牌堆顶', ids, 0, ids.length)
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'top') return
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => (resolution.data.cardIds as CardId[]).includes(cardId) && host.state.zones.discardPile.includes(cardId))
    for (const cardId of [...selected].reverse()) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'drawPile' }, { toTop: true })
  },
})

registerSkillRuntime({ id: YUSHI, triggers: [
  { event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { targetId?: PlayerId; finalAmount?: number }
    if ((context.event.sourceId !== ownerId && payload.targetId !== ownerId) || Number(payload.finalAmount ?? 0) <= 0
      || !playerOf(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: YUSHI, ownerId, step: 'invoke', data: {} })
  } },
  { event: 'ConversionStateToggled', handle(host, ownerId, context) {
    const player = playerOf(host.state, ownerId)
    if (!player?.alive || !(context.event.payload as { skillId?: string }).skillId) return
    const record = stateOf(host).xuyouJiebianRound?.[ownerId]
    const count = record?.roundNumber === host.state.roundNumber ? record.count : 0
    if (count >= player.maxHp) return
    stateOf(host).xuyouJiebianRound ??= {}
    stateOf(host).xuyouJiebianRound![ownerId] = { roundNumber: host.state.roundNumber, count: count + 1 }
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'invoke') return
  askOption(host, YUSHI, ownerId, 'invoke', '【驭势】：是否令一名角色切换转换技状态或获得“迁附”？', [
    { id: 'yes', label: '选择一名角色' }, { id: 'no', label: '不发动' },
  ])
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    askTargets(host, YUSHI, ownerId, 'target', '【驭势】：选择一名角色',
      host.state.players.filter((player) => player.alive).map((player) => player.id), 1, 1, {}, false)
    return
  }
  if (resolution.step !== 'target') return
  const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
  const target = targetId ? playerOf(host.state, targetId) : undefined
  if (!target?.alive || !target.characterId) return
  const conversionIds = getCharacter(target.characterId)?.skills.filter((entry) => !entry.granted && entry.description.startsWith('转换技')).map((entry) => entry.id) ?? []
  if (conversionIds.length) {
    for (const skillId of conversionIds) toggleConversionState(host, targetId!, skillId, YUSHI)
  } else if (hand(host.state, targetId!).length) {
    replaceTemporarySkill(host.state, targetId!, `${YUSHI}:${ownerId}`, QIANFU)
  }
},
})

registerSkillRuntime({ id: FENCHAO, limited: true, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const event = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
  if (event.playerId !== ownerId || event.phase !== 'finish' || !playerOf(host.state, ownerId)?.alive
    || stateOf(host).fenchaoUsed?.[ownerId]) return
  host.queueSkill({ skillId: FENCHAO, ownerId, step: 'invoke', data: {} })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'invoke') {
    askOption(host, FENCHAO, ownerId, 'invoke', '【焚巢】：是否令一名角色获得弃牌堆中的伤害牌？', [
      { id: 'yes', label: '选择角色' }, { id: 'no', label: '不发动' },
    ])
  }
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const eligible = host.state.zones.discardPile.filter((cardId) => DAMAGE_TRICKS.has(host.state.cards[cardId]?.name ?? '')
      && !host.state.cards[cardId]?.virtual)
    if (!eligible.length) return
    askTargets(host, FENCHAO, ownerId, 'target', '【焚巢】：选择一名获得伤害牌的角色',
      host.state.players.filter((player) => player.alive).map((player) => player.id), 1, 1, {}, false)
    return
  }
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    const eligible = host.state.zones.discardPile.filter((cardId) => DAMAGE_TRICKS.has(host.state.cards[cardId]?.name ?? '')
      && !host.state.cards[cardId]?.virtual)
    const amount = Math.min(eligible.length, host.state.players.filter((player) => player.alive).length)
    if (!amount) return
    askCards(host, FENCHAO, ownerId, 'cards', `【焚巢】：选择至多${amount}张伤害牌交给${target.nickname}`,
      eligible, 1, amount, { targetId }, true)
    return
  }
  if (resolution.step !== 'cards') return
  const targetId = resolution.data.targetId as PlayerId
  const target = playerOf(host.state, targetId)
  const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    .filter((cardId) => host.state.zones.discardPile.includes(cardId) && DAMAGE_TRICKS.has(host.state.cards[cardId]?.name ?? ''))
    .slice(0, host.state.players.filter((player) => player.alive).length)
  if (!target?.alive || !selected.length) return
  stateOf(host).fenchaoUsed ??= {}
  stateOf(host).fenchaoUsed![ownerId] = true
  for (const cardId of selected) {
    setCardNature(host.state, cardId, 'fire')
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
  }
  say(host, ownerId, FENCHAO, '焚巢', `${playerOf(host.state, ownerId)?.nickname ?? '许攸'}发动【焚巢】，${target.nickname}获得${selected.length}张伤害牌，且其伤害属性为火焰`, [targetId])
},
})

// 邓艾【积谷】：只保存出牌阶段外真正使用完并进入弃牌堆的牌。
const JIGU = id('jigu-mou-dengai')
const JIEWAN = id('jiewan-mou-dengai')
registerSkillRuntime({ id: JIGU, onGameStart(host, ownerId) {
  const owner = playerOf(host.state, ownerId)
  if (owner) owner.characterPiles[GU] ??= []
}, triggers: [
  { event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId
    const owner = playerOf(host.state, ownerId)
    const sourceId = context.event.sourceId
    if (!owner?.alive || !cardId || !sourceId || !payload.cardName || ownerId === sourceId
      || (host.state.currentPlayerId === sourceId && host.state.phase === 'play')) return
    const card = host.state.cards[cardId]
    const pile = owner.characterPiles[GU] ?? (owner.characterPiles[GU] = [])
    if (!card || card.virtual || !host.state.zones.discardPile.includes(cardId) || card.suit === 'heart' || pile.length >= owner.maxHp) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: GU })
  } },
  { event: 'TurnStart', handle(host, ownerId, context) {
    const turnPlayer = context.event.payload.playerId as PlayerId | undefined
    const owner = playerOf(host.state, ownerId)
    const player = turnPlayer ? playerOf(host.state, turnPlayer) : undefined
    const pile = owner?.characterPiles[GU] ?? []
    if (!owner?.alive || !player?.alive || player.maxHp !== owner.maxHp || !pile.length || !hand(host.state, ownerId).length) return
    host.queueSkill({ skillId: JIGU, ownerId, step: 'replace', data: { turnPlayerId: turnPlayer, pileCardIds: [...pile] } })
  } },
] , startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'replace') return
  const owner = playerOf(host.state, ownerId)
  const handIds = hand(host.state, ownerId)
  const pileIds = owner?.characterPiles[GU] ?? []
  const count = Math.min(handIds.length, pileIds.length)
  if (!owner?.alive || !count) return
  host.askSkill({ skillId: JIGU, ownerId, step: 'replace', data: { pileCardIds: [...pileIds] }, build: (requestId): ChooseCardsRequest => ({
    id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【积谷】：选择等量手牌替换“谷”', timeoutMs: 25_000,
    optional: true, purpose: 'skill', cardIds: handIds, hiddenCardSlots: [], min: 0, max: count,
  }) })
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'replace') return
  const selected = validChosenCards(host.state, ownerId, (response.payload as { cardIds?: CardId[] }).cardIds ?? [])
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  const pile = owner.characterPiles[GU] ?? (owner.characterPiles[GU] = [])
  const oldCards = (resolution.data.pileCardIds as CardId[]).filter((cardId) => pile.includes(cardId)).slice(0, selected.length)
  for (const cardId of selected) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: GU })
  for (const cardId of oldCards) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: GU }, { kind: 'hand', playerId: ownerId })
  if (selected.length) say(host, ownerId, JIGU, '积谷', `${owner.nickname}发动【积谷】，替换了${selected.length}张“谷”`)
} })

registerSkillRuntime({ id: JIEWAN,
  trickDistanceLimit(state, ownerId, _cardId, cardName) {
    return cardName === '顺手牵羊' && turnRecord((state as Batch66State).b66?.dengaiSnatchRange, ownerId) !== undefined
      ? turnRecord((state as Batch66State).b66?.dengaiSnatchRange, ownerId)! : null
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const owner = playerOf(host.state, ownerId)
      if (event.playerId !== ownerId || !owner?.alive) return
      if (event.phase === 'prepare' && hand(host.state, ownerId).length
        && !usedThisPhase(host.state, ownerId, JIEWAN)) host.queueSkill({ skillId: JIEWAN, ownerId, step: 'cost', data: {} })
      if (event.phase === 'finish') {
        const pile = owner.characterPiles[GU] ?? []
        const top = Math.max(...host.state.players.filter((player) => player.alive).map((player) => player.maxHp))
        const topCount = host.state.players.filter((player) => player.alive && player.maxHp === top).length
        if (pile.length === hand(host.state, ownerId).length && (owner.maxHp < top || topCount > 1)) gainMaxHp(host, ownerId, 1, JIEWAN)
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'cost') return
    const owner = playerOf(host.state, ownerId)
    const pile = owner?.characterPiles[GU] ?? []
    if (!owner?.alive || !hand(host.state, ownerId).length) return
    const options = [{ id: 'maxhp', label: '減少1點體力上限' }, ...(pile.length >= 2 ? [{ id: 'grain', label: '移除2張“谷”' }] : [])]
    askOption(host, JIEWAN, ownerId, 'cost', '【解腕】：選擇发动代价', options)
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const choice = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'cost') {
      const pile = owner.characterPiles[GU] ?? []
      if (choice === 'maxhp') loseMaxHp(host, ownerId, 1, JIEWAN)
      else if (choice === 'grain' && pile.length >= 2) {
        for (const cardId of pile.slice(0, 2)) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: GU }, { kind: 'discardPile' })
      } else return
      if (!owner.alive || !hand(host.state, ownerId).length) return
      stateOf(host).dengaiSnatchRange ??= {}
      stateOf(host).dengaiSnatchRange![ownerId] = Math.max(1, pile.length)
      askCards(host, JIEWAN, ownerId, 'material', '【解腕】：选择一张手牌当【顺手牵羊】', hand(host.state, ownerId), 1, 1,
        { range: Math.max(1, pile.length) })
      return
    }
    if (resolution.step === 'material') {
      const cardId = validChosenCards(host.state, ownerId, (response.payload as { cardIds?: CardId[] }).cardIds ?? [])[0]
      if (!cardId) { delete stateOf(host).dengaiSnatchRange?.[ownerId]; return }
      const range = Number(resolution.data.range)
      askTargets(host, JIEWAN, ownerId, 'target', '【解腕】：选择【顺手牵羊】目标', host.state.players.filter((target) => target.alive && target.id !== ownerId
        && getDistance(host.state, ownerId, target.id) <= range && (target.zones.hand.length + Object.values(target.zones.equipment).filter(Boolean).length + target.zones.judgingArea.length > 0)
        && !isTargetProhibited(host.state, ownerId, target.id, '顺手牵羊', skillIdsOf, cardId)).map((target) => target.id), 1, 1, { cardId, range }, false)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = resolution.data.cardId as CardId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || getDistance(host.state, ownerId, target.id) > Number(resolution.data.range) || !hand(host.state, ownerId).includes(cardId)) {
        delete stateOf(host).dengaiSnatchRange?.[ownerId]
        return
      }
      markUsedThisPhase(host.state, ownerId, JIEWAN)
      host.beginVirtualTrick({ sourceId: ownerId, targetId, cardName: '顺手牵羊', sourceSkillId: JIEWAN, cardId })
      delete stateOf(host).dengaiSnatchRange?.[ownerId]
    }
  },
})

const DUDUAN = id('duduan-mou-lusu')
const YINGLUE = id('yinglue-mou-lusu')
const MENGSHI = id('mengshi-mou-lusu')
function labelPhase(phase: TurnPhase): string {
  return ({ prepare: '准备阶段', judge: '判定阶段', draw: '摸牌阶段', play: '出牌阶段', discard: '弃牌阶段', finish: '结束阶段' } as const)[phase]
}

registerSkillRuntime({ id: DUDUAN, triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
  if (context.event.payload.playerId !== ownerId || !playerOf(host.state, ownerId)?.alive
    || stateOf(host).luSuDuduanTurn?.[ownerId] === host.state.turnNumber) return
  stateOf(host).luSuDuduanTurn ??= {}
  stateOf(host).luSuDuduanTurn![ownerId] = host.state.turnNumber
  stateOf(host).luSuSkipUsed ??= {}
  stateOf(host).luSuSkipUsed![ownerId] = []
  host.queueSkill({ skillId: DUDUAN, ownerId, step: 'invoke', data: { turnNumber: host.state.turnNumber } })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'invoke') return
  askOption(host, DUDUAN, ownerId, 'invoke', '【独断】：是否摸一张牌并调整本回合阶段？', [
    { id: 'yes', label: '摸一张牌并调整阶段' }, { id: 'no', label: '不发动' },
  ])
}, resume(host, ownerId, resolution, response) {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) { host.resumePhaseEntry(); return }
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumePhaseEntry(); return }
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    const phases = [
      { id: 'judge', label: '跳过判定阶段', phase: 'judge' as const },
      { id: 'draw', label: '跳过摸牌阶段', phase: 'draw' as const },
      { id: 'play', label: '跳过出牌阶段', phase: 'play' as const },
      { id: 'discard', label: '跳过弃牌阶段', phase: 'discard' as const },
    ].filter((entry) => !host.state.skippedPhases.includes(entry.phase))
    if (phases.length === 0) { host.resumePhaseEntry(); return }
    askOption(host, DUDUAN, ownerId, 'skip', '【独断】：选择本回合跳过的阶段', phases.map(({ id: phaseId, label }) => ({ id: phaseId, label })), { turnNumber: host.state.turnNumber }, false)
    return
  }
  if (resolution.step === 'skip') {
    const selected = (response.payload as { optionId?: string }).optionId as string | undefined
    const chosen = selected === 'judge' ? 'judge' : selected === 'draw' ? 'draw' : selected === 'play' ? 'play' : selected === 'discard' ? 'discard' : null
    if (!chosen) return
    const phases = (host.state.turnPhaseOrder ?? ['prepare', 'judge', 'draw', 'play', 'discard', 'finish']) as TurnPhase[]
    const remaining = phases.filter((phase) => phase !== chosen && phase !== 'prepare' && phase !== 'finish')
    if (stateOf(host).luSuSkipUsed?.[ownerId]?.includes(chosen)) { host.resumePhaseEntry(); return }
    stateOf(host).luSuSkipUsed ??= {}
    stateOf(host).luSuSkipUsed![ownerId] = [...(stateOf(host).luSuSkipUsed![ownerId] ?? []), chosen]
    skipPhase(host.state, chosen)
    host.askSkill({ skillId: DUDUAN, ownerId, step: 'swap', data: { remaining }, build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【独断】：选择交换的另外两个阶段', timeoutMs: 25_000,
      optional: false, options: [
        { id: '0-1', label: `交换${labelPhase(remaining[0]!)}与${labelPhase(remaining[1]!)}` },
        { id: '0-2', label: `交换${labelPhase(remaining[0]!)}与${labelPhase(remaining[2]!)}` },
        { id: '1-2', label: `交换${labelPhase(remaining[1]!)}与${labelPhase(remaining[2]!)}` },
      ],
    }) })
    return
  }
  if (resolution.step !== 'swap') { host.resumePhaseEntry(); return }
  const optionId = (response.payload as { optionId?: string }).optionId
  const [leftIndex, rightIndex] = optionId === '0-1' ? [0, 1] : optionId === '0-2' ? [0, 2] : optionId === '1-2' ? [1, 2] : [-1, -1]
  if (leftIndex < 0) { host.resumePhaseEntry(); return }
  const order = [...(host.state.turnPhaseOrder ?? ['prepare', 'judge', 'draw', 'play', 'discard', 'finish'])] as TurnPhase[]
  const remaining = resolution.data.remaining as TurnPhase[]
  const a = order.indexOf(remaining[leftIndex]!)
  const b = order.indexOf(remaining[rightIndex]!)
  if (a < 0 || b < 0) { host.resumePhaseEntry(); return }
  ;[order[a], order[b]] = [order[b]!, order[a]!]
  host.state.turnPhaseOrder = order
  say(host, ownerId, DUDUAN, '独断', `${playerOf(host.state, ownerId)?.nickname ?? '鲁肃'}发动【独断】，跳过${labelPhase(resolution.data.chosen as TurnPhase)}并交换阶段顺序`)
  host.resumePhaseEntry()
} })

registerSkillRuntime({ id: YINGLUE,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const record = (state as Batch66State).b66?.luSuYinglue?.[ownerId]
    const phaseId = phaseKey(state)
    if (record?.phaseInstanceId !== phaseId) return [
      { id: `skill:${YINGLUE}:hp`, label: '发动【英略】：令一名角色失去1点体力，其下个摸牌阶段多摸两张' },
      { id: `skill:${YINGLUE}:draw`, label: '发动【英略】：令一名角色摸两张牌，其下个弃牌阶段手牌上限-2' },
    ]
    return ['hp', 'draw'].filter((kind) => !record.used.includes(kind)).map((kind) => ({
      id: `skill:${YINGLUE}:${kind}`, label: kind === 'hp' ? '【英略】：失去体力并增加下次摸牌数' : '【英略】：摸牌并减少下次手牌上限',
    }))
  },
  invokeActive(host, ownerId, actionId) {
    const kind = actionId.endsWith(':hp') ? 'hp' : actionId.endsWith(':draw') ? 'draw' : null
    if (!kind) return
    askTargets(host, YINGLUE, ownerId, 'target', kind === 'hp' ? '【英略】：选择失去1点体力的角色' : '【英略】：选择摸两张牌的角色',
      host.state.players.filter((player) => player.alive).map((player) => player.id), 1, 1, { kind }, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    const kind = resolution.data.kind as string
    const phaseId = phaseKey(host.state)
    const record = stateOf(host).luSuYinglue?.[ownerId]
    if (record?.phaseInstanceId === phaseId && record.used.includes(kind)) return
    stateOf(host).luSuYinglue ??= {}
    const current = stateOf(host).luSuYinglue![ownerId]
    if (!current || current.phaseInstanceId !== phaseId) stateOf(host).luSuYinglue![ownerId] = { phaseInstanceId: phaseId, used: [kind] }
    else current.used.push(kind)
    if (kind === 'hp') {
      loseHp(host, target.id, 1, YINGLUE)
      host.state.drawPhaseBonuses ??= {}
      host.state.drawPhaseBonuses[target.id] = (host.state.drawPhaseBonuses[target.id] ?? 0) + 2
    } else {
      drawCards(host.state, host.rng, target.id, 2, (name, payload) => host.dispatch(name, payload))
      host.state.maxCardsAdjustments ??= {}
      host.state.maxCardsAdjustments[target.id] = (host.state.maxCardsAdjustments[target.id] ?? 0) - 2
    }
    say(host, ownerId, YINGLUE, '英略', `${playerOf(host.state, ownerId)?.nickname ?? '鲁肃'}发动【英略】`, [target.id])
  },
})

registerSkillRuntime({ id: MENGSHI, limited: true,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    const owner = playerOf(host.state, ownerId)
    if (phase.playerId !== ownerId || phase.phase !== 'finish' || !owner?.alive || owner.usedLimitedSkills.includes(MENGSHI)) return
    host.queueSkill({ skillId: MENGSHI, ownerId, step: 'invoke', data: {} })
  } }, { event: 'TurnEnd', allowDeadOwner: true, handle(host, ownerId) {
    const contract = stateOf(host).mengshi?.[ownerId]
    if (!contract) return
    const [leftId, rightId] = contract.pair
    const owner = playerOf(host.state, ownerId)
    const left = playerOf(host.state, leftId)
    const right = playerOf(host.state, rightId)
    if (!owner?.alive || !left?.alive || !right?.alive) { delete stateOf(host).mengshi?.[ownerId]; return }
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    if (owner.hp < owner.maxHp) recover(host, ownerId, 1, ownerId, contract.skillId)
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    askOption(host, MENGSHI, ownerId, 'invoke', '【盟势】：是否失去两名角色体力值之差，并交换其体力值？', [
      { id: 'yes', label: '选择两名其他角色' }, { id: 'no', label: '不发动' },
    ])
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      askTargets(host, MENGSHI, ownerId, 'targets', '【盟势】：选择两名其他角色交换体力值',
        host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id), 2, 2, {}, false)
      return
    }
    if (resolution.step !== 'targets') return
    const ids = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
    if (ids.length !== 2 || ids.includes(ownerId)) return
    const [leftId, rightId] = ids as [PlayerId, PlayerId]
    const left = playerOf(host.state, leftId)
    const right = playerOf(host.state, rightId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !left?.alive || !right?.alive || owner.usedLimitedSkills.includes(MENGSHI)) return
    const cost = Math.abs(left.hp - right.hp)
    owner.usedLimitedSkills.push(MENGSHI)
    if (cost > 0) loseHp(host, ownerId, cost, MENGSHI)
    exchangeHp(host, leftId, rightId, MENGSHI)
    stateOf(host).mengshi ??= {}
    stateOf(host).mengshi![ownerId] = { pair: [leftId, rightId], skillId: MENGSHI }
    say(host, ownerId, MENGSHI, '盟势', `${owner.nickname}发动【盟势】，令${left.nickname}与${right.nickname}交换体力值`, ids)
  },
})

registerSkillRuntime({ id: JINJIN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || state.skillSuppressions?.some((entry) => entry.targetId === ownerId && entry.skillId === JINJIN)) return []
    return virtualTrickChoices(state, ownerId).length ? [{ id: `skill:${JINJIN}`, label: '发动【金烬】：移出弃牌堆的牌并视为使用普通锦囊' }] : []
  },
  onGameStart(host, ownerId) {
    const zoneId = `${JINJIN}:${ownerId}`
    if (!host.state.privateZones?.some((zone) => zone.id === zoneId)) openPrivateZone(host.state, zoneId, ownerId, '谋戏志才【金烬】')
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JINJIN}`) return
    const cards = host.state.zones.discardPile.filter((cardId) => !host.state.cards[cardId]?.virtual)
    askCards(host, JINJIN, ownerId, 'cards', '【金烬】：选择任意张花色各不相同的弃牌堆牌移出游戏', cards, 0, 4)
  },
  resume(host, ownerId, resolution, response) {
    const zoneId = `${JINJIN}:${ownerId}`
    if (resolution.step === 'recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      for (const cardId of [...privateZoneCards(host.state, zoneId)])
        moveOutOfPrivateZone(host.state, cardId, zoneId, { kind: 'hand', playerId: targetId! })
      grantSkill(host.state, targetId!, JINJIN)
      delete stateOf(host).jinjinPending?.[ownerId]
      say(host, ownerId, JINJIN, '金烬', `${playerOf(host.state, ownerId)?.nickname ?? '戏志才'}将“金烬”牌与技能交给${target.nickname}`, [targetId!])
      return
    }
    if (resolution.step === 'cards') {
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => host.state.zones.discardPile.includes(cardId) && !host.state.cards[cardId]?.virtual)
      const suits = selected.map((cardId) => host.state.cards[cardId]!.suit)
      if (new Set(suits).size !== selected.length || !selected.length) return
      const choices = virtualTrickChoices(host.state, ownerId)
      if (!choices.length) return
      for (const cardId of selected) moveIntoPrivateZone(host.state, cardId, { kind: 'discardPile' }, zoneId)
      stateOf(host).jinjinPending ??= {}
      stateOf(host).jinjinPending![ownerId] = { cardIds: [...privateZoneCards(host.state, zoneId)] }
      suppressSkill(host.state, { targetId: ownerId, skillId: JINJIN, sourceId: ownerId, sourceSkillId: JINJIN,
        expiresAt: 'never', armedAtTurn: host.state.turnNumber })
      host.askSkill({ skillId: JINJIN, ownerId, step: 'trick', data: { choices }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【金烬】：选择视为使用的普通锦囊',
        timeoutMs: 25_000, optional: false, options: choices.map((name) => ({ id: name, label: name })),
      }) })
      return
    }
    if (resolution.step === 'trick') {
      const name = (response.payload as { optionId?: string }).optionId
      if (!name || !(resolution.data.choices as string[]).includes(name)) return
      const virtualId = createVirtualTrick(host.state, ownerId, name, JINJIN)
      const actions = declaredCardActions(host.state, ownerId, virtualId, name, `【金烬】视为使用【${name}】`, { sourceSkillId: JINJIN })
        .filter((action) => action.kind === 'use-card')
      if (actions.length === 1 && actions[0]?.kind === 'use-card') executeUseCardAction(host as never, ownerId, actions[0])
      else if (actions.length) host.askSkill({ skillId: JINJIN, ownerId, step: 'targets', data: { virtualId, name }, build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: `【金烬】：选择【${name}】目标`,
        timeoutMs: 25_000, optional: false,
        candidateIds: [...new Set(actions.flatMap((action) => action.kind === 'use-card' ? action.targetIds : []))],
        min: Math.min(...actions.map((action) => action.kind === 'use-card' ? action.targetMin : 1)),
        max: Math.max(...actions.map((action) => action.kind === 'use-card' ? action.targetMax : 1)),
      }) })
      return
    }
    if (resolution.step === 'targets') {
      const virtualId = resolution.data.virtualId as CardId
      const name = resolution.data.name as string
      const targets = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const action = declaredCardActions(host.state, ownerId, virtualId, name, `【金烬】视为使用【${name}】`, { sourceSkillId: JINJIN })
        .find((candidate) => candidate.kind === 'use-card' && candidate.targetIds.length === targets.length
          && candidate.targetIds.every((target, index) => target === targets[index]))
      if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
    }
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const p = context.event.payload as { targetId?: PlayerId; finalAmount?: number }
      if (p.targetId !== ownerId || Number(p.finalAmount ?? 0) <= 0) return
      const pending = stateOf(host).jinjinPending?.[ownerId]
      if (pending) pending.damageTurn = host.state.turnNumber
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId }
      const pending = stateOf(host).jinjinPending?.[ownerId]
      if (p.playerId !== ownerId || pending?.damageTurn !== host.state.turnNumber) return
      host.queueSkill({ skillId: JINJIN, ownerId, step: 'return', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'return') return
    askTargets(host, JINJIN, ownerId, 'recipient', '【金烬】：选择获得移出牌和【金烬】的角色',
      host.state.players.filter((player) => player.alive).map((player) => player.id), 1, 1, {}, false)
  },
})

registerSkillRuntime({ id: HUANYIN, triggers: [{ event: 'EnterDying', priority: 100, handle(host, ownerId, context) {
  if (context.event.targetId !== ownerId) return
  const count = Math.max(0, 4 - hand(host.state, ownerId).length)
  if (count) drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
} }] })

registerSkillRuntime({ id: BALONG, triggers: ['LoseHp', 'Damaged', 'Recover', 'MaxHpChange', 'HpExchanged'].map((event) => ({
  event: event as 'LoseHp' | 'Damaged' | 'Recover' | 'MaxHpChange' | 'HpExchanged', handle(host: SkillHost, ownerId: PlayerId, context: { event: { payload: Record<string, unknown> } }) {
    const payload = context.event.payload
    const affected = payload.playerId === ownerId || (payload.leftId === ownerId || payload.rightId === ownerId)
    if (!affected || stateOf(host).balongTurn?.[ownerId] === host.state.turnNumber) return
    stateOf(host).balongTurn ??= {}
    stateOf(host).balongTurn![ownerId] = host.state.turnNumber
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const counts = { basic: 0, trick: 0, equip: 0 }
    for (const cardId of hand(host.state, ownerId)) {
      const category = host.state.cards[cardId]?.category
      if (category === 'basic' || category === 'trick') counts[category] += 1
      if (category === 'equipment') counts.equip += 1
    }
    if (counts.trick <= 0 || counts.trick <= counts.basic || counts.trick <= counts.equip) return
    const amount = Math.max(0, host.state.players.filter((player) => player.alive).length - hand(host.state, ownerId).length)
    host.dispatch('SkillActivated', { skillId: BALONG, skillName: '八龙', playerId: ownerId,
      cardIds: hand(host.state, ownerId), logText: `${owner.nickname}发动【八龙】，展示手牌并摸至存活角色数` }, { sourceId: ownerId })
    if (amount) drawCards(host.state, host.rng, ownerId, amount, (name, data) => host.dispatch(name, data))
  },
})) })

registerSkillRuntime({ id: DIANZHAN, triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
  const event = context.event
  const payload = event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
  if (event.sourceId !== ownerId || !payload.cardId || !payload.targetIds || payload.targetIds.length !== 1) return
  const card = host.state.cards[payload.cardId]
  const suit = card?.suit
  if (!suit || !['spade', 'heart', 'club', 'diamond'].includes(suit)) return
  const record = stateOf(host).xunColorUsed?.[ownerId]
  const used = record?.round === host.state.roundNumber ? record.suits : []
  if (used.includes(suit)) return
  stateOf(host).xunColorUsed ??= {}
  stateOf(host).xunColorUsed![ownerId] = { round: host.state.roundNumber, suits: [...used, suit] }
  const targetId = payload.targetIds[0]!
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  setChained(host, targetId, '【点盏】', true)
  const matching = hand(host.state, ownerId).filter((cardId) => host.state.cards[cardId]?.suit === suit)
  if (matching.length) {
    const discarded = discardCardsByIds(host as never, ownerId, matching, 'recast')
    if (discarded.length) drawCards(host.state, host.rng, ownerId, discarded.length, (name, data) => host.dispatch(name, data))
  }
  if (matching.length > 0 && matching.every((cardId) => !hand(host.state, ownerId).includes(cardId)))
    drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
} }] })

function applyLieshiOption(host: SkillHost, playerId: PlayerId, option: string): void {
  if (option === 'judge') {
    abolishJudgmentArea(host.state, playerId)
    resolveDamage(host, { sourceId: playerId, targetId: playerId, amount: 1, nature: 'fire', cardName: '烈誓' })
    return
  }
  const names = option === 'jink' ? new Set(['闪']) : new Set(['杀', '火杀', '雷杀'])
  const ids = hand(host.state, playerId).filter((cardId) => names.has(host.state.cards[cardId]?.name ?? ''))
  if (ids.length) discardCardsByIds(host as never, playerId, ids, '【烈誓】')
}

registerSkillRuntime({ id: LIESHI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId
      ? [{ id: `skill:${LIESHI}`, label: '发动【烈誓】：选择一项，然后令一名角色选择另一项' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${LIESHI}`) return
    askOption(host, LIESHI, ownerId, 'self', '【烈誓】：选择一项', [
      { id: 'judge', label: '废除判定区并受到1点火焰伤害' },
      { id: 'jink', label: '弃置所有【闪】' },
      { id: 'slash', label: '弃置所有【杀】' },
    ], {}, false)
  },
  resume(host, ownerId, resolution, response) {
    const option = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'self') {
      if (!['judge', 'jink', 'slash'].includes(option ?? '')) return
      applyLieshiOption(host, ownerId, option!)
      if (!playerOf(host.state, ownerId)?.alive) return
      const options = ['judge', 'jink', 'slash'].filter((id) => id !== option)
      askTargets(host, LIESHI, ownerId, 'target', '【烈誓】：选择一名角色令其选择另一项',
        host.state.players.filter((player) => player.alive).map((player) => player.id), 1, 1, { options }, false)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      askOption(host, LIESHI, ownerId, 'other', `【烈誓】：令${target.nickname}选择一项`,
        (resolution.data.options as string[]).map((id) => ({ id, label: id === 'judge' ? '废除判定区并受到1点火焰伤害' : id === 'jink' ? '弃置所有【闪】' : '弃置所有【杀】' })),
        { targetId }, false, target.id)
      return
    }
    if (resolution.step === 'other') {
      const targetId = resolution.data.targetId as PlayerId
      if (['judge', 'jink', 'slash'].includes(option ?? '') && (resolution.data.options as string[]).includes(option!))
        applyLieshiOption(host, targetId, option!)
    }
  },
})

const YISHI = id('yishi-mou-dongzhao')
const SHUNJI = id('shunji-mou-dongzhao')
registerSkillRuntime({ id: YISHI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, YISHI)) return []
    const movable = fieldCards(state).some((entry) => fieldMoveDestinations(state, entry.cardId).length > 0)
    return movable ? [{ id: `skill:${YISHI}`, label: '发动【移势】：展示并整理手牌，然后移动一张场上牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${YISHI}`) return
    askCards(host, YISHI, ownerId, 'keep', '【移势】：选择每种花色至多保留一张手牌', hand(host.state, ownerId), 0, hand(host.state, ownerId).length)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'keep') {
      const keep = validChosenCards(host.state, ownerId, (response.payload as { cardIds?: CardId[] }).cardIds ?? [])
      const suits = keep.map((cardId) => host.state.cards[cardId]?.suit)
      if (new Set(suits).size !== keep.length) return
      const thrown = hand(host.state, ownerId).filter((cardId) => !keep.includes(cardId))
      const discarded = thrown.length ? discardCardsByIds(host as never, ownerId, thrown, '【移势】') : []
      const fields = fieldCards(host.state).filter((entry) => fieldMoveDestinations(host.state, entry.cardId).length > 0)
      if (!fields.length) return
      markUsedThisPhase(host.state, ownerId, YISHI)
      askCards(host, YISHI, ownerId, 'field', '【移势】：选择一张可移动的场上牌', fields.map((entry) => entry.cardId), 1, 1,
        { retainedAllHand: discarded.length === 0 }, false)
      return
    }
    if (resolution.step === 'field') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !fieldCards(host.state).some((entry) => entry.cardId === cardId)) return
      const destinations = fieldMoveDestinations(host.state, cardId)
      if (!destinations.length) return
      askTargets(host, YISHI, ownerId, 'destination', '【移势】：选择场上牌移动至的角色', destinations, 1, 1,
        { cardId, retainedAllHand: resolution.data.retainedAllHand }, false)
      return
    }
    if (resolution.step !== 'destination') return
    const cardId = resolution.data.cardId as CardId
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !fieldMoveDestinations(host.state, cardId).includes(targetId)) return
    const card = host.state.cards[cardId]
    const suit = card?.suit
    moveFieldCard(host as never, cardId, targetId)
    if (resolution.data.retainedAllHand && suit) {
      stateOf(host).dongzhaoSuitFollow ??= {}
      stateOf(host).dongzhaoSuitFollow![ownerId] = { suit, untilTurn: host.state.turnNumber + host.state.players.length }
    }
    say(host, ownerId, YISHI, '移势', `${playerOf(host.state, ownerId)?.nickname ?? '董昭'}发动【移势】移动一张场上牌`, [targetId])
  },
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    if (context.event.payload.playerId === ownerId) delete stateOf(host).dongzhaoSuitFollow?.[ownerId]
  } }, { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; reason?: string; from?: { kind?: string; playerId?: PlayerId } }
    const record = stateOf(host).dongzhaoSuitFollow?.[ownerId]
    const cardId = payload.cardId
    if (!record || payload.reason !== 'other'
      || payload.from?.kind !== 'hand' || payload.from.playerId !== ownerId || !cardId
      || host.state.cards[cardId]?.suit !== record.suit || !host.state.zones.discardPile.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
  } }],
})

registerSkillRuntime({ id: SHUNJI, triggers: [
  { event: 'RoundStart', handle(host, ownerId) {
    stateOf(host).dongzhaoShunjiUsed ??= {}
    stateOf(host).dongzhaoShunjiUsed![ownerId] = []
    stateOf(host).dongzhaoNames ??= {}
  } },
  { event: 'DamageSettled', handle(host, ownerId, context) {
    const p = context.event.payload as { targetId?: PlayerId; finalAmount?: number }
    const victimId = p.targetId
    if (!victimId || Number(p.finalAmount ?? 0) <= 0 || !playerOf(host.state, ownerId)?.alive
      || !playerOf(host.state, victimId)?.alive || stateOf(host).dongzhaoShunjiUsed?.[ownerId]?.includes(victimId)) return
    stateOf(host).dongzhaoShunjiUsed ??= {}
    stateOf(host).dongzhaoShunjiUsed![ownerId] ??= []
    stateOf(host).dongzhaoShunjiUsed![ownerId]!.push(victimId)
    host.queueSkill({ skillId: SHUNJI, ownerId, step: 'draw-count', data: { victimId } })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'draw-count') return
  const victimId = prompt.data.victimId as PlayerId
  if (!playerOf(host.state, victimId)?.alive) return
  askOption(host, SHUNJI, ownerId, 'draw-count', '【顺机】：摸至多两张牌，再交给受伤角色等量牌？', [
    { id: '0', label: '不摸牌（放弃发动）' }, { id: '1', label: '摸一张并交给其一张' }, { id: '2', label: '摸两张并交给其两张' },
  ], { victimId }, true)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'draw-count') {
    const count = Number((response.payload as { optionId?: string }).optionId)
    const victimId = resolution.data.victimId as PlayerId
    if (!Number.isInteger(count) || count < 1 || count > 2 || !playerOf(host.state, victimId)?.alive) return
    drawCards(host.state, host.rng, ownerId, count, (name, data) => host.dispatch(name, data))
    const available = hand(host.state, ownerId)
    if (available.length < count) return
    askCards(host, SHUNJI, ownerId, 'give', `【顺机】：选择${count}张牌交给受伤角色`, available, count, count, { victimId, count }, false)
    return
  }
  if (resolution.step !== 'give') return
  const victimId = resolution.data.victimId as PlayerId
  const victim = playerOf(host.state, victimId)
  const selected = validChosenCards(host.state, ownerId, (response.payload as { cardIds?: CardId[] }).cardIds ?? [])
  if (!victim?.alive || selected.length !== Number(resolution.data.count)) return
  const transferred = victimId === ownerId ? [] : giveCards(host as never, ownerId, victimId, selected, SHUNJI)
  const lostNames = [...new Set(transferred.map((cardId) => host.state.cards[cardId]?.name).filter((name): name is string => !!name))]
    .filter((name) => !hand(host.state, ownerId).some((cardId) => host.state.cards[cardId]?.name === name)
      && !Object.values(playerOf(host.state, ownerId)?.zones.equipment ?? {}).some((cardId) => cardId && host.state.cards[cardId]?.name === name))
  const already = stateOf(host).dongzhaoNames?.[ownerId] ?? []
  for (const name of lostNames.filter((entry) => !already.includes(entry))) {
    stateOf(host).dongzhaoNames ??= {}
    stateOf(host).dongzhaoNames![ownerId] = [...(stateOf(host).dongzhaoNames![ownerId] ?? []), name]
    resolveDamage(host, { sourceId: ownerId, targetId: victimId, amount: 1, cardName: '【顺机】' })
    break
  }
} })

registerSkillRuntime({ id: DANCHI,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { targetId?: PlayerId; finalAmount?: number }
      const target = payload.targetId ? playerOf(host.state, payload.targetId) : undefined
      if (!target?.alive || !playerOf(host.state, ownerId)?.alive || Number(payload.finalAmount ?? 0) <= 0
        || getDistance(host.state, ownerId, target.id) > 1
        || stateOf(host).chengyuDanchiUsed?.[ownerId] === host.state.turnNumber) return
      host.queueSkill({ skillId: DANCHI, ownerId, step: 'choose-category', data: { victimId: target.id, sourceId: context.event.sourceId ?? null } })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; sourceSkillId?: string }
      if (payload.sourceSkillId === DANCHI && payload.cardName === '无中生有') {
        const flow = stateOf(host).chengyuDanchiFlow?.[ownerId]
        if (flow?.stage === 'wuzhong') {
          if (flow.usedCategory !== flow.category) host.queueSkill({ skillId: DANCHI, ownerId, step: 'use-slash', data: {} })
          else delete stateOf(host).chengyuDanchiFlow?.[ownerId]
        }
        return
      }
      if (payload.sourceSkillId === DANCHI && payload.cardName === '杀') { delete stateOf(host).chengyuDanchiFlow?.[ownerId]; return }
      const pending = stateOf(host).chengyuDanchi?.[ownerId]
      const sourceId = context.event.sourceId
      if (!pending || pending.sourceId !== sourceId || !sourceId) return
      const usedId = payload.cardId
      const usedCard = usedId ? host.state.cards[usedId] : undefined
      delete stateOf(host).chengyuDanchi![ownerId]
      if (!playerOf(host.state, ownerId)?.alive) return
      stateOf(host).chengyuDanchiFlow ??= {}
      const usedName = payload.cardName ?? usedCard?.name
      const usedCategory = usedName === '杀' || usedName === '闪' || usedName === '桃' || usedName === '酒'
        ? 'basic' : usedName && INSTANT_TRICKS.has(usedName) ? 'trick' : usedCard?.category ?? ''
      stateOf(host).chengyuDanchiFlow![ownerId] = { category: pending.category, usedCategory, stage: 'wuzhong' }
      host.queueSkill({ skillId: DANCHI, ownerId, step: 'use-wuzhong', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'use-wuzhong') {
      const cardId = createVirtualTrick(host.state, ownerId, '无中生有', DANCHI)
      const action = declaredCardActions(host.state, ownerId, cardId, '无中生有', '【胆持】视为使用【无中生有】', { sourceSkillId: DANCHI })
        .find((entry) => entry.kind === 'use-card' && entry.targetIds.length === 0)
      if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
      else delete stateOf(host).chengyuDanchiFlow?.[ownerId]
      return
    }
    if (prompt.step === 'use-slash') {
      const slashId = createVirtualSlashCard(host.state, ownerId, DANCHI)
      const actions = declaredCardActions(host.state, ownerId, slashId, '杀', '【胆持】视为使用【杀】', { sourceSkillId: DANCHI })
        .filter((entry) => entry.kind === 'use-card')
      if (actions.length === 1 && actions[0]?.kind === 'use-card') executeUseCardAction(host as never, ownerId, actions[0])
      else if (actions.length) host.askSkill({ skillId: DANCHI, ownerId, step: 'slash-target', data: { slashId }, build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【胆持】：选择额外【杀】的目标', timeoutMs: 25_000,
        optional: true, candidateIds: [...new Set(actions.flatMap((entry) => entry.kind === 'use-card' ? entry.targetIds : []))], min: 1,
        max: Math.max(...actions.map((entry) => entry.kind === 'use-card' ? entry.targetMax : 1)),
      }) })
      else delete stateOf(host).chengyuDanchiFlow?.[ownerId]
      return
    }
    if (prompt.step !== 'choose-category') return
    const victimId = prompt.data.victimId as PlayerId
    const victim = playerOf(host.state, victimId)
    if (!victim?.alive || getDistance(host.state, ownerId, victimId) > 1) return
    host.askSkill({ skillId: DANCHI, ownerId, step: 'category', data: prompt.data, build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: victimId, prompt: '【胆持】：选择一种牌的类别', timeoutMs: 25_000,
      optional: false, options: [{ id: 'basic', label: '基本牌' }, { id: 'trick', label: '锦囊牌' }, { id: 'equipment', label: '装备牌' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'slash-target') {
      const slashId = resolution.data.slashId as CardId
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const action = declaredCardActions(host.state, ownerId, slashId, '杀', '【胆持】视为使用【杀】', { sourceSkillId: DANCHI })
        .find((candidate) => candidate.kind === 'use-card' && candidate.targetIds.length === targetIds.length
          && candidate.targetIds.every((target, index) => target === targetIds[index]))
      if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
      return
    }
    if (resolution.step !== 'category') return
    const victimId = resolution.data.victimId as PlayerId
    const sourceId = resolution.data.sourceId as PlayerId | null
    const category = (response.payload as { optionId?: string }).optionId
    if (!['basic', 'trick', 'equipment'].includes(category ?? '') || !playerOf(host.state, victimId)?.alive
      || (sourceId && !playerOf(host.state, sourceId)?.alive)) return
    stateOf(host).chengyuDanchiUsed ??= {}
    stateOf(host).chengyuDanchiUsed![ownerId] = host.state.turnNumber
    stateOf(host).chengyuDanchi ??= {}
    if (sourceId) stateOf(host).chengyuDanchi![ownerId] = { victimId, sourceId, category: category!, turnNumber: host.state.turnNumber }
  },
})

registerSkillRuntime({ id: DAOJIE, triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
  const payload = context.event.payload as { cardId?: CardId; cardName?: string }
  if (context.event.sourceId !== ownerId || !payload.cardId || stateOf(host).xunUsedTrick?.[ownerId] === host.state.turnNumber) return
  const card = host.state.cards[payload.cardId]
  const name = payload.cardName ?? card?.name
  if (card?.category !== 'trick' || !name || DAMAGE_TRICKS.has(name)) return
  stateOf(host).xunUsedTrick ??= {}
  stateOf(host).xunUsedTrick![ownerId] = host.state.turnNumber
  const owner = playerOf(host.state, ownerId)
  const locked = (owner?.characterId ? getCharacter(owner.characterId)?.skills : [])
    ?.filter((entry) => isLockedSkill(entry.id) && !entry.granted) ?? []
  const kin = host.state.players.filter((player) => player.alive && player.id !== ownerId
    && !!player.characterId && getCharacter(player.characterId)?.clan === 'xun')
  if (!locked.length || !kin.length) {
    loseHp(host, ownerId, 1, DAOJIE)
    return
  }
  const options = [{ id: 'lose', label: '失去1点体力' }, ...locked.flatMap((entry) => kin.map((target) => ({
    id: `transfer:${entry.id}:${target.id}`, label: `失去锁定技【${entry.name}】并令${target.nickname}获得此牌`,
  })))]
  host.queueSkill({ skillId: DAOJIE, ownerId, step: 'choose', data: { cardId: payload.cardId, options } })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'choose') return
  const options = prompt.data.options as Array<{ id: string; label: string }>
  askOption(host, DAOJIE, ownerId, 'choose', '【蹈节】：选择失去1点体力，或失去一个锁定技令同族角色获得此牌', options, prompt.data, false)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'choose') return
  const option = (response.payload as { optionId?: string }).optionId ?? ''
  if (option === 'lose') { loseHp(host, ownerId, 1, DAOJIE); return }
  const match = /^transfer:(.+):([^:]+)$/.exec(option)
  if (!match) return
  const skillId = match[1]!
  const targetId = match[2] as PlayerId
  const target = playerOf(host.state, targetId)
  const cardId = resolution.data.cardId as CardId
  if (!target?.alive || !target.characterId || getCharacter(target.characterId)?.clan !== 'xun'
    || !isLockedSkill(skillId) || !host.state.zones.discardPile.includes(cardId)) return
  suppressSkill(host.state, { targetId: ownerId, skillId, sourceId: ownerId, sourceSkillId: DAOJIE,
    expiresAt: 'never', armedAtTurn: host.state.turnNumber })
  grantSkill(host.state, targetId, skillId)
  moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
} })

registerSkillRuntime({ id: LIDAN,
  extraTargetsForTrick(state, ownerId, cardName) {
    return (state as Batch66State).b66?.chengyuNext?.[ownerId] === 'trick' && INSTANT_TRICKS.has(cardName) ? 1 : 0
  },
  extraSlashTargets(state, ownerId) {
    return (state as Batch66State).b66?.chengyuNext?.[ownerId] === 'slash' ? 1 : 0
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
    const name = payload.cardName ?? card?.name
    stateOf(host).chengyuNext ??= {}
    if (name === '杀') stateOf(host).chengyuNext![ownerId] = 'trick'
    else if (card?.category === 'trick' && name && INSTANT_TRICKS.has(name)) stateOf(host).chengyuNext![ownerId] = 'slash'
  } }],
})

registerSkillRuntime({ id: SANHUANG,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const card = cardId ? host.state.cards[cardId] : undefined
    if (!card || !['basic', 'trick', 'equipment'].includes(card.category)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const key = `b66-sanhuang:${host.state.roundNumber}:${card.category}`
    if (owner.marks[key]) return
    owner.marks[key] = 1
    host.queueSkill({ skillId: SANHUANG, ownerId, step: 'target', data: { cardId, category: card.category } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId)
    askTargets(host, SANHUANG, ownerId, 'target', '【三恇】：选择一名其他角色', targets.map((player) => player.id), 1, 1,
      prompt.data, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const cardId = resolution.data.cardId as CardId
      if (!target?.alive) return
      const x = Number(target.zones.hand.length + Object.values(target.zones.equipment).filter(Boolean).length + target.zones.judgingArea.length > 0)
        + Number(target.hp < target.maxHp) + Number(target.hp < target.zones.hand.length)
      if (target.zones.hand.length < x) return
      stateOf(host).xunTripletUsed ??= {}
      stateOf(host).xunTripletUsed![ownerId] = { round: host.state.roundNumber, category: String(resolution.data.category) }
      stateOf(host).bishiTarget ??= {}
      if (x > 0 && !stateOf(host).xunEmptyHandTarget?.[ownerId] && !stateOf(host).bishiUsed?.[ownerId])
        stateOf(host).bishiTarget![ownerId] = target.id
      if (x === 0) {
        if (host.state.zones.discardPile.includes(cardId)) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        return
      }
      askCards(host, SANHUANG, ownerId, 'give', `【三恇】：令${target.nickname}交给你至少${x}张手牌`,
        target.zones.hand, x, target.zones.hand.length, { targetId, cardId, x }, false)
      return
    }
    if (resolution.step !== 'give') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const requested = Number(resolution.data.x)
    const cards = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => target?.zones.hand.includes(cardId))
    if (!target?.alive || cards.length < requested) return
    const handed = giveCards(host as never, targetId, ownerId, cards, SANHUANG)
    const cardId = resolution.data.cardId as CardId
    if (host.state.zones.discardPile.includes(cardId)) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    if (target.zones.hand.length > 0 && stateOf(host).bishiTarget?.[ownerId] === targetId) {
      delete stateOf(host).bishiTarget?.[ownerId]
    }
    if (target.zones.hand.length === 0 && stateOf(host).bishiTarget?.[ownerId] === targetId) {
      stateOf(host).xunEmptyHandTarget ??= {}
      stateOf(host).xunEmptyHandTarget![ownerId] = targetId
    }
    if (!handed.length && requested > 0) return
  },
})

registerSkillRuntime({ id: BEISHI, triggers: [{ event: 'HandCardLeft', handle(host, ownerId, context) {
  const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
  if (!targetId || targetId !== stateOf(host).bishiTarget?.[ownerId] || hand(host.state, targetId).length > 0
    || stateOf(host).bishiUsed?.[ownerId]) return
  stateOf(host).bishiUsed ??= {}
  stateOf(host).bishiUsed![ownerId] = true
  stateOf(host).bishiTarget![ownerId] = '' as PlayerId
  const owner = playerOf(host.state, ownerId)
  if (owner?.alive && owner.hp < owner.maxHp) recover(host, ownerId, 1, ownerId, BEISHI)
} }] })

export const HISTORICAL_BATCH66_CHARACTERS = [
  MOU_DENGAI_B66, MOU_LUSU_B66, MOU_XUYOU_B66, MOU_XIZHICAI_B66, MOU_ZHANGRANG_B66,
  MOU_DONGZHAO_B66, MOU_CHENGYU_B66, CLAN_XUNSHU_B66, CLAN_XUNCHEN_B66, CLAN_XUNCAI_B66,
] as const

const LUCUN_NAMES = ['杀', '桃', '酒', ...INSTANT_TRICKS]
function createLucunCard(host: SkillHost, ownerId: PlayerId, name: string): CardId {
  const cardId = `virtual:${LUCUN}:${host.state.seq + 1}:${host.state.decisions.length}`
  host.state.cards[cardId] = { id: cardId, ruleset: host.state.rulesetVersion, expansion: 'standard', name,
    suit: 'spade', rank: 1, color: 'black', category: INSTANT_TRICKS.has(name) || name === '无懈可击' ? 'trick' : 'basic',
    virtual: true, sourceSkillId: LUCUN }
  playerOf(host.state, ownerId)!.zones.hand.push(cardId)
  return cardId
}
function lucunOptions(state: SanguoshaState, ownerId: PlayerId): string[] {
  const used = new Set((state as Batch66State).b66?.zhangrangUsedNames?.[ownerId] ?? [])
  return LUCUN_NAMES.filter((name) => !used.has(name))
}

registerSkillRuntime({ id: LUCUN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && lucunOptions(state, ownerId).length
      ? [{ id: `skill:${LUCUN}`, label: '发动【赂存】：视为使用一张尚未以此法使用的基本牌或普通锦囊牌' }] : []
  },
  onGameStart(host, ownerId) { playerOf(host.state, ownerId)!.characterPiles[LU] ??= [] },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${LUCUN}`) return
    const names = lucunOptions(host.state, ownerId)
    host.askSkill({ skillId: LUCUN, ownerId, step: 'name', data: { names }, build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【赂存】：选择一种尚未以此法使用的牌',
      timeoutMs: 25_000, optional: true, options: names.map((name) => ({ id: name, label: name })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'name') {
      const name = (response.payload as { optionId?: string }).optionId
      if (!name || !(resolution.data.names as string[]).includes(name) || !lucunOptions(host.state, ownerId).includes(name)) return
      const cardId = createLucunCard(host, ownerId, name)
      const actions = declaredCardActions(host.state, ownerId, cardId, name, `【赂存】视为使用【${name}】`, { sourceSkillId: LUCUN })
        .filter((action) => action.kind === 'use-card')
      if (!actions.length) { playerOf(host.state, ownerId)!.zones.hand = hand(host.state, ownerId).filter((id) => id !== cardId); delete host.state.cards[cardId]; return }
      stateOf(host).zhangrangUsedNames ??= {}
      stateOf(host).zhangrangUsedNames![ownerId] = [...(stateOf(host).zhangrangUsedNames![ownerId] ?? []), name]
      if (actions.length === 1 && actions[0]?.kind === 'use-card') executeUseCardAction(host as never, ownerId, actions[0])
      else host.askSkill({ skillId: LUCUN, ownerId, step: 'targets', data: { cardId, name }, build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: `【赂存】：选择【${name}】的目标`, timeoutMs: 25_000,
        optional: false, candidateIds: [...new Set(actions.flatMap((action) => action.kind === 'use-card' ? action.targetIds : []))],
        min: Math.min(...actions.map((action) => action.kind === 'use-card' ? action.targetMin : 1)),
        max: Math.max(...actions.map((action) => action.kind === 'use-card' ? action.targetMax : 1)),
      }) })
      return
    }
    if (resolution.step !== 'targets') return
    const cardId = resolution.data.cardId as CardId
    const name = resolution.data.name as string
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const action = declaredCardActions(host.state, ownerId, cardId, name, `【赂存】视为使用【${name}】`, { sourceSkillId: LUCUN })
      .find((entry) => entry.kind === 'use-card' && entry.targetIds.length === targetIds.length
        && entry.targetIds.every((target, index) => target === targetIds[index]))
    if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
  },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
      stateOf(host).zhangrangUsedNames ??= {}
      stateOf(host).zhangrangUsedNames![ownerId] = []
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[]; sourceSkillId?: string }
      if (context.event.sourceId !== ownerId || payload.sourceSkillId !== LUCUN) return
      const owner = playerOf(host.state, ownerId)
      const cardName = payload.cardName ?? (payload.cardId ? host.state.cards[payload.cardId]?.name : undefined)
      if (!owner || !cardName) return
      stateOf(host).zhangrangNames ??= {}
      stateOf(host).zhangrangNames![ownerId] = [...new Set([...(stateOf(host).zhangrangNames![ownerId] ?? []), cardName])]
      const targets = (payload.targetIds ?? []).map((playerId) => playerOf(host.state, playerId)).filter((player) => player?.alive)
      if (!targets.length) return
      const maxHand = Math.max(...targets.map((player) => player!.zones.hand.length))
      const tied = targets.filter((player) => player!.zones.hand.length === maxHand)
      if (!tied.length || maxHand === 0) return
      const holder = tied[host.rng.nextInt(tied.length)]!
      const cardId = holder.zones.hand[host.rng.nextInt(holder.zones.hand.length)]
      if (!cardId) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: holder.id }, { kind: 'characterPile', playerId: ownerId, pile: LU })
      stateOf(host).zhangrangLu ??= {}
      stateOf(host).zhangrangLu![ownerId] = [...(stateOf(host).zhangrangLu![ownerId] ?? []), cardId]
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      const pile = playerOf(host.state, ownerId)?.characterPiles[LU] ?? []
      if (!pile.length) return
      const cardId = pile[host.rng.nextInt(pile.length)]!
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: LU }, { kind: 'discardPile' })
      const record = stateOf(host).zhangrangLu?.[ownerId] ?? []
      stateOf(host).zhangrangLu![ownerId] = record.filter((id) => id !== cardId)
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    } },
  ],
})

registerSkillRuntime({ id: TUISHENG, limited: true, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    if (context.event.payload.playerId === ownerId && (context.event.payload as { phase?: string }).phase === 'prepare')
      host.queueSkill({ skillId: TUISHENG, ownerId, step: 'invoke', data: { trigger: 'prepare' } })
  } },
  { event: 'EnterDying', handle(host, ownerId, context) {
    if (context.event.targetId === ownerId) host.queueSkill({ skillId: TUISHENG, ownerId, step: 'invoke', data: { trigger: 'dying' } })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'invoke' || stateOf(host).tuishengUsed?.[ownerId]) return
  askOption(host, TUISHENG, ownerId, 'invoke', '【蜕生】：是否重置“赂存”使用记录并回复1点体力？', [
    { id: 'yes', label: '发动蜕生' }, { id: 'no', label: '不发动' },
  ], prompt.data)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes' || stateOf(host).tuishengUsed?.[ownerId]) return
    const names = [...(stateOf(host).zhangrangNames?.[ownerId] ?? [])]
    stateOf(host).zhangrangNames ??= {}
    stateOf(host).zhangrangNames![ownerId] = names
    stateOf(host).zhangrangUsedNames ??= {}
    stateOf(host).zhangrangUsedNames![ownerId] = []
    stateOf(host).tuishengUsed ??= {}
    stateOf(host).tuishengUsed![ownerId] = true
    const canTake = host.state.zones.discardPile.some((cardId) => names.includes(host.state.cards[cardId]?.name ?? ''))
    askOption(host, TUISHENG, ownerId, 'choice', '【蜕生】：选择将手牌置为“赂”，或从弃牌堆随机获得牌', [
      { id: 'lu', label: '将所有手牌置为“赂”' }, ...(canTake ? [{ id: 'gain', label: `随机获得至多${host.state.roundNumber}张牌` }] : []),
    ], { names }, false)
    return
  }
  if (resolution.step !== 'choice') return
  const option = (response.payload as { optionId?: string }).optionId
  const player = playerOf(host.state, ownerId)
  if (!player?.alive) return
  if (option === 'lu') {
    player.characterPiles[LU] ??= []
    for (const cardId of [...hand(host.state, ownerId)]) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: LU })
  } else if (option === 'gain') {
    const names = resolution.data.names as string[]
    const candidates = host.state.zones.discardPile.filter((cardId) => names.includes(host.state.cards[cardId]?.name ?? ''))
    const count = Math.min(candidates.length, host.state.roundNumber)
    for (let index = 0; index < count; index += 1) {
      const cardId = candidates.splice(host.rng.nextInt(candidates.length), 1)[0]!
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    }
  } else return
  if (player.hp < player.maxHp) recover(host, ownerId, 1, ownerId, TUISHENG)
} })

function askXinjuanDiscard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, amount: number): void {
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  drawCards(host.state, host.rng, targetId, amount, (name, data) => host.dispatch(name, data))
  const cards = hand(host.state, targetId)
  const count = Math.min(amount, cards.length)
  host.askSkill({ skillId: XINJUAN, ownerId, step: 'discard', data: { targetId, amount, count }, build: (requestId): ChooseCardsRequest => ({
    id: requestId, kind: 'choose-cards', playerId: targetId, prompt: `【薪传】：弃置${count}张手牌`, timeoutMs: 25_000,
    optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: count, max: count,
  }) })
}

registerSkillRuntime({ id: XINJUAN, triggers: [
  { event: 'TurnStart', handle(host) { stateOf(host).discardSuitLedger = { turnNumber: host.state.turnNumber, suits: [] } } },
  { event: 'CardEnteredDiscardByMove', handle(host, _ownerId, context) {
    const p = context.event.payload as { cardId?: CardId }
    const suit = p.cardId ? host.state.cards[p.cardId]?.suit : undefined
    if (!suit || !['spade', 'heart', 'club', 'diamond'].includes(suit)) return
    const ledger = stateOf(host).discardSuitLedger
    if (!ledger || ledger.turnNumber !== host.state.turnNumber) stateOf(host).discardSuitLedger = { turnNumber: host.state.turnNumber, suits: [suit] }
    else if (!ledger.suits.includes(suit)) ledger.suits.push(suit)
  } },
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId }
    const cardId = payload.cardId
    const card = cardId ? host.state.cards[cardId] : undefined
    if (context.event.sourceId !== ownerId || !cardId || card?.category !== 'trick'
      || !host.state.zones.discardPile.includes(cardId)) return
    const ledger = stateOf(host).discardSuitLedger
    const amount = 4 - (ledger?.turnNumber === host.state.turnNumber ? ledger.suits.length : 0)
    host.queueSkill({ skillId: XINJUAN, ownerId, step: 'target', data: { amount } })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'target') return
  askTargets(host, XINJUAN, ownerId, 'target', '【薪传】：选择一名角色开始依次摸牌并弃牌',
    host.state.players.filter((player) => player.alive).map((player) => player.id), 1, 1, prompt.data, true)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    const amount = Math.max(0, Math.min(4, Number(resolution.data.amount)))
    stateOf(host).xinjuanRun ??= {}
    stateOf(host).xinjuanRun![ownerId] = { amount, playerIds: [targetId], index: 0 }
    stateOf(host).xinjuanVisited ??= {}
    stateOf(host).xinjuanVisited![ownerId] = [targetId]
    askXinjuanDiscard(host, ownerId, targetId, amount)
    return
  }
  if (resolution.step !== 'discard') return
  const targetId = resolution.data.targetId as PlayerId
  const target = playerOf(host.state, targetId)
  const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    .filter((cardId) => target?.zones.hand.includes(cardId)).slice(0, Number(resolution.data.count))
  if (!target?.alive || selected.length !== Number(resolution.data.count)) return
  discardCardsByIds(host as never, targetId, selected, XINJUAN)
  const run = stateOf(host).xinjuanRun?.[ownerId]
  const visited = stateOf(host).xinjuanVisited?.[ownerId] ?? []
  if (!run || target.zones.hand.length !== target.hp || visited.length >= host.state.players.length) {
    delete stateOf(host).xinjuanRun?.[ownerId]
    delete stateOf(host).xinjuanVisited?.[ownerId]
    return
  }
  const alive = host.state.players.filter((player) => player.alive).sort((a, b) => a.seat - b.seat)
  const next = alive.find((player) => player.seat > target.seat) ?? alive[0]
  if (!next || visited.includes(next.id)) {
    delete stateOf(host).xinjuanRun?.[ownerId]
    delete stateOf(host).xinjuanVisited?.[ownerId]
    return
  }
  visited.push(next.id)
  run.playerIds.push(next.id)
  run.index += 1
  askXinjuanDiscard(host, ownerId, next.id, run.amount)
} })

registerSkillRuntime({ id: SHENJUN_SKILL, triggers: [
  { event: 'CardUsed', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId
    const card = cardId ? host.state.cards[cardId] : undefined
    const name = payload.cardName ?? card?.name
    if (!name || (name !== '杀' && !(card?.category === 'trick' && INSTANT_TRICKS.has(name)))) return
    const ids = hand(host.state, ownerId).filter((candidate) => host.state.cards[candidate]?.name === name)
    if (!ids.length) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const record = stateOf(host).shenjun?.[ownerId]
    const key = phaseKey(host.state)
    stateOf(host).shenjun ??= {}
    stateOf(host).shenjun![ownerId] = record?.phaseKey === key
      ? { cardIds: [...new Set([...record.cardIds, ...ids])], names: [...new Set([...record.names, name])], phaseKey: key }
      : { cardIds: ids, names: [name], phaseKey: key }
    host.state.faceUpHandCards ??= {}
    host.state.faceUpHandCards[ownerId] = [...new Set([...(host.state.faceUpHandCards[ownerId] ?? []), ...ids])]
    host.dispatch('SkillActivated', { skillId: SHENJUN_SKILL, skillName: '神君', playerId: ownerId,
      cardIds: ids, logText: `${owner.nickname}展示${ids.length}张同名手牌，记为“神君”` }, { sourceId: ownerId, cardIds: ids })
  } },
  { event: 'PhaseEnd', handle(host, ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    const record = stateOf(host).shenjun?.[ownerId]
    if (!record || !playerOf(host.state, ownerId)?.alive || record.phaseKey !== `${host.state.turnNumber}:${p.phase}`) return
    if (p.playerId !== host.state.currentPlayerId) return
    const liveMarks = record.cardIds.filter((cardId) => hand(host.state, ownerId).includes(cardId))
    if (!liveMarks.length) {
      host.state.faceUpHandCards![ownerId] = (host.state.faceUpHandCards?.[ownerId] ?? []).filter((cardId) => !record.cardIds.includes(cardId))
      delete stateOf(host).shenjun?.[ownerId]
      return
    }
    stateOf(host).shenjunPhaseUsed ??= {}
    stateOf(host).shenjunPhaseUsed![ownerId] = { phaseKey: record.phaseKey, remaining: liveMarks.length }
    host.queueSkill({ skillId: SHENJUN_SKILL, ownerId, step: 'invoke', data: { phaseKey: record.phaseKey } })
  } },
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceSkillId !== SHENJUN_SKILL || context.event.sourceId !== ownerId) return
    const record = stateOf(host).shenjunPhaseUsed?.[ownerId]
    if (record && record.phaseKey === phaseKey(host.state)) record.remaining = Math.max(0, record.remaining - 1)
  } },
  { event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceSkillId?: string }
    if (payload.sourceSkillId !== SHENJUN_SKILL || context.event.sourceId !== ownerId) return
    const record = stateOf(host).shenjunPhaseUsed?.[ownerId]
    if (record?.remaining) host.queueSkill({ skillId: SHENJUN_SKILL, ownerId, step: 'next', data: { phaseKey: record.phaseKey } })
    else {
      const marked = stateOf(host).shenjun?.[ownerId]?.cardIds ?? []
      host.state.faceUpHandCards![ownerId] = (host.state.faceUpHandCards?.[ownerId] ?? []).filter((cardId) => !marked.includes(cardId))
      delete stateOf(host).shenjun?.[ownerId]
      delete stateOf(host).shenjunPhaseUsed?.[ownerId]
    }
  } },
], startQueued(host, ownerId, prompt) {
  const record = stateOf(host).shenjun?.[ownerId]
  const usage = stateOf(host).shenjunPhaseUsed?.[ownerId]
  if (!record || !usage || prompt.data.phaseKey !== usage.phaseKey || !usage.remaining) return
  if (prompt.step === 'invoke') {
    askOption(host, SHENJUN_SKILL, ownerId, 'invoke', `【神君】：本阶段记有${usage.remaining}张“神君”，是否开始使用？`, [
      { id: 'yes', label: '开始使用' }, { id: 'no', label: '不发动' },
    ], prompt.data)
    return
  }
  if (prompt.step === 'next') {
    host.queueSkill({ skillId: SHENJUN_SKILL, ownerId, step: 'material', data: prompt.data })
    return
  }
  if (prompt.step === 'material') {
    const candidates = hand(host.state, ownerId)
    if (!candidates.length) {
      const marked = record.cardIds
      host.state.faceUpHandCards![ownerId] = (host.state.faceUpHandCards?.[ownerId] ?? []).filter((cardId) => !marked.includes(cardId))
      delete stateOf(host).shenjun?.[ownerId]
      delete stateOf(host).shenjunPhaseUsed?.[ownerId]
      return
    }
    askCards(host, SHENJUN_SKILL, ownerId, 'material', '【神君】：选择一张手牌作为使用牌', candidates, 1, 1, prompt.data, false)
  }
}, resume(host, ownerId, resolution, response) {
  const usage = stateOf(host).shenjunPhaseUsed?.[ownerId]
  const record = stateOf(host).shenjun?.[ownerId]
  if (!usage || !record || resolution.data.phaseKey !== usage.phaseKey || !usage.remaining) return
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') {
      host.state.faceUpHandCards![ownerId] = (host.state.faceUpHandCards?.[ownerId] ?? [])
        .filter((cardId) => !record.cardIds.includes(cardId))
      delete stateOf(host).shenjunPhaseUsed?.[ownerId]
      delete stateOf(host).shenjun?.[ownerId]
      return
    }
    host.queueSkill({ skillId: SHENJUN_SKILL, ownerId, step: 'material', data: resolution.data })
    return
  }
  if (resolution.step === 'material') {
    const cardId = validChosenCards(host.state, ownerId, (response.payload as { cardIds?: CardId[] }).cardIds ?? [])[0]
    const names = record.names.filter((name) => name === '杀' || INSTANT_TRICKS.has(name))
    if (!cardId || !names.length) return
    host.askSkill({ skillId: SHENJUN_SKILL, ownerId, step: 'name', data: { cardId, names, phaseKey: usage.phaseKey }, build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【神君】：选择一种已记为“神君”的牌名',
      timeoutMs: 25_000, optional: false, options: names.map((name) => ({ id: name, label: name })),
    }) })
    return
  }
  if (resolution.step === 'name') {
    const cardId = resolution.data.cardId as CardId
    const name = (response.payload as { optionId?: string }).optionId
    if (!name || !(resolution.data.names as string[]).includes(name) || !hand(host.state, ownerId).includes(cardId)) return
    setCardAlias(host.state, cardId, name)
    const actions = declaredCardActions(host.state, ownerId, cardId, name, `【神君】视为使用【${name}】`, { sourceSkillId: SHENJUN_SKILL })
      .filter((action) => action.kind === 'use-card')
    if (!actions.length) { setCardAlias(host.state, cardId, host.state.cards[cardId]!.name); return }
    if (actions.length === 1 && actions[0]?.kind === 'use-card') executeUseCardAction(host as never, ownerId, actions[0])
    else host.askSkill({ skillId: SHENJUN_SKILL, ownerId, step: 'targets', data: { cardId, name, phaseKey: usage.phaseKey }, build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: `【神君】：选择【${name}】目标`, timeoutMs: 25_000,
      optional: false, candidateIds: [...new Set(actions.flatMap((action) => action.kind === 'use-card' ? action.targetIds : []))],
      min: Math.min(...actions.map((action) => action.kind === 'use-card' ? action.targetMin : 1)),
      max: Math.max(...actions.map((action) => action.kind === 'use-card' ? action.targetMax : 1)),
    }) })
    return
  }
  if (resolution.step === 'targets') {
    const cardId = resolution.data.cardId as CardId
    const name = resolution.data.name as string
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const action = declaredCardActions(host.state, ownerId, cardId, name, `【神君】视为使用【${name}】`, { sourceSkillId: SHENJUN_SKILL })
      .find((entry) => entry.kind === 'use-card' && entry.targetIds.length === targetIds.length
        && entry.targetIds.every((target, index) => target === targetIds[index]))
    if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
    else setCardAlias(host.state, cardId, host.state.cards[cardId]!.name)
  }
} })


