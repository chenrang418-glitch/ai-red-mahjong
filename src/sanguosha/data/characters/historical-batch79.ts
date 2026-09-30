import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'
import { registerSkillRuntime, effectiveCardSuit, effectiveCardColor, type SkillHost } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { moveCard, locateOwnedCard, setCardAlias } from '../../engine/zones'
import { reshuffleDrawPile } from '../../engine/deck'
import { discardCardsByIds } from '../../engine/discard-all'
import { loseHp, loseMaxHp, gainMaxHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { continueDyingRescue } from '../../engine/damage'
import { handleEquipmentLost } from '../../engine/equipment'
import { fieldCards } from '../../engine/field-move'
import { suppressSkill } from '../../engine/skill-suppression'
import { isLockedSkill } from '../../engine/locked-skills'
import { recover } from '../../engine/recover'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { executeUseCardAction } from '../../engine/cards/basic'
import { DAMAGE_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'

const B = '-b79'
const sid = (name: string) => `${name}${B}`
const WANG_LING_JICHOU = sid('jichou-mou-wangling')
const WANG_LING_MOULI = sid('mouli-mou-wangling')
const WANG_LING_ZIFU = sid('zifu-mou-wangling')
const SIMASHI_SANSHI = sid('sanshi-mou-simashi')
const SIMASHI_ZHENRAO = sid('zhenrao-mou-simashi')
const SIMASHI_CHENLUE = sid('chenlue-mou-simashi')
const CAOSHANG_JIANZHUAN = sid('jianzhuan-mou-caoshuang')
const CAOSHANG_FANSHI = sid('fanship-mou-caoshuang')
const CAOSHANG_FUDOU = sid('fudou-mou-caoshuang')
const GUANYU_JUEWU = sid('juewu-wu-guanyu')
const GUANYU_WUYOU = sid('wuyou-wu-guanyu')
const GUANYU_YIXIAN = sid('yixian-wu-guanyu')
const SUNJIAN_RUIJUN = sid('ruijun-star-sunjian')
const SUNJIAN_GANGYI = sid('gangyi-star-sunjian')
const WUPU_DUANTI = sid('duanti-wupu')
const WUPU_SHICAO = sid('shicao-wupu')
const GUANYUE_SHOUZHI = sid('shouzhi-guanyue')
const GUANYUE_FENHUI = sid('fenhui-guanyue')
const GUANYUE_XINGMEN = sid('xingmen-guanyue')
const ZHUPEILAN_CILU = sid('cilu-zhupeilan')
const ZHUPEILAN_TONGDAO = sid('tongdao-zhupeilan')
const GUANPING_WUWEI = sid('wuwei-mou-guanping')
const ZOUYUNSHI_YUNZHENG = sid('yunzheng-le-zoushi')
const ZOUYUNSHI_HUOXIN = sid('huoxin-le-zoushi')

const CAO_SHANG_CHOICES = ['discard-target', 'draw-self', 'recast-self', 'discard-self'] as const

type B79State = SanguoshaState & { b79?: Record<string, any> }
function s79(state: SanguoshaState): Record<string, any> { const target = state as B79State; target.b79 ??= {}; return target.b79 }
function player(state: SanguoshaState, id: PlayerId) { return state.players.find((entry) => entry.id === id) }
function living(state: SanguoshaState) { return state.players.filter((entry) => entry.alive) }
function handAndEquipment(state: SanguoshaState, id: PlayerId): CardId[] {
  const owner = player(state, id)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))] : []
}
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId,
    prompt, timeoutMs: 25_000, optional, options }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, cardIds: CardId[],
  prompt: string, data: Record<string, unknown> = {}, min = 1, max = min) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId,
    prompt, timeoutMs: 25_000, optional: min === 0, purpose: 'skill', hiddenCardSlots: [], cardIds, min, max }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, targetIds: PlayerId[],
  prompt: string, data: Record<string, unknown> = {}, min = 1, max = min) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId,
    prompt, timeoutMs: 25_000, optional: min === 0, min, max, candidateIds: targetIds }) })
}
function discard(host: SkillHost, playerId: PlayerId, cardIds: CardId[], reason: string) {
  if (cardIds.length) discardCardsByIds(host as never, playerId, cardIds, reason)
}
function addGrantedSkill(owner: { grantedSkills: string[] }, skillId: string) {
  if (!owner.grantedSkills.includes(skillId)) owner.grantedSkills.push(skillId)
}
export const HISTORICAL_BATCH79_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'mou-wangling-b79', name: '谋·王凌', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: WANG_LING_JICHOU, name: '集筹', description: '结束阶段，若你本回合使用的牌名均不同，你可以从弃牌堆中将这些牌交给你选择的角色各一张，然后你摸X张牌（X是其中此前没有因此给出过的牌名张数）。' },
    { id: WANG_LING_MOULI, name: '谋立', description: '觉醒技，回合结束时，若你因“集筹”给出的牌名不同的牌超过了5种，你加1点体力上限并回复1点体力，然后获得“自缚”。' },
    { id: WANG_LING_ZIFU, name: '自缚', description: '锁定技，出牌阶段结束时，若你本阶段未使用牌，你本回合手牌上限-1。' , granted: true },
  ] },
  { id: 'mou-simashi-b79', name: '谋·司马师', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SIMASHI_SANSHI, name: '散士', description: '锁定技，游戏开始时，你将牌堆中每个点数的随机一张牌标记为“死士”牌。每个回合结束时，若本回合有“死士”牌不因你使用或打出而进入弃牌堆，你获得弃牌堆中的这些牌。你使用“死士”牌不能被响应。' },
    { id: SIMASHI_ZHENRAO, name: '震扰', description: '每回合每名角色限一次，你使用牌指定其他角色为目标后，或其他角色使用牌指定你为目标后，你可以选择手牌数大于你的其中一个目标或使用者，对其造成1点伤害。' },
    { id: SIMASHI_CHENLUE, name: '沉略', description: '限定技，出牌阶段，你可以从牌堆、弃牌堆、场上或其他角色手牌中获得所有“死士”牌。出牌阶段结束时，将这些牌移出游戏直到你死亡。' },
  ] },
  { id: 'mou-caoshuang-b79', name: '谋·曹爽', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: CAOSHANG_JIANZHUAN, name: '渐专', description: '锁定技，出牌阶段每项限一次，你使用牌时，选择一项：1.令一名角色弃X张牌；2.摸X张牌；3.重铸X张牌；4.弃X张牌（X为此技能此阶段发动次数）。出牌阶段结束时，若所有选项都执行过，随机删除一个选项。' },
    { id: CAOSHANG_FANSHI, name: '返势', description: '觉醒技，结束阶段，若“渐专”的选项小于2个，你执行3次剩余选项（X视为1），增加2点体力上限并回复2点体力，然后失去“渐专”，获得“覆斗”。' },
    { id: CAOSHANG_FUDOU, name: '覆斗', description: '当你使用黑色/红色牌指定其他角色为唯一目标后，若其已对你/未对你造成过伤害，你可以与其各失去1点体力/摸一张牌。', granted: true },
  ] },
  { id: 'wu-guanyu-b79', name: '武关羽', kingdom: 'shu', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: GUANYU_JUEWU, name: '绝武', description: '你点数为2的牌可当任意伤害牌使用（每种牌名每回合限一次）。你从其他角色处获得的牌在你的手牌中时均视为点数2。' },
    { id: GUANYU_WUYOU, name: '武佑', description: '每名角色的出牌阶段限一次，其可以交给你一张手牌，然后你可以从五个随机非装备牌名中选择一个并交给其一张手牌。此牌视为你选择牌名的牌且无距离和次数限制。' },
    { id: GUANYU_YIXIAN, name: '义贤', description: '限定技，出牌阶段，你可以选择一项：1.获得场上所有装备牌；2.获得弃牌堆中所有装备牌。然后你可令被你获得牌的角色摸X张牌（X为该角色因此被你获得的牌数）并回复1点体力。' },
  ] },
  { id: 'star-sunjian-b79', name: '星·孙坚', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SUNJIAN_RUIJUN, name: '锐军', description: '出牌阶段，当你首次使用牌指定其他角色为目标后，你可以摸X+1张牌（X为你已损失体力值）。若如此做，此阶段内，除该角色外其他角色均不在你的攻击范围内，你对其使用牌无距离限制，且每次你对该角色造成伤害时，伤害值均比上一次增加1（至多为5）。' },
    { id: SUNJIAN_GANGYI, name: '刚毅', description: '锁定技，你的回合内，若你本回合没有造成伤害，你不能使用【桃】。你处于濒死状态时，【桃】或【酒】回复值+1。' },
  ] },
  { id: 'wupu-b79', name: '吴普', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: WUPU_DUANTI, name: '锻体', description: '锁定技，每使用或打出五张牌结算后，你回复1点体力并增加1点体力上限（至多+5）。' },
    { id: WUPU_SHICAO, name: '识草', description: '出牌阶段，你可以声明一种牌的类型然后从牌堆顶或牌堆底摸一张牌。若此牌与你声明类型不同，你观看另一端两张牌且此技能本回合失效。' },
  ] },
  { id: 'guanyue-b79', name: '关樾', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: GUANYUE_SHOUZHI, name: '守执', description: '锁定技，每个回合结束时，若你的手牌数比回合开始时多，你弃置1张手牌；若你的手牌数比回合开始时少，你摸两张牌。' },
    { id: GUANYUE_FENHUI, name: '奋恚', description: '限定技，出牌阶段，你可令一名角色获得X个“恨”标记并摸等量的牌（X为你本局游戏对其使用过牌的次数且最多为5）。其每次受到伤害时，移去一个“恨”且此伤害+1。若其脱离濒死状态或死亡时仍有“恨”，你减1点体力上限，“守执”改为非锁定技且获得技能“兴门”。' },
    { id: GUANYUE_XINGMEN, name: '兴门', description: '你因“守执”弃牌时，可回复1点体力；你一次性从牌堆摸超过一张牌时，这些牌获得不计次数且“不能被响应”。', granted: true },
  ] },
  { id: 'zhupeilan-b79', name: '朱佩兰', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHUPEILAN_CILU, name: '辞虑', description: '你成为普通锦囊牌目标后，可以摸剩余选项数张牌。若你手牌数大于体力上限，你选择一项并移除该选项：1.此牌对你无效；2.防止此牌造成的伤害；3.此牌结算完毕后获得此牌。' },
    { id: ZHUPEILAN_TONGDAO, name: '痛悼', description: '限定技，当你处于濒死状态时，你可以令一名角色技能还原为游戏开始时状态。若该角色不为你，你回复体力至与其相同。' },
  ] },
  { id: 'mou-guanping-b79', name: '谋·关平', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: GUANPING_WUWEI, name: '武威', description: '出牌阶段限一次，你可将一种颜色的所有手牌当【杀】使用（无次数距离限制），其中每有一种牌类型你可选择一项执行一次：1.摸一张牌；2.目标角色本回合非锁定技能失效；3.此技能本回合可发动次数+1。若此【杀】执行了所有选项，则伤害+1。' },
  ] },
  { id: 'le-zoushi-b79', name: '乐邹氏', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZOUYUNSHI_YUNZHENG, name: '韵筝', description: '锁定技，游戏开始时，你的初始手牌增加“筝”标记且不计入手牌上限，手牌有“筝”的其他角色非锁定技失效。' },
    { id: ZOUYUNSHI_HUOXIN, name: '惑心', description: '你使用非装备牌时，可以展示一名其他角色一张手牌并标记为“筝”。若此牌与你使用的牌花色相同或已被标记过，你可以获得之。' },
  ] },
]

