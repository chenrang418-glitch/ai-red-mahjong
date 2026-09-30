import type { CharacterDefinition } from './types'
import { drawCards } from '../../engine/draw'
import { gainArmor } from '../../engine/armor'
import { recover } from '../../engine/recover'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { canTarget, getAttackRange, getDistance } from '../../engine/distance'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { giveCards } from '../../engine/hand-transfer'
import { restoreCharacter } from '../../engine/character-state'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { effectiveKingdomOf } from '../../engine/huashen'
import { skipPhase } from '../../engine/turn'
import { effectiveCardColor, prohibitsBeingPindianTargetOf, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { canPindian, registerPindianContinuation, startPindian } from '../../engine/pindian'
import { getEngineCallbacks } from '../../engine/equipment-requests'
import { resumeDamageModifier, resolveDamage } from '../../engine/damage'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'
import { getCharacter } from './standard'

const B52 = ':b52'
const skill = (id: string) => `${id}${B52}`

const MOU_DA_QIAO: CharacterDefinition = {
  id: 'mou-daqiao-b52', name: '谋·大乔', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('guose-mou-daqiao'), name: '国色', description: '出牌阶段限四次，你可以将一张方块牌当【乐不思蜀】使用，或弃置场上一张【乐不思蜀】。然后你摸一张牌。' },
    { id: skill('liuli-mou-daqiao'), name: '流离', description: '当你成为【杀】的目标时，你可以弃置一张牌并选择你攻击范围内的一名其他角色（不能是此【杀】的使用者），然后将此【杀】转移给该角色。每名角色的回合限一次，若你弃置的是红桃牌，你可令一名其他角色（不能是此【杀】的使用者）获得“流离”标记（若场上已有“流离”标记则改为转移给该角色）。拥有“流离”标记的角色回合开始时，执行一个额外的出牌阶段并令其移除“流离”标记。' },
  ],
}

const MOU_MENGHUO: CharacterDefinition = {
  id: 'mou-menghuo-b52', name: '谋·孟获', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('huoshou-mou-menghuo'), name: '祸首', description: '锁定技，【南蛮入侵】对你无效；当其他角色使用【南蛮入侵】指定目标后，你代替其成为此牌造成的伤害的来源。出牌阶段开始时，你随机获得弃牌堆中一张【南蛮入侵】。出牌阶段，若你使用过【南蛮入侵】，则你此阶段不能使用【南蛮入侵】。' },
    { id: skill('zaiqi-mou-menghuo'), name: '再起', description: '蓄力技（0/7），弃牌阶段结束时，你可以选择任意名角色并扣除等量蓄力点，然后令你选择的角色各选择一项：1.令你摸一张牌；2.弃置一张牌，然后你回复1点体力。当你造成伤害后，获得1点蓄力点（每回合限获得1点蓄力点）。' },
  ],
}

const JIE_CAOXIU: CharacterDefinition = {
  id: 'jie-caoxiu-b52', name: '界·曹休', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'wind',
  skills: [
    { id: skill('qianju-jie-caoxiu'), name: '千驹', description: '锁定技，若你已受伤，你计算与其他角色距离时-X（X为你已损失体力值）。' },
    { id: skill('qingxi-jie-caoxiu'), name: '倾袭', description: '每回合限一次，当你对其他角色造成伤害时，你可以令其选择一项：1.弃置Y张手牌（Y为4-你与其距离，且至少为1）；2.令此伤害+1。' },
  ],
}

const MOU_SUNCE: CharacterDefinition = {
  id: 'mou-sunce-b52', name: '谋·孙策', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('jiang-mou-sunce'), name: '激昂', description: '一级：你使用【决斗】可以额外指定一名目标，若如此做，你流失1点体力。当你使用【决斗】或红色【杀】指定一名目标后，或成为【决斗】或红色【杀】的目标后，你摸一张牌。出牌阶段限一次，你可以将所有手牌当【决斗】使用。二级：你使用【决斗】可以额外指定一名目标，若如此做，你流失1点体力。当你使用【决斗】或红色【杀】指定一名目标后，或成为【决斗】或红色【杀】的目标后，你摸一张牌。出牌阶段限X次（X为场上吴势力角色数），你可以将所有手牌当【决斗】使用。' },
    { id: skill('hunzi-mou-sunce'), name: '魂姿', description: '觉醒技，你脱离濒死状态时，你减1点体力上限、获得1点护甲、摸三张牌，然后获得技能“英姿※”和“英魂※”。' },
    { id: skill('zhiba-mou-sunce'), name: '制霸', description: '主公技，限定技，当你进入濒死状态时，你可回复X点体力（X为场上吴势力角色数量-1）并升级技能“激昂”，然后其他吴势力角色依次受到1点无来源伤害；若其因此死亡，你摸三张牌。' },
    { id: skill('yingzi-mou-sunce-awakened'), name: '英姿※', description: '锁定技，摸牌阶段，你每满足以下一项便多摸一张牌且本回合手牌上限+1：1.手牌数不少于2；2.体力值不少于2；3.装备区有牌。', granted: true },
    { id: skill('yinghun-mou-sunce-awakened'), name: '英魂※', description: '准备阶段，若你已受伤，你可以选择一名其他角色并选择一项：1.令其摸X张牌，然后弃置一张牌；2.令其摸一张牌，然后弃置X张牌（X为你已损失的体力值）。', granted: true },
  ],
}

const GUO_NUWANG: CharacterDefinition = {
  id: 'guonuwang-b52', name: '郭女王', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('yichong-guonuwang'), name: '易宠', description: '准备阶段，你可以选择一名其他角色并指定一种花色，获得其所有该花色的牌，并直到你下个回合开始令其获得“雀”标记（若场上已有“雀”标记，则转移给该角色）。拥有“雀”标记的角色获得下一张你指定花色的牌时，你获得此牌。' },
    { id: skill('wufei-guonuwang'), name: '诬诽', description: '你的【杀】或伤害类普通锦囊即将造成的伤害，视为由拥有“雀”标记的角色作为伤害来源造成的。你受到伤害后，若拥有“雀”的角色体力值大于3，你可以令其受到1点无来源伤害。' },
  ],
}

const XING_WEIYAN: CharacterDefinition = {
  id: 'xing-weiyan-b52', name: '星·魏延', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('guli-xing-weiyan'), name: '孤厉', description: '出牌阶段限一次，你可以将所有手牌当一张无视目标防具的普通【杀】使用。此牌结算结束后，若此牌造成过伤害，你可以失去1点体力，然后将手牌摸至X张（X为你的体力上限）。' },
    { id: skill('aosi-xing-weiyan'), name: '骜肆', description: '锁定技，当你于出牌阶段对一名在你攻击范围内的其他角色造成伤害后，你于此阶段对其使用牌不受次数限制。' },
  ],
}

const JIE_ZHUHUAN: CharacterDefinition = {
  id: 'jie-zhuhuan-b52', name: '界·朱桓', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'wind',
  skills: [
    { id: skill('fenli-jie-zhuhuan'), name: '奋励', description: '若你的手牌数为全场最多，你可以跳过摸牌阶段；若你的体力值为全场最多，你可以跳过出牌阶段；若你的装备区有牌且数量为全场最多，你可以跳过弃牌阶段。' },
    { id: skill('pingkou-jie-zhuhuan'), name: '平寇', description: '回合结束后，你可以对至多X名其他角色各造成1点伤害（X为你本回合跳过的阶段数），若如此做，你从牌堆中随机获得一张装备牌。' },
  ],
}

const MOU_ZHURONG: CharacterDefinition = {
  id: 'mou-zhurong-b52', name: '谋·祝融', kingdom: 'shu', gender: 'female', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('lieren-mou-zhurong'), name: '烈刃', description: '当你使用【杀】指定一名其他角色为唯一目标后，你可以与其拼点。若你赢，此【杀】结算结束后，你可以对另一名其他角色造成1点伤害。' },
    { id: skill('juxiang-mou-zhurong'), name: '巨象', description: '锁定技，【南蛮入侵】对你无效；当其他角色使用的【南蛮入侵】结算结束后，你获得之。结束阶段，若你本回合未使用过【南蛮入侵】，你随机从游戏外将一张【南蛮入侵】交给一名角色。' },
  ],
}

const YANXIANG: CharacterDefinition = {
  id: 'yanxiang-b52', name: '阎象', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('kujian-yanxiang'), name: '苦谏', description: '出牌阶段限一次，你可以将至多两张手牌标记为“谏”并交给一名其他角色。当其他角色使用或打出“谏”牌时，你与其各摸两张牌。当其他角色非因使用或打出从手牌区失去“谏”牌时，你与其各弃置一张牌。' },
    { id: skill('ruilian-yanxiang'), name: '睿敛', description: '每轮开始时，你可以选择一名角色。该角色接下来的一个回合结束时，若其此回合弃置过牌，你可以选择一种类型（其此回合须弃置过此类型的牌），然后你与该角色依次从弃牌堆中随机获得一张此类型的牌。' },
  ],
}

const XING_ZHOUBUYI: CharacterDefinition = {
  id: 'xing-zhoubuyi-b52', name: '星·周不疑', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('huiyao-xing-zhoubuyi'), name: '慧夭', description: '出牌阶段限一次，你可以受到1点无来源伤害。若如此做，你须选择一名其他角色，令其视为对另一名你选择的角色造成过1点伤害。' },
    { id: skill('quesong-xing-zhoubuyi'), name: '雀颂', description: '一名角色的结束阶段，若你于此回合内受到过伤害，则你可以令一名角色选择一项执行：1.摸三张牌并复原武将牌（若其装备区的牌数不小于3，则摸牌数改为2）；2.回复1点体力。' },
  ],
}

