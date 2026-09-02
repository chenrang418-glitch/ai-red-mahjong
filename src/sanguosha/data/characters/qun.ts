import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { CharacterDefinition } from './types'

registerSkillRuntime({
  id: 'wushuang',
  slashDodgeResponses: 2,
  duelSlashResponses: 2,
})

// —— 貂蝉【闭月】——
// 【离间】的运行时在 engine/equipment-requests.ts：它要凭空发起一次决斗，
// 需要引擎内部的锦囊结算入口，放在这里会形成 import 环。
registerSkillRuntime({
  id: 'biyue',
  triggers: [{
    // 离间的「限一次」由 turn.ts 统一在回合结束清，这里不再各清各的
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: string; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (!owner?.alive) return
      const drawn = host.state.zones.drawPile.shift()
      if (!drawn) return
      owner.zones.hand.push(drawn)
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [drawn], reason: '闭月' }, { targetId: ownerId, cardIds: [drawn] })
    },
  }],
})

export const QUN_CHARACTERS: readonly CharacterDefinition[] = [{
  id: 'lvbu',
  name: '吕布',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'standard',
  skills: [{
    id: 'wushuang',
    name: '无双',
    description: '锁定技，你使用【杀】指定目标后，目标需连续使用两张【闪】；与你进行【决斗】的角色每轮需连续打出两张【杀】。',
  }],
}, {
  id: 'diaochan',
  name: '貂蝉',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'standard',
  skills: [
    { id: 'lijian', name: '离间', description: '出牌阶段限一次，你可以弃置一张牌，令两名男性角色进行【决斗】。' },
    { id: 'biyue', name: '闭月', description: '结束阶段，你可以摸一张牌。' },
  ],
}] as const