const CILU_CHOICES = ['cancel', 'prevent', 'claim'] as const
registerSkillRuntime({ id: ZHUPEILAN_CILU,
  onGameStart(host, ownerId) { s79(host.state).ciluOptions ??= {}, s79(host.state).ciluOptions[ownerId] = [...CILU_CHOICES] },
  interceptPlayAction(host, ownerId, action) {
    if (!action.targetIds.includes(ownerId) || !INSTANT_TRICKS.has(action.asCardName) || !player(host.state, ownerId)?.alive) return false
    const options = (s79(host.state).ciluOptions?.[ownerId] as string[] | undefined) ?? [...CILU_CHOICES]
    if (!options.length) return false
    host.queueSkill({ skillId: ZHUPEILAN_CILU, ownerId, step: 'offer', data: { action, remaining: options.length } })
    return true
  },
  cancelsBecomingTarget(host, ownerId, context) {
    return Boolean(context.cardId && s79(host.state).ciluCanceled?.[context.cardId]?.includes(ownerId))
  },
  preventsDamage(state, ownerId, _side, context) {
    return Boolean(context.targetId === ownerId && context.cardId && s79(state).ciluPrevent?.[context.cardId]?.includes(ownerId))
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!cardId || !s79(host.state).ciluClaim?.[cardId]?.includes(ownerId)) return
    s79(host.state).ciluClaim[cardId] = s79(host.state).ciluClaim[cardId].filter((id: PlayerId) => id !== ownerId)
    if (host.state.zones.discardPile.includes(cardId)) {
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHUPEILAN_CILU }, { targetId: ownerId, cardIds: [cardId] })
    }
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    askOption(host, ZHUPEILAN_CILU, ownerId, 'invoke', ownerId, `【辞虑】：是否摸${prompt.data.remaining}张牌？`,
      [{ id: 'yes', label: '摸牌' }, { id: 'no', label: '不发动' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { action: Parameters<typeof executeUseCardAction>[2]; remaining: number; cardId?: CardId }
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') {
        drawCards(host.state, host.rng, ownerId, data.remaining, (name, payload) => host.dispatch(name, payload))
        const owner = player(host.state, ownerId)
        const options = (s79(host.state).ciluOptions?.[ownerId] as string[] | undefined) ?? []
        if (owner && owner.zones.hand.length > owner.maxHp && options.length) {
          askOption(host, ZHUPEILAN_CILU, ownerId, 'mode', ownerId, '【辞虑】：选择并移除一项效果',
            options.map((id) => ({ id, label: id === 'cancel' ? '此牌对你无效' : id === 'prevent' ? '防止此牌造成的伤害' : '结算後获得此牌' })), data, false)
          return
        }
      }
      executeUseCardAction(host as never, data.action.playerId, data.action, { skipPlayInterceptors: true })
      return
    }
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      const action = data.action
      const cardId = action.cardIds[0]
      const options = s79(host.state).ciluOptions?.[ownerId] as string[] | undefined
      if (!mode || !options?.includes(mode) || !cardId) return
      s79(host.state).ciluOptions[ownerId] = options.filter((id) => id !== mode)
      if (mode === 'cancel') { s79(host.state).ciluCanceled ??= {}; s79(host.state).ciluCanceled[cardId] ??= []; s79(host.state).ciluCanceled[cardId].push(ownerId) }
      if (mode === 'prevent') { s79(host.state).ciluPrevent ??= {}; s79(host.state).ciluPrevent[cardId] ??= []; s79(host.state).ciluPrevent[cardId].push(ownerId) }
      if (mode === 'claim') { s79(host.state).ciluClaim ??= {}; s79(host.state).ciluClaim[cardId] ??= []; s79(host.state).ciluClaim[cardId].push(ownerId) }
      executeUseCardAction(host as never, action.playerId, action, { skipPlayInterceptors: true })
    }
  },
})

registerSkillRuntime({ id: SUNJIAN_GANGYI,
  prohibitsCardUse(state, ownerId, context) {
    const owner = player(state, ownerId)
    if (context.userId !== ownerId || context.cardName !== '桃' || !owner || state.currentPlayerId !== ownerId) return false
    const dealt = s79(state).sunjianDamageTurns?.[ownerId] === state.turnNumber
    return !dealt
  },
  basicCardUseValueBonus(state, ownerId, _cardId, cardName) {
    const owner = player(state, ownerId)
    return owner && owner.hp <= 0 && (cardName === '桃' || cardName === '酒') ? 1 : 0
  },
  triggers: [{ event: 'DamageSettled', handle(host, _ownerId, context) {
    if (!context.event.sourceId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
    s79(host.state).sunjianDamageTurns ??= {}
    s79(host.state).sunjianDamageTurns[context.event.sourceId] = host.state.turnNumber
  } }],
})

registerSkillRuntime({ id: WANG_LING_JICHOU,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) {
        s79(host.state).jichouTurnCards ??= {}
        s79(host.state).jichouTurnCards[ownerId] = []
      }
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (!payload.cardId || !payload.cardName) return
      s79(host.state).jichouTurnCards ??= {}
      s79(host.state).jichouTurnCards[ownerId] ??= []
      s79(host.state).jichouTurnCards[ownerId].push({ cardId: payload.cardId, cardName: payload.cardName })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const used = s79(host.state).jichouTurnCards?.[ownerId] ?? []
      if (payload.playerId !== ownerId || payload.phase !== 'finish' || !used.length
        || new Set(used.map((entry: { cardName: string }) => entry.cardName)).size !== used.length) return
      const movable = used.filter((entry: { cardId: CardId }) => host.state.zones.discardPile.includes(entry.cardId))
      if (movable.length) host.queueSkill({ skillId: WANG_LING_JICHOU, ownerId, step: 'offer', data: { cards: movable } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      askOption(host, WANG_LING_JICHOU, ownerId, 'offer-choice', ownerId,
        '【集筹】：是否将本回合使用且仍在弃牌堆中的牌依次交给角色？',
        [{ id: 'yes', label: '发动集筹' }, { id: 'no', label: '不发动' }], prompt.data)
      return
    }
    if (prompt.step !== 'give-next') return
    const data = prompt.data as { entries: Array<{ cardId: CardId; cardName: string }>; index: number; newNames: string[] }
    const index = Number(data.index ?? 0)
    if (index >= data.entries.length || !player(host.state, ownerId)?.alive) {
      const state = s79(host.state)
      state.jichouGivenNames ??= {}
      const prior = new Set<string>(state.jichouGivenNames[ownerId] ?? [])
      for (const name of data.newNames) prior.add(name)
      state.jichouGivenNames[ownerId] = [...prior]
      if (data.newNames.length) drawCards(host.state, host.rng, ownerId, data.newNames.length,
        (name, payload) => host.dispatch(name, payload))
      return
    }
    const entry = data.entries[index]!
    if (!host.state.zones.discardPile.includes(entry.cardId)) {
      host.queueSkill({ skillId: WANG_LING_JICHOU, ownerId, step: 'give-next', data: { ...data, index: index + 1 } })
      return
    }
    askTargets(host, WANG_LING_JICHOU, ownerId, 'give-target', ownerId, living(host.state).map(({ id }) => id),
      `【集筹】：选择获得【${entry.cardName}】的角色`, { ...data, index }, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer-choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const entries = (resolution.data.cards as Array<{ cardId: CardId; cardName: string }>).filter((entry) =>
        host.state.zones.discardPile.includes(entry.cardId))
      if (entries.length) host.queueSkill({ skillId: WANG_LING_JICHOU, ownerId, step: 'give-next', data: { entries, index: 0, newNames: [] } })
      return
    }
    if (resolution.step === 'give-target') {
      const data = resolution.data as { entries: Array<{ cardId: CardId; cardName: string }>; index: number; newNames: string[] }
      const entry = data.entries[data.index]
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (entry && target?.alive && host.state.zones.discardPile.includes(entry.cardId)) {
        moveCard(host.state, entry.cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: target.id })
        host.dispatch('GainCard', { playerId: target.id, cardIds: [entry.cardId], reason: WANG_LING_JICHOU },
          { sourceId: ownerId, targetId: target.id, cardIds: [entry.cardId] })
        const history = new Set<string>(s79(host.state).jichouGivenNames?.[ownerId] ?? [])
        if (!history.has(entry.cardName) && !data.newNames.includes(entry.cardName)) data.newNames.push(entry.cardName)
      }
      host.queueSkill({ skillId: WANG_LING_JICHOU, ownerId, step: 'give-next', data: { ...data, index: data.index + 1 } })
      return
    }
    if (resolution.step !== 'offer-choice') return
  },
})