export const HISTORICAL_BATCH52_CHARACTERS: readonly CharacterDefinition[] = [
  MOU_DA_QIAO, MOU_MENGHUO, JIE_CAOXIU, MOU_SUNCE, GUO_NUWANG,
  XING_WEIYAN, JIE_ZHUHUAN, MOU_ZHURONG, YANXIANG, XING_ZHOUBUYI,
]

type Batch52State = SanguoshaState & {
  b52GuoseDraw?: Record<string, PlayerId>
  b52ZaiqiTurn?: Record<string, number>
  b52Liuli?: Record<string, { sourceId: PlayerId; turnNumber: number }>
  b52LiuliExtraPlay?: Record<PlayerId, true>
  b52GuoQue?: Record<string, { targetId: PlayerId; suit: string; expiresAtTurn: number }>
  b52MarkedCards?: Record<string, { ownerId: PlayerId; giverId: PlayerId }>
  b52DiscardedByTurn?: Record<string, { turnNumber: number; cardIds: CardId[] }>
  b52ChuxiSkipped?: Record<string, number>
  b52ZhurongDuel?: Record<string, { targetId: PlayerId; won: boolean }>
  b52SunceAwake?: Record<string, boolean>
  b52SunceLimit?: Record<string, number>
  b52SunceDuelUses?: Record<string, number>
  b52SunceJiangUpgraded?: Record<string, boolean>
  b52SunceDuel?: Record<string, { targets: PlayerId[]; index: number }>
  b52GuoMarker?: { ownerId: PlayerId; targetId: PlayerId; suit: string; expiresAtTurn: number }
  b52WeiyanDamage?: Record<string, PlayerId>
  b52WeiyanHit?: Record<string, boolean>
  b52ZhuHuanSkipped?: Record<string, number>
  b52ZhouDamageTurn?: Record<string, number>
  b52NamanUsedTurn?: number
  b52ZhurongCurrentCard?: Record<string, CardId>
  b52Kujian?: Record<string, { ownerId: PlayerId; recipientId: PlayerId }>
  b52KujianLeaving?: Record<string, { ownerId: PlayerId; recipientId: PlayerId }>
  b52RuilianTarget?: Record<string, PlayerId>
  b52RuilianDiscards?: Record<string, { turnNumber: number; cardIds: CardId[] }>
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function livingOthers(state: SanguoshaState, playerId: PlayerId) {
  return state.players.filter((player) => player.alive && player.id !== playerId)
}

function requestCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, targetId: PlayerId,
  cardIds: CardId[], min: number, max: number, prompt: string, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data,
    build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId, prompt,
      timeoutMs: 30_000, optional, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max }) })
}

function requestTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  candidates: PlayerId[], min: number, max: number, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data,
    build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt,
      timeoutMs: 30_000, optional, candidateIds: candidates, min, max }) })
}

function chooseOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, targetId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data,
    build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: targetId, prompt,
      timeoutMs: 30_000, optional, options }) })
}

function discardOwned(host: SkillHost, playerId: PlayerId, cardIds: CardId[], reason: string): CardId[] {
  const discarded: CardId[] = []
  for (const cardId of cardIds) {
    const from = locateOwnedCard(host.state, playerId, cardId)
    if (!from || !['hand', 'equipment'].includes(from.kind)) continue
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') host.dispatch('LoseEquipment', { playerId, cardId, slot: from.slot, reason }, { targetId: playerId, cardIds: [cardId] })
    discarded.push(cardId)
  }
  if (discarded.length) host.dispatch('LoseCard', { playerId, cardIds: discarded, reason }, { sourceId: playerId, cardIds: discarded })
  return discarded
}

const DAQIAO_GUOSE = skill('guose-mou-daqiao')
const DAQIAO_LIULI = skill('liuli-mou-daqiao')
const MENGHUO_HUOSHOU = skill('huoshou-mou-menghuo')
const MENGHUO_ZAIQI = skill('zaiqi-mou-menghuo')
const CAOXIU_QIANJU = skill('qianju-jie-caoxiu')
const CAOXIU_QINGXI = skill('qingxi-jie-caoxiu')
const SUNCE_JIANG = skill('jiang-mou-sunce')
const SUNCE_HUNZI = skill('hunzi-mou-sunce')
const SUNCE_ZHIBA = skill('zhiba-mou-sunce')
const SUNCE_YINGZI = skill('yingzi-mou-sunce-awakened')
const SUNCE_YINGHUN = skill('yinghun-mou-sunce-awakened')
const GUO_YICHONG = skill('yichong-guonuwang')
const GUO_WUFEI = skill('wufei-guonuwang')
const WEIYAN_GULI = skill('guli-xing-weiyan')
const WEIYAN_AOSI = skill('aosi-xing-weiyan')
const ZHUHUAN_FENLI = skill('fenli-jie-zhuhuan')
const ZHUHUAN_PINGKOU = skill('pingkou-jie-zhuhuan')
const ZHURONG_LIEREN = skill('lieren-mou-zhurong')
const ZHURONG_JUXIANG = skill('juxiang-mou-zhurong')
const YANXIANG_KUJIAN = skill('kujian-yanxiang')
const YANXIANG_RUILIAN = skill('ruilian-yanxiang')
const ZHOUBUYI_HUIYAO = skill('huiyao-xing-zhoubuyi')
const ZHOUBUYI_QUESONG = skill('quesong-xing-zhoubuyi')

function validUseActions(state: SanguoshaState, playerId: PlayerId, cardId: CardId, cardName: string) {
  return declaredCardActions(state, playerId, cardId, cardName, `使用【${cardName}】`)
    .filter((action): action is Extract<import('../../engine/actions').LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
}

// 【千驹】的距离修正完整走通用距离结算，因此进攻距离和被动目标判断一致。
registerSkillRuntime({ id: CAOXIU_QIANJU,
  distanceModifier: { toOthers: (state, ownerId) => -Math.max(0, (playerOf(state, ownerId)?.maxHp ?? 0) - (playerOf(state, ownerId)?.hp ?? 0)) },
})

// 【倾袭】在原伤害上交互式加伤；弃牌分支仍由目标选择，且整次结算只计一次。
registerSkillRuntime({ id: CAOXIU_QINGXI,
  offersDamageModifierAsk(host, ownerId, side, context) {
    if (side !== 'source' || context.sourceId !== ownerId || context.targetId === ownerId
      || !playerOf(host.state, ownerId)?.alive || usedThisTurn(host.state, ownerId, CAOXIU_QINGXI)) return false
    const target = playerOf(host.state, context.targetId)
    if (!target?.alive) return false
    const required = Math.max(1, 4 - getDistance(host.state, ownerId, target.id))
    chooseOption(host, CAOXIU_QINGXI, ownerId, 'activate', ownerId, '【倾袭】：是否发动？',
      [{ id: 'yes', label: '发动【倾袭】' }, { id: 'no', label: '不发动' }], { targetId: target.id, required }, true)
    return true
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { targetId?: PlayerId; required?: number }
    const payload = response.payload as { optionId?: string; cardIds?: CardId[] }
    if (resolution.step === 'activate') {
      if (payload.optionId !== 'yes' || !playerOf(host.state, ownerId)?.alive
        || !playerOf(host.state, data.targetId ?? '')?.alive) {
        resumeDamageModifier(host as never, CAOXIU_QINGXI, 0)
        return
      }
      markUsedThisTurn(host.state, ownerId, CAOXIU_QINGXI)
      const target = playerOf(host.state, data.targetId!)!
      const required = Math.max(1, 4 - getDistance(host.state, ownerId, target.id))
      const canDiscard = target.zones.hand.length >= required
      chooseOption(host, CAOXIU_QINGXI, ownerId, 'target-choice', target.id, '【倾袭】：选择一项', [
        ...(canDiscard ? [{ id: 'discard', label: `弃置${required}张手牌` }] : []),
        { id: 'damage', label: '令此伤害+1' },
      ], { targetId: target.id, required }, false)
      return
    }
    if (resolution.step === 'target-choice') {
      const target = playerOf(host.state, data.targetId ?? '')
      if (payload.optionId === 'damage') { resumeDamageModifier(host as never, CAOXIU_QINGXI, 1); return }
      if (!target?.alive || payload.optionId !== 'discard') { resumeDamageModifier(host as never, CAOXIU_QINGXI, 0); return }
      const required = Math.max(1, 4 - getDistance(host.state, ownerId, target.id))
      if (target.zones.hand.length < required) { resumeDamageModifier(host as never, CAOXIU_QINGXI, 0); return }
      requestCards(host, CAOXIU_QINGXI, ownerId, 'discard', target.id, [...target.zones.hand], required, required,
        `【倾袭】：弃置${required}张手牌`, { targetId: target.id, required }, false)
      return
    }
    if (resolution.step === 'discard') {
      const target = playerOf(host.state, data.targetId ?? '')
      const selected = payload.cardIds ?? []
      const required = Math.max(1, 4 - getDistance(host.state, ownerId, data.targetId ?? ''))
      const valid = target?.alive && selected.length === required && selected.every((id) => target.zones.hand.includes(id))
      if (valid) discardOwned(host, target!.id, selected, CAOXIU_QINGXI)
      resumeDamageModifier(host as never, CAOXIU_QINGXI, 0)
    }
  },
})

// 【流离】逐张杀结算时替换当前目标；红桃成本另行授予一次真实额外出牌阶段。
registerSkillRuntime({ id: DAQIAO_LIULI,
  interceptTarget(host, ownerId, context) {
    if (context.targetId !== ownerId || context.cardName !== '杀') return false
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, context.sourceId)
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
      && target.id !== context.sourceId && getDistance(host.state, ownerId, target.id) <= getAttackRange(host.state, ownerId)
      && canTarget(host.state, context.sourceId, target.id))
    if (!owner?.alive || !source?.alive || !candidates.length
      || (host.state as Batch52State).b52Liuli?.[ownerId]?.turnNumber === host.state.turnNumber) return false
    const costs = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (!costs.length) return false
    requestCards(host, DAQIAO_LIULI, ownerId, 'pay', ownerId, costs, 1, 1, '【流离】：弃置一张牌并转移此【杀】',
      { sourceId: context.sourceId, cardId: context.cardId, candidates: candidates.map((target) => target.id) }, true)
    return true
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { sourceId: PlayerId; cardId: CardId; candidates: PlayerId[]; cardCost?: CardId; redirectId?: PlayerId; heartCost?: boolean }
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pay') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!owner?.alive || !cardId || ![...owner.zones.hand, ...Object.values(owner.zones.equipment)].includes(cardId)) {
        host.resumeCardTarget(); return
      }
      const suit = host.state.cards[cardId]?.suit
      if (!discardOwned(host, ownerId, [cardId], DAQIAO_LIULI).length) { host.resumeCardTarget(); return }
      const legal = data.candidates.filter((id) => {
        const target = playerOf(host.state, id)
        return target?.alive && id !== data.sourceId && getDistance(host.state, ownerId, id) <= getAttackRange(host.state, ownerId)
          && canTarget(host.state, data.sourceId, id)
      })
      if (!legal.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: DAQIAO_LIULI, ownerId, step: 'redirect', data: { ...data, cardCost: cardId, heartCost: suit === 'heart' },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【流离】：选择此【杀】的新目标', timeoutMs: 30_000, optional: false,
          candidateIds: legal, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'redirect') {
      const redirectId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const legal = redirectId && data.candidates.includes(redirectId) && playerOf(host.state, redirectId)?.alive
        && redirectId !== data.sourceId && getDistance(host.state, ownerId, redirectId) <= getAttackRange(host.state, ownerId)
        && canTarget(host.state, data.sourceId, redirectId)
      if (!legal || !owner?.alive) { host.resumeCardTarget(); return }
      const state = host.state as Batch52State
      state.b52Liuli ??= {}
      state.b52Liuli[ownerId] = { sourceId: data.sourceId, turnNumber: host.state.turnNumber }
      const cardCost = data.cardCost!
      if (data.heartCost) {
        const candidates = host.state.players.filter((target) => target.alive && target.id !== data.sourceId && target.id !== ownerId).map((target) => target.id)
        if (candidates.length) {
          requestTargets(host, DAQIAO_LIULI, ownerId, 'grant-extra-play', '【流离】：选择一名角色获得“流离”标记',
            candidates, 1, 1, { sourceId: data.sourceId, cardId: data.cardId, redirectId, cardCost })
          return
        }
      }
      getEngineCallbacks()?.transferSlashTarget(host, redirectId, '流离')
      return
    }
    if (resolution.step === 'grant-extra-play') {
      const recipientId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const recipient = recipientId ? playerOf(host.state, recipientId) : undefined
      if (recipient?.alive && recipientId !== data.sourceId) {
        const state = host.state as Batch52State
        state.b52LiuliExtraPlay ??= {}
        for (const id of Object.keys(state.b52LiuliExtraPlay)) delete state.b52LiuliExtraPlay[id]
        state.b52LiuliExtraPlay[recipient.id] = true
      }
      const redirectId = data.redirectId
      if (redirectId && playerOf(host.state, redirectId)?.alive) getEngineCallbacks()?.transferSlashTarget(host, redirectId, '流离')
      else host.resumeCardTarget()
    }
  },
  extraPhaseAtTurnStart(state, ownerId) {
    return (state as Batch52State).b52LiuliExtraPlay?.[ownerId] ? 'play' : null
  },
  triggers: [{ event: 'TurnStart', handle(host, ownerId) {
    const state = host.state as Batch52State
    delete state.b52LiuliExtraPlay?.[ownerId]
  } }],
})

