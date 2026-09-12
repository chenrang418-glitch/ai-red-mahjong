import { resolveDamage } from '../../engine/damage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { skipPhase } from '../../engine/turn'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 朱桓（一将成名 2014）。
 *
 * 【奋励】：若朱桓手牌数为全场最多（可并列），可以跳过摸牌阶段；若朱桓体力
 *          值为全场最多（可并列），可以跳过出牌阶段；若朱桓装备区至少有一张
 *          牌且装备数量为全场最多（可并列），可以跳过弃牌阶段。三项各自独立。
 * 【平寇】：回合结束时，X 为朱桓本回合实际跳过的阶段数，若 X>0，可以选择
 *          至多 X 名其他角色，分别对其造成 1 点伤害。
 *
 * 两处最容易做错的：
 *
 * 1. **三项条件各自独立判断**，走公共的 `offerPhaseSkip` 挂起窗口，
 *    真要跳过时调 `skipPhase`——不能直接改阶段数组。
 * 2. **X 只认这个回合真的被跳过的阶段数**（`state.skippedPhases`），
 *    不是「没有判定牌」这类效果本身导致的阶段空转。
 */

const FENLI = 'fenli'
const PINGKOU = 'pingkou'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isMax(state: SanguoshaState, ownerId: PlayerId, value: (playerId: PlayerId) => number): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return false
  const mine = value(ownerId)
  return state.players.filter((candidate) => candidate.alive).every((candidate) => value(candidate.id) <= mine)
}

registerSkillRuntime({
  id: FENLI,
  offerPhaseSkip(host, ownerId, phase) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    if (phase === 'draw' && !isMax(host.state, ownerId, (id) => playerOf(host.state, id)?.zones.hand.length ?? 0)) return false
    if (phase === 'play' && !isMax(host.state, ownerId, (id) => playerOf(host.state, id)?.hp ?? -Infinity)) return false
    if (phase === 'discard') {
      const equipmentCount = (id: PlayerId) => Object.values(playerOf(host.state, id)?.zones.equipment ?? {}).filter(Boolean).length
      if (equipmentCount(ownerId) === 0 || !isMax(host.state, ownerId, equipmentCount)) return false
    }
    if (phase !== 'draw' && phase !== 'play' && phase !== 'discard') return false
    const label: Record<string, string> = { draw: '摸牌阶段', play: '出牌阶段', discard: '弃牌阶段' }
    host.askSkill({
      skillId: FENLI, ownerId, step: 'ask', data: { phase },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【奋励】：跳过${label[phase]}？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: `跳过${label[phase]}` }, { id: 'no', label: '正常进行' }],
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if ((response.payload as { optionId?: string }).optionId === 'yes' && owner?.alive) {
      const phase = resolution.data.phase as 'draw' | 'play' | 'discard'
      skipPhase(host.state, phase)
      host.dispatch('SkillActivated', {
        skillId: FENLI, skillName: '奋励', playerId: ownerId,
        logText: `${owner.nickname}发动【奋励】，跳过本回合的这个阶段`,
      }, { sourceId: ownerId })
    }
    host.resumePhaseEntry()
  },
})

registerSkillRuntime({
  id: PINGKOU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      host.queueSkill({ skillId: PINGKOU, ownerId, step: 'target', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'continue') {
      const { targetIds, index } = prompt.data as { targetIds: PlayerId[]; index: number }
      dealPingkouDamage(host, ownerId, targetIds, index)
      return
    }
    if (prompt.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const x = host.state.skippedPhases.length
    if (x <= 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: PINGKOU, ownerId, step: 'target', data: { x },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【平寇】：选择至多 ${x} 名其他角色，各造成 1 点伤害`,
        timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: Math.min(x, candidateIds.length),
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const owner = playerOf(host.state, ownerId)
      const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      if (!owner?.alive || targetIds.length === 0) return
      host.dispatch('SkillActivated', {
        skillId: PINGKOU, skillName: '平寇', playerId: ownerId,
        logText: `${owner.nickname}发动【平寇】`,
      }, { sourceId: ownerId })
      dealPingkouDamage(host, ownerId, targetIds, 0)
      return
    }
    if (resolution.step === 'continue') {
      const targetIds = resolution.data.targetIds as PlayerId[]
      const index = resolution.data.index as number
      dealPingkouDamage(host, ownerId, targetIds, index)
    }
  },
})

/**
 * 依次对每名目标造成 1 点伤害。**每次伤害之后都要确认濒死流程已经结束**——
 * 打倒其中一人可能触发求桃，那是另一套独立的请求 / 响应流程，
 * 不能在同一次调用里紧接着对下一人造成伤害（那会撞上「濒死流程尚未结束」）。
 */
function dealPingkouDamage(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number): void {
  for (let i = index; i < targetIds.length; i += 1) {
    const targetId = targetIds[i]
    if (playerOf(host.state, targetId)?.alive) {
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
    }
    if (host.state.dying || host.state.damageChain) {
      host.queueSkill({ skillId: PINGKOU, ownerId, step: 'continue', data: { targetIds, index: i + 1 } })
      return
    }
  }
}

export const ZHUHUAN: CharacterDefinition = {
  id: 'zhuhuan',
  name: '朱桓',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2014',
  skills: [
    {
      id: FENLI,
      name: '奋励',
      description: '若朱桓手牌数为全场最多（可并列），可以跳过摸牌阶段；若朱桓体力值为全场最多（可并列），可以跳过出牌阶段；若朱桓装备区至少有一张牌且装备数量为全场最多（可并列），可以跳过弃牌阶段。',
    },
    {
      id: PINGKOU,
      name: '平寇',
      description: '回合结束时，X 为朱桓本回合实际跳过的阶段数，若 X>0，可以选择至多 X 名其他角色，分别对其造成 1 点伤害。',
    },
  ],
}
