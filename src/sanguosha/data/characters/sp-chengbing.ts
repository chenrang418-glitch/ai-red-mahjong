import { moveCard } from '../../engine/zones'
import { reshuffleDrawPile } from '../../engine/deck'
import { cancelCardTargetForOwner } from '../../engine/target-cancellation'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 程秉（三国杀 OL 经典身份 SP）。
 *
 * 【经造】：出牌阶段每名角色限一次，亮出牌堆顶X张牌（初始X=3），选择一名
 *          其他角色A：A可以弃置1张与亮出牌中同名的牌，然后本回合之后的
 *          经造X+1；否则你随机获得亮出牌中每种不同牌名各1张，且本回合
 *          经造失效。
 * 【恩遇】：锁定技，你成为其他角色使用的基本牌/普通锦囊牌的目标后，若你
 *          本回合已经成为过同名牌的目标，则当前这张牌对你无效。
 */

const JINGZAO = 'jingzao'
const ENYU = 'enyu'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function currentX(state: SanguoshaState, ownerId: PlayerId): number {
  const ledger = state.chengbingLedger
  if (!ledger || ledger.turnNumber !== state.turnNumber) return 3
  void ownerId
  return ledger.x
}

registerSkillRuntime({
  id: JINGZAO,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const ledger = state.chengbingLedger
    if (ledger?.turnNumber === state.turnNumber && ledger.disabled) return []
    const used = ledger?.turnNumber === state.turnNumber ? ledger.usedTargets : []
    const candidateIds = state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !used.includes(candidate.id)).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return []
    return [{ id: JINGZAO, label: '经造：亮出牌堆顶牌，选一名未使用过的角色' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JINGZAO) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const ledger = host.state.chengbingLedger
    if (ledger?.turnNumber === host.state.turnNumber && ledger.disabled) return
    const used = ledger?.turnNumber === host.state.turnNumber ? ledger.usedTargets : []
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !used.includes(candidate.id)).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: JINGZAO, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【经造】：选择一名其他角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      host.state.chengbingLedger ??= { turnNumber: host.state.turnNumber, x: 3, usedTargets: [], disabled: false }
      if (host.state.chengbingLedger.turnNumber !== host.state.turnNumber) host.state.chengbingLedger = { turnNumber: host.state.turnNumber, x: 3, usedTargets: [], disabled: false }
      host.state.chengbingLedger.usedTargets.push(targetId)
      const x = currentX(host.state, ownerId)
      if (host.state.zones.drawPile.length < x) reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) })
      const top = host.state.zones.drawPile.slice(0, x)
      if (top.length === 0) return
      for (const cardId of top) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
      host.dispatch('CardMove', { cardIds: top, reason: JINGZAO, revealed: true }, { sourceId: ownerId })
      host.dispatch('SkillActivated', { skillId: JINGZAO, skillName: '经造', playerId: ownerId, targetId, logText: `${owner.nickname}发动【经造】，亮出${top.length}张牌` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: JINGZAO, ownerId, step: 'target-choice', data: { targetId, top },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【经造】：弃置1张与亮出牌中同名的手牌（不弃则程秉获得这些牌）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'target-choice') {
      const { targetId, top } = resolution.data as { targetId: PlayerId; top: CardId[] }
      const target = playerOf(host.state, targetId)
      const remaining = top.filter((cardId) => host.state.zones.processingArea.includes(cardId))
      const topNames = new Set(remaining.map((cardId) => host.state.cards[cardId]?.name).filter((name): name is string => Boolean(name)))
      const [pickedId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = pickedId && target?.zones.hand.includes(pickedId) && topNames.has(host.state.cards[pickedId]?.name ?? '')
      if (valid && owner?.alive) {
        moveCard(host.state, pickedId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [pickedId], reason: JINGZAO }, { sourceId: ownerId, targetId, cardIds: [pickedId] })
        if (host.state.chengbingLedger?.turnNumber === host.state.turnNumber) host.state.chengbingLedger.x += 1
        for (const cardId of remaining) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
        return
      }
      if (!owner?.alive) { for (const cardId of remaining) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true }); return }
      const byName = new Map<string, CardId[]>()
      for (const cardId of remaining) {
        const name = host.state.cards[cardId]?.name
        if (!name) continue
        byName.set(name, [...(byName.get(name) ?? []), cardId])
      }
      const gained: CardId[] = []
      for (const [, ids] of byName) gained.push(ids[host.rng.nextInt(ids.length)])
      for (const cardId of gained) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      if (gained.length > 0) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: JINGZAO }, { targetId: ownerId, cardIds: gained })
      const leftover = remaining.filter((cardId) => !gained.includes(cardId))
      for (const cardId of leftover) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' }, { discardReason: 'other' })
      if (host.state.chengbingLedger?.turnNumber === host.state.turnNumber) host.state.chengbingLedger.disabled = true
    }
  },
})

const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

registerSkillRuntime({
  id: ENYU,
  interceptTarget(host, ownerId, context) {
    if (context.category !== 'basic' && context.category !== 'trick') return false
    if (context.category === 'trick' && DELAYED_TRICK_NAMES.has(context.cardName)) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    const ledger = host.state.enyuTargeted
    const seen = ledger && ledger.turnNumber === host.state.turnNumber ? ledger.names : []
    if (seen.includes(context.cardName)) {
      cancelCardTargetForOwner(host, ownerId)
      host.dispatch('SkillActivated', { skillId: ENYU, skillName: '恩遇', playerId: ownerId, logText: `${owner.nickname}发动【恩遇】，${context.cardName}对其无效` }, { sourceId: ownerId })
      return false
    }
    if (!host.state.enyuTargeted || host.state.enyuTargeted.turnNumber !== host.state.turnNumber) host.state.enyuTargeted = { turnNumber: host.state.turnNumber, names: [] }
    host.state.enyuTargeted.names.push(context.cardName)
    return false
  },
})

export const CHENGBING: CharacterDefinition = {
  id: 'chengbing',
  name: '程秉',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: JINGZAO, name: '经造', description: '出牌阶段每名角色限一次，亮出牌堆顶X张牌（初始X=3），选择一名其他角色：其可以弃置1张与亮出牌中同名的手牌，然后本回合之后的经造X+1；否则你随机获得亮出牌中每种不同牌名各1张，且本回合经造失效。' },
    { id: ENYU, name: '恩遇', description: '锁定技，你成为其他角色使用的基本牌/普通锦囊牌的目标后，若你本回合已经成为过同名牌的目标，则当前这张牌对你无效。' },
  ],
}
