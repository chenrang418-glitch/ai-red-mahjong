import { getDistance } from '../../engine/distance'
import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { effectiveCardSuit, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, DamageNature, PlayerId, SkillResolutionState, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 神话再临·风包。
 *
 * 只放技能全部实现完的武将。**没实现的宁可不登记**——
 * 能选到却发动不了比根本选不到更糟。
 */

// —— 魏延【狂骨】——
//
// 采用**经典风包版**：锁定技，你对距离 1 以内的角色造成伤害后，
// 回复等同于伤害点数的体力。
// 界限突破版是「可以回复 1 点体力或摸一张牌」，这里不混进来。
//
// 挂在 `AfterDamage` 而不是 `Damaged`：两者都在扣血之后、进入濒死之前，
// 但 AfterDamage 是这一轮伤害时机的最后一站，回血放在这里不会打断
// 别的「受到伤害后」技能的排队顺序。此时目标即使已经掉到 0 点也还没
// 进濒死结算，仍在存活列表里，距离算得出来。

registerSkillRuntime({
  id: 'kuanggu',
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      const event = context.event
      // 狂骨看的是「你造成伤害」，是来源侧的时机，不是自己挨打
      if (event.sourceId !== ownerId) return
      const targetId = event.targetId as PlayerId | undefined
      if (!targetId || targetId === ownerId) return
      const amount = Number((event.payload as { amount?: unknown }).amount ?? 0)
      if (!Number.isInteger(amount) || amount <= 0) return

      const owner = host.state.players.find((player) => player.id === ownerId)
      // 自己也可能在这一下之后死了（决斗输了、反伤），死人不回血
      if (!owner?.alive) return
      if (getDistance(host.state, ownerId, targetId) > 1) return
      // 锁定技，不发问。满血时 recover 自己会返回 0，不需要额外判断——
      // 「触发了但没有实际回复」和规则一致。
      recover(host, ownerId, amount, ownerId)
    },
  }],
})

// —— 黄忠【烈弓】——
//
// 采用**经典风包版**：锁定技，当你使用【杀】指定一个目标后，
// 若该角色的手牌数小于等于你的体力值，或大于等于你的体力上限，
// 则该【杀】不可被【闪】响应。
// 界限突破版换成了「距离条件 + 可选发动」，这里不混进来。
//
// 走 `slashUndodgeable` 这个公共入口，和铁骑落到同一个 noDodge 字段上——
// 不为烈弓单开一条结算分支。

registerSkillRuntime({
  id: 'liegong',
  slashUndodgeable(state, ownerId, targetId) {
    const owner = state.players.find((player) => player.id === ownerId)
    const target = state.players.find((player) => player.id === targetId)
    if (!owner || !target) return false
    // 比的是当前手牌数。此刻【杀】已经离手进了处理区，所以两边数的都是「出牌之后」的手牌
    const handCount = target.zones.hand.length
    return handCount <= owner.hp || handCount >= owner.maxHp
  },
})

// —— 小乔【红颜】【天香】——
//
// 采用经典风包版：黑桃牌视为红桃牌；受到伤害时可弃一张红桃手牌，
// 把整次伤害转移给另一名角色，伤害结算完毕后其摸已损失体力值张牌。

registerSkillRuntime({
  id: 'hongyan',
  cardSuit(_state, _ownerId, _cardId, printedSuit) {
    return printedSuit === 'spade' ? 'heart' : printedSuit
  },
})

interface TianxiangDamageFacts {
  sourceId: PlayerId | null
  amount: number
  nature: DamageNature
  cardId: CardId | null
  cardName: string | null
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((player) => player.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

function tianxiangHeartCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId).zones.hand.filter((cardId) => effectiveCardSuit(state, ownerId, cardId) === 'heart')
}

function damageFactsOf(resolution: Pick<SkillResolutionState, 'data'>): TianxiangDamageFacts {
  return {
    sourceId: (resolution.data.sourceId as PlayerId | null) ?? null,
    amount: Number(resolution.data.amount),
    nature: resolution.data.nature as DamageNature,
    cardId: (resolution.data.cardId as CardId | null) ?? null,
    cardName: (resolution.data.cardName as string | null) ?? null,
  }
}

/** 放弃天香后重放被取消的原伤害；一次性标记避免再次询问天香。 */
function replayOriginalDamage(host: SkillHost, ownerId: PlayerId, facts: TianxiangDamageFacts): void {
  const owner = playerOf(host.state, ownerId)
  owner.marks.tianxiangSkip = (owner.marks.tianxiangSkip ?? 0) + 1
  resolveDamage(host, { ...facts, targetId: ownerId })
  // 若伤害在到达 DamageInflicted 前已被防具减为零，标记不会被触发器消费。
  if (owner.marks.tianxiangSkip) delete owner.marks.tianxiangSkip
}

