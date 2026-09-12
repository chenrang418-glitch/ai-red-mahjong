import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { reshuffleDrawPile } from '../../engine/deck'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 伊籍（三国杀 OL 经典身份 SP）。
 *
 * 【机捷】：出牌阶段限一次，伊籍观看牌堆底一张牌，然后将这张牌交给任意一名
 *          角色（可以是自己）。
 * 【急援】：一名角色进入濒死状态时，伊籍可以令其摸一张牌；伊籍交给一名其他
 *          角色牌后，可以令其摸一张牌。
 *
 * 最容易做错的：**机捷是「牌堆底 → 目标手牌」直接移动，不先摸再给**——
 * 只有伊籍看得到牌面（这一步不发 `revealed` 的 `CardMove`）；急援的第二种
 * 触发只认伊籍自己交给别人的牌（机捷给自己不算「交给其他角色」）。
 */

const JIJIE = 'jijie'
const JIYUAN = 'jiyuan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: JIJIE,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(JIJIE)) return []
    return [{ id: JIJIE, label: '机捷：观看牌堆底一张牌，交给任意一名角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIJIE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (host.state.zones.drawPile.length === 0) {
      reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) })
    }
    if (host.state.zones.drawPile.length === 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: JIJIE, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【机捷】：将牌堆底这张牌交给一名角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive || host.state.zones.drawPile.length === 0) return
    if (!owner.turnUsedSkills.includes(JIJIE)) owner.turnUsedSkills.push(JIJIE)
    const cardId = host.state.zones.drawPile[host.state.zones.drawPile.length - 1]
    // 只有伊籍看得到这张牌：不发 revealed 的 CardMove，直接搬走
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: JIJIE }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('SkillActivated', {
      skillId: JIJIE, skillName: '机捷', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【机捷】，将牌堆底一张牌交给${target.nickname}`,
    }, { sourceId: ownerId, targetId })
    if (targetId !== ownerId) triggerJiyuanAfterGive(host, ownerId, targetId)
  },
})

function triggerJiyuanAfterGive(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  host.queueSkill({ skillId: `${JIYUAN}-give`, ownerId, step: 'ask', data: { targetId } })
}

registerSkillRuntime({
  id: JIYUAN,
  triggers: [{
    event: 'EnterDying',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (!payload.playerId) return
      host.queueSkill({ skillId: JIYUAN, ownerId, step: 'ask', data: { targetId: payload.playerId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
    host.askSkill({
      skillId: JIYUAN, ownerId, step: 'ask', data: { targetId },
      build: (requestId) => ({
        id: requestId, kind: 'choose-option' as const, playerId: ownerId,
        prompt: '【急援】：令其摸一张牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【急援】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    if (!playerOf(host.state, targetId)?.alive) return
    host.dispatch('SkillActivated', {
      skillId: JIYUAN, skillName: '急援', playerId: ownerId, targetId,
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【急援】`,
    }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: `${JIYUAN}-give`,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
    host.askSkill({
      skillId: `${JIYUAN}-give`, ownerId, step: 'ask', data: { targetId },
      build: (requestId) => ({
        id: requestId, kind: 'choose-option' as const, playerId: ownerId,
        prompt: `【急援】：令${playerOf(host.state, targetId)?.nickname ?? ''}摸一张牌？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【急援】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    if (!playerOf(host.state, targetId)?.alive) return
    host.dispatch('SkillActivated', {
      skillId: JIYUAN, skillName: '急援', playerId: ownerId, targetId,
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【急援】`,
    }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const YIJI: CharacterDefinition = {
  id: 'yiji',
  name: '伊籍',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: JIJIE, name: '机捷', description: '出牌阶段限一次，伊籍观看牌堆底一张牌，然后将这张牌交给任意一名角色（可以是自己）。' },
    { id: JIYUAN, name: '急援', description: '一名角色进入濒死状态时，伊籍可以令其摸一张牌；伊籍交给一名其他角色牌后，可以令其摸一张牌。' },
  ],
}
