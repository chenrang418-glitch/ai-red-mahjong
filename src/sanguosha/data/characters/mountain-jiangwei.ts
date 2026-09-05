import { attackRangeCovers, canUseSlashAt, slashUseOptions } from '../../engine/ask-use-slash'
import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { drawCards } from '../../engine/draw'
import { loseMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { setCardAlias } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 山包·姜维。本项目自研表述。。
 *
 * 原文：
 * - **挑衅**：出牌阶段限一次，你可以指定一名攻击范围内含有你的其他角色，
 *   该角色需对你使用一张【杀】，否则你弃置其一张牌。
 * - **志继**：觉醒技，准备阶段，若你没有手牌，你须回复 1 点体力或摸两张牌，
 *   然后减 1 点体力上限，并获得【观星】。
 *
 * **不是界姜维、谋姜维。** 这里没有「志」标记，也没有额外的爆发强化。
 *
 * 最容易做反的一处：**挑衅选的是「攻击范围内含有你的角色」，
 * 不是「你攻击范围内的角色」**。方向反了就成了另一个技能。
 */

export const TIAOXIN = 'tiaoxin'
export const ZHIJI = 'zhiji'
/** 志继觉醒后获得的技能，直接复用标准诸葛亮那一个，不另写一份牌堆控制。 */
const GUANXING = 'guanxing'

const TIAOXIN_ACTION = 'tiaoxin-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 挑衅的候选：**攻击范围里包含姜维**的其他存活角色。
 *
 * 注意不要求候选「现在拿得出杀」——拿不出杀正是挑衅想要的结果之一
 * （他不出杀，姜维就弃他一张牌）。也不要求他有牌可弃：
 * 经典文本的目标条件只有攻击范围这一条，没牌可弃时后半段落空即可。
 */
function tiaoxinCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .filter((candidate) => attackRangeCovers(state, candidate.id, ownerId))
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: TIAOXIN,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisTurn(state, ownerId, TIAOXIN)) return []
    if (tiaoxinCandidates(state, ownerId).length === 0) return []
    return [{ id: TIAOXIN_ACTION, label: '挑衅：令一名攻击范围内含有你的角色对你使用【杀】' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== TIAOXIN_ACTION) return
    const candidateIds = tiaoxinCandidates(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: TIAOXIN, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【挑衅】：选择一名攻击范围内含有你的角色',
        timeoutMs: 20_000,
        // 取消选目标不消耗次数，所以这里是可选的
        optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      // 取消：不消耗「出牌阶段限一次」
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      // 正式确认目标之后才计次
      markUsedThisTurn(host.state, ownerId, TIAOXIN)
      host.dispatch('SkillActivated', { playerId: ownerId, skillId: TIAOXIN, targetId }, { sourceId: ownerId, targetId })

      /*
       * 拿不出【杀】就不弹一个只能拒绝的窗口，直接进入「不出杀」分支。
       * 判断包含转化技（武圣、龙胆、蛊惑），不是只看手上有没有实体杀。
       */
      if (!canUseSlashAt(host.state, targetId, ownerId)) {
        askDiscard(host, ownerId, targetId)
        return
      }

      const options = slashUseOptions(host.state, targetId, ownerId)
      host.askSkill({
        skillId: TIAOXIN, ownerId, step: 'slash', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards',
          // 出不出杀是**目标**的决定，不是姜维的
          playerId: targetId,
          prompt: `【挑衅】：对${playerOf(host.state, ownerId)?.nickname ?? ''}使用一张【杀】，否则被弃置一张牌`,
          timeoutMs: 30_000,
          // 有杀也可以选择不出
          optional: true, purpose: 'skill',
          cardIds: options, hiddenCardSlots: [],
          min: 0, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'slash') {
      const targetId = resolution.data.targetId as PlayerId
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return

      /*
       * 发问期间局势可能变了（目标死了、牌没了、姜维被换了位置），
       * 落地前重新验一次；已经使不出杀就走「不出杀」那条分支。
       */
      const stillLegal = target?.alive
        && cardId
        && slashUseOptions(host.state, targetId, ownerId).includes(cardId)
      if (!stillLegal) {
        askDiscard(host, ownerId, targetId)
        return
      }

      /*
       * 转化技（武圣的红牌、龙胆的闪）拿出来的底牌印的不是【杀】。
       * `beginVirtualSlash` 按**有效牌名**校验载体，所以别名要由调用方先设好——
       * 这是引擎的既有约定，贾诩【乱武】走的也是这一条。
       * 漏了它，被挑衅的关羽/赵云一出杀就会抛「作为载体的牌不是【杀】」，
       * 压测里 5 局直接失败。
       */
      if (host.state.cards[cardId]?.name !== '杀') setCardAlias(host.state, cardId, '杀')

      /*
       * **真正的「使用」**：走公共虚拟杀，完整经过求闪、伤害、享乐、无双、
       * 铁骑、烈弓这一整条管线。目标固定为姜维，玩家拿这个机会杀不了别人。
       */
      host.beginVirtualSlash({ sourceId: targetId, targetId: ownerId, sourceSkillId: TIAOXIN, cardId })
      return
    }

    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const [picked] = (response.payload as { cardIds: string[] }).cardIds ?? []
      if (!picked) return
      const cardId = resolvePickedCard(host.state, targetId, picked)
      if (!cardId) return
      if (movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: TIAOXIN }, { targetId, cardIds: [cardId] })
      }
    }
  },
})

