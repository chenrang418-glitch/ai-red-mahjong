import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { LegalAction } from '../../engine/actions'
import type { CharacterDefinition } from './types'
import { registerGroupCardDecision, startGroupCardDecision } from '../../engine/group-card-decision'
import { effectiveCardColor, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import { drawCards } from '../../engine/draw'
import { revealTopCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { discardCardsByIds } from '../../engine/discard-all'
import { beginReplacementSlashEffect, skillOtherHandCardUseActions } from '../../engine/cards/basic'
import { flipCharacter, isFaceDown } from '../../engine/character-state'
import type { ArrangeCardsRequest, ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { clearUsedThisPhase } from '../../engine/phase-usage'
import { resolveDamage } from '../../engine/damage'
import { recover } from '../../engine/recover'
import { executeUseCardAction, legalPlayActions } from '../../engine/cards/basic'
import { beginReplacementTrickEffect, DAMAGE_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { getCharacter } from './standard'
import { getDistance } from '../../engine/distance'
import { giveCards } from '../../engine/hand-transfer'
import { giveOwnedCards } from '../../engine/hand-transfer'
import { pickableCardsOf } from '../../engine/card-pick'
import { hasPickableCards, movePickedCard, resolvePickedCard } from '../../engine/card-pick'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import type { JudgmentOutcome } from '../../engine/judgment'
import { gainMaxHp, loseMaxHp } from '../../engine/hp'
import { ALL_CARD_INFO, BASIC_CARD_INFO, EQUIPMENT_CARD_INFO, TRICK_CARD_INFO } from '../ruleset-v1/card-info'

const B = '-b81'
const sid = (name: string) => `${name}${B}`
const SUNBA_JIEDANG = sid('jiedang-sunba')
const SUNBA_JIDI = sid('jidi-sunba')
const LIU_QINXIN = sid('qixin-liujin-liupei')
const LIU_JIUSI = sid('jiusi-liujin-liupei')
const XING_ZHANGZHAO_ZHONGYAN = sid('zhongyan-xing-zhangzhao')
const XING_ZHANGZHAO_JINGLUN = sid('jinglun-xing-zhangzhao')
const XING_WENCHOU_LIANZHAN = sid('lianzhan-xing-wenchou')
const XING_WENCHOU_WEIMING = sid('weiming-xing-wenchou')
const XING_DINGFENG_DANGCHEN = sid('dangchen-xing-dingfeng')
const XING_DINGFENG_JIANYU = sid('jianyu-xing-dingfeng')
const WEI_SUNQUAN_WOHENG = sid('woheng-wei-sunquan')
const WEI_SUNQUAN_YUANHUI = sid('yuhui-wei-sunquan')
const WEI_LUBU_XIAOWU = sid('xiaowu-wei-lubu')
const WEI_LUBU_BAGUAN = sid('baguan-wei-lubu')
const WEI_DONGZHUO_GUANGYONG = sid('guangyong-wei-dongzhuo')
const WEI_DONGZHUO_JUYU = sid('juyu-wei-dongzhuo')
const MOU_LIUXIE_ZHANBAN = sid('zhanban-mou-liuxie')
const MOU_LIUXIE_CHENSHENG = sid('chensheng-mou-liuxie')
const MOU_LIUXIE_TIANCHENG = sid('tiancheng-mou-liuxie')
const LE_ZHUGUOGUO_XIDI = sid('xidi-le-zhugeguo')
const LE_ZHUGUOGUO_CHENGYAN = sid('chengyan-le-zhugeguo')
const DANGCHEN_JUDGE_TAG = `${XING_DINGFENG_DANGCHEN}:judge`

type B81State = SanguoshaState & { b81?: Record<string, any> }
function b81(state: SanguoshaState): Record<string, any> { const extended = state as B81State; extended.b81 ??= {}; return extended.b81 }
function player(state: SanguoshaState, id: PlayerId) { return state.players.find((entry) => entry.id === id) }
function living(state: SanguoshaState) { return state.players.filter((entry) => entry.alive).sort((a, b) => a.seat - b.seat) }
function handEquipment(state: SanguoshaState, id: PlayerId): CardId[] {
  const owner = player(state, id)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => !!cardId)] : []
}

registerJudgmentContinuation(DANGCHEN_JUDGE_TAG, (host, judged: JudgmentOutcome, data) => {
  const count = Number(data.count)
  if (count > 0 && judged.rank % count === 0) {
    b81(host.state).dangchenRepeat ??= {}
    b81(host.state).dangchenRepeat[data.cardId as CardId] ??= {}
    b81(host.state).dangchenRepeat[data.cardId as CardId][data.targetId as PlayerId] = { cardName: data.cardName, ownerId: data.ownerId }
  }
  host.resumeCardTarget()
})

export const HISTORICAL_BATCH81_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'sun-ba-b81', name: '孙霸', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SUNBA_JIEDANG, name: '结党', description: '你的回合开始时，可令所有角色将任意张牌置于你武将牌上，因此失去牌的角色摸一张牌。进入濒死状态时、出牌阶段开始时、结束阶段，你须移去武将牌上一种类型的牌并摸等量牌。' },
    { id: SUNBA_JIDI, name: '觊嫡', locked: true, description: '锁定技，体力值或手牌数大于你的角色对你造成伤害时，其分别流失1点体力或随机弃置两张手牌。' },
  ] },
  { id: 'liu-jin-liu-pei-b81', name: '刘衿刘佩', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: LIU_QINXIN, name: '契心', description: '每回合限两次，每当你使用一张基本牌/单次摸两张牌时，你可以摸两张牌/使用一张基本牌。（此技能触发的效果除外）' },
    { id: LIU_JIUSI, name: '纠思', description: '每回合限一次，当你需要使用基本牌时，你可将你的武将牌翻面视为使用一张基本牌。' },
  ] },
  { id: 'xing-zhangzhao-b81', name: '星·张昭', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: XING_ZHANGZHAO_ZHONGYAN, name: '忠言', description: '出牌阶段限一次，你可展示牌堆顶三张牌，然后令一名角色将一张手牌交换其中一张牌。若如此做且此时这些牌颜色相同，其回复1点体力或获得场上一张牌；若其不是你，你执行另一项。' },
    { id: XING_ZHANGZHAO_JINGLUN, name: '经纶', description: '每回合限一次，你距离1以内的角色造成伤害后，你可以令其摸X张牌并对其发动“忠言”（X为其装备区牌数）。' },
  ] },
  { id: 'xing-wenchou-b81', name: '星·文丑', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: XING_WENCHOU_LIANZHAN, name: '连战', description: '当你使用伤害牌指定唯一目标时，你可以选择：多选择一个目标或令此牌额外结算一次。然后，若你对目标角色造成伤害的次数为2，你可以回复1点体力（满体力改为摸两张牌）；为0，目标角色视为对你使用同名牌。' },
    { id: XING_WENCHOU_WEIMING, name: '威名', locked: true, description: '锁定技，体力值小于你或本轮受到过你造成伤害的其他角色对你使用牌时，随机弃置一张手牌；若两项均满足，则你摸一张牌。' },
  ] },
  { id: 'xing-dingfeng-b81', name: '星·丁奉', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: XING_DINGFENG_DANGCHEN, name: '荡尘', description: '出牌阶段开始时，你可令一名其他角色交给你至少一张牌，然后你可以弃置等量张牌。若你弃牌，本阶段你使用【杀】或普通锦囊牌指定其为目标后，可以判定：若点数为X的整数倍，此牌额外结算一次（X为你以此法弃置的牌数）。' },
    { id: XING_DINGFENG_JIANYU, name: '翦羽', locked: true, description: '锁定技，其他角色于你的回合内失去装备区的牌后，你摸一张牌。' },
  ] },
  { id: 'wei-sunquan-b81', name: '威·孙权', kingdom: 'wu', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: WEI_SUNQUAN_WOHENG, name: '斡衡', description: '出牌阶段或当你受到伤害后，你可令一名其他角色摸或弃置X张牌（X为此技能本轮发动次数）。结算后，若其手牌数与你不同或X大于3，你摸两张牌且此技能本回合失效。' },
    { id: WEI_SUNQUAN_YUANHUI, name: '御麾', description: '结束阶段，选择一名其他吴势力角色；其出牌阶段开始时可选择交给你一张红色基本牌并发动一次X为1的“斡衡”。' },
  ] },
  { id: 'wei-lubu-b81', name: '威·吕布', kingdom: 'qun', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: WEI_LUBU_XIAOWU, name: '骁武', description: '出牌阶段限一次，你可弃置一张牌，然后从牌堆获得一张牌面信息中有【杀】字的牌（不计次数）。当你造成伤害后，此技能视为未发动过且本回合获得牌张数改为两张。' },
    { id: WEI_LUBU_BAGUAN, name: '霸关', description: '连招技（单目标牌+武器牌），你可以将至多X张手牌当一张【杀】使用（X为你武器牌字数），此【杀】基础伤害等于以此法转化牌数。' },
  ] },
  { id: 'wei-dongzhuo-b81', name: '威·董卓', kingdom: 'qun', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: WEI_DONGZHUO_GUANGYONG, name: '犷勇', locked: true, description: '锁定技，你使用牌指定自己为目标后，摸一张牌并加一点体力上限；你使用牌指定其他角色为目标后，获得其中一个目标一张牌，然后若你已受伤，减一点体力上限。' },
    { id: WEI_DONGZHUO_JUYU, name: '据陲', description: '连招技（装备牌+锦囊牌），选择其中一个目标：若其体力上限小于等于你，你可令其失去或回复1点体力；若大于你，你选择一种牌的类型，获得牌堆中一张此类别的牌且该角色本回合不能使用此类别的牌。' },
  ] },
  { id: 'mou-liuxie-b81', name: '谋·刘协', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: MOU_LIUXIE_ZHANBAN, name: '斩绊', description: '出牌阶段限一次，你可以摸或弃至多三张牌，然后令所有其他角色将手牌数调整至与你相同。以此法弃牌的角色摸三张牌；以此法摸牌的角色弃置三张牌；手牌数没变化的角色受到你造成的1点伤害。' },
    { id: MOU_LIUXIE_CHENSHENG, name: '沉声', description: '其他角色的回合结束时，若你和当前回合角色都不是手牌数唯一最多的角色，则你摸一张牌。' },
    { id: MOU_LIUXIE_TIANCHENG, name: '天承', description: '主公技，你发动“斩绊”时，可以选择任意群雄角色不成为“斩绊”的目标。' },
  ] },
  { id: 'le-zhugeguo-b81', name: '乐诸葛果', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: LE_ZHUGUOGUO_XIDI, name: '羲笛', locked: true, description: '锁定技，游戏开始时，你的初始手牌增加“笛”标记且不计入手牌上限。准备阶段和结束阶段，你观看牌堆顶X张牌（X为“笛”牌数且至少为1），然后以任意顺序放回牌堆顶或牌堆底。' },
    { id: LE_ZHUGUOGUO_CHENGYAN, name: '乘烟', description: '你使用【杀】或普通锦囊牌指定其他角色为目标后，可以摸一张牌并展示。若展示牌为【杀】或普通锦囊牌，将使用牌的效果改为展示牌的效果；否则再摸一张牌并将其标记为“笛”。' },
  ] },
]

