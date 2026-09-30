import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, clanOfCharacter, isCardUseProhibited, type SkillHost, type ViewAsOption } from '../../engine/skills/runtime'
import { maxCardsOf } from '../../engine/phase'
import { recover } from '../../engine/recover'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { effectiveGenderOf } from '../../engine/huashen'
import { setChained } from '../../engine/character-state'
import { clearUsedThisPhase, markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { discardCardsByIds } from '../../engine/discard-all'
import { phaseSlotOf } from '../../engine/phase-replacement'
import { giveOwnedCards } from '../../engine/hand-transfer'
import { giveCards } from '../../engine/hand-transfer'
import { locateOwnedCard } from '../../engine/zones'
import { useVirtualWine, applyWineEffect } from '../../engine/virtual-wine'
import { isSkillSuppressed, suppressSkill } from '../../engine/skill-suppression'
import { canPindian, registerPindianContinuation, startPindian, finishPindianSettlement, claimPindianCards } from '../../engine/pindian'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { getDistance } from '../../engine/distance'
import { skillHandCardUseActions } from '../../engine/cards/basic'
import { moveCard } from '../../engine/zones'
import { effectiveCardColor, effectiveCardSuit } from '../../engine/skills/runtime'
import { conversionStateOf as engineConversionStateOf, toggleConversionState as engineToggleConversionState } from '../../engine/conversion'
import { skillIdsOf } from './standard'
import { getCharacter } from './standard'
import { skillOtherHandCardUseActions } from '../../engine/cards/basic'
import type { MultiCardViewAsSpec } from '../../engine/multi-card-viewas'
import { hiddenHandSlot } from '../../engine/cards/host'
import { resolvePickedCard } from '../../engine/card-pick'

const B = '-b67'
const sid = (name: string) => `${name}${B}`
const stateOf = (host: SkillHost) => host.state as Batch67State
const playerOf = (state: SanguoshaState, playerId: PlayerId) => state.players.find((player) => player.id === playerId)
const handOf = (state: SanguoshaState, playerId: PlayerId): CardId[] => playerOf(state, playerId)?.zones.hand ?? []
type Batch67State = SanguoshaState & { b67?: {
  muyinBonus?: Record<PlayerId, number>
  muyinUsed?: Record<PlayerId, number>
  baizuUsed?: Record<PlayerId, boolean>
  fuzhenRounds?: Record<PlayerId, number>
  lianheLinks?: Record<PlayerId, PlayerId[]>
  guangu?: Record<PlayerId, { polarity: 'yang' | 'yin'; viewedCount: number }>
  xiaoyongUsed?: Record<PlayerId, number>
  jiexuan?: Record<PlayerId, 'yang' | 'yin'>
  mingjie?: Record<PlayerId, { targetId: PlayerId; expiresTurn: number; turnNumber: number; records: Array<{ cardId: CardId; cardName: string; used: boolean }> }>
  xuncanFirstTarget?: Record<PlayerId, PlayerId>
  xuncanWushenUsed?: Record<PlayerId, number>
  xuncanShangshenTurn?: Record<PlayerId, number>
  wuxianYirongUses?: Record<PlayerId, { phaseKey: string; count: number }>
  fangzhenExpires?: Record<PlayerId, number[]>
  lianhePending?: Record<PlayerId, Array<{ createdAt: string; phaseKey?: string; drew: boolean; gained: number }>>
  liujuUse?: { ownerId: PlayerId; loserId: PlayerId; cardId: CardId; targetId: PlayerId; beforeOut: number; beforeBack: number }
  huanjiaUse?: { ownerId: PlayerId; cardId: CardId; usedCardId: CardId; unusedCardId: CardId }
  guanguCount?: Record<PlayerId, number>
  xiaoyongTurn?: Record<PlayerId, number>
  zhangdingCarrier?: Record<CardId, { ownerId: PlayerId; countedSlash: boolean }>
  lianzhuBonus?: Record<PlayerId, number>
  lianzhuPhaseUse?: Record<PlayerId, string>
  kaijiUsed?: Record<PlayerId, { round: number; targets: PlayerId[] }>
  kaijiCurrent?: { ownerId: PlayerId; cardId: CardId; actionIds: string[] }
  kaijiDrawAfterCard?: Record<CardId, PlayerId>
  mingjieAwaiting?: Record<PlayerId, CardId>
  lianzhuPending?: { targetId: PlayerId; actorId: PlayerId; secondActorId: PlayerId; stage: 'first' | 'second'; firstColor?: 'red' | 'black' | null }
} }

const MUYIN = sid('muyin-clan-wu')
const XUMIN = sid('xumin-clan-han')
const BAIZU = sid('baizu-clan-zhong')
const ZHONGLIU = 'zhongliu-clan-wang'
const XUNCAN = 'clan-xuncan-b67'
const WUXIAN = 'clan-wuxian-b67'
const WUBAN = 'clan-wuban-b67'
const HANSHAO = 'clan-hanshao-b67'
const HANRONG = 'clan-hanrong-b67'
const ZHONGYAN = 'clan-zhongyan-b67'
const WUKUANG = 'clan-wukuang-b67'
const WANGYUN = 'clan-wangyun-b67'
const WANGLING = 'clan-wangling-b67'
const WANGCHANG = 'clan-wangchang-b67'
const JIEXUAN = sid('jiexuan-clan-wangyun')
const MINGJIE = sid('mingjie-clan-wangyun')
const ZHANGDING = sid('zhangding-clan-wuban')
const LIANZHU = sid('lianzhu-clan-wukuang')
const KAIJI = sid('kaiji-clan-wangchang')

const sk = (key: string, name: string, description: string, locked = false) => ({ id: sid(key), name, description, ...(locked ? { locked: true } : {}) })
const muyin = sk('muyin-clan-wu', '穆荫', '宗族技，回合开始时，你可以令一名手牌上限不为全场最大的同族角色手牌上限+1。')
const xumin = sk('xumin-clan-han', '恤民', '宗族技，限定技，你可以将一张牌当【五谷丰登】对任意名其他角色使用。')
const baizu = sk('baizu-clan-zhong', '保族', '宗族技，限定技，当同族角色进入濒死状态时，你可以令其进入连环状态并回复1点体力。')
const zhongliu = { id: ZHONGLIU, name: '中流', description: '宗族技，锁定技，当你使用牌时，若不为同族角色的手牌，你视为未发动武将牌上的技能。', locked: true }

function askLianzhuSlash(host: SkillHost, ownerId: PlayerId, actorId: PlayerId, step: 'yin-first-use' | 'yin-second-use') {
  const pending = stateOf(host).b67?.lianzhuPending
  if (!pending || !playerOf(host.state, actorId)?.alive || !playerOf(host.state, pending.targetId)?.alive) return false
  const actions = handOf(host.state, actorId).flatMap((cardId) => skillHandCardUseActions(host.state, actorId, cardId))
    .filter((action) => action.asCardName === '杀' && action.targetIds.length === 1 && action.targetIds[0] === pending.targetId)
  host.askSkill({ skillId: LIANZHU, ownerId, step, data: { actorId, targetId: pending.targetId, actions: actions.map((action) => ({ id: action.id, cardId: action.cardIds[0] })) }, build: (requestId): ChooseOptionRequest => ({
    id: requestId, kind: 'choose-option', playerId: actorId, prompt: `【联诛·阴】：是否对${playerOf(host.state, pending.targetId)?.nickname ?? '目标'}使用一张无距离限制的【杀】？`,
    timeoutMs: 25_000, optional: true, options: [...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'pass', label: '不使用' }],
  }) })
  return true
}

