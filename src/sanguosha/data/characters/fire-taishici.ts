import { canPindian, claimPindianCards, finishPindianSettlement, registerPindianContinuation, startPindian } from '../../engine/pindian'
import type { ChooseOptionRequest, ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { characterSkillIdsOf, registerSkillRuntime, skillsOf, type SkillHost } from '../../engine/skills/runtime'
import { grantTurnSlashBonus, prohibitSlashThisTurn } from '../../engine/slash-rules'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
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
const JIE_HANZHAN_B64 = 'han-zhan-jie-b64'
registerSkillRuntime({ id: JIE_HANZHAN_B64 })

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
    if (!owner?.alive || usedThisPhase(state, ownerId, TIANYI)) return []
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
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !tianyiTargets(host.state, ownerId).includes(targetId)) return
      const hasHanzhan = skillsOf(host.state, ownerId, characterSkillIdsOf).some((skill) => skill.id === JIE_HANZHAN_B64)
      const target = playerOf(host.state, targetId)
      if (hasHanzhan && target?.zones.hand.length) {
        host.askSkill({ skillId: TIANYI, ownerId, step: 'hanzhan-before', data: { targetId }, build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: ownerId,
          prompt: `【酣战】：是否令${target.nickname}以一张随机手牌与你拼点？`, timeoutMs: 20_000, optional: true,
          options: [{ id: 'random', label: '令其以随机手牌拼点' }, { id: 'normal', label: '正常拼点' }],
        }) })
        return
      }
      beginTianyiPindian(host, ownerId, targetId, false)
      return
    }
    if (resolution.step === 'hanzhan-before') {
      const targetId = resolution.data.targetId as PlayerId
      const forceRandom = (response.payload as { optionId?: string }).optionId === 'random'
      if (!tianyiTargets(host.state, ownerId).includes(targetId)) return
      beginTianyiPindian(host, ownerId, targetId, forceRandom)
      return
    }
    if (resolution.step === 'hanzhan-after') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') {
        const candidates = (resolution.data.cardIds as string[]) ?? []
        if (candidates.length > 1) {
          host.askSkill({ skillId: TIANYI, ownerId, step: 'hanzhan-pick', data: { cardIds: candidates }, build: (id) => ({
            id, kind: 'choose-cards', playerId: ownerId, prompt: '【酣战】：选择获得一张点数最大的【杀】', timeoutMs: 20_000,
            optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
          }) })
        } else {
          claimPindianCards(host, ownerId, candidates)
          host.dispatch('SkillActivated', { skillId: JIE_HANZHAN_B64, skillName: '酣战', playerId: ownerId, cardIds: candidates, logText: `${playerOf(host.state, ownerId)?.nickname ?? '界太史慈'}发动【酣战】，获得拼点牌中的【杀】` }, { sourceId: ownerId, cardIds: candidates })
        }
      } else finishPindianSettlement(host)
      return
    }
    if (resolution.step === 'hanzhan-pick') {
      const candidates = (resolution.data.cardIds as string[]) ?? []
      const cardId = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      if (cardId && candidates.includes(cardId)) {
        const claimed = claimPindianCards(host, ownerId, [cardId])
        if (claimed.length) host.dispatch('SkillActivated', { skillId: JIE_HANZHAN_B64, skillName: '酣战', playerId: ownerId, cardIds: claimed, logText: `${playerOf(host.state, ownerId)?.nickname ?? '界太史慈'}发动【酣战】，获得拼点牌中的【杀】` }, { sourceId: ownerId, cardIds: claimed })
      } else finishPindianSettlement(host)
    }
  },
})

function beginTianyiPindian(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, forceRandom: boolean): void {
  markUsedThisPhase(host.state, ownerId, TIANYI)
  const target = playerOf(host.state, targetId)
  const forcedCardId = forceRandom && target?.zones.hand.length
    ? target.zones.hand[host.rng.nextInt(target.zones.hand.length)] : undefined
  startPindian(host, {
    id: `tianyi-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
    reason: TIANYI, continuationTag: TIANYI_TAG,
    ...(forcedCardId ? { opponentForcedCardId: forcedCardId } : {}),
    data: { jieHanzhan: forceRandom },
  })
}

registerPindianContinuation(TIANYI_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = result.initiatorId
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return

  resolveTianyiResult(skillHost, result)

  const hasHanzhan = skillsOf(host.state, ownerId, characterSkillIdsOf).some((skill) => skill.id === JIE_HANZHAN_B64)
  if (hasHanzhan) {
    const slashCards = [
      { cardId: result.initiatorCardId, rank: result.initiatorRank },
      { cardId: result.opponentCardId, rank: result.opponentRank },
    ].filter(({ cardId }) => host.state.cards[cardId]?.name === '杀')
    if (slashCards.length) {
      const highest = Math.max(...slashCards.map(({ rank }) => rank))
      const highestSlashIds = slashCards.filter(({ rank }) => rank === highest).map(({ cardId }) => cardId)
      const skillHost = host as unknown as SkillHost
      skillHost.askSkill({ skillId: TIANYI, ownerId, step: 'hanzhan-after', data: { cardIds: highestSlashIds }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【酣战】：是否获得拼点牌中点数最大的【杀】？',
        timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '获得此【杀】' }, { id: 'no', label: '不获得' }],
      }) })
      return 'defer-settlement'
    }
  }

})

function resolveTianyiResult(host: SkillHost, result: import('../../engine/pindian').PindianResult): void {
  const owner = playerOf(host.state, result.initiatorId)
  if (!owner?.alive) return
  if (result.outcome === 'initiator-win') {
    // 本回合：多一次出杀、每张杀多指定一个目标、无距离限制
    grantTurnSlashBonus(host.state, result.initiatorId, { extraUses: 1, extraTargets: 1, ignoreDistance: true })
    host.dispatch('SkillActivated', {
      skillId: TIANYI, skillName: '天义', playerId: result.initiatorId, targetIds: [result.opponentId], result: 'win',
      logText: `${owner.nickname}拼点获胜：本回合可多使用一张【杀】，且【杀】可多指定一个目标并无距离限制`,
    }, { sourceId: result.initiatorId, targetId: result.opponentId })
    return
  }

  // **「没赢」包含平局**：经典规则写的是「若你没赢」，平局同样进失败分支
  prohibitSlashThisTurn(host.state, result.initiatorId)
  host.dispatch('SkillActivated', {
    skillId: TIANYI, skillName: '天义', playerId: result.initiatorId, targetIds: [result.opponentId], result: 'lose',
    logText: `${owner.nickname}拼点没有赢：本回合不能使用【杀】`,
  }, { sourceId: result.initiatorId, targetId: result.opponentId })
}

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

export const JIE_TAISHICI_B64: CharacterDefinition = {
  id: 'jie-taishici-b64', name: '界·太史慈', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'fire',
  skills: [
    { id: TIANYI, name: '天义', description: '出牌阶段限一次，你可以拼点：若你赢，你本回合使用【杀】的次数+1、无距离限制且可以多指定一个目标；若你没赢，你本回合不能使用【杀】。' },
    { id: JIE_HANZHAN_B64, name: '酣战', description: '当你拼点前，你可以令对方用随机手牌拼点。当你拼点后，你可以获得拼点牌中点数最大的【杀】。' },
  ],
}
