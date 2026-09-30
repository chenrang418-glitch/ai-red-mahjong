import type { CardId, PlayerId, SanguoshaState, TurnPhase, Suit } from '../../engine/types'
import type { CharacterDefinition } from './types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, UseCardRequest } from '../../engine/requests'
import { registerSkillRuntime, getSkillRuntime, grantSkill, isCardUseProhibited, isTargetProhibited, type SkillHost } from '../../engine/skills/runtime'
import { drawCards, revealTopCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { moveCard } from '../../engine/zones'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { discardCardsByIds } from '../../engine/discard-all'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { setChained, restoreCharacter } from '../../engine/character-state'
import { resolveDamage } from '../../engine/damage'
import { continueDyingAssists } from '../../engine/damage'
import { resumeDamageModifier } from '../../engine/damage'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { giveCards } from '../../engine/hand-transfer'
import { skillHandCardUseActions, skillOtherHandCardUseActions, declaredCardActions } from '../../engine/cards/basic'
import { ALL_CHARACTERS, skillIdsOf } from './standard'
import { canTarget, getDistance } from '../../engine/distance'

const B = '-b76'
const sid = (name: string) => `${name}${B}`
const BLING_LINGHUI = sid('linghui-bailingyun')
const BLING_XIECE = sid('xiece-bailingyun')
const BLING_YUXIN = sid('yuxin-bailingyun')
const ZHENGHUN_QIANGZHI = sid('qiangzhi-zhenghun')
const ZHENGHUN_PITIAN = sid('pitian-zhenghun')
const LECW_SHUANGJIA = sid('shuangjia-lecaiwenji')
const LECW_BEIFEN = sid('beifen-lecaiwenji')
const DONGWAN_SHENGDU = sid('shengdu-dongwan')
const DONGWAN_JIELING = sid('jieling-dongwan')
const GUANNING_DUNSHI = sid('dunshi-guanning')
const MENGJIE_YINLU = sid('yinlu-mengjie')
const MENGJIE_YOUQI = sid('youqi-mengjie')
const HUANFAN_JIANZHENG = sid('jianzheng-huanfan')
const HUANFAN_FUMOU = sid('fumou-huanfan')
const MENGYOU_MANYI = sid('manyi-mengyou')
const MENGYOU_MANZHI = sid('manzhi-mengyou')
const ZHOUBUYI_SHIJI = sid('shiji-zhoubuyi')
const ZHOUBUYI_SILUN = sid('silun-zhoubuyi')
const ZHUGE_MENGXUE_JICHUN = sid('jichun-zhugemengxue')
const ZHUGE_MENGXUE_HANYING = sid('hanying-zhugemengxue')

type B76State = SanguoshaState & { b76?: Record<string, any> }
function s76(state: SanguoshaState): Record<string, any> { const value = state as B76State; value.b76 ??= {}; return value.b76 }
function p(state: SanguoshaState, id: PlayerId) { return state.players.find((entry) => entry.id === id) }
function living(state: SanguoshaState) { return state.players.filter((entry) => entry.alive) }
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, prompt: string,
  options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId, prompt,
    timeoutMs: 25_000, optional, options }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  candidateIds: PlayerId[], prompt: string, data: Record<string, unknown> = {}, min = 1, max = 1) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId,
    prompt, timeoutMs: 25_000, optional: false, candidateIds, min, max }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, cardIds: CardId[],
  prompt: string, data: Record<string, unknown> = {}, min = 1, max = 1, optional = false) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId, prompt,
    timeoutMs: 25_000, optional, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max }) })
}
function askPick(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, targetId: PlayerId,
  prompt: string, data: Record<string, unknown> = {}, min = 1, max = 1) {
  const cards = pickableCardsOf(host.state, targetId, { discarderId: playerId, includeJudgingArea: true })
  host.askSkill({ skillId, ownerId, step, data: { ...data, targetId }, build: (id) => ({ id, kind: 'choose-cards', playerId,
    prompt, timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards.cardIds,
    hiddenCardSlots: cards.hiddenCardSlots, min: Math.min(min, cards.cardIds.length + cards.hiddenCardSlots.length),
    max: Math.min(max, cards.cardIds.length + cards.hiddenCardSlots.length) }) })
}

registerSkillRuntime({ id: ZHENGHUN_PITIAN, maxCardsBonus(state, ownerId) { return s76(state).pitianBonus?.[ownerId] ?? 0 }, triggers: [
  { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const data = context.event.payload as { fromPlayerId?: PlayerId; reason?: string }
    if (data.fromPlayerId === ownerId && data.reason === 'discard') (s76(host.state).pitianBonus ??= {})[ownerId] = (s76(host.state).pitianBonus?.[ownerId] ?? 0) + 1
  } },
  { event: 'DamageSettled', handle(host, ownerId, context) {
    if (context.event.targetId === ownerId && Number((context.event.payload as { finalAmount?: number }).finalAmount) > 0)
      (s76(host.state).pitianBonus ??= {})[ownerId] = (s76(host.state).pitianBonus?.[ownerId] ?? 0) + 1
  } },
  { event: 'PhaseStart', handle(host, ownerId, context) {
    if ((context.event.payload as { phase?: TurnPhase }).phase !== 'finish' || !p(host.state, ownerId)?.alive) return
    const bonus = s76(host.state).pitianBonus?.[ownerId] ?? 0
    if (bonus > 0 && (p(host.state, ownerId)?.zones.hand.length ?? 0) < (p(host.state, ownerId)?.hp ?? 0) + bonus)
      askOption(host, ZHENGHUN_PITIAN, ownerId, 'draw-to-limit', ownerId, `【辟田】：是否摸牌至手牌上限（当前额外上限${bonus}）`, [{ id: 'yes', label: '摸牌' }], { bonus })
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'draw-to-limit' || (response.payload as { optionId?: string }).optionId !== 'yes') return
  const owner = p(host.state, ownerId)
  const bonus = Number(resolution.data.bonus ?? 0)
  if (owner) drawCards(host.state, host.rng, ownerId, Math.min(5, Math.max(0, owner.hp + bonus - owner.zones.hand.length)))
  if (s76(host.state).pitianBonus) delete s76(host.state).pitianBonus[ownerId]
} })

registerSkillRuntime({ id: ZHOUBUYI_SILUN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const data = context.event.payload as { phase?: TurnPhase; playerId?: PlayerId }
      if (data.playerId === ownerId && data.phase === 'prepare') offerSilun(host, ownerId)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId && Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) > 0)
        offerSilun(host, ownerId)
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      if (context.event.sourceSkillId !== ZHOUBUYI_SILUN) return
      const record = s76(host.state).silun?.[ownerId]
      if (!record) return
      for (const player of living(host.state)) {
        const before = Number(record.equipmentCounts?.[player.id] ?? 0)
        const after = Object.values(player.zones.equipment).filter(Boolean).length
        if (before !== after) restoreCharacter(host as never, player.id, ZHOUBUYI_SILUN)
      }
      advanceSilun(host, ownerId)
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !p(host.state, ownerId)?.alive) return
      const cards = drawCards(host.state, host.rng, ownerId, 4)
      if (!cards.length) return
      s76(host.state).silun ??= {}
      s76(host.state).silun[ownerId] = { cards, index: 0,
        equipmentCounts: Object.fromEntries(living(host.state).map((player) =>
          [player.id, Object.values(player.zones.equipment).filter(Boolean).length])) }
      askSilunDisposition(host, ownerId)
      return
    }
    const record = s76(host.state).silun?.[ownerId]
    if (!record) return
    const cardId = (record.cards as CardId[])[Number(record.index)]
    if (!cardId || !p(host.state, ownerId)?.zones.hand.includes(cardId)) { advanceSilun(host, ownerId); return }
    if (resolution.step === 'disposition') {
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'top' || choice === 'bottom') {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
        const currentIndex = host.state.zones.drawPile.indexOf(cardId)
        if (currentIndex >= 0) host.state.zones.drawPile.splice(currentIndex, 1)
        host.state.zones.drawPile.splice(choice === 'top' ? 0 : host.state.zones.drawPile.length, 0, cardId)
        advanceSilun(host, ownerId)
        return
      }
      if (choice === 'use') {
        const actions = skillHandCardUseActions(host.state, ownerId, cardId).map(({ id, label }) => ({ id, label }))
        if (!actions.length) { askSilunDisposition(host, ownerId); return }
        askOption(host, ZHOUBUYI_SILUN, ownerId, 'use-action', ownerId, '【四论】：选择牌的使用方式与目标',
          actions.map((action, index) => ({ id: String(index), label: action.label })), { cardId, actions }, false)
      }
      return
    }
    if (resolution.step === 'use-action') {
      const actions = resolution.data.actions as Array<{ id: string }> | undefined
      const action = actions?.[Number((response.payload as { optionId?: string }).optionId)]
      if (!action || !p(host.state, ownerId)?.zones.hand.includes(cardId)) { advanceSilun(host, ownerId); return }
      record.equipmentCounts = Object.fromEntries(living(host.state).map((player) =>
        [player.id, Object.values(player.zones.equipment).filter(Boolean).length]))
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
      if (!host.beginSkillCardUseFromProcessing(ownerId, cardId, ZHOUBUYI_SILUN, action.id)) {
        if (host.state.zones.processingArea.includes(cardId))
          moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        advanceSilun(host, ownerId)
      }
    }
  },
})

function offerSilun(host: SkillHost, ownerId: PlayerId) {
  if (!p(host.state, ownerId)?.alive || s76(host.state).silun?.[ownerId]) return
  askOption(host, ZHOUBUYI_SILUN, ownerId, 'invoke', ownerId, '【四论】：是否摸四张牌并依次将其使用或置于牌堆顶/底？',
    [{ id: 'yes', label: '摸四张牌并依次处理' }])
}
function askSilunDisposition(host: SkillHost, ownerId: PlayerId) {
  const record = s76(host.state).silun?.[ownerId]
  const cardId = (record?.cards as CardId[] | undefined)?.[Number(record?.index)]
  if (!record || !cardId) { delete s76(host.state).silun?.[ownerId]; return }
  const actions = p(host.state, ownerId)?.zones.hand.includes(cardId)
    ? skillHandCardUseActions(host.state, ownerId, cardId) : []
  askOption(host, ZHOUBUYI_SILUN, ownerId, 'disposition', ownerId,
    `【四论】：处理第${Number(record.index) + 1}张【${host.state.cards[cardId]?.name ?? '牌'}】`,
    [...(actions.length ? [{ id: 'use', label: '使用此牌' }] : []),
      { id: 'top', label: '置于牌堆顶' }, { id: 'bottom', label: '置于牌堆底' }], {}, false)
}
function advanceSilun(host: SkillHost, ownerId: PlayerId) {
  const record = s76(host.state).silun?.[ownerId]
  if (!record) return
  record.index = Number(record.index) + 1
  if (record.index >= (record.cards as CardId[]).length) { delete s76(host.state).silun[ownerId]; return }
  askSilunDisposition(host, ownerId)
}