export const HISTORICAL_BATCH67_CHARACTERS: readonly CharacterDefinition[] = [
  { id: XUNCAN, name: '族·荀粲', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'xun', skills: [
    { id: 'daojie-clan-xun-b66', name: '蹈节', description: '宗族技，锁定技，当你每回合首次使用非伤害锦囊牌后，你失去1点体力或一个锁定技令一名同族角色获得此牌。', locked: true },
    sk('wushen-clan-xuncan', '熨身', '出牌阶段限一次，你可以令一名其他角色回复1点体力并视为你对其或其对你使用一张冰【杀】。'),
    sk('shangshen-clan-xuncan', '伤神', '当每回合首次有角色受到属性伤害后，你可以进行【闪电】判定并令其将手牌摸至四张。'),
    sk('fenchai-clan-xuncan', '分钗', '锁定技，若首次成为你武将牌上技能目标的异性存活/死亡，你的判定牌视为红桃/黑桃。', true),
  ] },
  { id: WUXIAN, name: '族·吴苋', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', clan: 'chenliu-wu', skills: [
    muyin, sk('yirong-clan-wuxian', '移荣', '出牌阶段限两次，你可以将手牌摸/弃至手牌上限并令你手牌上限-1/+1。'),
    sk('guixiang-clan-wuxian', '贵相', '锁定技，你回合内第X个阶段改为出牌阶段（X为你的手牌上限）。', true),
  ] },
  { id: WUBAN, name: '族·吴班', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', clan: 'chenliu-wu', skills: [
    muyin, sk('zhangding-clan-wuban', '斩钉', '你可以将任意张牌当【杀】使用并令你手牌上限-1：若造成伤害，你将手牌调整至手牌上限；若未造成伤害，此【杀】不计入次数限制。'),
  ] },
  { id: HANSHAO, name: '族·韩韶', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', clan: 'yingchuan-han', skills: [
    xumin, sk('fangzhen-clan-hanshao', '放赈', '出牌阶段开始时，你可以令一名角色进入连环状态并选择一项：1.摸两张牌并交给其两张牌；2.令其回复1点体力。第X轮开始时（X为其座次），你失去本技能。'),
    sk('liuju-clan-hanshao', '留驹', '出牌阶段结束时，你可以拼点，输的角色可以使用拼点牌中的非基本牌。若你与被拼点者的相互距离因此变化，你视为未发动宗族技。'),
  ] },
  { id: HANRONG, name: '族·韩融', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', clan: 'yingchuan-han', skills: [
    xumin, sk('lianhe-clan-hanrong', '连和', '出牌阶段开始时，你可以令两名角色进入连环状态，其下个出牌阶段结束时，若其此阶段未摸牌，其令你摸X+1张牌或交给你X-1张牌（X为其此阶段获得牌数且至多为3）。'),
    sk('huanjia-clan-hanrong', '缓颊', '出牌阶段结束时，你可以拼点，赢的角色可以使用一张拼点牌。若未造成伤害，你获得另一张拼点牌；若造成伤害，你失去一个技能。'),
  ] },
  { id: ZHONGYAN, name: '族·钟琰', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp', clan: 'yingchuan-zhong', skills: [
    baizu, sk('guangu-clan-zhongyan', '观骨', '转换技，出牌阶段限一次，阳：你可以观看牌堆顶至多四张牌；阴：你可以观看一名角色至多四张手牌。然后你可以使用其中一张牌。'),
    sk('xiaoyong-clan-zhongyan', '啸咏', '锁定技，当你回合内首次使用牌名字数为X的牌时（X为上次“观骨”观看牌数），你视为未发动“观骨”。', true),
  ] },
  { id: WUKUANG, name: '族·吴匡', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', clan: 'chenliu-wu', skills: [
    muyin, sk('lianzhu-clan-wukuang', '联诛', '转换技，每名角色出牌阶段限一次，阳：其可以与你各重铸一张牌，若颜色相同，你的手牌上限+1；阴：其可以与你各对由你指定的角色使用一张无距离限制的【杀】，若颜色不同，你的手牌上限-1。'),
  ] },
  { id: WANGYUN, name: '族·王允', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', clan: 'taiyuan-wang', skills: [
    zhongliu, sk('jiexuan-clan-wangyun', '解悬', '转换技，限定技，阳：你可以将一张红色牌当【顺手牵羊】使用；阴：你可以将一张黑色牌当【过河拆桥】使用。'),
    sk('mingjie-clan-wangyun', '铭戒', '限定技，出牌阶段，你可以选择一名角色：直到其下回合结束，你使用牌可以多指定其为目标；其下回合结束时，你可以使用弃牌堆中此回合被使用过的黑桃牌和被抵消过的牌。'),
  ] },
  { id: WANGLING, name: '族·王凌', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', clan: 'taiyuan-wang', skills: [
    zhongliu, sk('bolong-clan-wangling', '驳龙', '出牌阶段限一次，你可以令一名其他角色选择一项：1.你交给其一张牌，视为对其使用一张雷【杀】；2.交给你与你手牌数等量张牌，视为对你使用一张【酒】。'),
  ] },
  { id: WANGCHANG, name: '族·王昶', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'taiyuan-wang', skills: [
    zhongliu, sk('kaiji-clan-wangchang', '开济', '出牌阶段限一次，你可以令一名本轮未以此法指定过的角色弃置你一张手牌，然后你可以使用弃置的牌，若如此做，你摸一张牌。'),
  ] },
]