// 【国色】两种效果共享同一出牌阶段次数；使用牌走普通延时锦囊流程，拆牌走区域移动。
registerSkillRuntime({ id: DAQIAO_GUOSE,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.characterId !== MOU_DA_QIAO.id || state.phase !== 'play'
      || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, DAQIAO_GUOSE)) return []
    const canUse = owner.zones.hand.some((id) => state.cards[id]?.suit === 'diamond'
      && validUseActions(state, ownerId, id, '乐不思蜀').length > 0)
    const canRemove = state.players.some((target) => target.alive
      && target.zones.judgingArea.some((id) => state.cards[id]?.name === '乐不思蜀'))
    return canUse || canRemove ? [{ id: `skill:${DAQIAO_GUOSE}`, label: '国色：使用方块牌或弃置场上一张【乐不思蜀】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${DAQIAO_GUOSE}` || usedThisPhase(host.state, ownerId, DAQIAO_GUOSE)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const useCards = owner.zones.hand.filter((id) => host.state.cards[id]?.suit === 'diamond'
      && validUseActions(host.state, ownerId, id, '乐不思蜀').length > 0)
    const delayed = host.state.players.filter((target) => target.alive
      && target.zones.judgingArea.some((id) => host.state.cards[id]?.name === '乐不思蜀'))
    const options = [
      ...(useCards.length ? [{ id: 'use', label: '将一张方块牌当【乐不思蜀】使用' }] : []),
      ...(delayed.length ? [{ id: 'remove', label: '弃置场上一张【乐不思蜀】并摸一张牌' }] : []),
    ]
    if (!options.length) return
    chooseOption(host, DAQIAO_GUOSE, ownerId, 'mode', ownerId, '【国色】：选择一项', options, {}, false)
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; cardIds?: CardId[]; targetIds?: PlayerId[] }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'mode') {
      if (payload.optionId === 'use') {
        const candidates = owner.zones.hand.filter((id) => host.state.cards[id]?.suit === 'diamond'
          && validUseActions(host.state, ownerId, id, '乐不思蜀').length > 0)
        if (candidates.length) requestCards(host, DAQIAO_GUOSE, ownerId, 'use-card', ownerId, candidates, 1, 1,
          '【国色】：选择一张方块手牌', {}, false)
        return
      }
      if (payload.optionId === 'remove') {
        const targets = host.state.players.filter((target) => target.alive
          && target.zones.judgingArea.some((id) => host.state.cards[id]?.name === '乐不思蜀')).map((target) => target.id)
        if (targets.length) requestTargets(host, DAQIAO_GUOSE, ownerId, 'remove-target', '【国色】：选择一名有【乐不思蜀】的角色', targets, 1, 1, {}, false)
        return
      }
    }
    if (resolution.step === 'use-card') {
      const cardId = payload.cardIds?.[0]
      if (!cardId || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.suit !== 'diamond') return
      const actions = validUseActions(host.state, ownerId, cardId, '乐不思蜀')
      const targets = [...new Set(actions.flatMap((action) => action.targetIds))]
      if (!targets.length) return
      host.askSkill({ skillId: DAQIAO_GUOSE, ownerId, step: 'use-target', data: { cardId, targets },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【国色】：选择【乐不思蜀】的目标', timeoutMs: 30_000, optional: false,
          candidateIds: targets, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'use-target') {
      const useTargetData = resolution.data as { cardId: CardId; targets: PlayerId[] }
      const cardId = useTargetData.cardId
      const targetId = payload.targetIds?.[0]
      if (!targetId || !owner.zones.hand.includes(cardId) || !useTargetData.targets.includes(targetId)) return
      const action = validUseActions(host.state, ownerId, cardId, '乐不思蜀')
        .find((candidate) => candidate.targetIds.includes(targetId))
      if (!action) return
      markUsedThisPhase(host.state, ownerId, DAQIAO_GUOSE)
      ;((host.state as Batch52State).b52GuoseDraw ??= {})[cardId] = ownerId
      executeUseCardAction(host as never, ownerId, action)
      return
    }
    if (resolution.step === 'remove-target') {
      const targetId = payload.targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const cardId = target?.zones.judgingArea.find((id) => host.state.cards[id]?.name === '乐不思蜀')
      if (!target || !cardId) return
      moveCard(host.state, cardId, { kind: 'judgingArea', playerId: target.id }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: DAQIAO_GUOSE }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
      markUsedThisPhase(host.state, ownerId, DAQIAO_GUOSE)
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    }
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const records = (host.state as Batch52State).b52GuoseDraw
    if (!cardId || records?.[cardId] !== ownerId || context.event.sourceId !== ownerId) return
    delete records[cardId]
    if (playerOf(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  } }],
})

// 【祸首】全局改写南蛮伤害来源、免疫南蛮，并把每阶段仅一张南蛮的限制接入统一卡牌拦截。
registerSkillRuntime({ id: MENGHUO_HUOSHOU,
  cardEffectInvalid(_state, _ownerId, _sourceId, cardName) { return cardName === '南蛮入侵' },
  modifyDamageSource(_state, ownerId, context) {
    return context.cardName === '南蛮入侵' && context.sourceId !== ownerId ? ownerId : undefined
  },
  prohibitsCardUse(state, ownerId, context) {
    return context.userId === ownerId && context.cardName === '南蛮入侵' && usedThisPhase(state, ownerId, MENGHUO_HUOSHOU)
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (phase.playerId !== ownerId || phase.phase !== 'play') return
      const player = playerOf(host.state, ownerId)
      const cards = host.state.zones.discardPile.filter((id) => host.state.cards[id]?.name === '南蛮入侵')
      if (!player?.alive || !cards.length) return
      const cardId = host.rng.pick(cards)
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MENGHUO_HUOSHOU }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const data = context.event.payload as { cardName?: string }
      if (context.event.sourceId === ownerId && data.cardName === '南蛮入侵' && host.state.phase === 'play') {
        markUsedThisPhase(host.state, ownerId, MENGHUO_HUOSHOU)
      }
    } },
  ],
})

