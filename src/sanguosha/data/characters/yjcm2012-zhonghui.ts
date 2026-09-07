import { drawCards } from '../../engine/draw'
import { loseMaxHp } from '../../engine/hp'
import { damagePointsOf, queueDamagePoint, queueNextDamagePoint, remainingDamagePoints } from '../../engine/per-damage-point'
import { recover } from '../../engine/recover'
import { grantSkill, registerSkillRuntime } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { moveCard } from '../../engine/zones'
import { resolveDamage } from '../../engine/damage'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 钟会（一将成名 2012 经典）。
 *
 * 【权计】：每当你受到 1 点伤害后，你可以摸一张牌，然后将一张手牌置于你的武将牌上，
 *          称为「权」。你的手牌上限 +X（X 为「权」的数量）。
 * 【自立】：觉醒技，准备阶段，若你的「权」不少于三张，你减 1 点体力上限，
 *          然后选择一项：回复 1 点体力，或摸两张牌。最后你获得【排异】。
 * 【排异】：出牌阶段限一次，你可以将一张「权」置入弃牌堆，然后选择一名角色，
 *          其摸两张牌。若其手牌数大于你的手牌数，你对其造成 1 点伤害。
 *
 * 六处最容易做错的：
 *
 * 1. **权计按「每 1 点伤害」触发**：挨 3 点就有三次独立机会，
 *    不是一次伤害问一次。走公共的逐点结算入口。
 * 2. **顺序是「先摸一张、再放一张进权」**：放进去的可以是刚摸到的那张，
 *    也可以是原来的手牌——那一步是在摸完之后从**当前**手牌里挑。
 * 3. **进权不是弃牌**：不触发任何弃牌时机。
 * 4. **手牌上限实时按权的张数算**，排异消耗一张，上限立刻降 1；
 *    走公共的手牌上限加成，不去改玩家身上的字段。
 * 5. **自立的顺序**：减体力上限 → 二选一 → 获得【排异】。
 * 6. **排异可以选自己**：文本是「一名角色」，没有「其他」；
 *    选自己时摸完两张手牌数当然不大于自己，所以不会自伤。
 */

const QUANJI = 'quanji'
const ZILI = 'zili'
const PAIYI = 'paiyi'
const PAIYI_ACTION = 'paiyi-invoke'

/** 「权」放在武将牌上，是**明置**的堆——不登记进只有主人可见的那份名单。 */
export const QUAN_PILE = 'quan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 这名角色现在有几张「权」。 */
export function quanCountOf(state: SanguoshaState, playerId: PlayerId): number {
  return (playerOf(state, playerId)?.characterPiles?.[QUAN_PILE] ?? []).length
}

// ─────────────────────────────── 权计 ───────────────────────────────

