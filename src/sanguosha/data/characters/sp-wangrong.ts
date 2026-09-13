import { moveCard } from '../../engine/zones'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { cardUseTargetsOf } from '../../engine/card-use-targets'
import { DELAYED_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { grantSkill, registerSkillRuntime } from '../../engine/skills/runtime'
import type { SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 王荣（三国杀 OL 经典身份 SP）。
 *
 * 【丰姿】：出牌阶段限一次，王荣使用基本牌或普通锦囊后，可以弃置1张与
 *          这张牌类别相同的手牌，令这张牌的效果额外结算1次（复用费祎
 *          【和衷】的同名虚拟牌 + `executeUseCardAction` 额外结算做法；
 *          锦囊类走 `createVirtualTrick`，杀类走 `beginVirtualSlash`，
 *          引擎没有通用的虚拟基本牌工厂，桃/酒这两张基本牌的额外结算
 *          不在本次实现范围内）。
 * 【吉占】：摸牌阶段可以改为发动：展示牌堆顶1张，此后每次猜下一张比当前
 *          这张大或小，猜对可以继续猜下一张，点数相同视为猜错；猜错立即
 *          停止，获得本次吉占展示过的所有牌（含导致猜错的那张）。
 * 【赋颂】：王荣死亡时，可以选择一名体力上限大于王荣的其他角色，令其选择
 *          永久获得【丰姿】或【吉占】其中一个。
 */

const FENGZI = 'fengzi'
const JIZHAN = 'jizhan'
const FUSONG = 'fusong'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: FENGZI,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; asCardName?: string; cancelled?: boolean }
      if (context.event.sourceId !== ownerId || payload.cancelled || payload.asCardName) return
      const cardName = payload.cardName
      if (!cardName || !payload.cardId) return
      const category = host.state.cards[payload.cardId]?.category
      if (category !== 'basic' && category !== 'trick') return
      if (category === 'trick' && (!INSTANT_TRICKS.has(cardName) || DELAYED_TRICKS.has(cardName))) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.turnUsedSkills.includes(FENGZI)) return
      const sameType = owner.zones.hand.filter((id) => host.state.cards[id]?.category === category)
      if (sameType.length === 0) return
      host.queueSkill({ skillId: FENGZI, ownerId, step: 'ask', data: { cardName, category, sameType, originalCardId: payload.cardId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(FENGZI)) return
    const { sameType, cardName } = prompt.data as { sameType: CardId[]; cardName: string }
    const valid = sameType.filter((id) => owner.zones.hand.includes(id))
    if (valid.length === 0) return
    host.askSkill({
      skillId: FENGZI, ownerId, step: 'discard', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【丰姿】：弃置1张与【${cardName}】类别相同的手牌，令其额外结算1次`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: valid, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const { cardName, category, originalCardId } = resolution.data as { cardName: string; category: string; originalCardId: CardId }
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
    owner.turnUsedSkills.push(FENGZI)
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: FENGZI }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: FENGZI, skillName: '丰姿', playerId: ownerId, logText: `${owner.nickname}发动【丰姿】，额外结算【${cardName}】` }, { sourceId: ownerId })

    if (cardName === '杀') {
      const targets = cardUseTargetsOf(host.state, originalCardId)?.targetIds ?? []
      for (const targetId of targets) host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: FENGZI })
      return
    }
    if (category !== 'trick') return
    const targets = cardUseTargetsOf(host.state, originalCardId)?.targetIds ?? []
    const virtualId = createVirtualTrick(host.state, ownerId, cardName, FENGZI)
    executeUseCardAction(host as never, ownerId, {
      kind: 'use-card', id: `fengzi-extra:${virtualId}`, playerId: ownerId,
      cardIds: [virtualId], targetIds: [...targets], targetMin: targets.length, targetMax: targets.length,
      asCardName: cardName, label: `【丰姿】额外结算【${cardName}】`,
    } as never)
  },
})

registerSkillRuntime({
  id: JIZHAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: JIZHAN, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      host.askSkill({
        skillId: JIZHAN, ownerId, step: 'ask',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【吉占】：是否改为发动？（放弃本次正常摸牌）', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '正常摸牌' }],
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const cardId = host.state.zones.drawPile[0]
      if (!cardId) return
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
      host.dispatch('CardMove', { cardIds: [cardId], reason: JIZHAN, revealed: true }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: JIZHAN, skillName: '吉占', playerId: ownerId, logText: `${owner.nickname}发动【吉占】` }, { sourceId: ownerId })
      askGuess(host, ownerId, [cardId])
      return
    }

    if (resolution.step === 'guess') {
      const { pool } = resolution.data as { pool: CardId[] }
      const guess = (response.payload as { optionId?: string }).optionId
      const nextCardId = host.state.zones.drawPile[0]
      if (!nextCardId) { finishJizhan(host, ownerId, pool); return }
      const lastRank = host.state.cards[pool[pool.length - 1]]?.rank ?? 0
      const nextRank = host.state.cards[nextCardId]?.rank ?? 0
      moveCard(host.state, nextCardId, { kind: 'drawPile' }, { kind: 'processingArea' })
      host.dispatch('CardMove', { cardIds: [nextCardId], reason: JIZHAN, revealed: true }, { sourceId: ownerId, cardIds: [nextCardId] })
      const nextPool = [...pool, nextCardId]
      const correct = guess === 'gt' ? nextRank > lastRank : nextRank < lastRank
      if (!correct) { finishJizhan(host, ownerId, nextPool); return }
      askGuess(host, ownerId, nextPool)
    }
  },
})

function askGuess(host: SkillHost, ownerId: PlayerId, pool: CardId[]): void {
  host.askSkill({
    skillId: JIZHAN, ownerId, step: 'guess', data: { pool },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【吉占】：猜下一张点数比当前大还是小？', timeoutMs: 20_000, optional: false,
      options: [{ id: 'gt', label: '更大' }, { id: 'lt', label: '更小' }],
    }),
  })
}

function finishJizhan(host: SkillHost, ownerId: PlayerId, pool: CardId[]): void {
  for (const cardId of pool) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: pool, reason: JIZHAN, revealed: true }, { targetId: ownerId, cardIds: pool })
}

registerSkillRuntime({
  id: FUSONG,
  triggers: [{
    event: 'Death',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.maxHp > (owner?.maxHp ?? 0)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: FUSONG, ownerId, step: 'pick', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: FUSONG, ownerId, step: 'pick',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【赋颂】：选择一名体力上限更高的角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pick') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.askSkill({
        skillId: FUSONG, ownerId, step: 'choose', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【赋颂】：请选择永久获得的技能', timeoutMs: 20_000, optional: false,
          options: [{ id: FENGZI, label: '丰姿' }, { id: JIZHAN, label: '吉占' }],
        }),
      })
      return
    }
    if (resolution.step === 'choose') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!target?.alive || (optionId !== FENGZI && optionId !== JIZHAN)) return
      grantSkill(host.state, targetId, optionId)
      host.dispatch('SkillActivated', { skillId: FUSONG, skillName: '赋颂', playerId: ownerId, targetId, logText: `${target.nickname}获得【${optionId === FENGZI ? '丰姿' : '吉占'}】` }, { sourceId: ownerId, targetId })
    }
  },
})

export const WANGRONG: CharacterDefinition = {
  id: 'wangrong',
  name: '王荣',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: FENGZI, name: '丰姿', description: '出牌阶段限一次，使用基本牌或普通锦囊后，可以弃置1张同类别手牌，令这张牌的效果额外结算1次。' },
    { id: JIZHAN, name: '吉占', description: '摸牌阶段可以改为发动：展示牌堆顶1张，此后连续猜下一张比当前大或小，猜对可继续，点数相同视为猜错；猜错停止，获得本次展示过的所有牌。' },
    { id: FUSONG, name: '赋颂', description: '王荣死亡时，可以选择一名体力上限大于王荣的其他角色，令其选择永久获得丰姿或吉占之一。' },
  ],
}
