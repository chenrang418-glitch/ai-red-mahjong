import { finalizeDamage } from '../../engine/damage'
import { flipCharacter } from '../../engine/character-state'
import { reshuffleDrawPile } from '../../engine/deck'
import { movePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import { damagePointsOf, queueDamagePoint, queueNextDamagePoint, remainingDamagePoints } from '../../engine/per-damage-point'
import type { CardId, DamageNature, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹冲（一将成名 2013，采用 2014 调整后的成熟版）。
 *
 * 【称象】：你受到伤害后，你可以亮出牌堆顶四张牌，获得其中任意张点数之和不大于
 *          13 的牌，其余的牌进入弃牌堆。
 * 【仁心】：当体力值为 1 的其他角色将要受到伤害时，你可以翻面并弃置一张装备牌，
 *          防止此伤害。
 *
 * 三处最容易做错的：
 *
 * 1. **称象选牌是「点数之和 ≤ 13」的任意子集**，A 记 1、K 记 13，牌面 rank
 *    字段本来就是这个数值，不需要再换算；服务端必须再验一遍这个约束，
 *    不能只信客户端传回来的组合。
 * 2. **仁心是真正的伤害防止**：目标是「别人」，不是曹冲自己，
 *    所以走 `BeforeDamage` 触发（时机在拥有者遍历，可以是任意人的伤害），
 *    不是 `preventsDamage`（那个只查伤害的来源方和目标方自己的技能）。
 * 3. **仁心可以不发动**：先在 `BeforeDamage` 里 `cancel()` 挂起询问，
 *    曹冲拒绝或付不起代价时，用 `finalizeDamage` 原样把这次伤害续上——
 *    不能重新走一遍 `resolveDamage`，那会把已经算好的属性/数值修正
 *    （藤甲、大雾……）的战报和一次性效果重复触发一遍。
 */

const CHENGXIANG = 'chengxiang'
const RENXIN = 'renxin'
const PEEK = 4
const MAX_SUM = 13
const JIE_CAOCHONG_ID = 'jie-caochong-b64'
const CHENGXIANG_NEXT_PEEK = 'jie-chengxiang-next-peek'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function equipmentCandidatesOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return [
    ...owner.zones.hand.filter((cardId) => state.cards[cardId]?.category === 'equipment'),
    ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
  ]
}

// ─────────────────────────────── 称象 ───────────────────────────────

registerSkillRuntime({
  id: CHENGXIANG,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (owner.characterId === JIE_CAOCHONG_ID) {
        const amount = (context.event.payload as { amount?: number }).amount
        queueDamagePoint(host, { skillId: CHENGXIANG, ownerId, step: 'invoke', remaining: damagePointsOf(amount) })
        return
      }
      host.queueSkill({ skillId: CHENGXIANG, ownerId, step: 'peek', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'invoke') {
      const remaining = remainingDamagePoints(prompt.data)
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.characterId !== JIE_CAOCHONG_ID) return
      host.askSkill({ skillId: CHENGXIANG, ownerId, step: 'invoke', data: { remaining }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【称象】：是否亮出牌堆顶的牌并获得其中点数和不大于13的牌？',
        timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '发动【称象】' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step === 'peek') revealChengxiang(host, ownerId, 0, false)
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      const remainingPoints = remainingDamagePoints(resolution.data)
      if ((response.payload as { optionId?: string }).optionId === 'yes') revealChengxiang(host, ownerId, remainingPoints, true)
      else queueNextDamagePoint(host, { skillId: CHENGXIANG, ownerId, step: 'invoke', remaining: remainingPoints })
      return
    }
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    const top = (resolution.data.top as CardId[]) ?? []
    const jieCaochong = resolution.data.jieCaochong === true
    const inProcessing = top.filter((cardId) => host.state.zones.processingArea.includes(cardId))
    let picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => inProcessing.includes(cardId))
    // 服务端再验一遍点数之和的约束：客户端传回来的组合不可信
    const sum = (ids: CardId[]) => ids.reduce((total, cardId) => total + (host.state.cards[cardId]?.rank ?? 0), 0)
    if (sum(picked) > MAX_SUM) picked = []

    if (picked.length > 0 && owner?.alive) {
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: picked, reason: CHENGXIANG }, { targetId: ownerId, cardIds: picked })
    }
    const remaining = inProcessing.filter((cardId) => !picked.includes(cardId))
    for (const cardId of remaining) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' }, { discardReason: 'other' })
    if (jieCaochong && owner?.alive) {
      if (sum(picked) === MAX_SUM) owner.marks[CHENGXIANG_NEXT_PEEK] = 1
      queueNextDamagePoint(host, { skillId: CHENGXIANG, ownerId, step: 'invoke', remaining: remainingDamagePoints(resolution.data) })
    }
  },
})

