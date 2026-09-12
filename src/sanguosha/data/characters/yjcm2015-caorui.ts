import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { giveCards } from '../../engine/hand-transfer'
import { effectiveKingdomOf } from '../../engine/huashen'
import { recover } from '../../engine/recover'
import { registerJudgmentContinuation, performJudgment } from '../../engine/judgment'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹叡（一将成名 2015）。
 *
 * 【恢拓】：曹叡受到一次伤害后，可以选择一名角色进行判定：红色，其回复
 *          1 点体力；黑色，其摸 X 张牌（X 为此次伤害点数）。
 * 【明鉴】：出牌阶段限一次，曹叡将所有手牌交给一名其他角色，目标下一个
 *          实际回合的手牌上限 +1、出牌阶段【杀】使用次数上限 +1（可叠加）。
 * 【兴衰】：主公技，限定技，曹叡进入濒死时可以发动，其他存活魏势力角色
 *          依次选择是否响应；每有一名响应者，曹叡回复 1 点体力（不超过体力
 *          上限）；濒死结算结束后，响应过的角色依次受到 1 点无来源伤害。
 *
 * 三处最容易做错的：
 *
 * 1. **恢拓的伤害点数取自触发时的那一次伤害**，走 `AfterDamage` 记录的
 *    payload；曹叡若因这次伤害进入濒死，判定推迟到濒死结算完、曹叡仍存活
 *    才问。
 * 2. **明鉴的加成只在目标下一次真正轮到的回合生效**，用临时授予的隐藏
 *    技能实现——授予后目标下一次 `TurnStart` 自动「武装」为当回合有效，
 *    那个回合结束后自动收回，不会被跳过的回合提前消耗。
 * 3. **兴衰是主公技+限定技**：`lord: true` 交给引擎判断是否真的坐主公，
 *    `dyingIntercept` 接管整个濒死流程，不再走正常求桃。
 */

const HUITUO = 'huituo'
const HUITUO_TAG = 'huituo'
const MINGJIAN = 'mingjian'
const MINGJIAN_BUFF = 'mingjian-buff'
const MINGJIAN_BUFF_SOURCE = 'mingjian'
const XINGSHUAI = 'xingshuai'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 恢拓 ───────────────────────────────