registerSkillRuntime({ id: WANG_LING_MOULI,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId || s79(host.state).wanglingAwakened?.[ownerId]) return
    const names = s79(host.state).jichouGivenNames?.[ownerId] as string[] | undefined
    if ((names?.length ?? 0) <= 5) return
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    s79(host.state).wanglingAwakened ??= {}
    s79(host.state).wanglingAwakened[ownerId] = true
    owner.awakenedSkills.push(WANG_LING_MOULI)
    gainMaxHp(host as never, ownerId, 1, WANG_LING_MOULI)
    recover(host as never, ownerId, 1, ownerId, WANG_LING_MOULI)
    addGrantedSkill(owner, WANG_LING_ZIFU)
    host.dispatch('SkillAwakened', { playerId: ownerId, skillId: WANG_LING_MOULI }, { sourceId: ownerId })
  } }],
})

registerSkillRuntime({ id: WANG_LING_ZIFU,
  maxCardsBonus(state, ownerId) { return s79(state).zifuFailedTurn?.[ownerId] === state.turnNumber ? -1 : 0 },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) {
        s79(host.state).zifuUsedCard ??= {}
        s79(host.state).zifuUsedCard[ownerId] = false
      }
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId && host.state.phase === 'play') {
        s79(host.state).zifuUsedCard ??= {}
        s79(host.state).zifuUsedCard[ownerId] = true
      }
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play' && !s79(host.state).zifuUsedCard?.[ownerId]) {
        s79(host.state).zifuFailedTurn ??= {}
        s79(host.state).zifuFailedTurn[ownerId] = host.state.turnNumber
      }
    } },
  ],
})

registerSkillRuntime({ id: CAOSHANG_JIANZHUAN,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) {
        s79(host.state).caoshuangOptions ??= {}
        s79(host.state).caoshuangOptions[ownerId] ??= [...CAO_SHANG_CHOICES]
        s79(host.state).caoshuangPhase ??= {}
        s79(host.state).caoshuangPhase[ownerId] = { turn: host.state.turnNumber, count: 0, used: [] }
      }
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const phase = s79(host.state).caoshuangPhase?.[ownerId]
      if (context.event.sourceId !== ownerId || host.state.phase !== 'play' || phase?.turn !== host.state.turnNumber
        || s79(host.state).caoshuangAwakened?.[ownerId]) return
      phase.count = Number(phase.count ?? 0) + 1
      host.queueSkill({ skillId: CAOSHANG_JIANZHUAN, ownerId, step: 'choose-option', data: { count: phase.count } })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const options = s79(host.state).caoshuangOptions?.[ownerId] as string[] | undefined
      const phase = s79(host.state).caoshuangPhase?.[ownerId]
      if (options?.length && phase?.used?.length === options.length) {
        const remove = host.rng.shuffle([...options])[0]
        s79(host.state).caoshuangOptions[ownerId] = options.filter((option) => option !== remove)
      }
      s79(host.state).caoshuangPhase[ownerId] = { turn: host.state.turnNumber, count: 0, used: [] }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-option') return
    const owner = player(host.state, ownerId)
    const count = Math.trunc(Number(prompt.data.count ?? 0))
    const options = (s79(host.state).caoshuangOptions?.[ownerId] as string[] | undefined) ?? []
    const phase = s79(host.state).caoshuangPhase?.[ownerId]
    if (!owner?.alive || count < 1 || phase?.turn !== host.state.turnNumber) return
    const available = options.filter((id) => !phase.used.includes(id))
    const hand = owner.zones.hand
    const discardTargets = living(host.state).filter((target) => handAndEquipment(host.state, target.id).length >= count)
    const choices: Array<{ id: string; label: string }> = []
    if (available.includes('discard-target') && discardTargets.length) choices.push({ id: 'discard-target', label: `令一名角色弃置${count}张牌` })
    if (available.includes('draw-self')) choices.push({ id: 'draw-self', label: `摸${count}张牌` })
    if (available.includes('recast-self') && hand.length >= count) choices.push({ id: 'recast-self', label: `重铸${count}张牌` })
    if (available.includes('discard-self') && hand.length >= count) choices.push({ id: 'discard-self', label: `弃置${count}张手牌` })
    if (choices.length === 0 && available.includes('draw-self')) choices.push({ id: 'draw-self', label: `摸${count}张牌` })
    if (choices.length) askOption(host, CAOSHANG_JIANZHUAN, ownerId, 'option', ownerId,
      `【渐专】：选择一项（本阶段第${count}次发动，X=${count}）`, choices, { count }, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'option') {
      const option = (response.payload as { optionId?: string }).optionId
      const count = Math.trunc(Number(resolution.data.count ?? 0))
      const options = (s79(host.state).caoshuangOptions?.[ownerId] as string[] | undefined) ?? []
      const phase = s79(host.state).caoshuangPhase?.[ownerId]
      if (!option || !options.includes(option) || !phase || phase.turn !== host.state.turnNumber || phase.used.includes(option)) return
      const owner = player(host.state, ownerId)
      if (!owner?.alive) return
      if (option === 'discard-target') {
        const targets = living(host.state).filter((target) => handAndEquipment(host.state, target.id).length >= count).map(({ id }) => id)
        if (targets.length) askTargets(host, CAOSHANG_JIANZHUAN, ownerId, 'target', ownerId, targets,
          `【渐专】：选择弃置${count}张牌的角色`, { option, count }, 1, 1)
        return
      }
      if (option === 'recast-self' || option === 'discard-self') {
        if (owner.zones.hand.length < count) return
        askCards(host, CAOSHANG_JIANZHUAN, ownerId, 'self-cards', ownerId, [...owner.zones.hand],
          `【渐专】：选择${count}张手牌${option === 'recast-self' ? '重铸' : '弃置'}`, { option, count }, count, count)
        return
      }
      if (option !== 'draw-self') return
      phase.used.push(option)
      drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
      return
    }
    if (resolution.step === 'target') {
      const option = resolution.data.option as string
      const count = Math.trunc(Number(resolution.data.count ?? 0))
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      const phase = s79(host.state).caoshuangPhase?.[ownerId]
      if (!target?.alive || handAndEquipment(host.state, target.id).length < count || !phase) return
      const cards = handAndEquipment(host.state, target.id)
      askCards(host, CAOSHANG_JIANZHUAN, ownerId, 'target-cards', target.id, cards,
        `【渐专】：选择${count}张牌弃置`, { option, count, targetId }, count, count)
      return
    }
    if (resolution.step === 'target-cards' || resolution.step === 'self-cards') {
      const option = resolution.data.option as string
      const count = Math.trunc(Number(resolution.data.count ?? 0))
      const targetId = resolution.step === 'self-cards' ? ownerId : resolution.data.targetId as PlayerId
      const target = player(host.state, targetId)
      const available = resolution.step === 'self-cards' ? target?.zones.hand ?? [] : handAndEquipment(host.state, targetId)
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((id) => available.includes(id)).slice(0, count)
      if (!target?.alive || selected.length !== count) return
      const phase = s79(host.state).caoshuangPhase?.[ownerId]
      if (!phase || phase.turn !== host.state.turnNumber || phase.used.includes(option)) return
      phase.used.push(option)
      discard(host as never, targetId, selected, CAOSHANG_JIANZHUAN)
      if (option === 'recast-self') drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
      return
    }
  },
})

