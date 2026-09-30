import type { CharacterDefinition } from './types'
import type { CardId, PhysicalCard, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import { effectiveCardColor, isCardProtectedFromDiscard, isCardResponseProhibited, isCardUseProhibited, isTargetProhibited, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { queueExtraTurn } from '../../engine/turn'
import type { ArrangeCardsRequest, ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { LegalAction } from '../../engine/actions'
import { gainMaxHp, loseHp, loseMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { suppressSkill } from '../../engine/skill-suppression'
import { redirectCurrentCardTarget } from '../../engine/target-cancellation'
import { discardCardsByIds } from '../../engine/discard-all'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { continueDyingAfterSkill, resolveDamageSequence } from '../../engine/damage'
import { DELAYED_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { discardAllCards } from '../../engine/discard-all'
import { reshuffleDrawPile } from '../../engine/deck'
import { skillIdsOf } from './standard'
import { completeVirtualBasicResponse, executeUseCardAction, legalPlayActions } from '../../engine/cards/basic'
import { hiddenHandSlot } from '../../engine/cards/host'
import { completeVirtualTrickBasicResponse } from '../../engine/cards/tricks'

const B55 = ':b55'
const sid = (id: string) => `${id}${B55}`
const XJ_XIONGJIN = sid('xiongjin-star-dongzhuo')
const XJ_ZHENBIAN = sid('zhenbian-star-dongzhuo')
const XJ_BAOXI = sid('baoxi-star-dongzhuo')
const DZ_MIAOLUE = sid('miaolue-shi-dongzhao')
const DZ_YINGJIA = sid('yingjia-shi-dongzhao')
const WJ_ZUJIN = sid('zujin-wangjing')
const WJ_JIEJIAN = sid('jiejian-wangjing')
const YZ_YANCE = sid('yance-you-zhuge-liang')
const YZ_FANGQIU = sid('fangqiu-you-zhuge-liang')
const YZ_GONGLI = sid('gongli-you-zhuge-liang')
const YP_MANJUAN = sid('manjuan-you-pangtong')
const YP_YANGMING = sid('yangming-you-pangtong')
const YP_GONGLI = sid('gongli-you-pangtong')
const YX_XIAXING = sid('xiaxing-you-xushu')
const YX_QIHUI = sid('qihui-you-xushu')
const YX_GONGLI = sid('gongli-you-xushu')
const GH_JINGCE = sid('jingce-mou-guohuai')
const LG_GUANSHA = sid('guansha-lougui')
const LG_JIYU = sid('jiyu-lougui')
const YJ_FUJI = sid('fuji-shi-yuji')
const YJ_DAOZHUAN = sid('daozhuan-shi-yuji')
const ZB_CHENGXIONG = sid('chengxiong-zhangbu')
const ZB_WANGZHUAN = sid('wangzhuan-zhangbu')

type B55State = SanguoshaState & {
  b55ZhenbianMarks?: Record<PlayerId, number[]>
  b55BaoxiTurn?: Record<PlayerId, { turn: number; basic: number; nonBasic: number }>
  b55ZujinNames?: Record<PlayerId, { turn: number; names: string[] }>
  b55DongzhaoUses?: Record<PlayerId, { turn: number; trickNames: string[] }>
  b55YingjiaDraw?: Record<PlayerId, number>
  b55UsedCards?: CardId[]
  b55ZhenbianSuits?: Record<PlayerId, Array<'spade' | 'heart' | 'club' | 'diamond'>>
  b55Jiejian?: Record<PlayerId, { ownerId: PlayerId; hp: number }>
  b55JiejianUsed?: Record<PlayerId, number>
  b55XiongjinUsed?: Record<PlayerId, { ownRound: number; othersRound: number }>
  b55XiongjinPending?: Record<PlayerId, { ownerId: PlayerId; turn: number; category: 'basic' | 'non-basic' }>
  b55BaoxiUsed?: Record<PlayerId, { basicRound: number; nonBasicRound: number }>
  b55MiaolueCards?: Record<PlayerId, CardId[]>
  b55ZhangbuUses?: Record<PlayerId, { turn: number; count: number }>
  b55QihuiOrder?: Record<PlayerId, Array<'basic' | 'trick' | 'equipment'>>
  b55QihuiNextUse?: PlayerId[]
  b55JingcePredictions?: Record<CardId, { ownerId: PlayerId; predictedId: PlayerId | null; position: number; obtained: boolean }>
  b55Jiyu?: Record<PlayerId, { turn: number; uses: number; gained: CardId[]; used: CardId[] }>
  b55GuanshaBonus?: Record<PlayerId, { turn: number; names: string[] }>
  b55ManjuanUses?: Record<PlayerId, { round: number; uses: number }>
  b55YanceForecast?: Record<PlayerId, { round: number; count: number; mode: 'category' | 'color'; value: string; verified: number; correct: number; draws: number; revealed: boolean }>
  b55YanceCount?: Record<PlayerId, number>
  b55YanceUsedRound?: Record<PlayerId, number>
  b55YancePendingStart?: Record<PlayerId, { round: number; mode: 'category' | 'color'; value: string }>
  b55YangmingTurn?: Record<PlayerId, { turn: number; handLosses: number; discardSuits: Suit[] }>
  b55YangmingRun?: Record<PlayerId, { turn: number; usedSuits: Suit[] }>
  b55XuanjianSuit?: Record<PlayerId, Suit>
  b55FujiCards?: Record<CardId, { ownerId: PlayerId; recipientId: PlayerId; suit: Suit }>
  b55FujiEcho?: Record<CardId, { ownerId: PlayerId; cardName: string }>
  b55FujiPending?: Record<PlayerId, { slashUsed: boolean; dodgeUsed: boolean }>
  b55Daozhuan?: Record<PlayerId, { turn: number; round: number; usedThisTurn: boolean; usedNames: string[]; disabledRound?: number }>
}

const character = (id: string, name: string, kingdom: CharacterDefinition['kingdom'], gender: CharacterDefinition['gender'], maxHp: number, skills: CharacterDefinition['skills']): CharacterDefinition => ({ id, name, kingdom, gender, maxHp, pack: 'sp', skills })

const STAR_DONGZHUO = character('star-dongzhuo-b55', '星·董卓', 'qun', 'male', 5, [
  { id: XJ_XIONGJIN, name: '雄进', description: '出牌阶段开始时（每轮限一次），你可以摸X张牌（X为你已损失的体力值，至少为1且至多为3），然后本回合的弃牌阶段开始时，你弃置所有非基本牌；其他角色的出牌阶段开始时（每轮限一次），你可以令其摸X张牌，然后本回合的弃牌阶段开始时，其弃置所有基本牌。' },
  { id: XJ_ZHENBIAN, name: '镇边', description: '锁定技。你的手牌上限等于你的体力上限。当有牌不因使用置入弃牌堆时，你记录这些牌的花色，然后若你记录了四种花色且体力上限小于8，你清除记录的花色并加1点体力上限。' },
  { id: XJ_BAOXI, name: '暴袭', description: '每轮各限一次。当一次性至少两张基本牌进入弃牌堆后，你可以减1点体力上限，将一张手牌当【决斗】使用。当一次性至少两张非基本牌进入弃牌堆后，你可以减1点体力上限，将一张手牌当不计入次数且无次数限制的【杀】使用。' },
])
const SHI_DONGZHAO = character('shi-dongzhao-b55', '势·董昭', 'wei', 'male', 3, [
  { id: DZ_MIAOLUE, name: '妙略', description: '游戏开始时，你获得两张【瞒天过海】；当你受到伤害后，你可以选择一项：摸两张牌；从牌堆或弃牌堆中获得一张智囊。' },
  { id: DZ_YINGJIA, name: '迎驾', description: '限定技，一名角色的回合结束后，若你本回合使用了至少两张同名锦囊牌，你可以弃置一张手牌，令一名角色执行一个额外的回合，此额外回合开始时，其摸两张牌。' },
])
const WANG_JING = character('wangjing-b55', '王经', 'wei', 'male', 4, [
  { id: WJ_ZUJIN, name: '阻进', description: '每回合每种牌名限一次。若你未受伤或体力值不为最低，你可将一张基本牌当做【杀】使用或打出；若你已受伤，你可将一张基本牌当做【闪】或【无懈可击】使用或打出。' },
  { id: WJ_JIEJIAN, name: '节谏', description: '准备阶段，你可以选择一名其他角色，交给其任意张手牌，然后其获得“节谏”标记。每名角色的回合限一次，当拥有“节谏”标记的角色成为非你使用的非装备牌的唯一目标时，你可以取消之，然后你成为此牌目标并摸一张牌。其回合结束后移除此标记；若其体力值大于等于交牌时的体力值，你摸两张牌。' },
])
const YOU_ZHUGE_LIANG = character('you-zhuge-liang-b55', '友·诸葛亮', 'qun', 'male', 3, [
  { id: YZ_YANCE, name: '演策', description: '每轮限一次，首轮开始时，或准备阶段，你可以选择一项：从牌堆中随机获得一张锦囊牌；执行“卧龙演策”。若你执行“卧龙演策”，当一张牌被使用时，若此牌的类别或颜色与你的预测相同，你摸一张牌（每次执行“卧龙演策”至多因此摸五张牌）。当本次“卧龙演策”的预测全部验证后，或当你再次执行“卧龙演策”时，若你本次“卧龙演策”正确的预测数量：为0，你失去1点体力，此后“卧龙演策”可预测的牌数-1；不足一半，你弃置两张牌；至少一半（向上取整），你根据本次预测的方式，从牌堆中获得一张符合你声明条件的牌；全部正确，你摸两张牌，此后“卧龙演策”可预测的牌数+1（至多为7）。' },
  { id: YZ_FANGQIU, name: '方遒', description: '限定技，当你执行“卧龙演策”后，你可以展示你的“卧龙演策”预测，若如此做，本次“卧龙演策”的预测全部验证后，执行效果的值均+1，然后若卧龙演策预测的牌数大于3且预测全部正确，该技能可以再次发动。' },
  { id: YZ_GONGLI, name: '共砺', description: '身份：此模式无效。排位、斗地主：锁定技，若友庞统在场且与你阵营一致，你执行“卧龙演策”可预测的牌数+1；若友徐庶在场且与你阵营一致，你“卧龙演策”预测的第一张牌的结果视为正确。' },
])
const YOU_PANGTONG = character('you-pangtong-b55', '友·庞统', 'qun', 'male', 3, [
  { id: YP_MANJUAN, name: '漫卷', description: '每轮限五次，当你不因本技能一次性获得至少两张牌后，你可以将这些牌中的任意张牌以任意顺序置于牌堆顶。若如此做，你每放置一张牌，便从弃牌堆中随机获得一张与此牌类别不同的牌（单次至多获得五张）。' },
  { id: YP_YANGMING, name: '养名', description: '出牌阶段结束时，若你本阶段失去过三张手牌，你可以将牌堆顶的X张牌置于你的武将牌上（X为本回合进入弃牌堆的花色数），然后使用其中花色各不相同的牌（无次数限制），将剩余的牌置入弃牌堆。' },
  { id: YP_GONGLI, name: '共砺', description: '身份：此模式无效。排位、斗地主：锁定技，若友诸葛亮在场且与你阵营一致，你发动“养名”置于武将牌上的牌的张数+1；若友徐庶在场且与你阵营一致，你发动“养名”后，获得一张本次置于武将牌上的牌中未使用过的花色的牌。' },
])
const YOU_XU_SHU = character('you-xushu-b55', '友·徐庶', 'qun', 'male', 3, [
  { id: YX_XIAXING, name: '侠行', description: '游戏开始时，你获得并使用【玄剑】；当【玄剑】进入弃牌堆时，你可以移除2个“启诲”标记并获得之。（衍生牌）玄剑1362：你可以将一种花色的所有手牌当普通【杀】使用。' },
  { id: YX_QIHUI, name: '启诲', description: '锁定技，当你使用牌时，若你没有此牌对应类别的标记，你获得1个对应类别的“启诲”标记，然后若你拥有3个“启诲”标记，你移除2个并选择一项：回复1点体力；摸两张牌；使用下一张牌不计入次数且无次数限制。' },
  { id: YX_GONGLI, name: '共砺', description: '身份：此模式无效。排位、斗地主：锁定技，若友诸葛亮在场且与你阵营一致，你发动【玄剑】改为将一张手牌当普通【杀】使用；若友庞统在场且与你阵营一致，你发动【玄剑】使用的【杀】无距离限制。' },
])
const MOU_GUO_HUAI = character('mou-guohuai-b55', '谋·郭淮', 'wei', 'male', 4, [
  { id: GH_JINGCE, name: '精策', description: '锁定技，回合开始时，若你的武将牌上没有“精策”牌，则你清除未验证的预测记录，然后将牌堆顶的三张牌置于你的武将牌上，称为“精策”牌。回合结束时，你预测将获得这些“精策”牌的角色（或预测这些“精策”牌不被任何角色获得），然后根据预测顺序将这些牌分别置为牌堆顶的第三、六、九张牌（若牌堆剩余牌数不足，则将无法达到的牌按预测顺序置于牌堆底）。若你预测正确，则你分别摸一、二、三张牌。' },
])
const LOU_GUI = character('lougui-b55', '娄圭', 'wei', 'male', 3, [
  { id: LG_GUANSHA, name: '灌沙', description: '限定技，出牌阶段结束时，你可以将你的所有牌替换为牌堆中的等量随机基本牌，然后本回合你的手牌上限+X（X为你因此获得的牌的牌名数）。' },
  { id: LG_JIYU, name: '急御', description: '出牌阶段限一次，你可弃置一张手牌，随机从牌堆或弃牌堆中获得此牌类别外的牌各一张。每阶段限两次；若此阶段已使用所有因此获得的牌，此技能可以再次发动。' },
])
const SHI_YUJI = character('shi-yuji-b55', '势·于吉', 'qun', 'male', 3, [
  { id: YJ_FUJI, name: '符济', description: '出牌阶段限一次，你可展示至多全场存活的其他角色数张牌并交给等量名其他角色，这些牌称为“符济”牌。其他角色使用“符济”牌时，获得一张与“符济”牌相同花色的牌。若“符济”牌为【杀】，此【杀】的基础伤害值+1；若“符济”牌为【闪】，则使用结算后使用者摸一张牌。若你发动此技能后手牌数为全场最少，则你摸一张牌，且直至下回合开始前，你使用的第一张【杀】和【闪】带有“符济”牌效果。' },
  { id: YJ_DAOZHUAN, name: '道转', description: '每回合限一次，当你需要使用基本牌时，可将你或当前回合角色的一张牌置入弃牌堆，视为使用此牌；每轮每牌名限一次。若当前回合角色因此失去牌，本轮此技能失效。' },
])
const ZHANG_BU = character('zhangbu-b55', '张布', 'wu', 'male', 4, [
  { id: ZB_CHENGXIONG, name: '惩凶', description: '你使用锦囊牌仅指定其他角色为目标后，你可以选择一名牌数大于等于X的其他角色（X为你此阶段使用的牌数）并弃置其一张牌。若此牌颜色与你使用的锦囊牌颜色相同，你对其造成1点伤害。' },
  { id: ZB_WANGZHUAN, name: '妄专', description: '当一名角色受到非游戏牌造成的伤害后，若你是伤害来源或受伤角色，你可摸一张牌，然后当前回合角色本回合非锁定技失效。' },
])

const WISDOM_TRICKS = new Set(['无中生有', '无懈可击', '过河拆桥'])
const XUANJIAN_EQUIPMENT = 'you-xushu-xuanjian'

// 【漫卷】：只截获一次性获得至少两张牌的事件；选中的牌依次置于牌堆顶，
// 每置入一张，便从弃牌堆随机取得一张类别不同的牌。自身补牌不会递归触发。
registerSkillRuntime({ id: YP_MANJUAN,
  triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_PANGTONG.id)
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; reason?: string }
    const ids = [...new Set((payload.cardIds ?? []).filter((id) => host.state.players.find((player) => player.id === ownerId)?.zones.hand.includes(id)))]
    if (!owner || payload.playerId !== ownerId || payload.reason === YP_MANJUAN || ids.length < 2) return
    const state = host.state as B55State
    const usage = state.b55ManjuanUses?.[ownerId]
    if (usage?.round === state.roundNumber && usage.uses >= 5) return
    host.queueSkill({ skillId: YP_MANJUAN, ownerId, step: 'select-top', data: { cardIds: ids } })
  } }],
  startQueued(host, ownerId, prompt) {
    const ids = (prompt.data.cardIds as CardId[]).filter((id) => host.state.players.find((player) => player.id === ownerId)?.zones.hand.includes(id))
    if (prompt.step === 'select-top') {
      if (ids.length < 2) return
      host.askSkill({ skillId: YP_MANJUAN, ownerId, step: 'select-top', data: { cardIds: ids }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【漫卷】：选择其中任意张牌按顺序置于牌堆顶',
        timeoutMs: 30_000, optional: true, cardIds: ids, hiddenCardSlots: [], min: 0, max: ids.length, purpose: 'skill',
      }) })
      return
    }
    if (prompt.step === 'arrange-top') {
      const chosen = (prompt.data.selectedIds as CardId[]).filter((cardId) => ids.includes(cardId))
      if (!chosen.length) return
      host.askSkill({ skillId: YP_MANJUAN, ownerId, step: 'arrange-top', data: { selectedIds: chosen }, build: (id): ArrangeCardsRequest => ({
        id, kind: 'arrange-cards', playerId: ownerId, prompt: '【漫卷】：排列置于牌堆顶的牌（列表第一张在最上方）',
        timeoutMs: 30_000, optional: false, cardIds: chosen, minTop: chosen.length, maxTop: chosen.length, allowBottom: false,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'select-top') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const currentHand = host.state.players.find((player) => player.id === ownerId)?.zones.hand ?? []
      const valid = [...new Set(selected.filter((id) => (resolution.data.cardIds as CardId[]).includes(id) && currentHand.includes(id)))]
      if (!valid.length) return
      host.queueSkill({ skillId: YP_MANJUAN, ownerId, step: 'arrange-top', data: { selectedIds: valid } })
      return
    }
    if (resolution.step !== 'arrange-top') return
    const payload = response.payload as { top?: CardId[]; bottom?: CardId[] }
    const selected = resolution.data.selectedIds as CardId[]
    const top = payload.top ?? []
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_PANGTONG.id)
    if (!owner || top.length !== selected.length || new Set(top).size !== selected.length || top.some((id) => !selected.includes(id) || !owner.zones.hand.includes(id))) return
    for (const cardId of [...top].reverse()) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
    const state = host.state as B55State
    const usage = state.b55ManjuanUses ??= {}
    const record = usage[ownerId] = usage[ownerId]?.round === state.roundNumber ? usage[ownerId] : { round: state.roundNumber, uses: 0 }
    if (record.uses >= 5) return
    record.uses += 1
    for (const cardId of top.slice(0, 5)) {
      const category = host.state.cards[cardId]?.category
      const choices = host.state.zones.discardPile.filter((discardId) => host.state.cards[discardId]?.category !== category)
      if (!choices.length) continue
      const gained = host.rng.pick(choices)
      if (!gained || !host.state.zones.discardPile.includes(gained)) continue
      moveCard(host.state, gained, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [gained], reason: YP_MANJUAN }, { sourceId: ownerId, targetId: ownerId, cardIds: [gained] })
    }
  },
})