// 宗族通用：同族全员共享的永久手牌上限成长，并非单局状态临时增减。
registerSkillRuntime({ id: MUYIN,
  maxCardsBonus(state, ownerId) { return (state as Batch67State).b67?.muyinBonus?.[ownerId] ?? 0 },
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const owner = playerOf(host.state, ownerId)
    const clan = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
    if (!owner?.alive || !clan) return
    const living = host.state.players.filter((player) => player.alive)
    const maximum = Math.max(...living.map((player) => maxCardsOf(host.state, player.id)))
    const candidates = living.filter((player) => player.characterId && clanOfCharacter(player.characterId) === clan
      && maxCardsOf(host.state, player.id) < maximum)
    if (!candidates.length) return
    host.askSkill({ skillId: MUYIN, ownerId, step: 'target', build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【穆荫】：选择一名手牌上限未达全场最大值的同族角色',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const clan = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
    if (!owner?.alive || !target?.alive || !clan || !target.characterId || clanOfCharacter(target.characterId) !== clan) return
    const maximum = Math.max(...host.state.players.filter((player) => player.alive).map((player) => maxCardsOf(host.state, player.id)))
    if (maxCardsOf(host.state, targetId!) >= maximum) return
    stateOf(host).b67 ??= {}
    stateOf(host).b67!.muyinBonus ??= {}
    stateOf(host).b67!.muyinBonus![targetId!] = (stateOf(host).b67!.muyinBonus![targetId!] ?? 0) + 1
    host.dispatch('SkillActivated', { skillId: MUYIN, skillName: '穆荫', playerId: ownerId, targetIds: [targetId], logText: `${owner.nickname}发动【穆荫】，令${target.nickname}手牌上限+1` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({ id: ZHONGLIU, triggers: [
  { event: 'CardUsed', priority: 10_000, handle(host, ownerId, context) {
    const event = context.event
    const payload = event.payload as { cardId?: CardId; cardOwnerId?: PlayerId; cardIds?: CardId[] }
    if (event.sourceId !== ownerId || !payload.cardId) return
    const user = playerOf(host.state, ownerId)
    const physicalOwner = payload.cardOwnerId ? playerOf(host.state, payload.cardOwnerId) : undefined
    const userClan = user?.characterId ? clanOfCharacter(user.characterId) : undefined
    const cardClan = physicalOwner?.characterId ? clanOfCharacter(physicalOwner.characterId) : undefined
    const virtualWithoutClanHand = host.state.cards[payload.cardId]?.virtual === true && !payload.cardOwnerId
    if (!userClan || (!virtualWithoutClanHand && (!cardClan || userClan === cardClan))) return
    host.state.clanUseSkillMute = { playerId: ownerId, cardId: payload.cardId }
    // “视为未发动”重置本回合可重复技的引擎记账；限定技的一局标记不清除。
    const player = playerOf(host.state, ownerId)
    if (player) player.turnUsedSkills = []
  } },
  { event: 'AfterCardUse', priority: -10_000, handle(host, ownerId, context) {
    const mute = host.state.clanUseSkillMute
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (mute?.playerId === ownerId && mute.cardId === cardId) delete host.state.clanUseSkillMute
  } },
] })

registerSkillRuntime({ id: XUMIN, limited: true,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play'
      && !owner.usedLimitedSkills.includes(XUMIN)
      ? handOf(state, ownerId).map((cardId) => ({ cardId, asCardName: '五谷丰登', label: '当【五谷丰登】使用' }))
      : []
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== XUMIN
      || (context.event.payload as { cardName?: string }).cardName !== '五谷丰登') return
    const owner = playerOf(host.state, ownerId)
    if (owner && !owner.usedLimitedSkills.includes(XUMIN)) owner.usedLimitedSkills.push(XUMIN)
  } }],
})

registerSkillRuntime({ id: BAIZU, limited: true, triggers: [{ event: 'EnterDying', priority: 100, handle(host, ownerId, context) {
  const targetId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
  const owner = playerOf(host.state, ownerId)
  const target = targetId ? playerOf(host.state, targetId) : undefined
  const clan = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
  if (!owner?.alive || !target?.alive || !targetId || !clan || !target.characterId
    || clanOfCharacter(target.characterId) !== clan || owner.usedLimitedSkills.includes(BAIZU)) return
  host.askSkill({ skillId: BAIZU, ownerId, step: 'invoke', data: { targetId }, build: (requestId): ChooseOptionRequest => ({
    id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【保族】：${target.nickname}正处于濒死，是否令其连环并回复1点体力？`,
    timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '连环并回复1点体力' }, { id: 'no', label: '不发动' }],
  }) })
} }], resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
  const targetId = resolution.data.targetId as PlayerId
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  const clan = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
  if (!owner?.alive || !target?.alive || !clan || !target.characterId
    || clanOfCharacter(target.characterId) !== clan || owner.usedLimitedSkills.includes(BAIZU)) return
  owner.usedLimitedSkills.push(BAIZU)
  setChained(host as never, targetId, '【保族】', true)
  recover(host, targetId, 1, ownerId, BAIZU)
} })

const WUSHEN = sid('wushen-clan-xuncan')
const SHANGSHEN = sid('shangshen-clan-xuncan')
const FENCHAI = sid('fenchai-clan-xuncan')
const SHANGSHEN_JUDGE = `${SHANGSHEN}:lightning`
registerJudgmentContinuation(SHANGSHEN_JUDGE, (host, result, data) => {
  const sourceId = data.sourceId as PlayerId
  const targetId = data.targetId as PlayerId
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  if (result.suit === 'spade' && result.rank >= 2 && result.rank <= 9)
    resolveDamage(host, { sourceId, targetId, amount: 3, nature: 'thunder', cardName: '闪电' })
  const missing = Math.max(0, 4 - handOf(host.state, targetId).length)
  if (missing) drawCards(host.state, host.rng, targetId, missing, (name, payload) => host.dispatch(name, payload))
})

registerSkillRuntime({ id: WUSHEN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play'
      && !usedThisPhase(state, ownerId, WUSHEN)
      && state.players.some((player) => player.alive && player.id !== ownerId && player.hp < player.maxHp)
      ? [{ id: `skill:${WUSHEN}`, label: '发动【熨身】：令角色回复并使用冰【杀】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${WUSHEN}`) return
    markUsedThisPhase(host.state, ownerId, WUSHEN)
    host.askSkill({ skillId: WUSHEN, ownerId, step: 'target', build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【熨身】：选择一名已受伤的其他角色',
      timeoutMs: 25_000, optional: false, candidateIds: host.state.players.filter((player) => player.alive && player.id !== ownerId && player.hp < player.maxHp).map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'give') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => handOf(host.state, ownerId).includes(cardId)).slice(0, 2)
      if (selected.length === 2) giveCards(host as never, ownerId, targetId, selected, FANGZHEN)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.id === ownerId || target.hp >= target.maxHp) return
      host.askSkill({ skillId: WUSHEN, ownerId, step: 'direction', data: { targetId }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【熨身】：令${target.nickname}回复1点体力，并选择冰【杀】方向`,
        timeoutMs: 25_000, optional: false, options: [
          { id: 'out', label: `你对${target.nickname}使用冰【杀】` }, { id: 'in', label: `${target.nickname}对你使用冰【杀】` },
        ],
      }) })
      return
    }
    if (resolution.step !== 'direction') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!target?.alive || target.hp >= target.maxHp) return
    recover(host, targetId, 1, ownerId, WUSHEN)
    const direction = (response.payload as { optionId?: string }).optionId
    if (direction === 'out' && target.alive) host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: WUSHEN, nature: 'ice' })
    else if (direction === 'in' && playerOf(host.state, ownerId)?.alive) host.beginVirtualSlash({ sourceId: targetId, targetId: ownerId, sourceSkillId: WUSHEN, nature: 'ice' })
  },
})

registerSkillRuntime({ id: SHANGSHEN, triggers: [{ event: 'Damaged', handle(host, _ownerId, context) {
  if (!context.event.damageNature || context.event.damageNature === 'normal' || !context.event.targetId) return
  const state = stateOf(host)
  state.b67 ??= {}
  state.b67.xuncanShangshenTurn ??= {}
  if (state.b67.xuncanShangshenTurn[_ownerId] === host.state.turnNumber) return
  const owner = playerOf(host.state, _ownerId)
  if (owner?.alive && owner.characterId === XUNCAN) {
    state.b67.xuncanShangshenTurn[_ownerId] = host.state.turnNumber
    host.queueSkill({ skillId: SHANGSHEN, ownerId: _ownerId, step: 'invoke', data: { targetId: context.event.targetId } })
  }
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'invoke' || !playerOf(host.state, ownerId)?.alive) return
  host.askSkill({ skillId: SHANGSHEN, ownerId, step: 'invoke', data: prompt.data, build: (requestId): ChooseOptionRequest => ({
    id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【伤神】：是否进行一次【闪电】判定？',
    timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '进行判定' }, { id: 'no', label: '不发动' }],
  }) })
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
  const targetId = resolution.data.targetId as PlayerId
  if (!playerOf(host.state, targetId)?.alive) return
  performJudgment(host as never, ownerId, '闪电', { tag: SHANGSHEN_JUDGE, data: { sourceId: ownerId, targetId } })
} })

registerSkillRuntime({ id: FENCHAI,
  triggers: [{ event: 'SkillActivated', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    if (stateOf(host).b67?.xuncanFirstTarget?.[ownerId]) return
    const ownerGender = effectiveGenderOf(host.state, ownerId)
    const targets = (context.event.payload as { targetIds?: PlayerId[]; targetId?: PlayerId }).targetIds
      ?? ((context.event.payload as { targetId?: PlayerId }).targetId ? [(context.event.payload as { targetId: PlayerId }).targetId] : [])
    const target = targets.find((targetId) => {
      const targetGender = effectiveGenderOf(host.state, targetId)
      return targetId !== ownerId && !!ownerGender && !!targetGender && targetGender !== ownerGender
    })
    if (!target) return
    stateOf(host).b67 ??= {}
    stateOf(host).b67!.xuncanFirstTarget ??= {}
    stateOf(host).b67!.xuncanFirstTarget![ownerId] = target
  } }],
  overrideJudgmentSuit(state, ownerId, judgedPlayerId, _suit) {
    if (judgedPlayerId !== ownerId) return null
    const first = (state as Batch67State).b67?.xuncanFirstTarget?.[ownerId]
    if (!first) return null
    const target = playerOf(state, first)
    if (!target) return null
    if (target.alive) return 'heart'
    return 'spade'
  },
})

const YIRONG = sid('yirong-clan-wuxian')
const GUIXIANG = sid('guixiang-clan-wuxian')
const BOLONG = sid('bolong-clan-wangling')
const FANGZHEN = sid('fangzhen-clan-hanshao')
const LIANHE = sid('lianhe-clan-hanrong')
const LIUJU = sid('liuju-clan-hanshao')
const LIUJU_TAG = `${LIUJU}:pindian`
const HUANJIA = sid('huanjia-clan-hanrong')
const HUANJIA_TAG = `${HUANJIA}:pindian`
const GUANGU = sid('guangu-clan-zhongyan')
const XIAOYONG = sid('xiaoyong-clan-zhongyan')
function wuxianPhaseKey(state: SanguoshaState): string {
  return `${state.turnNumber}:${phaseSlotOf(state)}:${state.extraPhase?.instanceId ?? ''}`
}
registerSkillRuntime({ id: YIRONG,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const key = wuxianPhaseKey(state)
    const record = (state as Batch67State).b67?.wuxianYirongUses?.[ownerId]
    const limit = maxCardsOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || (record?.phaseKey === key && record.count >= 2) || owner.zones.hand.length === limit) return []
    return [{ id: `skill:${YIRONG}`, label: owner.zones.hand.length < limit
      ? '发动【移荣】：摸牌至手牌上限，手牌上限-1'
      : '发动【移荣】：弃牌至手牌上限，手牌上限+1' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${YIRONG}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const limit = maxCardsOf(host.state, ownerId)
    if (owner.zones.hand.length < limit) {
      drawCards(host.state, host.rng, ownerId, limit - owner.zones.hand.length, (name, payload) => host.dispatch(name, payload))
      host.state.maxCardsAdjustments ??= {}
      host.state.maxCardsAdjustments[ownerId] = (host.state.maxCardsAdjustments[ownerId] ?? 0) - 1
      recordYirongUse(host.state, ownerId)
      return
    }
    const count = owner.zones.hand.length - limit
    host.askSkill({ skillId: YIRONG, ownerId, step: 'discard', data: { count }, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【移荣】：弃置${count}张手牌`, timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: count, max: count,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const requested = Number(resolution.data.count)
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => handOf(host.state, ownerId).includes(cardId)).slice(0, requested)
    if (!owner?.alive || selected.length !== requested) return
    const discarded = discardCardsByIds(host as never, ownerId, selected, YIRONG)
    if (discarded.length !== requested) return
    host.state.maxCardsAdjustments ??= {}
    host.state.maxCardsAdjustments[ownerId] = (host.state.maxCardsAdjustments[ownerId] ?? 0) + 1
    recordYirongUse(host.state, ownerId)
  },
})

function recordYirongUse(state: SanguoshaState, ownerId: PlayerId): void {
  const data = state as Batch67State
  data.b67 ??= {}
  data.b67.wuxianYirongUses ??= {}
  const key = wuxianPhaseKey(state)
  const record = data.b67.wuxianYirongUses[ownerId]
  data.b67.wuxianYirongUses[ownerId] = { phaseKey: key, count: (record?.phaseKey === key ? record.count : 0) + 1 }
}

registerSkillRuntime({ id: GUIXIANG, replacesPhase(state, ownerId, slot) {
  if (ownerId !== state.currentPlayerId || !playerOf(state, ownerId)?.alive) return null
  const order: TurnPhase[] = state.turnPhaseOrder ?? ['prepare', 'judge', 'draw', 'play', 'discard', 'finish']
  const index = order.indexOf(slot)
  if (index < 0 || index + 1 !== maxCardsOf(state, ownerId) || slot === 'play') return null
  return 'play'
} })

registerSkillRuntime({ id: JIEXUAN, limited: true,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || owner.usedLimitedSkills.includes(JIEXUAN)) return []
    const yang = engineConversionStateOf(state, ownerId, JIEXUAN) === 'yang'
    return handOf(state, ownerId).flatMap((cardId) => {
      const color = effectiveCardColor(state, ownerId, cardId, skillIdsOf)
      if (yang && color === 'red') return [{ cardId, asCardName: '顺手牵羊', label: '【解悬·阳】：红色牌当【顺手牵羊】使用' }]
      if (!yang && color === 'black') return [{ cardId, asCardName: '过河拆桥', label: '【解悬·阴】：黑色牌当【过河拆桥】使用' }]
      return []
    })
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== JIEXUAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner || owner.usedLimitedSkills.includes(JIEXUAN)) return
    owner.usedLimitedSkills.push(JIEXUAN)
    const next = engineToggleConversionState(host.state, ownerId, JIEXUAN)
    host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: JIEXUAN, state: next }, { sourceId: ownerId, sourceSkillId: JIEXUAN })
  } }],
})

function guanguUseActions(host: SkillHost, ownerId: PlayerId, source: 'top' | 'hand', physicalOwnerId: PlayerId | null, cardIds: CardId[]) {
  const result: Array<{ id: string; label: string; cardId: CardId; source: 'top' | 'hand'; physicalOwnerId: PlayerId | null }> = []
  for (const cardId of cardIds) {
    let actions: Array<{ id: string; label: string }> = []
    if (source === 'top') {
      const index = host.state.zones.drawPile.indexOf(cardId)
      if (index < 0) continue
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
      actions = pindianCardUseActions(host, ownerId, cardId)
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toIndex: index })
    } else if (physicalOwnerId) {
      actions = skillOtherHandCardUseActions(host.state, ownerId, physicalOwnerId, cardId)
    }
    for (const action of actions) result.push({
      id: action.id, label: `使用【${host.state.cards[cardId]?.name ?? '牌'}】：${action.label}`,
      cardId, source, physicalOwnerId,
    })
  }
  return result
}