registerSkillRuntime({ id: CAOSHANG_FANSHI,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || s79(host.state).caoshuangAwakened?.[ownerId]) return
    const options = (s79(host.state).caoshuangOptions?.[ownerId] as string[] | undefined) ?? [...CAO_SHANG_CHOICES]
    if (options.length >= 2) return
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    s79(host.state).caoshuangAwakened ??= {}
    s79(host.state).caoshuangAwakened[ownerId] = true
    owner.awakenedSkills.push(CAOSHANG_FANSHI)
    owner.permanentlyLostSkills ??= []
    owner.permanentlyLostSkills.push(CAOSHANG_JIANZHUAN)
    host.queueSkill({ skillId: CAOSHANG_FANSHI, ownerId, step: 'choose', data: { index: 0, options: [...options] } })
    host.dispatch('SkillAwakened', { playerId: ownerId, skillId: CAOSHANG_FANSHI }, { sourceId: ownerId })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const data = prompt.data as { index: number; options: string[] }
    if (data.index >= 3 || !data.options.length) return finishFanShi(host, ownerId)
    askOption(host, CAOSHANG_FANSHI, ownerId, 'effect', ownerId, `【返势】：执行剩余选项（第${data.index + 1}/3次，X=1）`,
      data.options.map((id) => ({ id, label: id === 'discard-target' ? '令一名角色弃一张牌' : id === 'draw-self' ? '摸一张牌' : id === 'recast-self' ? '重铸一张手牌' : '弃置一张手牌' })), data, false)
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { index: number; options: string[]; option?: string; targetId?: PlayerId }
    if (resolution.step === 'effect') {
      const option = (response.payload as { optionId?: string }).optionId
      if (!option || !data.options.includes(option)) return
      if (option === 'draw-self') {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
        return continueFanShi(host, ownerId, data.index + 1, data.options)
      }
      if (option === 'discard-target') {
        const targets = living(host.state).filter((entry) => handAndEquipment(host.state, entry.id).length).map(({ id }) => id)
        if (targets.length) askTargets(host, CAOSHANG_FANSHI, ownerId, 'target', ownerId, targets, '【返势】：选择弃牌角色', { ...data, option }, 1, 1)
        else continueFanShi(host, ownerId, data.index + 1, data.options)
        return
      }
      const owner = player(host.state, ownerId)
      if (owner?.zones.hand.length) askCards(host, CAOSHANG_FANSHI, ownerId, 'self-card', ownerId, [...owner.zones.hand],
        `【返势】：${option === 'recast-self' ? '重铸' : '弃置'}一张手牌`, { ...data, option }, 1, 1)
      else continueFanShi(host, ownerId, data.index + 1, data.options)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const ids = targetId ? handAndEquipment(host.state, targetId) : []
      if (targetId && ids.length) askCards(host, CAOSHANG_FANSHI, ownerId, 'target-card', targetId, ids, '【返势】：选择弃置一张牌', { ...data, targetId }, 1, 1)
      else continueFanShi(host, ownerId, data.index + 1, data.options)
      return
    }
    if (resolution.step === 'target-card' || resolution.step === 'self-card') {
      const targetId = resolution.step === 'self-card' ? ownerId : data.targetId!
      const target = player(host.state, targetId)
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!target || !selected || !handAndEquipment(host.state, targetId).includes(selected)) return
      discard(host, targetId, [selected], CAOSHANG_FANSHI)
      if (data.option === 'recast-self') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      continueFanShi(host, ownerId, data.index + 1, data.options)
    }
  },
})

function continueFanShi(host: SkillHost, ownerId: PlayerId, index: number, options: string[]) {
  if (index < 3 && options.length && player(host.state, ownerId)?.alive)
    host.queueSkill({ skillId: CAOSHANG_FANSHI, ownerId, step: 'choose', data: { index, options } })
  else finishFanShi(host, ownerId)
}

function finishFanShi(host: SkillHost, ownerId: PlayerId) {
  const owner = player(host.state, ownerId)
  if (!owner?.alive || s79(host.state).fansiFinished?.[ownerId]) return
  s79(host.state).fansiFinished ??= {}; s79(host.state).fansiFinished[ownerId] = true
  gainMaxHp(host as never, ownerId, 2, CAOSHANG_FANSHI)
  recover(host as never, ownerId, 2, ownerId, CAOSHANG_FANSHI)
  addGrantedSkill(owner, CAOSHANG_FUDOU)
}

registerSkillRuntime({ id: CAOSHANG_FUDOU,
  triggers: [
    { event: 'DamageSettled', handle(host, _ownerId, context) {
      const targetId = context.event.targetId
      const sourceId = context.event.sourceId
      if (!targetId || !sourceId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      if (targetId === sourceId) return
      if (player(host.state, targetId)?.characterId === 'mou-caoshuang-b79') {
        s79(host.state).fudouHarmedBy ??= {}
        s79(host.state).fudouHarmedBy[sourceId] = true
      }
    } },
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      if (!payload.cardId || payload.targetIds?.length !== 1 || payload.targetIds[0] === ownerId) return
      const targetId = payload.targetIds[0]!
      const target = player(host.state, targetId)
      const color = effectiveCardColor(host.state, ownerId, payload.cardId)
      const wasHarmful = Boolean(s79(host.state).fudouHarmedBy?.[targetId])
      const valid = color === 'black' ? wasHarmful : color === 'red' && !wasHarmful
      if (valid && target?.alive) host.queueSkill({ skillId: CAOSHANG_FUDOU, ownerId, step: 'offer', data: { targetId, color } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const targetId = prompt.data.targetId as PlayerId
    if (!player(host.state, targetId)?.alive) return
    askOption(host, CAOSHANG_FUDOU, ownerId, 'invoke', ownerId, '【覆斗】：是否发动？',
      [{ id: 'yes', label: '发动覆斗' }, { id: 'no', label: '不发动' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    const owner = player(host.state, ownerId)
    const target = player(host.state, targetId)
    if (!owner?.alive || !target?.alive || ownerId === targetId) return
    if (resolution.data.color === 'black') {
      loseHp(host as never, ownerId, 1, CAOSHANG_FUDOU)
      loseHp(host as never, targetId, 1, CAOSHANG_FUDOU)
    } else {
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
    }
  },
})

registerSkillRuntime({ id: WUPU_DUANTI,
  onGameStart(host, ownerId) {
    const owner = player(host.state, ownerId)
    if (owner) { s79(host.state).wupuMaxHpCap ??= {}; s79(host.state).wupuMaxHpCap[ownerId] ??= owner.maxHp + 5 }
  },
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId) {
        const count = (context.event.payload as { cardIds?: CardId[] }).cardIds?.length ?? 1
        resolveWupuCards(host, ownerId, count)
      }
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId) {
        const count = (context.event.payload as { cardIds?: CardId[] }).cardIds?.length ?? 1
        resolveWupuCards(host, ownerId, count)
      }
    } },
  ],
})

function resolveWupuCards(host: SkillHost, ownerId: PlayerId, count: number) {
  const state = s79(host.state)
  state.wupuCardCount ??= {}
  let next = Number(state.wupuCardCount[ownerId] ?? 0) + Math.max(1, count)
  const cap = Number(state.wupuMaxHpCap?.[ownerId] ?? player(host.state, ownerId)?.maxHp ?? 0)
  while (next >= 5) {
    next -= 5
    const owner = player(host.state, ownerId)
    if (!owner?.alive) break
    if (owner.maxHp < cap) gainMaxHp(host as never, ownerId, 1, WUPU_DUANTI)
    recover(host as never, ownerId, 1, ownerId, WUPU_DUANTI)
  }
  state.wupuCardCount[ownerId] = next
}

registerSkillRuntime({ id: WUPU_SHICAO,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && player(state, ownerId)?.alive
      && s79(state).shicaoDisabled?.[ownerId] !== state.turnNumber
      ? [{ id: 'shicao:activate', label: '识草：声明牌类别并选择从牌堆顶或牌堆底摸牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'shicao:activate' || s79(host.state).shicaoDisabled?.[ownerId] === host.state.turnNumber) return
    askOption(host, WUPU_SHICAO, ownerId, 'category', ownerId, '【识草】：声明一种牌的类型', [
      { id: 'basic', label: '基本牌' }, { id: 'trick', label: '锦囊牌' }, { id: 'equipment', label: '装备牌' },
    ], {}, false)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-end') return
    askOption(host, WUPU_SHICAO, ownerId, 'choose-end', ownerId, '【识草】：选择从牌堆哪一端摸一张牌', [
      { id: 'top', label: '牌堆顶' }, { id: 'bottom', label: '牌堆底' },
    ], prompt.data, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'category') {
      const category = (response.payload as { optionId?: string }).optionId
      if (!['basic', 'trick', 'equipment'].includes(category ?? '')) return
      host.queueSkill({ skillId: WUPU_SHICAO, ownerId, step: 'choose-end', data: { category } })
      return
    }
    if (resolution.step !== 'choose-end') return
    const end = (response.payload as { optionId?: string }).optionId
    const owner = player(host.state, ownerId)
    const category = resolution.data.category as string
    if (!owner?.alive || !['top', 'bottom'].includes(end ?? '') || !['basic', 'trick', 'equipment'].includes(category)) return
    if (host.state.zones.drawPile.length === 0) reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
    const before = host.state.zones.drawPile.length
    if (!before) return
    const cardId = end === 'top' ? host.state.zones.drawPile[0]! : host.state.zones.drawPile[before - 1]!
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WUPU_SHICAO, isDraw: true },
      { targetId: ownerId, cardIds: [cardId] })
    if (host.state.cards[cardId]?.category === category) return
    s79(host.state).shicaoDisabled ??= {}
    s79(host.state).shicaoDisabled[ownerId] = host.state.turnNumber
    const revealAtOtherEnd = Math.min(2, host.state.zones.drawPile.length)
    const revealed = end === 'top'
      ? host.state.zones.drawPile.slice(-revealAtOtherEnd)
      : host.state.zones.drawPile.slice(0, revealAtOtherEnd)
    host.askSkill({ skillId: WUPU_SHICAO, ownerId, step: 'view-other-end', data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【识草】：你观看另一端的牌堆两张牌', timeoutMs: 25_000, optional: true,
        purpose: 'skill', cardIds: [], viewOnlyCardIds: revealed, hiddenCardSlots: [], min: 0, max: 0 }) })
  },
})