/**
 * 不出杀之后：姜维弃置目标的一张牌。
 *
 * 「其一张牌」包含手牌和装备区，走公共的 `pickableCardsOf`——
 * **手牌只给占位槽**，姜维不能先看清对方手牌再挑。
 * 目标一张牌都没有时安静结束，不弹空窗口。
 */
function askDiscard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  if (!target?.alive || !hasPickableCards(host.state, targetId)) return
  const pickable = pickableCardsOf(host.state, targetId)
  host.askSkill({
    skillId: TIAOXIN, ownerId, step: 'discard', data: { targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【挑衅】：${target.nickname}没有使用【杀】，弃置其一张牌`,
      timeoutMs: 20_000, optional: false, purpose: 'skill',
      cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
      min: 1, max: 1,
    }),
  })
}

const ZHIJI_RECOVER = 'zhiji-recover'
const ZHIJI_DRAW = 'zhiji-draw'

registerSkillRuntime({
  id: ZHIJI,
  awakening: {
    phase: 'prepare',
    // **严格「没有手牌」**，不是「手牌数最少」
    ready: (state, ownerId) => (playerOf(state, ownerId)?.zones.hand.length ?? 0) === 0,
    invoke(host, ownerId) {
      /*
       * 二选一由**姜维本人**决定，不能系统随机。
       * 满血时「回复 1 点」实际没有收益，但规则允许选，所以两个选项都保留——
       * 该由 AI 去判断哪个更好，而不是引擎替玩家把选项删掉。
       */
      host.askSkill({
        skillId: ZHIJI, ownerId, step: 'choose',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【志继】觉醒：回复 1 点体力，或摸两张牌',
          timeoutMs: 20_000, optional: false,
          options: [
            { id: ZHIJI_RECOVER, label: '回复 1 点体力' },
            { id: ZHIJI_DRAW, label: '摸两张牌' },
          ],
        }),
      })
    },
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId: string }).optionId
    if (optionId === ZHIJI_DRAW) {
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
    } else {
      recover(host as never, ownerId, 1)
    }
    // 顺序按原文：先选一项，然后减体力上限，最后获得观星
    loseMaxHp(host as never, ownerId, 1, '志继')
    grantSkill(host.state, ownerId, GUANXING)
    host.dispatch('SkillActivated', { playerId: ownerId, skillId: ZHIJI, granted: GUANXING }, { sourceId: ownerId })
  },
})

export const JIANGWEI: CharacterDefinition = {
  id: 'jiangwei',
  name: '姜维',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'mountain',
  skills: [
    {
      id: TIAOXIN,
      name: '挑衅',
      description: '出牌阶段限一次，你可以指定一名攻击范围内含有你的其他角色，该角色需对你使用一张【杀】，否则你弃置其一张牌。',
    },
    {
      id: ZHIJI,
      name: '志继',
      description: '觉醒技。准备阶段，若你没有手牌，你须回复1点体力或摸两张牌，然后减1点体力上限，并获得【观星】。',
    },
    {
      id: GUANXING,
      name: '观星',
      description: '准备阶段，你观看牌堆顶的X张牌（X为存活角色数且至多为5），然后以任意顺序置于牌堆顶或牌堆底。',
      // 志继觉醒之后才获得，开局没有
      granted: true,
    },
  ],
}