function askGuanguView(host: SkillHost, ownerId: PlayerId, cardIds: CardId[], source: 'top' | 'hand', physicalOwnerId: PlayerId | null): void {
  stateOf(host).b67 ??= {}
  stateOf(host).b67!.guanguCount ??= {}
  stateOf(host).b67!.guanguCount![ownerId] = cardIds.length
  host.askSkill({ skillId: GUANGU, ownerId, step: 'viewed', data: { cardIds, source, physicalOwnerId }, build: (requestId): ChooseCardsRequest => ({
    id: requestId, kind: 'choose-cards', playerId: ownerId,
    prompt: '【观骨】：查看这些牌；随后可使用其中一张', timeoutMs: 25_000,
    optional: true, purpose: 'skill', cardIds: [], viewOnlyCardIds: cardIds, hiddenCardSlots: [], min: 0, max: 0,
  }) })
}

registerSkillRuntime({ id: GUANGU,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, GUANGU)) return []
    const yang = engineConversionStateOf(state, ownerId, GUANGU) === 'yang'
    const canUseMode = yang ? state.zones.drawPile.length > 0
      : state.players.some((player) => player.alive && player.zones.hand.length > 0)
    return canUseMode ? [{ id: `skill:${GUANGU}`, label: yang
      ? '发动【观骨·阳】：观看牌堆顶至多四张牌并可使用其中一张'
      : '发动【观骨·阴】：观看一名角色至多四张手牌并可使用其中一张' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${GUANGU}`) return
    markUsedThisPhase(host.state, ownerId, GUANGU)
    const next = engineToggleConversionState(host.state, ownerId, GUANGU)
    host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: GUANGU, state: next }, { sourceId: ownerId, sourceSkillId: GUANGU })
    const yang = next === 'yin'
    if (!yang) {
      const top = host.state.zones.drawPile.slice(0, 4)
      askGuanguView(host, ownerId, top, 'top', null)
      return
    }
    host.askSkill({ skillId: GUANGU, ownerId, step: 'target', build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【观骨·阴】：选择一名有手牌的角色',
      timeoutMs: 25_000, optional: false, candidateIds: host.state.players.filter((player) => player.alive && player.zones.hand.length).map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || !target.zones.hand.length) return
      const maximum = Math.min(4, target.zones.hand.length)
      host.askSkill({ skillId: GUANGU, ownerId, step: 'select-hidden', data: { targetId }, build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【观骨·阴】：选择观看${target.nickname}的至多${maximum}张手牌`,
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: [],
        hiddenCardSlots: target.zones.hand.map((_, index) => `hidden:${targetId}:${index}`), min: 0, max: maximum,
      }) })
      return
    }
    if (resolution.step === 'select-hidden') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => target?.zones.hand.includes(cardId)).slice(0, 4)
      askGuanguView(host, ownerId, selected, 'hand', targetId)
      return
    }
    if (resolution.step === 'viewed') {
      const source = resolution.data.source as 'top' | 'hand'
      const physicalOwnerId = resolution.data.physicalOwnerId as PlayerId | null
      const cardIds = (resolution.data.cardIds as CardId[]).filter((cardId) => source === 'top'
        ? host.state.zones.drawPile.includes(cardId)
        : !!physicalOwnerId && handOf(host.state, physicalOwnerId).includes(cardId))
      const choices = guanguUseActions(host, ownerId, source, physicalOwnerId, cardIds)
      host.askSkill({ skillId: GUANGU, ownerId, step: 'use-choice', data: { choices }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【观骨】：选择一张可用的牌或放弃',
        timeoutMs: 25_000, optional: true,
        options: [...choices.map(({ id, label }) => ({ id, label })), { id: 'pass', label: '不使用' }],
      }) })
      return
    }
    if (resolution.step !== 'use-choice') return
    const actionId = (response.payload as { optionId?: string }).optionId
    if (!actionId || actionId === 'pass') return
    const choice = (resolution.data.choices as Array<{ id: string; cardId: CardId; source: 'top' | 'hand'; physicalOwnerId: PlayerId | null }>).find((item) => item.id === actionId)
    if (!choice) return
    if (choice.source === 'top') {
      if (!host.state.zones.drawPile.includes(choice.cardId)) return
      moveCard(host.state, choice.cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
      if (!host.beginSkillCardUseFromProcessing(ownerId, choice.cardId, GUANGU, actionId)
        && host.state.zones.processingArea.includes(choice.cardId)) moveCard(host.state, choice.cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
      return
    }
    if (choice.physicalOwnerId)
      host.beginSkillCardUseFromOtherHand(ownerId, choice.physicalOwnerId, choice.cardId, GUANGU, actionId)
  },
})

registerSkillRuntime({ id: XIAOYONG, triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
  if (context.event.sourceId !== ownerId) return
  const cardName = (context.event.payload as { cardName?: string }).cardName
  const watched = stateOf(host).b67?.guanguCount?.[ownerId] ?? 0
  if (!cardName || !watched || [...cardName].length !== watched) return
  stateOf(host).b67 ??= {}
  stateOf(host).b67!.xiaoyongTurn ??= {}
  if (stateOf(host).b67!.xiaoyongTurn![ownerId] === host.state.turnNumber) return
  stateOf(host).b67!.xiaoyongTurn![ownerId] = host.state.turnNumber
  clearUsedThisPhase(host.state, ownerId, GUANGU)
} }] })

function ownedHandAndEquipment(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  return [...player.zones.hand, ...Object.values(player.zones.equipment).filter((id): id is CardId => !!id)]
}