registerSkillRuntime({ id: GUANYUE_SHOUZHI,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      s79(host.state).guanyueStartHand ??= {}
      s79(host.state).guanyueStartHand[ownerId] = player(host.state, ownerId)?.zones.hand.length ?? 0
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const owner = player(host.state, ownerId)
      if (!owner?.alive) return
      const start = s79(host.state).guanyueStartHand?.[ownerId]
      if (!Number.isFinite(start)) return
      if (owner.zones.hand.length > Number(start) && owner.zones.hand.length) {
        askCards(host, GUANYUE_SHOUZHI, ownerId, 'discard-one', ownerId, [...owner.zones.hand],
          '【守执】：选择弃置一张手牌', {}, 1, 1)
      } else if (owner.zones.hand.length < Number(start)) drawCards(host.state, host.rng, ownerId, 2,
        (name, payload) => host.dispatch(name, payload))
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard-one') return
    const owner = player(host.state, ownerId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
    discard(host, ownerId, [cardId], GUANYUE_SHOUZHI)
    if (s79(host.state).guanyueAwakened?.[ownerId]) recover(host as never, ownerId, 1, ownerId, GUANYUE_XINGMEN)
  },
})

registerSkillRuntime({ id: GUANYUE_FENHUI,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && !owner.usedLimitedSkills.includes(GUANYUE_FENHUI)
      && living(state).some((target) => target.id !== ownerId)
      ? [{ id: 'fenhui:activate', label: '奋恚：令一名角色获得“恨”标记' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'fenhui:activate') return
    const owner = player(host.state, ownerId)
    const candidates = living(host.state).filter((target) => target.id !== ownerId).map((target) => target.id)
    if (!owner?.alive || owner.usedLimitedSkills.includes(GUANYUE_FENHUI) || !candidates.length) return
    owner.usedLimitedSkills.push(GUANYUE_FENHUI)
    askTargets(host, GUANYUE_FENHUI, ownerId, 'target', ownerId, candidates, '【奋恚】：选择一名角色', {}, 1, 1)
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const targets = (context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      s79(host.state).guanyueTargetUses ??= {}
      for (const targetId of targets) if (targetId !== ownerId)
        s79(host.state).guanyueTargetUses[targetId] = Number(s79(host.state).guanyueTargetUses[targetId] ?? 0) + 1
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      const marks = s79(host.state).guanyueHatred?.[ownerId]?.[targetId] ?? 0
      if (marks > 0) s79(host.state).guanyueHatred[ownerId][targetId] = marks - 1
    } },
    { event: 'QuitDying', handle(host, ownerId, context) { awakenGuanyue(host, ownerId, (context.event.payload as { playerId?: PlayerId }).playerId) } },
    { event: 'Death', handle(host, ownerId, context) { awakenGuanyue(host, ownerId, (context.event.payload as { playerId?: PlayerId }).playerId) } },
  ],
  globalOutgoingDamage(state, _ownerId, _sourceId, context) {
    const marks = s79(state).guanyueHatred?.[_ownerId]?.[context.targetId] ?? 0
    return marks > 0 ? { amount: context.amount + 1 } : null
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host.state, targetId) : undefined
    const count = Math.min(5, Number(s79(host.state).guanyueTargetUses?.[targetId!] ?? 0))
    if (!target?.alive || target.id === ownerId || count < 1) return
    s79(host.state).guanyueHatred ??= {}; s79(host.state).guanyueHatred[ownerId] ??= {}
    s79(host.state).guanyueHatred[ownerId][target.id] = Number(s79(host.state).guanyueHatred[ownerId][target.id] ?? 0) + count
    drawCards(host.state, host.rng, target.id, count, (name, payload) => host.dispatch(name, payload))
  },
})

function awakenGuanyue(host: SkillHost, ownerId: PlayerId, targetId?: PlayerId) {
  if (!targetId || (s79(host.state).guanyueHatred?.[ownerId]?.[targetId] ?? 0) <= 0 || s79(host.state).guanyueAwakened?.[ownerId]) return
  const target = player(host.state, targetId)
  const owner = player(host.state, ownerId)
  if (!owner || !target) return
  s79(host.state).guanyueAwakened ??= {}
  s79(host.state).guanyueAwakened[ownerId] = true
  delete s79(host.state).guanyueHatred[ownerId][targetId]
  loseMaxHp(host as never, ownerId, 1, GUANYUE_FENHUI)
  s79(host.state).nonLockedSkillOverrides ??= {}
  s79(host.state).nonLockedSkillOverrides[ownerId] = [...new Set([...(s79(host.state).nonLockedSkillOverrides[ownerId] ?? []), GUANYUE_SHOUZHI])]
  addGrantedSkill(owner, GUANYUE_XINGMEN)
}

registerSkillRuntime({ id: GUANYUE_XINGMEN,
  slashUndodgeable(state, _ownerId, _targetId, cardId) {
    return Boolean(cardId && s79(state).xingmenUnrespondable?.includes(cardId))
  },
  trickUnresponsive(state, _ownerId, _targetId, _cardName, cardId) {
    return Boolean(cardId && s79(state).xingmenUnrespondable?.includes(cardId))
  },
  triggers: [{ event: 'GainCard', handle(host, _ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; isDraw?: boolean }
    if (!payload.isDraw || !payload.playerId || (payload.cardIds?.length ?? 0) <= 1
      || !player(host.state, payload.playerId)?.grantedSkills.includes(GUANYUE_XINGMEN)) return
    s79(host.state).xingmenUnrespondable ??= []
    s79(host.state).xingmenUnrespondable.push(...(payload.cardIds ?? []).filter((id) => effectiveCardColor(host.state, payload.playerId!, id) === 'red'))
  } }, { event: 'LoseCard', handle(host, _ownerId, context) {
    const payload = context.event.payload as { cardIds?: CardId[] }
    const lost = new Set(payload.cardIds ?? [])
    s79(host.state).xingmenUnrespondable = (s79(host.state).xingmenUnrespondable ?? []).filter((id: CardId) => !lost.has(id))
  } }],
})

registerSkillRuntime({ id: SUNJIAN_RUIJUN,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || host.state.phase !== 'play' || usedThisPhase(host.state, ownerId, SUNJIAN_RUIJUN)) return
    const targetIds = ((context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []).filter((id) => id !== ownerId && player(host.state, id)?.alive)
    if (!targetIds.length) return
    markUsedThisPhase(host.state, ownerId, SUNJIAN_RUIJUN)
    host.queueSkill({ skillId: SUNJIAN_RUIJUN, ownerId, step: 'offer', data: { targetIds } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    askOption(host, SUNJIAN_RUIJUN, ownerId, 'invoke', ownerId, '【锐军】：是否摸牌并指定本阶段的目标？',
      [{ id: 'yes', label: '发动锐军' }, { id: 'no', label: '不发动' }], prompt.data)
  },
  directedDistanceTo(state, ownerId, targetId) {
    return s79(state).ruijun?.[ownerId]?.targetId === targetId ? -999 : 0
  },
  globalDistanceModifier(state, _ownerId, sourceId, targetId) {
    const record = s79(state).ruijun?.[sourceId]
    return record?.turn === state.turnNumber && record.targetId && record.targetId !== targetId ? 999 : 0
  },
  outgoingDamage(state, ownerId, context) {
    const record = s79(state).ruijun?.[ownerId]
    if (!record || record.turn !== state.turnNumber || record.targetId !== context.targetId || context.amount >= 5) return null
    record.damage = Math.min(5, Number(record.damage ?? 0) + 1)
    return { amount: Math.min(5, context.amount + Number(record.damage)) }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidates = (resolution.data.targetIds as PlayerId[]).filter((id) => player(host.state, id)?.alive)
      if (candidates.length) askTargets(host, SUNJIAN_RUIJUN, ownerId, 'target', ownerId, candidates, '【锐军】：选择其中一名角色', {}, 1, 1)
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host.state, targetId) : undefined
    const owner = player(host.state, ownerId)
    if (!target?.alive || !owner?.alive || targetId === ownerId) return
    s79(host.state).ruijun ??= {}
    s79(host.state).ruijun[ownerId] = { turn: host.state.turnNumber, targetId, damage: 0 }
    drawCards(host.state, host.rng, ownerId, owner.maxHp - owner.hp + 1, (name, payload) => host.dispatch(name, payload))
  },
})