const SUNBA_GROUP_TAG = `${SUNBA_JIEDANG}:simultaneous`
const SUNBA_PILE = SUNBA_JIEDANG

registerGroupCardDecision(SUNBA_GROUP_TAG, (rawHost, decision) => {
  const host = rawHost as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  for (const playerId of decision.playerIds) {
    const owner = player(host.state, playerId)
    if (!owner?.alive) continue
    const selected = [...new Set(decision.responses[playerId] ?? [])]
    const moved: CardId[] = []
    for (const cardId of selected) {
      const zone = locateOwnedCard(host.state, playerId, cardId)
      if (!zone || (zone.kind !== 'hand' && zone.kind !== 'equipment')) continue
      moveCard(host.state, cardId, zone, { kind: 'characterPile', playerId: ownerId, pile: SUNBA_PILE })
      if (zone.kind === 'equipment') handleEquipmentLost(host as never, playerId, cardId)
      moved.push(cardId)
    }
    if (moved.length) {
      host.dispatch('LoseCard', { playerId, cardIds: moved, reason: SUNBA_JIEDANG }, { sourceId: playerId, targetId: ownerId, cardIds: moved })
      drawCards(host.state, host.rng, playerId, 1, (name, payload) => host.dispatch(name, payload))
    }
  }
})

registerSkillRuntime({ id: SUNBA_JIEDANG,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId || !player(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: SUNBA_JIEDANG, ownerId, step: 'ask', data: {} })
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) host.queueSkill({ skillId: SUNBA_JIEDANG, ownerId, step: 'collect', data: {} })
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && (payload.phase === 'play' || payload.phase === 'finish'))
        host.queueSkill({ skillId: SUNBA_JIEDANG, ownerId, step: 'collect', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask') {
      host.askSkill({ skillId: SUNBA_JIEDANG, ownerId, step: 'ask', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【结党】：是否发动？所有角色可同时秘密选择任意张手牌或装备牌置于孙霸武将牌上',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step !== 'collect') return
    const pile = player(host.state, ownerId)?.characterPiles[SUNBA_PILE] ?? []
    const types = [...new Set(pile.map((id) => host.state.cards[id]?.category).filter((type): type is CardCategory => Boolean(type)))]
    if (!types.length) return
    host.askSkill({ skillId: SUNBA_JIEDANG, ownerId, step: 'type', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【结党】：选择移去一种类型的牌并摸等量张牌', timeoutMs: 25_000,
      optional: false, options: types.map((type) => ({ id: type, label: `${type}（${pile.filter((cardId) => host.state.cards[cardId]?.category === type).length}张）` })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      startGroupCardDecision(host, { id: `${SUNBA_JIEDANG}:${host.state.seq}`, tag: SUNBA_GROUP_TAG, skillId: SUNBA_JIEDANG,
        playerIds: living(host.state).map(({ id }) => id), prompt: '【结党】：可同时秘密选择任意张手牌或装备牌置于孙霸武将牌上',
        cardIdsFor: (playerId) => handEquipment(host.state, playerId), max: Object.keys(host.state.cards).length, timeoutMs: 25_000, data: { ownerId } })
      return
    }
    if (resolution.step !== 'type') return
    const type = (response.payload as { optionId?: string }).optionId
    if (!type) return
    const pile = player(host.state, ownerId)?.characterPiles[SUNBA_PILE] ?? []
    const selected = pile.filter((id) => host.state.cards[id]?.category === type)
    for (const cardId of selected) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: SUNBA_PILE }, { kind: 'discardPile' })
    drawCards(host.state, host.rng, ownerId, selected.length, (name, payload) => host.dispatch(name, payload))
  },
})

registerSkillRuntime({ id: SUNBA_JIDI,
  triggers: [
    { event: 'BeforeDamage', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || !context.event.sourceId) return
      const source = player(host.state, context.event.sourceId)
      const owner = player(host.state, ownerId)
      if (!source || !owner) return
      b81(host.state).jidiSnapshots ??= {}
      b81(host.state).jidiSnapshots[ownerId] ??= []
      b81(host.state).jidiSnapshots[ownerId].push({ sourceId: source.id, hpHigher: source.hp > owner.hp,
        handHigher: source.zones.hand.length > owner.zones.hand.length })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      if (context.event.targetId !== ownerId || !sourceId) return
      const snapshots = b81(host.state).jidiSnapshots?.[ownerId] as Array<{ sourceId: PlayerId; hpHigher: boolean; handHigher: boolean }> | undefined
      const snapshotIndex = snapshots?.findLastIndex(({ sourceId: candidate }) => candidate === sourceId) ?? -1
      if (snapshotIndex < 0) return
      const [snapshot] = snapshots!.splice(snapshotIndex, 1)
      if (Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      const source = player(host.state, sourceId)
      if (!source?.alive) return
      if (snapshot.hpHigher) loseHp(host as never, sourceId, 1, SUNBA_JIDI)
      const discarded = snapshot.handHigher ? host.rng.shuffle([...source.zones.hand]).slice(0, 2) : []
      if (discarded.length) discardCardsByIds(host as never, sourceId, discarded, SUNBA_JIDI)
    } },
  ],
})