registerSkillRuntime({ id: BOLONG,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || usedThisPhase(state, ownerId, BOLONG)
      || !state.players.some((player) => player.alive && player.id !== ownerId)) return []
    return [{ id: `skill:${BOLONG}`, label: '发动【驳龙】：令一名角色选择交牌并受雷杀，或交牌并对你使用酒' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${BOLONG}`) return
    markUsedThisPhase(host.state, ownerId, BOLONG)
    host.askSkill({ skillId: BOLONG, ownerId, step: 'target', build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【驳龙】：选择一名其他角色',
      timeoutMs: 25_000, optional: false, candidateIds: host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.id === ownerId) return
      const selectedTargetId = target.id
      const cardsAvailable = ownedHandAndEquipment(host.state, selectedTargetId).length >= owner.zones.hand.length
        && owner.zones.hand.length > 0 && !isCardUseProhibited(host.state, selectedTargetId, '酒', { dyingPlayerId: host.state.dying?.playerId ?? null })
      const options = [{ id: 'slash', label: '你交给其一张牌，视为对其使用雷【杀】' },
        ...(cardsAvailable ? [{ id: 'wine', label: `其交给你${owner.zones.hand.length}张牌，视为对你使用【酒】` }] : [])]
      host.askSkill({ skillId: BOLONG, ownerId, step: 'mode', data: { targetId: selectedTargetId }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: selectedTargetId, prompt: `【驳龙】：${owner.nickname}令你选择一项`,
        timeoutMs: 25_000, optional: false, options,
      }) })
      return
    }
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode === 'slash') {
        const cards = ownedHandAndEquipment(host.state, ownerId)
        if (!cards.length) return
        host.askSkill({ skillId: BOLONG, ownerId, step: 'give-slash', data: { targetId }, build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【驳龙】：选择交给目标角色的一张手牌或装备牌',
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      } else if (mode === 'wine') {
        const count = owner.zones.hand.length
        const cards = ownedHandAndEquipment(host.state, targetId)
        if (!count || cards.length < count || isCardUseProhibited(host.state, targetId, '酒', { dyingPlayerId: host.state.dying?.playerId ?? null })) return
        host.askSkill({ skillId: BOLONG, ownerId, step: 'give-wine', data: { targetId, count }, build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId, prompt: `【驳龙】：选择交给${owner.nickname}的${count}张手牌或装备牌`,
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: count, max: count,
        }) })
      }
      return
    }
    if (resolution.step === 'give-slash') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const sourceZone = cardId ? locateOwnedCard(host.state, ownerId, cardId) : null
      if (!cardId || !sourceZone || (sourceZone.kind !== 'hand' && sourceZone.kind !== 'equipment')) return
      if (giveOwnedCards(host as never, ownerId, targetId, [cardId], BOLONG).length !== 1) return
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: BOLONG, nature: 'thunder', ignoreDistance: true })
      return
    }
    if (resolution.step === 'give-wine') {
      const count = Number(resolution.data.count)
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].slice(0, count)
      if (cardIds.length !== count || cardIds.some((id) => !ownedHandAndEquipment(host.state, targetId).includes(id))) return
      if (giveOwnedCards(host as never, targetId, ownerId, cardIds, BOLONG).length !== count) return
      if (useVirtualWine(host, targetId, BOLONG, ownerId)) applyWineEffect(host)
    }
  },
})

registerSkillRuntime({ id: FANGZHEN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const owner = playerOf(host.state, ownerId)
      if (payload.playerId !== ownerId || payload.phase !== 'play' || !owner?.alive) return
      host.queueSkill({ skillId: FANGZHEN, ownerId, step: 'target', data: {} })
    } },
    { event: 'RoundStart', handle(host, ownerId, context) {
      const round = Number((context.event.payload as { roundNumber?: number }).roundNumber)
      if (!round || !stateOf(host).b67?.fangzhenExpires?.[ownerId]?.includes(round)) return
      delete stateOf(host).b67!.fangzhenExpires![ownerId]
      suppressSkill(host.state, { targetId: ownerId, skillId: FANGZHEN, sourceId: ownerId,
        sourceSkillId: FANGZHEN, expiresAt: 'never', armedAtTurn: host.state.turnNumber })
      host.dispatch('SkillActivated', { skillId: FANGZHEN, playerId: ownerId, result: 'lost', logText: `${playerOf(host.state, ownerId)?.nickname ?? '韩韶'}失去【放赈】` }, { sourceId: ownerId })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target' || !playerOf(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: FANGZHEN, ownerId, step: 'target', build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【放赈】：横置一名角色并选择赈济方式',
      timeoutMs: 25_000, optional: true, candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !target?.alive || !targetId) return
      setChained(host as never, targetId, FANGZHEN, true)
      stateOf(host).b67 ??= {}
      stateOf(host).b67!.fangzhenExpires ??= {}
      const expiryRounds = stateOf(host).b67!.fangzhenExpires![ownerId] ??= []
      if (!expiryRounds.includes(target.seat + 1)) expiryRounds.push(target.seat + 1)
      const options = [{ id: 'draw-give', label: '你摸两张牌，然后交给其两张牌' },
        ...(target.hp < target.maxHp ? [{ id: 'recover', label: `令${target.nickname}回复1点体力` }] : [])]
      host.askSkill({ skillId: FANGZHEN, ownerId, step: 'effect', data: { targetId }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【放赈】：选择对${target.nickname}的效果`,
        timeoutMs: 25_000, optional: false, options,
      }) })
      return
    }
    if (resolution.step !== 'effect') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!playerOf(host.state, ownerId)?.alive || !target?.alive) return
    const mode = (response.payload as { optionId?: string }).optionId
    if (mode === 'recover') {
      if (target.hp < target.maxHp) recover(host, targetId, 1, ownerId, FANGZHEN)
      return
    }
    if (mode !== 'draw-give') return
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return
    host.askSkill({ skillId: FANGZHEN, ownerId, step: 'give', data: { targetId }, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【放赈】：选择交给${target?.nickname ?? '目标角色'}的两张手牌`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
    }) })
  },
})

registerSkillRuntime({ id: LIANHE,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const targetId = payload.playerId
      if (!targetId || payload.phase !== 'play') return
      const pending = stateOf(host).b67?.lianhePending?.[targetId]
      const waiting = pending?.filter((record) => !record.phaseKey) ?? []
      for (const record of waiting) record.phaseKey = `${host.state.turnNumber}:${phaseSlotOf(host.state)}:${host.state.extraPhase?.instanceId ?? ''}`
      const owner = playerOf(host.state, ownerId)
      if (targetId !== ownerId || !owner?.alive) return
      host.queueSkill({ skillId: LIANHE, ownerId, step: 'targets', data: {} })
    } },
    { event: 'DrawAttempt', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; count?: number; isDraw?: boolean }
      if (!payload.playerId || !payload.isDraw || Number(payload.count) <= 0 || context.event.name !== 'DrawAttempt'
        || host.state.phase !== 'play' || !host.state.currentPlayerId) return
      const record = stateOf(host).b67?.lianhePending?.[payload.playerId]
        ?.find((entry) => entry.phaseKey === `${host.state.turnNumber}:${phaseSlotOf(host.state)}:${host.state.extraPhase?.instanceId ?? ''}`)
      if (record) record.drew = true
      void ownerId
    } },
    { event: 'GainCard', handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; isDraw?: boolean }
      if (!payload.playerId || host.state.phase !== 'play' || !host.state.currentPlayerId) return
      const record = stateOf(host).b67?.lianhePending?.[payload.playerId]
        ?.find((entry) => entry.phaseKey === `${host.state.turnNumber}:${phaseSlotOf(host.state)}:${host.state.extraPhase?.instanceId ?? ''}`)
      if (!record) return
      record.gained += payload.cardIds?.length ?? 0
      if (payload.isDraw) record.drew = true
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const targetId = payload.playerId
      if (!targetId || payload.phase !== 'play') return
      const list = stateOf(host).b67?.lianhePending?.[targetId]
      const key = `${host.state.turnNumber}:${phaseSlotOf(host.state)}:${host.state.extraPhase?.instanceId ?? ''}`
      const records = list?.filter((record) => record.phaseKey === key) ?? []
      if (!records.length || !list) return
      stateOf(host).b67!.lianhePending![targetId] = list.filter((record) => record.phaseKey !== key)
      if (!stateOf(host).b67!.lianhePending![targetId]!.length) delete stateOf(host).b67!.lianhePending![targetId]
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      for (const record of records) if (!record.drew) {
        const x = Math.min(3, record.gained)
        host.queueSkill({ skillId: LIANHE, ownerId, step: 'reward', data: { targetId, gained: record.gained, drawCount: x + 1, giveCount: x - 1 } })
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (!playerOf(host.state, ownerId)?.alive) return
    if (prompt.step === 'reward') {
      const targetId = prompt.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      if (!target?.alive || !owner?.alive) return
      const drawCount = Number(prompt.data.drawCount)
      const giveCount = Number(prompt.data.giveCount)
      const options = [{ id: 'draw', label: `令${owner.nickname}摸${drawCount}张牌` },
        ...(giveCount > 0 && target.zones.hand.length >= giveCount ? [{ id: 'give', label: `交给${owner.nickname}${giveCount}张手牌` }] : [])]
      host.askSkill({ skillId: LIANHE, ownerId, step: 'reward', data: prompt.data, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: targetId, prompt: `【连和】：你本阶段获得${Number(prompt.data.gained)}张牌且未摸牌，选择一项`,
        timeoutMs: 25_000, optional: false, options,
      }) })
      return
    }
    if (prompt.step !== 'targets') return
    const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
    if (candidates.length < 2) return
    host.askSkill({ skillId: LIANHE, ownerId, step: 'targets', build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【连和】：选择两名角色横置',
      timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 2, max: 2,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'give-reward') {
      const targetId = resolution.data.targetId as PlayerId
      const count = Number(resolution.data.count)
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => handOf(host.state, targetId).includes(cardId)).slice(0, count)
      if (selected.length === count) giveCards(host as never, targetId, ownerId, selected, LIANHE)
      return
    }
    if (resolution.step === 'targets') {
      const targets = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
        .filter((id) => playerOf(host.state, id)?.alive).slice(0, 2)
      if (targets.length !== 2) return
      for (const targetId of targets) {
        setChained(host as never, targetId, LIANHE, true)
        stateOf(host).b67 ??= {}
        stateOf(host).b67!.lianhePending ??= {}
        stateOf(host).b67!.lianhePending![targetId] ??= []
        stateOf(host).b67!.lianhePending![targetId]!.push({
          createdAt: `${host.state.turnNumber}:${phaseSlotOf(host.state)}:${host.state.extraPhase?.instanceId ?? ''}`,
          drew: false, gained: 0,
        })
      }
      return
    }
    const targetId = resolution.data.targetId as PlayerId
    if (resolution.step === 'reward' && (response.payload as { optionId?: string }).optionId === 'draw') {
      const count = Number(resolution.data.drawCount)
      if (Number.isInteger(count) && count > 0 && playerOf(host.state, ownerId)?.alive)
        drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
      return
    }
    if (resolution.step !== 'reward' || (response.payload as { optionId?: string }).optionId !== 'give') return
    const target = playerOf(host.state, targetId)
    const count = Number(resolution.data.giveCount)
    if (!target?.alive || !Number.isInteger(count) || count <= 0 || target.zones.hand.length < count) return
    host.askSkill({ skillId: LIANHE, ownerId, step: 'give-reward', data: { targetId, count }, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: targetId, prompt: `【连和】：选择交给${playerOf(host.state, ownerId)?.nickname ?? '韩融'}的${count}张手牌`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: count, max: count,
    }) })
  },
})

registerPindianContinuation(LIUJU_TAG, (rawHost, result) => {
  if (result.outcome === 'tie') return
  const loserId = result.outcome === 'initiator-win' ? result.opponentId : result.initiatorId
  const cardId = loserId === result.initiatorId ? result.initiatorCardId : result.opponentCardId
  const skillHost = rawHost as unknown as SkillHost
  const owner = playerOf(skillHost.state, result.initiatorId)
  const loser = playerOf(skillHost.state, loserId)
  if (!owner?.alive || !loser?.alive || skillHost.state.cards[cardId]?.category === 'basic') return
  moveCard(skillHost.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: loserId })
  const actions = skillHandCardUseActions(skillHost.state, loserId, cardId)
  moveCard(skillHost.state, cardId, { kind: 'hand', playerId: loserId }, { kind: 'processingArea' })
  if (!actions.length) return
  stateOf(skillHost).b67 ??= {}
  stateOf(skillHost).b67!.liujuUse = {
    ownerId: result.initiatorId, loserId, cardId, targetId: result.opponentId,
    beforeOut: getDistance(skillHost.state, result.initiatorId, result.opponentId),
    beforeBack: getDistance(skillHost.state, result.opponentId, result.initiatorId),
  }
  skillHost.askSkill({ skillId: LIUJU, ownerId: result.initiatorId, step: 'use-pindian-card', data: { loserId, cardId, actionIds: actions.map((action) => action.id) }, build: (requestId): ChooseOptionRequest => ({
    id: requestId, kind: 'choose-option', playerId: loserId, prompt: '【留驹】：你输掉拼点，可以使用拼点牌中的非基本牌',
    timeoutMs: 25_000, optional: true,
    options: [...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'pass', label: '不使用' }],
  }) })
  return 'defer-settlement'
})

registerSkillRuntime({ id: LIUJU,
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (payload.playerId !== ownerId || payload.phase !== 'play' || !canPindian(host.state, ownerId)) return
      host.queueSkill({ skillId: LIUJU, ownerId, step: 'target', data: {} })
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const use = stateOf(host).b67?.liujuUse
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!use || use.cardId !== cardId) return
      delete stateOf(host).b67!.liujuUse
      if (getDistance(host.state, use.ownerId, use.targetId) === use.beforeOut
        && getDistance(host.state, use.targetId, use.ownerId) === use.beforeBack) return
      const owner = playerOf(host.state, use.ownerId)
      if (owner) owner.usedLimitedSkills = owner.usedLimitedSkills.filter((id) => id !== XUMIN)
      host.dispatch('SkillActivated', { skillId: LIUJU, playerId: use.ownerId, targetIds: [use.targetId], result: 'restore-xumin', logText: '【留驹】：相互距离改变，重置【恤民】限定技' }, { sourceId: use.ownerId, targetId: use.targetId })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target' || !canPindian(host.state, ownerId)) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && canPindian(host.state, player.id))
    if (!candidates.length) return
    host.askSkill({ skillId: LIUJU, ownerId, step: 'target', build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【留驹】：选择一名有手牌的角色拼点',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'use-pindian-card') {
      const chosen = (response.payload as { optionId?: string }).optionId
      const cardId = resolution.data.cardId as CardId
      if (!chosen || chosen === 'pass') { finishPindianSettlement(host as never); delete stateOf(host).b67?.liujuUse; return }
      const settlement = host.state.pindianSettlement
      if (settlement) settlement.cardIds = settlement.cardIds.filter((id) => id !== cardId)
      finishPindianSettlement(host as never)
      if (!host.beginSkillCardUseFromProcessing(resolution.data.loserId as PlayerId, cardId, LIUJU, chosen)) {
        delete stateOf(host).b67?.liujuUse
        if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      }
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive || !canPindian(host.state, ownerId) || !canPindian(host.state, targetId)) return
    startPindian(host as never, { id: `b67-liuju-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
      reason: LIUJU, continuationTag: LIUJU_TAG, data: { targetId } })
  },
})