export const HISTORICAL_BATCH76_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'bailingyun-b76', name: '柏灵筠', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: BLING_LINGHUI, name: '灵慧', description: '每个结束阶段，若本回合有角色进入过濒死状态（你的回合无此条件），你可以观看牌堆顶的三张牌：你可以使用其中一张牌，然后随机获得剩余中的一张。' },
    { id: BLING_XIECE, name: '黠策', description: '每回合每项限一次，当你受到伤害后，你可令一名其他角色所有非锁定技失效直到回合结束；当你造成伤害后，你可以弃置一张牌并回复1点体力。' },
    { id: BLING_YUXIN, name: '御心', description: '限定技，一名角色进入濒死状态时，你可以令其回复体力至1点。若以此法回复体力的是其他角色，改为回复至与你体力值相同。' },
  ] },
  { id: 'zhenghun-b76', name: '郑浑', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHENGHUN_QIANGZHI, name: '强峙', description: '出牌阶段限一次，你可以弃置你和一名其他角色共计3张牌。若有角色因此失去3张牌，视为其对另一名角色造成1点伤害。' },
    { id: ZHENGHUN_PITIAN, name: '辟田', description: '当你的牌因弃置而进入弃牌堆或你受到伤害后，你的手牌上限+1。结束阶段若你的手牌数小于手牌上限，你可以将手牌摸至手牌上限（最多摸五张），然后重置此技能的手牌上限数。' },
  ] },
  { id: 'lecaiwenji-b76', name: '乐蔡文姬', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: LECW_SHUANGJIA, name: '霜笳', description: '锁定技，游戏开始时，你的初始手牌增加“胡笳”标记且不计入手牌上限。你每拥有一张“胡笳”，其他角色与你计算距离+1（最多+5）。', locked: true },
    { id: LECW_BEIFEN, name: '悲愤', description: '锁定技，当你失去“胡笳”后，你获得与手中“胡笳”花色均不同的牌各一张。你手中“胡笳”少于其他牌时，你使用牌无距离和次数限制。', locked: true },
  ] },
  { id: 'dongwan-b76', name: '董绾', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: DONGWAN_SHENGDU, name: '生妒', description: '回合开始时，你可以选择一名其他角色，该角色获得“生妒”标记，有“生妒”标记的角色摸牌阶段摸牌后，每有一个“生妒”你摸等量的牌，然后移去“生妒”标记。' },
    { id: DONGWAN_JIELING, name: '介绫', description: '出牌阶段每种花色限一次，你可以将两张花色不同的手牌当无距离和次数限制的【杀】使用。若此【杀】造成伤害，其失去1点体力；若未造成伤害，其获得一个“生妒”标记。' },
  ] },
  { id: 'guanning-b76', name: '管宁', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: GUANNING_DUNSHI, name: '遁世', description: '每回合限一次，你可视为使用或打出一张【杀】、【闪】、【桃】或【酒】。然后当前回合角色本回合下次造成伤害时，你选择两项：1.防止此伤害，选择1个包含“仁义礼智信”的技能令其获得；2.减1点体力上限并摸X张牌（X为你选择3的次数）；3.删除你本次视为使用的牌名。' },
  ] },
  { id: 'mengjie-b76', name: '孟节', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: MENGJIE_YINLU, name: '引路', description: '游戏开始时，你令三名角色依次获得以下一个标记：“乐泉”、“藿溪”、“瘴气”，然后你获得一个“芸香”。准备阶段，你可以移动一个标记（有标记的角色死亡时也可以移动）。拥有标记的角色获得对应效果：乐泉：结束阶段，你可以弃置一张方块牌，然后回复1点体力；藿溪：结束阶段，你可以弃置一张红桃牌，然后摸两张牌；瘴气：锁定技，结束阶段，除非你弃置一张黑桃牌，否则失去1点体力；芸香：结束阶段，你可以弃置一张梅花牌，获得一个“芸香”；当你受到伤害时，你可以移去所有“芸香”并防止等量的伤害。' },
    { id: MENGJIE_YOUQI, name: '幽栖', description: '锁定技，其他角色因“引路”弃置牌时，你有概率获得此牌，该角色距离你越近，概率越高。', locked: true },
  ] },
  { id: 'huanfan-b76', name: '桓范', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: HUANFAN_JIANZHENG, name: '谏诤', description: '出牌阶段限一次，你可观看一名其他角色的手牌，然后若其中有你可以使用的牌，你可以获得并使用其中一张。若此牌指定了该角色为目标，则横置你与其的武将牌，然后其观看你的手牌。' },
    { id: HUANFAN_FUMOU, name: '腹谋', description: '当你受到伤害后，你可令至多X名角色依次选择一项（X为你已损失的体力值）：1.移动场上一张牌；2.弃置所有手牌并摸两张牌；3.弃置装备区所有牌并回复1点体力。' },
  ] },
  { id: 'mengyou-b76', name: '孟优', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MENGYOU_MANYI, name: '蛮裔', description: '锁定技，【南蛮入侵】对你无效。', locked: true },
    { id: MENGYOU_MANZHI, name: '蛮智', description: '准备阶段，你可以选择一名其他角色，然后选择一项：1.令其交给你两张牌，然后其视为使用一张无距离限制的【杀】；2.获得其区域内的至多两张牌，然后交给其等量的牌并摸一张牌。结束阶段，若你的体力值与本回合准备阶段时相等，你可以选择执行本回合未被选择的一项。' },
  ] },
  { id: 'zhoubuyi-b76', name: '周不疑', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZHOUBUYI_SHIJI, name: '十计', description: '一名角色的结束阶段，若其本回合未造成伤害，你可以声明一张普通锦囊牌（每轮每个牌名限一次），然后其可以将一张牌当你声明的牌使用（其不能对自己使用）。' },
    { id: ZHOUBUYI_SILUN, name: '四论', description: '准备阶段或当你受到伤害后，你可以摸四张牌，然后将四张牌依次置于场上或牌堆两端，装备区的牌数因此变化的角色复原其武将牌。' },
  ] },
  { id: 'zhugemengxue-b76', name: '诸葛梦雪', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHUGE_MENGXUE_JICHUN, name: '寄春', description: '出牌阶段各限一次，你可以展示一张牌，然后选择一项：1.将此牌交给一名手牌数小于你的角色，然后你摸X张牌；2.弃置此牌，并弃置一名手牌数大于你的角色区域内至多X张牌。（X为此牌名字数）' },
    { id: ZHUGE_MENGXUE_HANYING, name: '寒英', description: '准备阶段，你可以展示牌堆第一张装备牌，然后令一名手牌数等于你的角色使用之。' },
  ] },
]

registerSkillRuntime({ id: ZHENGHUN_QIANGZHI,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, ZHENGHUN_QIANGZHI)) return []
    const own = p(state, ownerId)
    const ownCount = (own?.zones.hand.length ?? 0) + Object.values(own?.zones.equipment ?? {}).filter(Boolean).length
    return living(state).some((target) => target.id !== ownerId && ownCount + target.zones.hand.length
      + Object.values(target.zones.equipment).filter(Boolean).length >= 3)
      ? [{ id: 'qiangzhi:activate', label: '【强峙】弃置共计三张牌并令失去三张牌者造成伤害' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'qiangzhi:activate') return
    const own = p(host.state, ownerId)
    const ownCount = (own?.zones.hand.length ?? 0) + Object.values(own?.zones.equipment ?? {}).filter(Boolean).length
    askTargets(host, ZHENGHUN_QIANGZHI, ownerId, 'target', ownerId, living(host.state).filter((target) => target.id !== ownerId
      && ownCount + target.zones.hand.length + Object.values(target.zones.equipment).filter(Boolean).length >= 3)
      .map(({ id }) => id), '【强峙】：选择另一名角色')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'damage-target') {
      const sourceId = resolution.data.sourceId as PlayerId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && p(host.state, sourceId)?.alive && p(host.state, targetId)?.alive)
        resolveDamage(host as never, { sourceId, targetId, amount: 1, reason: ZHENGHUN_QIANGZHI })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const own = p(host.state, ownerId)
      const ownIds = [...(own?.zones.hand ?? []), ...Object.values(own?.zones.equipment ?? {}).filter((id): id is CardId => Boolean(id))]
      const targetIds = [...(p(host.state, targetId)?.zones.hand ?? []), ...Object.values(p(host.state, targetId)?.zones.equipment ?? {}).filter((id): id is CardId => Boolean(id))]
      const ownCount = Math.min(3, ownIds.length)
      if (ownCount + targetIds.length < 3) return
      askOption(host, ZHENGHUN_QIANGZHI, ownerId, 'distribution', ownerId, '【强峙】：选择由你与目标各自失去几张牌（合计三张）',
        Array.from({ length: ownCount + 1 }, (_, index) => ({ id: String(index), label: `你失去${index}张，目标失去${3 - index}张` }))
          .filter((option) => Number(option.id) <= ownCount && 3 - Number(option.id) <= targetIds.length), { targetId })
      return
    }
    if (resolution.step === 'distribution') {
      const ownCount = Number((response.payload as { optionId?: string }).optionId)
      const targetId = resolution.data.targetId as PlayerId
      const owner = p(host.state, ownerId)
      const ownCards = [...(owner?.zones.hand ?? []), ...Object.values(owner?.zones.equipment ?? {}).filter((id): id is CardId => Boolean(id))]
      const targetCards = [...(p(host.state, targetId)?.zones.hand ?? []), ...Object.values(p(host.state, targetId)?.zones.equipment ?? {}).filter((id): id is CardId => Boolean(id))]
      s76(host.state).qiangzhiPending = { ownerId, targetId, ownCount, targetCount: 3 - ownCount, removed: { [ownerId]: [], [targetId]: [] } }
      markUsedThisPhase(host.state, ownerId, ZHENGHUN_QIANGZHI)
      if (ownCount) askCards(host, ZHENGHUN_QIANGZHI, ownerId, 'own-discard', ownerId, ownCards, '【强峙】：选择你弃置的牌', {}, ownCount, ownCount)
      else askCards(host, ZHENGHUN_QIANGZHI, ownerId, 'target-discard', targetId, targetCards,
        '【强峙】：选择目标弃置的牌', {}, 3, 3)
      return
    }
    const pending = s76(host.state).qiangzhiPending
    if (!pending) return
    if (resolution.step === 'own-discard') {
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const currentOwner = p(host.state, ownerId)
      const owned = new Set([...(currentOwner?.zones.hand ?? []), ...Object.values(currentOwner?.zones.equipment ?? {}).filter(Boolean)])
      const valid = ids.filter((id) => owned.has(id))
      pending.removed[ownerId] = valid
      if (valid.length) discardCardsByIds(host as never, ownerId, valid, ZHENGHUN_QIANGZHI)
      const targetId = pending.targetId as PlayerId
      const targetCards = [...(p(host.state, targetId)?.zones.hand ?? []), ...Object.values(p(host.state, targetId)?.zones.equipment ?? {}).filter((id): id is CardId => Boolean(id))]
      const count = pending.targetCount as number
      if (count) askCards(host, ZHENGHUN_QIANGZHI, ownerId, 'target-discard', targetId, targetCards, '【强峙】：选择目标弃置的牌', {}, count, count)
      else resolveQiangzhiDamage(host, pending)
      return
    }
    if (resolution.step === 'target-discard') {
      const targetId = pending.targetId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = ids.filter((id) => p(host.state, targetId)?.zones.hand.includes(id) || Object.values(p(host.state, targetId)?.zones.equipment ?? {}).includes(id))
      pending.removed[targetId] = valid
      if (valid.length) discardCardsByIds(host as never, targetId, valid, ZHENGHUN_QIANGZHI)
      resolveQiangzhiDamage(host, pending)
      return
    }
    if (resolution.step === 'damage-target') {
      const sourceId = resolution.data.sourceId as PlayerId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && p(host.state, sourceId)?.alive && p(host.state, targetId)?.alive)
        resolveDamage(host as never, { sourceId, targetId, amount: 1, reason: ZHENGHUN_QIANGZHI })
    }
  },
})
function resolveQiangzhiDamage(host: SkillHost, pending: any) {
  const ownerId = pending.ownerId as PlayerId, targetId = pending.targetId as PlayerId
  const a = pending.removed[ownerId] as CardId[], b = pending.removed[targetId] as CardId[]
  delete s76(host.state).qiangzhiPending
  const who = a.length === 3 ? ownerId : b.length === 3 ? targetId : null
  if (!who) return
  askTargets(host, ZHENGHUN_QIANGZHI, ownerId, 'damage-target', ownerId, living(host.state).filter((target) => target.id !== who).map(({ id }) => id),
    '【强峙】：选择“失去三张牌”的角色造成伤害的目标', { sourceId: who })
}

