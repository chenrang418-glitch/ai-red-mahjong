import { resolveDamage } from '../../engine/damage'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { kingdomOf } from './lords'

/**
 * 张角【雷击】【鬼道】【黄天】。
 *
 * 采用**经典风包版**，锁定的规则文本见 docs/sanguosha-ruleset-v1.md。
 * 界限突破、OL、十周年都不混进来。
 *
 * 三个技能全部复用已有的公共机制，**没有为张角新建任何一套并行系统**：
 * - 雷击的判定走 `performJudgment` + 续接（和司马懿、刚烈、洛神同一条路）；
 * - 雷击的伤害走 `resolveDamage` 的 `nature: 'thunder'`，铁索传导自动生效；
 * - 鬼道复用为司马懿【鬼才】建立的 `SkillRuntime.retrial`，只是能用的牌不同；
 * - 黄天复用主公技的授权入口 `grantsPlayActions`。
 */

export const LEIJI = 'leiji'
export const GUIDAO = 'guidao'
export const HUANGTIAN = 'huangtian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// —— 雷击 ——
//
// 「每当你使用或打出一张【闪】时，你可以令一名角色进行判定，
//   若结果为黑桃，你对该角色造成 2 点雷电伤害。」
//
// 挂在 `CardResponded` 上：【闪】在标准局里只会被「打出」，
// 转化出来的【闪】（倾国、龙胆）走的也是同一条派发，所以一并覆盖。
// 已知简化：八卦阵判定成功是「视为打出一张【闪】」，但引擎那条路径
// 不产生实体牌的 CardResponded，因此不触发雷击——记在规则文档里。
//
// 发问必须走延后队列：这时候【杀】的结算还没走完，当场发问会让
// 玩家的回答和结算错位（麒麟弓踩过同一个坑）。

const LEIJI_TAG = 'leiji'