function pindianCardUseActions(host: SkillHost, playerId: PlayerId, cardId: CardId) {
  if (!host.state.zones.processingArea.includes(cardId) || !playerOf(host.state, playerId)?.alive) return []
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId })
  const actions = skillHandCardUseActions(host.state, playerId, cardId)
  moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'processingArea' })
  return actions
}

function discardPileCardUseActions(host: SkillHost, playerId: PlayerId, cardId: CardId) {
  if (!host.state.zones.discardPile.includes(cardId)) return []
  moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'processingArea' })
  const actions = pindianCardUseActions(host, playerId, cardId)
  if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  return actions
}

registerPindianContinuation(HUANJIA_TAG, (rawHost, result) => {
  if (result.outcome === 'tie') return
  const skillHost = rawHost as unknown as SkillHost
  const winnerId = result.outcome === 'initiator-win' ? result.initiatorId : result.opponentId
  const owner = playerOf(skillHost.state, result.initiatorId)
  if (!owner?.alive) return
  const cardIds = [result.initiatorCardId, result.opponentCardId]
  const available = cardIds.map((cardId) => ({ cardId, actions: pindianCardUseActions(skillHost, winnerId, cardId) }))
    .filter((entry) => entry.actions.length > 0)
  if (!available.length) return
  skillHost.askSkill({ skillId: HUANJIA, ownerId: result.initiatorId, step: 'choose-pindian-card',
    data: { winnerId, available: available.map(({ cardId, actions }) => ({ cardId, actions: actions.map(({ id, label }) => ({ id, label })) })) },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: winnerId, prompt: '【缓颊】：选择使用一张拼点牌',
      timeoutMs: 25_000, optional: true,
      options: [...available.map(({ cardId }) => ({ id: cardId, label: `使用拼点牌【${skillHost.state.cards[cardId]?.name ?? '牌'}】` })), { id: 'pass', label: '不使用' }],
    }) })
  return 'defer-settlement'
})