registerSkillRuntime({ id: LECW_SHUANGJIA,
  onGameStart(host, ownerId) {
    s76(host.state).hujia ??= {}
    s76(host.state).huajiaOwner ??= {}
    const hand = p(host.state, ownerId)?.zones.hand ?? []
    s76(host.state).huajia[ownerId] = [...hand]
    for (const id of hand) s76(host.state).huajiaOwner[id] = ownerId
  },
  distanceModifier: { fromOthers(state, ownerId) { return Math.min(5, (s76(state).huajia?.[ownerId] ?? []).length) } },
  handLimitExempt(state, ownerId, cardId) { return (s76(state).huajia?.[ownerId] ?? []).includes(cardId) },
})

registerSkillRuntime({ id: LECW_BEIFEN,
  unlimitedCardUses(state, ownerId) {
    const tagged = (s76(state).huajia?.[ownerId] ?? []).length
    const hand = p(state, ownerId)?.zones.hand.length ?? 0
    return tagged < hand - tagged
  },
  slashIgnoresDistance(state, ownerId) {
    const tagged = (s76(state).huajia?.[ownerId] ?? []).length
    return tagged < (p(state, ownerId)?.zones.hand.length ?? 0) - tagged
  },
  ignoresTrickDistance(state, ownerId) {
    const tagged = (s76(state).huajia?.[ownerId] ?? []).length
    return tagged < (p(state, ownerId)?.zones.hand.length ?? 0) - tagged
  },
  triggers: [
    { event: 'CardZoneMoved', handle(host, ownerId, context) {
      const data = context.event.payload as { fromKind?: string; fromPlayerId?: PlayerId | null; toKind?: string; toPlayerId?: PlayerId | null }
      const tagged = (s76(host.state).huajia?.[ownerId] ?? []) as CardId[]
      const lost = (context.event.cardIds ?? []).filter((id) => tagged.includes(id))
      if (data.fromKind !== 'hand' || data.fromPlayerId !== ownerId || data.toKind === 'hand' && data.toPlayerId === ownerId || !lost.length) return
      s76(host.state).huajia[ownerId] = tagged.filter((id) => !lost.includes(id))
      const remainingSuits = new Set(((s76(host.state).huajia?.[ownerId] ?? []) as CardId[]).map((id) => effectiveCardSuit(host.state, ownerId, id)))
      for (const suit of ['spade', 'heart', 'club', 'diamond'] as Suit[]) {
        if (remainingSuits.has(suit)) continue
        const id = host.state.zones.drawPile.find((cardId) => effectiveCardSuit(host.state, ownerId, cardId) === suit)
        if (id) {
          moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [id], reason: LECW_BEIFEN },
            { sourceId: ownerId, targetId: ownerId, cardIds: [id] })
        }
      }
    } },
  ],
})

registerSkillRuntime({ id: DONGWAN_SHENGDU, triggers: [
  { event: 'TurnStart', handle(host, ownerId) {
    const candidates = living(host.state).filter((target) => target.id !== ownerId).map(({ id }) => id)
    if (candidates.length) askTargets(host, DONGWAN_SHENGDU, ownerId, 'mark-target', ownerId, candidates, '【生妒】：选择一名其他角色获得“生妒”')
  } },
  { event: 'PhaseEnd', handle(host, ownerId, context) {
    if ((context.event.payload as { phase?: TurnPhase }).phase !== 'draw') return
    const actorId = (context.event.payload as { playerId?: PlayerId }).playerId
    const actor = actorId ? p(host.state, actorId) : undefined
    if (!actor || (actor.marks?.['生妒'] ?? 0) <= 0) return
    const amount = actor.marks!['生妒']!
    drawCards(host.state, host.rng, ownerId, amount)
    delete actor.marks!['生妒']
  } },
], resume(host, _ownerId, resolution, response) {
  if (resolution.step !== 'mark-target') return
  const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
  const target = targetId && p(host.state, targetId)
  if (target) { target.marks ??= {}; target.marks['生妒'] = (target.marks['生妒'] ?? 0) + 1 }
} })

registerSkillRuntime({ id: DONGWAN_JIELING,
  multiCardViewAs(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return null
    const used = (s76(state).jielingSuits?.[ownerId] ?? []) as Suit[]
    const available = (['spade', 'heart', 'club', 'diamond'] as Suit[]).filter((suit) => !used.includes(suit)
      && (p(state, ownerId)?.zones.hand ?? []).some((id) => effectiveCardSuit(state, ownerId, id) === suit))
    if (available.length < 2) return null
    return { skillId: DONGWAN_JIELING, skillName: '介绫', requiredCount: 2, sameSuit: false, distinctSuits: true,
      handOnly: true, allowedSuits: available, anySuitCardNames: ['杀'], suitToCardName: {}, onConvert(current, playerId, carrierId, cardIds) {
        const suits = [...new Set(cardIds.map((id) => effectiveCardSuit(current, playerId, id)))]
        s76(current).jielingConvertedSuit = { cardId: carrierId, suits }
      } }
  },
  unlimitedSlash: true,
  slashIgnoresDistance() { return true },
  triggers: [
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== DONGWAN_JIELING) return
      const cardId = context.event.cardIds?.[0]
      const targetId = (context.event.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!cardId || !targetId) return
      const converted = s76(host.state).jielingConvertedSuit
      const suits = converted?.cardId === cardId ? converted.suits as Suit[] : [effectiveCardSuit(host.state, ownerId, cardId)]
      s76(host.state).jielingSuits ??= {}
      s76(host.state).jielingSuits[ownerId] = [...new Set([...(s76(host.state).jielingSuits[ownerId] ?? []), ...suits])]
      delete s76(host.state).jielingConvertedSuit
      if (cardDamageDealt(host.state, cardId) > 0) {
        if (p(host.state, targetId)?.alive) loseHp(host as never, targetId, 1, DONGWAN_JIELING)
      } else {
        const target = p(host.state, targetId)
        if (target?.alive) { target.marks ??= {}; target.marks['生妒'] = (target.marks['生妒'] ?? 0) + 1 }
      }
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId && (context.event.payload as { phase?: TurnPhase }).phase === 'play')
        delete s76(host.state).jielingSuits?.[ownerId]
    } },
  ],
})

registerSkillRuntime({ id: BLING_XIECE,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const amount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      if (amount <= 0) return
      if (context.event.targetId === ownerId && !usedThisTurn(host.state, ownerId, `${BLING_XIECE}:defend`)) {
        const candidates = living(host.state).filter((target) => target.id !== ownerId).map(({ id }) => id)
        if (candidates.length) host.queueSkill({ skillId: BLING_XIECE, ownerId, step: 'choose-suppressed', data: { branch: 'defend', candidates } })
      }
      if (context.event.sourceId === ownerId && !usedThisTurn(host.state, ownerId, `${BLING_XIECE}:attack`))
        host.queueSkill({ skillId: BLING_XIECE, ownerId, step: 'discard-recover', data: {} })
    } },
    { event: 'TurnEnd', handle(host) {
      host.state.skillSuppressions = (host.state.skillSuppressions ?? []).filter((entry) => !(entry.sourceSkillId === BLING_XIECE
        && entry.armedAtTurn === host.state.turnNumber && entry.expiresAt === 'never'))
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'discard-recover') {
      const owner = p(host.state, ownerId)
      if (!owner || usedThisTurn(host.state, ownerId, `${BLING_XIECE}:attack`)) return
      const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      if (cards.length) askCards(host, BLING_XIECE, ownerId, 'discard-recover', ownerId,
        cards, '【黠策】：可弃置一张牌并回复1点体力', {}, 0, 1, true)
      return
    }
    if (prompt.step !== 'choose-suppressed') return
    const branch = prompt.data.branch as string
    const candidates = (prompt.data.candidates as PlayerId[]).filter((id) => p(host.state, id)?.alive)
    if (usedThisTurn(host.state, ownerId, `${BLING_XIECE}:${branch}`) || !candidates.length) return
    askTargets(host, BLING_XIECE, ownerId, `choose-${branch}`, ownerId, candidates, '【黠策】：令一名其他角色的非锁定技失效至本回合结束', { branch })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard-recover') {
      const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = p(host.state, ownerId)
      const owns = owner && ([...owner.zones.hand, ...Object.values(owner.zones.equipment).filter(Boolean)] as CardId[]).includes(id as CardId)
      if (id && owns && !usedThisTurn(host.state, ownerId, `${BLING_XIECE}:attack`)) {
        markUsedThisTurn(host.state, ownerId, `${BLING_XIECE}:attack`)
        discardCardsByIds(host as never, ownerId, [id], BLING_XIECE)
        recover(host as never, ownerId, 1, ownerId)
      }
      return
    }
    const branch = resolution.data.branch as string
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (resolution.step !== 'choose-defend' && resolution.step !== 'choose-attack') return
    if (!targetId || !p(host.state, targetId)?.alive || usedThisTurn(host.state, ownerId, `${BLING_XIECE}:${branch}`)) return
    markUsedThisTurn(host.state, ownerId, `${BLING_XIECE}:${branch}`)
    host.state.skillSuppressions ??= []
    host.state.skillSuppressions.push({ targetId, sourceId: ownerId,
      sourceSkillId: BLING_XIECE, scope: 'non-locked', expiresAt: 'never', armedAtTurn: host.state.turnNumber })
  },
})