// 【再起】蓄力为公开标记，造成伤害每回合最多+1；弃牌阶段结束逐角色执行所选收益。
registerSkillRuntime({ id: MENGHUO_ZAIQI,
  onGameStart(host, ownerId) {
    const player = playerOf(host.state, ownerId)
    if (player) player.marks.mouMenghuoZaiqi ??= 0
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0
        || usedThisTurn(host.state, ownerId, MENGHUO_ZAIQI)) return
      const player = playerOf(host.state, ownerId)
      if (!player?.alive) return
      player.marks.mouMenghuoZaiqi = Math.min(7, (player.marks.mouMenghuoZaiqi ?? 0) + 1)
      markUsedThisTurn(host.state, ownerId, MENGHUO_ZAIQI)
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const amount = playerOf(host.state, ownerId)?.marks.mouMenghuoZaiqi ?? 0
      const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (phase.playerId !== ownerId || phase.phase !== 'discard' || amount < 1) return
      host.queueSkill({ skillId: MENGHUO_ZAIQI, ownerId, step: 'choose-targets', data: { amount } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-targets') return
    const amount = Math.min(Number((prompt.data as { amount?: number }).amount ?? 0), playerOf(host.state, ownerId)?.marks.mouMenghuoZaiqi ?? 0)
    const living = host.state.players.filter((player) => player.alive).map((player) => player.id)
    if (!amount || !living.length) return
    host.askSkill({ skillId: MENGHUO_ZAIQI, ownerId, step: 'choose-targets', data: { amount },
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: `【再起】：选择至多${amount}名角色并消耗等量蓄力点`, timeoutMs: 30_000,
        optional: true, candidateIds: living, min: 0, max: Math.min(amount, living.length) }) })
  },
  resume(host, ownerId, resolution, response) {
    const player = playerOf(host.state, ownerId)
    if (!player?.alive) return
    if (resolution.step === 'choose-targets') {
      const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const current = player.marks.mouMenghuoZaiqi ?? 0
      if (!ids.length || ids.length > current || new Set(ids).size !== ids.length
        || ids.some((id) => !playerOf(host.state, id)?.alive)) return
      player.marks.mouMenghuoZaiqi = current - ids.length
      host.askSkill({ skillId: MENGHUO_ZAIQI, ownerId, step: 'resolve-next', data: { targetIds: ids, index: 0 },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ids[0]!,
          prompt: '【再起】：选择一项', timeoutMs: 30_000, optional: false,
          options: [{ id: 'draw-owner', label: '令孟获摸一张牌' },
            ...(playerCardsForDiscard(host.state, ids[0]!).length ? [{ id: 'discard-heal', label: '弃置一张牌，然后孟获回复1点体力' }] : [])] }) })
      return
    }
    if (resolution.step === 'resolve-next') {
      const data = resolution.data as { targetIds: PlayerId[]; index: number }
      const targetId = data.targetIds[data.index]
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      const option = (response.payload as { optionId?: string }).optionId
      if (target?.alive && option === 'draw-owner') {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
        zaiqiNext(host, ownerId, data.targetIds, data.index + 1)
      } else if (target?.alive && option === 'discard-heal' && playerCardsForDiscard(host.state, targetId).length) {
        requestCards(host, MENGHUO_ZAIQI, ownerId, 'pay-discard', targetId, playerCardsForDiscard(host.state, targetId), 1, 1,
          '【再起】：弃置一张牌', { targetIds: data.targetIds, index: data.index }, false)
      } else zaiqiNext(host, ownerId, data.targetIds, data.index + 1)
      return
    }
    if (resolution.step === 'pay-discard') {
      const data = resolution.data as { targetIds: PlayerId[]; index: number }
      const targetId = data.targetIds[data.index]!
      const target = playerOf(host.state, targetId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (target?.alive && cardId && target.zones.hand.includes(cardId) && discardOwned(host, targetId, [cardId], MENGHUO_ZAIQI).length) {
        recover(host as never, ownerId, 1, ownerId)
      }
      zaiqiNext(host, ownerId, data.targetIds, data.index + 1)
    }
  },
})

function zaiqiNext(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number): void {
  while (index < targetIds.length && !playerOf(host.state, targetIds[index]!)?.alive) index += 1
  if (index >= targetIds.length || !playerOf(host.state, ownerId)?.alive) return
  const targetId = targetIds[index]!
  const options = [{ id: 'draw-owner', label: '令孟获摸一张牌' },
    ...(playerCardsForDiscard(host.state, targetId).length ? [{ id: 'discard-heal', label: '弃置一张牌，然后孟获回复1点体力' }] : [])]
  host.askSkill({ skillId: MENGHUO_ZAIQI, ownerId, step: 'resolve-next', data: { targetIds, index },
    build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: targetId,
      prompt: '【再起】：选择一项', timeoutMs: 30_000, optional: false, options }) })
}

// 【魂姿】在真正脱离濒死后强制觉醒；觉醒后技能以可序列化的 grantedSkills 生效。
registerSkillRuntime({ id: SUNCE_HUNZI, triggers: [{ event: 'QuitDying', handle(host, ownerId, context) {
  const state = host.state as Batch52State
  const owner = playerOf(host.state, ownerId)
  if (context.event.targetId !== ownerId || !owner?.alive || state.b52SunceAwake?.[ownerId]) return
  state.b52SunceAwake ??= {}
  state.b52SunceAwake[ownerId] = true
  if (!owner.awakenedSkills.includes(SUNCE_HUNZI)) owner.awakenedSkills.push(SUNCE_HUNZI)
  loseMaxHp(host as never, ownerId, 1, SUNCE_HUNZI)
  if (!owner.alive) return
  gainArmor(host as never, ownerId, 1, SUNCE_HUNZI)
  drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
  for (const id of [SUNCE_YINGZI, SUNCE_YINGHUN]) if (!owner.grantedSkills.includes(id)) owner.grantedSkills.push(id)
} }] })

registerSkillRuntime({ id: SUNCE_YINGZI,
  maxCardsBonus(state, ownerId) { return (state as Batch52State).b52SunceLimit?.[ownerId] ?? 0 },
  triggers: [{ event: 'DrawPhase', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; count?: number }
    if (payload.playerId !== ownerId) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const bonus = Number(owner.zones.hand.length >= 2) + Number(owner.hp >= 2)
      + Number(Object.values(owner.zones.equipment).some(Boolean))
    if (!bonus) return
    payload.count = Number(payload.count ?? 2) + bonus
    ;((host.state as Batch52State).b52SunceLimit ??= {})[ownerId] = bonus
  } }, { event: 'TurnStart', handle(host, ownerId) {
    delete (host.state as Batch52State).b52SunceLimit?.[ownerId]
  } }],
})

registerSkillRuntime({ id: SUNCE_YINGHUN, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
  if (phase.playerId !== ownerId || phase.phase !== 'prepare') return
  const owner = playerOf(host.state, ownerId)
  const targets = livingOthers(host.state, ownerId)
  if (!owner || owner.hp >= owner.maxHp || !targets.length) return
  requestTargets(host, SUNCE_YINGHUN, ownerId, 'target', '【英魂※】：选择一名其他角色', targets.map((p) => p.id), 1, 1, { x: owner.maxHp - owner.hp })
} }], resume(host, ownerId, resolution, response) {
  const payload = response.payload as { targetIds?: PlayerId[]; optionId?: string; cardIds?: CardId[] }
  const data = resolution.data as { x?: number; targetId?: PlayerId; discardCount?: number }
  if (resolution.step === 'target') {
    const targetId = payload.targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    chooseOption(host, SUNCE_YINGHUN, ownerId, 'mode', ownerId, '【英魂※】：选择一项', [
      { id: 'draw-x', label: `其摸${data.x}张牌，然后弃置一张牌` }, { id: 'draw-1', label: `其摸一张牌，然后弃置${data.x}张牌` },
    ], { ...data, targetId }, false)
    return
  }
  if (resolution.step === 'mode') {
    const targetId = data.targetId!
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const x = Math.max(1, Math.min(10, data.x ?? 1))
    const n = payload.optionId === 'draw-x' ? x : 1
    drawCards(host.state, host.rng, targetId, n, (name, eventPayload) => { host.dispatch(name, eventPayload) })
    const discardCount = payload.optionId === 'draw-x' ? 1 : x
    const cards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (cards.length) requestCards(host, SUNCE_YINGHUN, ownerId, 'discard', targetId, cards, Math.min(discardCount, cards.length), Math.min(discardCount, cards.length), '【英魂※】：弃置牌', { targetId, discardCount }, false)
    return
  }
  if (resolution.step === 'discard') {
    const target = playerOf(host.state, data.targetId!)
    const cards = payload.cardIds ?? []
    if (target && cards.length === (data.discardCount ?? 0) && cards.every((id) => locateOwnedCard(host.state, target.id, id))) discardOwned(host, target.id, cards, SUNCE_YINGHUN)
  }
} })

