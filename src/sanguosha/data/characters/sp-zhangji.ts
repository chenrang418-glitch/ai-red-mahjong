import { moveCard } from '../../engine/zones'
import { resolveDamage } from '../../engine/damage'
import { movePickedCard } from '../../engine/card-pick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张济（三国杀 OL 经典身份 SP）。
 *
 * 【掠命】：出牌阶段限一次，选择一名装备数少于自己的角色A，A声明1~13的
 *          点数，然后张济进行判定：点数相同则对A造成2点伤害；不同则随机
 *          获得A手牌/装备区/判定区里的1张牌。
 * 【屯军】：限定技，选择一名角色，令其随机使用牌堆中X张副类别各不相同的
 *          装备牌（X为本局张济发动【掠命】的次数，装备副类别不足则以
 *          实际存在数量为准）。
 */

const LUEMING = 'lueming'
const LUEMING_INVOKE = 'lueming-invoke'
const LUEMING_TAG = 'lueming-judge'
const LUEMING_TOTAL = 'lueming-total'
const TUNJUN = 'tunjun'
const TUNJUN_INVOKE = 'tunjun-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function equipmentCount(state: SanguoshaState, playerId: PlayerId): number {
  const player = playerOf(state, playerId)
  if (!player) return 0
  return Object.values(player.zones.equipment).filter(Boolean).length
}

registerSkillRuntime({
  id: LUEMING,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(LUEMING)) return []
    const myCount = equipmentCount(state, ownerId)
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && equipmentCount(state, candidate.id) < myCount)) return []
    return [{ id: LUEMING_INVOKE, label: '掠命：选择一名装备数少于你的角色' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== LUEMING_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(LUEMING)) return
    const myCount = equipmentCount(host.state, ownerId)
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && equipmentCount(host.state, candidate.id) < myCount).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(LUEMING)
    host.askSkill({
      skillId: LUEMING, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【掠命】：选择一名装备数少于你的角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.askSkill({
        skillId: LUEMING, ownerId, step: 'declare', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【掠命】：请声明一个1~13的点数', timeoutMs: 20_000, optional: false,
          options: Array.from({ length: 13 }, (_, index) => ({ id: String(index + 1), label: String(index + 1) })),
        }),
      })
      return
    }

    if (resolution.step === 'declare') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const declared = Number((response.payload as { optionId?: string }).optionId)
      if (!declared) return
      owner.marks[LUEMING_TOTAL] = (owner.marks[LUEMING_TOTAL] ?? 0) + 1
      performJudgment(host, ownerId, LUEMING, { tag: LUEMING_TAG, data: { ownerId, targetId, declared } })
    }
  },
})

registerJudgmentContinuation(LUEMING_TAG, (host, judged, data) => {
  const skillHost = host as unknown as SkillHost
  const { ownerId, targetId, declared } = data as { ownerId: PlayerId; targetId: PlayerId; declared: number }
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive) return
  if (declared === judged.rank) {
    resolveDamage(skillHost as never, { sourceId: ownerId, targetId, amount: 2, nature: 'normal', cardName: null })
    return
  }
  const candidates = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => !!id), ...target.zones.judgingArea]
  if (candidates.length === 0) return
  const cardId = candidates[skillHost.rng.nextInt(candidates.length)]
  if (!movePickedCard(skillHost as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) return
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: LUEMING }, { sourceId: ownerId, targetId, cardIds: [cardId] })
})

registerSkillRuntime({
  id: TUNJUN,
  limited: true,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(TUNJUN)) return []
    return [{ id: TUNJUN_INVOKE, label: '屯军：选择一名角色，随机为其使用装备牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== TUNJUN_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(TUNJUN)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: TUNJUN, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【屯军】：选择一名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    owner.usedLimitedSkills.push(TUNJUN)
    const x = owner.marks[LUEMING_TOTAL] ?? 0
    host.dispatch('SkillActivated', { skillId: TUNJUN, skillName: '屯军', playerId: ownerId, targetId, logText: `${owner.nickname}发动限定技【屯军】` }, { sourceId: ownerId, targetId })
    const slots: EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']
    for (let index = slots.length - 1; index > 0; index -= 1) {
      const swap = host.rng.nextInt(index + 1)
      ;[slots[index], slots[swap]] = [slots[swap], slots[index]]
    }
    let remaining = x
    for (const slot of slots) {
      if (remaining <= 0) break
      const candidates = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.equipmentSlot === slot)
      if (candidates.length === 0) continue
      const cardId = candidates[host.rng.nextInt(candidates.length)]
      const cardName = host.state.cards[cardId]?.name ?? ''
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
      executeUseCardAction(host as never, targetId, {
        kind: 'use-card', id: `tunjun:${cardId}`, playerId: targetId,
        cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1,
        asCardName: cardName, label: `屯军：使用【${cardName}】`,
      })
      remaining -= 1
    }
  },
})

export const ZHANGJI: CharacterDefinition = {
  id: 'zhangji',
  name: '张济',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: LUEMING, name: '掠命', description: '出牌阶段限一次，选择一名装备数少于你的角色，其声明一个1~13的点数，然后你进行判定：点数相同则对其造成2点伤害，不同则随机获得其手牌/装备区/判定区里的1张牌。' },
    { id: TUNJUN, name: '屯军', description: '限定技，选择一名角色，令其随机使用牌堆中X张副类别各不相同的装备牌（X为本局你发动【掠命】的次数）。' },
  ],
}