registerSkillRuntime({
  id: QUANJI,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const points = damagePointsOf((context.event.payload as { amount?: unknown }).amount)
      if (points === 0) return
      /*
       * **每 1 点各一次**，而且逐点排队——一口气推三条进队列是不行的：
       * 中间任何一点都可能让后面几点不该再问（人死了、技能没了）。
       */
      queueDamagePoint(host, { skillId: QUANJI, ownerId, step: 'draw', remaining: points })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const remaining = remainingDamagePoints(prompt.data)
    if (remaining <= 0) return
    host.askSkill({
      skillId: QUANJI, ownerId, step: 'draw', data: { remaining },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【权计】：摸一张牌，然后将一张手牌置于武将牌上作为「权」？`
          + (remaining > 1 ? `（还剩 ${remaining} 点）` : ''),
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【权计】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    const remaining = remainingDamagePoints(resolution.data)

    if (resolution.step === 'draw') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner?.alive) {
        queueNextDamagePoint(host, { skillId: QUANJI, ownerId, step: 'draw', remaining })
        return
      }
      // **先摸**，再从摸完之后的手牌里挑一张放进权
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      if (owner.zones.hand.length === 0) {
        queueNextDamagePoint(host, { skillId: QUANJI, ownerId, step: 'draw', remaining })
        return
      }
      host.askSkill({
        skillId: QUANJI, ownerId, step: 'place', data: { remaining },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【权计】：将一张手牌置于武将牌上作为「权」',
          timeoutMs: 20_000,
          // 已经摸过牌了，这一步是必须完成的
          optional: false, purpose: 'skill',
          cardIds: [...owner.zones.hand], hiddenCardSlots: [],
          min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'place') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardId && owner?.alive && owner.zones.hand.includes(cardId)) {
        /*
         * 手牌 → 权堆。**不是弃牌**：不路过弃牌堆，也就不触发任何弃牌时机。
         */
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: QUAN_PILE })
        host.dispatch('SkillActivated', {
          skillId: QUANJI, skillName: '权计', playerId: ownerId,
          logText: `${owner.nickname}发动【权计】，将一张牌置为「权」（共 ${quanCountOf(host.state, ownerId)} 张）`,
        }, { sourceId: ownerId })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: QUANJI }, { targetId: ownerId, cardIds: [cardId] })
      }
      queueNextDamagePoint(host, { skillId: QUANJI, ownerId, step: 'draw', remaining })
    }
  },

  /** 手牌上限 +X，X 是当前「权」的张数。现算，权一变上限立刻跟着变。 */
  maxCardsBonus(state, ownerId) {
    return quanCountOf(state, ownerId)
  },
})

// ─────────────────────────────── 自立 ───────────────────────────────

registerSkillRuntime({
  id: ZILI,
  awakening: {
    phase: 'prepare',
    ready: (state, ownerId) => quanCountOf(state, ownerId) >= 3,
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      /*
       * **顺序：先减体力上限，再二选一，最后获得【排异】。**
       * 减上限走公共入口——直接 `maxHp--` 会漏掉「体力超过新上限时要跟着降」
       * 这一步，也不会发事件。
       */
      loseMaxHp(host as never, ownerId, 1, ZILI)
      host.askSkill({
        skillId: ZILI, ownerId, step: 'choose',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【自立】：选择一项',
          timeoutMs: 20_000, optional: false,
          options: [
            { id: 'recover', label: '回复 1 点体力' },
            { id: 'draw', label: '摸两张牌' },
          ],
        }),
      })
    },
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if ((response.payload as { optionId?: string }).optionId === 'recover') {
      recover(host as never, ownerId, 1, ZILI)
    } else {
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
    }
    // 最后才获得【排异】：顺序是规则的一部分
    grantSkill(host.state, ownerId, PAIYI)
    host.dispatch('SkillActivated', {
      skillId: ZILI, skillName: '自立', playerId: ownerId,
      logText: `${owner.nickname}觉醒【自立】，获得【排异】`,
    }, { sourceId: ownerId })
  },
})

// ─────────────────────────────── 排异 ───────────────────────────────

registerSkillRuntime({
  id: PAIYI,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisPhase(state, ownerId, PAIYI)) return []
    if (quanCountOf(state, ownerId) === 0) return []
    return [{ id: PAIYI_ACTION, label: '排异：弃一张「权」，令一名角色摸两张牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== PAIYI_ACTION) return
    const quan = playerOf(host.state, ownerId)?.characterPiles?.[QUAN_PILE] ?? []
    if (quan.length === 0) return
    host.askSkill({
      skillId: PAIYI, ownerId, step: 'cost',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【排异】：将一张「权」置入弃牌堆',
        timeoutMs: 20_000,
        // 取消不消耗「出牌阶段限一次」
        optional: true, purpose: 'skill',
        cardIds: [...quan], hiddenCardSlots: [],
        min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'cost') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner?.alive) return
      const quan = owner.characterPiles?.[QUAN_PILE] ?? []
      if (!quan.includes(cardId)) return
      markUsedThisPhase(host.state, ownerId, PAIYI)
      /*
       * **代价先付**：权进弃牌堆，手牌上限当场降 1。
       * 上限不影响此刻的手牌数，所以后面的手牌比较不受它影响。
       */
      moveCard(
        host.state, cardId,
        { kind: 'characterPile', playerId: ownerId, pile: QUAN_PILE },
        { kind: 'discardPile' },
        { discardReason: 'discard' },
      )
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: PAIYI }, { targetId: ownerId, cardIds: [cardId] })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: PAIYI, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【排异】：选择一名角色，其摸两张牌',
          timeoutMs: 20_000, optional: false,
          // 自己也在候选里：文本是「一名角色」，没有「其他」
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      host.dispatch('SkillActivated', {
        skillId: PAIYI, skillName: '排异', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【排异】，${target.nickname}摸两张牌`,
      }, { sourceId: ownerId, targetId })
      drawCards(host.state, host.rng, targetId!, 2, (name, payload) => { host.dispatch(name, payload) })
      /*
       * **比较发生在摸完之后**。选自己时手牌数当然不大于自己，
       * 所以不会自伤——这一条不需要特判，比较本身就得出这个结果。
       */
      if (target.zones.hand.length > owner.zones.hand.length) {
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal' })
      }
    }
  },
})

export const ZHONGHUI: CharacterDefinition = {
  id: 'zhonghui',
  name: '钟会',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2012',
  skills: [
    {
      id: QUANJI,
      name: '权计',
      description: '每当你受到 1 点伤害后，你可以摸一张牌，然后将一张手牌置于你的武将牌上，'
        + '称为「权」。你的手牌上限 +X（X 为「权」的数量）。',
    },
    {
      id: ZILI,
      name: '自立',
      description: '觉醒技，准备阶段，若你的「权」不少于三张，你减 1 点体力上限，'
        + '然后选择一项：回复 1 点体力，或摸两张牌。最后你获得【排异】。',
    },
    {
      id: PAIYI,
      name: '排异',
      description: '出牌阶段限一次，你可以将一张「权」置入弃牌堆，然后选择一名角色，'
        + '其摸两张牌。若其手牌数大于你的手牌数，你对其造成 1 点伤害。',
      // 觉醒之后才获得，开局并不拥有
      granted: true,
    },
  ],
}