registerSkillRuntime({ id: SUNCE_JIANG,
  extraTargetsForTrick(state, ownerId, cardName) { return cardName === '决斗' && playerOf(state, ownerId)?.characterId === MOU_SUNCE.id ? 1 : 0 },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.characterId !== MOU_SUNCE.id || state.phase !== 'play' || state.currentPlayerId !== ownerId || !owner.zones.hand.length) return []
    const used = (state as Batch52State).b52SunceDuelUses?.[ownerId] ?? 0
    const limit = (state as Batch52State).b52SunceJiangUpgraded?.[ownerId]
      ? Math.max(1, state.players.filter((p) => p.alive && effectiveKingdomOf(state, p.id) === 'wu').length) : 1
    return used < limit ? [{ id: `skill:${SUNCE_JIANG}:all-hand-duel`, label: '激昂：将所有手牌当【决斗】使用' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SUNCE_JIANG}:all-hand-duel`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.characterId !== MOU_SUNCE.id || !owner.zones.hand.length) return
    const costs = [...owner.zones.hand]
    const virtualId = createVirtualTrick(host.state, ownerId, '决斗', SUNCE_JIANG)
    const actions = validUseActions(host.state, ownerId, virtualId, '决斗')
    const candidates = [...new Set(actions.flatMap((candidate) => candidate.targetIds))]
    if (!candidates.length) { moveCard(host.state, virtualId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }); return }
    for (const id of costs) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: costs, reason: SUNCE_JIANG }, { sourceId: ownerId, cardIds: costs })
    const state = host.state as Batch52State
    state.b52SunceDuelUses ??= {}
    state.b52SunceDuelUses[ownerId] = (state.b52SunceDuelUses[ownerId] ?? 0) + 1
    host.askSkill({ skillId: SUNCE_JIANG, ownerId, step: 'all-hand-targets', data: { virtualId, actions }, build: (id) => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【激昂】：选择【决斗】目标（两名目标须流失1点体力）', timeoutMs: 30_000, optional: false, candidateIds: candidates, min: 1, max: Math.min(2, candidates.length) }) })
  },
  interceptPlayAction(host, ownerId, action) {
    if (action.asCardName !== '决斗' || action.targetIds.length < 2 || playerOf(host.state, ownerId)?.characterId !== MOU_SUNCE.id) return false
    chooseOption(host, SUNCE_JIANG, ownerId, 'extra-target-cost', ownerId, '【激昂】：额外指定目标须流失1点体力',
      [{ id: 'pay', label: '流失1点体力并保留额外目标' }, { id: 'one', label: '只指定第一名目标' }], { cardId: action.cardIds[0], targetIds: action.targetIds }, false)
    return true
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (phase.playerId === ownerId && phase.phase === 'play') delete (host.state as Batch52State).b52SunceDuelUses?.[ownerId]
    } },
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || !(data.cardName === '决斗' || (data.cardName === '杀' && effectiveCardColor(host.state, ownerId, data.cardId ?? '') === 'red'))) return
      drawCards(host.state, host.rng, ownerId, Math.max(1, data.targetIds?.length ?? 1), (name, payload) => { host.dispatch(name, payload) })
    } },
    { event: 'TargetConfirmed', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; cardName?: string }
      if (context.event.targetId === ownerId && (data.cardName === '决斗' || (data.cardName === '杀' && effectiveCardColor(host.state, ownerId, data.cardId ?? '') === 'red')))
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; targetIds?: PlayerId[] }
    if (resolution.step === 'all-hand-targets') {
      const data = resolution.data as { virtualId: CardId; actions: ReturnType<typeof validUseActions> }
      const targets = payload.targetIds ?? []
      const action = data.actions.find((candidate) => candidate.targetIds.length === targets.length && candidate.targetIds.every((id) => targets.includes(id)))
      if (action) executeUseCardAction(host as never, ownerId, action)
      else if (host.state.cards[data.virtualId]) moveCard(host.state, data.virtualId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      return
    }
    if (resolution.step !== 'extra-target-cost') return
    const data = resolution.data as { cardId: CardId; targetIds: PlayerId[] }
    const actions = validUseActions(host.state, ownerId, data.cardId, '决斗')
    if (payload.optionId === 'pay') {
      loseHp(host as never, ownerId, 1, SUNCE_JIANG)
      if (host.state.dying?.playerId === ownerId) {
        host.queueSkill({ skillId: SUNCE_JIANG, ownerId, step: 'paid-duel-after-dying', data: { cardId: data.cardId, targetIds: data.targetIds } })
      } else if (playerOf(host.state, ownerId)?.alive) {
        const action = actions.find((candidate) => data.targetIds.every((id) => candidate.targetIds.includes(id)))
        if (action) executeUseCardAction(host as never, ownerId, action)
      }
    } else {
      const action = actions.find((candidate) => candidate.targetIds.length === 1 && candidate.targetIds[0] === data.targetIds[0])
      if (action) executeUseCardAction(host as never, ownerId, action)
    }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'paid-duel-after-dying' || !playerOf(host.state, ownerId)?.alive) return
    const data = prompt.data as { cardId: CardId; targetIds: PlayerId[] }
    const action = validUseActions(host.state, ownerId, data.cardId, '决斗').find((candidate) => data.targetIds.every((id) => candidate.targetIds.includes(id)))
    if (action) executeUseCardAction(host as never, ownerId, action)
  },
})

registerSkillRuntime({ id: SUNCE_ZHIBA, lord: true, limited: true, triggers: [{ event: 'EnterDying', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || getCharacter(playerOf(host.state, ownerId)?.characterId ?? '')?.kingdom !== 'wu'
    || playerOf(host.state, ownerId)?.usedLimitedSkills.includes(SUNCE_ZHIBA)) return
  const wu = host.state.players.filter((p) => p.alive && effectiveKingdomOf(host.state, p.id) === 'wu')
  if (wu.length < 2) return
  chooseOption(host, SUNCE_ZHIBA, ownerId, 'activate', ownerId, '【制霸】：是否发动？',
    [{ id: 'yes', label: `回复${wu.length - 1}点体力，升级【激昂】并令其他吴势力角色依次受伤` }, { id: 'no', label: '不发动' }], { targetIds: wu.filter((p) => p.id !== ownerId).map((p) => p.id) }, true)
} }], resume(host, ownerId, resolution, response) {
  const payload = response.payload as { optionId?: string }
  const data = resolution.data as { targetIds?: PlayerId[]; index?: number }
  const owner = playerOf(host.state, ownerId)
  if (resolution.step === 'activate') {
    if (payload.optionId !== 'yes' || !owner?.alive) { host.resumeAfterDying(); return }
    owner.usedLimitedSkills.push(SUNCE_ZHIBA)
    recover(host as never, ownerId, Math.max(0, data.targetIds?.length ?? 0), ownerId)
    if (owner.characterId === MOU_SUNCE.id) {
      const state = host.state as Batch52State
      state.b52SunceJiangUpgraded ??= {}
      state.b52SunceJiangUpgraded[ownerId] = true
    }
    host.resumeAfterDying()
    host.queueSkill({ skillId: SUNCE_ZHIBA, ownerId, step: 'damage-next', data: { targetIds: data.targetIds ?? [], index: 0 } })
    return
  }
}, startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'damage-next') return
  const data = prompt.data as { targetIds: PlayerId[]; index: number; previousTargetId?: PlayerId }
  if (data.previousTargetId && !playerOf(host.state, data.previousTargetId)?.alive && playerOf(host.state, ownerId)?.alive)
    drawCards(host.state, host.rng, ownerId, 3, (name, eventPayload) => { host.dispatch(name, eventPayload) })
  const targetId = data.targetIds.slice(data.index).find((id) => playerOf(host.state, id)?.alive)
  if (!targetId) return
  resolveDamage(host as never, { sourceId: null, targetId, amount: 1, nature: 'normal', cardName: '制霸' })
  host.queueSkill({ skillId: SUNCE_ZHIBA, ownerId, step: 'damage-next', data: { targetIds: data.targetIds, index: data.targetIds.indexOf(targetId) + 1, previousTargetId: targetId } })
} })

// 【奋励】阶段窗口使用引擎的真实跳过状态；【平寇】按阶段状态机记录的跳过数执行。
registerSkillRuntime({ id: ZHUHUAN_FENLI,
  offerPhaseSkip(host, ownerId, phase) {
    if (!['draw', 'play', 'discard'].includes(phase)) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    const comparable = host.state.players.filter((p) => p.alive)
    const score = (p: typeof owner) => phase === 'draw' ? p.zones.hand.length
      : phase === 'play' ? p.hp : Object.values(p.zones.equipment).filter(Boolean).length
    const max = Math.max(...comparable.map(score))
    if (score(owner) !== max || (phase === 'discard' && score(owner) === 0)) return false
    chooseOption(host, ZHUHUAN_FENLI, ownerId, 'skip', ownerId, `【奋励】：是否跳过${phase === 'draw' ? '摸牌' : phase === 'play' ? '出牌' : '弃牌'}阶段？`,
      [{ id: 'yes', label: '跳过此阶段' }, { id: 'no', label: '不跳过' }], { phase }, true)
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'skip') return
    const phase = (resolution.data as { phase?: TurnPhase }).phase
    if (response.payload && (response.payload as { optionId?: string }).optionId === 'yes' && phase) {
      skipPhase(host.state, phase)
      ;((host.state as Batch52State).b52ChuxiSkipped ??= {})[ownerId] = ((host.state as Batch52State).b52ChuxiSkipped?.[ownerId] ?? 0) + 1
    }
    host.resumePhaseEntry()
  },
})

registerSkillRuntime({ id: ZHUHUAN_PINGKOU, triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
  if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
  const count = (host.state as Batch52State).b52ChuxiSkipped?.[ownerId] ?? 0
  if (count > 0) host.queueSkill({ skillId: ZHUHUAN_PINGKOU, ownerId, step: 'targets', data: { count } })
  delete (host.state as Batch52State).b52ChuxiSkipped?.[ownerId]
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'targets') {
    const count = Math.min(Number((prompt.data as { count?: number }).count ?? 0), livingOthers(host.state, ownerId).length)
    if (!count) return
    requestTargets(host, ZHUHUAN_PINGKOU, ownerId, 'targets', '【平寇】：选择至多相应名其他角色各造成1点伤害',
      livingOthers(host.state, ownerId).map((p) => p.id), 0, count, { count }, true)
    return
  }
  if (prompt.step !== 'damage-next') return
  const data = prompt.data as { targetIds: PlayerId[]; index: number; previousTargetId?: PlayerId }
  if (data.previousTargetId && !playerOf(host.state, data.previousTargetId)?.alive && playerOf(host.state, ownerId)?.alive)
    drawCards(host.state, host.rng, ownerId, 1, (name, eventPayload) => { host.dispatch(name, eventPayload) })
  const targetId = data.targetIds.slice(data.index).find((id) => playerOf(host.state, id)?.alive)
  if (!targetId) {
    if (data.targetIds.length && playerOf(host.state, ownerId)?.alive) {
      const equipment = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.category === 'equipment')
      const picked = equipment.length ? host.rng.pick(equipment) : undefined
      if (picked) { moveCard(host.state, picked, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId }); host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: ZHUHUAN_PINGKOU }, { targetId: ownerId, cardIds: [picked] }) }
    }
    return
  }
  resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '平寇' })
  host.queueSkill({ skillId: ZHUHUAN_PINGKOU, ownerId, step: 'damage-next', data: { targetIds: data.targetIds, index: data.targetIds.indexOf(targetId) + 1, previousTargetId: targetId } })
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'targets') return
  const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
  const count = Math.max(0, Math.min(ids.length, (resolution.data as { count?: number }).count ?? 0))
  if (count) host.queueSkill({ skillId: ZHUHUAN_PINGKOU, ownerId, step: 'damage-next', data: { targetIds: ids.slice(0, count), index: 0 } })
} })

// 【孤厉】使用普通出杀入口，卡牌历史和响应流程不绕开通用管线；记录其伤害后续补牌。
registerSkillRuntime({ id: WEIYAN_AOSI,
  ignoresSlashUsesTo(state, ownerId, targetId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId
      && Boolean((state as Batch52State).b52WeiyanDamage?.[ownerId] === targetId)
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || host.state.phase !== 'play') return
    const targetId = context.event.targetId
    if (targetId && playerOf(host.state, targetId)?.alive && getDistance(host.state, ownerId, targetId) <= getAttackRange(host.state, ownerId)) {
      ;((host.state as Batch52State).b52WeiyanDamage ??= {})[ownerId] = targetId
    }
  } }, { event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (phase.playerId === ownerId && phase.phase === 'play') delete (host.state as Batch52State).b52WeiyanDamage?.[ownerId]
  } }, { event: 'TurnEnd', handle(host, ownerId) { delete (host.state as Batch52State).b52WeiyanDamage?.[ownerId] } }],
})

// 【慧夭】伤害后才指定施害者与受害者，避免受到濒死结算中途挂起的伤害错位。
registerSkillRuntime({ id: ZHOUBUYI_HUIYAO,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, ZHOUBUYI_HUIYAO)
      ? [{ id: `skill:${ZHOUBUYI_HUIYAO}`, label: '慧夭：受到1点无来源伤害并令两名角色造成伤害' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${ZHOUBUYI_HUIYAO}` || usedThisPhase(host.state, ownerId, ZHOUBUYI_HUIYAO)) return
    markUsedThisPhase(host.state, ownerId, ZHOUBUYI_HUIYAO)
    resolveDamage(host as never, { sourceId: null, targetId: ownerId, amount: 1, nature: 'normal', cardName: '慧夭' })
    if (playerOf(host.state, ownerId)?.alive) host.queueSkill({ skillId: ZHOUBUYI_HUIYAO, ownerId, step: 'choose-actor', data: {} })
  },
  startQueued(host, ownerId, prompt) {
    const living = host.state.players.filter((p) => p.alive).map((p) => p.id)
    if (!playerOf(host.state, ownerId)?.alive) return
    if (prompt.step === 'choose-actor' && living.length > 1) requestTargets(host, ZHOUBUYI_HUIYAO, ownerId, 'choose-actor', '【慧夭】：选择视为造成伤害的角色', living.filter((id) => id !== ownerId), 1, 1, {}, false)
  },
  resume(host, ownerId, resolution, response) {
    const selected = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const living = host.state.players.filter((p) => p.alive && p.id !== ownerId).map((p) => p.id)
    if (resolution.step === 'choose-actor' && selected && living.includes(selected))
      requestTargets(host, ZHOUBUYI_HUIYAO, ownerId, 'choose-victim', '【慧夭】：选择其造成伤害的角色', host.state.players.filter((p) => p.alive && p.id !== selected).map((p) => p.id), 1, 1, { actorId: selected }, false)
    else if (resolution.step === 'choose-victim' && selected && host.state.players.some((p) => p.alive && p.id === selected)) {
      const actorId = (resolution.data as { actorId?: PlayerId }).actorId
      if (actorId && actorId !== selected) resolveDamage(host as never, { sourceId: actorId, targetId: selected, amount: 1, nature: 'normal', cardName: '慧夭' })
    }
  },
})

