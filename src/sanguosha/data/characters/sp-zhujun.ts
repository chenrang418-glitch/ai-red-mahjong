import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 朱儁（三国杀 OL 经典身份 SP）。
 *
 * 【摧破】：锁定技，朱儁每个 TurnInstance 使用的第X张牌（X=这张牌中文
 *          牌名的字数）触发：若是【杀】或有伤害效果的普通锦囊（决斗/
 *          南蛮入侵/万箭齐发/借刀杀人），这张牌造成的伤害+1（绑定这次
 *          CardUse，不是全局加成）；否则摸1张牌。
 */

const CUIPO = 'cuipo'
const DAMAGE_TRICKS = new Set(['决斗', '南蛮入侵', '万箭齐发', '借刀杀人'])

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: CUIPO,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; asCardName?: string }
      const cardName = payload.asCardName ?? payload.cardName
      if (!cardName) return
      const entry = host.state.zhujunCardUseCount?.[ownerId]
      const sequence = entry?.turnNumber === host.state.turnNumber ? entry.count + 1 : 1
      host.state.zhujunCardUseCount ??= {}
      host.state.zhujunCardUseCount[ownerId] = { turnNumber: host.state.turnNumber, count: sequence }
      if (sequence !== cardName.length) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return

      if (cardName === '杀' || DAMAGE_TRICKS.has(cardName)) {
        if (payload.cardId) host.state.zhujunBoundDamageCardId = { cardId: payload.cardId, turnNumber: host.state.turnNumber }
        host.dispatch('SkillActivated', { skillId: CUIPO, skillName: '摧破', playerId: ownerId, logText: `${owner.nickname}发动【摧破】，这张牌造成的伤害+1` }, { sourceId: ownerId })
      } else {
        host.dispatch('SkillActivated', { skillId: CUIPO, skillName: '摧破', playerId: ownerId, logText: `${owner.nickname}发动【摧破】，摸1张牌` }, { sourceId: ownerId })
        drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      }
    },
  }],

  outgoingDamage(state, _ownerId, context) {
    const bound = state.zhujunBoundDamageCardId
    if (!bound || bound.turnNumber !== state.turnNumber || bound.cardId !== context.cardId) return null
    return { amount: context.amount + 1 }
  },
})

export const ZHUJUN: CharacterDefinition = {
  id: 'zhujun',
  name: '朱儁',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: CUIPO, name: '摧破', description: '锁定技，朱儁每个 TurnInstance 使用的第X张牌（X为这张牌中文牌名的字数）：若是杀或伤害类普通锦囊（决斗/南蛮入侵/万箭齐发/借刀杀人），这张牌造成的伤害+1；否则摸1张牌。' },
  ],
}
