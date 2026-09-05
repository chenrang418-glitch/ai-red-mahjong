import { resolveDamage } from '../../engine/damage'
import { canTarget } from '../../engine/distance'
import { drawCards } from '../../engine/draw'
import { registerPindianContinuation, canPindian, startPindian } from '../../engine/pindian'
import type { ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'
import { queueOnDamaged } from './wei-damage'

/**
 * 火包·荀彧。本项目自研表述。
 *
 * 【驱虎】是第一个拼点消费者：它**不实现任何拼点流程**，只负责发起、拿结果、
 * 决定后续。选牌、隐藏、揭示、比点、弃置全在 `engine/pindian.ts` 里。
 *
 * 【节命】走已有的「按伤害点数排队触发」（`wei-damage.ts` 的 queueOnDamaged），
 * 受到 2 点伤害就会问两次，而不是一次伤害事件只问一遍。
 */

export const QUHU = 'quhu'
export const JIEMING = 'jieming'

/** 拼点续接的 tag。 */
const QUHU_TAG = 'quhu'
/** 节命补牌的上限：补至体力上限，且最多 5 张。 */
const JIEMING_CAP = 5

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 驱虎 ───────────────────────────────

/**
 * 能被驱虎的角色：存活、有手牌、**体力值多于荀彧**。
 *
 * 刻意**不**排除「攻击范围内没有别人」的角色——经典规则的发动条件只有这三条。
 * 拼点赢了却没人可打确实会白忙一场，但那是规则本来的样子，多加一条限制
 * 反而改了规则。
 */
export function quhuTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return state.players
    .filter((player) => player.alive && player.id !== ownerId && player.hp > owner.hp && canPindian(state, player.id))
    .map((player) => player.id)
}

/** 被驱虎的角色能打谁：他攻击范围内的角色，但不能是他自己。 */
export function quhuDamageTargets(state: SanguoshaState, opponentId: PlayerId): PlayerId[] {
  return state.players
    .filter((player) => player.alive && player.id !== opponentId && canTarget(state, opponentId, player.id))
    .map((player) => player.id)
}

registerSkillRuntime({
  id: QUHU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, QUHU)) return []
    // 自己没手牌就拼不了点：在合法性阶段就挡掉，不要发动完再弹空选择框
    if (!canPindian(state, ownerId)) return []
    if (quhuTargets(state, ownerId).length === 0) return []
    return [{ id: `skill:${QUHU}`, label: '发动【驱虎】：与一名体力值多于你的角色拼点' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${QUHU}`) throw new Error('驱虎动作不匹配')
    const candidateIds = quhuTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: QUHU,
      ownerId,
      step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId,
        kind: 'choose-targets',
        playerId: ownerId,
        prompt: '【驱虎】：选择一名体力值多于你的角色拼点',
        timeoutMs: 20_000,
        optional: true,
        candidateIds,
        // min 0 = 可以放弃。**放弃不消耗次数**，次数在真正进入拼点时才记
        min: 0,
        max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId) return
      if (!quhuTargets(host.state, ownerId).includes(targetId)) return
      // 真正进入拼点才记次数：选目标阶段取消不算发动过
      markUsedThisTurn(host.state, ownerId, QUHU)
      startPindian(host, {
        id: `quhu-${host.state.seq}`,
        initiatorId: ownerId,
        opponentId: targetId,
        reason: QUHU,
        continuationTag: QUHU_TAG,
      })
      return
    }

    if (resolution.step !== 'damage-target') return
    const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const opponentId = String(resolution.data.opponentId ?? '')
    if (!victimId || !quhuDamageTargets(host.state, opponentId).includes(victimId)) return
    const opponent = playerOf(host.state, opponentId)
    const victim = playerOf(host.state, victimId)
    if (!opponent?.alive || !victim?.alive) return
    host.dispatch('SkillActivated', {
      skillId: QUHU, skillName: '驱虎', playerId: ownerId, targetIds: [opponentId, victimId], result: 'redirect',
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【驱虎】，令${opponent.nickname}对${victim.nickname}造成 1 点伤害`,
    }, { sourceId: ownerId, targetId: victimId })
    // **伤害来源是拼点目标，不是荀彧**
    resolveDamage(host as never, { sourceId: opponentId, targetId: victimId, amount: 1, nature: 'normal' })
  },
})

