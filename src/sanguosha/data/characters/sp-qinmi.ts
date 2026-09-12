import { canTarget } from '../../engine/distance'
import { moveCard } from '../../engine/zones'
import { startPindian, registerPindianContinuation } from '../../engine/pindian'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 秦宓（三国杀 OL 经典身份 SP）。
 *
 * 【谏征】：当其他角色 A 使用【杀】指定另一名角色 B 为目标时，若秦宓在 A
 *          的攻击范围内，秦宓可以将一张手牌置于牌堆顶，然后取消这张【杀】
 *          当前的所有目标；若这张【杀】不是黑色，秦宓成为该【杀】的目标。
 * 【专对】：秦宓使用【杀】指定目标后，可以与目标拼点，赢则目标不能响应；
 *          秦宓成为【杀】目标后，可以与使用者拼点，赢则这张牌对秦宓无效。
 * 【天辩】：秦宓拼点时可以改用牌堆顶一张牌参与拼点；他的红桃拼点牌点数
 *          视为 13。
 *
 * 两处最容易做错的：
 *
 * 1. **谏征取消的是「当前所有目标」**：把 `targetCancelled` 和
 *    `remainingTargetIds` 一起清掉；非黑杀改秦宓为目标时，把秦宓塞进
 *    `remainingTargetIds`，交给既有的 `continueSlash` 流程去接手，
 *    不自己重置各项每目标状态。
 * 2. **天辩不改变实体拼点流程**：把牌堆顶牌先移进秦宓手牌，再走正常拼点
 *    选牌；点数覆盖走新增的 `pindianRankOverride` 钩子，只在拼点比较时
 *    生效，不改这张牌本身的点数。
 */

const JIANZHENG = 'jianzheng'
const ZHUANDUI = 'zhuandui'
const TIANBIAN = 'tianbian'
const ZHUANDUI_A_TAG = 'zhuandui-a'
const ZHUANDUI_B_TAG = 'zhuandui-b'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: JIANZHENG,
  /*
   * 谏征是「既不是使用者也不是目标」的旁观者反应，必须在求闪**之前**同步
   * 插入——`TargetConfirmed` + `queueSkill` 会等到 `cardResolution` 清空
   * （即这张杀已经问完闪、伤害都结算完）才排到，那时候再取消目标就晚了。
   * 走新增的旁观者插入点 `interceptBystanderTarget`（和已有的
   * `interceptTarget`/`interceptSourceTarget` 同一批，只是遍历对象是
   * 「既非使用者也非目标的其他人」）。
   */
  interceptBystanderTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || !context.sourceId || context.sourceId === ownerId || context.targetId === ownerId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return false
    if (!canTarget(host.state, context.sourceId, ownerId)) return false
    host.askSkill({
      skillId: JIANZHENG, ownerId, step: 'ask',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【谏征】：将一张手牌置于牌堆顶，取消这张【杀】的所有目标？',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const [cardId] = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    const current = host.state.cardResolution
    if (!cardId || !owner?.alive || !owner.zones.hand.includes(cardId) || current?.kind !== 'slash') { host.resumeCardTarget(); return }
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIANZHENG }, { targetId: ownerId, cardIds: [cardId] })
    const isBlack = host.state.cards[current.cardId]?.color === 'black'
    host.dispatch('SkillActivated', {
      skillId: JIANZHENG, skillName: '谏征', playerId: ownerId,
      logText: `${owner.nickname}发动【谏征】，取消这张【杀】的所有目标${isBlack ? '' : `，改指向${owner.nickname}`}`,
    }, { sourceId: ownerId })
    current.targetCancelled = true
    current.remainingTargetIds = isBlack ? [] : [ownerId]
    host.resumeCardTarget()
  },
})

