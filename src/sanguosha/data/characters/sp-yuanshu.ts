import { drawCards } from '../../engine/draw'
import { takeOverDrawPhase } from '../../engine/draw-phase-takeover'
import { livingKingdomCount } from '../../engine/living-kingdoms'
import { maxCardsOf } from '../../engine/phase'
import { characterSkillIdsOf, getSkillRuntime, registerSkillRuntime, replaceTemporarySkills } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 袁术（三国杀 OL 经典身份 SP）。
 *
 * 【庸肆】：锁定技，摸牌阶段额外摸 X 张牌，弃牌阶段开始时弃置 X 张牌
 *          （X 为当前存活势力数）。
 * 【伪帝】：锁定技，视为拥有当前主公的主公技（自己是主公则不重复获得）。
 *
 * 两处最容易做错的：
 *
 * 1. **庸肆的弃牌是「强制弃 X 张」，不是「手牌上限 -X」**：弃牌阶段开始时
 *    先单独弃这 X 张，弃完之后手牌若仍超过正常上限，照常再走一次弃牌阶段
 *    的过量弃置。X 不足手牌数时按现有强制弃牌规则全部弃光。
 * 2. **伪帝不能复制主公技代码**：只把主公真正拥有的主公技 id 通过
 *    `replaceTemporarySkills` 原样发给袁术，并把 `lords.ts` 里判定「坐主公位」
 *    的几处放宽成「坐主公位，或者被伪帝借到了这个技能」（`isEffectiveLord`）。
 *    已知范围限制：只覆盖标准三主公（护驾/激将/救援）——新增的几位带主公技的
 *    角色（曹叡/刘谌/孙休）内部仍然直接判 `identity==='lord'`，不在这次放宽
 *    范围内，借到之后对袁术安全 no-op，不报错、不产生副作用。
 */

const YONGSI = 'yongsi'
const WEIDI = 'weidi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: YONGSI,
  triggers: [
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { count?: number }
        const base = Math.max(0, Math.trunc(Number(payload.count ?? 2)))
        // 锁定技，没有选择余地：直接接管，按「基础摸牌数 + 存活势力数」补牌
        if (!takeOverDrawPhase(host, ownerId, context)) return
        const total = base + livingKingdomCount(host.state)
        if (total > 0) drawCards(host.state, host.rng, ownerId, total, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      },
    },
    {
      event: 'DiscardPhase',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const x = livingKingdomCount(host.state)
        const discardCount = Math.min(x, owner.zones.hand.length)
        if (discardCount <= 0) return
        host.askSkill({
          skillId: YONGSI, ownerId, step: 'discard', data: {},
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: `【庸肆】：弃置 ${discardCount} 张手牌`,
            timeoutMs: 25_000, optional: false, purpose: 'skill',
            cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: discardCount, max: discardCount,
          }),
        })
      },
    },
  ],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => owner?.zones.hand.includes(cardId))
    if (!owner?.alive || cardIds.length === 0) return
    for (const cardId of cardIds) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    }
    host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: YONGSI }, { targetId: ownerId, cardIds })

    /*
     * 庸肆强制弃的这 X 张单独结算，不冒充手牌上限。这里的问答本身占用了
     * 弃牌阶段入口那次「场面还干净」的检查窗口，标准的过量弃置请求因此
     * 被跳过了一次——弃完之后手牌若仍超过正常上限，在这里补发一次。
     */
    const overflow = owner.zones.hand.length - maxCardsOf(host.state, ownerId)
    if (overflow <= 0 || host.state.pendingRequests.length > 0) return
    host.askSkill({
      skillId: `${YONGSI}-overflow`, ownerId, step: 'overflow', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `弃置 ${overflow} 张手牌`,
        timeoutMs: 25_000, optional: false, purpose: 'discard-phase',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: overflow, max: overflow,
      }),
    })
    return
  },
})

registerSkillRuntime({
  id: `${YONGSI}-overflow`,
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'overflow') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => owner?.zones.hand.includes(cardId))
    if (!owner?.alive || cardIds.length === 0) return
    for (const cardId of cardIds) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    }
    host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: 'discard-phase' }, { sourceId: ownerId, cardIds })
  },
})

registerSkillRuntime({
  id: WEIDI,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner || owner.identity === 'lord') return
    const lord = host.state.players.find((candidate) => candidate.identity === 'lord')
    if (!lord?.alive || !lord.characterId) return
    const lordSkillIds = characterSkillIdsOf(lord.characterId).filter((skillId) => getSkillRuntime(skillId)?.lord)
    if (lordSkillIds.length === 0) return
    replaceTemporarySkills(host.state, ownerId, WEIDI, lordSkillIds)
    owner.marks['weidi-active'] = 1
  },
})

export const YUANSHU: CharacterDefinition = {
  id: 'yuanshu',
  name: '袁术',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    {
      id: YONGSI,
      name: '庸肆',
      description: '锁定技，摸牌阶段额外摸 X 张牌，弃牌阶段开始时弃置 X 张牌（X 为存活势力数）。',
      locked: true,
    },
    {
      id: WEIDI,
      name: '伪帝',
      description: '锁定技，视为拥有当前主公的主公技（自己是主公则不重复获得）。',
      locked: true,
    },
  ],
}