function b55YangmingActions(host: SkillHost, ownerId: PlayerId): Extract<LegalAction, { kind: 'use-card' }>[] {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_PANGTONG.id)
  const pile = owner?.characterPiles[YP_YANGMING] ?? []
  if (!owner || !pile.length || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return []
  const originalHand = owner.zones.hand
  owner.zones.hand = [...originalHand, ...pile.filter((id) => !originalHand.includes(id))]
  try {
    return legalPlayActions(host.state, ownerId).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> =>
      action.kind === 'use-card' && action.cardIds.length === 1 && pile.includes(action.cardIds[0]))
  } finally {
    owner.zones.hand = originalHand
  }
}

function b55FinishYangming(host: SkillHost, ownerId: PlayerId): void {
  const owner = host.state.players.find((player) => player.id === ownerId)
  if (owner) {
    const cards = [...(owner.characterPiles[YP_YANGMING] ?? [])]
    for (const cardId of cards) {
      if (owner.characterPiles[YP_YANGMING]?.includes(cardId))
        moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YP_YANGMING }, { kind: 'discardPile' })
    }
  }
  delete (host.state as B55State).b55YangmingRun?.[ownerId]
}

// 【养名】：统计出牌阶段手牌离区次数和本回合真实进弃牌堆的花色；牌从专属牌堆直接进入常规用牌结算。
registerSkillRuntime({ id: YP_YANGMING,
  unlimitedSlash(state, ownerId) { return Boolean((state as B55State).b55YangmingRun?.[ownerId]) },
  slashUseQuotaBypass(state, ownerId) { return Boolean((state as B55State).b55YangmingRun?.[ownerId]) },
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (playerId !== ownerId) return
    ;(host.state as B55State).b55YangmingTurn ??= {}
    ;(host.state as B55State).b55YangmingTurn![ownerId] = { turn: host.state.turnNumber, handLosses: 0, discardSuits: [] }
  } }, { event: 'HandCardLeft', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId }
    if (payload.playerId !== ownerId || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    const state = host.state as B55State
    state.b55YangmingTurn ??= {}
    const record = state.b55YangmingTurn[ownerId] = state.b55YangmingTurn[ownerId]?.turn === state.turnNumber
      ? state.b55YangmingTurn[ownerId] : { turn: state.turnNumber, handLosses: 0, discardSuits: [] }
    record.handLosses += 1
  } }, { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    if (host.state.currentPlayerId !== ownerId) return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const suit = cardId ? host.state.cards[cardId]?.suit : undefined
    if (!suit) return
    const state = host.state as B55State
    state.b55YangmingTurn ??= {}
    const record = state.b55YangmingTurn[ownerId] = state.b55YangmingTurn[ownerId]?.turn === state.turnNumber
      ? state.b55YangmingTurn[ownerId] : { turn: state.turnNumber, handLosses: 0, discardSuits: [] }
    if (!record.discardSuits.includes(suit)) record.discardSuits.push(suit)
  } }, { event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const record = (host.state as B55State).b55YangmingTurn?.[ownerId]
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_PANGTONG.id)
    if (phase.playerId !== ownerId || phase.phase !== 'play' || !owner || record?.turn !== host.state.turnNumber
      || record.handLosses < 3 || record.discardSuits.length === 0 || owner.characterPiles[YP_YANGMING]?.length) return
    host.queueSkill({ skillId: YP_YANGMING, ownerId, step: 'invoke', data: { count: record.discardSuits.length } })
  } }, { event: 'Death', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) b55FinishYangming(host, ownerId)
  } }],
  startQueued(host, ownerId, prompt) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_PANGTONG.id)
    if (!owner) return
    if (prompt.step === 'invoke') {
      const amount = Number(prompt.data.count ?? 0)
      if (amount <= 0) return
      host.askSkill({ skillId: YP_YANGMING, ownerId, step: 'invoke', data: { amount }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【养名】：将牌堆顶${amount}张牌置于武将牌上并依次使用花色各不相同的牌？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动【养名】' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step !== 'play-next') return
    const run = (host.state as B55State).b55YangmingRun?.[ownerId]
    const pile = owner.characterPiles[YP_YANGMING] ?? []
    if (!run || !pile.length) { b55FinishYangming(host, ownerId); return }
    const usedSuits = new Set(run.usedSuits)
    const actions = b55YangmingActions(host, ownerId).filter((action) => {
      const suit = host.state.cards[action.cardIds[0]]?.suit
      return !!suit && !usedSuits.has(suit)
    })
    if (!actions.length) { b55FinishYangming(host, ownerId); return }
    const options = actions.map((action) => ({ id: action.id, label: `使用【${action.asCardName}】：${action.label}` }))
    options.push({ id: 'finish', label: '结束使用并弃置剩余牌' })
    host.askSkill({ skillId: YP_YANGMING, ownerId, step: 'play-next', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【养名】：选择使用一张花色未使用的牌，或结束',
      timeoutMs: 30_000, optional: false, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as B55State
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    const option = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'invoke') {
      if (option !== 'yes' || host.state.turnNumber !== (state.b55YangmingTurn?.[ownerId]?.turn ?? -1)) return
      const amount = Number(resolution.data.amount ?? 0)
      if (amount <= 0) return
      while (host.state.zones.drawPile.length < amount) {
        if (!reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))) break
      }
      const cards = host.state.zones.drawPile.slice(0, amount)
      if (!cards.length) return
      for (const cardId of cards) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: YP_YANGMING })
      state.b55YangmingRun ??= {}
      state.b55YangmingRun[ownerId] = { turn: host.state.turnNumber, usedSuits: [] }
      host.queueSkill({ skillId: YP_YANGMING, ownerId, step: 'play-next', data: {} })
      return
    }
    if (resolution.step !== 'play-next') return
    if (option === 'finish') { b55FinishYangming(host, ownerId); return }
    const run = state.b55YangmingRun?.[ownerId]
    const action = b55YangmingActions(host, ownerId).find((candidate) => candidate.id === option)
    const cardId = action?.cardIds[0]
    const suit = cardId ? host.state.cards[cardId]?.suit : undefined
    if (!owner || !action || !cardId || !suit || !owner.characterPiles[YP_YANGMING]?.includes(cardId)
      || !run || run.usedSuits.includes(suit)) return
    run.usedSuits.push(suit)
    host.queueSkill({ skillId: YP_YANGMING, ownerId, step: 'play-next', data: {} })
    executeUseCardAction(host as never, ownerId, { ...action, sourceSkillId: YP_YANGMING })
  },
})

function b55YanceCardFacts(state: SanguoshaState, sourceId: PlayerId, cardId: CardId | undefined, cardName: string): { category: string | null; color: string | null } {
  const basicNames = new Set(['杀', '火杀', '雷杀', '闪', '桃', '酒'])
  const category = basicNames.has(cardName) ? 'basic'
    : INSTANT_TRICKS.has(cardName) || DELAYED_TRICKS.has(cardName) ? 'trick'
      : cardId ? state.cards[cardId]?.category ?? null : null
  const color = cardId ? effectiveCardColor(state, sourceId, cardId, skillIdsOf) : null
  return { category, color }
}

function b55BeginYance(host: SkillHost, ownerId: PlayerId, mode: 'category' | 'color', value: string): void {
  const state = host.state as B55State
  const count = Math.max(1, Math.min(7, state.b55YanceCount?.[ownerId] ?? 3))
  state.b55YanceForecast ??= {}
  state.b55YanceForecast[ownerId] = { round: state.roundNumber, count, mode, value, verified: 0, correct: 0, draws: 0, revealed: false }
  const owner = state.players.find((player) => player.id === ownerId)
  if (!owner || owner.usedLimitedSkills.includes(YZ_FANGQIU)) return
  host.queueSkill({ skillId: YZ_FANGQIU, ownerId, step: 'show-forecast', data: {} })
}

