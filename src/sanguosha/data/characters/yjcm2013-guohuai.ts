import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 郭淮（一将成名 2013）。
 *
 * 【精策】：出牌阶段结束时，若你本回合内使用过的牌数不小于你当前的体力值，
 *          你可以摸两张牌。
 *
 * 两处最容易做错的：
 *
 * 1. **计数的是「使用」**：打出（响应）不算。挂在 `AfterCardUse` 上，
 *    响应类结算走的是别的事件，不会被这里计入。
 * 2. **比较的是当前体力值，不是体力上限**：体力越低越容易发动，
 *    每次检查都要现读 `hp`，不能缓存。
 */

const JINGCE = 'jingce'
const COUNT_TURN_MARK = 'jingce-count-turn'
const COUNT_MARK = 'jingce-count'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 郭淮本回合已经使用过几张牌。回合一换（键里带着回合号）自然归零。 */
function cardUseCountThisTurn(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner || owner.marks[COUNT_TURN_MARK] !== state.turnNumber) return 0
  return owner.marks[COUNT_MARK] ?? 0
}

registerSkillRuntime({
  id: JINGCE,
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (owner.marks[COUNT_TURN_MARK] !== host.state.turnNumber) {
          owner.marks[COUNT_TURN_MARK] = host.state.turnNumber
          owner.marks[COUNT_MARK] = 0
        }
        owner.marks[COUNT_MARK] = (owner.marks[COUNT_MARK] ?? 0) + 1
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.playerId !== ownerId || payload.phase !== 'play') return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        // 比的是当前体力值，实时读——体力越低越容易满足
        if (cardUseCountThisTurn(host.state, ownerId) < owner.hp) return
        host.askSkill({
          skillId: JINGCE, ownerId, step: 'draw',
          build: (requestId): ChooseOptionRequest => ({
            id: requestId, kind: 'choose-option', playerId: ownerId,
            prompt: '【精策】：摸两张牌？',
            timeoutMs: 20_000, optional: true,
            options: [{ id: 'yes', label: '发动【精策】' }, { id: 'no', label: '不发动' }],
          }),
        })
      },
    },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'draw') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.dispatch('SkillActivated', {
      skillId: JINGCE, skillName: '精策', playerId: ownerId,
      logText: `${owner.nickname}发动【精策】，摸两张牌`,
    }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const GUOHUAI: CharacterDefinition = {
  id: 'guohuai',
  name: '郭淮',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2013',
  skills: [
    {
      id: JINGCE,
      name: '精策',
      description: '出牌阶段结束时，若你本回合内使用过的牌数不小于你当前的体力值，你可以摸两张牌。',
    },
  ],
}