registerSkillRuntime({
  id: 'tianxiang',
  triggers: [{
    event: 'DamageInflicted',
    priority: 100,
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (owner.marks.tianxiangSkip) {
        owner.marks.tianxiangSkip -= 1
        if (owner.marks.tianxiangSkip <= 0) delete owner.marks.tianxiangSkip
        return
      }
      if (tianxiangHeartCards(host.state, ownerId).length === 0) return
      if (!host.state.players.some((player) => player.alive && player.id !== ownerId)) return

      const amount = Number(context.event.payload.amount)
      if (!Number.isInteger(amount) || amount <= 0) return
      context.cancel()
      // 伤害函数的调用者还要收尾当前【杀】/锦囊。这里只取消原伤害并排队，
      // 等牌结算完全干净后再发问，避免多目标锦囊继续推进时撞上技能 Request。
      host.queueSkill({
        skillId: 'tianxiang', ownerId, step: 'ask', data: {
          sourceId: context.event.sourceId ?? null,
          amount,
          nature: context.event.damageNature ?? 'normal',
          cardId: (context.event.payload.cardId as CardId | null) ?? null,
          cardName: (context.event.payload.cardName as string | null) ?? null,
        },
      })
    },
  }],
  resume(host, ownerId, resolution, response: GameResponse) {
    const facts = damageFactsOf(resolution)
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'tianxiang-invoke') {
        replayOriginalDamage(host, ownerId, facts)
        return
      }
      const cardIds = tianxiangHeartCards(host.state, ownerId)
      if (cardIds.length === 0) {
        replayOriginalDamage(host, ownerId, facts)
        return
      }
      host.askSkill({
        skillId: 'tianxiang', ownerId, step: 'card', data: resolution.data,
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【天香】：弃置一张红桃手牌（【红颜】转换后的黑桃也可）',
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'card') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      const owner = playerOf(host.state, ownerId)
      if (!owner.zones.hand.includes(cardId) || effectiveCardSuit(host.state, ownerId, cardId) !== 'heart') {
        throw new Error('天香弃置的牌不是红桃手牌')
      }
      const candidateIds = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (candidateIds.length === 0) {
        replayOriginalDamage(host, ownerId, facts)
        return
      }
      host.askSkill({
        skillId: 'tianxiang', ownerId, step: 'target', data: { ...resolution.data, cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '选择【天香】转移伤害的角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step !== 'target') return
    const cardId = resolution.data.cardId as CardId
    const owner = playerOf(host.state, ownerId)
    if (!owner.zones.hand.includes(cardId) || effectiveCardSuit(host.state, ownerId, cardId) !== 'heart') {
      throw new Error('天香弃置的牌已不在手牌中')
    }
    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
    const target = playerOf(host.state, targetId)
    if (!target.alive || targetId === ownerId) throw new Error('天香目标非法')
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '天香' }, { sourceId: ownerId, cardIds: [cardId] })

    const hpBefore = target.hp
    resolveDamage(host, { ...facts, targetId })
    if (target.hp < hpBefore) {
      host.queueSkill({ skillId: 'tianxiang', ownerId, step: 'draw', data: { targetId } })
    }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask') {
      const facts = damageFactsOf(prompt)
      if (tianxiangHeartCards(host.state, ownerId).length === 0
        || !host.state.players.some((player) => player.alive && player.id !== ownerId)) {
        replayOriginalDamage(host, ownerId, facts)
        return
      }
      host.askSkill({
        skillId: 'tianxiang', ownerId, step: 'ask', data: prompt.data,
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `受到 ${facts.amount} 点伤害，是否发动【天香】转移此伤害？`,
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'tianxiang-invoke', label: '发动天香' }, { id: 'no', label: '承受伤害' }],
        }),
      })
      return
    }
    if (prompt.step !== 'draw') return
    const targetId = prompt.data.targetId as PlayerId
    const target = host.state.players.find((player) => player.id === targetId)
    if (!target?.alive) return
    const count = Math.max(0, target.maxHp - target.hp)
    if (count > 0) drawCards(host.state, host.rng, targetId, count, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const WIND_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'xiaoqiao',
    name: '小乔',
    kingdom: 'wu',
    gender: 'female',
    maxHp: 3,
    pack: 'wind',
    skills: [
      { id: 'tianxiang', name: '天香', description: '当你受到伤害时，你可以弃置一张红桃手牌并选择一名其他角色，将此伤害转移给该角色；其伤害结算结束后，摸等同于其已损失体力值的牌。' },
      { id: 'hongyan', name: '红颜', description: '锁定技，你的黑桃牌视为红桃牌。' },
    ],
  },
  {
    id: 'weiyan',
    name: '魏延',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'wind',
    skills: [{
      id: 'kuanggu',
      name: '狂骨',
      description: '锁定技，当你对距离一以内的角色造成伤害后，你回复等同于伤害点数的体力。',
    }],
  },
  {
    id: 'huangzhong',
    name: '黄忠',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'wind',
    skills: [{
      id: 'liegong',
      name: '烈弓',
      description: '锁定技，当你使用【杀】指定一个目标后，若该角色的手牌数小于等于你的体力值，或大于等于你的体力上限，则该【杀】不可被【闪】响应。',
    }],
  },
] as const