function b55FinishFangqiu(host: SkillHost, ownerId: PlayerId): void {
  const state = host.state as B55State
  const forecast = state.b55YanceForecast?.[ownerId]
  if (!forecast || !forecast.revealed) return
  delete state.b55YanceForecast?.[ownerId]
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_ZHUGE_LIANG.id)
  if (!owner) return
  const threshold = Math.ceil(forecast.count / 2)
  const allCorrect = forecast.verified === forecast.count && forecast.correct === forecast.count
  if (forecast.correct === 0) {
    loseHp(host as never, ownerId, 2, YZ_FANGQIU)
    state.b55YanceCount ??= {}
    state.b55YanceCount[ownerId] = Math.max(1, forecast.count)
  } else if (forecast.correct < threshold) {
    const hand = owner.zones.hand
    const count = Math.min(3, hand.length)
    if (count) host.askSkill({ skillId: YZ_FANGQIU, ownerId, step: 'forecast-penalty', data: { count }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【方遒】：弃置${count}张牌`, timeoutMs: 30_000,
      optional: false, cardIds: [...hand], hiddenCardSlots: [], min: count, max: count, purpose: 'skill',
    }) })
    if (count) return
  } else {
    const candidates = host.state.zones.drawPile.filter((cardId) => {
      const card = host.state.cards[cardId]
      return forecast.mode === 'category' ? card?.category === forecast.value : card?.color === forecast.value
    })
    for (let index = 0; index < 2 && candidates.length; index += 1) {
      const selected = host.rng.pick(candidates)
      if (!selected) break
      moveCard(host.state, selected, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: YZ_FANGQIU }, { sourceId: ownerId, targetId: ownerId, cardIds: [selected] })
      candidates.splice(candidates.indexOf(selected), 1)
    }
    if (allCorrect) {
      drawCards(host.state, host.rng, ownerId, 3, (name, payload) => host.dispatch(name, payload))
      state.b55YanceCount ??= {}
      state.b55YanceCount[ownerId] = Math.min(7, forecast.count + 2)
    }
  }
  if (allCorrect && forecast.count > 3) owner.usedLimitedSkills = owner.usedLimitedSkills.filter((skillId) => skillId !== YZ_FANGQIU)
  const pending = state.b55YancePendingStart?.[ownerId]
  if (pending) { delete state.b55YancePendingStart?.[ownerId]; b55BeginYance(host, ownerId, pending.mode, pending.value) }
}

registerSkillRuntime({ id: YZ_FANGQIU,
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'show-forecast') {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_ZHUGE_LIANG.id)
      const forecast = (host.state as B55State).b55YanceForecast?.[ownerId]
      if (!owner || !forecast || owner.usedLimitedSkills.includes(YZ_FANGQIU)) return
      host.askSkill({ skillId: YZ_FANGQIU, ownerId, step: 'show-forecast', data: {}, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【方遒】：是否展示本次“卧龙演策”预测？展示后本次演策效果数值+1',
    timeoutMs: 25_000, optional: true,
    options: [{ id: 'show', label: '发动【方遒】并展示预测' }, { id: 'hide', label: '不展示' }],
      }) })
    } else if (prompt.step === 'resolve-enhanced') b55FinishFangqiu(host, ownerId)
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as B55State
    if (resolution.step === 'show-forecast') {
      const forecast = state.b55YanceForecast?.[ownerId]
      const owner = host.state.players.find((player) => player.id === ownerId)
      const payload = response.payload
      if (!forecast || !owner || !payload || typeof payload !== 'object' || !('optionId' in payload)
        || payload.optionId !== 'show' || owner.usedLimitedSkills.includes(YZ_FANGQIU)) return
      forecast.revealed = true
      owner.usedLimitedSkills.push(YZ_FANGQIU)
      host.dispatch('SkillActivated', { skillId: YZ_FANGQIU, playerId: ownerId, revealed: true,
        logText: `${owner.nickname}发动【方遒】，公开预测${forecast.mode === 'category' ? '类别' : '颜色'}：${forecast.value}` }, { sourceId: ownerId })
    } else if (resolution.step === 'forecast-penalty') {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const expected = Math.max(0, Math.trunc(Number(resolution.data.count ?? 3)))
      const valid = [...new Set(selected.filter((id): id is CardId => owner.zones.hand.includes(id)))].slice(0, expected)
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      if (valid.length) host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: YZ_FANGQIU }, { sourceId: ownerId, cardIds: valid })
      const pending = state.b55YancePendingStart?.[ownerId]
      if (pending) { delete state.b55YancePendingStart?.[ownerId]; b55BeginYance(host, ownerId, pending.mode, pending.value) }
    }
  },
})

function b55FinishYance(host: SkillHost, ownerId: PlayerId): void {
  const state = host.state as B55State
  const forecast = state.b55YanceForecast?.[ownerId]
  if (!forecast) return
  if (forecast.revealed) {
    host.queueSkill({ skillId: YZ_FANGQIU, ownerId, step: 'resolve-enhanced', data: {} })
    return
  }
  delete state.b55YanceForecast?.[ownerId]
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_ZHUGE_LIANG.id)
  if (!owner) return
  const threshold = Math.ceil(forecast.count / 2)
  const allCorrect = forecast.verified === forecast.count && forecast.correct === forecast.count
  if (forecast.correct === 0) {
    loseHp(host as never, ownerId, 1, YZ_YANCE)
    state.b55YanceCount ??= {}
    state.b55YanceCount[ownerId] = Math.max(1, forecast.count - 1)
  } else if (forecast.correct < threshold) {
    const hand = owner.zones.hand
    const count = Math.min(2, hand.length)
    if (count) host.askSkill({ skillId: YZ_YANCE, ownerId, step: 'forecast-penalty', data: { count }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【演策】：弃置${count}张牌`, timeoutMs: 30_000,
      optional: false, cardIds: [...hand], hiddenCardSlots: [], min: count, max: count, purpose: 'skill',
    }) })
    if (count) return
  } else {
    if (forecast.correct >= threshold) {
      const candidates = host.state.zones.drawPile.filter((cardId) => {
        const card = host.state.cards[cardId]
        return forecast.mode === 'category' ? card?.category === forecast.value : (card?.color === forecast.value)
      })
      for (let index = 0; index < 1 && candidates.length; index += 1) {
        const selected = host.rng.pick(candidates)
        if (!selected) break
        moveCard(host.state, selected, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: YZ_YANCE }, { sourceId: ownerId, targetId: ownerId, cardIds: [selected] })
        candidates.splice(candidates.indexOf(selected), 1)
      }
    }
    if (allCorrect) {
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      state.b55YanceCount ??= {}
      state.b55YanceCount[ownerId] = Math.min(7, forecast.count + 1)
    }
  }
  const pending = state.b55YancePendingStart?.[ownerId]
  if (pending) {
    delete state.b55YancePendingStart?.[ownerId]
    b55BeginYance(host, ownerId, pending.mode, pending.value)
  }
}

// 【演策】逐一核验接下来使用的牌；打出的响应牌不触发 CardUsed，因而不会误计。
registerSkillRuntime({ id: YZ_YANCE,
  triggers: [{ event: 'RoundStart', handle(host, ownerId, context) {
    const round = Number((context.event.payload as { roundNumber?: number }).roundNumber)
    const state = host.state as B55State
    if (round !== 1 || state.b55YanceUsedRound?.[ownerId] === round
      || !host.state.players.some((player) => player.id === ownerId && player.alive && player.characterId === YOU_ZHUGE_LIANG.id)) return
    host.queueSkill({ skillId: YZ_YANCE, ownerId, step: 'choose-branch', data: { round } })
  } }, { event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    const state = host.state as B55State
    if (event.playerId !== ownerId || event.phase !== 'prepare' || state.b55YanceUsedRound?.[ownerId] === state.roundNumber
      || !host.state.players.some((player) => player.id === ownerId && player.alive && player.characterId === YOU_ZHUGE_LIANG.id)) return
    host.queueSkill({ skillId: YZ_YANCE, ownerId, step: 'choose-branch', data: { round: state.roundNumber } })
  } }, { event: 'CardUsed', handle(host, ownerId, context) {
    const state = host.state as B55State
    const forecast = state.b55YanceForecast?.[ownerId]
    if (!forecast || forecast.verified >= forecast.count) return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId ?? context.event.cardIds?.[0]
    const cardName = payload.cardName ?? (cardId ? host.state.cards[cardId]?.name : '')
    const facts = b55YanceCardFacts(host.state, ownerId, cardId, cardName ?? '')
    forecast.verified += 1
    if ((forecast.mode === 'category' ? facts.category : facts.color) === forecast.value) {
      forecast.correct += 1
      if (forecast.draws < 5) {
        forecast.draws += 1
        drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => host.dispatch(name, drawPayload))
      }
    }
    if (forecast.verified >= forecast.count) b55FinishYance(host, ownerId)
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-branch') {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_ZHUGE_LIANG.id)
      if (!owner) return
      host.askSkill({ skillId: YZ_YANCE, ownerId, step: 'choose-branch', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【演策】：随机获得一张锦囊牌，或执行“卧龙演策”',
        timeoutMs: 25_000, optional: true, options: [
          { id: 'trick', label: '随机获得一张锦囊牌' }, { id: 'forecast', label: '执行“卧龙演策”' },
        ],
      }) })
      return
    }
    if (prompt.step === 'close-old') { b55FinishYance(host, ownerId); return }
    if (prompt.step === 'choose-mode') {
      host.askSkill({ skillId: YZ_YANCE, ownerId, step: 'choose-mode', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【演策】：选择预测类别或颜色', timeoutMs: 25_000,
        optional: false, options: [{ id: 'category', label: '类别' }, { id: 'color', label: '颜色' }],
      }) })
      return
    }
    if (prompt.step === 'choose-value') {
      const mode = prompt.data.mode as 'category' | 'color'
      const options = mode === 'category'
        ? [{ id: 'basic', label: '基本牌' }, { id: 'trick', label: '锦囊牌' }, { id: 'equipment', label: '装备牌' }]
        : [{ id: 'red', label: '红色牌' }, { id: 'black', label: '黑色牌' }]
      host.askSkill({ skillId: YZ_YANCE, ownerId, step: 'choose-value', data: { mode }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【演策】：选择本次预测的牌类/颜色',
        timeoutMs: 25_000, optional: false, options,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as B55State
    const option = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'choose-branch') {
      if (option !== 'trick' && option !== 'forecast') return
      if (state.b55YanceUsedRound?.[ownerId] === state.roundNumber) return
      state.b55YanceUsedRound ??= {}
      state.b55YanceUsedRound[ownerId] = state.roundNumber
      if (option === 'trick') {
        const ids = host.state.zones.drawPile.filter((cardId) => {
          const card = host.state.cards[cardId]
          return card?.category === 'trick' && (INSTANT_TRICKS.has(card.name) || DELAYED_TRICKS.has(card.name))
        })
        const selected = ids.length ? host.rng.pick(ids) : null
        if (selected) {
          moveCard(host.state, selected, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: YZ_YANCE }, { sourceId: ownerId, targetId: ownerId, cardIds: [selected] })
        }
      } else host.queueSkill({ skillId: YZ_YANCE, ownerId, step: 'choose-mode', data: {} })
      return
    }
    if (resolution.step === 'choose-mode') {
      if (option !== 'category' && option !== 'color') return
      host.queueSkill({ skillId: YZ_YANCE, ownerId, step: 'choose-value', data: { mode: option } })
      return
    }
    if (resolution.step === 'choose-value') {
      const mode = resolution.data.mode as 'category' | 'color'
      const values = mode === 'category' ? ['basic', 'trick', 'equipment'] : ['red', 'black']
      if (!option || !values.includes(option)) return
      const active = state.b55YanceForecast?.[ownerId]
      const selected = { mode, value: option } as { mode: 'category' | 'color'; value: string }
      if (active) {
        state.b55YancePendingStart ??= {}
        state.b55YancePendingStart[ownerId] = { round: state.roundNumber, ...selected }
        host.queueSkill({ skillId: YZ_YANCE, ownerId, step: 'close-old', data: {} })
      } else b55BeginYance(host, ownerId, selected.mode, selected.value)
      return
    }
    if (resolution.step === 'forecast-penalty') {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const expected = Math.max(0, Math.trunc(Number(resolution.data.count ?? 2)))
      const valid = [...new Set(selected.filter((id): id is CardId => owner.zones.hand.includes(id)))].slice(0, expected)
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      if (valid.length) host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: YZ_YANCE }, { sourceId: ownerId, cardIds: valid })
      const pending = state.b55YancePendingStart?.[ownerId]
      if (pending) { delete state.b55YancePendingStart?.[ownerId]; b55BeginYance(host, ownerId, pending.mode, pending.value) }
    }
  },
})

// 共砺只在排位/斗地主模式生效；当前项目仅运行身份模式，三个定义保留官方文本，
// 但这些身份局运行时不施加任何额外效果。
registerSkillRuntime({ id: YZ_GONGLI })
registerSkillRuntime({ id: YP_GONGLI })
registerSkillRuntime({ id: YX_GONGLI })

export const HISTORICAL_BATCH55_CHARACTERS: readonly CharacterDefinition[] = [STAR_DONGZHUO, SHI_DONGZHAO, WANG_JING, YOU_ZHUGE_LIANG, YOU_PANGTONG, YOU_XU_SHU, MOU_GUO_HUAI, LOU_GUI, SHI_YUJI, ZHANG_BU]