registerSkillRuntime({ id: ZHOUBUYI_QUESONG, triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
  if (context.event.targetId === ownerId) (host.state as Batch52State).b52ZhouDamageTurn ??= {}, (host.state as Batch52State).b52ZhouDamageTurn![ownerId] = host.state.turnNumber
} }, { event: 'PhaseStart', handle(host, ownerId, context) {
  if ((context.event.payload as { phase?: TurnPhase }).phase !== 'finish' || (host.state as Batch52State).b52ZhouDamageTurn?.[ownerId] !== host.state.turnNumber) return
  const targets = host.state.players.filter((p) => p.alive).map((p) => p.id)
  if (targets.length) requestTargets(host, ZHOUBUYI_QUESONG, ownerId, 'recipient', '【雀颂】：选择一名角色', targets, 1, 1, {}, true)
} }], resume(host, ownerId, resolution, response) {
  const targetId = (response.payload as { targetIds?: PlayerId[]; optionId?: string }).targetIds?.[0]
  if (resolution.step === 'recipient' && targetId && playerOf(host.state, targetId)?.alive)
    chooseOption(host, ZHOUBUYI_QUESONG, ownerId, 'mode', targetId, '【雀颂】：选择一项', [
      { id: 'draw', label: `摸${Object.values(playerOf(host.state, targetId)!.zones.equipment).filter(Boolean).length >= 3 ? 2 : 3}张牌并复原武将牌` },
      { id: 'recover', label: '回复1点体力' },
    ], { targetId }, false)
  else if (resolution.step === 'mode') {
    const data = resolution.data as { targetId?: PlayerId }
    const recipient = playerOf(host.state, data.targetId ?? '')
    if (!recipient?.alive) return
    if ((response.payload as { optionId?: string }).optionId === 'recover') recover(host as never, recipient.id, 1, ownerId)
    else { drawCards(host.state, host.rng, recipient.id, Object.values(recipient.zones.equipment).filter(Boolean).length >= 3 ? 2 : 3, (name, payload) => { host.dispatch(name, payload) }); restoreCharacter(host as never, recipient.id, '雀颂') }
  }
} })

// 【易宠】标记全场唯一；下一张该花色的牌真正进入目标手牌后转交给郭女王。
registerSkillRuntime({ id: GUO_YICHONG, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (phase.playerId !== ownerId || phase.phase !== 'prepare') return
    const targets = livingOthers(host.state, ownerId)
    if (targets.length) requestTargets(host, GUO_YICHONG, ownerId, 'target', '【易宠】：选择一名其他角色', targets.map((p) => p.id), 1, 1)
  } },
  { event: 'GainCard', handle(host, ownerId, context) {
    const marker = (host.state as Batch52State).b52GuoMarker
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (!marker || marker.ownerId !== ownerId || payload.playerId !== marker.targetId || context.event.sourceId === ownerId) return
    const stolen = (payload.cardIds ?? []).find((id) => host.state.cards[id]?.suit === marker.suit
      && playerOf(host.state, marker.targetId)?.zones.hand.includes(id))
    if (!stolen || !playerOf(host.state, ownerId)?.alive) return
    moveCard(host.state, stolen, { kind: 'hand', playerId: marker.targetId }, { kind: 'hand', playerId: ownerId })
    host.dispatch('CardGiven', { fromId: marker.targetId, toId: ownerId, cardIds: [stolen], reason: GUO_YICHONG }, { sourceId: marker.targetId, targetId: ownerId, cardIds: [stolen] })
    delete (host.state as Batch52State).b52GuoMarker
  } },
  { event: 'TurnStart', handle(host, ownerId, context) {
    const marker = (host.state as Batch52State).b52GuoMarker
    if (marker?.ownerId === ownerId && (context.event.payload as { playerId?: PlayerId }).playerId === ownerId) delete (host.state as Batch52State).b52GuoMarker
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const owner = playerOf(host.state, ownerId)
    if (!target?.alive || !owner?.alive) return
    host.askSkill({ skillId: GUO_YICHONG, ownerId, step: 'suit', data: { targetId }, build: (id) => ({ id, kind: 'choose-suit', playerId: ownerId, prompt: '【易宠】：选择一种花色', timeoutMs: 30_000, optional: false, suits: ['spade', 'heart', 'club', 'diamond'] }) })
    return
  }
  if (resolution.step === 'suit') {
    const targetId = (resolution.data as { targetId?: PlayerId }).targetId
    const suit = (response.payload as { suit?: string }).suit
    const target = playerOf(host.state, targetId ?? '')
    const owner = playerOf(host.state, ownerId)
    if (!target?.alive || !owner?.alive || !['spade', 'heart', 'club', 'diamond'].includes(suit ?? '')) return
    const owned = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea]
      .filter((id) => host.state.cards[id]?.suit === suit)
    for (const id of owned) {
      const from = locateOwnedCard(host.state, target.id, id)
      if (!from) continue
      moveCard(host.state, id, from, { kind: 'hand', playerId: ownerId })
      if (from.kind === 'equipment' && from.slot) host.dispatch('LoseEquipment', { playerId: target.id, cardId: id, slot: from.slot, reason: GUO_YICHONG }, { targetId: target.id, cardIds: [id] })
    }
    if (owned.length) {
      host.dispatch('LoseCard', { playerId: target.id, cardIds: owned, reason: GUO_YICHONG }, { sourceId: target.id, cardIds: owned })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: owned, reason: GUO_YICHONG }, { sourceId: target.id, targetId: ownerId, cardIds: owned })
    }
    ;(host.state as Batch52State).b52GuoMarker = { ownerId, targetId: target.id, suit: suit!, expiresAtTurn: host.state.turnNumber + host.state.players.length }
  }
} })