registerSkillRuntime({ id: SIMASHI_SANSHI,
  onGameStart(host, ownerId) {
    const byRank = new Map<number, CardId[]>()
    for (const id of host.state.zones.drawPile) {
      const rank = host.state.cards[id]?.rank
      if (rank) byRank.set(rank, [...(byRank.get(rank) ?? []), id])
    }
    const selected = [...byRank.values()].map((ids) => ids[host.rng.nextInt(ids.length)]!).filter(Boolean)
    s79(host.state).sanshiCards ??= []
    s79(host.state).sanshiCards.push(...selected)
    s79(host.state).sanshiOwner ??= {}
    for (const id of selected) s79(host.state).sanshiOwner[id] = ownerId
  },
  slashUndodgeable(state, ownerId, _targetId, cardId) { return !!cardId && s79(state).sanshiOwner?.[cardId] === ownerId },
  trickUnresponsive(state, ownerId, _targetId, _cardName, cardId) { return !!cardId && s79(state).sanshiOwner?.[cardId] === ownerId },
  triggers: [
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const id = (context.event.payload as { cardId?: CardId }).cardId
      if (id && s79(host.state).sanshiOwner?.[id] === _ownerId) s79(host.state).sanshiSpent ??= [], s79(host.state).sanshiSpent.push(id)
    } },
    { event: 'CardResponded', handle(host, _ownerId, context) {
      const id = (context.event.payload as { cardId?: CardId }).cardId
      if (id && s79(host.state).sanshiOwner?.[id] === _ownerId) s79(host.state).sanshiSpent ??= [], s79(host.state).sanshiSpent.push(id)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const tagged = ((s79(host.state).sanshiCards ?? []) as CardId[]).filter((id) => s79(host.state).sanshiOwner?.[id] === ownerId)
      const used = new Set<CardId>(s79(host.state).sanshiSpent ?? [])
      const reclaim = tagged.filter((id) => !used.has(id) && host.state.zones.discardPile.includes(id))
      for (const id of reclaim) {
        moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        delete s79(host.state).sanshiOwner[id]
        s79(host.state).sanshiCards = ((s79(host.state).sanshiCards ?? []) as CardId[]).filter((cardId) => cardId !== id)
      }
      s79(host.state).sanshiSpent = []
    } },
  ],
})

registerSkillRuntime({ id: SIMASHI_CHENLUE,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && player(state, ownerId)?.alive
      && !player(state, ownerId)?.usedLimitedSkills.includes(SIMASHI_CHENLUE)
      && (s79(state).sanshiCards as CardId[] | undefined)?.some((id) => s79(state).sanshiOwner?.[id] === ownerId
        && !!locateTaggedCard(state, id) && !player(state, ownerId)?.zones.hand.includes(id))
      ? [{ id: 'chenlue:activate', label: '沉略：获得所有“死士”牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'chenlue:activate') return
    const owner = player(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(SIMASHI_CHENLUE)) return
    const ids = ((s79(host.state).sanshiCards as CardId[] | undefined) ?? []).filter((id) => s79(host.state).sanshiOwner?.[id] === ownerId)
    const moved: CardId[] = []
    for (const id of ids) {
      const from = locateTaggedCard(host.state, id)
      if (!from || (from.kind === 'hand' && from.playerId === ownerId)) continue
      if (from.kind === 'equipment') handleEquipmentLost(host as never, from.playerId, id)
      moveCard(host.state, id, from, { kind: 'hand', playerId: ownerId })
      moved.push(id)
    }
    owner.usedLimitedSkills.push(SIMASHI_CHENLUE)
    s79(host.state).chenlueCards ??= {}; s79(host.state).chenlueCards[ownerId] = [...moved]
  },
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (data.playerId !== ownerId || data.phase !== 'play') return
      for (const id of (s79(host.state).chenlueCards?.[ownerId] ?? []) as CardId[]) {
        const from = locateTaggedCard(host.state, id)
        if (!from || (from.kind === 'characterPile' && from.playerId === ownerId && from.pile === SIMASHI_CHENLUE)) continue
        if (from.kind === 'equipment') handleEquipmentLost(host as never, from.playerId, id)
        moveCard(host.state, id, from, { kind: 'characterPile', playerId: ownerId, pile: SIMASHI_CHENLUE })
      }
    } },
    { event: 'Death', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const pile = player(host.state, ownerId)?.characterPiles[SIMASHI_CHENLUE] ?? []
      for (const id of [...pile]) moveCard(host.state, id, { kind: 'characterPile', playerId: ownerId, pile: SIMASHI_CHENLUE }, { kind: 'discardPile' })
    } },
  ],
})

function locateTaggedCard(state: SanguoshaState, cardId: CardId) {
  for (const owner of state.players) {
    const zone = locateOwnedCard(state, owner.id, cardId)
    if (zone) return zone
  }
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' as const }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' as const }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' as const }
  return null
}

registerSkillRuntime({ id: SIMASHI_ZHENRAO,
  triggers: [{ event: 'TargetSpecified', handle(host, ownerId, context) {
    const payload = context.event.payload as { targetIds?: PlayerId[] }
    const sourceId = context.event.sourceId
    if (!sourceId || s79(host.state).zhenraoUsed?.[ownerId]?.[sourceId] === host.state.turnNumber) return
    const candidateIds = context.event.targetId && context.event.targetId !== sourceId
      ? [context.event.targetId] : (payload.targetIds ?? []).filter((id) => id !== sourceId)
    if (sourceId === ownerId) {
      const larger = living(host.state).filter((entry) => candidateIds.includes(entry.id) && entry.zones.hand.length > (player(host.state, ownerId)?.zones.hand.length ?? 0)).map(({ id }) => id)
      if (larger.length) host.queueSkill({ skillId: SIMASHI_ZHENRAO, ownerId, step: 'activate', data: { userId: ownerId, candidates: larger } })
    } else if ((player(host.state, sourceId)?.zones.hand.length ?? 0) > (player(host.state, ownerId)?.zones.hand.length ?? 0)) {
      host.queueSkill({ skillId: SIMASHI_ZHENRAO, ownerId, step: 'activate', data: { userId: sourceId, candidates: [sourceId] } })
    }
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'activate') return
    const data = prompt.data as { userId: PlayerId; candidates: PlayerId[] }
    if (!player(host.state, ownerId)?.alive || !data.candidates.some((id) => player(host.state, id)?.alive)) return
    askOption(host, SIMASHI_ZHENRAO, ownerId, 'invoke', ownerId, '【震扰】：是否令一名手牌多于你的角色受到1点伤害？',
      [{ id: 'yes', label: '发动震扰' }, { id: 'no', label: '不发动' }], data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const userId = (resolution.data as { userId?: PlayerId }).userId
      if (targetId && userId && player(host.state, targetId)?.alive)
        resolveDamage(host as never, { sourceId: userId, targetId, amount: 1, nature: 'normal', cardName: '震扰' })
      return
    }
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const data = resolution.data as { userId: PlayerId; candidates: PlayerId[] }
    const candidates = data.candidates.filter((id) => player(host.state, id)?.alive
      && (player(host.state, id)?.zones.hand.length ?? 0) > (player(host.state, ownerId)?.zones.hand.length ?? 0))
    if (!candidates.length) return
    s79(host.state).zhenraoUsed ??= {}; s79(host.state).zhenraoUsed[ownerId] ??= {}
    s79(host.state).zhenraoUsed[ownerId][data.userId] = host.state.turnNumber
    askTargets(host, SIMASHI_ZHENRAO, ownerId, 'target', ownerId, candidates, '【震扰】：选择受到1点伤害的角色', { userId: data.userId }, 1, 1)
  },
})

registerSkillRuntime({ id: GUANPING_WUWEI,
  activeActions(state, ownerId) {
    const allowance = s79(state).wuweiAllowance?.[ownerId]
    const record = allowance?.turn === state.turnNumber ? allowance : { turn: state.turnNumber, used: 0, bonus: 0 }
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || record.used >= 1 + record.bonus) return []
    const hand = player(state, ownerId)?.zones.hand ?? []
    const colors = new Set(hand.map((id) => effectiveCardColor(state, ownerId, id)).filter((color) => color === 'red' || color === 'black'))
    return colors.size ? [{ id: 'wuwei:activate', label: '武威：将一种颜色的所有手牌当【杀】使用' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'wuwei:activate') return
    const owner = player(host.state, ownerId)
    const allowance = s79(host.state).wuweiAllowance?.[ownerId]
    const record = allowance?.turn === host.state.turnNumber ? allowance : { turn: host.state.turnNumber, used: 0, bonus: 0 }
    if (!owner?.alive || record.used >= 1 + record.bonus) return
    const colors = [...new Set(owner.zones.hand.map((id) => effectiveCardColor(host.state, ownerId, id)).filter((color) => color === 'red' || color === 'black'))]
    if (colors.length) askOption(host, GUANPING_WUWEI, ownerId, 'color', ownerId, '【武威】：选择一种颜色的所有手牌当【杀】使用',
      colors.map((color) => ({ id: color, label: color === 'red' ? '所有红色手牌' : '所有黑色手牌' })), {}, false)
  },
  ignoresDistanceTo(state, ownerId, _targetId, cardId) {
    return Boolean(cardId && s79(state).wuweiActiveCard?.[ownerId] === cardId)
  },
  globalUnlimitedSlashWithCard(state, _ownerId, attackerId, cardId) {
    return s79(state).wuweiActiveCard?.[attackerId] === cardId
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const usedPayload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
    const cardId = usedPayload.cardId
    const pending = cardId ? s79(host.state).wuweiPending?.[cardId] : null
    if (context.event.sourceId !== ownerId || !pending || pending.ownerId !== ownerId) return
    pending.targetIds = usedPayload.targetIds ?? []
    const choices = [{ id: 'draw', label: '摸一张牌' }, { id: 'silence', label: '令目标非锁定技失效' }, { id: 'repeat', label: '本回合此技能可再发动一次' }]
      if (pending.count) askOption(host, GUANPING_WUWEI, ownerId, 'effect', ownerId, '【武威】：选择一项效果', choices, { cardId, types: pending.types }, false)
  } }, { event: 'CardResolved', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (cardId && s79(host.state).wuweiActiveCard?.[ownerId] === cardId) delete s79(host.state).wuweiActiveCard[ownerId]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'color') {
      const color = (response.payload as { optionId?: string }).optionId
      const owner = player(host.state, ownerId)
      const materials = owner?.zones.hand.filter((id) => effectiveCardColor(host.state, ownerId, id) === color) ?? []
      if ((color !== 'red' && color !== 'black') || !owner?.alive || !materials.length) return
      const allowance = s79(host.state).wuweiAllowance?.[ownerId]?.turn === host.state.turnNumber
        ? s79(host.state).wuweiAllowance[ownerId] : { turn: host.state.turnNumber, used: 0, bonus: 0 }
      if (allowance.used >= 1 + allowance.bonus) return
      allowance.used += 1
      s79(host.state).wuweiAllowance ??= {}; s79(host.state).wuweiAllowance[ownerId] = allowance
      const cardId = materials[0]!
      const types = [...new Set(materials.map((id) => host.state.cards[id]?.category).filter(Boolean))] as string[]
      s79(host.state).wuweiActiveCard ??= {}; s79(host.state).wuweiActiveCard[ownerId] = cardId
      s79(host.state).wuweiPending ??= {}
      s79(host.state).wuweiPending[cardId] = { ownerId, types, count: types.length, chosen: [], materials }
      const targets = living(host.state).filter((entry) => entry.id !== ownerId).map(({ id }) => id)
      if (targets.length) askTargets(host, GUANPING_WUWEI, ownerId, 'target', ownerId, targets, '【武威】：选择此【杀】的目标', { cardId }, 1, 1)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = (resolution.data as { cardId: CardId }).cardId
      const pending = s79(host.state).wuweiPending?.[cardId]
      if (!targetId || !player(host.state, targetId)?.alive || !player(host.state, ownerId)?.alive || !pending) return
      executeUseCardAction(host as never, ownerId, { id: `wuwei:${host.state.seq}:${cardId}`, kind: 'use-card', playerId: ownerId,
        label: '【武威】视为使用【杀】', cardIds: [...pending.materials], targetIds: [targetId], targetMin: 1, targetMax: 1,
        asCardName: '杀', sourceSkillId: GUANPING_WUWEI }, { ignoreUsageLimits: true, countSlashUsage: false })
      return
    }
    if (resolution.step === 'silence-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive) suppressSkill(host.state, {
        targetId, sourceId: ownerId, sourceSkillId: GUANPING_WUWEI, scope: 'non-locked', armedAtTurn: host.state.turnNumber,
      })
      const data = resolution.data as { cardId: CardId; types: string[] }
      const pending = s79(host.state).wuweiPending?.[data.cardId]
      if (pending?.chosen.length < pending.count) askWuweiNext(host, ownerId, data)
      return
    }
    if (resolution.step !== 'effect') return
    const option = (response.payload as { optionId?: string }).optionId
    const data = resolution.data as { cardId: CardId; types: string[] }
    const pending = s79(host.state).wuweiPending?.[data.cardId]
    if (!pending || pending.ownerId !== ownerId || !option || !['draw', 'silence', 'repeat'].includes(option)) return
    pending.chosen.push(option)
    if (option === 'draw') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    else if (option === 'repeat') {
      const allowance = s79(host.state).wuweiAllowance?.[ownerId]
      if (allowance?.turn === host.state.turnNumber) allowance.bonus += 1
    }
    else if (option === 'silence') {
      const targetIds = (pending.targetIds as PlayerId[]).filter((id) => player(host.state, id)?.alive)
      if (targetIds.length) host.askSkill({ skillId: GUANPING_WUWEI, ownerId, step: 'silence-target', data: { cardId: data.cardId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【武威】：选择令非锁定技失效的目标', timeoutMs: 25_000, optional: false, candidateIds: targetIds, min: 1, max: 1 }) })
      if (targetIds.length) return
    }
    if (pending.chosen.length < pending.count) askWuweiNext(host, ownerId, data)
  },
  outgoingDamage(state, ownerId, context) {
    const used = s79(state).wuweiPending?.[context.cardId ?? '']
    return used?.ownerId === ownerId && used.chosen?.includes('draw') && used.chosen?.includes('silence') && used.chosen?.includes('repeat')
      ? { amount: context.amount + 1 } : null
  },
})

