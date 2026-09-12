import { canPindian, registerPindianContinuation, startPindian } from '../../engine/pindian'
import { forceDistance } from '../../engine/distance-override'
import { registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 伏皇后（一将成名 2013）。
 *
 * 【惴恐】：其他角色的准备阶段，若伏皇后已受伤，她可以与其拼点。若伏皇后赢，
 *          直到本回合结束，该角色使用的牌不能指定除他自己以外的角色为目标；
 *          若伏皇后没赢，直到本回合结束，该角色与伏皇后的距离视为 1。
 * 【求援】：伏皇后成为【杀】的目标时，可以选择另一名其他角色 C（不能是这张
 *          【杀】的使用者），C 选择：交给伏皇后一张【闪】，或成为这张【杀】
 *          的额外目标。
 *
 * 三处最容易做错的：
 *
 * 1. **惴恐赢的限制是「不能指定别人」，不是全场禁用牌**——用临时授予的
 *    隐藏技能挂 `prohibitsSourceTarget`，回合结束自己清掉，不碰
 *    `prohibitsCardUse`。
 * 2. **惴恐没赢的距离是定向的**（该角色→伏皇后），用新增的 `distance-override`
 *    覆盖距离本身（会连带影响顺手牵羊、兵粮寸断），不是攻击范围豁免。
 * 3. **求援的额外目标是同一次【杀】的结算追加**，不是另开一张虚拟杀——
 *    直接把 C 塞进当前 `cardResolution.remainingTargetIds`。
 */

const ZHUIKONG = 'zhuikong'
const ZHUIKONG_TAG = 'fuhuanghou-zhuikong'
/** 惴恐赢之后临时授予对方的隐藏技能：本回合不能指定别人为目标。 */
const ZHUIKONG_RESTRICT = 'zhuikong-restrict'
const ZHUIKONG_RESTRICT_SOURCE = 'zhuikong'
const QIUYUAN = 'qiuyuan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: ZHUIKONG,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'prepare' || payload.playerId === ownerId || !payload.playerId) return
      // 排队而不是当场问：同一次阶段开始可能撞上别的角色技能已经挂起的发问。
      host.queueSkill({ skillId: ZHUIKONG, ownerId, step: 'ask', data: { targetId: payload.playerId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const targetId = prompt.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || owner.hp >= owner.maxHp) return
    if (!target?.alive || !canPindian(host.state, ownerId) || !canPindian(host.state, targetId)) return
    host.askSkill({
      skillId: ZHUIKONG, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【惴恐】：与${target.nickname}拼点？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【惴恐】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    if (!playerOf(host.state, targetId)?.alive) return
    startPindian(host, {
      id: `zhuikong-${host.state.seq}`,
      initiatorId: ownerId,
      opponentId: targetId,
      reason: ZHUIKONG,
      continuationTag: ZHUIKONG_TAG,
    })
  },
})

registerPindianContinuation(ZHUIKONG_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = result.initiatorId
  const targetId = result.opponentId
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive) return

  if (result.outcome === 'initiator-win') {
    replaceTemporarySkill(host.state, targetId, ZHUIKONG_RESTRICT_SOURCE, ZHUIKONG_RESTRICT)
    skillHost.dispatch('SkillActivated', {
      skillId: ZHUIKONG, skillName: '惴恐', playerId: ownerId, targetId,
      logText: `${owner.nickname}拼点赢了，${target.nickname}本回合使用的牌不能指定除自己以外的角色为目标`,
    }, { sourceId: ownerId, targetId })
    return
  }

  // 平局同样算没赢
  forceDistance(host.state, { fromId: targetId, toId: ownerId, distance: 1, sourceSkillId: ZHUIKONG })
  skillHost.dispatch('SkillActivated', {
    skillId: ZHUIKONG, skillName: '惴恐', playerId: ownerId, targetId,
    logText: `${owner.nickname}没有拼点赢，${target.nickname}本回合与${owner.nickname}的距离视为 1`,
  }, { sourceId: ownerId, targetId })
})