registerSkillRuntime({ id: LIU_QINXIN,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId === LIU_QINXIN) return
      const cardName = (context.event.payload as { cardName?: string }).cardName
      if (['杀', '闪', '桃', '酒'].includes(cardName ?? '')) queueQixin(host, ownerId, 'after-basic-use')
    } },
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; reason?: string; isDraw?: boolean }
      if (payload.playerId !== ownerId || !payload.isDraw || payload.reason !== 'draw') return
      const suppressed = b81(host.state).qixinSuppression?.[ownerId]
      if (suppressed) {
        const consumed = Math.min(suppressed, payload.cardIds?.length ?? 0)
        if (consumed) b81(host.state).qixinSuppression[ownerId] = suppressed - consumed
        if (b81(host.state).qixinSuppression[ownerId] <= 0) delete b81(host.state).qixinSuppression[ownerId]
        return
      }
      if (payload.cardIds?.length !== 2) return
      queueQixin(host, ownerId, 'after-two-draw')
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'trigger') return
    if (prompt.data.kind === 'after-basic-use') {
      host.askSkill({ skillId: LIU_QINXIN, ownerId, step: 'after-basic-use', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【契心】：是否摸两张牌？', timeoutMs: 25_000, optional: true,
        options: [{ id: 'yes', label: '摸两张牌' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.data.kind !== 'after-two-draw') return
    const options = handBasicUseOptions(host.state, ownerId)
    if (options.length) host.askSkill({ skillId: LIU_QINXIN, ownerId, step: 'after-two-draw', data: { actions: options }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【契心】：是否使用一张基本牌？', timeoutMs: 25_000, optional: true,
      options: [...options.map(({ id: actionId, label }) => ({ id: actionId, label })), { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const choice = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'after-basic-use') {
      if (choice !== 'yes' || !consumeQixinUse(host.state, ownerId)) return
      b81(host.state).qixinSuppression ??= {}; b81(host.state).qixinSuppression[ownerId] = 2
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      delete b81(host.state).qixinSuppression[ownerId]
      return
    }
    if (resolution.step !== 'after-two-draw' || !choice || choice === 'no') return
    const action = (resolution.data.actions as ReturnType<typeof handBasicUseOptions>).find(({ id }) => id === choice)
    if (!action || !consumeQixinUse(host.state, ownerId)) return
    host.beginSkillCardUseFromOtherHand(ownerId, ownerId, action.cardId, LIU_QINXIN, action.id, undefined, undefined, { allowSelf: true })
  },
})

function qixinTurnUses(state: SanguoshaState, ownerId: PlayerId): number {
  const record = b81(state).qixinUses?.[ownerId]
  return record?.turn === state.turnNumber ? record.count : 0
}
function consumeQixinUse(state: SanguoshaState, ownerId: PlayerId): boolean {
  const count = qixinTurnUses(state, ownerId)
  if (count >= 2) return false
  b81(state).qixinUses ??= {}; b81(state).qixinUses[ownerId] = { turn: state.turnNumber, count: count + 1 }
  return true
}
function queueQixin(host: SkillHost, ownerId: PlayerId, kind: 'after-basic-use' | 'after-two-draw') {
  if (qixinTurnUses(host.state, ownerId) >= 2) return
  host.queueSkill({ skillId: LIU_QINXIN, ownerId, step: 'trigger', data: { kind } })
}
function handBasicUseOptions(state: SanguoshaState, ownerId: PlayerId) {
  const hand = player(state, ownerId)?.zones.hand ?? []
  return hand.flatMap((cardId) => state.cards[cardId]?.category === 'basic'
    ? skillOtherHandCardUseActions(state, ownerId, ownerId, cardId, undefined, LIU_QINXIN, undefined, { allowSelf: true })
      .map((action) => ({ id: action.id, label: action.label, cardId })) : [])
}

registerSkillRuntime({ id: LIU_JIUSI,
  virtualBasicResponse(state, ownerId, cardName) {
    return !isFaceDown(state, ownerId) && b81(state).jiusiUsed?.[ownerId] !== state.turnNumber
      && ['杀', '闪', '桃', '酒'].includes(cardName)
  },
  consumeVirtualBasicResponse(host, ownerId) {
    if (isFaceDown(host.state, ownerId) || b81(host.state).jiusiUsed?.[ownerId] === host.state.turnNumber) return
    b81(host.state).jiusiUsed ??= {}; b81(host.state).jiusiUsed[ownerId] = host.state.turnNumber
    flipCharacter(host, ownerId, LIU_JIUSI)
  },
})

registerSkillRuntime({ id: WEI_LUBU_BAGUAN,
  activeActions(state, ownerId) {
    const combo = b81(state).baguanReady?.[ownerId]
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || !player(state, ownerId)?.alive
      || combo?.turn !== state.turnNumber || handCards(state, ownerId).length === 0) return []
    return [{ id: WEI_LUBU_BAGUAN, label: `霸关：将至多${combo.maxCards}张手牌当【杀】使用` }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== WEI_LUBU_BAGUAN) return
    const combo = b81(host.state).baguanReady?.[ownerId]
    const hand = handCards(host.state, ownerId)
    if (combo?.turn !== host.state.turnNumber || !hand.length) return
    host.queueSkill({ skillId: WEI_LUBU_BAGUAN, ownerId, step: 'materials', data: { maxCards: Math.min(combo.maxCards, hand.length) } })
  },
  outgoingDamage(state, _ownerId, context) {
    const bonus = context.cardId ? b81(state).baguanDamage?.[context.cardId] : undefined
    return bonus ? { amount: context.amount + Number(bonus) } : null
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      if (b81(host.state).baguanReady) delete b81(host.state).baguanReady[ownerId]
      if (b81(host.state).baguanPrior) delete b81(host.state).baguanPrior[ownerId]
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const cardId = payload.cardId ?? context.event.cardIds?.[0]
      const card = cardId ? host.state.cards[cardId] : undefined
      const prior = b81(host.state).baguanPrior?.[ownerId]
      if (card?.category === 'equipment' && card.equipmentSlot === 'weapon' && prior?.turn === host.state.turnNumber && prior.singleTarget) {
        b81(host.state).baguanReady ??= {}
        b81(host.state).baguanReady[ownerId] = { turn: host.state.turnNumber, maxCards: Math.max(1, Array.from(card.name).length) }
      } else if (b81(host.state).baguanReady) delete b81(host.state).baguanReady[ownerId]
      b81(host.state).baguanPrior ??= {}
      b81(host.state).baguanPrior[ownerId] = {
        turn: host.state.turnNumber,
        singleTarget: Boolean(card && card.category !== 'equipment' && payload.targetIds?.length === 1),
      }
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (payload.cardId && b81(host.state).baguanDamage) delete b81(host.state).baguanDamage[payload.cardId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'materials') {
      const ids = handCards(host.state, ownerId)
      const max = Math.min(Number(prompt.data.maxCards), ids.length)
      if (!max) return
      host.askSkill({ skillId: WEI_LUBU_BAGUAN, ownerId, step: 'materials', data: { maxCards: max }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【霸关】：选择1至${max}张手牌当【杀】的材料`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: 1, max,
      }) })
      return
    }
    if (prompt.step === 'targets') askBaguangTargets(host, ownerId, prompt.data.cardIds as CardId[])
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'materials') {
      const max = Number(resolution.data.maxCards)
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      if (!selected.length || selected.length > max || selected.some((id) => !player(host.state, ownerId)?.zones.hand.includes(id))) return
      const actions = skillOtherHandCardUseActions(host.state, ownerId, ownerId, selected, '杀', WEI_LUBU_BAGUAN, undefined, { allowSelf: true })
      if (!actions.length) return
      host.queueSkill({ skillId: WEI_LUBU_BAGUAN, ownerId, step: 'targets', data: { cardIds: selected } })
      return
    }
    if (resolution.step !== 'targets') return
    const cardIds = resolution.data.cardIds as CardId[]
    const optionId = (response.payload as { optionId?: string }).optionId
    const targetIds = (resolution.data.targetOptions as Array<{ id: string; targetIds: PlayerId[] }> | undefined)
      ?.find((option) => option.id === optionId)?.targetIds
    if (!targetIds) return
    const action = skillOtherHandCardUseActions(host.state, ownerId, ownerId, cardIds, '杀', WEI_LUBU_BAGUAN, undefined, { allowSelf: true })
      .find((candidate) => candidate.targetIds.length === targetIds.length && candidate.targetIds.every((id, index) => id === targetIds[index]))
    if (!action || !cardIds.every((id) => player(host.state, ownerId)?.zones.hand.includes(id))) return
    b81(host.state).baguanDamage ??= {}
    b81(host.state).baguanDamage[cardIds[0]!] = cardIds.length - 1
    if (host.beginSkillCardUseFromOtherHand(ownerId, ownerId, cardIds, WEI_LUBU_BAGUAN, action.id, '杀', undefined, { allowSelf: true })) {
      delete b81(host.state).baguanReady?.[ownerId]
    } else delete b81(host.state).baguanDamage[cardIds[0]!]
  },
})

function handCards(state: SanguoshaState, ownerId: PlayerId): CardId[] { return [...(player(state, ownerId)?.zones.hand ?? [])] }

function askBaguangTargets(host: SkillHost, ownerId: PlayerId, cardIds: CardId[]): void {
  const actions = skillOtherHandCardUseActions(host.state, ownerId, ownerId, cardIds, '杀', WEI_LUBU_BAGUAN, undefined, { allowSelf: true })
  const targetOptions = [...new Map(actions.map((action) => [action.targetIds.join(','), action.targetIds])).entries()]
    .map(([key, targetIds], index) => ({ id: `target-${index}`, key, targetIds }))
  if (!targetOptions.length) return
  const options = targetOptions.map(({ id, targetIds }) => ({ id, label: targetIds.map((targetId) => player(host.state, targetId)?.nickname ?? '角色').join('、') }))
  host.askSkill({ skillId: WEI_LUBU_BAGUAN, ownerId, step: 'targets', data: { cardIds, targetOptions }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【霸关】：选择此【杀】的合法目标组合', timeoutMs: 25_000,
    optional: false, options,
  }) })
}

const B81_CARD_CATEGORY_BY_NAME = new Map<string, CardCategory>([
  ...BASIC_CARD_INFO.map(({ name }) => [name, 'basic' as const] as const),
  ...TRICK_CARD_INFO.map(({ name }) => [name, 'trick' as const] as const),
  ...EQUIPMENT_CARD_INFO.map(({ name }) => [name, 'equipment' as const] as const),
])

registerSkillRuntime({ id: WEI_DONGZHUO_JUYU,
  prohibitsCardUse(state, ownerId, context) {
    const restriction = b81(state).juyuBan?.[ownerId]?.[context.userId]
    if (restriction?.turn !== state.turnNumber) return false
    const category = B81_CARD_CATEGORY_BY_NAME.get(context.cardName)
      ?? context.cardIds?.map((cardId) => state.cards[cardId]?.category).find((candidate) => candidate != null)
    return category === restriction.category
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    const cardId = payload.cardId ?? context.event.cardIds?.[0]
    const card = cardId ? host.state.cards[cardId] : undefined
    const prior = b81(host.state).juyuPrior?.[ownerId]
    if (card?.category === 'trick' && prior?.turn === host.state.turnNumber && prior.equipment) {
      b81(host.state).juyuReady ??= {}
      b81(host.state).juyuReady[ownerId] = {
        turn: host.state.turnNumber, cardId, targetIds: (payload.targetIds ?? []).filter((id) => player(host.state, id)?.alive), asked: false,
      }
    } else if (b81(host.state).juyuReady) delete b81(host.state).juyuReady[ownerId]
    b81(host.state).juyuPrior ??= {}
    b81(host.state).juyuPrior[ownerId] = { turn: host.state.turnNumber, equipment: card?.category === 'equipment' }
  } }],
  interceptSourceTargetEach(host, ownerId, context) {
    const ready = b81(host.state).juyuReady?.[ownerId]
    if (context.sourceId !== ownerId || !ready || ready.turn !== host.state.turnNumber || ready.cardId !== context.cardId
      || ready.asked || !ready.targetIds.includes(context.targetId)) return false
    ready.asked = true
    const targets = ready.targetIds.filter((id: PlayerId) => player(host.state, id)?.alive)
    if (!targets.length) return false
    host.askSkill({ skillId: WEI_DONGZHUO_JUYU, ownerId, step: 'target', data: { cardId: context.cardId, targetIds: targets }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【据陲】：选择此锦囊的一名目标', timeoutMs: 25_000,
      optional: false, candidateIds: targets, min: 1, max: 1,
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = resolution.data.cardId as CardId
      const targetIds = resolution.data.targetIds as PlayerId[]
      if (!targetId || !targetIds.includes(targetId) || !player(host.state, targetId)?.alive) { host.resumeCardTarget(); return }
      const target = player(host.state, targetId)!
      const owner = player(host.state, ownerId)
      if (!owner) { host.resumeCardTarget(); return }
      if (target.maxHp <= owner.maxHp) {
        const options = [
          { id: 'lose-hp', label: '令其失去1点体力' },
          ...(target.hp < target.maxHp ? [{ id: 'recover', label: '令其回复1点体力' }] : []),
        ]
        askB81Option(host, WEI_DONGZHUO_JUYU, ownerId, 'effect-small', '【据陲】：选择对其造成体力变化', options, false,
          { cardId, targetId })
      } else {
        const categories = [...new Set(host.state.zones.drawPile.map((cardId) => host.state.cards[cardId]?.category).filter(
          (category): category is CardCategory => category === 'basic' || category === 'trick' || category === 'equipment'))]
        if (!categories.length) { host.resumeCardTarget(); return }
        askB81Option(host, WEI_DONGZHUO_JUYU, ownerId, 'category', '【据陲】：选择获得牌的类别', categories.map((category) => ({
          id: category, label: categoryLabel(category),
        })), false, { cardId, targetId })
      }
      return
    }
    if (resolution.step === 'effect-small') {
      const targetId = resolution.data.targetId as PlayerId
      if ((response.payload as { optionId?: string }).optionId === 'lose-hp') loseHp(host as never, targetId, 1, WEI_DONGZHUO_JUYU)
      else if ((response.payload as { optionId?: string }).optionId === 'recover' && player(host.state, targetId)?.hp! < player(host.state, targetId)!.maxHp)
        recover(host as never, targetId, 1, ownerId)
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'category') {
      const category = (response.payload as { optionId?: CardCategory }).optionId
      const targetId = resolution.data.targetId as PlayerId
      if (!category || !player(host.state, targetId)?.alive) { host.resumeCardTarget(); return }
      const candidates = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.category === category)
      if (!candidates.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: WEI_DONGZHUO_JUYU, ownerId, step: 'take-card', data: { targetId, category, cardIds: candidates }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【据陲】：从牌堆选择一张${categoryLabel(category)}`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'take-card') {
      const targetId = resolution.data.targetId as PlayerId
      const category = resolution.data.category as CardCategory
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !(resolution.data.cardIds as CardId[]).includes(cardId) || !host.state.zones.drawPile.includes(cardId)
        || host.state.cards[cardId]?.category !== category || !player(host.state, targetId)?.alive) { host.resumeCardTarget(); return }
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WEI_DONGZHUO_JUYU }, { targetId: ownerId, cardIds: [cardId] })
      host.state.zones.drawPile = host.rng.shuffle(host.state.zones.drawPile)
      b81(host.state).juyuBan ??= {}; b81(host.state).juyuBan[ownerId] ??= {}
      b81(host.state).juyuBan[ownerId][targetId] = { turn: host.state.turnNumber, category }
      host.resumeCardTarget()
    }
  },
})

function categoryLabel(category: CardCategory): string { return category === 'basic' ? '基本牌' : category === 'trick' ? '锦囊牌' : '装备牌' }

registerSkillRuntime({ id: XING_ZHANGZHAO_ZHONGYAN,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && player(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, XING_ZHANGZHAO_ZHONGYAN)
      && living(state).some((candidate) => candidate.zones.hand.length > 0)
      ? [{ id: XING_ZHANGZHAO_ZHONGYAN, label: '忠言：展示牌堆顶三张牌并交换' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== XING_ZHANGZHAO_ZHONGYAN || usedThisPhase(host.state, ownerId, XING_ZHANGZHAO_ZHONGYAN)) return
    markUsedThisPhase(host.state, ownerId, XING_ZHANGZHAO_ZHONGYAN)
    host.queueSkill({ skillId: XING_ZHANGZHAO_ZHONGYAN, ownerId, step: 'choose-target', data: {} })
  },
  startQueued(host, ownerId, prompt) {
    const targetId = prompt.data.targetId as PlayerId | undefined
    if (prompt.step === 'choose-target') {
      const candidates = living(host.state).filter((candidate) => candidate.zones.hand.length > 0).map(({ id }) => id)
      if (!candidates.length) return
      host.askSkill({ skillId: XING_ZHANGZHAO_ZHONGYAN, ownerId, step: 'choose-target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【忠言】：选择一名有手牌的角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step !== 'reveal' || !targetId || !player(host.state, targetId)?.zones.hand.length) return
    const revealed = revealTopCards(host.state, host.rng, 3, XING_ZHANGZHAO_ZHONGYAN, (name, data) => host.dispatch(name, data)) as CardId[]
    if (!revealed.length) return
    host.askSkill({ skillId: XING_ZHANGZHAO_ZHONGYAN, ownerId, step: 'exchange-hand', data: { targetId, revealed }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: targetId, prompt: '【忠言】：选择一张手牌用于交换（同时展示的牌见下方）', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: player(host.state, targetId)!.zones.hand, viewOnlyCardIds: revealed, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive && player(host.state, targetId)!.zones.hand.length)
        host.queueSkill({ skillId: XING_ZHANGZHAO_ZHONGYAN, ownerId, step: 'reveal', data: { targetId } })
      return
    }
    const targetId = resolution.data.targetId as PlayerId
    const revealed = resolution.data.revealed as CardId[]
    if (resolution.step === 'exchange-hand') {
      const handCardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!handCardId || !player(host.state, targetId)?.zones.hand.includes(handCardId)
        || !revealed.some((id) => host.state.zones.processingArea.includes(id))) {
        returnZhongyanCardsToTop(host.state, revealed)
        return
      }
      host.queueSkill({ skillId: XING_ZHANGZHAO_ZHONGYAN, ownerId, step: 'exchange-shown', data: { targetId, revealed, handCardId } })
      return
    }
    if (resolution.step === 'exchange-shown') {
      const handCardId = resolution.data.handCardId as CardId
      const shownCardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const target = player(host.state, targetId)
      const index = revealed.indexOf(shownCardId as CardId)
      if (!shownCardId || index < 0 || !target?.zones.hand.includes(handCardId) || !host.state.zones.processingArea.includes(shownCardId)) {
        returnZhongyanCardsToTop(host.state, revealed)
        return
      }
      const returned = revealed.map((cardId) => cardId === shownCardId ? handCardId : cardId)
      const firstColor = returned[0] ? effectiveCardColor(host.state, targetId, returned[0]) : null
      const sameColor = firstColor !== null && returned.every((cardId) => effectiveCardColor(host.state, targetId, cardId) === firstColor)
      for (let i = returned.length - 1; i >= 0; i -= 1) {
        const cardId = returned[i]!
        const from = cardId === handCardId ? { kind: 'hand' as const, playerId: targetId } : { kind: 'processingArea' as const }
        moveCard(host.state, cardId, from, { kind: 'drawPile' }, { toTop: true })
      }
      moveCard(host.state, shownCardId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [handCardId], reason: XING_ZHANGZHAO_ZHONGYAN }, { sourceId: targetId, targetId: ownerId, cardIds: [handCardId] })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [shownCardId], reason: XING_ZHANGZHAO_ZHONGYAN }, { sourceId: ownerId, targetId, cardIds: [shownCardId] })
      if (sameColor) {
        const canPick = living(host.state).some((candidate) => hasPickableCards(host.state, candidate.id, { includeJudgingArea: true }))
        const options = [
          { id: 'recover', label: '回复1点体力' },
          ...(canPick ? [{ id: 'gain', label: '获得场上一张牌' }] : []),
        ]
        askB81Option(host, XING_ZHANGZHAO_ZHONGYAN, ownerId, 'target-reward', '【忠言】：令其选择一项效果', options, false,
          { targetId, actorId: targetId })
      }
      return
    }
    if (resolution.step === 'target-reward') {
      const optionId = (response.payload as { optionId?: string }).optionId
      const actorId = resolution.data.actorId as PlayerId
      if (optionId === 'recover') {
        recover(host as never, actorId, 1, ownerId)
        if (targetId !== ownerId) queueZhongyanOwnerGain(host, ownerId)
      } else if (optionId === 'gain') queueZhongyanGainTarget(host, ownerId, actorId, targetId !== ownerId ? 'owner-recover' : 'finish')
      return
    }
    if (resolution.step === 'gain-target') {
      const pickerId = resolution.data.pickerId as PlayerId
      const purpose = resolution.data.after as string
      const victimId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!victimId || !player(host.state, victimId)?.alive) { queueZhongyanAfterGain(host, ownerId, purpose); return }
      const pickable = pickableCardsOf(host.state, victimId, { includeJudgingArea: true })
      const cardIds = pickable.cardIds
      const hiddenCardSlots = pickerId === victimId ? [] : pickable.hiddenCardSlots
      if (!cardIds.length && !hiddenCardSlots.length) { queueZhongyanAfterGain(host, ownerId, purpose); return }
      host.askSkill({ skillId: XING_ZHANGZHAO_ZHONGYAN, ownerId, step: 'gain-card', data: { pickerId, victimId, after: purpose }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: pickerId, prompt: '【忠言】：选择要获得的一张场上牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds, hiddenCardSlots, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'gain-card') {
      const pickerId = resolution.data.pickerId as PlayerId
      const victimId = resolution.data.victimId as PlayerId
      const purpose = resolution.data.after as string
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = picked && resolvePickedCard(host.state, victimId, picked)
      if (cardId) {
        const from = locateOwnedCard(host.state, victimId, cardId)
        if (from && movePickedCard(host as never, victimId, cardId, { kind: 'hand', playerId: pickerId })) {
          host.dispatch('LoseCard', { playerId: victimId, cardIds: [cardId], reason: XING_ZHANGZHAO_ZHONGYAN }, { sourceId: pickerId, targetId: victimId, cardIds: [cardId] })
          host.dispatch('GainCard', { playerId: pickerId, cardIds: [cardId], reason: XING_ZHANGZHAO_ZHONGYAN }, { sourceId: victimId, targetId: pickerId, cardIds: [cardId] })
        }
      }
      queueZhongyanAfterGain(host, ownerId, purpose)
    }
  },
})

function returnZhongyanCardsToTop(state: SanguoshaState, cardIds: readonly CardId[]): void {
  for (let index = cardIds.length - 1; index >= 0; index -= 1) {
    const cardId = cardIds[index]!
    if (state.zones.processingArea.includes(cardId)) moveCard(state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
  }
}

function queueZhongyanOwnerGain(host: SkillHost, ownerId: PlayerId): void {
  queueZhongyanGainTarget(host, ownerId, ownerId, 'finish')
}

function queueZhongyanGainTarget(host: SkillHost, ownerId: PlayerId, pickerId: PlayerId, after: string): void {
  const candidates = living(host.state).filter((candidate) => hasPickableCards(host.state, candidate.id, { includeJudgingArea: true }))
    .map(({ id }) => id)
  if (!candidates.length) return
  host.askSkill({ skillId: XING_ZHANGZHAO_ZHONGYAN, ownerId, step: 'gain-target', data: { pickerId, after }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: pickerId, prompt: '【忠言】：选择要获得牌的一名角色', timeoutMs: 25_000,
    optional: false, candidateIds: candidates, min: 1, max: 1,
  }) })
}

function queueZhongyanAfterGain(host: SkillHost, ownerId: PlayerId, purpose: string): void {
  if (purpose === 'owner-recover' && player(host.state, ownerId)?.hp! < player(host.state, ownerId)!.maxHp) recover(host as never, ownerId, 1, ownerId)
}

registerSkillRuntime({ id: XING_ZHANGZHAO_JINGLUN,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId
    if (!sourceId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0
      || b81(host.state).jinglunUsed?.[ownerId] === host.state.turnNumber
      || !player(host.state, sourceId)?.alive || !player(host.state, sourceId)?.zones.hand.length
      || (sourceId !== ownerId && getDistance(host.state, ownerId, sourceId) > 1)) return
    askB81Option(host, XING_ZHANGZHAO_JINGLUN, ownerId, 'invoke', '【经纶】：是否令伤害来源摸牌并对其发动【忠言】？', [
      { id: 'yes', label: '发动经纶' }, { id: 'no', label: '不发动' },
    ], true, { sourceId })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const sourceId = resolution.data.sourceId as PlayerId
    const source = player(host.state, sourceId)
    if (!source?.alive || b81(host.state).jinglunUsed?.[ownerId] === host.state.turnNumber
      || (sourceId !== ownerId && getDistance(host.state, ownerId, sourceId) > 1)) return
    b81(host.state).jinglunUsed ??= {}; b81(host.state).jinglunUsed[ownerId] = host.state.turnNumber
    const equipmentCount = Object.values(source.zones.equipment).filter(Boolean).length
    drawCards(host.state, host.rng, sourceId, equipmentCount, (name, data) => host.dispatch(name, data))
    host.queueSkill({ skillId: XING_ZHANGZHAO_ZHONGYAN, ownerId, step: 'reveal', data: { targetId: sourceId } })
  },
})

