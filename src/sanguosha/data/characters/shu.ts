import type { ArrangeCardsRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { CardId, PlayerId } from '../../engine/types'
import type { CharacterDefinition } from './types'

// —— 诸葛亮【观星】——
registerSkillRuntime({
  id: 'guanxing',
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'prepare') return
      const count = Math.min(5, host.state.players.filter((player) => player.alive).length, host.state.zones.drawPile.length)
      if (count === 0) return
      host.askSkill({
        skillId: 'guanxing',
        ownerId,
        step: 'arrange',
        data: { cardIds: host.state.zones.drawPile.slice(0, count) },
        build: (requestId): ArrangeCardsRequest => ({
          id: requestId,
          kind: 'arrange-cards',
          playerId: ownerId,
          prompt: `【观星】：查看牌堆顶 ${count} 张牌，并以任意顺序置于牌堆顶或牌堆底`,
          timeoutMs: 30_000,
          optional: false,
          cardIds: host.state.zones.drawPile.slice(0, count),
          minTop: 0,
          maxTop: count,
          allowBottom: true,
        }),
      })
    },
  }],
  resume(host, _ownerId, resolution, response: GameResponse) {
    const original = resolution.data.cardIds as CardId[]
    const { top, bottom } = response.payload as { top: CardId[]; bottom: CardId[] }
    const observed = new Set(original)
    const untouched = host.state.zones.drawPile.filter((cardId) => !observed.has(cardId))
    // 快照里的牌若在这期间离开了牌堆（别的技能拿走了），就不能再写回去，否则会凭空多出一张
    const stillInPile = (cardId: CardId): boolean => host.state.zones.drawPile.includes(cardId)
    host.state.zones.drawPile = [...top.filter(stillInPile), ...untouched, ...bottom.filter(stillInPile)]
  },
})

// —— 诸葛亮【空城】——
registerSkillRuntime({
  id: 'kongcheng',
  prohibitsTarget(state, ownerId, _sourceId, cardName) {
    const owner = state.players.find((player) => player.id === ownerId)
    return owner?.zones.hand.length === 0 && (cardName === '杀' || cardName === '决斗')
  },
})

export const SHU_CHARACTERS: readonly CharacterDefinition[] = [{
  id: 'zhugeliang',
  name: '诸葛亮',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'standard',
  skills: [
    { id: 'guanxing', name: '观星', description: '准备阶段，你观看牌堆顶的X张牌（X为存活角色数且至多为5），然后以任意顺序置于牌堆顶或牌堆底。' },
    { id: 'kongcheng', name: '空城', description: '锁定技，若你没有手牌，你不能成为【杀】或【决斗】的目标。' },
  ],
}] as const