registerSkillRuntime({ id: GUO_WUFEI,
  modifyDamageSource(state, ownerId, context) {
    const marker = (state as Batch52State).b52GuoMarker
    if (!marker || marker.ownerId !== ownerId || !playerOf(state, marker.targetId)?.alive || context.sourceId !== ownerId) return undefined
    return context.cardName === '杀' || DAMAGE_TRICKS.has(context.cardName ?? '') ? marker.targetId : undefined
  },
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    const marker = (host.state as Batch52State).b52GuoMarker
    const target = marker?.ownerId === ownerId ? playerOf(host.state, marker.targetId) : undefined
    if (context.event.targetId !== ownerId || !target?.alive || target.hp <= 3) return
    host.queueSkill({ skillId: GUO_WUFEI, ownerId, step: 'retaliate', data: { targetId: target.id } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'retaliate') return
    const targetId = (prompt.data as { targetId?: PlayerId }).targetId
    const target = playerOf(host.state, targetId ?? '')
    if (!target?.alive || target.hp <= 3 || !playerOf(host.state, ownerId)?.alive) return
    chooseOption(host, GUO_WUFEI, ownerId, 'retaliate', ownerId, '【诬诽】：是否令“雀”角色受到1点无来源伤害？',
      [{ id: 'yes', label: '令其受到1点无来源伤害' }, { id: 'no', label: '不发动' }], { targetId }, true)
  },
  resume(host, _ownerId, resolution, response) {
    const data = resolution.data as { targetId?: PlayerId }
    if (resolution.step === 'retaliate' && (response.payload as { optionId?: string }).optionId === 'yes' && playerOf(host.state, data.targetId ?? '')?.alive)
      resolveDamage(host as never, { sourceId: null, targetId: data.targetId!, amount: 1, nature: 'normal', cardName: '诬诽' })
  },
})