registerSkillRuntime({ id: BLING_YUXIN, limited: true,
  dyingAssist(host, ownerId, dyingPlayerId) {
    const owner = p(host.state, ownerId), target = p(host.state, dyingPlayerId)
    if (!owner?.alive || !target?.alive || owner.usedLimitedSkills.includes(BLING_YUXIN)) return false
    host.askSkill({ skillId: BLING_YUXIN, ownerId, step: 'save', data: { dyingPlayerId }, build: (id) => ({ id,
      kind: 'choose-option', playerId: ownerId, prompt: '【御心】：是否令濒死角色回复体力？', timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '令其回复至规定体力值' }],
    }) })
    return 'pending'
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'save') return
    const targetId = resolution.data.dyingPlayerId as PlayerId
    const target = p(host.state, targetId), owner = p(host.state, ownerId)
    if ((response.payload as { optionId?: string }).optionId === 'yes' && target?.alive && owner?.alive
      && !owner.usedLimitedSkills.includes(BLING_YUXIN)) {
      owner.usedLimitedSkills.push(BLING_YUXIN)
      const desired = targetId === ownerId ? 1 : owner.hp
      recover(host as never, targetId, Math.max(0, desired - target.hp), ownerId)
    }
    continueDyingAssists(host as never)
  },
})

registerSkillRuntime({ id: HUANFAN_FUMOU, triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
  if (context.event.targetId !== ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
  const owner = p(host.state, ownerId)
  const count = Math.min(owner ? Math.max(0, owner.maxHp - owner.hp) : 0, living(host.state).length)
  if (count > 0) host.queueSkill({ skillId: HUANFAN_FUMOU, ownerId, step: 'select-actors', data: { count } })
} }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'select-actors') return
    const candidates = living(host.state).map(({ id }) => id)
    const max = Math.min(Number(prompt.data.count ?? 0), candidates.length)
    if (!max) return
    host.askSkill({ skillId: HUANFAN_FUMOU, ownerId, step: 'actor-order', data: {}, build: (id) => ({ id, kind: 'choose-targets', playerId: ownerId,
      prompt: '【腹谋】：选择至多X名角色并确定依次选择的顺序', timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 0, max }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'actor-order') {
      s76(host.state).fumouQueue = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? []).filter((id) => p(host.state, id)?.alive)
      runFumouNext(host, ownerId)
      return
    }
    if (resolution.step === 'choice') {
      const actorId = resolution.data.actorId as PlayerId
      const choice = (response.payload as { optionId?: string }).optionId
      const actor = p(host.state, actorId)
      if (!actor?.alive) { runFumouNext(host, ownerId); return }
      if (choice === 'discard-draw') {
        if (actor.zones.hand.length) discardCardsByIds(host as never, actorId, [...actor.zones.hand], HUANFAN_FUMOU)
        drawCards(host.state, host.rng, actorId, 2)
        runFumouNext(host, ownerId)
        return
      }
      if (choice === 'discard-equip-recover') {
        const ids = Object.values(actor.zones.equipment).filter((id): id is CardId => Boolean(id))
        if (ids.length) discardCardsByIds(host as never, actorId, ids, HUANFAN_FUMOU)
        recover(host as never, actorId, 1, ownerId)
        runFumouNext(host, ownerId)
        return
      }
      if (choice === 'move-field') {
        const cards = fieldCards(host.state).filter(({ cardId }) => fieldMoveDestinations(host.state, cardId).length > 0)
        if (cards.length) askCards(host, HUANFAN_FUMOU, ownerId, 'field-card', actorId, cards.map(({ cardId }) => cardId), '【腹谋】：选择移动一张场上的牌', { actorId })
        else runFumouNext(host, ownerId)
      }
      return
    }
    if (resolution.step === 'field-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const destinations = cardId ? fieldMoveDestinations(host.state, cardId) : []
      if (!cardId || !destinations.length) { runFumouNext(host, ownerId); return }
      askTargets(host, HUANFAN_FUMOU, ownerId, 'field-destination', resolution.data.actorId as PlayerId, destinations,
        '【腹谋】：选择移动目标', { cardId, actorId: resolution.data.actorId })
      return
    }
    if (resolution.step === 'field-destination') {
      const cardId = resolution.data.cardId as CardId
      const destination = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (destination && fieldMoveDestinations(host.state, cardId).includes(destination)) moveFieldCard(host as never, cardId, destination)
      runFumouNext(host, ownerId)
    }
  },
})
function runFumouNext(host: SkillHost, ownerId: PlayerId) {
  const queue = (s76(host.state).fumouQueue ?? []) as PlayerId[]
  while (queue.length && !p(host.state, queue[0]!)?.alive) queue.shift()
  const actorId = queue.shift()
  if (!actorId) { delete s76(host.state).fumouQueue; return }
  s76(host.state).fumouQueue = queue
  const canMoveField = fieldCards(host.state).some(({ cardId }) => fieldMoveDestinations(host.state, cardId).length > 0)
  askOption(host, HUANFAN_FUMOU, ownerId, 'choice', actorId, '【腹谋】：选择一项', [
    ...(canMoveField ? [{ id: 'move-field', label: '移动场上一张牌' }] : []),
    { id: 'discard-draw', label: '弃置所有手牌并摸两张牌' },
    { id: 'discard-equip-recover', label: '弃置装备区所有牌并回复1点体力' },
  ], { actorId }, false)
}

registerSkillRuntime({ id: MENGYOU_MANYI, cardEffectInvalid(_state, ownerId, _sourceId, cardName, _color, targetId) {
  return ownerId === targetId && cardName === '南蛮入侵'
} })

registerSkillRuntime({ id: MENGYOU_MANZHI, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = (context.event.payload as { phase?: TurnPhase }).phase
    if (context.event.sourceId === ownerId && phase === 'prepare') {
      s76(host.state).manzhi ??= {}
      s76(host.state).manzhi[ownerId] = { hp: p(host.state, ownerId)?.hp, used: [], turn: host.state.turnNumber }
      startManzhiTarget(host, ownerId, 'prepare')
    }
    if (context.event.sourceId === ownerId && phase === 'finish') {
      const record = s76(host.state).manzhi?.[ownerId]
      if (!record || record.turn !== host.state.turnNumber || p(host.state, ownerId)?.hp !== record.hp) return
      const unused = ['give-two', 'take-two'].filter((option) => !record.used.includes(option))
      if (unused.length) startManzhiTarget(host, ownerId, 'finish', unused)
    }
  } },
  { event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = (context.event.payload as { phase?: TurnPhase }).phase
    if (context.event.sourceId === ownerId && phase === 'finish') delete s76(host.state).manzhi?.[ownerId]
  } },
], resume(host, ownerId, resolution, response) {
  const record = s76(host.state).manzhi?.[ownerId]
  if (!record) return
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !p(host.state, targetId)?.alive) return
    askOption(host, MENGYOU_MANZHI, ownerId, 'mode', ownerId, '【蛮智】：选择一项', [
      ...((record.available ?? ['give-two', 'take-two']).includes('give-two') && (p(host.state, targetId)?.zones.hand.length ?? 0) >= 2
        ? [{ id: 'give-two', label: '其交给你两张手牌，然后其视为无距离限制使用【杀】' }] : []),
      ...((record.available ?? ['give-two', 'take-two']).includes('take-two')
        ? [{ id: 'take-two', label: '获得其区域内至多两张牌，然后交给其等量的牌并摸一张牌' }] : []),
    ], { targetId, timing: resolution.data.timing, available: record.available })
    return
  }
  if (resolution.step === 'mode') {
    const option = (response.payload as { optionId?: string }).optionId
    const targetId = resolution.data.targetId as PlayerId
    if (!option || !['give-two', 'take-two'].includes(option)) return
    record.used = [...new Set([...(record.used ?? []), option])]
    if (option === 'give-two') {
      askCards(host, MENGYOU_MANZHI, ownerId, 'target-gives', targetId, [...(p(host.state, targetId)?.zones.hand ?? [])], '【蛮智】：选择交给孟优的两张手牌', { targetId }, 2, 2)
      return
    }
    askPick(host, MENGYOU_MANZHI, ownerId, 'take-cards', ownerId, targetId, '【蛮智】：获得其区域内至多两张牌', { targetId }, 0, 2)
    return
  }
  if (resolution.step === 'target-gives') {
    const targetId = resolution.data.targetId as PlayerId
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const given = giveCards(host as never, targetId, ownerId, ids, MENGYOU_MANZHI)
    if (!p(host.state, targetId)?.alive || !given.length) return
    askTargets(host, MENGYOU_MANZHI, ownerId, 'slash-target', targetId, living(host.state).filter((candidate) => candidate.id !== targetId).map(({ id }) => id),
      '【蛮智】：选择【杀】的目标（无距离限制）', { targetId })
    return
  }
  if (resolution.step === 'slash-target') {
    const sourceId = resolution.data.targetId as PlayerId
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (targetId && p(host.state, sourceId)?.alive && p(host.state, targetId)?.alive)
      host.beginVirtualSlash({ sourceId, targetId, sourceSkillId: MENGYOU_MANZHI, ignoreDistance: true })
    return
  }
  if (resolution.step === 'take-cards') {
    const targetId = resolution.data.targetId as PlayerId
    const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const got: CardId[] = []
    for (const token of selected) {
      const id = resolvePickedCard(host.state, targetId, token)
      if (id && movePickedCard(host as never, targetId, id, { kind: 'hand', playerId: ownerId })) got.push(id)
    }
    if (!got.length) { drawCards(host.state, host.rng, ownerId, 1); return }
    askCards(host, MENGYOU_MANZHI, ownerId, 'return-cards', ownerId, [...(p(host.state, ownerId)?.zones.hand ?? [])], '【蛮智】：交给目标等量的手牌', { targetId, count: got.length }, got.length, got.length)
    return
  }
  if (resolution.step === 'return-cards') {
    const targetId = resolution.data.targetId as PlayerId
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    giveCards(host as never, ownerId, targetId, ids, MENGYOU_MANZHI)
    drawCards(host.state, host.rng, ownerId, 1)
  }
} })
function startManzhiTarget(host: SkillHost, ownerId: PlayerId, timing: 'prepare' | 'finish', available = ['give-two', 'take-two']) {
  const candidates = living(host.state).filter((target) => target.id !== ownerId).map(({ id }) => id)
  if (!candidates.length) return
  s76(host.state).manzhi[ownerId].available = available
  askTargets(host, MENGYOU_MANZHI, ownerId, 'target', ownerId, candidates, '【蛮智】：选择一名其他角色', { timing })
}

