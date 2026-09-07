import { restoreCharacter } from '../../engine/character-state'
import { nonBasicCardsOf, damageIsFromTrick } from '../../engine/damage-provenance'
import { drawCards } from '../../engine/draw'
import { movePickedCard } from '../../engine/card-pick'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 徐庶（一将成名 2011 · 2015 合并后的经典版）。
 *
 * 【无言】：锁定技，防止你使用的锦囊牌造成的伤害，防止你受到的锦囊牌造成的伤害。
 * 【举荐】：结束阶段，你可以弃置一张非基本牌，令一名其他角色选择：
 *          摸两张牌、回复 1 点体力、或复原其武将牌。
 *
 * 六处最容易做错的：
 *
 * 1. **无言判断的是「这次伤害挂在哪张牌上」**，不是「谁造成的」。
 *    同一个徐庶打出的【杀】照常打进来，他的【决斗】一点伤害都造不成。
 * 2. **技能伤害不被防止**：它不归属于任何一张牌。默认成锦囊的话，
 *    无言会把一切技能伤害都吃掉，那是完全不同的一个技能。
 * 3. **防止 ≠ 改成 0 点**：这次伤害没有发生，连环不传导、
 *    「受到伤害后」那批时机一个都不跑。
 * 4. **举荐的代价是非基本牌**，手牌和装备区都算；弃装备走统一的装备离场，
 *    白银狮子的回血、枭姬、旋风照常。
 * 5. **三选一由目标本人决定**，不是徐庶替他选。
 * 6. **「复原武将牌」是翻回正面 + 解除横置两件事**，少做一件就是另一个效果。
 */

const WUYAN = 'wuyan'
const JUJIAN = 'jujian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 无言 ───────────────────────────────

registerSkillRuntime({
  id: WUYAN,
  preventsDamage(state, _ownerId, _side, context) {
    /*
     * 两侧同一条判断：**这次伤害是不是某张锦囊牌造成的**。
     *
     * `side` 不参与判断——无言两个方向的文本是一样的，
     * 分开写只会给以后留一个「改了一边忘了另一边」的坑。
     * 管线在来源侧和目标侧各问一次，问的都是这个人自己。
     */
    return damageIsFromTrick(state, { cardId: context.cardId, cardName: context.cardName })
  },
})

// ─────────────────────────────── 举荐 ───────────────────────────────

const JUJIAN_OPTIONS = [
  { id: 'draw', label: '摸两张牌' },
  { id: 'recover', label: '回复 1 点体力' },
  { id: 'restore', label: '复原武将牌（翻至正面并解除横置）' },
] as const

registerSkillRuntime({
  id: JUJIAN,
  announcesSelf: true,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      // 拿不出非基本牌，或者场上没有别人，就不弹一个只能拒绝的窗口
      if (nonBasicCardsOf(host.state, ownerId).length === 0) return
      if (jujianTargets(host.state, ownerId).length === 0) return
      host.askSkill({
        skillId: JUJIAN, ownerId, step: 'cost',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【举荐】：弃置一张非基本牌，令一名其他角色摸牌、回血或复原武将牌',
          timeoutMs: 25_000, optional: true, purpose: 'skill',
          // 手牌和装备区里的非基本牌都能当代价；判定区不能
          cardIds: nonBasicCardsOf(host.state, ownerId), hiddenCardSlots: [],
          min: 0, max: 1,
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'cost') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner?.alive) return
      // 落地前重新验一次：发问期间牌可能已经被别的效果拿走了
      if (!nonBasicCardsOf(host.state, ownerId).includes(cardId)) return
      const targetIds = jujianTargets(host.state, ownerId)
      if (targetIds.length === 0) return
      /*
       * 代价走统一的「挑中的牌搬到某处」：从装备区弃的话，
       * 白银狮子的回血、枭姬、旋风都在那条路上。
       */
      if (!movePickedCard(host as never, ownerId, cardId, { kind: 'discardPile' })) return
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JUJIAN }, { targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', {
        skillId: JUJIAN, skillName: '举荐', playerId: ownerId,
        logText: `${owner.nickname}发动【举荐】`,
      }, { sourceId: ownerId })
      host.askSkill({
        skillId: JUJIAN, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【举荐】：选择一名其他角色',
          timeoutMs: 20_000, optional: false,
          candidateIds: targetIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.askSkill({
        skillId: JUJIAN, ownerId, step: 'choice', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option',
          // **由目标本人选**，不是徐庶替他选
          playerId: targetId!,
          prompt: `【举荐】：${owner?.nickname ?? ''}令你选择一项`,
          timeoutMs: 25_000, optional: false,
          options: JUJIAN_OPTIONS.map((option) => ({ ...option })),
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'draw') {
        drawCards(host.state, host.rng, targetId, 2, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      if (optionId === 'recover') {
        /*
         * 满体力时也允许选：规则没有禁止，只是没有实际恢复。
         * 公共的 `recover` 自己会处理上限，这里不替玩家把选项藏起来。
         */
        recover(host as never, targetId, 1, JUJIAN)
        return
      }
      if (optionId === 'restore') {
        // 翻回正面 + 解除横置。连环锁（神刘备【结营】）由公共入口自己挡住
        restoreCharacter(host as never, targetId, JUJIAN)
      }
    }
  },
})

/** 举荐的目标：其他存活角色。**不能选自己**。 */
function jujianTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .map((candidate) => candidate.id)
}

export const XUSHU: CharacterDefinition = {
  id: 'xushu',
  name: '徐庶',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2011',
  skills: [
    {
      id: WUYAN,
      name: '无言',
      description: '锁定技，防止你使用的锦囊牌造成的伤害，防止你受到的锦囊牌造成的伤害。',
    },
    {
      id: JUJIAN,
      name: '举荐',
      description: '结束阶段，你可以弃置一张非基本牌，令一名其他角色选择：'
        + '摸两张牌、回复 1 点体力、或复原其武将牌。',
    },
  ],
}