registerSkillRuntime({
  id: LEIJI,
  triggers: [{
    event: 'CardResponded',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: string; cardName?: string }
      if (payload.cardName !== '闪' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: LEIJI, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // 排队期间局势可能已经变了，前提不成立就安静放弃
    if (leijiTargets(host.state, ownerId).length === 0) return
    host.askSkill({
      skillId: LEIJI,
      ownerId,
      step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: '发动【雷击】？令一名角色判定，若为黑桃则对其造成 2 点雷电伤害',
        timeoutMs: 20_000,
        optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidates = leijiTargets(host.state, ownerId)
      if (candidates.length === 0) return
      host.askSkill({
        skillId: LEIJI,
        ownerId,
        step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId,
          kind: 'choose-targets',
          playerId: ownerId,
          prompt: '【雷击】：选择进行判定的角色',
          timeoutMs: 20_000,
          optional: false,
          candidateIds: candidates,
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      if (!playerOf(host.state, targetId)?.alive) return
      // 判定的是**目标**，不是张角——所以花色修正按目标算（小乔的红颜在这里生效）
      performJudgment(host, targetId, '雷击', { tag: LEIJI_TAG, data: { ownerId, targetId } })
    }
  },
})

/** 雷击打得到谁：所有存活角色，**包括张角自己**（规则没有排除自己）。 */
function leijiTargets(state: SanguoshaState, _ownerId: PlayerId): PlayerId[] {
  return state.players.filter((player) => player.alive).map((player) => player.id)
}

registerJudgmentContinuation(LEIJI_TAG, (host, judged, data) => {
  if (judged.suit !== 'spade') return
  const ownerId = data.ownerId as PlayerId
  const targetId = data.targetId as PlayerId
  if (!playerOf(host.state, ownerId)?.alive) return
  if (!playerOf(host.state, targetId)?.alive) return
  // 走统一的伤害入口，雷电是真的属性伤害：铁索传导、藤甲加伤都自动生效
  resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 2, nature: 'thunder', cardName: '雷击' })
})

// —— 鬼道 ——
//
// 「在一名角色的判定牌生效前，你可以打出一张黑色手牌代替之。」
//
// 直接复用为司马懿【鬼才】建立的改判入口，**不另写一套判定替换系统**。
// 和鬼才的唯一区别就是「哪些牌能用」：鬼道只认黑色手牌。
// 同时有鬼才和鬼道时的先后、能不能连续改判，全部由判定引擎统一安排
// （按座次逐个问，换牌之后从头再问一遍），这里不做任何假设。

registerSkillRuntime({
  id: GUIDAO,
  retrial(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    // 黑色 = 黑桃或梅花。用印刷花色即可：改判牌是「打出」的，
    // 不经过判定角色的花色修正
    return owner.zones.hand.filter((cardId) => state.cards[cardId]?.color === 'black')
  },
})

// —— 黄天（主公技）——
//
// 「其他群雄角色可以在他们各自的出牌阶段中，交给你一张【闪】或【闪电】，
//   每阶段限一次。」
//
// 动作出现在**别人**的出牌阶段，所以走 `grantsPlayActions`：
// 技能属于张角，但产出的动作属于交牌的那个人。
// 「是不是主公」由技能自己确认——主公技只在坐主公位时生效，这是规则。

const HUANGTIAN_GIVE = 'huangtian-give'
/** 黄天能交的牌。 */
const HUANGTIAN_CARDS = new Set(['闪', '闪电'])

function huangtianGiftIds(state: SanguoshaState, actorId: PlayerId): CardId[] {
  const actor = playerOf(state, actorId)
  if (!actor) return []
  return actor.zones.hand.filter((cardId) => HUANGTIAN_CARDS.has(state.cards[cardId]?.name ?? ''))
}

registerSkillRuntime({
  id: HUANGTIAN,
  grantsPlayActions(state, ownerId, actorId) {
    const lord = playerOf(state, ownerId)
    // 主公技：不在主公位上就没有效果
    if (!lord?.alive || lord.identity !== 'lord') return []
    if (actorId === ownerId) return []
    const actor = playerOf(state, actorId)
    if (!actor?.alive || actor.characterId === null) return []
    // 只有群雄角色能交
    if (!isQun(state, actorId)) return []
    // 每阶段限一次：出牌阶段本身就是一个阶段，用回合内记账即可
    if (actor.turnUsedSkills.includes(HUANGTIAN)) return []
    if (huangtianGiftIds(state, actorId).length === 0) return []
    return [{ id: HUANGTIAN_GIVE, label: `发动【黄天】：交给${lord.nickname}一张【闪】或【闪电】` }]
  },

  invokeGrantedAction(host, ownerId, actorId, actionId) {
    if (actionId !== HUANGTIAN_GIVE) return
    const gifts = huangtianGiftIds(host.state, actorId)
    if (gifts.length === 0) return
    // 先记账再发问：反复取消不能刷次数
    const actor = playerOf(host.state, actorId)
    if (!actor || actor.turnUsedSkills.includes(HUANGTIAN)) return
    actor.turnUsedSkills.push(HUANGTIAN)
    host.askSkill({
      skillId: HUANGTIAN,
      ownerId: actorId,
      step: 'give',
      data: { lordId: ownerId },
      build: (requestId) => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: actorId,
        prompt: '【黄天】：选择交给主公的【闪】或【闪电】',
        timeoutMs: 20_000,
        optional: false,
        purpose: 'skill',
        cardIds: gifts,
        hiddenCardSlots: [],
        min: 1,
        max: 1,
      }),
    })
  },

  resume(host, actorId, resolution, response) {
    if (resolution.step !== 'give') return
    const lordId = resolution.data.lordId as PlayerId
    const cardId = (response.payload as { cardIds: CardId[] }).cardIds[0]
    const actor = playerOf(host.state, actorId)
    const lord = playerOf(host.state, lordId)
    if (!actor || !lord?.alive || !actor.zones.hand.includes(cardId)) return
    giveCard(host, actorId, lordId, cardId)
  },
})

/**
 * 某人是不是群势力。武将没定下来时算不是。
 *
 * 势力查询复用 lords.ts 那份运行时回注的 `kingdomOf`——护驾、激将、救援
 * 都在用同一个，不为黄天再注一份。
 */
function isQun(state: SanguoshaState, playerId: PlayerId): boolean {
  const characterId = playerOf(state, playerId)?.characterId
  return characterId ? kingdomOf(characterId) === 'qun' : false
}

function giveCard(host: SkillHost, fromId: PlayerId, toId: PlayerId, cardId: CardId): void {
  const from = playerOf(host.state, fromId)
  const to = playerOf(host.state, toId)
  if (!from || !to) return
  from.zones.hand.splice(from.zones.hand.indexOf(cardId), 1)
  to.zones.hand.push(cardId)
  host.dispatch('LoseCard', { playerId: fromId, cardIds: [cardId], reason: '黄天' }, { targetId: fromId, cardIds: [cardId] })
  host.dispatch('GainCard', { playerId: toId, cardIds: [cardId], reason: '黄天' }, { targetId: toId, cardIds: [cardId] })
}