registerSkillRuntime({ id: ZHUGE_MENGXUE_JICHUN,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || !p(state, ownerId)?.alive) return []
    const cardIds = p(state, ownerId)!.zones.hand
    if (!cardIds.length) return []
    return [
      ...(!usedThisPhase(state, ownerId, `${ZHUGE_MENGXUE_JICHUN}:gift`) ? [{ id: 'jichun:gift', label: '【寄春】展示一张牌并交给手牌更少角色' }] : []),
      ...(!usedThisPhase(state, ownerId, `${ZHUGE_MENGXUE_JICHUN}:discard`) ? [{ id: 'jichun:discard', label: '【寄春】展示并弃置一张牌，弃置手牌更多角色的牌' }] : []),
    ]
  },
  invokeActive(host, ownerId, actionId) {
    if (!['jichun:gift', 'jichun:discard'].includes(actionId)) return
    const owner = p(host.state, ownerId)
    if (!owner?.zones.hand.length) return
    askCards(host, ZHUGE_MENGXUE_JICHUN, ownerId, 'show-card', ownerId, [...owner.zones.hand], '【寄春】：展示一张手牌', { branch: actionId.slice(7) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'show-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const branch = resolution.data.branch as string
      if (!cardId || !owner.zones.hand.includes(cardId) || usedThisPhase(host.state, ownerId, `${ZHUGE_MENGXUE_JICHUN}:${branch}`)) return
      host.dispatch('CardMove', { cardIds: [cardId], reason: ZHUGE_MENGXUE_JICHUN, revealed: true }, { sourceId: ownerId, cardIds: [cardId] })
      const nameLength = Array.from(host.state.cards[cardId]?.name ?? '').length
      if (branch === 'gift') {
        const candidates = living(host.state).filter((target) => target.id !== ownerId && target.zones.hand.length < owner.zones.hand.length).map(({ id }) => id)
        if (!candidates.length) return
        askTargets(host, ZHUGE_MENGXUE_JICHUN, ownerId, 'gift-target', ownerId, candidates, '【寄春】：选择获得此牌的角色', { cardId, nameLength })
      } else if (branch === 'discard') {
        discardCardsByIds(host as never, ownerId, [cardId], ZHUGE_MENGXUE_JICHUN)
        const candidates = living(host.state).filter((target) => target.id !== ownerId && target.zones.hand.length > owner.zones.hand.length).map(({ id }) => id)
        if (!candidates.length) { markUsedThisPhase(host.state, ownerId, `${ZHUGE_MENGXUE_JICHUN}:discard`); return }
        askTargets(host, ZHUGE_MENGXUE_JICHUN, ownerId, 'discard-target', ownerId, candidates, '【寄春】：选择手牌更多的角色', { nameLength })
      }
      return
    }
    if (resolution.step === 'gift-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = resolution.data.cardId as CardId
      if (!targetId || !owner.zones.hand.includes(cardId) || (p(host.state, targetId)?.zones.hand.length ?? Infinity) >= owner.zones.hand.length) return
      markUsedThisPhase(host.state, ownerId, `${ZHUGE_MENGXUE_JICHUN}:gift`)
      giveCards(host as never, ownerId, targetId, [cardId], ZHUGE_MENGXUE_JICHUN)
      drawCards(host.state, host.rng, ownerId, Number(resolution.data.nameLength ?? 0))
      return
    }
    if (resolution.step === 'discard-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || (p(host.state, targetId)?.zones.hand.length ?? 0) <= owner.zones.hand.length) return
      const available = pickableCardsOf(host.state, targetId, { discarderId: ownerId, includeJudgingArea: true })
      if (available.cardIds.length + available.hiddenCardSlots.length) askPick(host, ZHUGE_MENGXUE_JICHUN, ownerId, 'discard-target-cards', ownerId, targetId,
        `【寄春】：选择弃置至多${resolution.data.nameLength}张其区域内的牌`, { nameLength: resolution.data.nameLength }, 0, Number(resolution.data.nameLength ?? 0))
      else markUsedThisPhase(host.state, ownerId, `${ZHUGE_MENGXUE_JICHUN}:discard`)
      return
    }
    if (resolution.step === 'discard-target-cards') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const ids = selected.map((token) => resolvePickedCard(host.state, targetId, token)).filter((id): id is CardId => Boolean(id))
      for (const id of ids) movePickedCard(host as never, targetId, id, { kind: 'discardPile' })
      markUsedThisPhase(host.state, ownerId, `${ZHUGE_MENGXUE_JICHUN}:discard`)
    }
  },
})

registerSkillRuntime({ id: ZHUGE_MENGXUE_HANYING, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  if (context.event.sourceId !== ownerId || (context.event.payload as { phase?: TurnPhase }).phase !== 'prepare') return
  askOption(host, ZHUGE_MENGXUE_HANYING, ownerId, 'invoke', ownerId, '【寒英】：是否展示牌堆中第一张装备牌？',
    [{ id: 'yes', label: '展示并令一名手牌数相同的角色使用' }])
} }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') revealHanyingEquipment(host, ownerId)
      return
    }
    if (resolution.step === 'equipment-user') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = resolution.data.equipmentId as CardId
      if (!targetId || !p(host.state, targetId)?.alive || !host.state.zones.processingArea.includes(cardId)) { returnProcessingToTop(host, cardId); return }
      const candidates = skillHandCardUseActions(host.state, targetId, cardId)
      if (!candidates.length) { returnProcessingToTop(host, cardId); return }
      s76(host.state).hanyingActions = { cardId, targetId, actionIds: candidates.map(({ id }) => id) }
      host.askSkill({ skillId: ZHUGE_MENGXUE_HANYING, ownerId, step: 'use-equipment', data: { cardId, targetId }, build: (id): UseCardRequest => ({
        id, kind: 'use-card', playerId: targetId, prompt: '【寒英】：选择如何使用此装备牌', timeoutMs: 25_000, optional: false,
        actionIds: candidates.map(({ id }) => id),
      }) })
      return
    }
    if (resolution.step === 'use-equipment') {
      const cardId = resolution.data.cardId as CardId
      const targetId = resolution.data.targetId as PlayerId
      const actionId = (response.payload as { actionId?: string }).actionId
      const known = s76(host.state).hanyingActions
      if (actionId && known?.cardId === cardId && known?.targetId === targetId && known.actionIds.includes(actionId)
        && !host.beginSkillCardUseFromProcessing(targetId, cardId, ZHUGE_MENGXUE_HANYING, actionId)) returnProcessingToTop(host, cardId)
      delete s76(host.state).hanyingActions
    }
  },
})
function revealHanyingEquipment(host: SkillHost, ownerId: PlayerId) {
  const equipmentId = host.state.zones.drawPile.find((id) => host.state.cards[id]?.category === 'equipment')
  if (!equipmentId) return
  moveCard(host.state, equipmentId, { kind: 'drawPile' }, { kind: 'processingArea' })
  const count = p(host.state, ownerId)?.zones.hand.length ?? 0
  const candidates = living(host.state).filter((target) => target.zones.hand.length === count).map(({ id }) => id)
  if (candidates.length) askTargets(host, ZHUGE_MENGXUE_HANYING, ownerId, 'equipment-user', ownerId, candidates,
    '【寒英】：选择一名手牌数与你相同的角色使用亮出的装备牌', { equipmentId })
  else returnProcessingToTop(host, equipmentId)
}
function returnProcessingToTop(host: SkillHost, cardId: CardId) {
  if (!host.state.zones.processingArea.includes(cardId)) return
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' })
  const index = host.state.zones.drawPile.indexOf(cardId)
  if (index >= 0) { host.state.zones.drawPile.splice(index, 1); host.state.zones.drawPile.unshift(cardId) }
}