// 【雄进】：手牌上限固定等于体力上限。
registerSkillRuntime({ id: XJ_XIONGJIN,
  maxCardsBonus(state, ownerId) {
    const player = state.players.find((candidate) => candidate.id === ownerId)
    return player ? player.maxHp - player.hp : 0
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === STAR_DONGZHUO.id)
    const actorId = event.playerId
    if (!owner || !actorId || event.phase !== 'play' || !host.state.players.some((player) => player.id === actorId && player.alive)) return
    const state = host.state as B55State
    const usage = state.b55XiongjinUsed ??= {}
    const record = usage[ownerId] ??= { ownRound: -1, othersRound: -1 }
    const own = actorId === ownerId
    if (own ? record.ownRound === state.roundNumber : record.othersRound === state.roundNumber) return
    const count = Math.max(1, Math.min(3, owner.maxHp - owner.hp))
    host.askSkill({ skillId: XJ_XIONGJIN, ownerId, step: 'choose-branch', data: { actorId, own, count }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: own ? `【雄进】：摸${count}张牌，然后本回合弃牌阶段弃置所有非基本牌？`
        : `【雄进】：令${host.state.players.find((player) => player.id === actorId)?.nickname ?? '该角色'}摸${count}张牌，然后其本回合弃牌阶段弃置所有基本牌？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'invoke', label: '发动【雄进】' }],
    }) })
  } }, { event: 'PhaseStart', handle(host, _ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (event.phase !== 'discard' || !event.playerId) return
    const state = host.state as B55State
    const pending = state.b55XiongjinPending?.[event.playerId]
    if (!pending || pending.turn !== state.turnNumber) return
    delete state.b55XiongjinPending?.[event.playerId]
    const target = host.state.players.find((player) => player.id === event.playerId && player.alive)
    if (!target) return
    const cardIds = target.zones.hand.filter((cardId) => {
      const category = host.state.cards[cardId]?.category
      return pending.category === 'basic' ? category === 'basic' : !!category && category !== 'basic'
    })
    if (cardIds.length) discardCardsByIds(host as never, event.playerId, cardIds, XJ_XIONGJIN)
  } }, { event: 'TurnEnd', handle(host, _ownerId, context) {
    const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (targetId) delete (host.state as B55State).b55XiongjinPending?.[targetId]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-branch' || (response.payload as { optionId?: string }).optionId !== 'invoke') return
    const state = host.state as B55State
    const actorId = resolution.data.actorId as PlayerId
    const own = resolution.data.own === true
    const actor = host.state.players.find((player) => player.id === actorId && player.alive)
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!actor || !owner) return
    const use = state.b55XiongjinUsed ??= {}
    const record = use[ownerId] ??= { ownRound: -1, othersRound: -1 }
    if (own ? record.ownRound === state.roundNumber : record.othersRound === state.roundNumber) return
    if (own) record.ownRound = state.roundNumber
    else record.othersRound = state.roundNumber
    const count = Number(resolution.data.count)
    state.b55XiongjinPending ??= {}
    state.b55XiongjinPending[actorId] = { ownerId, turn: state.turnNumber, category: own ? 'non-basic' : 'basic' }
    drawCards(host.state, host.rng, actorId, count, (name, payload) => host.dispatch(name, payload))
  },
})

// 【精策】：逐张预测接收者后，把牌按第三/六/九张放回牌堆；未被取得的牌留到下回合开始验证。
registerSkillRuntime({ id: GH_JINGCE,
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === MOU_GUO_HUAI.id)
    if (!owner) return
    const state = host.state as B55State
    const pile = owner.characterPiles[GH_JINGCE] ?? (owner.characterPiles[GH_JINGCE] = [])
    if (pile.length) return
    const ledger = state.b55JingcePredictions ?? {}
    for (const [cardId, prediction] of Object.entries(ledger)) {
      if (prediction.ownerId !== ownerId) continue
      if (!prediction.obtained && prediction.predictedId === null) {
        drawCards(host.state, host.rng, ownerId, prediction.position, (name, payload) => host.dispatch(name, payload))
      }
      delete ledger[cardId]
    }
    const top = host.state.zones.drawPile.slice(0, 3)
    for (const cardId of top) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: GH_JINGCE })
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === MOU_GUO_HUAI.id)
    const cardIds = owner?.characterPiles[GH_JINGCE] ?? []
    if (!owner || !cardIds.length) return
    host.queueSkill({ skillId: GH_JINGCE, ownerId, step: 'predict', data: { cardIds: [...cardIds], index: 0, choices: [] } })
  } }, { event: 'GainCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    const state = host.state as B55State
    const ledger = state.b55JingcePredictions
    if (!ledger || !payload.playerId) return
    for (const cardId of payload.cardIds ?? []) {
      const prediction = ledger[cardId]
      if (!prediction || prediction.ownerId !== ownerId || prediction.obtained) continue
      prediction.obtained = true
      if (prediction.predictedId === payload.playerId) {
        drawCards(host.state, host.rng, ownerId, prediction.position, (name, drawPayload) => host.dispatch(name, drawPayload))
      }
    }
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'predict') return
    const ids = prompt.data.cardIds as CardId[]
    const index = Number(prompt.data.index)
    const cardId = ids[index]
    if (!cardId) return
    const players = host.state.players.filter((player) => player.alive).map((player) => ({ id: player.id, label: player.nickname }))
    const options = [...players, { id: 'nobody', label: '无人获得' }]
    host.askSkill({ skillId: GH_JINGCE, ownerId, step: 'predict', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【精策】：预测第${index + 1}张“精策”牌将由谁获得`,
      timeoutMs: 30_000, optional: false, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'predict') return
    const ids = resolution.data.cardIds as CardId[]
    const index = Number(resolution.data.index)
    const selected = (response.payload as { optionId?: string }).optionId
    if (!selected) return
    const choices = [...(resolution.data.choices as Array<PlayerId | null> ?? []), selected === 'nobody' ? null : selected]
    if (index + 1 < ids.length) {
      host.queueSkill({ skillId: GH_JINGCE, ownerId, step: 'predict', data: { cardIds: ids, index: index + 1, choices } })
      return
    }
    const state = host.state as B55State
    const ledger = state.b55JingcePredictions ??= {}
    for (let i = 0; i < ids.length; i += 1) {
      const cardId = ids[i]
      if (!host.state.players.find((player) => player.id === ownerId)?.characterPiles[GH_JINGCE]?.includes(cardId)) continue
      const prediction = choices[i] ?? null
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: GH_JINGCE }, { kind: 'drawPile' })
      const desiredPosition = (i + 1) * 3
      const pile = host.state.zones.drawPile
      const currentIndex = pile.indexOf(cardId)
      pile.splice(currentIndex, 1)
      if (pile.length >= desiredPosition - 1) pile.splice(desiredPosition - 1, 0, cardId)
      else pile.push(cardId)
      ledger[cardId] = { ownerId, predictedId: prediction, position: i + 1, obtained: false }
    }
  },
})

// 【灌沙】：限定技，替换全部手牌和装备；每种获得的基本牌名计一手牌上限。
registerSkillRuntime({ id: LG_GUANSHA, limited: true,
  maxCardsBonus(state, ownerId) {
    const entry = (state as B55State).b55GuanshaBonus?.[ownerId]
    return entry?.turn === state.turnNumber ? entry.names.length : 0
  },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === LOU_GUI.id)
    const count = owner ? owner.zones.hand.length + Object.values(owner.zones.equipment).filter(Boolean).length : 0
    if (phase.playerId !== ownerId || phase.phase !== 'play' || !owner || count === 0 || owner.usedLimitedSkills.includes(LG_GUANSHA)) return
    host.queueSkill({ skillId: LG_GUANSHA, ownerId, step: 'invoke', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner || owner.usedLimitedSkills.includes(LG_GUANSHA)) return
    host.askSkill({ skillId: LG_GUANSHA, ownerId, step: 'invoke', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【灌沙】：将你的所有手牌和装备替换为等量随机基本牌？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'invoke', label: '发动【灌沙】' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'invoke') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner || owner.usedLimitedSkills.includes(LG_GUANSHA)) return
    const count = owner.zones.hand.length + Object.values(owner.zones.equipment).filter(Boolean).length
    if (!count) return
    owner.usedLimitedSkills.push(LG_GUANSHA)
    discardAllCards(host as never, ownerId, LG_GUANSHA)
    const gained: CardId[] = []
    while (gained.length < count) {
      let candidates = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.category === 'basic')
      if (!candidates.length) {
        if (!reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))) break
        candidates = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.category === 'basic')
        if (!candidates.length) break
      }
      const cardId = host.rng.pick(candidates)
      if (!cardId) break
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      gained.push(cardId)
    }
    if (gained.length) {
      host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: LG_GUANSHA }, { sourceId: ownerId, targetId: ownerId, cardIds: gained })
      const names = [...new Set(gained.map((cardId) => host.state.cards[cardId].name))]
      ;(host.state as B55State).b55GuanshaBonus ??= {}
      ;(host.state as B55State).b55GuanshaBonus![ownerId] = { turn: host.state.turnNumber, names }
    }
  },
})

// 【急御】：最多两次；第二次必须在首次效果取得的牌全部真实使用后解锁。
registerSkillRuntime({ id: LG_JIYU,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === LOU_GUI.id)
    const record = (state as B55State).b55Jiyu?.[ownerId]
    const current = record?.turn === state.turnNumber ? record : { turn: state.turnNumber, uses: 0, gained: [], used: [] }
    const unlocked = current.uses === 0 || (current.uses === 1 && current.gained.length > 0 && current.gained.every((id) => current.used.includes(id)))
    return owner && owner.zones.hand.length > 0 && state.currentPlayerId === ownerId && state.phase === 'play' && current.uses < 2 && unlocked
      ? [{ id: `skill:${LG_JIYU}`, label: '急御：弃置一张手牌，随机获得两张异类别牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${LG_JIYU}`) return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === LOU_GUI.id)
    if (!owner?.zones.hand.length) return
    const state = host.state as B55State
    const record = state.b55Jiyu ??= {}
    const entry = record[ownerId] = record[ownerId]?.turn === state.turnNumber ? record[ownerId] : { turn: state.turnNumber, uses: 0, gained: [], used: [] }
    const unlocked = entry.uses === 0 || (entry.uses === 1 && entry.gained.length > 0 && entry.gained.every((id) => entry.used.includes(id)))
    if (entry.uses >= 2 || !unlocked) return
    host.askSkill({ skillId: LG_JIYU, ownerId, step: 'discard-cost', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【急御】：弃置一张手牌', timeoutMs: 25_000,
      optional: false, cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
    }) })
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const ids = context.event.cardIds ?? ((context.event.payload as { cardId?: CardId }).cardId ? [(context.event.payload as { cardId: CardId }).cardId] : [])
    const entry = (host.state as B55State).b55Jiyu?.[ownerId]
    if (!entry || entry.turn !== host.state.turnNumber) return
    entry.used.push(...ids.filter((id) => entry.gained.includes(id) && !entry.used.includes(id)))
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard-cost') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner || !cardId || !owner.zones.hand.includes(cardId)) return
    const category = host.state.cards[cardId]?.category
    if (!category) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: LG_JIYU }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    const state = host.state as B55State
    const record = state.b55Jiyu ??= {}
    const entry = record[ownerId] = record[ownerId]?.turn === state.turnNumber ? record[ownerId] : { turn: state.turnNumber, uses: 0, gained: [], used: [] }
    entry.uses += 1
    const obtained: CardId[] = []
    for (const source of ['drawPile', 'discardPile'] as const) {
      const pool = host.state.zones[source].filter((id) => host.state.cards[id]?.category !== category && !!host.state.cards[id])
      const selected = pool.length ? host.rng.pick(pool) : null
      if (!selected || !host.state.zones[source].includes(selected)) continue
      moveCard(host.state, selected, { kind: source }, { kind: 'hand', playerId: ownerId })
      obtained.push(selected)
    }
    entry.gained = obtained
    if (obtained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: obtained, reason: LG_JIYU }, { sourceId: ownerId, targetId: ownerId, cardIds: obtained })
  },
})

