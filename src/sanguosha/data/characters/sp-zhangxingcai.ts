import { drawCards } from '../../engine/draw'
import { newDiscardEntries } from '../../engine/discard-provenance'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张星彩（三国杀 OL 经典身份 SP）。
 *
 * 【甚贤】：每个回合限一次，其他角色于张星彩回合外因弃置而失去至少一张基本
 *          牌后，张星彩可以摸一张牌。
 * 【枪舞】：出牌阶段限一次，张星彩进行一次判定，X 为判定牌点数。直到本回合
 *          结束：点数 < X 的【杀】无距离限制；点数 > X 的【杀】无次数限制。
 *
 * 已知简化（记录在案）：**无距离限制这一半退化为整个回合无条件生效**，不再
 * 按点数区分。距离判定的 `ignoresDistanceTo` 钩子只问「拥有者对这个目标」，
 * 不带正在使用哪张牌的信息，给它加一个 cardId 形参是比这一条效果本身更大的
 * 改动，本轮不做。「无次数限制」这一半按点数区分是精确实现的：挂在
 * `TargetConfirmed` 上，点数 > X 的【杀】用掉之后把本回合出杀计数原样退回去。
 */

const SHENXIAN = 'shenxian'
const QIANGWU = 'qiangwu'
const SHENXIAN_CURSOR = 'shenxian-cursor'
const SHENXIAN_TURN_MARK = 'shenxian-turn'
const QIANGWU_TAG = 'qiangwu'
const QIANGWU_TURN_MARK = 'qiangwu-active-turn'
const QIANGWU_X_MARK = 'qiangwu-x'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: SHENXIAN,
  triggers: [{
    event: 'LoseCard',
    handle(host, ownerId) {
      if (host.state.currentPlayerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.marks[SHENXIAN_TURN_MARK] === host.state.turnNumber) return
      host.queueSkill({ skillId: SHENXIAN, ownerId, step: 'collect', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'collect') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.marks[SHENXIAN_TURN_MARK] === host.state.turnNumber) return
    const cursor = owner.marks[SHENXIAN_CURSOR] ?? 0
    const hit = newDiscardEntries(host.state, cursor, (entry, cardId) => (
      entry.reason === 'discard' && entry.ownerId !== null && entry.ownerId !== ownerId
      && host.state.cards[cardId]?.category === 'basic'
    ))
    owner.marks[SHENXIAN_CURSOR] = host.state.seq
    if (hit.length === 0) return
    owner.marks[SHENXIAN_TURN_MARK] = host.state.turnNumber
    host.dispatch('SkillActivated', {
      skillId: SHENXIAN, skillName: '甚贤', playerId: ownerId,
      logText: `${owner.nickname}发动【甚贤】，摸一张牌`,
    }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: QIANGWU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, QIANGWU)) return []
    return [{ id: QIANGWU, label: '枪舞：进行一次判定' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== QIANGWU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    markUsedThisTurn(host.state, ownerId, QIANGWU)
    host.dispatch('SkillActivated', {
      skillId: QIANGWU, skillName: '枪舞', playerId: ownerId,
      logText: `${owner.nickname}发动【枪舞】，进行判定`,
    }, { sourceId: ownerId })
    performJudgment(host, ownerId, QIANGWU, { tag: QIANGWU_TAG, data: { ownerId } })
  },

  ignoresDistanceTo(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return Boolean(owner?.alive && owner.marks[QIANGWU_TURN_MARK] === state.turnNumber)
  },

  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (context.event.sourceId !== ownerId || payload.cardName !== '杀') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.marks[QIANGWU_TURN_MARK] !== host.state.turnNumber) return
      const x = owner.marks[QIANGWU_X_MARK] ?? 0
      const rank = payload.cardId ? host.state.cards[payload.cardId]?.rank ?? 0 : 0
      if (rank <= x) return
      // 点数 > X：这一张【杀】不计入本回合出杀次数，原样退回去
      host.state.turnUsage.slashUses = Math.max(0, host.state.turnUsage.slashUses - 1)
      if (host.state.turnUsage.slashUsesThisTurn !== undefined) {
        host.state.turnUsage.slashUsesThisTurn = Math.max(0, host.state.turnUsage.slashUsesThisTurn - 1)
      }
    },
  }],
})

registerJudgmentContinuation(QIANGWU_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  owner.marks[QIANGWU_TURN_MARK] = host.state.turnNumber
  owner.marks[QIANGWU_X_MARK] = judged.rank
  host.dispatch('SkillActivated', {
    skillId: QIANGWU, skillName: '枪舞', playerId: ownerId,
    logText: `${owner.nickname}的【枪舞】判定结果为 ${judged.rank} 点`,
  }, { sourceId: ownerId })
})

export const ZHANGXINGCAI: CharacterDefinition = {
  id: 'zhangxingcai',
  name: '张星彩',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: SHENXIAN,
      name: '甚贤',
      description: '每个回合限一次，其他角色于张星彩回合外因弃置而失去至少一张基本牌后，张星彩可以摸一张牌。',
    },
    {
      id: QIANGWU,
      name: '枪舞',
      description: '出牌阶段限一次，张星彩进行一次判定，X 为判定牌点数。直到本回合结束：点数小于 X 的【杀】无距离限制；点数大于 X 的【杀】无次数限制。',
    },
  ],
}