registerSkillRuntime({ id: GUANNING_DUNSHI,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisTurn(state, ownerId, GUANNING_DUNSHI)) return []
    const blocked = (s76(state).dunshiRemoved?.[ownerId] ?? []) as string[]
    const usable = ['杀', '桃', '酒'].some((name) => !blocked.includes(name)
      && (name !== '杀' || dunshiSlashTargets(state, ownerId).length > 0)
      && (name !== '桃' || (p(state, ownerId)?.hp ?? 0) < (p(state, ownerId)?.maxHp ?? 0)))
    return usable ? [{ id: 'dunshi:activate', label: '【遁世】视为使用一张【杀】【桃】或【酒】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'dunshi:activate' || usedThisTurn(host.state, ownerId, GUANNING_DUNSHI)) return
    const blocked = (s76(host.state).dunshiRemoved?.[ownerId] ?? []) as string[]
    const options = ['杀', '桃', '酒'].filter((name) => !blocked.includes(name)
      && (name !== '杀' || dunshiSlashTargets(host.state, ownerId).length > 0)
      && (name !== '桃' || (p(host.state, ownerId)?.hp ?? 0) < (p(host.state, ownerId)?.maxHp ?? 0)))
    if (options.length) askOption(host, GUANNING_DUNSHI, ownerId, 'use-name', ownerId, '【遁世】：选择视为使用的基本牌',
      options.map((name) => ({ id: name, label: `视为使用【${name}】` })))
  },
  virtualBasicResponse(state, ownerId, cardName) {
    return cardName === '闪' && !usedThisTurn(state, ownerId, GUANNING_DUNSHI)
      && !(s76(state).dunshiRemoved?.[ownerId] ?? []).includes('闪')
  },
  consumeVirtualBasicResponse(host, ownerId, cardName) {
    if (cardName !== '闪' || usedThisTurn(host.state, ownerId, GUANNING_DUNSHI)) return
    recordDunshiUse(host.state, ownerId, cardName)
  },
  rescueActions(state, ownerId) {
    return !usedThisTurn(state, ownerId, GUANNING_DUNSHI) && !(s76(state).dunshiRemoved?.[ownerId] ?? []).includes('桃')
      ? [{ id: 'dunshi:peach', label: '【遁世】视为使用【桃】' }] : []
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== 'dunshi:peach' || usedThisTurn(host.state, ownerId, GUANNING_DUNSHI)) return false
    if (!host.useVirtualPeachDuringDying(ownerId, dyingPlayerId, GUANNING_DUNSHI)) return false
    recordDunshiUse(host.state, ownerId, '桃')
    return true
  },
  offersGlobalDamageModifierAsk(host, ownerId, side, context) {
    const pending = s76(host.state).dunshiNextDamage?.[ownerId]
    if (side !== 'source' || !pending || pending.turn !== host.state.turnNumber || context.sourceId !== pending.actorId
      || Number(context.amount) <= 0 || s76(host.state).dunshiDamageChoice) return false
    delete s76(host.state).dunshiNextDamage[ownerId]
    s76(host.state).dunshiDamageChoice = { ownerId, actorId: pending.actorId, cardName: pending.cardName, amount: context.amount,
      options: [], turn: host.state.turnNumber }
    askOption(host, GUANNING_DUNSHI, ownerId, 'damage-choice-1', ownerId, '【遁世】：选择本次伤害处理选项（共选择两次）',
      dunshiChoices(host.state, pending.actorId, pending.cardName), {}, false)
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'use-name') {
      const name = (response.payload as { optionId?: string }).optionId
      if (!name || !['杀', '桃', '酒'].includes(name) || usedThisTurn(host.state, ownerId, GUANNING_DUNSHI)) return
      const ok = name === '杀'
        ? false
        : host.beginVirtualBasic({ sourceId: ownerId, targetIds: [ownerId], cardName: name, sourceSkillId: GUANNING_DUNSHI })
      if (name === '杀') {
        const candidates = dunshiSlashTargets(host.state, ownerId)
        if (candidates.length) askTargets(host, GUANNING_DUNSHI, ownerId, 'slash-target', ownerId, candidates, '【遁世】：选择【杀】的目标', { name })
        return
      }
      if (ok) recordDunshiUse(host.state, ownerId, name)
      return
    }
    if (resolution.step === 'slash-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && dunshiSlashTargets(host.state, ownerId).includes(targetId)
        && host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: GUANNING_DUNSHI }))
        recordDunshiUse(host.state, ownerId, '杀')
      return
    }
    const state = s76(host.state).dunshiDamageChoice
    if (!state || state.ownerId !== ownerId || state.turn !== host.state.turnNumber) return
    if (resolution.step === 'damage-choice-1' || resolution.step === 'damage-choice-2') {
      const choice = (response.payload as { optionId?: string }).optionId
      if (!choice || !['prevent-gain', 'lose-maxhp', 'remove-name'].includes(choice)) return
      state.options.push(choice)
      if (resolution.step === 'damage-choice-1') {
        askOption(host, GUANNING_DUNSHI, ownerId, 'damage-choice-2', ownerId, '【遁世】：再选择一项（可重复）',
          dunshiChoices(host.state, state.actorId, state.cardName), {}, false)
        return
      }
      const loseCount = state.options.filter((value: string) => value === 'lose-maxhp').length
      const removeCount = state.options.filter((value: string) => value === 'remove-name').length
      if (loseCount) {
        loseMaxHp(host as never, ownerId, loseCount, GUANNING_DUNSHI)
        drawCards(host.state, host.rng, ownerId, state.options.filter((value: string) => value === 'remove-name').length)
      }
      if (removeCount) {
        s76(host.state).dunshiRemoved ??= {}
        s76(host.state).dunshiRemoved[ownerId] = [...new Set([...(s76(host.state).dunshiRemoved[ownerId] ?? []), state.cardName])]
      }
      const grants = state.options.filter((value: string) => value === 'prevent-gain').length
      if (grants) {
        const actorId = state.actorId as PlayerId
        const choices = dunshiSkillChoices(host.state, actorId)
        if (choices.length) {
          s76(host.state).dunshiGrantQueue = { actorId, skills: choices, remaining: grants, state }
          askDunshiGrant(host, ownerId)
          return
        }
      }
      resumeDamageModifier(host as never, GUANNING_DUNSHI, state.options.includes('prevent-gain') ? -state.amount : 0)
      delete s76(host.state).dunshiDamageChoice
      return
    }
    if (resolution.step === 'grant-skill') {
      const queue = s76(host.state).dunshiGrantQueue
      const index = Number((response.payload as { optionId?: string }).optionId)
      const skill = queue?.skills?.[index]
      if (skill && p(host.state, queue.actorId)?.alive) grantSkill(host.state, queue.actorId, skill.id)
      if (queue && skill) queue.skills = queue.skills.filter((candidate: { id: string }) => candidate.id !== skill.id)
      queue.remaining -= 1
      if (queue.remaining > 0 && queue.skills.length > 0) { askDunshiGrant(host, ownerId); return }
      const damageState = queue.state
      resumeDamageModifier(host as never, GUANNING_DUNSHI, damageState.options.includes('prevent-gain') ? -damageState.amount : 0)
      delete s76(host.state).dunshiDamageChoice
      delete s76(host.state).dunshiGrantQueue
    }
  },
})
function recordDunshiUse(state: SanguoshaState, ownerId: PlayerId, cardName: string) {
  markUsedThisTurn(state, ownerId, GUANNING_DUNSHI)
  const actorId = state.currentPlayerId
  if (actorId) {
    s76(state).dunshiNextDamage ??= {}
    s76(state).dunshiNextDamage[ownerId] = { actorId, turn: state.turnNumber, cardName }
  }
}
function dunshiSlashTargets(state: SanguoshaState, ownerId: PlayerId) {
  if (isCardUseProhibited(state, ownerId, '杀', { dyingPlayerId: state.dying?.playerId ?? null }, skillIdsOf)) return []
  return living(state).filter((target) => canTarget(state, ownerId, target.id)
    && !isTargetProhibited(state, ownerId, target.id, '杀', skillIdsOf, undefined, GUANNING_DUNSHI))
    .map(({ id }) => id)
}
function dunshiSkillChoices(state: SanguoshaState, actorId: PlayerId) {
  const tokens = ['仁', '义', '礼', '智', '信']
  const actor = p(state, actorId)
  const known = new Set([...(actor?.grantedSkills ?? []), ...(actor?.temporaryGrantedSkills ?? []).map((entry) => entry.skillId),
    ...(actor?.characterId ? skillIdsOf(actor.characterId) : [])])
  const seen = new Set<string>()
  return ALL_CHARACTERS.flatMap((character) => character.skills)
    .filter((skill) => tokens.some((token) => skill.name.includes(token)) && getSkillRuntime(skill.id)
      && !known.has(skill.id) && !seen.has(skill.id) && Boolean(seen.add(skill.id)))
}
function dunshiChoices(state: SanguoshaState, actorId: PlayerId, cardName: string) {
  return [
    ...(dunshiSkillChoices(state, actorId).length ? [{ id: 'prevent-gain', label: '防止此伤害并选择一项含“仁义礼智信”的技能令伤害来源获得' }] : []),
    { id: 'lose-maxhp', label: '减1点体力上限并摸牌' },
    { id: 'remove-name', label: `删除本次视为使用的【${cardName}】名称` },
  ]
}
function askDunshiGrant(host: SkillHost, ownerId: PlayerId) {
  const queue = s76(host.state).dunshiGrantQueue
  if (!queue) return
  host.askSkill({ skillId: GUANNING_DUNSHI, ownerId, step: 'grant-skill', data: {}, build: (id) => ({ id,
    kind: 'choose-option', playerId: ownerId, prompt: `【遁世】：选择一项技能令伤害来源获得（剩余${queue.remaining}次）`, timeoutMs: 25_000,
    optional: false, options: queue.skills.map((skill: { id: string; name: string }, index: number) => ({ id: String(index), label: skill.name })),
  }) })
}

registerSkillRuntime({ id: HUANFAN_JIANZHENG,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, HUANFAN_JIANZHENG)) return []
    return living(state).some((target) => target.id !== ownerId && target.zones.hand.length > 0)
      ? [{ id: 'jianzheng:activate', label: '【谏诤】观看一名其他角色的手牌并使用其中一张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'jianzheng:activate') return
    const candidates = living(host.state).filter((target) => target.id !== ownerId && target.zones.hand.length > 0).map(({ id }) => id)
    if (candidates.length) askTargets(host, HUANFAN_JIANZHENG, ownerId, 'target', ownerId, candidates, '【谏诤】：选择观看手牌的角色')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? p(host.state, targetId) : undefined
      if (!target?.alive) return
      const actions = skillOtherHandCardUseActions(host.state, ownerId, target.id, target.zones.hand)
      const playable = new Set(actions.flatMap((action) => action.cardIds))
      if (!playable.size) return
      host.askSkill({ skillId: HUANFAN_JIANZHENG, ownerId, step: 'choose-card', data: { targetId }, build: (id) => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【谏诤】：观看其全部手牌，并选择一张你可以使用的牌', timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds: [...playable], viewOnlyCardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-card') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !p(host.state, targetId)?.zones.hand.includes(cardId)) return
      const actions = skillOtherHandCardUseActions(host.state, ownerId, targetId, cardId)
      if (!actions.length) return
      s76(host.state).jianzhengActions = { targetId, cardId, actions }
      askOption(host, HUANFAN_JIANZHENG, ownerId, 'choose-action', ownerId, '【谏诤】：选择使用方式与目标',
        actions.map((action, index) => ({ id: String(index), label: action.label })), { targetId, cardId }, false)
      return
    }
    if (resolution.step === 'choose-action') {
      const index = Number((response.payload as { optionId?: string }).optionId)
      const stored = s76(host.state).jianzhengActions
      const action = stored?.actions?.[index]
      const targetId = resolution.data.targetId as PlayerId
      const cardId = resolution.data.cardId as CardId
      if (!action || stored.targetId !== targetId || stored.cardId !== cardId || !p(host.state, targetId)?.zones.hand.includes(cardId)) return
      const targetsBorrowed = action.targetIds.includes(targetId)
      s76(host.state).jianzhengFollowup = { ownerId, targetId, targetsBorrowed }
      const used = host.beginSkillCardUseFromOtherHand(ownerId, targetId, cardId, HUANFAN_JIANZHENG, action.id)
      delete s76(host.state).jianzhengActions
      if (used) {
        markUsedThisPhase(host.state, ownerId, HUANFAN_JIANZHENG)
      } else delete s76(host.state).jianzhengFollowup
    }
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const followup = s76(host.state).jianzhengFollowup
    if (!followup || followup.ownerId !== ownerId || context.event.sourceSkillId !== HUANFAN_JIANZHENG) return
    delete s76(host.state).jianzhengFollowup
    if (!followup.targetsBorrowed || !p(host.state, ownerId)?.alive || !p(host.state, followup.targetId)?.alive) return
    setChained(host as never, ownerId, '谏诤', true)
    setChained(host as never, followup.targetId, '谏诤', true)
    const cards = p(host.state, ownerId)?.zones.hand ?? []
    if (cards.length) host.askSkill({ skillId: HUANFAN_JIANZHENG, ownerId, step: 'borrower-views', data: { targetId: followup.targetId }, build: (id) => ({
      id, kind: 'choose-cards', playerId: followup.targetId, prompt: '【谏诤】：观看谏诤者的全部手牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [], viewOnlyCardIds: [...cards], hiddenCardSlots: [], min: 0, max: 0,
    }) })
  } }],
})