registerSkillRuntime({
  id: HUITUO,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { amount?: number }
      const amount = typeof payload.amount === 'number' ? payload.amount : 1
      host.queueSkill({ skillId: HUITUO, ownerId, step: 'ask', data: { amount } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: HUITUO, ownerId, step: 'target', data: prompt.data,
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【恢拓】：选择一名角色进行判定',
        timeoutMs: 20_000, optional: true,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const amount = resolution.data.amount as number
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    host.dispatch('SkillActivated', {
      skillId: HUITUO, skillName: '恢拓', playerId: ownerId, targetId,
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【恢拓】`,
    }, { sourceId: ownerId, targetId })
    performJudgment(host as never, targetId, '恢拓', { tag: HUITUO_TAG, data: { targetId, amount } })
  },
})

registerJudgmentContinuation(HUITUO_TAG, (host, judged, data) => {
  const targetId = data.targetId as PlayerId
  const amount = data.amount as number
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  if (judged.color === 'red') {
    recover(host as never, targetId, 1, HUITUO)
  } else {
    drawCards(host.state, host.rng, targetId, amount, (name, payload) => { host.dispatch(name, payload) })
  }
})

// ─────────────────────────────── 明鉴 ───────────────────────────────

registerSkillRuntime({
  id: MINGJIAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisPhase(state, ownerId, MINGJIAN)) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: MINGJIAN, label: '明鉴：将所有手牌交给一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== MINGJIAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: MINGJIAN, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【明鉴】：选择一名其他角色',
        timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    markUsedThisPhase(host.state, ownerId, MINGJIAN)
    const given = giveCards(host as never, ownerId, targetId!, [...owner.zones.hand], MINGJIAN)
    target.marks['mingjian-armed'] = (target.marks['mingjian-armed'] ?? 0) + 1
    replaceTemporarySkill(host.state, targetId!, MINGJIAN_BUFF_SOURCE, MINGJIAN_BUFF)
    host.dispatch('SkillActivated', {
      skillId: MINGJIAN, skillName: '明鉴', playerId: ownerId, targetId, cardIds: given,
      logText: `${owner.nickname}发动【明鉴】，${target.nickname}下次回合手牌上限和【杀】使用次数上限各 +1`,
    }, { sourceId: ownerId, targetId, cardIds: given })
  },
})

/** 明鉴授予的隐藏技能：下一次真正轮到自己的回合生效一次，然后自动收回。 */
registerSkillRuntime({
  id: MINGJIAN_BUFF,
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const armed = owner.marks['mingjian-armed'] ?? 0
        if (armed <= 0) return
        delete owner.marks['mingjian-armed']
        owner.marks['mingjian-active-turn'] = host.state.turnNumber
        owner.marks['mingjian-active-count'] = armed
        grantTurnSlashBonus(host.state, ownerId, { extraUses: armed })
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner?.marks['mingjian-active-turn'] === host.state.turnNumber) {
          delete owner.marks['mingjian-active-turn']
          delete owner.marks['mingjian-active-count']
          replaceTemporarySkill(host.state, ownerId, MINGJIAN_BUFF_SOURCE, null)
        }
      },
    },
  ],
  maxCardsBonus(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.marks['mingjian-active-turn'] === state.turnNumber ? (owner.marks['mingjian-active-count'] ?? 0) : 0
  },
})

// ─────────────────────────────── 兴衰 ───────────────────────────────

registerSkillRuntime({
  id: XINGSHUAI,
  lord: true,
  limited: true,

  dyingIntercept(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.identity !== 'lord' || owner.usedLimitedSkills.includes(XINGSHUAI)) return false
    const candidateIds = host.state.players
      .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.characterId
        && effectiveKingdomOf(host.state, candidate.id) === 'wei')
      .map((candidate) => candidate.id)
    if (candidateIds.length === 0) return false
    owner.usedLimitedSkills.push(XINGSHUAI)
    host.dispatch('SkillActivated', {
      skillId: XINGSHUAI, skillName: '兴衰', playerId: ownerId,
      logText: `${owner.nickname}发动【兴衰】`,
    }, { sourceId: ownerId })
    host.askSkill({
      skillId: XINGSHUAI, ownerId, step: 'ask', data: { candidateIds, index: 0, responders: [] },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: candidateIds[0],
        prompt: `${owner.nickname}发动【兴衰】：是否响应，令其回复 1 点体力？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '响应' }, { id: 'no', label: '不响应' }],
      }),
    })
    return 'pending'
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const candidateIds = resolution.data.candidateIds as PlayerId[]
    const index = resolution.data.index as number
    const responders = [...(resolution.data.responders as PlayerId[])]
    if ((response.payload as { optionId?: string }).optionId === 'yes') responders.push(candidateIds[index])

    const nextIndex = index + 1
    if (nextIndex < candidateIds.length) {
      host.askSkill({
        skillId: XINGSHUAI, ownerId, step: 'ask', data: { candidateIds, index: nextIndex, responders },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: candidateIds[nextIndex],
          prompt: '发动【兴衰】：是否响应，令主公回复 1 点体力？',
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '响应' }, { id: 'no', label: '不响应' }],
        }),
      })
      return
    }

    // 全部问完：按响应人数恢复体力，正常结束这次濒死，再让响应者各受 1 点无来源伤害
    const owner = playerOf(host.state, ownerId)
    if (owner?.alive && responders.length > 0) {
      owner.hp = Math.min(owner.maxHp, owner.hp + responders.length)
      host.dispatch('Recover', { playerId: ownerId, amount: responders.length, reason: XINGSHUAI }, { targetId: ownerId })
    }
    host.dispatch('QuitDying', { playerId: ownerId, hp: owner?.hp ?? 0 }, { targetId: ownerId })
    host.state.dying = null
    host.resumeAfterDying()
    dealXingshuaiPunishment(host, responders, 0)
  },

  startQueued(host, _ownerId, prompt) {
    if (prompt.step !== 'punish-continue') return
    const { responders, index } = prompt.data as { responders: PlayerId[]; index: number }
    dealXingshuaiPunishment(host, responders, index)
  },
})

function dealXingshuaiPunishment(host: SkillHost, responders: PlayerId[], index: number): void {
  for (let i = index; i < responders.length; i += 1) {
    const targetId = responders[i]
    if (playerOf(host.state, targetId)?.alive) {
      resolveDamage(host as never, { sourceId: null, targetId, amount: 1, nature: 'normal', cardName: null })
    }
    if (host.state.dying || host.state.damageChain) {
      host.queueSkill({ skillId: XINGSHUAI, ownerId: targetId, step: 'punish-continue', data: { responders, index: i + 1 } })
      return
    }
  }
}

export const CAORUI: CharacterDefinition = {
  id: 'caorui',
  name: '曹叡',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2015',
  skills: [
    {
      id: HUITUO,
      name: '恢拓',
      description: '曹叡受到一次伤害后，可以选择一名角色进行判定：红色，其回复 1 点体力；黑色，其摸 X 张牌（X 为此次伤害点数）。',
    },
    {
      id: MINGJIAN,
      name: '明鉴',
      description: '出牌阶段限一次，曹叡将所有手牌交给一名其他角色，目标下一个实际回合的手牌上限 +1、出牌阶段【杀】使用次数上限 +1（可叠加）。',
    },
    {
      id: XINGSHUAI,
      name: '兴衰',
      description: '主公技，限定技，曹叡进入濒死时可以发动，其他存活魏势力角色依次选择是否响应；每有一名响应者，曹叡回复 1 点体力；濒死结算结束后，响应过的角色依次受到 1 点无来源伤害。',
    },
  ],
}