registerSkillRuntime({ id: XING_DINGFENG_JIANYU,
  triggers: [{ event: 'EquipmentZoneLoss', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (payload.playerId === ownerId || !payload.playerId || !payload.cardIds?.length
      || host.state.currentPlayerId !== ownerId || !player(host.state, ownerId)?.alive) return
    drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
  } }],
})

registerSkillRuntime({ id: XING_DINGFENG_DANGCHEN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId === ownerId && phase.phase === 'play') {
        b81(host.state).dangchenPlayPhase ??= {}
        b81(host.state).dangchenPlayPhase[ownerId] = context.event.seq
        host.queueSkill({ skillId: XING_DINGFENG_DANGCHEN, ownerId, step: 'choose-target', data: {} })
      }
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (cardId && b81(host.state).dangchenRepeat?.[cardId]) delete b81(host.state).dangchenRepeat[cardId]
    } },
  ],
  interceptSourceTargetEach(host, ownerId, context) {
    const active = b81(host.state).dangchen?.[ownerId]
    if (!active || active.turn !== host.state.turnNumber || active.phaseId !== b81(host.state).dangchenPlayPhase?.[ownerId]
      || active.targetId !== context.targetId
      || context.sourceId !== ownerId || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
      || !(context.cardName === '杀' || (context.category === 'trick' && !['乐不思蜀', '兵粮寸断', '闪电'].includes(context.cardName)))) return false
    host.askSkill({ skillId: XING_DINGFENG_DANGCHEN, ownerId, step: 'judge-choice',
      data: { cardId: context.cardId, targetId: context.targetId, cardName: context.cardName, count: active.count }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【荡尘】：是否判定？若点数为弃置牌数的整数倍，此牌对其额外结算一次',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '判定' }],
      }) })
    return true
  },
  repeatSlashTarget(state, ownerId, targetId, cardId) {
    const record = b81(state).dangchenRepeat?.[cardId]?.[targetId]
    return record?.ownerId === ownerId && record.cardName === '杀'
  },
  repeatTargetEffectCount(state, ownerId, targetId, cardId) {
    const record = b81(state).dangchenRepeat?.[cardId]?.[targetId]
    return record?.ownerId === ownerId && record.cardName !== '杀' ? 1 : 0
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-target') {
      const candidates = living(host.state).filter(({ id }) => id !== ownerId).map(({ id }) => id)
      if (!candidates.length) return
      host.askSkill({ skillId: XING_DINGFENG_DANGCHEN, ownerId, step: 'choose-target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【荡尘】：选择一名其他角色交给你至少一张牌', timeoutMs: 25_000,
        optional: true, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'request-give') {
      const targetId = prompt.data.targetId as PlayerId
      const cards = handEquipment(host.state, targetId)
      if (!cards.length) return
      host.askSkill({ skillId: XING_DINGFENG_DANGCHEN, ownerId, step: 'request-give', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: '【荡尘】：选择至少一张手牌或装备牌交给丁奉', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: cards.length,
      }) })
      return
    }
    if (prompt.step === 'may-discard') {
      askB81Option(host, XING_DINGFENG_DANGCHEN, ownerId, 'may-discard', `【荡尘】：是否弃置${prompt.data.count}张牌？`, [
        { id: 'yes', label: `弃置${prompt.data.count}张` }, { id: 'no', label: '不弃置' },
      ], true, prompt.data)
      return
    }
    if (prompt.step === 'discard') {
      const cards = pickableCardsOf(host.state, ownerId, { discarderId: ownerId }).cardIds
      const count = Number(prompt.data.count)
      if (cards.length < count) return
      host.askSkill({ skillId: XING_DINGFENG_DANGCHEN, ownerId, step: 'discard', data: prompt.data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【荡尘】：弃置${count}张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: count, max: count,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive)
        host.queueSkill({ skillId: XING_DINGFENG_DANGCHEN, ownerId, step: 'request-give', data: { targetId } })
      return
    }
    if (resolution.step === 'request-give') {
      const targetId = resolution.data.targetId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const given = giveOwnedCards(host as never, targetId, ownerId, ids, XING_DINGFENG_DANGCHEN)
      if (given.length) host.queueSkill({ skillId: XING_DINGFENG_DANGCHEN, ownerId, step: 'may-discard', data: { targetId, count: given.length } })
      return
    }
    if (resolution.step === 'may-discard') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const count = Number(resolution.data.count)
      if ((pickableCardsOf(host.state, ownerId, { discarderId: ownerId }).cardIds.length) < count) return
      host.queueSkill({ skillId: XING_DINGFENG_DANGCHEN, ownerId, step: 'discard', data: resolution.data })
      return
    }
    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const discarded = discardCardsByIds(host as never, ownerId, ids, XING_DINGFENG_DANGCHEN)
      if (discarded.length) {
        b81(host.state).dangchen ??= {}
        b81(host.state).dangchen[ownerId] = { turn: host.state.turnNumber,
          phaseId: b81(host.state).dangchenPlayPhase?.[ownerId], targetId, count: discarded.length }
      }
      return
    }
    if (resolution.step === 'judge-choice') {
      if ((response.payload as { optionId?: string }).optionId === 'yes')
        performJudgment(host as never, ownerId, '荡尘', { tag: DANGCHEN_JUDGE_TAG,
          data: { cardId: resolution.data.cardId, targetId: resolution.data.targetId, count: resolution.data.count,
            cardName: resolution.data.cardName, ownerId } })
      else host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({ id: MOU_LIUXIE_CHENSHENG,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const currentId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (!currentId || currentId === ownerId || !player(host.state, ownerId)?.alive) return
    const active = living(host.state)
    const maximum = Math.max(...active.map(({ zones }) => zones.hand.length))
    const uniqueLeaders = active.filter(({ zones }) => zones.hand.length === maximum)
    if (uniqueLeaders.length === 1 && (uniqueLeaders[0].id === ownerId || uniqueLeaders[0].id === currentId)) return
    drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
  } }],
})

