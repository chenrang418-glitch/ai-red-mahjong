import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { replaceTemporarySkill, registerSkillRuntime } from '../../engine/skills/runtime'
import { skillIdsOf } from '../../data/characters/standard'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 丁原（三国杀 OL 经典身份 SP）。
 *
 * 【慈孝】：准备阶段，若场上无"义子"，可以令一名其他角色获得"义子"；若已有
 *          "义子"，可以弃置1张牌，将"义子"移动至另一名其他角色。拥有"义子"
 *          的角色获得技能【叛弑】（mark 绑定的动态技能授予）。
 * 【叛弑】：锁定技（本批新增独立技能定义，随"义子"mark授予/收回）。①准备
 *          阶段，交给拥有【慈孝】的角色1张手牌；②出牌阶段内使用【杀】对
 *          拥有【慈孝】的目标造成伤害时+1，若因此造成了伤害，结束出牌阶段。
 * 【先率】：锁定技，一名角色造成伤害后，若是本轮第一次造成伤害，丁原摸1
 *          张牌；若伤害来源是丁原，丁原对受伤角色再造成1点伤害。
 */

const CIXIAO = 'cixiao'
const XIANLU = 'xianlu'
const BANSHI = 'banshi'
const YIZI_SOURCE = 'dingyuan-yizi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function cixiaoHolder(state: SanguoshaState): PlayerId | null {
  const player = state.players.find((candidate) => candidate.alive && candidate.characterId && skillIdsOf(candidate.characterId).includes(CIXIAO))
  return player?.id ?? null
}

function grantYizi(state: SanguoshaState, playerId: PlayerId): void {
  state.dingyuanYizi = playerId
  replaceTemporarySkill(state, playerId, YIZI_SOURCE, BANSHI)
}

function revokeYizi(state: SanguoshaState, playerId: PlayerId): void {
  replaceTemporarySkill(state, playerId, YIZI_SOURCE, null)
}

registerSkillRuntime({
  id: CIXIAO,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (!host.state.dingyuanYizi) {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: CIXIAO, ownerId, step: 'grant', data: { candidateIds } })
        return
      }
      const currentHolder = host.state.dingyuanYizi
      if (owner.zones.hand.length === 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== currentHolder).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: CIXIAO, ownerId, step: 'move-ask', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'grant') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: CIXIAO, ownerId, step: 'grant', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【慈孝】：选择一名角色获得"义子"', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'move-ask') {
      host.askSkill({
        skillId: CIXIAO, ownerId, step: 'move-ask', data: prompt.data,
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【慈孝】：是否弃置1张牌，移动"义子"？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'grant') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      grantYizi(host.state, targetId)
      host.dispatch('SkillActivated', { skillId: CIXIAO, skillName: '慈孝', playerId: ownerId, logText: `${owner.nickname}发动【慈孝】，令${target.nickname}获得"义子"` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'move-ask') {
      const { candidateIds } = resolution.data as { candidateIds: PlayerId[] }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'yes' || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: CIXIAO, ownerId, step: 'discard', data: { candidateIds },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【慈孝】：弃置1张牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'discard') {
      const { candidateIds } = resolution.data as { candidateIds: PlayerId[] }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: CIXIAO }, { sourceId: ownerId, cardIds: [cardId] })
      host.askSkill({
        skillId: CIXIAO, ownerId, step: 'move-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【慈孝】：选择"义子"的新持有者', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'move-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const oldHolder = host.state.dingyuanYizi
      if (!target?.alive || !oldHolder) return
      revokeYizi(host.state, oldHolder)
      grantYizi(host.state, targetId)
      host.dispatch('SkillActivated', { skillId: CIXIAO, skillName: '慈孝', playerId: ownerId, logText: `${owner.nickname}发动【慈孝】，"义子"移动至${target.nickname}` }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: BANSHI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      const holderId = cixiaoHolder(host.state)
      if (!owner?.alive || !holderId || holderId === ownerId || owner.zones.hand.length === 0) return
      const cardId = owner.zones.hand[host.rng.nextInt(owner.zones.hand.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: holderId })
      host.dispatch('GainCard', { playerId: holderId, cardIds: [cardId], reason: BANSHI }, { sourceId: ownerId, targetId: holderId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: BANSHI, skillName: '叛弑', playerId: ownerId, logText: `${owner.nickname}发动【叛弑】，交出1张手牌` }, { sourceId: ownerId, targetId: holderId })
    },
  }, {
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; amount?: number }
      if (context.event.sourceId !== ownerId || payload.cardName !== '杀') return
      const targetId = context.event.targetId
      const holderId = cixiaoHolder(host.state)
      if (!targetId || targetId !== holderId) return
      payload.amount = (typeof payload.amount === 'number' ? payload.amount : 0) + 1
      host.state.dingyuanBanshiArmed = { ownerId, targetId }
    },
  }, {
    event: 'Damaged',
    handle(host, ownerId, context) {
      const armed = host.state.dingyuanBanshiArmed
      if (!armed || armed.ownerId !== ownerId || context.event.sourceId !== ownerId || context.event.targetId !== armed.targetId) return
      host.state.dingyuanBanshiArmed = undefined
      if (host.state.phase === 'play' && host.state.currentPlayerId === ownerId) host.endPlayPhaseEarly(ownerId)
    },
  }],
})

registerSkillRuntime({
  id: XIANLU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const roundNumber = host.state.roundNumber
      if (host.state.dingyuanFirstDamageSeen === roundNumber) return
      // 先标记"本轮已出现过首次伤害"，再摸牌/追加伤害——追加的那次伤害
      // 绝不能被再次判定成"本轮第一次"。
      host.state.dingyuanFirstDamageSeen = roundNumber
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      host.dispatch('SkillActivated', { skillId: XIANLU, skillName: '先率', playerId: ownerId, logText: `${owner.nickname}发动【先率】，摸1张牌` }, { sourceId: ownerId })
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      if (sourceId !== ownerId || !targetId) return
      // 当前这次 Damaged 可能正处在别的响应链（无懈/求闪）中间，不能在这里
      // 同步再发起一次伤害，推迟到技能队列（当前结算彻底收尾之后）。
      host.queueSkill({ skillId: XIANLU, ownerId, step: 'extra-damage', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'extra-damage') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
  },
})

export const DINGYUAN: CharacterDefinition = {
  id: 'dingyuan',
  name: '丁原',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: CIXIAO, name: '慈孝', description: '准备阶段，若场上无"义子"，可以令一名其他角色获得"义子"；若已有，可以弃置1张牌将"义子"移动至另一名其他角色。拥有"义子"的角色获得技能【叛弑】。' },
    { id: XIANLU, name: '先率', description: '锁定技，一名角色造成伤害后，若是本轮第一次造成伤害，你摸1张牌；若伤害来源是你，你对受伤角色再造成1点伤害。' },
  ],
}
