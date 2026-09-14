import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 潘淑（三国杀 OL 经典身份 SP）。
 *
 * 【威仪】：每名角色本局限一次，其受到伤害后，比较其体力值与潘淑体力值：
 *          A.hp>=潘淑.hp时可以令其失去1点体力；A.hp<=潘淑.hp时可以令其
 *          回复1点体力；相等时二选一。
 * 【锦织】：你的出牌阶段限一次，X为本轮此前已发动过的锦织次数，弃置X张
 *          颜色相同的牌（X=0则无需弃牌），然后摸1张并视为使用一张杀。
 *
 * 已知简化：锦织固定视为使用【杀】，且仅在潘淑自己的出牌阶段发动（不
 * 覆盖全部Use/Respond窗口），为最小可用范围。
 */

const WEIYI = 'weiyi'
const JINZHI = 'jinzhi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: WEIYI,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId || targetId === ownerId) return
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      if (!target?.alive || !owner?.alive) return
      if ((host.state.weiyiUsed ?? []).includes(targetId)) return
      host.queueSkill({ skillId: WEIYI, ownerId, step: 'ask', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || (host.state.weiyiUsed ?? []).includes(targetId)) return
    const options: Array<{ id: string; label: string }> = []
    if (target.hp >= owner.hp) options.push({ id: 'lose', label: '令其失去1点体力' })
    if (target.hp <= owner.hp) options.push({ id: 'recover', label: '令其回复1点体力' })
    options.push({ id: 'no', label: '不发动' })
    host.askSkill({
      skillId: WEIYI, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【威仪】：是否发动？', timeoutMs: 20_000, optional: true, options,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || (host.state.weiyiUsed ?? []).includes(targetId)) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId !== 'lose' && optionId !== 'recover') return
    host.state.weiyiUsed = [...(host.state.weiyiUsed ?? []), targetId]
    host.dispatch('SkillActivated', { skillId: WEIYI, skillName: '威仪', playerId: ownerId, targetId, logText: `${owner.nickname}发动【威仪】` }, { sourceId: ownerId, targetId })
    if (optionId === 'lose') loseHp(host as never, targetId, 1, WEIYI)
    else recover(host as never, targetId, 1, ownerId)
  },
})

registerSkillRuntime({
  id: JINZHI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.marks['jinzhi-turn'] === host.state.turnNumber) return
      owner.marks['jinzhi-turn'] = host.state.turnNumber
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: JINZHI, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: JINZHI, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【锦织】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const round = host.state.roundNumber
      const state = host.state.jinzhiRound?.round === round ? host.state.jinzhiRound : { round, count: 0 }
      const x = state.count
      if (x === 0) {
        host.state.jinzhiRound = { round, count: x + 1 }
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: JINZHI, skillName: '锦织', playerId: ownerId, logText: `${owner.nickname}发动【锦织】` }, { sourceId: ownerId })
        offerSlash(host, ownerId)
        return
      }
      const byColor = new Map<string, CardId[]>()
      for (const cardId of owner.zones.hand) {
        const color = host.state.cards[cardId]?.color
        if (!color) continue
        byColor.set(color, [...(byColor.get(color) ?? []), cardId])
      }
      const candidates = [...byColor.values()].find((list) => list.length >= x)
      if (!candidates) return
      host.askSkill({
        skillId: JINZHI, ownerId, step: 'discard', data: { x },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【锦织】：弃置${x}张颜色相同的牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: x, max: x,
        }),
      })
      return
    }
    if (resolution.step === 'discard') {
      const { x } = resolution.data as { x: number }
      const picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => owner.zones.hand.includes(id))
      if (picked.length !== x) return
      const colors = new Set(picked.map((id) => host.state.cards[id]?.color))
      if (colors.size !== 1) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: JINZHI }, { sourceId: ownerId, cardIds: picked })
      const round = host.state.roundNumber
      const state = host.state.jinzhiRound?.round === round ? host.state.jinzhiRound : { round, count: 0 }
      host.state.jinzhiRound = { round, count: state.count + 1 }
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: JINZHI, skillName: '锦织', playerId: ownerId, logText: `${owner.nickname}发动【锦织】` }, { sourceId: ownerId })
      offerSlash(host, ownerId)
      return
    }
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: JINZHI })
    }
  },
})

function offerSlash(host: SkillHost, ownerId: PlayerId): void {
  const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
  if (candidateIds.length === 0) return
  host.askSkill({
    skillId: JINZHI, ownerId, step: 'pick-target', data: {},
    build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId,
      prompt: '【锦织】：视为使用一张杀', timeoutMs: 20_000, optional: true,
      candidateIds, min: 0, max: 1,
    }),
  })
}

export const PANSHU: CharacterDefinition = {
  id: 'panshu',
  name: '潘淑',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: WEIYI, name: '威仪', description: '每名角色本局限一次，其受到伤害后，比较其体力值与你的体力值：不低于你时可令其失去1点体力，不高于你时可令其回复1点体力，相等时二选一。' },
    { id: JINZHI, name: '锦织', description: '你的出牌阶段限一次，X为本轮此前已发动过的锦织次数，弃置X张颜色相同的牌（X为0则无需弃牌），然后摸1张并视为使用一张杀。' },
  ],
}