// 【孤厉】主动结算按真实普通杀目标合法性生成候选；失去体力和弃置手牌分别走公共流程。
registerSkillRuntime({ id: WEIYAN_GULI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && owner.zones.hand.length > 0 && state.phase === 'play' && state.currentPlayerId === ownerId
      && !usedThisPhase(state, ownerId, WEIYAN_GULI)
      ? [{ id: `skill:${WEIYAN_GULI}`, label: '孤厉：将所有手牌当无视防具的普通杀使用' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${WEIYAN_GULI}` || usedThisPhase(host.state, ownerId, WEIYAN_GULI)) return
    const owner = playerOf(host.state, ownerId)
    const ids = owner?.zones.hand.slice() ?? []
    const candidates = livingOthers(host.state, ownerId).filter((p) => canTarget(host.state, ownerId, p.id)
      && getDistance(host.state, ownerId, p.id) <= getAttackRange(host.state, ownerId)).map((p) => p.id)
    if (!owner?.alive || !ids.length || !candidates.length) return
    markUsedThisPhase(host.state, ownerId, WEIYAN_GULI)
    host.askSkill({ skillId: WEIYAN_GULI, ownerId, step: 'target', data: { ids }, build: (id) => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【孤厉】：选择【杀】的目标', timeoutMs: 30_000, optional: false, candidateIds: candidates, min: 1, max: 1 }) })
  },
  ignoresArmorFor(state, ownerId, targetId) { return (state as Batch52State).b52WeiyanDamage?.[ownerId] === targetId },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    if (context.event.sourceId === ownerId && context.event.targetId === (host.state as Batch52State).b52WeiyanDamage?.[ownerId]
      && (context.event.payload as { cardName?: string }).cardName === '杀') {
      ;((host.state as Batch52State).b52WeiyanHit ??= {})[ownerId] = true
    }
  } }, { event: 'CardResolved', handle(host, ownerId, context) {
    const card = context.event.payload as { cardName?: string }
    if (context.event.sourceId !== ownerId || card.cardName !== '杀' || !(host.state as Batch52State).b52WeiyanDamage?.[ownerId]) return
    const damage = (host.state as Batch52State).b52WeiyanHit?.[ownerId] === true
    const owner = playerOf(host.state, ownerId)
    delete (host.state as Batch52State).b52WeiyanDamage?.[ownerId]
    if (!owner?.alive || !damage) return
    chooseOption(host, WEIYAN_GULI, ownerId, 'refill', ownerId, '【孤厉】：是否失去1点体力并将手牌摸至体力上限？',
      [{ id: 'yes', label: '失去1点体力并补牌至体力上限' }, { id: 'no', label: '不发动' }], {}, true)
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const ids = (resolution.data as { ids?: CardId[] }).ids ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !targetId || !canTarget(host.state, ownerId, targetId) || !ids.length || ids.some((id) => !owner.zones.hand.includes(id))) return
      for (const id of ids) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: ids, reason: WEIYAN_GULI }, { sourceId: ownerId, cardIds: ids })
      ;((host.state as Batch52State).b52WeiyanHit ??= {})[ownerId] = false
      ;((host.state as Batch52State).b52WeiyanDamage ??= {})[ownerId] = targetId
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: WEIYAN_GULI, countUsage: true })
      return
    }
    if (resolution.step !== 'refill' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    loseHp(host as never, ownerId, 1, WEIYAN_GULI)
    if (playerOf(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, Math.max(0, owner.maxHp - owner.zones.hand.length), (name, payload) => { host.dispatch(name, payload) })
  },
})

// 【巨象】免疫通过公共牌效无效口；结算后的实体南蛮由引擎直接改写最终归属。
registerSkillRuntime({ id: ZHURONG_JUXIANG,
  cardEffectInvalid(_state, _ownerId, _sourceId, cardName) { return cardName === '南蛮入侵' },
  resolvedCardRecipient(_state, ownerId, context) { return context.cardName === '南蛮入侵' && context.sourceId !== ownerId },
  triggers: [{ event: 'CardUsed', handle(host, _ownerId, context) {
    if ((context.event.payload as { cardName?: string }).cardName === '南蛮入侵') (host.state as Batch52State).b52NamanUsedTurn = host.state.turnNumber
  } }, { event: 'PhaseStart', handle(host, ownerId, context) {
    const state = host.state as Batch52State
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (phase.playerId !== ownerId || phase.phase !== 'finish' || state.b52NamanUsedTurn === host.state.turnNumber || !playerOf(host.state, ownerId)?.alive) return
    const targets = host.state.players.filter((p) => p.alive).map((p) => p.id)
    if (targets.length) requestTargets(host, ZHURONG_JUXIANG, ownerId, 'gift-target', '【巨象】：选择一名角色获得游戏外的【南蛮入侵】', targets, 1, 1, {}, true)
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'gift-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive || !playerOf(host.state, ownerId)?.alive) return
    const virtual = createVirtualTrick(host.state, ownerId, '南蛮入侵', ZHURONG_JUXIANG)
    giveCards(host as never, ownerId, targetId, [virtual], ZHURONG_JUXIANG)
  },
})

const ZHURONG_LIEREN_TAG = `${ZHURONG_LIEREN}:pindian-result`
registerPindianContinuation(ZHURONG_LIEREN_TAG, (engineHost, result) => {
  const host = engineHost as unknown as SkillHost
  const cardId = (host.state as Batch52State).b52ZhurongCurrentCard?.[result.initiatorId]
  if (cardId) {
    ;((host.state as Batch52State).b52ZhurongDuel ??= {})[cardId] = { targetId: result.opponentId, won: result.outcome === 'initiator-win' }
    delete (host.state as Batch52State).b52ZhurongCurrentCard?.[result.initiatorId]
  }
  host.resumeCardTarget()
})

registerSkillRuntime({ id: ZHURONG_LIEREN,
  interceptSourceTargetEach(host, ownerId, context) {
    if (context.sourceId !== ownerId || context.cardName !== '杀' || !playerOf(host.state, ownerId)?.alive) return false
    const resolution = host.state.cardResolution
    if (!resolution || resolution.kind !== 'slash' || resolution.remainingTargetIds.length > 0 || !playerOf(host.state, context.targetId)?.alive) return false
    if (!canPindian(host.state, ownerId) || !canPindian(host.state, context.targetId) || prohibitsBeingPindianTargetOf(host.state, context.targetId)) return false
    chooseOption(host, ZHURONG_LIEREN, ownerId, 'ask-pindian', ownerId, '【烈刃】：是否与目标拼点？若赢，此【杀】结算后可对其他角色造成1点伤害。',
      [{ id: 'yes', label: '与其拼点' }, { id: 'no', label: '不发动' }], { targetId: context.targetId, cardId: context.cardId }, true)
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask-pindian') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const data = resolution.data as { targetId: PlayerId; cardId: CardId }
      if (!playerOf(host.state, data.targetId)?.alive || !playerOf(host.state, ownerId)?.alive) { host.resumeCardTarget(); return }
      ;((host.state as Batch52State).b52ZhurongCurrentCard ??= {})[ownerId] = data.cardId
      startPindian(host as never, { id: `mou-zhurong-${host.state.seq}`, initiatorId: ownerId, opponentId: data.targetId, reason: ZHURONG_LIEREN, continuationTag: ZHURONG_LIEREN_TAG })
      return
    }
    if (resolution.step === 'extra-damage') {
      const data = resolution.data as { cardId?: CardId }
      const record = data.cardId ? (host.state as Batch52State).b52ZhurongDuel?.[data.cardId] : undefined
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (record?.won && targetId && targetId !== record.targetId && playerOf(host.state, targetId)?.alive)
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '烈刃' })
      if (data.cardId) delete (host.state as Batch52State).b52ZhurongDuel?.[data.cardId]
    }
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || (context.event.payload as { cardName?: string }).cardName !== '杀') return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const record = cardId ? (host.state as Batch52State).b52ZhurongDuel?.[cardId] : undefined
    if (!record?.won) { if (cardId) delete (host.state as Batch52State).b52ZhurongDuel?.[cardId]; return }
    const targets = livingOthers(host.state, ownerId).filter((p) => p.id !== record.targetId).map((p) => p.id)
    if (targets.length) requestTargets(host, ZHURONG_LIEREN, ownerId, 'extra-damage', '【烈刃】：选择另一名其他角色受到1点伤害', targets, 1, 1, { cardId }, true)
    else if (cardId) delete (host.state as Batch52State).b52ZhurongDuel?.[cardId]
  } }],
})

// 【苦谏】牌标记随实体牌移动；使用/打出由对应事件兑奖，其他离手则延后惩罚以免抢在 CardUsed/Responded 前误判。
registerSkillRuntime({ id: YANXIANG_KUJIAN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const targets = livingOthers(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId
      && !usedThisPhase(state, ownerId, YANXIANG_KUJIAN) && owner.zones.hand.length > 0 && targets.length
      ? [{ id: `skill:${YANXIANG_KUJIAN}`, label: '苦谏：交给一名角色至多两张手牌并标记' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${YANXIANG_KUJIAN}` || usedThisPhase(host.state, ownerId, YANXIANG_KUJIAN)) return
    const owner = playerOf(host.state, ownerId)
    const targets = livingOthers(host.state, ownerId)
    if (!owner?.zones.hand.length || !targets.length) return
    requestCards(host, YANXIANG_KUJIAN, ownerId, 'cards', ownerId, [...owner.zones.hand], 1, Math.min(2, owner.zones.hand.length), '【苦谏】：选择交给目标的1至2张手牌', {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cards') {
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      const others = livingOthers(host.state, ownerId)
      if (!owner || !ids.length || ids.length > 2 || new Set(ids).size !== ids.length || ids.some((id) => !owner.zones.hand.includes(id)) || !others.length) return
      requestTargets(host, YANXIANG_KUJIAN, ownerId, 'recipient', '【苦谏】：选择获得并持有标记的角色', others.map((p) => p.id), 1, 1, { ids }, false)
      return
    }
    if (resolution.step === 'recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const ids = (resolution.data as { ids?: CardId[] }).ids ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive || ids.some((id) => !playerOf(host.state, ownerId)?.zones.hand.includes(id))) return
      const given = giveCards(host as never, ownerId, targetId, ids, YANXIANG_KUJIAN)
      if (!given.length) return
      markUsedThisPhase(host.state, ownerId, YANXIANG_KUJIAN)
      const marks = (host.state as Batch52State).b52Kujian ??= {}
      for (const cardId of given) marks[cardId] = { ownerId, recipientId: targetId }
      return
    }
    if (resolution.step === 'penalty-owner') {
      const data = resolution.data as { cardId: CardId; recipientId: PlayerId }
      const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (id && locateOwnedCard(host.state, ownerId, id)) discardOwned(host, ownerId, [id], YANXIANG_KUJIAN)
      const targetCards = playerCardsForDiscard(host.state, data.recipientId)
      if (targetCards.length) requestCards(host, YANXIANG_KUJIAN, ownerId, 'penalty-target', data.recipientId, targetCards, 1, 1, '【苦谏】：对方弃置一张牌', data, false)
      else clearKujianMarker(host.state as Batch52State, data.cardId)
      return
    }
    if (resolution.step === 'penalty-target') {
      const data = resolution.data as { cardId: CardId; recipientId: PlayerId }
      const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (id && locateOwnedCard(host.state, data.recipientId, id)) discardOwned(host, data.recipientId, [id], YANXIANG_KUJIAN)
      clearKujianMarker(host.state as Batch52State, data.cardId)
    }
  },
  triggers: [
    { event: 'CardResponded', handle(host, _ownerId, context) { resolveKujianUsed(host, context.event.payload as { cardId?: CardId }, YANXIANG_KUJIAN, context.event.sourceId ?? undefined) } },
    { event: 'CardUsed', handle(host, _ownerId, context) { resolveKujianUsed(host, context.event.payload as { cardId?: CardId }, YANXIANG_KUJIAN, context.event.sourceId ?? undefined) } },
    { event: 'HandCardLeft', handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; playerId?: PlayerId; destination?: { kind?: string } }
      const marker = payload.cardId ? (host.state as Batch52State).b52Kujian?.[payload.cardId] : undefined
      if (!payload.cardId || !marker || !payload.playerId) return
      if (payload.destination?.kind === 'processingArea') return
      const leaver = { ...marker, recipientId: payload.playerId }
      ;((host.state as Batch52State).b52KujianLeaving ??= {})[payload.cardId] = leaver
      host.queueSkill({ skillId: YANXIANG_KUJIAN, ownerId: marker.ownerId, step: 'penalty', data: { cardId: payload.cardId, recipientId: payload.playerId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'penalty') return
    const data = prompt.data as { cardId: CardId; recipientId: PlayerId }
    const marker = (host.state as Batch52State).b52KujianLeaving?.[data.cardId]
    if (!marker) return
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, data.recipientId)?.alive) { clearKujianMarker(host.state as Batch52State, data.cardId); return }
    const cards = playerCardsForDiscard(host.state, ownerId)
    if (!cards.length) { clearKujianMarker(host.state as Batch52State, data.cardId); return }
    requestCards(host, YANXIANG_KUJIAN, ownerId, 'penalty-owner', ownerId, cards, 1, 1, '【苦谏】：弃置一张牌', { ...data }, false)
  },
})

function resolveKujianUsed(host: SkillHost, payload: { cardId?: CardId }, skillId: string, actualUserId?: PlayerId): void {
  const marker = payload.cardId ? (host.state as Batch52State).b52Kujian?.[payload.cardId] : undefined
  if (!payload.cardId || !marker) return
  const owner = playerOf(host.state, marker.ownerId)
  const recipient = playerOf(host.state, actualUserId ?? marker.recipientId)
  clearKujianMarker(host.state as Batch52State, payload.cardId)
  if (owner?.alive) drawCards(host.state, host.rng, owner.id, 2, (name, eventPayload) => { host.dispatch(name, eventPayload) })
  if (recipient?.alive) drawCards(host.state, host.rng, recipient.id, 2, (name, eventPayload) => { host.dispatch(name, eventPayload) })
  void skillId
}

function clearKujianMarker(state: Batch52State, cardId: CardId): void {
  delete state.b52Kujian?.[cardId]
  delete state.b52KujianLeaving?.[cardId]
}

function playerCardsForDiscard(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  return player ? [...player.zones.hand, ...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
}

registerSkillRuntime({ id: YANXIANG_RUILIAN, triggers: [
  { event: 'RoundStart', handle(host, ownerId) {
    const candidates = host.state.players.filter((p) => p.alive).map((p) => p.id)
    if (playerOf(host.state, ownerId)?.alive && candidates.length)
      requestTargets(host, YANXIANG_RUILIAN, ownerId, 'mark-target', '【睿敛】：选择一名角色', candidates, 1, 1, {}, true)
  } },
  { event: 'TurnEnd', handle(host, ownerId, context) {
    const state = host.state as Batch52State
    const targetId = state.b52RuilianTarget?.[ownerId]
    if (!targetId || (context.event.payload as { playerId?: PlayerId }).playerId !== targetId) return
    delete state.b52RuilianTarget?.[ownerId]
    const history = host.state.turnCardCategories?.[targetId]
    const categories = history?.turnNumber === host.state.turnNumber
      ? [...new Set(history.entries.filter((entry) => entry.kind === 'discarded').map((entry) => entry.category))]
      : []
    if (categories.length) chooseOption(host, YANXIANG_RUILIAN, ownerId, 'category', ownerId, '【睿敛】：选择其本回合弃置过的牌类别', categories.map((category) => ({ id: category, label: category === 'basic' ? '基本牌' : category === 'trick' ? '锦囊牌' : '装备牌' })), { targetId }, true)
  } },
], resume(host, ownerId, resolution, response) {
  const state = host.state as Batch52State
  if (resolution.step === 'mark-target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (targetId && playerOf(host.state, targetId)?.alive) { state.b52RuilianTarget ??= {}; state.b52RuilianTarget[ownerId] = targetId }
    return
  }
  if (resolution.step !== 'category') return
  const targetId = (resolution.data as { targetId?: PlayerId }).targetId
  const category = (response.payload as { optionId?: string }).optionId
  if (!targetId || !['basic', 'trick', 'equipment'].includes(category ?? '') || !playerOf(host.state, ownerId)?.alive) return
  const pile = host.state.zones.discardPile.filter((id) => host.state.cards[id]?.category === category)
  const first = pile.length ? host.rng.pick(pile) : undefined
  if (first) {
    moveCard(host.state, first, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [first], reason: YANXIANG_RUILIAN }, { targetId: ownerId, cardIds: [first] })
  }
  const remaining = host.state.zones.discardPile.filter((id) => id !== first && host.state.cards[id]?.category === category)
  const second = remaining.length ? host.rng.pick(remaining) : undefined
  if (second && playerOf(host.state, targetId)?.alive) {
    moveCard(host.state, second, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [second], reason: YANXIANG_RUILIAN }, { targetId, cardIds: [second] })
  }
} })
