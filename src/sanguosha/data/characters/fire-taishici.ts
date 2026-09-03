import { canPindian, registerPindianContinuation, startPindian } from '../../engine/pindian'
import type { ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { grantTurnSlashBonus, prohibitSlashThisTurn } from '../../engine/slash-rules'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 火包·太史慈。经典火包版本。
 *
 * 【天义】是拼点引擎的第二个消费者，而且是检验这套架构的那一个：它**完全没有
 * 自己的拼点代码**——选牌、隐藏、揭示、比点、弃置一行都不重复，只做三件事：
 * 发起拼点 → 拿到结果 → 设置本回合的临时杀规则。
 *
 * 本回合的效果也不写成 `state.taishiciWonTianyi`，而是走公共的
 * `engine/slash-rules.ts`，回合结束由 `turn.ts` 统一清理。
 */

export const TIANYI = 'tianyi'

const TIANYI_TAG = 'tianyi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 能被天义拼点的角色：存活、有手牌的其他角色。
 *
 * **没有体力限制**——那是荀彧【驱虎】的条件，不能顺手复用过来。
 */
export function tianyiTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((player) => player.alive && player.id !== ownerId && canPindian(state, player.id))
    .map((player) => player.id)
}

registerSkillRuntime({
  id: TIANYI,
  announcesSelf: true,

  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, TIANYI)) return []
    // 自己没手牌就拼不了点，合法性阶段挡掉
    if (!canPindian(state, ownerId)) return []
    if (tianyiTargets(state, ownerId).length === 0) return []
    return [{ id: `skill:${TIANYI}`, label: '发动【天义】：与一名其他角色拼点' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${TIANYI}`) throw new Error('天义动作不匹配')
    const candidateIds = tianyiTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: TIANYI,
      ownerId,
      step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId,
        kind: 'choose-targets',
        playerId: ownerId,
        prompt: '【天义】：选择一名其他角色拼点',
        timeoutMs: 20_000,
        optional: true,
        candidateIds,
        // min 0 = 可以放弃；放弃不消耗次数
        min: 0,
        max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !tianyiTargets(host.state, ownerId).includes(targetId)) return
    markUsedThisTurn(host.state, ownerId, TIANYI)
    startPindian(host, {
      id: `tianyi-${host.state.seq}`,
      initiatorId: ownerId,
      opponentId: targetId,
      reason: TIANYI,
      continuationTag: TIANYI_TAG,
    })
  },
})

registerPindianContinuation(TIANYI_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = result.initiatorId
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return

  if (result.outcome === 'initiator-win') {
    // 本回合：多一次出杀、每张杀多指定一个目标、无距离限制
    grantTurnSlashBonus(host.state, ownerId, { extraUses: 1, extraTargets: 1, ignoreDistance: true })
    skillHost.dispatch('SkillActivated', {
      skillId: TIANYI, skillName: '天义', playerId: ownerId, targetIds: [result.opponentId], result: 'win',
      logText: `${owner.nickname}拼点获胜：本回合可多使用一张【杀】，且【杀】可多指定一个目标并无距离限制`,
    }, { sourceId: ownerId, targetId: result.opponentId })
    return
  }

  // **「没赢」包含平局**：经典规则写的是「若你没赢」，平局同样进失败分支
  prohibitSlashThisTurn(host.state, ownerId)
  skillHost.dispatch('SkillActivated', {
    skillId: TIANYI, skillName: '天义', playerId: ownerId, targetIds: [result.opponentId], result: 'lose',
    logText: `${owner.nickname}拼点没有赢：本回合不能使用【杀】`,
  }, { sourceId: ownerId, targetId: result.opponentId })
})

export const TAISHICI: CharacterDefinition = {
  id: 'taishici',
  name: '太史慈',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'fire',
  skills: [
    {
      id: TIANYI,
      name: '天义',
      description: '出牌阶段限一次，你可以与一名角色拼点：若你赢，你于此回合内可以多使用一张【杀】，且你使用【杀】时可以多指定一个目标且无距离限制；若你没赢，你于此回合内不能使用【杀】。',
    },
  ],
}