registerSkillRuntime({ id: XING_WENCHOU_WEIMING,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || !context.event.targetId
        || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      b81(host.state).damageByOwner ??= {}
      b81(host.state).damageByOwner[ownerId] ??= {}
      b81(host.state).damageByOwner[ownerId][context.event.targetId] = host.state.roundNumber
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
    const use = context.event.payload as { targetIds?: PlayerId[] }
    if (!use.targetIds?.includes(ownerId) || context.event.sourceId === ownerId) return
    const sourceId = context.event.sourceId
    if (!sourceId) return
    const source = player(host.state, sourceId)
    const owner = player(host.state, ownerId)
    if (!source?.alive || !owner || !source.zones.hand.length) return
    const lowHp = source.hp < owner.hp
    const damagedByOwner = (b81(host.state).damageByOwner?.[ownerId]?.[sourceId] ?? -1) === host.state.roundNumber
    if (!lowHp && !damagedByOwner) return
    const discarded = host.rng.shuffle([...source.zones.hand]).slice(0, 1)
    if (discarded.length) discardCardsByIds(host as never, sourceId, discarded, XING_WENCHOU_WEIMING)
    if (lowHp && damagedByOwner && player(host.state, ownerId)?.alive)
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
  } }],
})

registerSkillRuntime({ id: XING_WENCHOU_LIANZHAN,
  interceptPlayAction(host, ownerId, action) {
    const cardId = action.cardIds[0]
    const card = host.state.cards[cardId]
    if (action.playerId !== ownerId || action.targetIds.length !== 1 || !card
      || !(action.asCardName === '杀' || (card.category === 'trick' && DAMAGE_TRICKS.has(action.asCardName)))) return false
    const extraTargets = legalPlayActions(host.state, ownerId).flatMap((candidate) =>
      candidate.kind === 'use-card' && candidate.asCardName === action.asCardName && candidate.cardIds.includes(cardId)
        ? candidate.targetIds.filter((targetId) => !action.targetIds.includes(targetId)) : [])
    host.askSkill({ skillId: XING_WENCHOU_LIANZHAN, ownerId, step: 'mode', data: { action }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【连战】：选择额外指定一名目标或令此牌额外结算一次',
      timeoutMs: 25_000, optional: true, options: [
        ...(extraTargets.length ? [{ id: 'extra-target', label: '额外指定一名目标' }] : []),
        { id: 'repeat', label: '额外结算一次' },
      ],
    }) })
    return true
  },
  repeatSlashTarget(state, ownerId, targetId, cardId) {
    const active = b81(state).lianzhan?.[ownerId]
    return active?.cardId === cardId && active.mode === 'repeat' && active.targetIds.includes(targetId)
  },
  repeatTargetEffectCount(state, ownerId, targetId, cardId) {
    const active = b81(state).lianzhan?.[ownerId]
    return active?.cardId === cardId && active.mode === 'repeat' && active.targetIds.includes(targetId)
      && active.cardName !== '杀' ? 1 : 0
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const active = b81(host.state).lianzhan?.[ownerId]
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!active || active.cardId !== cardId || context.event.sourceId !== ownerId || !context.event.targetId
        || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      active.damageCounts[context.event.targetId] = (active.damageCounts[context.event.targetId] ?? 0) + 1
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const active = b81(host.state).lianzhan?.[ownerId]
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!active || active.cardId !== cardId || context.event.sourceId !== ownerId) return
      const cardName = active.cardName as string
      for (const targetId of active.targetIds as PlayerId[]) {
        const target = player(host.state, targetId)
        if (!target?.alive) continue
        const count = Number(active.damageCounts[targetId] ?? 0)
        if (count === 2) {
          const owner = player(host.state, ownerId)
          if (owner && owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ownerId)
          else drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
        } else if (count === 0) {
          host.queueSkill({ skillId: XING_WENCHOU_LIANZHAN, ownerId, step: 'retaliate', data: { targetId, cardName } })
        }
      }
      delete b81(host.state).lianzhan[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'retaliate') {
      const targetId = prompt.data.targetId as PlayerId
      if (!player(host.state, targetId)?.alive || !player(host.state, ownerId)?.alive) return
      const cardName = prompt.data.cardName as string
      const resolutionHost = host as SkillHost
      if (cardName === '杀') resolutionHost.beginVirtualBasic({ sourceId: targetId, targetIds: [ownerId], cardName, sourceSkillId: XING_WENCHOU_LIANZHAN })
      else resolutionHost.beginVirtualTrick({ sourceId: targetId, targetId: ownerId, cardName, sourceSkillId: XING_WENCHOU_LIANZHAN })
      return
    }
    if (prompt.step === 'mode') return
    if (prompt.step === 'extra-target') {
      const action = prompt.data.action as Extract<LegalAction, { kind: 'use-card' }>
      const cardId = action.cardIds[0]
      const legalTargets = new Set(legalPlayActions(host.state, ownerId).flatMap((candidate) =>
        candidate.kind === 'use-card' && candidate.asCardName === action.asCardName && candidate.cardIds.includes(cardId)
          ? candidate.targetIds : []))
      const candidates = [...legalTargets].filter((id) => !action.targetIds.includes(id))
      if (!candidates.length) { executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true }); return }
      host.askSkill({ skillId: XING_WENCHOU_LIANZHAN, ownerId, step: 'extra-target', data: { action }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【连战】：选择额外目标', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mode') {
      const action = resolution.data.action as Extract<LegalAction, { kind: 'use-card' }>
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode === 'repeat') {
        b81(host.state).lianzhan ??= {}
        b81(host.state).lianzhan[ownerId] = { cardId: action.cardIds[0], cardName: action.asCardName,
          targetIds: [...action.targetIds], mode, damageCounts: {} }
        executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
      } else if (mode === 'extra-target') host.queueSkill({ skillId: XING_WENCHOU_LIANZHAN, ownerId, step: 'extra-target', data: { action } })
      else executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
      return
    }
    if (resolution.step === 'extra-target') {
      const action = resolution.data.action as Extract<LegalAction, { kind: 'use-card' }>
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || action.targetIds.includes(targetId)) { executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true }); return }
      b81(host.state).lianzhan ??= {}
      b81(host.state).lianzhan[ownerId] = { cardId: action.cardIds[0], cardName: action.asCardName,
        targetIds: [...action.targetIds, targetId], mode: 'extra-target', damageCounts: {} }
      executeUseCardAction(host as never, ownerId, { ...action, targetIds: [...action.targetIds, targetId],
        targetMax: Math.max(action.targetMax, action.targetIds.length + 1) }, { skipPlayInterceptors: true })
    }
  },
})