const MENGJIE_TOKENS = ['乐泉', '藿溪', '瘴气', '芸香'] as const
type MengjieToken = typeof MENGJIE_TOKENS[number]
function tokenCount(state: SanguoshaState, playerId: PlayerId, token: MengjieToken): number { return p(state, playerId)?.marks?.[token] ?? 0 }
function setTokenCount(state: SanguoshaState, playerId: PlayerId, token: MengjieToken, count: number) {
  const target = p(state, playerId)
  if (!target) return
  target.marks ??= {}
  if (count > 0) target.marks[token] = count
  else delete target.marks[token]
}
function ownedCardsWithSuit(state: SanguoshaState, playerId: PlayerId, suit: Suit): CardId[] {
  const target = p(state, playerId)
  if (!target) return []
  return [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
    .filter((id) => effectiveCardSuit(state, playerId, id) === suit)
}

registerSkillRuntime({ id: MENGJIE_YINLU,
  onGameStart(host, ownerId) {
    s76(host.state).yinluAssigned = []
    assignYinluToken(host, ownerId, 0)
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = (context.event.payload as { phase?: TurnPhase }).phase
      if (context.event.sourceId === ownerId && phase === 'prepare') {
        const movable = living(host.state).flatMap((target) => MENGJIE_TOKENS.filter((token) => tokenCount(host.state, target.id, token) > 0)
          .map((token) => ({ playerId: target.id, token })))
        if (!movable.length) return
        askOption(host, MENGJIE_YINLU, ownerId, 'move-token', ownerId, '【引路】：选择移动一枚标记',
          movable.map(({ playerId, token }, index) => ({ id: String(index), label: `移动${p(host.state, playerId)?.nickname}的“${token}”` })),
          { movable })
      }
      if (phase === 'finish') {
        const queue = living(host.state).flatMap((target) => MENGJIE_TOKENS.filter((token) => tokenCount(host.state, target.id, token) > 0)
          .map((token) => ({ playerId: target.id, token })))
        if (queue.length) { s76(host.state).yinluFinishQueue = queue; runYinluFinishNext(host, ownerId) }
      }
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const deadId = context.event.targetId
      if (!deadId) return
      const tokens = MENGJIE_TOKENS.filter((token) => tokenCount(host.state, deadId, token) > 0)
      if (tokens.length) host.queueSkill({ skillId: MENGJIE_YINLU, ownerId, step: 'dead-token', data: { deadId, tokens } })
    } },
  ],
  offersGlobalDamageModifierAsk(host, ownerId, side, context) {
    const target = p(host.state, context.targetId)
    const count = tokenCount(host.state, context.targetId, '芸香')
    if (side !== 'target' || !target?.alive || count <= 0 || context.amount <= 0) return false
    host.askSkill({ skillId: MENGJIE_YINLU, ownerId, step: 'use-herbs', data: { targetId: context.targetId, count, amount: context.amount }, build: (id) => ({
      id, kind: 'choose-option', playerId: context.targetId, prompt: `【引路】芸香：是否移去${count}枚“芸香”防止等量伤害？`, timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: `移去全部${count}枚“芸香”` }],
    }) })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step.startsWith('assign-')) {
      const index = Number(prompt.step.slice('assign-'.length))
      const targetId = (prompt.data.targetIds as PlayerId[] | undefined)?.[0]
      const token = prompt.data.token as MengjieToken
      if (targetId && p(host.state, targetId)?.alive && MENGJIE_TOKENS.includes(token)) {
        setTokenCount(host.state, targetId, token, tokenCount(host.state, targetId, token) + 1)
        s76(host.state).yinluAssigned = [...((s76(host.state).yinluAssigned ?? []) as PlayerId[]), targetId]
      }
      assignYinluToken(host, ownerId, index + 1)
      return
    }
    if (prompt.step !== 'dead-token') return
    const deadId = prompt.data.deadId as PlayerId
    const tokens = (prompt.data.tokens as MengjieToken[]).filter((token) => tokenCount(host.state, deadId, token) > 0)
    const candidates = living(host.state).filter((target) => target.id !== deadId).map(({ id }) => id)
    if (!tokens.length || !candidates.length) return
    askOption(host, MENGJIE_YINLU, ownerId, 'choose-dead-token', ownerId, '【引路】：选择从已死亡角色处移动的标记',
      tokens.map((token) => ({ id: token, label: `移动“${token}”` })), { deadId, candidates })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step.startsWith('assign-')) {
      const index = Number(resolution.step.slice('assign-'.length))
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const token = resolution.data.token as MengjieToken
      if (targetId && p(host.state, targetId)?.alive && MENGJIE_TOKENS.includes(token)) {
        setTokenCount(host.state, targetId, token, tokenCount(host.state, targetId, token) + 1)
        s76(host.state).yinluAssigned = [...((s76(host.state).yinluAssigned ?? []) as PlayerId[]), targetId]
      }
      assignYinluToken(host, ownerId, index + 1)
      return
    }
    if (resolution.step === 'move-token') {
      const index = Number((response.payload as { optionId?: string }).optionId)
      const entry = (resolution.data.movable as Array<{ playerId: PlayerId; token: MengjieToken }>)[index]
      if (!entry || tokenCount(host.state, entry.playerId, entry.token) <= 0) return
      const candidates = living(host.state).filter((target) => target.id !== entry.playerId).map(({ id }) => id)
      if (candidates.length) askTargets(host, MENGJIE_YINLU, ownerId, 'move-destination', ownerId, candidates, '【引路】：选择标记的新持有者', entry)
      return
    }
    if (resolution.step === 'move-destination') {
      const entry = resolution.data as { playerId: PlayerId; token: MengjieToken }
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !p(host.state, targetId)?.alive || tokenCount(host.state, entry.playerId, entry.token) <= 0) return
      setTokenCount(host.state, entry.playerId, entry.token, tokenCount(host.state, entry.playerId, entry.token) - 1)
      setTokenCount(host.state, targetId, entry.token, tokenCount(host.state, targetId, entry.token) + 1)
      return
    }
    if (resolution.step === 'choose-dead-token') {
      const deadId = resolution.data.deadId as PlayerId
      const token = (response.payload as { optionId?: MengjieToken }).optionId
      const candidates = resolution.data.candidates as PlayerId[]
      if (!token || !MENGJIE_TOKENS.includes(token) || tokenCount(host.state, deadId, token) <= 0) return
      askTargets(host, MENGJIE_YINLU, ownerId, 'dead-token-destination', ownerId, candidates.filter((id) => p(host.state, id)?.alive),
        '【引路】：选择该标记的新持有者', { deadId, token })
      return
    }
    if (resolution.step === 'dead-token-destination') {
      const deadId = resolution.data.deadId as PlayerId
      const token = resolution.data.token as MengjieToken
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !p(host.state, targetId)?.alive || tokenCount(host.state, deadId, token) <= 0) return
      setTokenCount(host.state, deadId, token, tokenCount(host.state, deadId, token) - 1)
      setTokenCount(host.state, targetId, token, tokenCount(host.state, targetId, token) + 1)
      return
    }
    if (resolution.step === 'use-herbs') {
      const targetId = resolution.data.targetId as PlayerId
      const choice = (response.payload as { optionId?: string }).optionId
      const count = tokenCount(host.state, targetId, '芸香')
      if (choice === 'yes' && count > 0) {
        setTokenCount(host.state, targetId, '芸香', 0)
        resumeDamageModifier(host as never, MENGJIE_YINLU, -Math.min(count, Number(resolution.data.amount ?? 0)))
      } else resumeDamageModifier(host as never, MENGJIE_YINLU, 0)
      return
    }
    if (resolution.step === 'finish-choice') {
      finishYinluToken(host, ownerId, resolution.data.playerId as PlayerId, resolution.data.token as MengjieToken,
        (response.payload as { optionId?: string }).optionId)
      return
    }
    if (resolution.step === 'finish-discard') {
      const playerId = resolution.data.playerId as PlayerId
      const token = resolution.data.token as MengjieToken
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = ids.filter((id) => ownedCardsWithSuit(host.state, playerId, resolution.data.suit as Suit).includes(id))
      if (valid.length) {
        discardCardsByIds(host as never, playerId, [valid[0]!], MENGJIE_YINLU)
        if (token === '乐泉') recover(host as never, playerId, 1, ownerId)
        if (token === '藿溪') drawCards(host.state, host.rng, playerId, 2)
        if (token === '芸香') setTokenCount(host.state, playerId, token, tokenCount(host.state, playerId, token) + 1)
      } else if (token === '瘴气') loseHp(host as never, playerId, 1, MENGJIE_YINLU)
      runYinluFinishNext(host, ownerId)
    }
  },
})
function assignYinluToken(host: SkillHost, ownerId: PlayerId, index: number) {
  const names = ['乐泉', '藿溪', '瘴气'] as const
  if (index >= names.length) { setTokenCount(host.state, ownerId, '芸香', tokenCount(host.state, ownerId, '芸香') + 1); return }
  const assigned = (s76(host.state).yinluAssigned ?? []) as PlayerId[]
  const candidates = living(host.state).filter((target) => target.id !== ownerId && !assigned.includes(target.id)).map(({ id }) => id)
  if (!candidates.length) { assignYinluToken(host, ownerId, index + 1); return }
  askTargets(host, MENGJIE_YINLU, ownerId, `assign-${index}`, ownerId, candidates, `【引路】：为“${names[index]}”选择一名角色`, { index, token: names[index] })
}
function runYinluFinishNext(host: SkillHost, ownerId: PlayerId) {
  const queue = (s76(host.state).yinluFinishQueue ?? []) as Array<{ playerId: PlayerId; token: MengjieToken }>
  while (queue.length && (!p(host.state, queue[0]!.playerId)?.alive || tokenCount(host.state, queue[0]!.playerId, queue[0]!.token) <= 0)) queue.shift()
  const entry = queue.shift()
  if (!entry) { delete s76(host.state).yinluFinishQueue; return }
  s76(host.state).yinluFinishQueue = queue
  const suit: Partial<Record<MengjieToken, Suit>> = { 乐泉: 'diamond', 藿溪: 'heart', 芸香: 'club', 瘴气: 'spade' }
  const available = ownedCardsWithSuit(host.state, entry.playerId, suit[entry.token]!)
  if (entry.token === '瘴气' && !available.length) { loseHp(host as never, entry.playerId, 1, MENGJIE_YINLU); runYinluFinishNext(host, ownerId); return }
  if (entry.token !== '瘴气' && !available.length) { runYinluFinishNext(host, ownerId); return }
  if (entry.token === '瘴气') {
    askOption(host, MENGJIE_YINLU, ownerId, 'finish-choice', entry.playerId, '【引路】“瘴气”：选择弃置黑桃牌或失去1点体力', [
      ...(available.length ? [{ id: 'discard', label: '弃置一张黑桃牌' }] : []), { id: 'lose-hp', label: '失去1点体力' },
    ], entry, false)
    return
  }
  askOption(host, MENGJIE_YINLU, ownerId, 'finish-choice', entry.playerId, `【引路】“${entry.token}”：是否发动？`, [
    { id: 'use', label: available.length ? `弃置一张${suitName(suit[entry.token]!)}牌并执行效果` : '发动效果' },
  ], entry, true)
}
function finishYinluToken(host: SkillHost, ownerId: PlayerId, playerId: PlayerId, token: MengjieToken, choice?: string) {
  if (token === '瘴气') {
    if (choice !== 'discard') { loseHp(host as never, playerId, 1, MENGJIE_YINLU); runYinluFinishNext(host, ownerId); return }
    askCards(host, MENGJIE_YINLU, ownerId, 'finish-discard', playerId, ownedCardsWithSuit(host.state, playerId, 'spade'),
      '【引路】“瘴气”：选择弃置一张黑桃牌', { playerId, token, suit: 'spade' })
    return
  }
  if (choice !== 'use') { runYinluFinishNext(host, ownerId); return }
  const suit: Record<MengjieToken, Suit> = { 乐泉: 'diamond', 藿溪: 'heart', 瘴气: 'spade', 芸香: 'club' }
  const cards = ownedCardsWithSuit(host.state, playerId, suit[token])
  if (!cards.length) {
    runYinluFinishNext(host, ownerId)
    return
  }
  askCards(host, MENGJIE_YINLU, ownerId, 'finish-discard', playerId, cards, `【引路】“${token}”：选择弃置的${suitName(suit[token])}牌`, { playerId, token, suit: suit[token] })
}
function suitName(suit: Suit) { return ({ spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' })[suit] }

registerSkillRuntime({ id: MENGJIE_YOUQI, triggers: [{ event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
  const data = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null; reason?: string }
  if (!data.cardId || data.reason !== MENGJIE_YINLU || !data.fromPlayerId || data.fromPlayerId === ownerId
    || !host.state.zones.discardPile.includes(data.cardId)) return
  const distance = Math.max(1, getDistance(host.state, data.fromPlayerId, ownerId))
  // 技能原文只规定距离越近概率越高，未公布具体概率；采用随距离严格递减的 1/(距离+1)。
  if (host.rng.nextInt(distance + 1) !== 0) return
  moveCard(host.state, data.cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [data.cardId], reason: MENGJIE_YOUQI },
    { sourceId: data.fromPlayerId, targetId: ownerId, cardIds: [data.cardId] })
} }] })