/** 惴恐赢之后临时授予的隐藏限制技，回合结束自己清掉。不进 FUHUANGHOU 的技能表。 */
registerSkillRuntime({
  id: ZHUIKONG_RESTRICT,
  prohibitsSourceTarget(_state, ownerId, targetId) {
    return targetId !== ownerId
  },
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId) {
      replaceTemporarySkill(host.state, ownerId, ZHUIKONG_RESTRICT_SOURCE, null)
    },
  }],
})

// ─────────────────────────────── 求援 ───────────────────────────────

registerSkillRuntime({
  id: QIUYUAN,
  interceptTarget(host, ownerId, context) {
    if (context.targetId !== ownerId || context.cardName !== '杀') return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    const candidateIds = host.state.players
      .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.id !== context.sourceId)
      .map((candidate) => candidate.id)
    if (candidateIds.length === 0) return false
    host.askSkill({
      skillId: QIUYUAN, ownerId, step: 'choose-c',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【求援】：选择另一名其他角色',
        timeoutMs: 20_000, optional: true,
        candidateIds, min: 1, max: 1,
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'choose-c') {
      const [cId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const c = cId ? playerOf(host.state, cId) : undefined
      if (!c?.alive) { host.resumeCardTarget(); return }
      const hasDodge = c.zones.hand.some((cardId) => host.state.cards[cardId]?.name === '闪')
      host.askSkill({
        skillId: QIUYUAN, ownerId, step: 'c-choice', data: { cId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: cId!,
          prompt: `${owner?.nickname ?? ''}发动【求援】：选择一项`,
          timeoutMs: 20_000, optional: false,
          options: [
            ...(hasDodge ? [{ id: 'give', label: '交给伏皇后一张【闪】' }] : []),
            { id: 'target', label: '成为这张【杀】的额外目标' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'c-choice') {
      const cId = resolution.data.cId as PlayerId
      const c = playerOf(host.state, cId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!c?.alive) { host.resumeCardTarget(); return }
      if (optionId === 'give') {
        const dodges = c.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '闪')
        if (dodges.length === 0) { host.resumeCardTarget(); return }
        host.askSkill({
          skillId: QIUYUAN, ownerId, step: 'give-pick', data: { cId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: cId,
            prompt: '【求援】：交给伏皇后一张【闪】',
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: dodges, hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      // 成为额外目标：直接追加进当前这张杀的结算目标队列
      if (owner?.alive && host.state.cardResolution?.kind === 'slash' && !host.state.cardResolution.remainingTargetIds.includes(cId)
        && host.state.cardResolution.targetId !== cId) {
        host.state.cardResolution.remainingTargetIds.push(cId)
        host.dispatch('SkillActivated', {
          skillId: QIUYUAN, skillName: '求援', playerId: ownerId, targetId: cId,
          logText: `${c.nickname}成为这张【杀】的额外目标`,
        }, { sourceId: ownerId, targetId: cId })
      }
      host.resumeCardTarget()
      return
    }

    if (resolution.step === 'give-pick') {
      const cId = resolution.data.cId as PlayerId
      const c = playerOf(host.state, cId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (c?.alive && owner?.alive && cardId && c.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: cId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: QIUYUAN }, { sourceId: cId, targetId: ownerId, cardIds: [cardId] })
        host.dispatch('SkillActivated', {
          skillId: QIUYUAN, skillName: '求援', playerId: ownerId, targetId: cId,
          logText: `${c.nickname}交给${owner.nickname}一张【闪】`,
        }, { sourceId: ownerId, targetId: cId })
      }
      host.resumeCardTarget()
    }
  },
})

export const FUHUANGHOU: CharacterDefinition = {
  id: 'fuhuanghou',
  name: '伏皇后',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'yjcm2013',
  skills: [
    {
      id: ZHUIKONG,
      name: '惴恐',
      description: '其他角色的准备阶段，若伏皇后已受伤，她可以与其拼点。若伏皇后赢，直到本回合结束，该角色使用的牌不能指定除他自己以外的角色为目标；若伏皇后没赢，直到本回合结束，该角色与伏皇后的距离视为 1。',
    },
    {
      id: QIUYUAN,
      name: '求援',
      description: '伏皇后成为【杀】的目标时，可以选择另一名其他角色 C（不能是这张【杀】的使用者），C 选择：交给伏皇后一张【闪】，或成为这张【杀】的额外目标。',
    },
  ],
}