registerSkillRuntime({ id: LE_ZHUGUOGUO_XIDI,
  onGameStart(host, ownerId) {
    const hand = player(host.state, ownerId)?.zones.hand ?? []
    b81(host.state).xidiCards ??= {}
    b81(host.state).xidiCards[ownerId] = [...hand]
  },
  handLimitExempt(state, ownerId, cardId) {
    return (b81(state).xidiCards?.[ownerId] as CardId[] | undefined)?.includes(cardId) ?? false
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || (payload.phase !== 'prepare' && payload.phase !== 'finish')) return
    const marks = (b81(host.state).xidiCards?.[ownerId] as CardId[] | undefined) ?? []
    const count = Math.max(1, marks.filter((cardId) => player(host.state, ownerId)?.zones.hand.includes(cardId)).length)
    const observed = revealTopCards(host.state, host.rng, count, '羲笛', (name, data) => host.dispatch(name, data))
    if (observed.length) host.queueSkill({ skillId: LE_ZHUGUOGUO_XIDI, ownerId, step: 'arrange', data: { observed } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'arrange') return
    const observed = (prompt.data.observed as CardId[]).filter((cardId) => host.state.zones.processingArea.includes(cardId))
    if (!observed.length) return
    host.askSkill({ skillId: LE_ZHUGUOGUO_XIDI, ownerId, step: 'arrange', data: { observed }, build: (id): ArrangeCardsRequest => ({
      id, kind: 'arrange-cards', playerId: ownerId, prompt: `【羲笛】：观看${observed.length}张牌，以任意顺序置于牌堆顶或牌堆底`,
      timeoutMs: 30_000, optional: false, cardIds: observed, minTop: 0, maxTop: observed.length, allowBottom: true,
    }) })
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'arrange') return
    const observed = resolution.data.observed as CardId[]
    const { top, bottom } = response.payload as { top?: CardId[]; bottom?: CardId[] }
    const allowed = new Set(observed)
    if (!top || !bottom || top.length + bottom.length !== observed.length
      || [...top, ...bottom].some((cardId) => !allowed.has(cardId)) || new Set([...top, ...bottom]).size !== observed.length
      || observed.some((cardId) => !host.state.zones.processingArea.includes(cardId))) return
    for (const cardId of observed) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' })
    host.state.zones.drawPile = host.state.zones.drawPile.filter((cardId) => !allowed.has(cardId))
    host.state.zones.drawPile.unshift(...top)
    host.state.zones.drawPile.push(...bottom)
  },
})