// 【妙略】：衍生锦囊进入正常卡牌结算；受伤后的锦囊获取遵守牌堆/弃牌堆来源。
registerSkillRuntime({ id: DZ_MIAOLUE,
  onGameStart(host, ownerId) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === SHI_DONGZHAO.id)
    if (!owner) return
    const ids: CardId[] = []
    for (let index = 0; index < 2; index += 1) {
      const cardId = `special:man-tian-guo-hai:${ownerId}:${index}`
      const card: PhysicalCard = {
        id: cardId, ruleset: 'ruleset-v1', expansion: 'standard', name: '瞒天过海',
        suit: index === 0 ? 'heart' : 'diamond', rank: 5, color: 'red', category: 'trick',
      }
      host.state.cards[cardId] = card
      owner.zones.hand.push(cardId)
      ids.push(cardId)
    }
    ;(host.state as B55State).b55MiaolueCards ??= {}
    ;(host.state as B55State).b55MiaolueCards![ownerId] = ids
    host.dispatch('GainCard', { playerId: ownerId, cardIds: ids, reason: DZ_MIAOLUE }, { sourceId: ownerId, targetId: ownerId, cardIds: ids })
  },
  handLimitExempt(state, _ownerId, cardId) { return state.cards[cardId]?.name === '瞒天过海' },
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !host.state.players.some((player) => player.id === ownerId && player.alive)) return
    host.queueSkill({ skillId: DZ_MIAOLUE, ownerId, step: 'damage-choice', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'damage-choice') {
      const drawAvailable = host.state.zones.drawPile.some((id) => WISDOM_TRICKS.has(host.state.cards[id]?.name ?? ''))
      const discardAvailable = host.state.zones.discardPile.some((id) => WISDOM_TRICKS.has(host.state.cards[id]?.name ?? ''))
      const options = [{ id: 'draw-two', label: '摸两张牌' }, ...(drawAvailable || discardAvailable ? [{ id: 'wisdom', label: '获得一张智囊' }] : [])]
      host.askSkill({ skillId: DZ_MIAOLUE, ownerId, step: 'damage-choice', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【妙略】：选择摸两张牌或获得一张智囊',
        timeoutMs: 25_000, optional: true, options,
      }) })
      return
    }
    if (prompt.step === 'wisdom-source') {
      const options = (prompt.data.sources as string[]).map((source) => ({ id: source, label: source === 'draw' ? '从牌堆随机获得' : '从弃牌堆选择' }))
      host.askSkill({ skillId: DZ_MIAOLUE, ownerId, step: 'wisdom-source', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【妙略】：选择智囊牌来源', timeoutMs: 25_000,
        optional: false, options,
      }) })
      return
    }
    if (prompt.step === 'wisdom-discard') {
      const cardIds = host.state.zones.discardPile.filter((id) => WISDOM_TRICKS.has(host.state.cards[id]?.name ?? ''))
      if (!cardIds.length) return
      host.askSkill({ skillId: DZ_MIAOLUE, ownerId, step: 'wisdom-discard', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【妙略】：选择一张弃牌堆中的智囊牌',
        timeoutMs: 25_000, optional: false, cardIds, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'damage-choice') {
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'draw-two') {
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
        return
      }
      if (option !== 'wisdom') return
      const draw = host.state.zones.drawPile.some((id) => WISDOM_TRICKS.has(host.state.cards[id]?.name ?? ''))
      const discard = host.state.zones.discardPile.some((id) => WISDOM_TRICKS.has(host.state.cards[id]?.name ?? ''))
      const sources = [...(draw ? ['draw'] : []), ...(discard ? ['discard'] : [])]
      if (!sources.length) return
      if (sources.length === 1 && sources[0] === 'discard') {
        host.queueSkill({ skillId: DZ_MIAOLUE, ownerId, step: 'wisdom-discard', data: {} })
      } else if (sources.length === 1) {
        const candidates = host.state.zones.drawPile.filter((id) => WISDOM_TRICKS.has(host.state.cards[id]?.name ?? ''))
        const selected = host.rng.pick(candidates)
        if (selected) {
          moveCard(host.state, selected, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: DZ_MIAOLUE }, { sourceId: ownerId, targetId: ownerId, cardIds: [selected] })
        }
      } else host.queueSkill({ skillId: DZ_MIAOLUE, ownerId, step: 'wisdom-source', data: { sources } })
      return
    }
    if (resolution.step === 'wisdom-source') {
      const source = (response.payload as { optionId?: string }).optionId
      if (source === 'discard') host.queueSkill({ skillId: DZ_MIAOLUE, ownerId, step: 'wisdom-discard', data: {} })
      else if (source === 'draw') {
        const candidates = host.state.zones.drawPile.filter((id) => WISDOM_TRICKS.has(host.state.cards[id]?.name ?? ''))
        const selected = candidates.length ? host.rng.pick(candidates) : null
        if (selected) {
          moveCard(host.state, selected, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: DZ_MIAOLUE }, { sourceId: ownerId, targetId: ownerId, cardIds: [selected] })
        }
      }
      return
    }
    if (resolution.step !== 'wisdom-discard') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !host.state.zones.discardPile.includes(cardId) || !WISDOM_TRICKS.has(host.state.cards[cardId]?.name ?? '')) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: DZ_MIAOLUE }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  },
})

// 【启诲】：三种牌类别标记触发一项奖励；次数豁免以可序列化的一次性资源交给公共杀计数入口。
registerSkillRuntime({ id: YX_QIHUI,
  unlimitedSlash(state, ownerId) { return (state as B55State).b55QihuiNextUse?.includes(ownerId) === true },
  slashUseQuotaBypass(state, ownerId) { return (state as B55State).b55QihuiNextUse?.includes(ownerId) === true },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
    const cardId = payload.cardId ?? context.event.cardIds?.[0] ?? payload.cardIds?.[0]
    const category = cardId ? host.state.cards[cardId]?.category : undefined
    if (!category) return
    const state = host.state as B55State
    if (state.b55QihuiNextUse?.includes(ownerId)) state.b55QihuiNextUse = state.b55QihuiNextUse.filter((id) => id !== ownerId)
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_XU_SHU.id)
    if (!owner) return
    const order = state.b55QihuiOrder ??= {}
    const recorded = order[ownerId] ??= []
    if (recorded.includes(category)) return
    recorded.push(category)
    owner.marks[`启诲:${category}`] = 1
    if (recorded.length < 3) return
    for (const previous of recorded.slice(0, 2)) delete owner.marks[`启诲:${previous}`]
    order[ownerId] = recorded.slice(2)
    host.queueSkill({ skillId: YX_QIHUI, ownerId, step: 'reward', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'reward') return
    host.askSkill({ skillId: YX_QIHUI, ownerId, step: 'reward', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【启诲】：选择一项：回复1点体力、摸两张牌、或下一张牌不计入次数且无次数限制',
      timeoutMs: 25_000, optional: false, options: [
        { id: 'recover', label: '回复1点体力' }, { id: 'draw', label: '摸两张牌' }, { id: 'free-next', label: '下一张牌不计入次数且无次数限制' },
      ],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'reward') return
    const option = (response.payload as { optionId?: string }).optionId
    if (option === 'recover') recover(host as never, ownerId, 1, ownerId)
    else if (option === 'draw') drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
    else if (option === 'free-next') {
      const state = host.state as B55State
      state.b55QihuiNextUse = [...new Set([...(state.b55QihuiNextUse ?? []), ownerId])]
    }
  },
})

function b55HasXuanjian(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = state.players.find((player) => player.id === ownerId)
  return Boolean(owner && Object.values(owner.zones.equipment).some((cardId) =>
    cardId && state.cards[cardId]?.specialEquipment === XUANJIAN_EQUIPMENT))
}

function b55QihuiMarkerSuits(owner: { marks: Record<string, number> }): Array<'basic' | 'trick' | 'equipment'> {
  return (['basic', 'trick', 'equipment'] as const).filter((category) => (owner.marks[`启诲:${category}`] ?? 0) > 0)
}

