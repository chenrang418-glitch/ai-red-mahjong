import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { resolveDamage } from '../../engine/damage'
import { useVirtualWine } from '../../engine/virtual-wine'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 何太后（三国杀 OL 经典身份 SP）。
 *
 * 【鸩毒】：每名角色出牌阶段开始时，何太后可以弃置一张手牌，令当前回合角色
 *          视为使用一张【酒】；若当前回合角色不是何太后，何太后对其造成
 *          1 点伤害。
 * 【戚乱】：每个回合结束后，何太后摸 X + 2Y 张牌（X 为本回合死亡角色数，
 *          Y 为本回合由何太后杀死的角色数）。
 *
 * 两处最容易做错的：
 *
 * 1. **鸩毒对自己发动时不造成伤害**，只拿虚拟酒的效果；对别人发动才在
 *    虚拟酒结算完之后补一刀。
 * 2. **戚乱的 X 统计的是「死了几个人」，不是「何太后杀过几次」**：走
 *    `state.turnKills`（按回合实例记账的公共死亡账本）反推总死亡数，
 *    不新开一套统计。
 */

const ZHENDU = 'zhendu'
const QILUAN = 'qiluan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: ZHENDU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || !payload.playerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      host.queueSkill({ skillId: ZHENDU, ownerId, step: 'ask', data: { currentPlayerId: payload.playerId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: ZHENDU, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【鸩毒】：弃置一张手牌，令当前回合角色视为使用一张【酒】？',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const currentPlayerId = resolution.data.currentPlayerId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
    const current = playerOf(host.state, currentPlayerId)
    if (!current?.alive) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ZHENDU }, { targetId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', {
      skillId: ZHENDU, skillName: '鸩毒', playerId: ownerId, targetId: currentPlayerId,
      logText: `${owner.nickname}发动【鸩毒】，${current.nickname}视为使用一张【酒】`,
    }, { sourceId: ownerId, targetId: currentPlayerId })
    useVirtualWine(host, currentPlayerId, ZHENDU)
    if (currentPlayerId !== ownerId) {
      resolveDamage(host as never, { sourceId: ownerId, targetId: currentPlayerId, amount: 1, nature: 'normal', cardName: null })
    }
  },
})

registerSkillRuntime({
  id: QILUAN,
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const turnNumber = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
      const entries = (host.state.turnKills ?? []).filter((entry) => entry.turnNumber === turnNumber)
      const x = new Set(entries.flatMap((entry) => entry.killedPlayerIds)).size
      const y = entries.find((entry) => entry.killerId === ownerId)?.killedPlayerIds.length ?? 0
      const total = x + 2 * y
      if (total <= 0) return
      host.dispatch('SkillActivated', {
        skillId: QILUAN, skillName: '戚乱', playerId: ownerId,
        logText: `${owner.nickname}发动【戚乱】，摸 ${total} 张牌`,
      }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, total, (name, payload) => { host.dispatch(name, payload) })
    },
  }],
})

export const HETAIHOU: CharacterDefinition = {
  id: 'hetaihou',
  name: '何太后',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: ZHENDU,
      name: '鸩毒',
      description: '每名角色出牌阶段开始时，何太后可以弃置一张手牌，令当前回合角色视为使用一张【酒】；若当前回合角色不是何太后，何太后对其造成 1 点伤害。',
    },
    {
      id: QILUAN,
      name: '戚乱',
      description: '每个回合结束后，何太后摸 X + 2Y 张牌（X 为本回合死亡角色数，Y 为本回合由何太后杀死的角色数）。',
    },
  ],
}