registerSkillRuntime({ id: HUANJIA,
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (payload.playerId !== ownerId || payload.phase !== 'play' || !canPindian(host.state, ownerId)) return
      host.queueSkill({ skillId: HUANJIA, ownerId, step: 'target', data: {} })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const use = stateOf(host).b67?.huanjiaUse
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!use || use.ownerId !== ownerId || use.usedCardId !== cardId) return
      delete stateOf(host).b67!.huanjiaUse
      if (cardDamageDealt(host.state, cardId!) <= 0) {
        claimPindianCards(host as never, ownerId, [use.unusedCardId])
        return
      }
      finishPindianSettlement(host as never)
      host.queueSkill({ skillId: HUANJIA, ownerId, step: 'lose-skill', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (!playerOf(host.state, ownerId)?.alive) return
    if (prompt.step === 'target') {
      if (!canPindian(host.state, ownerId)) return
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && canPindian(host.state, player.id))
      if (!candidates.length) return
      host.askSkill({ skillId: HUANJIA, ownerId, step: 'target', build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【缓颊】：选择一名有手牌的角色拼点',
        timeoutMs: 25_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'lose-skill') {
      const character = playerOf(host.state, ownerId)?.characterId ? getCharacter(playerOf(host.state, ownerId)!.characterId!) : undefined
      const options = character?.skills.filter((skill) => !skill.granted && !isSkillSuppressed(host.state, ownerId, skill.id))
        .map((skill) => ({ id: skill.id, label: `失去【${skill.name}】` })) ?? []
      if (!options.length) return
      host.askSkill({ skillId: HUANJIA, ownerId, step: 'lose-skill', build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【缓颊】：选择失去一个武将技能',
        timeoutMs: 25_000, optional: false, options,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !canPindian(host.state, ownerId) || !canPindian(host.state, targetId)) return
      startPindian(host as never, { id: `b67-huanjia-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
        reason: HUANJIA, continuationTag: HUANJIA_TAG, data: {} })
      return
    }
    if (resolution.step === 'choose-pindian-card') {
      const cardId = (response.payload as { optionId?: string }).optionId as CardId | undefined
      if (!cardId || cardId === 'pass') { finishPindianSettlement(host as never); return }
      const entry = (resolution.data.available as Array<{ cardId: CardId; actions: Array<{ id: string; label: string }> }>).find((item) => item.cardId === cardId)
      if (!entry || !host.state.zones.processingArea.includes(cardId)) { finishPindianSettlement(host as never); return }
      host.askSkill({ skillId: HUANJIA, ownerId, step: 'use-pindian-card', data: { winnerId: resolution.data.winnerId, cardId, actions: entry.actions }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: resolution.data.winnerId as PlayerId,
        prompt: `【缓颊】：选择如何使用拼点牌【${host.state.cards[cardId]?.name ?? '牌'}】`,
        timeoutMs: 25_000, optional: true,
        options: [...entry.actions.map(({ id, label }) => ({ id, label })), { id: 'pass', label: '不使用' }],
      }) })
      return
    }
    if (resolution.step === 'use-pindian-card') {
      const chosen = (response.payload as { optionId?: string }).optionId
      const cardId = resolution.data.cardId as CardId
      if (!chosen || chosen === 'pass') { finishPindianSettlement(host as never); return }
      const settlement = host.state.pindianSettlement
      const unusedCardId = settlement?.cardIds.find((id) => id !== cardId)
      if (settlement) settlement.cardIds = settlement.cardIds.filter((id) => id !== cardId)
      if (!unusedCardId) finishPindianSettlement(host as never)
      else stateOf(host).b67!.huanjiaUse = { ownerId, cardId: unusedCardId, usedCardId: cardId, unusedCardId }
      if (!host.beginSkillCardUseFromProcessing(resolution.data.winnerId as PlayerId, cardId, HUANJIA, chosen)) {
        delete stateOf(host).b67?.huanjiaUse
        if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
        finishPindianSettlement(host as never)
      }
      return
    }
    if (resolution.step !== 'lose-skill') return
    const skillId = (response.payload as { optionId?: string }).optionId
    const skill = getCharacter(playerOf(host.state, ownerId)?.characterId ?? '')?.skills.find((entry) => entry.id === skillId)
    if (!skillId || !skill || !playerOf(host.state, ownerId)?.alive) return
    suppressSkill(host.state, { targetId: ownerId, skillId, sourceId: ownerId, sourceSkillId: HUANJIA,
      expiresAt: 'never', armedAtTurn: host.state.turnNumber })
    host.dispatch('SkillActivated', { skillId: HUANJIA, playerId: ownerId, result: 'lost-skill', logText: `${playerOf(host.state, ownerId)?.nickname ?? '韩融'}因【缓颊】失去【${skill.name}】` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({ id: MINGJIE, limited: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play'
      && !owner.usedLimitedSkills.includes(MINGJIE)
      ? [{ id: `skill:${MINGJIE}`, label: '发动【铭戒】：选择一名角色' }] : []
  },
  modifiesNextCardTargets(state, ownerId) {
    const mark = (state as Batch67State).b67?.mingjie?.[ownerId]
    return Boolean(mark && state.currentPlayerId === ownerId)
  },
  nextCardTargetExpansion(state, ownerId, _cardId, _cardName) {
    const targetId = (state as Batch67State).b67?.mingjie?.[ownerId]?.targetId
    const target = targetId ? playerOf(state, targetId) : undefined
    return target?.alive && target.id !== ownerId
      ? { maxAdditionalTargets: 1, candidateIds: [target.id] } : null
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MINGJIE}`) return
    host.askSkill({ skillId: MINGJIE, ownerId, step: 'target', build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【铭戒】：选择一名角色', timeoutMs: 25_000,
      optional: false, candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      const mark = stateOf(host).b67?.mingjie?.[ownerId]
      if (!mark || mark.targetId !== targetId) return
      mark.turnNumber = host.state.turnNumber
      mark.records = []
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const mark = stateOf(host).b67?.mingjie?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (!mark || host.state.currentPlayerId !== mark.targetId || !payload.cardId) return
      const userId = context.event.sourceId ?? ownerId
      if (effectiveCardSuit(host.state, userId, payload.cardId, skillIdsOf) !== 'spade') return
      if (!mark.records.some((record) => record.cardId === payload.cardId))
        mark.records.push({ cardId: payload.cardId, cardName: payload.cardName ?? host.state.cards[payload.cardId]?.name ?? '', used: true })
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const mark = stateOf(host).b67?.mingjie?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; cancelled?: boolean }
      if (!mark || host.state.currentPlayerId !== mark.targetId || !payload.cancelled || !payload.cardId) return
      if (!mark.records.some((record) => record.cardId === payload.cardId))
        mark.records.push({ cardId: payload.cardId, cardName: payload.cardName ?? host.state.cards[payload.cardId]?.name ?? '', used: false })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      const mark = stateOf(host).b67?.mingjie?.[ownerId]
      if (!mark || mark.targetId !== targetId || mark.turnNumber !== host.state.turnNumber) return
      const available = mark.records.filter((record) => host.state.zones.discardPile.includes(record.cardId))
      delete stateOf(host).b67!.mingjie![ownerId]
      if (!available.length || !playerOf(host.state, ownerId)?.alive) return
      stateOf(host).b67 ??= {}
      ;(stateOf(host).b67 as Batch67State['b67'] & { mingjiePending?: Record<PlayerId, CardId[]> }).mingjiePending ??= {}
      ;(stateOf(host).b67 as Batch67State['b67'] & { mingjiePending: Record<PlayerId, CardId[]> }).mingjiePending[ownerId] = available.map((record) => record.cardId)
      host.queueSkill({ skillId: MINGJIE, ownerId, step: 'choose-card', data: {} })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const data = stateOf(host).b67 as Batch67State['b67'] & { mingjiePending?: Record<PlayerId, CardId[]> } | undefined
      if (!cardId || data?.mingjieAwaiting?.[ownerId] !== cardId) return
      delete data.mingjieAwaiting![ownerId]
      if (data.mingjiePending?.[ownerId]?.length) host.queueSkill({ skillId: MINGJIE, ownerId, step: 'choose-card', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const pending = (stateOf(host).b67 as Batch67State['b67'] & { mingjiePending?: Record<PlayerId, CardId[]> } | undefined)?.mingjiePending?.[ownerId]
    if (!pending?.length || !playerOf(host.state, ownerId)?.alive || prompt.step !== 'choose-card') return
    const usable = pending.filter((cardId) => host.state.zones.discardPile.includes(cardId)
      && discardPileCardUseActions(host, ownerId, cardId).length > 0)
    if (!usable.length) { delete (stateOf(host).b67 as Batch67State['b67'] & { mingjiePending?: Record<PlayerId, CardId[]> }).mingjiePending?.[ownerId]; return }
    host.askSkill({ skillId: MINGJIE, ownerId, step: 'choose-card', data: { usable }, build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【铭戒】：选择使用一张本回合进入弃牌堆的牌（可重复）',
      timeoutMs: 25_000, optional: true, options: [...usable.map((cardId) => ({ id: cardId, label: `使用【${host.state.cards[cardId]?.name ?? '牌'}】` })), { id: 'pass', label: '结束' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const owner = playerOf(host.state, ownerId)
      if (!owner || owner.usedLimitedSkills.includes(MINGJIE)) return
      owner.usedLimitedSkills.push(MINGJIE)
      stateOf(host).b67 ??= {}
      stateOf(host).b67!.mingjie ??= {}
      stateOf(host).b67!.mingjie![ownerId] = { targetId, expiresTurn: 0, turnNumber: host.state.turnNumber, records: [] }
      return
    }
    if (resolution.step === 'choose-card') {
      const cardId = (response.payload as { optionId?: CardId }).optionId
      const pendingRoot = stateOf(host).b67 as Batch67State['b67'] & { mingjiePending?: Record<PlayerId, CardId[]> }
      const pending = pendingRoot.mingjiePending?.[ownerId]
      if (!cardId || cardId === 'pass' || !pending?.includes(cardId)) { delete pendingRoot.mingjiePending?.[ownerId]; return }
      const actions = discardPileCardUseActions(host, ownerId, cardId)
      if (!actions.length) { pendingRoot.mingjiePending![ownerId] = pending.filter((id) => id !== cardId); host.queueSkill({ skillId: MINGJIE, ownerId, step: 'choose-card', data: {} }); return }
      host.askSkill({ skillId: MINGJIE, ownerId, step: 'use-card', data: { cardId }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【铭戒】：使用【${host.state.cards[cardId]?.name ?? '牌'}】`, timeoutMs: 25_000,
        optional: true, options: [...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'pass', label: '不使用此牌' }],
      }) })
      return
    }
    if (resolution.step === 'use-card') {
      const cardId = resolution.data.cardId as CardId
      const chosen = (response.payload as { optionId?: string }).optionId
      const root = stateOf(host).b67 as Batch67State['b67'] & { mingjiePending?: Record<PlayerId, CardId[]> }
      const pending = root.mingjiePending?.[ownerId] ?? []
      root.mingjiePending![ownerId] = pending.filter((id) => id !== cardId)
      if (chosen && chosen !== 'pass' && host.state.zones.discardPile.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'processingArea' })
        root.mingjieAwaiting ??= {}
        root.mingjieAwaiting[ownerId] = cardId
        if (!host.beginSkillCardUseFromProcessing(ownerId, cardId, MINGJIE, chosen)) {
          delete root.mingjieAwaiting[ownerId]
          if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
          if (root.mingjiePending?.[ownerId]?.length) host.queueSkill({ skillId: MINGJIE, ownerId, step: 'choose-card', data: {} })
        }
      }
      else if (root.mingjiePending?.[ownerId]?.length) host.queueSkill({ skillId: MINGJIE, ownerId, step: 'choose-card', data: {} })
    }
  },
})

registerSkillRuntime({ id: ZHANGDING,
  multiCardViewAs(state, ownerId): MultiCardViewAsSpec | null {
    const player = playerOf(state, ownerId)
    const count = (player?.zones.hand.length ?? 0) + Object.values(player?.zones.equipment ?? {}).filter(Boolean).length
    return player?.alive && count > 0 ? { skillId: ZHANGDING, skillName: '斩钉', requiredCount: 1, maxCount: count,
      suitToCardName: { heart: '杀', diamond: '杀', club: '杀', spade: '杀' },
      sameSuit: false, anySuitCardNames: ['杀'], onConvert(current, actorId, carrierId) {
        ;((current as Batch67State).b67 ??= {}).zhangdingCarrier ??= {}
        ;(current as Batch67State).b67!.zhangdingCarrier![carrierId] = { ownerId: actorId,
          countedSlash: current.currentPlayerId === actorId && current.phase === 'play' }
      } } : null
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== ZHANGDING || payload.cardName !== '杀' || !payload.cardId) return
      host.state.maxCardsAdjustments ??= {}
      host.state.maxCardsAdjustments[ownerId] = (host.state.maxCardsAdjustments[ownerId] ?? 0) - 1
      ;(stateOf(host).b67 ??= {}).zhangdingCarrier ??= {}
      stateOf(host).b67!.zhangdingCarrier![payload.cardId] = { ownerId,
        countedSlash: host.state.currentPlayerId === ownerId && host.state.phase === 'play' }
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const usage = cardId ? stateOf(host).b67?.zhangdingCarrier?.[cardId] : undefined
      if (!cardId || usage?.ownerId !== ownerId) return
      delete stateOf(host).b67!.zhangdingCarrier![cardId]
      if (cardDamageDealt(host.state, cardId) > 0) {
        const count = maxCardsOf(host.state, ownerId) - handOf(host.state, ownerId).length
        if (count > 0) drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
        else if (count < 0) {
          const player = playerOf(host.state, ownerId)!
          host.askSkill({ skillId: ZHANGDING, ownerId, step: 'adjust-hand', data: { count: -count }, build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【斩钉】：弃置牌至手牌上限', timeoutMs: 25_000,
            optional: false, purpose: 'skill', cardIds: [...player.zones.hand], hiddenCardSlots: [], min: -count, max: -count,
          }) })
        }
      } else if (usage.countedSlash && host.state.turnUsage.slashUses > 0) host.state.turnUsage.slashUses -= 1
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'adjust-hand') return
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (ids.length === Number(resolution.data.count) && ids.every((id) => handOf(host.state, ownerId).includes(id)))
      discardCardsByIds(host as never, ownerId, ids, ZHANGDING)
  },
})

registerSkillRuntime({ id: LIANZHU,
  ignoresDistanceTo(state, actorId, targetId) {
    const pending = (state as Batch67State).b67?.lianzhuPending
    return pending?.actorId === actorId && pending.targetId === targetId
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const pending = stateOf(host).b67?.lianzhuPending
    const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
    if (!pending || !payload.cardId || context.event.sourceId !== pending.actorId
      || payload.sourceSkillId !== LIANZHU) return
    if (pending.stage === 'first') {
      pending.firstColor = effectiveCardColor(host.state, pending.actorId, payload.cardId, skillIdsOf)
      pending.stage = 'second'
      pending.actorId = pending.secondActorId
      askLianzhuSlash(host, ownerId, pending.secondActorId, 'yin-second-use')
      return
    }
    const color = effectiveCardColor(host.state, pending.actorId, payload.cardId, skillIdsOf)
    if (pending.firstColor && color && pending.firstColor !== color) {
      const data = stateOf(host); data.b67 ??= {}; data.b67.lianzhuBonus ??= {}
      data.b67.lianzhuBonus[ownerId] = (data.b67.lianzhuBonus[ownerId] ?? 0) - 1
    }
    delete stateOf(host).b67!.lianzhuPending
    engineToggleConversionState(host.state, ownerId, LIANZHU)
  } }],
  grantsPlayActions(state, ownerId, actorId) {
    const owner = playerOf(state, ownerId)
    const phaseKey = `${state.turnNumber}:${phaseSlotOf(state)}:${state.extraPhase?.instanceId ?? ''}`
    return owner?.alive && actorId !== ownerId && state.phase === 'play' && state.currentPlayerId === actorId
      && playerOf(state, actorId)?.alive
      && (state as Batch67State).b67?.lianzhuPhaseUse?.[actorId] !== phaseKey
      ? [{ id: `skill:${LIANZHU}`, label: '发动【联诛】' }] : []
  },
  maxCardsBonus(state, ownerId) { return (state as Batch67State).b67?.lianzhuBonus?.[ownerId] ?? 0 },
  invokeGrantedAction(host, ownerId, targetId, actionId) {
    if (actionId !== `skill:${LIANZHU}`) return
    if (targetId === ownerId || !playerOf(host.state, targetId)?.alive) return
    const state = stateOf(host)
    const key = `${host.state.turnNumber}:${phaseSlotOf(host.state)}:${host.state.extraPhase?.instanceId ?? ''}`
    state.b67 ??= {}; state.b67.lianzhuPhaseUse ??= {}; state.b67.lianzhuPhaseUse[targetId] = key
    const mode = engineConversionStateOf(host.state, ownerId, LIANZHU) ?? 'yang'
    host.askSkill({ skillId: LIANZHU, ownerId, step: mode === 'yang' ? 'yang-target-card' : 'yin-target', data: { targetId, mode }, build: (requestId): ChooseCardsRequest | ChooseTargetsRequest => mode === 'yang'
      ? { id: requestId, kind: 'choose-cards', playerId: targetId, prompt: '【联诛·阳】：选择一张牌重铸', timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: [...handOf(host.state, targetId)], hiddenCardSlots: [], min: 0, max: 1 }
      : { id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【联诛·阴】：选择一名角色作为目标', timeoutMs: 25_000, optional: true, candidateIds: host.state.players.filter((p) => p.alive && p.id !== targetId).map((p) => p.id), min: 1, max: 1 } })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    if (resolution.data.mode === 'yang') {
      if (resolution.step === 'yang-target-card') {
        const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
        if (!cardId || !handOf(host.state, targetId).includes(cardId)) { engineToggleConversionState(host.state, ownerId, LIANZHU); return }
        const actorOptions = [...handOf(host.state, ownerId)]
        host.askSkill({ skillId: LIANZHU, ownerId, step: 'yang-owner-card', data: { targetId, targetCardId: cardId, mode: 'yang' }, build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【联诛·阳】：选择一张牌重铸', timeoutMs: 25_000,
          optional: true, purpose: 'skill', cardIds: actorOptions, hiddenCardSlots: [], min: 0, max: 1,
        }) })
      } else if (resolution.step === 'yang-owner-card') {
        const ownerCardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
        const targetCardId = resolution.data.targetCardId as CardId
        if (!ownerCardId || !handOf(host.state, ownerId).includes(ownerCardId)) { engineToggleConversionState(host.state, ownerId, LIANZHU); return }
        const targetColor = effectiveCardColor(host.state, targetId, targetCardId, skillIdsOf), ownerColor = effectiveCardColor(host.state, ownerId, ownerCardId, skillIdsOf)
        for (const [actorId, cardId] of [[targetId, targetCardId], [ownerId, ownerCardId]] as const) {
          if (!handOf(host.state, actorId).includes(cardId)) continue
          moveCard(host.state, cardId, { kind: 'hand', playerId: actorId }, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: actorId, cardIds: [cardId], reason: 'recast' }, { sourceId: actorId, cardIds: [cardId] })
          drawCards(host.state, host.rng, actorId, 1, (name, payload) => {
            if (name === 'GainCard') {
              host.dispatch(name, { ...payload, reason: 'recast' }, {
                targetId: actorId, cardIds: payload.cardIds as CardId[],
              })
            } else host.dispatch(name, payload)
          })
        }
        if (targetColor && targetColor === ownerColor) {
          const data = stateOf(host); data.b67 ??= {}; data.b67.lianzhuBonus ??= {}; data.b67.lianzhuBonus[ownerId] = (data.b67.lianzhuBonus[ownerId] ?? 0) + 1
        }
        engineToggleConversionState(host.state, ownerId, LIANZHU)
      }
    } else if (resolution.step === 'yin-target') {
      const chosenTarget = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!chosenTarget || chosenTarget === ownerId || chosenTarget === targetId) { engineToggleConversionState(host.state, ownerId, LIANZHU); return }
      const state = stateOf(host); state.b67 ??= {}
      state.b67.lianzhuPending = { targetId: chosenTarget, actorId: ownerId, secondActorId: targetId, stage: 'first' }
      askLianzhuSlash(host, ownerId, ownerId, 'yin-first-use')
      return
    }
    if (resolution.step === 'yin-first-use' || resolution.step === 'yin-second-use') {
      const pending = stateOf(host).b67?.lianzhuPending
      const actorId = resolution.data.actorId as PlayerId
      const actionId = (response.payload as { optionId?: string }).optionId
      if (!pending || pending.actorId !== actorId) return
      if (actionId && actionId !== 'pass') {
        const selected = (resolution.data.actions as Array<{ id: string; cardId: CardId }>).find((action) => action.id === actionId)
        if (selected && handOf(host.state, actorId).includes(selected.cardId)
          && host.beginSkillBasicUse({ sourceId: actorId, cardId: selected.cardId, cardName: '杀', targetIds: [pending.targetId], sourceSkillId: LIANZHU })) return
      }
      if (pending.stage === 'first') {
        pending.stage = 'second'
        pending.actorId = pending.secondActorId
        askLianzhuSlash(host, ownerId, pending.secondActorId, 'yin-second-use')
      } else {
        delete stateOf(host).b67!.lianzhuPending
        engineToggleConversionState(host.state, ownerId, LIANZHU)
      }
    }
  },
})

registerSkillRuntime({ id: KAIJI,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const drawOwnerId = cardId ? stateOf(host).b67?.kaijiDrawAfterCard?.[cardId] : undefined
    if (!cardId || drawOwnerId !== ownerId) return
    delete stateOf(host).b67!.kaijiDrawAfterCard![cardId]
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  } }],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play' || !owner.zones.hand.length
      || usedThisPhase(state, ownerId, KAIJI)) return []
    const round = state.roundNumber ?? 1
    const used = (state as Batch67State).b67?.kaijiUsed?.[ownerId]
    const candidates = state.players.some((target) => target.alive && target.id !== ownerId
      && !(used?.round === round && used.targets.includes(target.id)))
    return candidates ? [{ id: `skill:${KAIJI}`, label: '发动【开济】：令一名本轮未指定的角色弃置你一张手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${KAIJI}`) return
    markUsedThisPhase(host.state, ownerId, KAIJI)
    const round = host.state.roundNumber ?? 1
    const used = stateOf(host).b67?.kaijiUsed?.[ownerId]
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
      && !(used?.round === round && used.targets.includes(target.id)))
    if (!candidates.length) return
    host.askSkill({ skillId: KAIJI, ownerId, step: 'target', data: { round }, build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【开济】：选择一名本轮未以此法指定过的角色',
      timeoutMs: 25_000, optional: false, candidateIds: candidates.map((target) => target.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const owner = playerOf(host.state, ownerId)
      if (!target?.alive || !owner?.alive || target.id === ownerId || !owner.zones.hand.length) return
      const round = Number(resolution.data.round)
      const state = stateOf(host); state.b67 ??= {}; state.b67.kaijiUsed ??= {}
      const used = state.b67.kaijiUsed[ownerId]
      state.b67.kaijiUsed[ownerId] = { round, targets: [...(used?.round === round ? used.targets : []), target.id] }
      host.askSkill({ skillId: KAIJI, ownerId, step: 'discard-owner-card', data: { targetId }, build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: target.id,
        prompt: `【开济】：弃置${owner.nickname}的一张手牌`, timeoutMs: 25_000, optional: false, purpose: 'skill',
        cardIds: [], hiddenCardSlots: owner.zones.hand.map((_, index) => hiddenHandSlot(ownerId, index)), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'discard-owner-card') {
      const targetId = resolution.data.targetId as PlayerId
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = picked ? resolvePickedCard(host.state, ownerId, picked) : null
      if (!cardId || !playerOf(host.state, targetId)?.alive) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: KAIJI }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      const actions = pindianCardUseActions(host, ownerId, cardId)
      if (!actions.length) { moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' }); return }
      stateOf(host).b67 ??= {}
      stateOf(host).b67!.kaijiCurrent = { ownerId, cardId, actionIds: actions.map((action) => action.id) }
      host.askSkill({ skillId: KAIJI, ownerId, step: 'use-discarded-card', data: { cardId }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【开济】：是否使用弃置的【${host.state.cards[cardId]?.name ?? '牌'}】？`,
        timeoutMs: 25_000, optional: true, options: [...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'pass', label: '不使用' }],
      }) })
      return
    }
    if (resolution.step !== 'use-discarded-card') return
    const cardId = resolution.data.cardId as CardId
    const chosen = (response.payload as { optionId?: string }).optionId
    const pending = stateOf(host).b67?.kaijiCurrent
    if (!pending || pending.ownerId !== ownerId || pending.cardId !== cardId) return
    delete stateOf(host).b67!.kaijiCurrent
    if (!chosen || chosen === 'pass') { if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' }); return }
    stateOf(host).b67 ??= {}; stateOf(host).b67!.kaijiDrawAfterCard ??= {}
    stateOf(host).b67!.kaijiDrawAfterCard![cardId] = ownerId
    if (!host.beginSkillCardUseFromProcessing(ownerId, cardId, KAIJI, chosen)) {
      delete stateOf(host).b67!.kaijiDrawAfterCard![cardId]
      if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    }
    else if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  },
})