function revealChengxiang(host: SkillHost, ownerId: PlayerId, remainingPoints: number, jieCaochong: boolean): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) {
    if (jieCaochong) queueNextDamagePoint(host, { skillId: CHENGXIANG, ownerId, step: 'invoke', remaining: remainingPoints })
    return
  }
  const extra = jieCaochong ? Math.max(0, Math.trunc(owner.marks[CHENGXIANG_NEXT_PEEK] ?? 0)) : 0
  if (extra) owner.marks[CHENGXIANG_NEXT_PEEK] = 0
  const count = PEEK + extra
  if (host.state.zones.drawPile.length < count) reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) })
  const top = host.state.zones.drawPile.slice(0, count)
  if (!top.length) {
    if (jieCaochong) queueNextDamagePoint(host, { skillId: CHENGXIANG, ownerId, step: 'invoke', remaining: remainingPoints })
    return
  }
  for (const cardId of top) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
  host.dispatch('CardMove', { playerId: ownerId, cardIds: top, reason: CHENGXIANG, revealed: true }, { sourceId: ownerId, cardIds: top })
  host.dispatch('SkillActivated', { skillId: CHENGXIANG, skillName: '称象', playerId: ownerId,
    logText: `${owner.nickname}发动【称象】，亮出牌堆顶 ${top.length} 张牌` }, { sourceId: ownerId })
  host.askSkill({ skillId: CHENGXIANG, ownerId, step: 'pick', data: { top, remaining: remainingPoints, jieCaochong }, build: (requestId): ChooseCardsRequest => ({
    id: requestId, kind: 'choose-cards', playerId: ownerId,
    prompt: `【称象】：获得其中任意张点数之和不大于 ${MAX_SUM} 的牌（可以一张都不选）`,
    timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: top, hiddenCardSlots: [], min: 0, max: top.length,
  }) })
}

// ─────────────────────────────── 仁心 ───────────────────────────────

registerSkillRuntime({
  id: RENXIN,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId || targetId === ownerId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.hp !== 1) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.faceDown) return
      if (equipmentCandidatesOf(host.state, ownerId).length === 0) return
      /*
       * **属性伤害传导中不介入**：`resumeDamageChain` 是一个同步 while 循环，
       * 一边遍历剩余目标一边直接调用 `resolveSingleDamage`；这里如果
       * `cancel()` 挂起发问，循环会在等到回答之前就继续处理下一个目标，
       * 状态会乱。传导链只有这一种同步实现，仁心不掺和这种伤害。
       */
      if (host.state.damageChain) return
      /*
       * **群体锦囊（南蛮入侵、万箭齐发）的多目标结算同样不介入**：
       * 那套流程在处理完一个目标之后会立刻同步推进到下一个目标——
       * 这里如果 `cancel()` 挂起发问，代码会在等到回答之前就把下一个目标
       * 的请求也发出去，两个 pending 状态互相打架。仁心只管单体伤害。
       */
      if (host.state.cardResolution?.kind === 'trick') return
      // 已经有别的技能在这次事件里挂起发问了，不重复挤占同一个 skillResolution
      if (host.state.skillResolution) return

      const payload = context.event.payload as { amount?: number; cardId?: CardId; cardName?: string; redirectedBy?: string }
      const amount = typeof payload.amount === 'number' ? payload.amount : 0
      if (amount <= 0) return
      // 先挂起这次伤害：防不防得靠曹冲的回答，回答出来之前不能真的扣血
      context.cancel()
      host.askSkill({
        skillId: RENXIN, ownerId, step: 'ask',
        data: {
          targetId, sourceId: context.event.sourceId ?? null, amount,
          nature: (context.event.damageNature ?? 'normal') as DamageNature,
          cardId: payload.cardId ?? null, cardName: payload.cardName ?? null,
          redirectedBy: payload.redirectedBy ?? null,
        },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【仁心】：翻面并弃置一张装备牌，防止${target.nickname}将要受到的这次伤害？`,
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动【仁心】' }, { id: 'no', label: '不发动' }],
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    const targetId = resolution.data.targetId as PlayerId
    const sourceId = resolution.data.sourceId as PlayerId | null
    const amount = resolution.data.amount as number
    const nature = resolution.data.nature as DamageNature
    const cardId = resolution.data.cardId as CardId | null
    const cardName = resolution.data.cardName as string | null
    const redirectedBy = resolution.data.redirectedBy as string | null

    const reapply = (): void => {
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      finalizeDamage(host as never, target, sourceId, amount, nature, cardId, cardName, redirectedBy, false)
    }

    if (resolution.step !== 'ask') return
    const accepted = (response.payload as { optionId?: string }).optionId === 'yes'
    if (!accepted || !owner?.alive || owner.faceDown) return reapply()

    const candidates = equipmentCandidatesOf(host.state, ownerId)
    if (candidates.length === 0) return reapply()

    if (candidates.length === 1) {
      commitRenxin(host, ownerId, candidates[0], targetId)
      return
    }
    host.askSkill({
      skillId: RENXIN, ownerId, step: 'discard', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【仁心】：弃置一张装备牌',
        timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [],
        min: 1, max: 1,
      }),
    })
  },
})

function commitRenxin(host: SkillHost, ownerId: PlayerId, cardId: CardId, targetId: PlayerId): void {
  const owner = host.state.players.find((candidate) => candidate.id === ownerId)
  const target = host.state.players.find((candidate) => candidate.id === targetId)
  if (!owner?.alive) return
  flipCharacter(host as never, ownerId, RENXIN, true)
  movePickedCard(host as never, ownerId, cardId, { kind: 'discardPile' })
  host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: RENXIN }, { targetId: ownerId, cardIds: [cardId] })
  host.dispatch('SkillActivated', {
    skillId: RENXIN, skillName: '仁心', playerId: ownerId, targetId,
    logText: `${owner.nickname}发动【仁心】，防止了${target?.nickname ?? ''}将要受到的伤害`,
  }, { sourceId: ownerId, targetId })
}

export const CAOCHONG: CharacterDefinition = {
  id: 'caochong',
  name: '曹冲',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2013',
  skills: [
    {
      id: CHENGXIANG,
      name: '称象',
      description: '你受到伤害后，你可以亮出牌堆顶四张牌，获得其中任意张点数之和不大于 13 的牌，其余的牌进入弃牌堆。',
    },
    {
      id: RENXIN,
      name: '仁心',
      description: '当体力值为 1 的其他角色将要受到伤害时，你可以翻面并弃置一张装备牌，防止此伤害。',
    },
  ],
}