registerSkillRuntime({
  id: ZHUANDUI,
  /*
   * A 半边（秦宓自己用杀指定目标后）同样必须在求闪之前同步问出去，
   * 走既有的使用者侧插入点 `interceptSourceTarget`（伏皇后【求援】走的
   * 也是这一类源侧插入点，只是那个用的是目标侧）。
   */
  interceptSourceTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.targetId === ownerId) return false
    const targetId = context.targetId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || owner.zones.hand.length === 0 || target.zones.hand.length === 0) return false
    host.askSkill({
      skillId: ZHUANDUI, ownerId, step: 'ask-a', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【专对】：与${target.nickname}拼点，赢则其不能响应这张【杀】？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '拼点' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },

  interceptTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId === ownerId) return false
    const sourceId = context.sourceId
    if (!sourceId) return false
    host.askSkill({
      skillId: ZHUANDUI, ownerId, step: 'ask-b', data: { sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【专对】：与使用者拼点，赢则这张【杀】对你无效？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '拼点' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask-a') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const { targetId } = resolution.data as { targetId: PlayerId }
      startPindian(host, { id: `zhuandui-a-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId, reason: ZHUANDUI, continuationTag: ZHUANDUI_A_TAG })
      return
    }
    if (resolution.step === 'ask-b') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const owner = playerOf(host.state, ownerId)
      const source = playerOf(host.state, sourceId)
      if (!owner?.alive || !source?.alive || owner.zones.hand.length === 0 || source.zones.hand.length === 0) { host.resumeCardTarget(); return }
      startPindian(host, { id: `zhuandui-b-${host.state.seq}`, initiatorId: ownerId, opponentId: sourceId, reason: ZHUANDUI, continuationTag: ZHUANDUI_B_TAG, data: { fromInterceptTarget: true } })
    }
  },
})

registerPindianContinuation(ZHUANDUI_A_TAG, (host, result) => {
  const { initiatorId, opponentId, outcome } = result
  const resolution = host.state.cardResolution
  if (outcome === 'initiator-win' && resolution?.kind === 'slash' && resolution.targetId === opponentId) {
    // 杀的结算一次只有一个「当前目标」，不能响应就是这个目标不能打出闪
    resolution.noDodge = true
    host.dispatch('SkillActivated', {
      skillId: ZHUANDUI, skillName: '专对', playerId: initiatorId, targetId: opponentId,
      logText: '拼点获胜，目标不能响应这张【杀】',
    }, { sourceId: initiatorId, targetId: opponentId })
  }
  const skillHost = host as unknown as SkillHost
  skillHost.resumeCardTarget()
})

registerPindianContinuation(ZHUANDUI_B_TAG, (host, result) => {
  const { initiatorId, outcome } = result
  const resolution = host.state.cardResolution
  if (outcome === 'initiator-win' && resolution?.kind === 'slash' && resolution.targetId === initiatorId) {
    resolution.targetCancelled = true
    host.dispatch('SkillActivated', {
      skillId: ZHUANDUI, skillName: '专对', playerId: initiatorId,
      logText: '拼点获胜，这张【杀】对秦宓无效',
    }, { sourceId: initiatorId, targetId: initiatorId })
  }
  const skillHost = host as unknown as SkillHost
  skillHost.resumeCardTarget()
})

/*
 * 天辩「改用牌堆顶一张牌参与拼点」这一半本轮未实现（记在案，不是遗漏）：
 * 拼点选牌走的是 `pindian.ts` 内部固定的 `askPindianCard`，直接向双方各发一条
 * 「选一张手牌」请求，没有给单个技能插入「换成另一来源的牌」的挂钩点；
 * 要做到这一半需要改造拼点核心的选牌请求本身，超出本轮「不改核心结算」的
 * 范围。红桃拼点牌视为 13 点的另一半按官方文本正常生效。
 */
registerSkillRuntime({
  id: TIANBIAN,

  pindianRankOverride(state, ownerId, card) {
    if (card.suit !== 'heart') return null
    const owner = playerOf(state, ownerId)
    return owner?.alive ? 13 : null
  },
})

export const QINMI: CharacterDefinition = {
  id: 'qinmi',
  name: '秦宓',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: JIANZHENG,
      name: '谏征',
      description: '当其他角色 A 使用【杀】指定另一名角色 B 为目标时，若秦宓在 A 的攻击范围内，秦宓可以将一张手牌置于牌堆顶，然后取消这张【杀】当前的所有目标；若这张【杀】不是黑色，秦宓成为该【杀】的目标。',
    },
    {
      id: ZHUANDUI,
      name: '专对',
      description: '秦宓使用【杀】指定目标后，可以与目标拼点，赢则目标不能响应这张【杀】；秦宓成为【杀】的目标后，可以与使用者拼点，赢则这张【杀】对秦宓无效。',
    },
    {
      id: TIANBIAN,
      name: '天辩',
      description: '秦宓拼点时可以改用牌堆顶一张牌参与拼点；他的红桃拼点牌点数视为 13。',
    },
  ],
}