function askWuweiNext(host: SkillHost, ownerId: PlayerId, data: { cardId: CardId; types: string[] }) {
  askOption(host, GUANPING_WUWEI, ownerId, 'effect', ownerId, '【武威】：选择下一项效果',
    [{ id: 'draw', label: '摸一张牌' }, { id: 'silence', label: '令目标非锁定技失效' }, { id: 'repeat', label: '本回合此技能可再发动一次' }], data, false)
}

registerSkillRuntime({ id: ZOUYUNSHI_YUNZHENG,
  handLimitExempt(state, ownerId, cardId) {
    return player(state, ownerId)?.characterId === 'le-zoushi-b79' && (s79(state).zhengCards as CardId[] | undefined)?.includes(cardId) === true
  },
  globallyInvalidatesSkill(state, targetId, skillId) {
    const target = player(state, targetId)
    if (!target || isLockedSkill(skillId, state, targetId)) return false
    const tagged = new Set<CardId>(s79(state).zhengCards ?? [])
    return target.zones.hand.some((id) => tagged.has(id))
      && state.players.some((owner) => owner.alive && owner.characterId === 'le-zoushi-b79' && owner.id !== targetId)
  },
  onGameStart(host, ownerId) {
    const hand = player(host.state, ownerId)?.zones.hand ?? []
    s79(host.state).zhengCards ??= []
    s79(host.state).zhengCards.push(...hand)
  },
})

registerSkillRuntime({ id: ZOUYUNSHI_HUOXIN,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId
    if (!cardId || host.state.cards[cardId]?.category === 'equipment') return
    const targets = living(host.state).filter((entry) => entry.id !== ownerId && entry.zones.hand.length).map(({ id }) => id)
    if (targets.length) host.queueSkill({ skillId: ZOUYUNSHI_HUOXIN, ownerId, step: 'target', data: { cardId, targets } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const targets = (prompt.data.targets as PlayerId[]).filter((id) => player(host.state, id)?.alive && player(host.state, id)!.zones.hand.length)
    if (targets.length) askTargets(host, ZOUYUNSHI_HUOXIN, ownerId, 'target', ownerId, targets, '【惑心】：选择展示一张手牌的角色', prompt.data, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!target?.alive || !target.zones.hand.length) return
      askCards(host, ZOUYUNSHI_HUOXIN, ownerId, 'show', target.id, [...target.zones.hand], '【惑心】：选择展示一张手牌', resolution.data, 1, 1)
      return
    }
    if (resolution.step === 'gain') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const cardId = (resolution.data as { cardId: CardId }).cardId
      const source = host.state.players.find((entry) => entry.zones.hand.includes(cardId))
      if (source && ownerId !== source.id) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: source.id }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZOUYUNSHI_HUOXIN }, { sourceId: source.id, targetId: ownerId, cardIds: [cardId] })
      }
      return
    }
    if (resolution.step !== 'show') return
    const data = resolution.data as { cardId: CardId }
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const target = cardId ? host.state.players.find((entry) => entry.zones.hand.includes(cardId)) : undefined
    if (!cardId || !target || !host.state.cards[cardId]) return
    const tagged = new Set<CardId>(s79(host.state).zhengCards ?? [])
    const matches = effectiveCardSuit(host.state, ownerId, cardId) === effectiveCardSuit(host.state, ownerId, data.cardId) || tagged.has(cardId)
    if (!tagged.has(cardId)) { tagged.add(cardId); s79(host.state).zhengCards = [...tagged] }
    if (!matches) return
    askOption(host, ZOUYUNSHI_HUOXIN, ownerId, 'gain', ownerId, '【惑心】：是否获得此牌？',
      [{ id: 'yes', label: '获得' }, { id: 'no', label: '不获得' }], { cardId }, true)
  },
})

const GUANYU_DAMAGE_NAMES = ['杀', '火杀', '雷杀', '闪电', ...DAMAGE_TRICKS] as const
registerSkillRuntime({ id: GUANYU_JUEWU,
  viewAs(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive) return []
    const acquired = new Set<CardId>(s79(state).guanyuAcquiredCards?.[ownerId] ?? [])
    const usedNames = new Set<string>(s79(state).guanyuUsedNames?.[ownerId]?.filter((item: { turn: number }) => item.turn === state.turnNumber).map((item: { name: string }) => item.name) ?? [])
    return owner.zones.hand.flatMap((cardId) => {
      if (state.cards[cardId]?.rank !== 2 && !acquired.has(cardId)) return []
      return GUANYU_DAMAGE_NAMES.filter((name) => !usedNames.has(name)).map((asCardName) => ({
        cardId, asCardName, label: `绝武：当【${asCardName}】使用`,
      }))
    })
  },
  triggers: [
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId || !context.event.sourceId || context.event.sourceId === ownerId) return
      s79(host.state).guanyuAcquiredCards ??= {}
      s79(host.state).guanyuAcquiredCards[ownerId] ??= []
      s79(host.state).guanyuAcquiredCards[ownerId].push(...(payload.cardIds ?? []))
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardName?: string; cardId?: CardId }
      if (!payload.cardName || !payload.cardId || (host.state.cards[payload.cardId]?.rank !== 2
        && !s79(host.state).guanyuAcquiredCards?.[ownerId]?.includes(payload.cardId))) return
      s79(host.state).guanyuUsedNames ??= {}; s79(host.state).guanyuUsedNames[ownerId] ??= []
      s79(host.state).guanyuUsedNames[ownerId].push({ turn: host.state.turnNumber, name: payload.cardName })
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId) return
      const lost = new Set(payload.cardIds ?? [])
      s79(host.state).guanyuAcquiredCards[ownerId] = (s79(host.state).guanyuAcquiredCards?.[ownerId] ?? []).filter((id: CardId) => !lost.has(id))
    } },
  ],
})