registerPindianContinuation(QUHU_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = result.initiatorId
  const opponentId = result.opponentId
  const owner = playerOf(host.state, ownerId)
  const opponent = playerOf(host.state, opponentId)
  if (!owner?.alive || !opponent?.alive) return

  /*
   * **没赢就是输**：经典规则写的是「若你没赢」，所以平局走的是失败分支，
   * 不是「什么都不发生」。
   */
  if (result.outcome !== 'initiator-win') {
    skillHost.dispatch('SkillActivated', {
      skillId: QUHU, skillName: '驱虎', playerId: ownerId, targetIds: [opponentId], result: 'backfire',
      logText: `${owner.nickname}拼点没有赢，${opponent.nickname}对他造成 1 点伤害`,
    }, { sourceId: opponentId, targetId: ownerId })
    // 是**伤害**不是失去体力：节命、奸雄、刚烈、狂骨、濒死都该正常走
    resolveDamage(skillHost as never, { sourceId: opponentId, targetId: ownerId, amount: 1, nature: 'normal' })
    return
  }

  const candidateIds = quhuDamageTargets(host.state, opponentId)
  // 赢了但那个人攻击范围内没有别人：按规则就是白忙一场，不倒扣也不补偿
  if (candidateIds.length === 0) {
    skillHost.dispatch('SkillActivated', {
      skillId: QUHU, skillName: '驱虎', playerId: ownerId, targetIds: [opponentId], result: 'no-target',
      logText: `${owner.nickname}拼点获胜，但${opponent.nickname}的攻击范围内没有其他角色`,
    }, { sourceId: ownerId, targetId: opponentId })
    return
  }
  skillHost.askSkill({
    skillId: QUHU,
    ownerId,
    step: 'damage-target',
    data: { opponentId },
    build: (requestId): ChooseTargetsRequest => ({
      id: requestId,
      kind: 'choose-targets',
      playerId: ownerId,
      prompt: `【驱虎】：选择${opponent.nickname}攻击范围内的一名角色，由他造成 1 点伤害`,
      timeoutMs: 20_000,
      optional: false,
      candidateIds,
      min: 1,
      max: 1,
    }),
  })
})

// ─────────────────────────────── 节命 ───────────────────────────────

/** 这个人补到几张：体力上限，且最多 5 张。 */
export function jiemingTargetCount(state: SanguoshaState, playerId: PlayerId): number {
  const player = playerOf(state, playerId)
  if (!player) return 0
  return Math.min(player.maxHp, JIEMING_CAP)
}

/** 谁值得被补：补完之后确实会多牌的存活角色。 */
export function jiemingCandidates(state: SanguoshaState): PlayerId[] {
  return state.players
    .filter((player) => player.alive && player.zones.hand.length < jiemingTargetCount(state, player.id))
    .map((player) => player.id)
}

registerSkillRuntime({
  id: JIEMING,
  announcesSelf: true,

  triggers: [{
    // 「每当你受到 1 点伤害后」——受到 2 点就要问两次，所以按点数排队
    event: 'Damaged',
    handle(host, ownerId, context) { queueOnDamaged(JIEMING, host, ownerId, context, true) },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidateIds = jiemingCandidates(host.state)
    // 全场都已经补满了：发动也只会摸 0 张，不弹这个无意义的窗口
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: JIEMING,
      ownerId,
      step: 'ask',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId,
        kind: 'choose-targets',
        playerId: ownerId,
        prompt: '【节命】：令一名角色将手牌补至其体力上限（至多 5 张）',
        timeoutMs: 20_000,
        optional: true,
        candidateIds,
        min: 0,
        max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step !== 'ask') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId) return
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const count = jiemingTargetCount(host.state, targetId) - target.zones.hand.length
    if (count <= 0) return
    host.dispatch('SkillActivated', {
      skillId: JIEMING, skillName: '节命', playerId: ownerId, targetIds: [targetId], result: 'refill', amount: count,
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【节命】，令${target.nickname}将手牌补至 ${jiemingTargetCount(host.state, targetId)} 张`,
    }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, targetId, count, (name, payload) => {
      host.dispatch(name, { ...payload, reason: JIEMING })
    })
  },
})

export const XUNYU: CharacterDefinition = {
  id: 'xunyu',
  name: '荀彧',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'fire',
  skills: [
    {
      id: QUHU,
      name: '驱虎',
      description: '出牌阶段限一次，你可以与一名体力值多于你的角色拼点：若你赢，你令该角色对其攻击范围内的一名角色（由你选择，不能是其自己）造成1点伤害；若你没赢，该角色对你造成1点伤害。',
    },
    {
      id: JIEMING,
      name: '节命',
      description: '每当你受到1点伤害后，你可以令一名角色将手牌补至X张（X为其体力上限，且至多为5）。',
    },
  ],
}