registerSkillRuntime({ id: BLING_LINGHUI, triggers: [
  { event: 'EnterDying', handle(host) { s76(host.state).linghuiDyingTurn = host.state.turnNumber } },
  { event: 'PhaseStart', handle(host, ownerId, context) {
    if ((context.event.payload as { phase?: TurnPhase }).phase !== 'finish') return
    if (host.state.currentPlayerId !== ownerId && s76(host.state).linghuiDyingTurn !== host.state.turnNumber) return
    if (s76(host.state).linghui?.[ownerId]?.turn === host.state.turnNumber) return
    const cards = revealTopCards(host.state, host.rng, 3, BLING_LINGHUI, (name, payload) => host.dispatch(name, payload)) as CardId[]
    if (!cards.length) return
    const actionMap: Record<string, Array<{ id: string; label: string }>> = {}
    for (const cardId of cards) {
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      const actions = skillHandCardUseActions(host.state, ownerId, cardId).map(({ id, label }) => ({ id, label }))
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
      if (actions.length) actionMap[cardId] = actions
    }
    s76(host.state).linghui ??= {}
    s76(host.state).linghui[ownerId] = { turn: host.state.turnNumber, cards, actions: actionMap }
    askOption(host, BLING_LINGHUI, ownerId, 'choose-to-use', ownerId, '【灵慧】：可使用其中一张牌；选择不使用则从三张中随机获得一张', [
      ...Object.keys(actionMap).map((cardId) => ({ id: `use:${cardId}`, label: `使用亮出的【${host.state.cards[cardId]?.name ?? '牌'}】` })),
      { id: 'skip', label: '不使用' },
    ], {}, false)
  } },
  { event: 'CardResolved', handle(host, ownerId, context) {
    if (context.event.sourceSkillId !== BLING_LINGHUI) return
    finishLinghui(host, ownerId, true)
  } },
], resume(host, ownerId, resolution, response) {
  const record = s76(host.state).linghui?.[ownerId]
  if (!record || record.turn !== host.state.turnNumber) return
  if (resolution.step === 'choose-to-use') {
    const choice = (response.payload as { optionId?: string }).optionId ?? 'skip'
    if (choice === 'skip') { finishLinghui(host, ownerId, false); return }
    const cardId = choice.slice(4) as CardId
    const actions = record.actions?.[cardId] as Array<{ id: string; label: string }> | undefined
    if (!actions?.length || !record.cards.includes(cardId)) { finishLinghui(host, ownerId, false); return }
    s76(host.state).linghui[ownerId].chosen = cardId
    askOption(host, BLING_LINGHUI, ownerId, 'choose-action', ownerId, '【灵慧】：选择牌的使用方式与目标',
      actions.map((action, index) => ({ id: String(index), label: action.label })), { cardId }, false)
    return
  }
  if (resolution.step === 'choose-action') {
    const cardId = resolution.data.cardId as CardId
    const index = Number((response.payload as { optionId?: string }).optionId)
    const action = (record.actions?.[cardId] as Array<{ id: string }> | undefined)?.[index]
    if (!action || !record.cards.includes(cardId)) { finishLinghui(host, ownerId, false); return }
    s76(host.state).linghui[ownerId].using = true
    if (!host.beginSkillCardUseFromProcessing(ownerId, cardId, BLING_LINGHUI, action.id)) finishLinghui(host, ownerId, false)
  }
},
})
function finishLinghui(host: SkillHost, ownerId: PlayerId, used: boolean) {
  const record = s76(host.state).linghui?.[ownerId]
  if (!record) return
  const cards = (record.cards as CardId[]).filter((id) => host.state.zones.processingArea.includes(id))
  const remaining = used ? cards.filter((id) => id !== record.chosen) : cards
  const owner = p(host.state, ownerId)
  if (remaining.length && owner?.alive) {
    const index = host.rng.nextInt(remaining.length)
    const gained = remaining[index]!
    moveCard(host.state, gained, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [gained], reason: BLING_LINGHUI }, { targetId: ownerId, cardIds: [gained] })
    for (const id of remaining) if (id !== gained && host.state.zones.processingArea.includes(id)) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
  } else for (const id of remaining) if (host.state.zones.processingArea.includes(id)) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
  record.used = true
  delete s76(host.state).linghui[ownerId]
}

registerSkillRuntime({ id: ZHOUBUYI_SHIJI, triggers: [
  { event: 'TurnStart', handle(host) { s76(host.state).turnDamage = {} } },
  { event: 'DamageSettled', handle(host, _ownerId, context) {
    if (context.event.sourceId && Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) > 0)
      (s76(host.state).turnDamage ??= {})[context.event.sourceId] = host.state.turnNumber
  } },
  { event: 'TurnEnd', handle(host, ownerId) {
    const actorId = host.state.currentPlayerId
    if (!actorId || s76(host.state).turnDamage?.[actorId] === host.state.turnNumber) return
    const used = (s76(host.state).shijiUsed?.[ownerId]?.[host.state.roundNumber] ?? []) as string[]
    const available = [...INSTANT_TRICKS].filter((name) => !used.includes(name))
    if (available.length) askOption(host, ZHOUBUYI_SHIJI, ownerId, 'declare', ownerId, '【十计】：声明一张本轮未声明过的普通锦囊牌',
      available.map((name) => ({ id: name, label: `声明【${name}】` })), { actorId })
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'declare') {
    const name = (response.payload as { optionId?: string }).optionId
    const actorId = resolution.data.actorId as PlayerId
    if (!name || !INSTANT_TRICKS.has(name) || !p(host.state, actorId)?.alive) return
    s76(host.state).shijiUsed ??= {}
    s76(host.state).shijiUsed[ownerId] ??= {}
    s76(host.state).shijiUsed[ownerId][host.state.roundNumber] = [...(s76(host.state).shijiUsed[ownerId][host.state.roundNumber] ?? []), name]
    const hand = p(host.state, actorId)!.zones.hand
    const usable = hand.filter((cardId) => declaredCardActions(host.state, actorId, cardId, name, `【十计】声明【${name}】`)
      .some((action) => action.kind === 'use-card' && action.targetIds.every((targetId) => targetId !== actorId)))
    if (!usable.length) return
    host.askSkill({ skillId: ZHOUBUYI_SHIJI, ownerId, step: 'accept', data: { actorId, name, usable }, build: (id) => ({ id,
      kind: 'choose-option', playerId: actorId, prompt: `【十计】：是否将一张手牌当作【${name}】使用（不能指定自己）？`, timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '使用一张手牌' }],
    }) })
    return
  }
  if (resolution.step === 'accept') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const actorId = resolution.data.actorId as PlayerId
    const name = resolution.data.name as string
    const usable = (resolution.data.usable as CardId[]).filter((id) => p(host.state, actorId)?.zones.hand.includes(id))
    if (usable.length) askCards(host, ZHOUBUYI_SHIJI, ownerId, 'choose-card', actorId, usable, `【十计】：选择当作【${name}】使用的手牌`, { actorId, name })
    return
  }
  if (resolution.step === 'choose-card') {
    const actorId = resolution.data.actorId as PlayerId
    const name = resolution.data.name as string
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !p(host.state, actorId)?.zones.hand.includes(cardId)) return
    const actions = declaredCardActions(host.state, actorId, cardId, name, `【十计】当作【${name}】使用`)
      .filter((action) => action.kind === 'use-card' && action.targetIds.every((targetId) => targetId !== actorId))
    if (!actions.length) return
    s76(host.state).shijiActions = { actorId, cardId, name, actions }
    askOption(host, ZHOUBUYI_SHIJI, ownerId, 'choose-action', actorId, '【十计】：选择牌的目标',
      actions.map((action, index) => ({ id: String(index), label: action.label })), {}, false)
    return
  }
  if (resolution.step === 'choose-action') {
    const stored = s76(host.state).shijiActions
    const action = stored?.actions?.[Number((response.payload as { optionId?: string }).optionId)]
    if (!action || !p(host.state, stored.actorId)?.zones.hand.includes(stored.cardId)) return
    host.beginSkillDeclaredCardUseFromOtherHand({ playerId: stored.actorId, physicalOwnerId: stored.actorId,
      cardId: stored.cardId, asCardName: stored.name, targetIds: action.targetIds, sourceSkillId: ZHOUBUYI_SHIJI })
    delete s76(host.state).shijiActions
  }
} })