// 【侠行】：开局实体装备【玄剑】；技能视为使用时将所选花色全部手牌作为同一张普通【杀】的子牌。
registerSkillRuntime({ id: YX_XIAXING,
  onGameStart(host, ownerId) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_XU_SHU.id)
    if (!owner || Object.values(owner.zones.equipment).some(Boolean)) return
    const cardId = `${XUANJIAN_EQUIPMENT}:${ownerId}`
    const card: PhysicalCard = {
      id: cardId, ruleset: 'ruleset-v1', expansion: 'standard', name: '玄剑',
      suit: 'spade', rank: 1, color: 'black', category: 'equipment', equipmentSlot: 'weapon', attackRange: 1,
      specialEquipment: XUANJIAN_EQUIPMENT, persistInDiscard: true, sourceSkillId: YX_XIAXING,
    }
    host.state.cards[cardId] = card
    owner.zones.equipment.weapon = cardId
  },
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_XU_SHU.id)
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || !owner || !b55HasXuanjian(state, ownerId)) return []
    return owner.zones.hand.length ? [{ id: `skill:${YX_XIAXING}:xuanjian`, label: '侠行：选择花色，将该花色所有手牌当普通【杀】使用' }] : []
  },
  viewAs(state, ownerId) {
    const selectedSuit = (state as B55State).b55XuanjianSuit?.[ownerId]
    const owner = state.players.find((player) => player.id === ownerId && player.alive)
    if (!selectedSuit || !owner || !b55HasXuanjian(state, ownerId)) return []
    return owner.zones.hand.filter((cardId) => state.cards[cardId]?.suit === selectedSuit)
      .map((cardId) => ({ cardId, asCardName: '杀', label: '侠行【玄剑】：同花色所有手牌当普通【杀】' }))
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${YX_XIAXING}:xuanjian` || !b55HasXuanjian(host.state, ownerId)) return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner) return
    const suits = [...new Set(owner.zones.hand.map((cardId) => host.state.cards[cardId]?.suit).filter((suit): suit is Suit => Boolean(suit)))]
    if (!suits.length) return
    host.askSkill({ skillId: YX_XIAXING, ownerId, step: 'choose-suit', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【侠行】：选择一种花色，将该花色所有手牌当普通【杀】使用',
      timeoutMs: 25_000, optional: true, options: [
        ...suits.map((suit) => ({ id: suit, label: { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }[suit] })),
        { id: 'cancel', label: '取消' },
      ],
    }) })
  },
  triggers: [{ event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; fromKind?: string }
    const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_XU_SHU.id)
    if (!owner || payload.fromKind !== 'equipment' || card?.specialEquipment !== XUANJIAN_EQUIPMENT
      || !host.state.zones.discardPile.includes(card.id) || b55QihuiMarkerSuits(owner).length < 2) return
    host.queueSkill({ skillId: YX_XIAXING, ownerId, step: 'recover-xuanjian', data: { cardId: card.id } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'recover-xuanjian') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === YOU_XU_SHU.id)
    const cardId = prompt.data.cardId as CardId
    const markers = owner ? b55QihuiMarkerSuits(owner) : []
    const options: Array<{ id: string; label: string }> = []
    for (let left = 0; left < markers.length; left += 1) for (let right = left + 1; right < markers.length; right += 1) {
      const pair = [markers[left], markers[right]]
      options.push({ id: pair.join(','), label: `移除“${pair.map((category) => ({ basic: '基本牌', trick: '锦囊牌', equipment: '装备牌' }[category])).join('”和“')}”类别标记并获得【玄剑】` })
    }
    if (!owner || !host.state.zones.discardPile.includes(cardId) || !options.length) return
    host.askSkill({ skillId: YX_XIAXING, ownerId, step: 'recover-xuanjian', data: { cardId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【侠行】：移除两个“启诲”标记并获得弃牌堆中的【玄剑】？',
      timeoutMs: 25_000, optional: true, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-suit') {
      const suit = (response.payload as { optionId?: Suit }).optionId
      if (!suit || !(['spade', 'heart', 'club', 'diamond'] as string[]).includes(suit) || !b55HasXuanjian(host.state, ownerId)) return
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      const batch = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === suit)
      if (!batch.length) return
      const state = host.state as B55State
      state.b55XuanjianSuit ??= {}
      state.b55XuanjianSuit[ownerId] = suit
      const actions = legalPlayActions(host.state, ownerId).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> =>
        action.kind === 'use-card' && action.asCardName === '杀' && action.cardIds.length === 1 && batch.includes(action.cardIds[0]))
      if (!actions.length) { delete state.b55XuanjianSuit[ownerId]; return }
      const options = actions.map((action) => ({ id: action.id, label: action.label }))
      options.push({ id: 'cancel', label: '取消' })
      host.askSkill({ skillId: YX_XIAXING, ownerId, step: 'choose-use', data: { suit, cardIds: batch }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【侠行】：选择【杀】的目标；本次将同时使用该花色所有手牌',
        timeoutMs: 30_000, optional: true, options,
      }) })
      return
    }
    if (resolution.step === 'choose-use') {
      const state = host.state as B55State
      const option = (response.payload as { optionId?: string }).optionId
      const suit = resolution.data.suit as Suit
      const cardIds = (resolution.data.cardIds as CardId[]).filter((cardId) =>
        host.state.players.find((player) => player.id === ownerId)?.zones.hand.includes(cardId)
        && host.state.cards[cardId]?.suit === suit)
      const action = option && option !== 'cancel'
        ? legalPlayActions(host.state, ownerId).find((candidate): candidate is Extract<LegalAction, { kind: 'use-card' }> =>
          candidate.kind === 'use-card' && candidate.id === option && candidate.asCardName === '杀'
          && candidate.cardIds.length === 1 && cardIds.includes(candidate.cardIds[0]))
        : undefined
      delete state.b55XuanjianSuit?.[ownerId]
      if (!action || !cardIds.length || !b55HasXuanjian(host.state, ownerId)) return
      executeUseCardAction(host as never, ownerId, { ...action, cardIds, sourceSkillId: YX_XIAXING })
      return
    }
    if (resolution.step !== 'recover-xuanjian') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    const cardId = resolution.data.cardId as CardId
    const option = (response.payload as { optionId?: string }).optionId
    if (!owner || !option || !host.state.zones.discardPile.includes(cardId)
      || host.state.cards[cardId]?.specialEquipment !== XUANJIAN_EQUIPMENT) return
    const categories = option.split(',') as Array<'basic' | 'trick' | 'equipment'>
    if (categories.length !== 2 || new Set(categories).size !== 2
      || categories.some((category) => (owner.marks[`启诲:${category}`] ?? 0) < 1)) return
    for (const category of categories) delete owner.marks[`启诲:${category}`]
    const state = host.state as B55State
    if (state.b55QihuiOrder?.[ownerId]) state.b55QihuiOrder[ownerId] = state.b55QihuiOrder[ownerId].filter((category) => !categories.includes(category))
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: YX_XIAXING }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  },
})

function b55GainFujiSuitCard(host: SkillHost, playerId: PlayerId, suit: Suit): void {
  const candidates = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.suit === suit)
  if (!candidates.length) {
    reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
    candidates.push(...host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.suit === suit))
  }
  const cardId = candidates.length ? host.rng.pick(candidates) : null
  if (!cardId || !host.state.zones.drawPile.includes(cardId)) return
  moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  host.dispatch('GainCard', { playerId, cardIds: [cardId], reason: YJ_FUJI }, { sourceId: playerId, targetId: playerId, cardIds: [cardId] })
}

function b55IsSlashName(cardName: string): boolean { return ['杀', '火杀', '雷杀'].includes(cardName) }

function b55FujiUse(host: SkillHost, userId: PlayerId, cardId: CardId, cardName: string): void {
  const state = host.state as B55State
  const tagged = state.b55FujiCards?.[cardId]
  if (tagged && tagged.ownerId !== userId && tagged.recipientId === userId) {
    b55GainFujiSuitCard(host, userId, tagged.suit)
    if (b55IsSlashName(cardName)) state.b55FujiEcho ??= {}, state.b55FujiEcho[cardId] = { ownerId: tagged.ownerId, cardName }
    if (cardName === '闪') state.b55FujiEcho ??= {}, state.b55FujiEcho[cardId] = { ownerId: tagged.ownerId, cardName }
  }
  delete state.b55FujiCards?.[cardId]
  const pending = state.b55FujiPending?.[userId]
  if (pending && !pending.slashUsed && b55IsSlashName(cardName)) {
    pending.slashUsed = true
    state.b55FujiEcho ??= {}
    state.b55FujiEcho[cardId] = { ownerId: userId, cardName }
    const suit = host.state.cards[cardId]?.suit
    if (suit) b55GainFujiSuitCard(host, userId, suit)
  } else if (pending && !pending.dodgeUsed && cardName === '闪') {
    pending.dodgeUsed = true
    state.b55FujiEcho ??= {}
    state.b55FujiEcho[cardId] = { ownerId: userId, cardName }
    const suit = host.state.cards[cardId]?.suit
    if (suit) b55GainFujiSuitCard(host, userId, suit)
  }
}

// 【符济】：目标只对其本人保留一次性牌标记；手牌最少时为下回合前首张杀/闪赋予同一套效果。
registerSkillRuntime({ id: YJ_FUJI,
  announcesSelf: true,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === SHI_YUJI.id)
    const others = state.players.filter((player) => player.alive && player.id !== ownerId)
    return owner && state.currentPlayerId === ownerId && state.phase === 'play' && others.length && owner.zones.hand.length
      ? [{ id: `skill:${YJ_FUJI}`, label: '符济：展示并分配手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${YJ_FUJI}`) return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === SHI_YUJI.id)
    const others = host.state.players.filter((player) => player.alive && player.id !== ownerId)
    if (!owner || !others.length || !owner.zones.hand.length) return
    host.askSkill({ skillId: YJ_FUJI, ownerId, step: 'choose-cards', data: { max: others.length }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【符济】：选择至多${others.length}张手牌，依次交给等量名其他角色`,
      timeoutMs: 30_000, optional: true, cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0,
      max: Math.min(others.length, owner.zones.hand.length), purpose: 'skill',
    }) })
  },
  triggers: [{ event: 'CardUsed', handle(host, _ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; cardName?: string }
    const userId = context.event.sourceId
    const cardId = payload.cardId ?? context.event.cardIds?.[0] ?? payload.cardIds?.[0]
    if (!cardId || !userId || !payload.cardName) return
    const card = host.state.cards[cardId]
    if (!card) return
    b55FujiUse(host, userId, cardId, payload.cardName)
  } }, { event: 'AfterCardUse', handle(host, _ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId
    const echo = cardId ? (host.state as B55State).b55FujiEcho?.[cardId] : null
    if (!cardId || !echo || echo.ownerId !== context.event.sourceId) return
    if (payload.cardName === '闪' || echo.cardName === '闪')
      drawCards(host.state, host.rng, echo.ownerId, 1, (name, drawPayload) => host.dispatch(name, drawPayload))
    delete (host.state as B55State).b55FujiEcho?.[cardId]
  } }, { event: 'TurnStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
      delete (host.state as B55State).b55FujiPending?.[ownerId]
  } }],
  globalOutgoingDamage(state, ownerId, sourceId, context) {
    if (sourceId !== ownerId || !context.cardId) return null
    const echo = (state as B55State).b55FujiEcho?.[context.cardId]
    return echo?.ownerId === ownerId && b55IsSlashName(echo.cardName) ? { amount: context.amount + 1 } : null
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'assign-card') return
    const cardIds = (prompt.data.cardIds as CardId[]).filter((cardId) =>
      host.state.players.find((player) => player.id === ownerId)?.zones.hand.includes(cardId))
    const index = Number(prompt.data.index ?? 0)
    const usedTargets = prompt.data.usedTargets as PlayerId[]
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && !usedTargets.includes(player.id))
    if (index >= cardIds.length || !cardIds[index] || !candidates.length) {
      if (index === cardIds.length) {
        const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
        if (owner) {
          const minHand = Math.min(...host.state.players.filter((player) => player.alive).map((player) => player.zones.hand.length))
          if (owner.zones.hand.length === minHand) {
            drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
            ;(host.state as B55State).b55FujiPending ??= {}
            ;(host.state as B55State).b55FujiPending![ownerId] = { slashUsed: false, dodgeUsed: false }
          }
        }
      }
      return
    }
    host.askSkill({ skillId: YJ_FUJI, ownerId, step: 'assign-card', data: prompt.data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: `【符济】：选择获得第${index + 1}张符济牌的角色`,
      timeoutMs: 25_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-cards') {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const cardIds = [...new Set(selected.filter((cardId) => owner.zones.hand.includes(cardId)))].slice(0, Number(resolution.data.max ?? 0))
      if (!cardIds.length) return
      host.dispatch('SkillActivated', { skillId: YJ_FUJI, playerId: ownerId, cardIds, logText: `${owner.nickname}展示了${cardIds.length}张牌并发动【符济】` }, { sourceId: ownerId, cardIds })
      host.queueSkill({ skillId: YJ_FUJI, ownerId, step: 'assign-card', data: { cardIds, index: 0, usedTargets: [] } })
      return
    }
    if (resolution.step !== 'assign-card') return
    const cardIds = resolution.data.cardIds as CardId[]
    const index = Number(resolution.data.index)
    const cardId = cardIds[index]
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive && player.id !== ownerId)
    const suit = cardId ? host.state.cards[cardId]?.suit : undefined
    if (!owner || !target || !suit || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: YJ_FUJI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: YJ_FUJI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('CardGiven', { fromId: ownerId, toId: targetId, cardIds: [cardId], reason: YJ_FUJI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    const state = host.state as B55State
    state.b55FujiCards ??= {}
    state.b55FujiCards[cardId] = { ownerId, recipientId: targetId, suit }
    const usedTargets = [...(resolution.data.usedTargets as PlayerId[]), targetId]
    host.queueSkill({ skillId: YJ_FUJI, ownerId, step: 'assign-card', data: { cardIds, index: index + 1, usedTargets } })
  },
})

// 【道转】的求闪入口：先选本人或当前回合角色的一张实体牌弃置，再以虚拟闪续接原杀。
function b55DaozhuanEntry(state: SanguoshaState, ownerId: PlayerId) {
  const records = (state as B55State).b55Daozhuan ??= {}
  const current = records[ownerId]
  if (current?.round === state.roundNumber) {
    if (current.turn !== state.turnNumber) current.usedThisTurn = false
    current.turn = state.turnNumber
    return current
  }
  return records[ownerId] = { turn: state.turnNumber, round: state.roundNumber, usedThisTurn: false, usedNames: [] }
}

function b55DaozhuanVirtualCardId(state: SanguoshaState, ownerId: PlayerId, cardName: string): CardId {
  return `virtual:${YJ_DAOZHUAN}:active:${ownerId}:${state.turnNumber}:${state.roundNumber}:${cardName}`
}

function b55DaozhuanCostOptions(state: SanguoshaState, targetId: PlayerId, discarderId: PlayerId) {
  const target = state.players.find((player) => player.id === targetId && player.alive)
  if (!target) return { cardIds: [] as CardId[], hiddenCardSlots: [] as string[] }
  const open = pickableCardsOf(state, targetId, { discarderId })
  const handCards = target.zones.hand.filter((cardId) => !isCardProtectedFromDiscard(state, targetId, cardId, discarderId))
  const handSlots = target.zones.hand.flatMap((cardId, index) =>
    isCardProtectedFromDiscard(state, targetId, cardId, discarderId) ? [] : [hiddenHandSlot(targetId, index)])
  return {
    cardIds: targetId === discarderId ? [...handCards, ...open.cardIds] : open.cardIds,
    hiddenCardSlots: targetId === discarderId ? [] : handSlots,
  }
}

function b55DaozhuanCanUse(state: SanguoshaState, ownerId: PlayerId, cardName: string, dyingPlayerId?: PlayerId): boolean {
  const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === SHI_YUJI.id)
  if (!owner || !['杀', '闪', '桃', '酒'].includes(cardName)) return false
  if (cardName === '桃' && isCardUseProhibited(state, ownerId, cardName, { dyingPlayerId: dyingPlayerId ?? null }, skillIdsOf)) return false
  const entry = (state as B55State).b55Daozhuan?.[ownerId]
  if (entry?.turn === state.turnNumber && entry.usedThisTurn) return false
  if (entry?.round === state.roundNumber && entry.usedNames.includes(cardName)) return false
  if (entry?.disabledRound === state.roundNumber) return false
  const own = b55DaozhuanCostOptions(state, ownerId, ownerId)
  const activeId = state.currentPlayerId
  const active = activeId && activeId !== ownerId ? b55DaozhuanCostOptions(state, activeId, ownerId) : null
  return own.cardIds.length + (active?.cardIds.length ?? 0) + (active?.hiddenCardSlots.length ?? 0) > 0
}

function b55DaozhuanPlayActions(state: SanguoshaState, ownerId: PlayerId) {
  const owner = state.players.find((player) => player.id === ownerId)
  if (!owner) return []
  const result: { action: Extract<LegalAction, { kind: 'use-card' }>; id: string; label: string }[] = []
  for (const cardName of ['杀', '桃', '酒']) {
    const cardId = b55DaozhuanVirtualCardId(state, ownerId, cardName)
    if (state.cards[cardId]) continue
    state.cards[cardId] = {
      id: cardId, ruleset: state.rulesetVersion, expansion: 'standard', name: cardName, suit: 'spade', rank: 1,
      color: 'black', category: 'basic', virtual: true, sourceSkillId: YJ_DAOZHUAN,
    }
    owner.zones.hand.push(cardId)
    try {
      result.push(...legalPlayActions(state, ownerId)
        .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> =>
          action.kind === 'use-card' && action.cardIds.length === 1 && action.cardIds[0] === cardId
            && action.asCardName === cardName)
        .map((action) => ({ action, id: `skill:${YJ_DAOZHUAN}:${action.id}`, label: `道转：${action.label}` })))
    } finally {
      owner.zones.hand = owner.zones.hand.filter((id) => id !== cardId)
      delete state.cards[cardId]
    }
  }
  return result
}

registerSkillRuntime({ id: YJ_DAOZHUAN,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === SHI_YUJI.id)
    const entry = (state as B55State).b55Daozhuan?.[ownerId]
    if (!owner || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || entry?.turn === state.turnNumber && entry.usedThisTurn || entry?.disabledRound === state.roundNumber
      || !Object.values(b55DaozhuanCostOptions(state, ownerId, ownerId)).some((items) => items.length)) return []
    return b55DaozhuanPlayActions(state, ownerId)
      .filter(({ action }) => !entry?.round || entry.round !== state.roundNumber || !entry.usedNames.includes(action.asCardName))
      .map(({ id, label }) => ({ id, label }))
  },
  invokeActive(host, ownerId, actionId) {
    const selected = b55DaozhuanPlayActions(host.state, ownerId).find((entry) => entry.id === actionId)
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === SHI_YUJI.id)
    if (!selected || !owner) return
    const cards = b55DaozhuanCostOptions(host.state, ownerId, ownerId).cardIds
    if (!cards.length) return
    host.askSkill({ skillId: YJ_DAOZHUAN, ownerId, step: 'active-cost', data: { actionId: selected.action.id, cardName: selected.action.asCardName }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【道转】：弃置你的一张牌，视为使用所选基本牌',
      timeoutMs: 25_000, optional: false, cardIds: cards, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
    }) })
  },
  rescueActions(state, ownerId, dyingPlayerId) {
    return [
      ...(b55DaozhuanCanUse(state, ownerId, '桃', dyingPlayerId)
        ? [{ id: `rescue:${YJ_DAOZHUAN}:桃`, label: '道转：弃置你或当前回合角色的一张牌，视为使用【桃】' }]
        : []),
      ...(dyingPlayerId === ownerId && b55DaozhuanCanUse(state, ownerId, '酒', dyingPlayerId)
        ? [{ id: `rescue:${YJ_DAOZHUAN}:酒`, label: '道转：弃置你或当前回合角色的一张牌，视为使用【酒】自救' }]
        : []),
    ]
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    const cardName = (['桃', '酒'] as const).find((name) => actionId === `rescue:${YJ_DAOZHUAN}:${name}`)
    if (!cardName || !b55DaozhuanCanUse(host.state, ownerId, cardName, dyingPlayerId)) return false
    const own = b55DaozhuanCostOptions(host.state, ownerId, ownerId)
    const active = host.state.currentPlayerId && host.state.currentPlayerId !== ownerId
      ? b55DaozhuanCostOptions(host.state, host.state.currentPlayerId, ownerId) : null
    const cardIds = [...own.cardIds, ...(active?.cardIds ?? [])]
    const hiddenCardSlots = active?.hiddenCardSlots ?? []
    host.askSkill({ skillId: YJ_DAOZHUAN, ownerId, step: 'rescue-cost', data: { dyingPlayerId, cardName }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId,
      prompt: `【道转】：选择你或当前回合角色的一张牌置入弃牌堆，视为使用【${cardName}】`,
      timeoutMs: 25_000, optional: false, cardIds, hiddenCardSlots, min: 1, max: 1, purpose: 'skill',
    }) })
    return 'deferred'
  },
  virtualBasicResponse(state, ownerId, requiredCardName) {
    return !isCardResponseProhibited(state, ownerId, requiredCardName, skillIdsOf)
      && b55DaozhuanCanUse(state, ownerId, requiredCardName)
  },
  beginVirtualBasicResponse(host, ownerId, requiredCardName) {
    if (!['杀', '闪'].includes(requiredCardName)) return false
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === SHI_YUJI.id)
    const active = host.state.players.find((player) => player.id === host.state.currentPlayerId && player.alive)
    if (!owner) return false
    const ownOptions = b55DaozhuanCostOptions(host.state, ownerId, ownerId)
    const cardIds = [...ownOptions.cardIds]
    let hiddenCardSlots: string[] = []
    if (active && active.id !== ownerId) {
      const activeOptions = b55DaozhuanCostOptions(host.state, active.id, ownerId)
      cardIds.push(...activeOptions.cardIds)
      hiddenCardSlots = activeOptions.hiddenCardSlots
    }
    if (!cardIds.length && !hiddenCardSlots.length) return false
    host.askSkill({ skillId: YJ_DAOZHUAN, ownerId, step: 'response-cost', data: { requiredCardName }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId,
      prompt: `【道转】：选择你或当前回合角色的一张牌置入弃牌堆，视为打出【${requiredCardName}】`,
      timeoutMs: 25_000, optional: false, cardIds, hiddenCardSlots, min: 1, max: 1, purpose: 'skill',
    }) })
    return true
  },
  triggers: [{ event: 'CardResponded', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== YJ_DAOZHUAN) return
    const name = String((context.event.payload as { cardName?: string }).cardName ?? '')
    if (!['杀', '火杀', '雷杀', '闪', '桃', '酒'].includes(name)) return
    const state = host.state as B55State
    state.b55Daozhuan ??= {}
    const before = state.b55Daozhuan[ownerId]
    const entry = before?.round === state.roundNumber
      ? before : { turn: state.turnNumber, round: state.roundNumber, usedThisTurn: false, usedNames: [] }
    entry.turn = host.state.turnNumber
    entry.usedThisTurn = true
    if (!entry.usedNames.includes(name)) entry.usedNames.push(name)
    state.b55Daozhuan[ownerId] = entry
  } }, { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== YJ_DAOZHUAN) return
    const name = String((context.event.payload as { cardName?: string }).cardName ?? '')
    if (!['杀', '火杀', '雷杀', '闪', '桃', '酒'].includes(name)) return
    const state = host.state as B55State
    const entry = b55DaozhuanEntry(host.state, ownerId)
    entry.usedThisTurn = true
    if (!entry.usedNames.includes(name)) entry.usedNames.push(name)
    state.b55Daozhuan![ownerId] = entry
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'rescue-cost') {
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const sourceId = selected?.startsWith('hidden:') ? selected.split(':')[1]
        : selected && host.state.players.find((player) => locateOwnedCard(host.state, player.id, selected))?.id
      const activeId = host.state.currentPlayerId
      const dyingPlayerId = resolution.data.dyingPlayerId as PlayerId
      const cardName = resolution.data.cardName as '桃' | '酒'
      if (!selected || !sourceId || (sourceId !== ownerId && sourceId !== activeId)) return
      const eligible = b55DaozhuanCostOptions(host.state, sourceId, ownerId)
      if (!(selected.startsWith('hidden:') ? eligible.hiddenCardSlots.includes(selected) : eligible.cardIds.includes(selected))) return
      const cardId = resolvePickedCard(host.state, sourceId, selected)
      if (!cardId || !movePickedCard(host as never, sourceId, cardId, { kind: 'discardPile' })) return
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: YJ_DAOZHUAN },
        { sourceId: ownerId, targetId: sourceId, cardIds: [cardId] })
      const ledger = b55DaozhuanEntry(host.state, ownerId)
      if (sourceId === activeId) ledger.disabledRound = host.state.roundNumber
      ;(host.state as B55State).b55Daozhuan![ownerId] = ledger
      host.dispatch('CardResponded', { playerId: ownerId, cardId: null, cardName, virtual: true, reason: 'rescue' },
        { sourceId: ownerId, targetId: dyingPlayerId, sourceSkillId: YJ_DAOZHUAN })
      recover(host as never, dyingPlayerId, 1, ownerId)
      continueDyingAfterSkill(host as never)
      return
    }
    if (resolution.step === 'active-cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!cardId || !owner || !b55DaozhuanCostOptions(host.state, ownerId, ownerId).cardIds.includes(cardId)
        || !discardCardsByIds(host as never, ownerId, [cardId], YJ_DAOZHUAN).includes(cardId)) return
      const cardName = resolution.data.cardName as '杀' | '桃' | '酒'
      const card = b55DaozhuanVirtualCardId(host.state, ownerId, cardName)
      const ledger = b55DaozhuanEntry(host.state, ownerId)
      ledger.disabledRound = host.state.roundNumber
      ;(host.state as B55State).b55Daozhuan![ownerId] = ledger
      host.state.cards[card] = {
        id: card, ruleset: host.state.rulesetVersion, expansion: 'standard', name: cardName, suit: 'spade', rank: 1,
        color: 'black', category: 'basic', virtual: true, sourceSkillId: YJ_DAOZHUAN,
      }
      owner.zones.hand.push(card)
      const action = legalPlayActions(host.state, ownerId).find((candidate) => candidate.id === resolution.data.actionId
        && candidate.kind === 'use-card' && candidate.cardIds.includes(card))
      if (!action || action.kind !== 'use-card') {
        owner.zones.hand = owner.zones.hand.filter((id) => id !== card)
        delete host.state.cards[card]
        return
      }
      executeUseCardAction(host as never, ownerId, { ...action, sourceSkillId: YJ_DAOZHUAN })
      return
    }
    if (resolution.step !== 'response-cost') return
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    if (!selected) return
    const sourceId = selected.startsWith('hidden:') ? selected.split(':')[1]
      : host.state.players.find((player) => locateOwnedCard(host.state, player.id, selected))?.id
    const activeId = host.state.currentPlayerId
    if (!sourceId || (sourceId !== ownerId && sourceId !== activeId)) return
    const eligible = b55DaozhuanCostOptions(host.state, sourceId, ownerId)
    if (!(selected.startsWith('hidden:') ? eligible.hiddenCardSlots.includes(selected) : eligible.cardIds.includes(selected))) return
    const cardId = resolvePickedCard(host.state, sourceId, selected)
    if (!cardId || !movePickedCard(host as never, sourceId, cardId, { kind: 'discardPile' })) return
    host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: YJ_DAOZHUAN },
      { sourceId: ownerId, targetId: sourceId, cardIds: [cardId] })
    if (sourceId === activeId) {
      const state = host.state as B55State
      state.b55Daozhuan ??= {}
      const entry = b55DaozhuanEntry(host.state, ownerId)
      entry.disabledRound = host.state.roundNumber
      state.b55Daozhuan![ownerId] = entry
    }
    const responseName = String(resolution.data.requiredCardName ?? '闪')
    if (host.state.cardResolution?.kind === 'trick')
      completeVirtualTrickBasicResponse(host as never, ownerId, responseName, YJ_DAOZHUAN)
    else completeVirtualBasicResponse(host as never, ownerId, responseName, YJ_DAOZHUAN)
  },
})

// 【镇边】：用牌事件只记实体牌，结算后进弃牌堆的牌由 CardUsed 留下的清单排除。
registerSkillRuntime({ id: XJ_ZHENBIAN,
  triggers: [{ event: 'CardUsed', handle(host, _ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
    const ids = [...(payload.cardIds ?? []), ...(payload.cardId ? [payload.cardId] : [])]
    const state = host.state as B55State
    state.b55UsedCards = [...new Set([...(state.b55UsedCards ?? []), ...ids])]
  } }, { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; reason?: string }
    const cardId = payload.cardId
    if (!cardId) return
    const state = host.state as B55State
    const used = state.b55UsedCards ?? []
    const wasUsed = used.includes(cardId)
    state.b55UsedCards = used.filter((id) => id !== cardId)
    if (wasUsed) return
    const card = host.state.cards[cardId]
    if (!card) return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner || owner.characterId !== STAR_DONGZHUO.id) return
    const suits = state.b55ZhenbianSuits ??= {}
    const recorded = suits[ownerId] ??= []
    if (!recorded.includes(card.suit)) recorded.push(card.suit)
    if (recorded.length === 4 && owner.maxHp < 8) {
      delete suits[ownerId]
      gainMaxHp(host as never, ownerId, 1, XJ_ZHENBIAN, 8)
    }
  } }],
})

// 【暴袭】：两类弃牌各自按轮记次；失去上限与实体手牌转化使用均走公共结算。
registerSkillRuntime({ id: XJ_BAOXI,
  triggers: [{ event: 'LoseCard', handle(host, ownerId, context) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === STAR_DONGZHUO.id)
    if (!owner) return
    const payload = context.event.payload as { cardIds?: CardId[] }
    const cardIds = (payload.cardIds ?? []).filter((cardId) => host.state.zones.discardPile.includes(cardId))
    const basic = cardIds.filter((cardId) => host.state.cards[cardId]?.category === 'basic')
    const nonBasic = cardIds.filter((cardId) => !!host.state.cards[cardId] && host.state.cards[cardId].category !== 'basic')
    const state = host.state as B55State
    const used = state.b55BaoxiUsed ??= {}
    const entry = used[ownerId] ??= { basicRound: -1, nonBasicRound: -1 }
    if (basic.length >= 2 && entry.basicRound !== state.roundNumber && owner.zones.hand.length) {
      host.queueSkill({ skillId: XJ_BAOXI, ownerId, step: 'offer', data: { mode: 'basic' } })
    }
    if (nonBasic.length >= 2 && entry.nonBasicRound !== state.roundNumber && owner.zones.hand.length) {
      host.queueSkill({ skillId: XJ_BAOXI, ownerId, step: 'offer', data: { mode: 'non-basic' } })
    }
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === STAR_DONGZHUO.id)
    if (!owner?.zones.hand.length) return
    const mode = prompt.data.mode as 'basic' | 'non-basic'
    const state = host.state as B55State
    const used = state.b55BaoxiUsed?.[ownerId]
    if (mode === 'basic' ? used?.basicRound === state.roundNumber : used?.nonBasicRound === state.roundNumber) return
    host.askSkill({ skillId: XJ_BAOXI, ownerId, step: 'invoke', data: { mode }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: mode === 'basic' ? '【暴袭】：减1点体力上限，将一张手牌当【决斗】使用？'
        : '【暴袭】：减1点体力上限，将一张手牌当不计入次数且无次数限制的【杀】使用？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'invoke', label: '发动【暴袭】' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const mode = resolution.data.mode as 'basic' | 'non-basic'
    const state = host.state as B55State
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'invoke') return
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === STAR_DONGZHUO.id)
      if (!owner?.zones.hand.length) return
      const used = state.b55BaoxiUsed ??= {}
      const entry = used[ownerId] ??= { basicRound: -1, nonBasicRound: -1 }
      if (mode === 'basic') {
        if (entry.basicRound === state.roundNumber) return
        entry.basicRound = state.roundNumber
      } else {
        if (entry.nonBasicRound === state.roundNumber) return
        entry.nonBasicRound = state.roundNumber
      }
      loseMaxHp(host as never, ownerId, 1, XJ_BAOXI)
      if (!host.state.players.some((player) => player.id === ownerId && player.alive) || !owner.zones.hand.length) return
      const cardIds = [...owner.zones.hand]
      host.askSkill({ skillId: XJ_BAOXI, ownerId, step: 'pay-card', data: { mode }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【暴袭】：选择一张手牌作为转化牌',
        timeoutMs: 25_000, optional: false, cardIds, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
      }) })
      return
    }
    if (resolution.step === 'pay-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!cardId || !owner?.zones.hand.includes(cardId)) return
      const asName = mode === 'basic' ? '决斗' : '杀'
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
        && !isTargetProhibited(host.state, ownerId, player.id, asName, skillIdsOf, cardId)).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: XJ_BAOXI, ownerId, step: 'choose-target', data: { mode, cardId, candidateIds: candidates }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: `【暴袭】：选择【${asName}】目标`,
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'choose-target') return
    const cardId = resolution.data.cardId as CardId
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !host.state.players.some((player) => player.id === targetId && player.alive)) return
    if (mode === 'basic') host.beginVirtualTrick({ sourceId: ownerId, targetId, cardName: '决斗', sourceSkillId: XJ_BAOXI, cardId })
    else host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: XJ_BAOXI, cardId, countUsage: false })
  },
})

// 【阻进】：身份模式体力值并列最低也属于最低；牌名限制由实体/转化用牌统一历史记录管理。
registerSkillRuntime({ id: WJ_ZUJIN,
  viewAs(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    if (!owner?.alive || owner.characterId !== WANG_JING.id) return []
    const wounded = owner.hp < owner.maxHp
    const minHp = Math.min(...state.players.filter((player) => player.alive).map((player) => player.hp))
    const canSlash = !wounded || owner.hp !== minHp
    const ledger = (state as B55State).b55ZujinNames?.[ownerId]
    const used = ledger?.turn === state.turnNumber ? new Set(ledger.names) : new Set<string>()
    return owner.zones.hand.flatMap((cardId) => {
      const card = state.cards[cardId]
      if (card?.category !== 'basic') return []
      return [
        ...(canSlash && !used.has('杀') ? [{ asCardName: '杀', cardId, label: '阻进：基本牌当【杀】' }] : []),
        ...(!canSlash && !used.has('闪') ? [{ asCardName: '闪', cardId, label: '阻进：基本牌当【闪】' }] : []),
        ...(!canSlash && !used.has('无懈可击') ? [{ asCardName: '无懈可击', cardId, label: '阻进：基本牌当【无懈可击】' }] : []),
      ]
    })
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardName?: string }
    if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== WJ_ZUJIN || !['杀', '闪', '无懈可击'].includes(payload.cardName ?? '')) return
    const state = host.state as B55State
    const record = state.b55ZujinNames ??= {}
    const entry = record[ownerId] = record[ownerId]?.turn === state.turnNumber ? record[ownerId] : { turn: state.turnNumber, names: [] }
    if (!entry.names.includes(payload.cardName!)) entry.names.push(payload.cardName!)
  } }, { event: 'CardResponded', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardName?: string; playerId?: PlayerId }
    if ((payload.playerId ?? context.event.sourceId) !== ownerId || !['杀', '闪', '无懈可击'].includes(payload.cardName ?? '')) return
    const state = host.state as B55State
    const record = state.b55ZujinNames ??= {}
    const entry = record[ownerId] = record[ownerId]?.turn === state.turnNumber ? record[ownerId] : { turn: state.turnNumber, names: [] }
    if (!entry.names.includes(payload.cardName!)) entry.names.push(payload.cardName!)
  } }],
})

// 【节谏】：交牌时记录目标体力；目标回合内第一次成为唯一目标时可改为王经。
registerSkillRuntime({ id: WJ_JIEJIAN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (phase.playerId !== ownerId || phase.phase !== 'prepare' || !owner || owner.characterId !== WANG_JING.id) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (!candidates.length) return
    host.askSkill({ skillId: WJ_JIEJIAN, ownerId, step: 'gift-target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【节谏】：可选择一名其他角色并交给其任意张手牌',
      timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 1, max: 1,
    }) })
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
    const state = host.state as B55State
    const entry = targetId ? state.b55Jiejian?.[targetId] : null
    if (!entry || entry.ownerId !== ownerId) return
    delete state.b55Jiejian?.[targetId!]
    delete state.b55JiejianUsed?.[targetId!]
    const target = host.state.players.find((player) => player.id === targetId)
    if (target) delete target.marks['节谏']
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (owner && target && target.hp >= entry.hp) drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
  } }],
  interceptBystanderTarget(host, ownerId, context) {
    if (context.sourceId === ownerId || context.targetId === ownerId || context.category === 'equipment') return false
    const state = host.state as B55State
    const entry = state.b55Jiejian?.[context.targetId]
    if (entry?.ownerId !== ownerId || state.b55JiejianUsed?.[context.targetId] === host.state.turnNumber) return false
    const resolution = host.state.cardResolution
    const targetIds = resolution?.kind === 'trick' ? resolution.targetIds
      : resolution?.kind === 'slash' ? [resolution.targetId] : []
    if (targetIds.length !== 1 || targetIds[0] !== context.targetId) return false
    host.askSkill({ skillId: WJ_JIEJIAN, ownerId, step: 'redirect', data: { targetId: context.targetId, cardId: context.cardId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: `【节谏】：取消${host.state.players.find((player) => player.id === context.targetId)?.nickname ?? '该角色'}的目标，改由你成为目标并摸一张牌？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '取消其目标，改由你成为目标并摸一张牌' }],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as B55State
    if (resolution.step === 'gift-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive && player.id !== ownerId)
      if (!target) return
      const owner = host.state.players.find((player) => player.id === ownerId)
      const cardIds = owner?.zones.hand ?? []
      host.askSkill({ skillId: WJ_JIEJIAN, ownerId, step: 'gift-cards', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【节谏】：选择交给目标的手牌（可以不交）',
        timeoutMs: 25_000, optional: false, cardIds: [...cardIds], hiddenCardSlots: [], min: 0, max: cardIds.length, purpose: 'skill',
      }) })
      return
    }
    if (resolution.step === 'gift-cards') {
      const targetId = resolution.data.targetId as PlayerId
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!target || !owner) return
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const moved = cardIds.filter((cardId) => owner.zones.hand.includes(cardId))
      for (const cardId of moved) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      if (moved.length) {
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: moved, reason: WJ_JIEJIAN }, { sourceId: ownerId, targetId, cardIds: moved })
        host.dispatch('GainCard', { playerId: targetId, cardIds: moved, reason: WJ_JIEJIAN }, { sourceId: ownerId, targetId, cardIds: moved })
      }
      const table = state.b55Jiejian ??= {}
      if (table[targetId]) delete host.state.players.find((player) => player.id === targetId)?.marks['节谏']
      table[targetId] = { ownerId, hp: target.hp }
      target.marks['节谏'] = 1
      return
    }
    if (resolution.step !== 'redirect' || (response.payload as { optionId?: string }).optionId !== 'yes') {
      host.resumeCardTarget()
      return
    }
    const targetId = resolution.data.targetId as PlayerId
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner || !redirectCurrentCardTarget(host.state, targetId, ownerId)) {
      host.resumeCardTarget()
      return
    }
    state.b55JiejianUsed ??= {}
    state.b55JiejianUsed[targetId] = host.state.turnNumber
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    host.resumeCardTarget()
  },
})

