import { drawCards } from '../../engine/draw'
import { getDistance } from '../../engine/distance'
import { BASIC_CARD_INFO, TRICK_CARD_INFO } from '../ruleset-v1/card-info'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { applyForcedIdentity } from '../../engine/forced-identity'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 郭皇后（三国杀 OL 经典身份 SP，普通版——不是2026界郭皇后）。
 *
 * 【矫诏】：出牌阶段限一次，展示一张手牌；殚心升级前，由与郭皇后距离最近
 *          的一名其他角色（并列可选）声明一种牌名（基本，升级一次后含普通
 *          非延时锦囊）；升级两次后由郭皇后自己直接声明。本回合这张具体的
 *          实体牌可以当作声明的牌名使用，但不能以此指定郭皇后自己为目标。
 * 【殚心】：受到伤害后，可以摸1张牌，或将【矫诏】升级（最多两次）。
 */

const JIAOZHAO = 'jiaozhao'
const DANXIN = 'danxin'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function jiaozhaoLevel(state: SanguoshaState, ownerId: PlayerId): 0 | 1 | 2 {
  return state.guohuanghouJiaozhao?.[ownerId]?.level ?? 0
}

function declarableNames(level: 0 | 1 | 2): string[] {
  const names = BASIC_CARD_INFO.map((info) => info.name)
  if (level >= 1) names.push(...TRICK_CARD_INFO.filter((info) => !DELAYED_TRICKS.has(info.name)).map((info) => info.name))
  return names
}

registerSkillRuntime({
  id: JIAOZHAO,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(JIAOZHAO)) return []
    return [{ id: JIAOZHAO, label: '矫诏：展示一张手牌，令其可当声明的牌名使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIAOZHAO) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(JIAOZHAO)) return
    host.askSkill({
      skillId: JIAOZHAO, ownerId, step: 'show', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【矫诏】：展示一张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  prohibitsTarget(state, ownerId, sourceId, cardName, cardId) {
    if (sourceId !== ownerId || !cardId) return false
    const entry = (state.forcedIdentities ?? []).find((candidate) => candidate.scope === 'card' && candidate.cardId === cardId && candidate.skillId === JIAOZHAO)
    return !!entry && entry.asCardName === cardName
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'show') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      owner.turnUsedSkills.push(JIAOZHAO)
      host.dispatch('CardMove', { playerId: ownerId, cardIds: [cardId], reason: JIAOZHAO, revealed: true }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: JIAOZHAO, skillName: '矫诏', playerId: ownerId, logText: `${owner.nickname}发动【矫诏】，展示一张手牌` }, { sourceId: ownerId, cardIds: [cardId] })
      const level = jiaozhaoLevel(host.state, ownerId)
      if (level >= 2) {
        host.askSkill({
          skillId: JIAOZHAO, ownerId, step: 'declare', data: { cardId, declarerId: ownerId },
          build: (requestId): ChooseOptionRequest => ({
            id: requestId, kind: 'choose-option', playerId: ownerId,
            prompt: '【矫诏】：声明一种牌名', timeoutMs: 20_000, optional: false,
            options: declarableNames(level).map((name) => ({ id: name, label: name })),
          }),
        })
        return
      }
      const distances = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => ({ id: candidate.id, distance: getDistance(host.state, ownerId, candidate.id) }))
      if (distances.length === 0) return
      const minDistance = Math.min(...distances.map((entry) => entry.distance))
      const candidateIds = distances.filter((entry) => entry.distance === minDistance).map((entry) => entry.id)
      host.askSkill({
        skillId: JIAOZHAO, ownerId, step: 'pick-nearest', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【矫诏】：选择一名距离最近的角色声明牌名', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-nearest') {
      const { cardId } = resolution.data as { cardId: CardId }
      const [declarerId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!declarerId || !playerOf(host.state, declarerId)?.alive) return
      const level = jiaozhaoLevel(host.state, ownerId)
      host.askSkill({
        skillId: JIAOZHAO, ownerId, step: 'declare', data: { cardId, declarerId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: declarerId,
          prompt: '【矫诏】：请为郭皇后声明一种牌名', timeoutMs: 20_000, optional: false,
          options: declarableNames(level).map((name) => ({ id: name, label: name })),
        }),
      })
      return
    }

    if (resolution.step === 'declare') {
      const { cardId } = resolution.data as { cardId: CardId; declarerId: PlayerId }
      const declared = (response.payload as { optionId?: string }).optionId
      if (!declared || !owner.zones.hand.includes(cardId)) return
      applyForcedIdentity(host.state, {
        ownerId, scope: 'card', cardId, asCardName: declared, nature: 'normal',
        ignoreDistance: false, unlimitedUses: false, skillId: JIAOZHAO, expiry: 'turn-end',
      })
      host.dispatch('SkillActivated', { skillId: JIAOZHAO, skillName: '矫诏', playerId: ownerId, logText: `${owner.nickname}的【矫诏】声明为【${declared}】` }, { sourceId: ownerId })
    }
  },
})

registerSkillRuntime({
  id: DANXIN,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: DANXIN, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const level = jiaozhaoLevel(host.state, ownerId)
    const options = [{ id: 'draw', label: '摸1张牌' }]
    if (level < 2) options.push({ id: 'upgrade', label: '升级【矫诏】' })
    host.askSkill({
      skillId: DANXIN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【殚心】：摸1张牌，或升级【矫诏】', timeoutMs: 20_000, optional: false, options,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'upgrade') {
      const level = jiaozhaoLevel(host.state, ownerId)
      if (level >= 2) return
      host.state.guohuanghouJiaozhao ??= {}
      host.state.guohuanghouJiaozhao[ownerId] = { level: (level + 1) as 0 | 1 | 2 }
      host.dispatch('SkillActivated', { skillId: DANXIN, skillName: '殚心', playerId: ownerId, logText: `${owner.nickname}发动【殚心】，升级【矫诏】` }, { sourceId: ownerId })
      return
    }
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    host.dispatch('SkillActivated', { skillId: DANXIN, skillName: '殚心', playerId: ownerId, logText: `${owner.nickname}发动【殚心】，摸1张牌` }, { sourceId: ownerId })
  },
})

export const GUOHUANGHOU: CharacterDefinition = {
  id: 'guohuanghou',
  name: '郭皇后',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: JIAOZHAO, name: '矫诏', description: '出牌阶段限一次，展示一张手牌；由与你距离最近的一名其他角色（殚心升级后由你自己）声明一种牌名，本回合这张牌可当声明的牌名使用，但不能以此指定你自己为目标。' },
    { id: DANXIN, name: '殚心', description: '受到伤害后，可以摸1张牌，或升级【矫诏】（最多两次：一次扩展声明范围至普通锦囊，两次改为你自己直接声明）。' },
  ],
}