registerSkillRuntime({ id: GUANYU_YIXIAN,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && !owner.usedLimitedSkills.includes(GUANYU_YIXIAN)
      ? [{ id: 'yixian:activate', label: '义贤：获得场上或弃牌堆的所有装备牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'yixian:activate') return
    const owner = player(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(GUANYU_YIXIAN)) return
    askOption(host, GUANYU_YIXIAN, ownerId, 'source', ownerId, '【义贤】：选择装备牌来源',
      [{ id: 'field', label: '获得场上所有装备牌' }, { id: 'discard', label: '获得弃牌堆所有装备牌' }], {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'source') {
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode !== 'field' && mode !== 'discard') return
      const owner = player(host.state, ownerId)
      if (!owner?.alive || owner.usedLimitedSkills.includes(GUANYU_YIXIAN)) return
      owner.usedLimitedSkills.push(GUANYU_YIXIAN)
      const sources = new Map<PlayerId, number>()
      const candidates: Array<{ id: CardId; from: ReturnType<typeof locateTaggedCard> }> = mode === 'field'
        ? fieldCards(host.state).filter((entry) => entry.slot !== null && host.state.cards[entry.cardId]?.category === 'equipment')
          .map((entry) => ({ id: entry.cardId, from: locateTaggedCard(host.state, entry.cardId) }))
        : host.state.zones.discardPile.filter((id) => host.state.cards[id]?.category === 'equipment')
          .map((id) => ({ id, from: { kind: 'discardPile' as const } }))
      for (const { id, from } of candidates) {
        if (!from) continue
        const fromPlayer = from.kind === 'hand' || from.kind === 'equipment' || from.kind === 'judgingArea' ? from.playerId : null
        if (from.kind === 'equipment') handleEquipmentLost(host as never, from.playerId, id)
        moveCard(host.state, id, from, { kind: 'hand', playerId: ownerId })
        if (fromPlayer && fromPlayer !== ownerId) sources.set(fromPlayer, (sources.get(fromPlayer) ?? 0) + 1)
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [id], reason: GUANYU_YIXIAN }, { ...(fromPlayer ? { sourceId: fromPlayer } : {}), targetId: ownerId, cardIds: [id] })
      }
      const targets = [...sources.keys()].filter((id) => player(host.state, id)?.alive)
      if (targets.length) askTargets(host, GUANYU_YIXIAN, ownerId, 'aid-targets', ownerId, targets,
        '【义贤】：选择令其摸牌并回复体力的角色（可多选）', { sources: Object.fromEntries(sources) }, 0, targets.length)
      return
    }
    if (resolution.step !== 'aid-targets') return
    const sources = resolution.data.sources as Record<PlayerId, number>
    const targets = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    for (const targetId of new Set(targets)) {
      const target = player(host.state, targetId)
      if (!target?.alive || !sources[targetId]) continue
      drawCards(host.state, host.rng, targetId, sources[targetId], (name, payload) => host.dispatch(name, payload))
      recover(host as never, targetId, 1, ownerId, GUANYU_YIXIAN)
    }
  },
})

registerSkillRuntime({ id: GUANYU_WUYOU,
  globalIgnoresDistanceTo(state, ownerId, attackerId, _targetId, cardId) {
    const active = s79(state).wuyouGranted?.[attackerId]
    return Boolean(active && active.untilTurn === state.turnNumber && active.guanYuId === ownerId && active.cardId === cardId)
  },
  globalUnlimitedSlashWithCard(state, ownerId, targetId, cardId) {
    const active = s79(state).wuyouGranted?.[targetId]
    return active?.untilTurn === state.turnNumber && active.guanYuId === ownerId && active.cardId === cardId
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; phase?: string }
    const target = data.playerId ? player(host.state, data.playerId) : undefined
    if (data.phase !== 'play' || !target?.alive || !target.zones.hand.length || !player(host.state, ownerId)?.alive) return
    s79(host.state).wuyouPhase ??= {}
    const key = `${target.id}:${host.state.turnNumber}`
    if (s79(host.state).wuyouPhase[key]) return
    s79(host.state).wuyouPhase[key] = true
    host.askSkill({ skillId: GUANYU_WUYOU, ownerId, step: 'give-to-guanyu', data: { targetId: target.id }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: target.id, prompt: '【武佑】：是否交给武关羽一张手牌？', timeoutMs: 25_000,
      optional: true, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
    }) })
  } }, { event: 'LoseCard', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (!data.playerId || data.playerId === ownerId) return
    const grant = s79(host.state).wuyouGranted?.[data.playerId]
    if (grant && (data.cardIds ?? []).includes(grant.cardId)) delete s79(host.state).wuyouGranted[data.playerId]
  } }],
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { targetId: PlayerId; names?: string[]; cardName?: string }
    if (resolution.step === 'give-to-guanyu') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const target = player(host.state, data.targetId)
      if (!cardId || !target?.zones.hand.includes(cardId) || !player(host.state, ownerId)?.alive) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: ownerId })
      const names = host.rng.shuffle([...new Set(Object.values(host.state.cards)
        .filter((card) => !card.virtual && card.category !== 'equipment').map((card) => card.name))]).slice(0, 5)
      askOption(host, GUANYU_WUYOU, ownerId, 'choose-name', ownerId, '【武佑】：从五个随机牌名中选择一个', names.map((name) => ({ id: name, label: name })), { targetId: target.id, names }, false)
      return
    }
    if (resolution.step === 'choose-name') {
      const cardName = (response.payload as { optionId?: string }).optionId
      const owner = player(host.state, ownerId)
      if (!cardName || !data.names?.includes(cardName) || !owner?.alive || !owner.zones.hand.length) return
      askCards(host, GUANYU_WUYOU, ownerId, 'give-virtual', ownerId, [...owner.zones.hand], `【武佑】：选择一张手牌交给其（视为【${cardName}】）`, { ...data, cardName }, 1, 1)
      return
    }
    if (resolution.step === 'give-virtual') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId)
      const target = player(host.state, data.targetId)
      if (!cardId || !owner?.zones.hand.includes(cardId) || !target?.alive || !data.cardName) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: target.id })
      setCardAlias(host.state, cardId, data.cardName)
      s79(host.state).wuyouGranted ??= {}
      s79(host.state).wuyouGranted[target.id] = { guanYuId: ownerId, untilTurn: host.state.turnNumber, cardId }
      host.dispatch('GainCard', { playerId: target.id, cardIds: [cardId], reason: GUANYU_WUYOU }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
    }
  },
})

registerSkillRuntime({ id: ZHUPEILAN_TONGDAO,
  limited: true,
  onGameStart(host) {
    s79(host.state).tongdaoSnapshot = Object.fromEntries(host.state.players.map((entry) => [entry.id, {
      grantedSkills: [...(entry.grantedSkills ?? [])], temporaryGrantedSkills: structuredClone(entry.temporaryGrantedSkills ?? []),
      permanentlyLostSkills: [...(entry.permanentlyLostSkills ?? [])], characterSkillsDisabled: entry.characterSkillsDisabled,
      usedLimitedSkills: [...(entry.usedLimitedSkills ?? [])], awakenedSkills: [...(entry.awakenedSkills ?? [])],
      skillSuppressions: structuredClone((host.state.skillSuppressions ?? []).filter((item) => item.targetId === entry.id)),
    }]))
  },
  dyingIntercept(host, ownerId) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(ZHUPEILAN_TONGDAO)) return false
    askTargets(host, ZHUPEILAN_TONGDAO, ownerId, 'dying-target', ownerId, living(host.state).map(({ id }) => id),
      '【痛悼】：选择一名角色，将其武将技能状态还原至游戏开始时', { dying: true }, 1, 1)
    return 'pending'
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'dying-target' || host.state.dying?.playerId !== ownerId) return
    const owner = player(host.state, ownerId)
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host.state, targetId) : undefined
    if (!owner?.alive || !targetId || !target?.alive || owner.usedLimitedSkills.includes(ZHUPEILAN_TONGDAO)) {
      continueDyingRescue(host); if (!host.state.dying) host.resumeAfterDying(); return
    }
    owner.usedLimitedSkills.push(ZHUPEILAN_TONGDAO)
    const snapshot = s79(host.state).tongdaoSnapshot?.[targetId]
    if (snapshot) {
      target.grantedSkills = [...snapshot.grantedSkills]
      target.temporaryGrantedSkills = structuredClone(snapshot.temporaryGrantedSkills)
      target.permanentlyLostSkills = [...snapshot.permanentlyLostSkills]
      target.characterSkillsDisabled = snapshot.characterSkillsDisabled
      target.usedLimitedSkills = [...snapshot.usedLimitedSkills]
      target.awakenedSkills = [...snapshot.awakenedSkills]
      host.state.skillSuppressions = (host.state.skillSuppressions ?? []).filter((entry) => entry.targetId !== targetId)
      host.state.skillSuppressions.push(...structuredClone(snapshot.skillSuppressions))
    }
    if (targetId !== ownerId && owner.hp < target.hp) recover(host as never, ownerId, target.hp - owner.hp, ownerId, ZHUPEILAN_TONGDAO)
    continueDyingRescue(host)
    if (!host.state.dying) host.resumeAfterDying()
  },
})