// 【迎驾】：记录回合内同名锦囊使用，发动后通过正式额外回合队列插入回合。
registerSkillRuntime({ id: DZ_YINGJIA, limited: true,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardName?: string }
    const card = context.event.cardIds?.map((id) => host.state.cards[id]).find(Boolean)
    const usedCard = card ?? (payload.cardName ? Object.values(host.state.cards).find((entry) => entry.name === payload.cardName) : undefined)
    if (usedCard?.category !== 'trick') return
    const state = host.state as B55State
    const log = state.b55DongzhaoUses ??= {}
    const entry = log[ownerId] = log[ownerId]?.turn === state.turnNumber ? log[ownerId] : { turn: state.turnNumber, trickNames: [] }
    entry.trickNames.push(payload.cardName ?? usedCard.name)
    const counts = new Map<string, number>()
    for (const name of entry.trickNames) counts.set(name, (counts.get(name) ?? 0) + 1)
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    const endingPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId
    const state = host.state as B55State
    const entry = state.b55DongzhaoUses?.[ownerId]
    if (endingPlayerId !== ownerId || entry?.turn !== state.turnNumber) return
    const counts = new Map<string, number>()
    for (const name of entry.trickNames) counts.set(name, (counts.get(name) ?? 0) + 1)
    if ([...counts.values()].some((count) => count >= 2)
      && !host.state.players.find((player) => player.id === ownerId)?.usedLimitedSkills.includes(DZ_YINGJIA)) {
      host.queueSkill({ skillId: DZ_YINGJIA, ownerId, step: 'discard-cost', data: {} })
    }
  } }, { event: 'TurnStart', handle(host, _ownerId, context) {
    const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
    const state = host.state as B55State
    if (targetId && state.b55YingjiaDraw?.[targetId]) {
      delete state.b55YingjiaDraw[targetId]
      drawCards(host.state, host.rng, targetId, 2, (name, payload) => host.dispatch(name, payload))
    }
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-cost') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner || owner.usedLimitedSkills.includes(DZ_YINGJIA) || !owner.zones.hand.length) return
    const cardIds = [...owner.zones.hand]
    host.askSkill({ skillId: DZ_YINGJIA, ownerId, step: 'discard-cost', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【迎驾】：可弃置一张手牌，令一名角色执行额外回合；该回合开始时摸两张牌',
      timeoutMs: 25_000, optional: true, cardIds, hiddenCardSlots: [], min: 0, max: 1, purpose: 'skill',
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard-cost') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!selected || !owner?.zones.hand.includes(selected)) return
      moveCard(host.state, selected, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      owner.usedLimitedSkills.push(DZ_YINGJIA)
      const targets = host.state.players.filter((player) => player.alive).map((player) => player.id)
      host.askSkill({ skillId: DZ_YINGJIA, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【迎驾】：选择执行额外回合的角色', timeoutMs: 25_000,
        optional: false, candidateIds: targets, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !host.state.players.some((player) => player.id === targetId && player.alive)) return
    queueExtraTurn(host.state, targetId, { skillId: DZ_YINGJIA, playerId: ownerId })
    const state = host.state as B55State
    state.b55YingjiaDraw ??= {}
    state.b55YingjiaDraw[targetId] = (state.b55YingjiaDraw[targetId] ?? 0) + 1
  },
})

// 【妄专】非牌来源伤害后摸牌；失效由公共技能封锁入口在随后补齐。
registerSkillRuntime({ id: ZB_WANGZHUAN,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: string | null; finalAmount?: number }
    if ((context.event.sourceId !== ownerId && context.event.targetId !== ownerId) || payload.cardId != null || (payload.finalAmount ?? 0) <= 0) return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner) return
    host.queueSkill({ skillId: ZB_WANGZHUAN, ownerId, step: 'invoke-after-damage', data: { turnPlayerId: host.state.currentPlayerId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke-after-damage') return
    host.askSkill({ skillId: ZB_WANGZHUAN, ownerId, step: 'invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【妄专】：你可以摸一张牌，然后令当前回合角色本回合非锁定技失效',
      timeoutMs: 25_000, optional: true, options: [{ id: 'invoke', label: '摸一张牌并令其非锁定技失效' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'invoke') return
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    const targetId = resolution.data.turnPlayerId as PlayerId | null
    if (!targetId || !host.state.players.some((player) => player.id === targetId && player.alive)) return
    suppressSkill(host.state, { targetId, sourceId: ownerId, sourceSkillId: ZB_WANGZHUAN, scope: 'non-locked', armedAtTurn: host.state.turnNumber - 1 })
  },
})

// 【惩凶】：X 在每次出牌阶段开始时归零，并包含当前这张锦囊牌的使用次数。
registerSkillRuntime({ id: ZB_CHENGXIONG,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (event.playerId !== ownerId || event.phase !== 'play') return
    ;(host.state as B55State).b55ZhangbuUses ??= {}
    ;(host.state as B55State).b55ZhangbuUses![ownerId] = { turn: host.state.turnNumber, count: 0 }
  } }, { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    const state = host.state as B55State
    const record = state.b55ZhangbuUses ??= {}
    const entry = record[ownerId] = record[ownerId]?.turn === state.turnNumber ? record[ownerId] : { turn: state.turnNumber, count: 0 }
    entry.count += 1
  } }, { event: 'TargetSpecified', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    const cardId = payload.cardId ?? context.event.cardIds?.[0]
    const targetIds = payload.targetIds ?? []
    const cardName = payload.cardName ?? (cardId ? host.state.cards[cardId]?.name : undefined)
    if (!cardId || (!INSTANT_TRICKS.has(cardName ?? '') && !DELAYED_TRICKS.has(cardName ?? ''))
      || !targetIds.length || targetIds.some((id) => id === ownerId)) return
    const state = host.state as B55State
    const x = state.b55ZhangbuUses?.[ownerId]?.count ?? 0
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
      && (player.zones.hand.length + player.zones.judgingArea.length + Object.values(player.zones.equipment).filter(Boolean).length) >= x)
      .map((player) => player.id)
    if (!candidates.length) return
    host.queueSkill({ skillId: ZB_CHENGXIONG, ownerId, step: 'choose-target', data: { cardId, cardName, candidates, x } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-target') return
    const candidates = (prompt.data.candidates as PlayerId[]).filter((id) => host.state.players.some((player) => player.id === id && player.alive))
    if (!candidates.length) return
    host.askSkill({ skillId: ZB_CHENGXIONG, ownerId, step: 'choose-target', data: prompt.data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: `【惩凶】：选择一名牌数至少为${prompt.data.x}的其他角色，弃置其一张牌`,
      timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
      if (!target) return
      const pickable = pickableCardsOf(host.state, targetId!, { discarderId: ownerId })
      if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
      host.askSkill({ skillId: ZB_CHENGXIONG, ownerId, step: 'discard', data: { targetId, cardId: resolution.data.cardId, cardName: resolution.data.cardName }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【惩凶】：弃置${target.nickname}一张牌`, timeoutMs: 25_000,
        optional: false, cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1, purpose: 'skill',
      }) })
      return
    }
    if (resolution.step !== 'discard') return
    const targetId = resolution.data.targetId as PlayerId
    const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = picked && resolvePickedCard(host.state, targetId, picked)
    if (!cardId || !movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) return
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: ZB_CHENGXIONG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    const trickCardId = resolution.data.cardId as CardId
    const card = host.state.cards[trickCardId]
    if (card && effectiveCardColor(host.state, targetId, cardId, skillIdsOf) === effectiveCardColor(host.state, ownerId, trickCardId, skillIdsOf)
      && effectiveCardColor(host.state, ownerId, trickCardId, skillIdsOf) !== null
      && host.state.players.some((player) => player.id === ownerId && player.alive)) {
      resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: [targetId], amount: 1, nature: 'normal', cardId: null, cardName: '惩凶' })
    }
  },
})