registerSkillRuntime({ id: WEI_DONGZHUO_GUANGYONG,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const targets = (context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const otherTargets = targets.filter((targetId) => targetId !== ownerId && player(host.state, targetId)?.alive)
    if (targets.includes(ownerId)) {
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      gainMaxHp(host as never, ownerId, 1, WEI_DONGZHUO_GUANGYONG)
    }
    if (otherTargets.length) host.queueSkill({ skillId: WEI_DONGZHUO_GUANGYONG, ownerId, step: 'choose-target', data: { targetIds: otherTargets } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-target') {
      const candidates = (prompt.data.targetIds as PlayerId[]).filter((id) => player(host.state, id)?.alive && hasPickableCards(host.state, id))
      if (!candidates.length) return
      host.askSkill({ skillId: WEI_DONGZHUO_GUANGYONG, ownerId, step: 'choose-target', data: { targetIds: candidates }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【犷勇】：选择一名目标角色获得其一张牌', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'choose-card') {
      const targetId = prompt.data.targetId as PlayerId
      const pickable = pickableCardsOf(host.state, targetId, { includeJudgingArea: true })
      host.askSkill({ skillId: WEI_DONGZHUO_GUANGYONG, ownerId, step: 'choose-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【犷勇】：选择获得其中一张牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && hasPickableCards(host.state, targetId))
        host.queueSkill({ skillId: WEI_DONGZHUO_GUANGYONG, ownerId, step: 'choose-card', data: { targetId } })
      return
    }
    if (resolution.step !== 'choose-card') return
    const targetId = resolution.data.targetId as PlayerId
    const pick = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = pick ? resolvePickedCard(host.state, targetId, pick) : null
    const from = cardId ? locateOwnedCard(host.state, targetId, cardId) : null
    if (!cardId || !from || !movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) return
    if (from.kind === 'equipment') host.dispatch('LoseEquipment', { playerId: targetId, cardIds: [cardId], reason: WEI_DONGZHUO_GUANGYONG }, { targetId, cardIds: [cardId] })
    else host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: WEI_DONGZHUO_GUANGYONG }, { sourceId: targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WEI_DONGZHUO_GUANGYONG }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
    const owner = player(host.state, ownerId)
    if (owner && owner.hp < owner.maxHp)
      loseMaxHp(host as never, ownerId, 1, WEI_DONGZHUO_GUANGYONG)
  },
})

registerSkillRuntime({ id: WEI_LUBU_XIAOWU,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return state.currentPlayerId === ownerId && state.phase === 'play' && owner?.alive
      && !usedThisPhase(state, ownerId, WEI_LUBU_XIAOWU) && handEquipment(state, ownerId).length > 0
      && xiaowuCandidates(state).length > 0
      ? [{ id: WEI_LUBU_XIAOWU, label: '骁武：弃置一张牌并从牌堆获得牌' }] : []
  },
  invokeActive(host, ownerId) {
    if (usedThisPhase(host.state, ownerId, WEI_LUBU_XIAOWU)) return
    markUsedThisPhase(host.state, ownerId, WEI_LUBU_XIAOWU)
    host.queueSkill({ skillId: WEI_LUBU_XIAOWU, ownerId, step: 'discard', data: {} })
  },
  slashUseQuotaBypass(state, ownerId, cardId) {
    return Boolean(cardId && b81(state).xiaowuFreeCards?.[ownerId]?.[cardId] === state.turnNumber)
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
    b81(host.state).xiaowuBonus ??= {}
    b81(host.state).xiaowuBonus[ownerId] = host.state.turnNumber
    if (host.state.currentPlayerId === ownerId && host.state.phase === 'play')
      clearUsedThisPhase(host.state, ownerId, WEI_LUBU_XIAOWU)
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'discard') {
      const candidates = handEquipment(host.state, ownerId)
      if (!candidates.length || !xiaowuCandidates(host.state).length) return
      host.askSkill({ skillId: WEI_LUBU_XIAOWU, ownerId, step: 'discard', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【骁武】：弃置一张牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'gain') {
      const candidates = xiaowuCandidates(host.state)
      const targetCount = Math.min(Number(prompt.data.count), candidates.length)
      if (!targetCount) return
      host.askSkill({ skillId: WEI_LUBU_XIAOWU, ownerId, step: 'gain', data: { candidates, count: targetCount }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【骁武】：从牌堆获得${targetCount}张牌面信息含【杀】的牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: targetCount, max: targetCount,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const discarded = discardCardsByIds(host as never, ownerId, selected.filter((id) => handEquipment(host.state, ownerId).includes(id)), WEI_LUBU_XIAOWU)
      if (!discarded.length) return
      const count = b81(host.state).xiaowuBonus?.[ownerId] === host.state.turnNumber ? 2 : 1
      host.queueSkill({ skillId: WEI_LUBU_XIAOWU, ownerId, step: 'gain', data: { count } })
      return
    }
    if (resolution.step !== 'gain') return
    const validPool = new Set((resolution.data.candidates as CardId[]).filter((id) => host.state.zones.drawPile.includes(id)))
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const cards = selected.filter((id) => validPool.has(id))
    if (cards.length !== Number(resolution.data.count)) return
    for (const cardId of cards) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    b81(host.state).xiaowuFreeCards ??= {}
    b81(host.state).xiaowuFreeCards[ownerId] ??= {}
    for (const cardId of cards) b81(host.state).xiaowuFreeCards[ownerId][cardId] = host.state.turnNumber
    host.dispatch('GainCard', { playerId: ownerId, cardIds: cards, reason: WEI_LUBU_XIAOWU }, { targetId: ownerId, cardIds: cards })
  },
})

function xiaowuCandidates(state: SanguoshaState): CardId[] {
  const namesWithSlashText = new Set(ALL_CARD_INFO.filter(({ description }) => /【杀】|〖杀〗/.test(description)).map(({ name }) => name))
  return state.zones.drawPile.filter((cardId) => namesWithSlashText.has(state.cards[cardId]?.name ?? ''))
}

registerSkillRuntime({ id: MOU_LIUXIE_ZHANBAN,
  activeActions(state, ownerId) {
    return usedThisPhase(state, ownerId, MOU_LIUXIE_ZHANBAN) ? [] : [{ id: MOU_LIUXIE_ZHANBAN, label: '斩绊' }]
  },
  invokeActive(host, ownerId) {
    if (usedThisPhase(host.state, ownerId, MOU_LIUXIE_ZHANBAN)) return
    markUsedThisPhase(host.state, ownerId, MOU_LIUXIE_ZHANBAN)
    host.queueSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'mode', data: {} })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'next-target') {
      queueNextZhanbanTarget(host, ownerId, Number(prompt.data.index) || 0)
      return
    }
    if (prompt.step === 'mode') {
      host.askSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'mode', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【斩绊】：选择摸牌或弃牌（至多三张）', timeoutMs: 25_000, optional: false,
        options: [{ id: 'draw', label: '摸牌' }, { id: 'discard', label: '弃牌' }],
      }) })
      return
    }
    if (prompt.step === 'count') {
      const max = prompt.data.mode === 'discard' ? Math.min(3, player(host.state, ownerId)?.zones.hand.length ?? 0) : 3
      host.askSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'count', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【斩绊】：选择${prompt.data.mode === 'draw' ? '摸' : '弃'}牌数`, timeoutMs: 25_000, optional: false,
        options: Array.from({ length: max + 1 }, (_, n) => ({ id: String(n), label: `${n}张` })),
      }) })
      return
    }
    if (prompt.step === 'own-discard') {
      const count = Number(prompt.data.count)
      const hand = player(host.state, ownerId)?.zones.hand ?? []
      host.askSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'own-discard', data: prompt.data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【斩绊】：选择弃置的手牌', timeoutMs: 25_000, optional: false,
        purpose: 'skill', cardIds: hand, hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (prompt.step === 'exclude-qun') {
      const characterId = player(host.state, ownerId)?.characterId
      const candidates = living(host.state).filter(({ id }) => id !== ownerId
        && getCharacter(player(host.state, id)?.characterId ?? '')?.kingdom === 'qun').map(({ id }) => id)
      const hasLordSkill = player(host.state, ownerId)?.identity === 'lord' && !!characterId
        && getCharacter(characterId)?.skills.some(({ id }) => id === MOU_LIUXIE_TIANCHENG)
      if (!hasLordSkill || !candidates.length) {
        const targets = living(host.state).filter(({ id }) => id !== ownerId).map(({ id }) => id)
        b81(host.state).zhanbanTargets ??= {}
        b81(host.state).zhanbanTargets[ownerId] = targets
        queueNextZhanbanTarget(host, ownerId, 0)
        return
      }
      const request = { id: '', kind: 'choose-targets' as const, playerId: ownerId, prompt: '【天承】：选择不成为“斩绊”目标的群雄角色',
        timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 0, max: candidates.length }
      host.askSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'exclude-qun', data: prompt.data,
        build: (id): ChooseTargetsRequest => ({ ...request, id }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode !== 'draw' && mode !== 'discard') return
      host.queueSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'count', data: { mode } })
      return
    }
    if (resolution.step === 'count') {
      const count = Number((response.payload as { optionId?: string }).optionId)
      const mode = resolution.data.mode as 'draw' | 'discard'
      if (![0, 1, 2, 3].includes(count)) return
      if (mode === 'draw') drawCards(host.state, host.rng, ownerId, count, (name, data) => host.dispatch(name, data))
      if (mode === 'discard' && count) {
        const hand = player(host.state, ownerId)?.zones.hand ?? []
        if (!hand.length) return
        host.queueSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'own-discard', data: { count: Math.min(count, hand.length) } })
      } else host.queueSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'exclude-qun', data: {} })
      return
    }
    if (resolution.step === 'own-discard') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = selected.filter((cardId) => player(host.state, ownerId)?.zones.hand.includes(cardId))
      discardCardsByIds(host as never, ownerId, valid, MOU_LIUXIE_ZHANBAN)
      host.queueSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'exclude-qun', data: {} })
      return
    }
    if (resolution.step === 'exclude-qun') {
      const excluded = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const targets = living(host.state).filter(({ id }) => id !== ownerId && !excluded.includes(id)).map(({ id }) => id)
      b81(host.state).zhanbanTargets ??= {}
      b81(host.state).zhanbanTargets[ownerId] = targets
      queueNextZhanbanTarget(host, ownerId, 0)
      return
    }
    if (resolution.step === 'target-more-discard') {
      const targetId = resolution.data.targetId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const hand = player(host.state, targetId)?.zones.hand ?? []
      discardCardsByIds(host as never, targetId, ids.filter((cardId) => hand.includes(cardId)), MOU_LIUXIE_ZHANBAN)
      drawCards(host.state, host.rng, targetId, 3, (name, data) => host.dispatch(name, data))
      queueNextZhanbanTarget(host, ownerId, Number(resolution.data.index) + 1)
      return
    }
    if (resolution.step === 'target-less-discard') {
      const targetId = resolution.data.targetId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const hand = player(host.state, targetId)?.zones.hand ?? []
      discardCardsByIds(host as never, targetId, ids.filter((cardId) => hand.includes(cardId)), MOU_LIUXIE_ZHANBAN)
      queueNextZhanbanTarget(host, ownerId, Number(resolution.data.index) + 1)
    }
  },
})

function queueNextZhanbanTarget(host: SkillHost, ownerId: PlayerId, index: number): void {
  const targets = b81(host.state).zhanbanTargets?.[ownerId] as PlayerId[] | undefined
  while (targets && index < targets.length && !player(host.state, targets[index])?.alive) index += 1
  if (!targets || index >= targets.length) { if (b81(host.state).zhanbanTargets) delete b81(host.state).zhanbanTargets[ownerId]; return }
  const targetId = targets[index]
  const ownerCount = player(host.state, ownerId)?.zones.hand.length ?? 0
  const target = player(host.state, targetId)
  if (!target) { queueNextZhanbanTarget(host, ownerId, index + 1); return }
  const difference = target.zones.hand.length - ownerCount
  if (difference === 0) {
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '斩绊' })
    host.queueSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'next-target', data: { index: index + 1 } })
    return
  }
  if (difference > 0) {
    const ids = [...target.zones.hand]
    host.askSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'target-more-discard', data: { targetId, index }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: targetId, prompt: '【斩绊】：弃置手牌至与刘协相同', timeoutMs: 25_000, optional: false,
      purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: difference, max: difference,
    }) })
    return
  }
  drawCards(host.state, host.rng, targetId, -difference, (name, data) => host.dispatch(name, data))
  const count = Math.min(3, player(host.state, targetId)?.zones.hand.length ?? 0)
  if (!count) { queueNextZhanbanTarget(host, ownerId, index + 1); return }
  const ids = [...(player(host.state, targetId)?.zones.hand ?? [])]
  host.askSkill({ skillId: MOU_LIUXIE_ZHANBAN, ownerId, step: 'target-less-discard', data: { targetId, index }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: targetId, prompt: '【斩绊】：弃置三张牌（不足则全弃）', timeoutMs: 25_000, optional: false,
    purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: count, max: count,
  }) })
}

registerSkillRuntime({ id: MOU_LIUXIE_TIANCHENG, lord: true })

registerSkillRuntime({ id: WEI_SUNQUAN_WOHENG,
  activeActions(state, ownerId) {
    return b81(state).wohengDisabled?.[ownerId] === state.turnNumber
      ? [] : [{ id: WEI_SUNQUAN_WOHENG, label: '斡衡' }]
  },
  invokeActive(host, ownerId) { beginWoheng(host, ownerId) },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId, context) {
      const round = (context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber
      b81(host.state).wohengUses ??= {}
      b81(host.state).wohengUses[ownerId] = { round, count: 0 }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0
        || b81(host.state).wohengDisabled?.[ownerId] === host.state.turnNumber) return
      host.queueSkill({ skillId: WEI_SUNQUAN_WOHENG, ownerId, step: 'trigger-choice', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'trigger-choice') {
      askB81Option(host, WEI_SUNQUAN_WOHENG, ownerId, 'trigger-choice', '受到伤害后是否发动【斡衡】？', [
        { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
      ], true)
      return
    }
    if (prompt.step === 'target') {
      const candidates = living(host.state).filter(({ id }) => id !== ownerId).map(({ id }) => id)
      if (!candidates.length) return
      host.askSkill({ skillId: WEI_SUNQUAN_WOHENG, ownerId, step: 'target', data: prompt.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【斡衡】：选择一名其他角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'mode') {
      askB81Option(host, WEI_SUNQUAN_WOHENG, ownerId, 'mode', `【斡衡】：令其摸或弃置${prompt.data.count}张牌`, [
        { id: 'draw', label: `摸${prompt.data.count}张` }, { id: 'discard', label: `弃置${prompt.data.count}张` },
      ], false, prompt.data)
      return
    }
    if (prompt.step === 'discard') {
      const targetId = prompt.data.targetId as PlayerId
      const hand = player(host.state, targetId)?.zones.hand ?? []
      const count = Math.min(Number(prompt.data.count), hand.length)
      if (!count) { finishWoheng(host, ownerId, targetId, Number(prompt.data.count)); return }
      host.askSkill({ skillId: WEI_SUNQUAN_WOHENG, ownerId, step: 'discard', data: prompt.data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: '【斡衡】：选择弃置的手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...hand], hiddenCardSlots: [], min: count, max: count,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'trigger-choice') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') beginWoheng(host, ownerId)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive) {
        const forcedCount = Number(resolution.data.countOverride)
        const count = Number.isInteger(forcedCount) && forcedCount > 0 ? forcedCount : consumeWohengUse(host.state, ownerId)
        queueWohengMode(host, ownerId, targetId, count)
      }
      return
    }
    if (resolution.step === 'mode') {
      const targetId = resolution.data.targetId as PlayerId
      const mode = (response.payload as { optionId?: string }).optionId
      const count = Number(resolution.data.count)
      if (!player(host.state, targetId)?.alive) return
      if (mode === 'draw') {
        drawCards(host.state, host.rng, targetId, count, (name, data) => host.dispatch(name, data))
        finishWoheng(host, ownerId, targetId, count)
      } else if (mode === 'discard') host.queueSkill({ skillId: WEI_SUNQUAN_WOHENG, ownerId, step: 'discard', data: { targetId, count } })
      return
    }
    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const hand = player(host.state, targetId)?.zones.hand ?? []
      discardCardsByIds(host as never, targetId, ids.filter((id) => hand.includes(id)), WEI_SUNQUAN_WOHENG)
      finishWoheng(host, ownerId, targetId, Number(resolution.data.count))
    }
  },
})

registerSkillRuntime({ id: WEI_SUNQUAN_YUANHUI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId === ownerId && payload.phase === 'finish') {
      host.queueSkill({ skillId: WEI_SUNQUAN_YUANHUI, ownerId, step: 'choose-wu', data: {} })
      return
    }
    if (payload.phase !== 'play' || !payload.playerId || payload.playerId === ownerId) return
    const assigned = b81(host.state).yuhuiTarget?.[payload.playerId] as PlayerId | PlayerId[] | undefined
    const designated = Array.isArray(assigned) ? assigned : assigned ? [assigned] : []
    if (!designated.includes(ownerId)) return
    const remaining = designated.filter((id) => id !== ownerId)
    if (remaining.length) b81(host.state).yuhuiTarget[payload.playerId] = remaining
    else delete b81(host.state).yuhuiTarget[payload.playerId]
    if (b81(host.state).wohengDisabled?.[ownerId] === host.state.turnNumber) return
    const redBasics = (player(host.state, payload.playerId)?.zones.hand ?? []).filter((cardId) =>
      host.state.cards[cardId]?.category === 'basic' && effectiveCardColor(host.state, payload.playerId!, cardId) === 'red')
    if (redBasics.length) host.queueSkill({ skillId: WEI_SUNQUAN_YUANHUI, ownerId, step: 'offer', data: { targetId: payload.playerId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-wu') {
      const candidates = living(host.state).filter(({ id }) => id !== ownerId
        && getCharacter(player(host.state, id)?.characterId ?? '')?.kingdom === 'wu').map(({ id }) => id)
      if (!candidates.length) return
      host.askSkill({ skillId: WEI_SUNQUAN_YUANHUI, ownerId, step: 'choose-wu', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【御麾】：选择一名其他吴势力角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    const targetId = prompt.data.targetId as PlayerId
    if (prompt.step === 'offer') {
      askB81Option(host, WEI_SUNQUAN_YUANHUI, ownerId, 'offer', '【御麾】：是否交给孙权一张红色基本牌并发动【斡衡】？', [
        { id: 'yes', label: '交牌并发动' }, { id: 'no', label: '不发动' },
      ], true, { targetId })
      return
    }
    if (prompt.step === 'give-card') {
      if (b81(host.state).wohengDisabled?.[ownerId] === host.state.turnNumber) return
      const basics = (player(host.state, targetId)?.zones.hand ?? []).filter((cardId) => host.state.cards[cardId]?.category === 'basic'
        && effectiveCardColor(host.state, targetId, cardId) === 'red')
      if (!basics.length) return
      host.askSkill({ skillId: WEI_SUNQUAN_YUANHUI, ownerId, step: 'give-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: '【御麾】：选择交给孙权的一张红色基本牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: basics, hiddenCardSlots: [], min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-wu') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive) {
        b81(host.state).yuhuiTarget ??= {}
        const existing = b81(host.state).yuhuiTarget[targetId]
        const assigned = Array.isArray(existing) ? existing as PlayerId[] : existing ? [existing as PlayerId] : []
        if (!assigned.includes(ownerId)) assigned.push(ownerId)
        b81(host.state).yuhuiTarget[targetId] = assigned
      }
      return
    }
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId === 'yes'
        && b81(host.state).wohengDisabled?.[ownerId] !== host.state.turnNumber)
        host.queueSkill({ skillId: WEI_SUNQUAN_YUANHUI, ownerId, step: 'give-card', data: resolution.data })
      return
    }
    if (resolution.step === 'give-card') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const valid = player(host.state, targetId)?.zones.hand.includes(cardId as CardId)
        && host.state.cards[cardId as CardId]?.category === 'basic'
        && effectiveCardColor(host.state, targetId, cardId as CardId) === 'red'
        && b81(host.state).wohengDisabled?.[ownerId] !== host.state.turnNumber
      if (!valid) return
      giveCards(host as never, targetId, ownerId, [cardId as CardId], WEI_SUNQUAN_YUANHUI)
      host.queueSkill({ skillId: WEI_SUNQUAN_WOHENG, ownerId, step: 'target', data: { countOverride: 1 } })
    }
  },
})

function beginWoheng(host: SkillHost, ownerId: PlayerId): void {
  const candidates = living(host.state).filter(({ id }) => id !== ownerId)
  if (!candidates.length || b81(host.state).wohengDisabled?.[ownerId] === host.state.turnNumber) return
  host.queueSkill({ skillId: WEI_SUNQUAN_WOHENG, ownerId, step: 'target', data: {} })
}

function consumeWohengUse(state: SanguoshaState, ownerId: PlayerId): number {
  const prior = b81(state).wohengUses?.[ownerId]
  const count = prior?.round === state.roundNumber ? prior.count + 1 : 1
  b81(state).wohengUses ??= {}
  b81(state).wohengUses[ownerId] = { round: state.roundNumber, count }
  return count
}

function queueWohengMode(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, count: number): void {
  host.queueSkill({ skillId: WEI_SUNQUAN_WOHENG, ownerId, step: 'mode', data: { targetId, count } })
}

function finishWoheng(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, count: number): void {
  const owner = player(host.state, ownerId)
  const target = player(host.state, targetId)
  if (!owner?.alive || !target) return
  if (target.zones.hand.length !== owner.zones.hand.length || count > 3) {
    drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
    b81(host.state).wohengDisabled ??= {}
    b81(host.state).wohengDisabled[ownerId] = host.state.turnNumber
  }
}

registerSkillRuntime({ id: LE_ZHUGUOGUO_CHENGYAN,
  interceptSourceTarget(host, ownerId, context) {
    const resolution = host.state.cardResolution
    const source = player(host.state, ownerId)
    const isReplaceable = context.cardName === '杀'
      || (context.category === 'trick' && INSTANT_TRICKS.has(context.cardName))
    const allTargets = host.state.cardUseTargets?.find((entry) => entry.cardId === context.cardId)?.targetIds
      ?? (resolution?.kind === 'trick' ? resolution.targetIds
        : resolution?.kind === 'slash' ? [resolution.targetId, ...resolution.remainingTargetIds] : [])
    if (!source?.alive || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
      || context.sourceId !== ownerId || !allTargets.some((targetId) => targetId !== ownerId) || !isReplaceable
      || !resolution || resolution.cardId !== context.cardId || resolution.sourceId !== ownerId) return false
    const asked = b81(host.state).chengyanAsked ??= {}
    if (asked[context.cardId]) return false
    asked[context.cardId] = true
    host.askSkill({ skillId: LE_ZHUGUOGUO_CHENGYAN, ownerId, step: 'invoke', data: {
      cardId: context.cardId, cardName: context.cardName,
    }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【乘烟】：是否摸一张牌并展示？',
      timeoutMs: 25_000, optional: true,
      options: [{ id: 'invoke', label: '发动' }, { id: 'decline', label: '不发动' }],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const cardId = resolution.data.cardId as CardId
    const original = host.state.cardResolution
    if (!original || original.cardId !== cardId || original.sourceId !== ownerId) return
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'invoke') {
        host.resumeCardTarget()
        return
      }
      const drawn = drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      const shownId = drawn[0]
      const shown = shownId ? host.state.cards[shownId] : undefined
      if (!shownId || !shown) { host.resumeCardTarget(); return }
      host.dispatch('CardMove', { playerId: ownerId, cardIds: [shownId], reason: LE_ZHUGUOGUO_CHENGYAN,
        revealed: true, revealedCardName: shown.name }, { sourceId: ownerId, cardIds: [shownId] })
      if (shown.name === '杀') {
        if (!beginReplacementSlashEffect(host as never, original, shown.damageNature ?? 'normal')) host.resumeCardTarget()
        return
      }
      if (shown.category === 'trick' && INSTANT_TRICKS.has(shown.name)) {
        if (!beginReplacementTrickEffect(host as never, original, shown.name)) host.resumeCardTarget()
        return
      }
      // 无懈可击没有可在此时机执行的目标牌效：保留原牌效，也不进入失败补摸分支。
      if (shown.name === '无懈可击') {
        host.resumeCardTarget()
        return
      }
      const additional = drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      if (additional[0]) {
        b81(host.state).xidiCards ??= {}
        const marks = (b81(host.state).xidiCards[ownerId] ??= []) as CardId[]
        if (!marks.includes(additional[0])) marks.push(additional[0])
      }
      host.resumeCardTarget()
    }
  },
})

function askB81Option(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  options: Array<{ id: string; label: string }>, optional = true, data: Record<string, unknown> = {}): void {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option',
    playerId: ownerId, prompt, timeoutMs: 25_000, optional, options }) })
}

