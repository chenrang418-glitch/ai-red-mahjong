import { drawCards } from '../../engine/draw'
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
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: string; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: 'biyue', ownerId, step: 'invoke', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    host.askSkill({
      skillId: 'biyue',
      ownerId,
      step: 'invoke',
      build: (id) => ({
        id,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: '【闭月】：是否摸一张牌？',
        timeoutMs: 20_000,
        optional: true,
        options: [{ id: 'yes', label: '摸一张牌' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, { ...payload, reason: '闭月' }))
  },
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
    description: '锁定技，你使用的【杀】需两张【闪】才能抵消；与你进行【决斗】的角色每次需打出两张【杀】。',
  }],
}, {
  id: 'diaochan',
  name: '貂蝉',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'standard',
  skills: [
    { id: 'lijian', name: '离间', description: '出牌阶段限一次，你可以弃置一张牌并选择两名其他男性角色，然后令其中一名男性角色视为对另一名男性角色使用一张【决斗】。' },
    { id: 'biyue', name: '闭月', description: '结束阶段，你可以摸一张牌。' },
  ],
}] as const
