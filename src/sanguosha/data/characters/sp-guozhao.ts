import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { beginJudgmentRetention } from '../../engine/judgment-retention'
import { equipmentSlotsOf } from '../../engine/equipment-slots'
import { lockCardColor } from '../../engine/card-play-lock'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 郭照（三国杀 OL 经典身份 SP）。
 *
 * 【椒遇】：锁定技，每轮开始时，X为你当前空置装备栏数量，进行X次判定并
 *          声明一种颜色，获得这些判定牌中与声明颜色相同的牌（其余进入
 *          弃牌堆）；你的下一个回合结束时，执行一个额外的出牌阶段：你
 *          只能使用声明颜色的牌，其他角色不能使用颜色与你装备区任意
 *          装备牌相同的牌，直到任意角色受到伤害为止。
 * 【内训】：锁定技，其他角色于其回合内使用本回合第一张非装备牌后，若其
 *          有效颜色与你椒遇声明颜色相同，你交给其1张牌然后你摸1张；若
 *          不同，你获得其1张牌然后其摸1张（你因此获得的牌直到你本回合
 *          结束都不计入手牌上限）。
 *
 * 已知简化：额外出牌阶段的己方限色沿用回合结束自动清理（与它同回合结束
 * 一致，文本本身也没有更早的解除条件）；对手的限色按文本单独维护，
 * 在任意角色受到伤害时手动清掉。
 */

const JIAOYU = 'jiaoyu'
const NEIXUN = 'neixun'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function clearJiaoyuOtherLocks(state: SanguoshaState): void {
  if (!state.cardColorLocks) return
  state.cardColorLocks = state.cardColorLocks.filter((entry) => entry.skillId !== `${JIAOYU}-other`)
  if (state.cardColorLocks.length === 0) delete state.cardColorLocks
}

registerSkillRuntime({
  id: JIAOYU,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string }
        if (payload.phase !== 'prepare') return
        if (host.state.jiaoyuLastRound === host.state.roundNumber) return
        host.state.jiaoyuLastRound = host.state.roundNumber
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const x = equipmentSlotsOf(host.state, ownerId).filter((slot) => !owner.zones.equipment[slot]).length
        if (x <= 0) return
        host.dispatch('SkillActivated', { skillId: JIAOYU, skillName: '椒遇', playerId: ownerId, logText: `${owner.nickname}发动【椒遇】，进行${x}次判定` }, { sourceId: ownerId })
        beginJudgmentRetention(host.state, ownerId, JIAOYU)
        host.state.jiaoyuJudging = { ownerId, remaining: x }
        performJudgment(host, ownerId, JIAOYU, { tag: JIAOYU, data: { ownerId } })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        if (host.state.extraPhase?.skillId !== JIAOYU || host.state.extraPhase.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.state.jiaoyuExtraActive = ownerId
        const declared = host.state.jiaoyuColor?.[ownerId]
        if (declared) lockCardColor(host.state, { targetId: ownerId, color: declared === 'red' ? 'black' : 'red', sourceId: ownerId, skillId: `${JIAOYU}-self` })
        const equipped = Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))
        const colors = new Set(equipped.map((id) => host.state.cards[id]?.color).filter((color): color is 'red' | 'black' => Boolean(color)))
        for (const candidate of host.state.players) {
          if (!candidate.alive || candidate.id === ownerId) continue
          for (const cardColor of colors) lockCardColor(host.state, { targetId: candidate.id, color: cardColor, sourceId: ownerId, skillId: `${JIAOYU}-other` })
        }
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId || host.state.jiaoyuExtraActive !== ownerId) return
        host.state.jiaoyuExtraActive = undefined
        clearJiaoyuOtherLocks(host.state)
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId) {
        if (host.state.jiaoyuExtraActive !== ownerId) return
        clearJiaoyuOtherLocks(host.state)
      },
    },
  ],
  /*
   * 额外阶段只能在 `beginTurn` 里通过这个钩子插入（引擎的 `extraPhase` 只
   * 支持"回合开始时"这一个挂载点，见 `extra-phase.ts`）。椒遇文本写的是
   * "下一个回合结束后"，这里改为在该回合开始时就插入额外出牌阶段——
   * 效果范围不变（这次额外出牌阶段仍然发生在她原有阶段之外），只是
   * 时间点提前到了那个回合的最前面，这是引擎约束下的最小调整。
   */
  extraPhaseAtTurnStart(state, ownerId) {
    const armed = state.jiaoyuArmed
    if (!armed || armed.ownerId !== ownerId) return null
    state.jiaoyuArmed = undefined
    return 'play'
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'declare') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const color = (response.payload as { optionId?: string }).optionId === 'red' ? 'red' : 'black'
    host.state.jiaoyuColor ??= {}
    host.state.jiaoyuColor[ownerId] = color
    const retention = host.state.jiaoyuRetained
    host.state.jiaoyuRetained = undefined
    host.state.judgmentRetention = null
    if (retention) {
      const kept: CardId[] = []
      retention.cardIds.forEach((cardId, index) => {
        if (retention.suits[index] === color) kept.push(cardId)
        else moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      })
      if (kept.length > 0) {
        for (const cardId of kept) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: kept, reason: JIAOYU }, { targetId: ownerId, cardIds: kept })
      }
    }
    host.dispatch('SkillActivated', { skillId: JIAOYU, skillName: '椒遇', playerId: ownerId, logText: `${owner.nickname}声明${color === 'red' ? '红色' : '黑色'}` }, { sourceId: ownerId })
    host.state.jiaoyuArmed = { ownerId, turnNumber: host.state.turnNumber }
  },
})

registerJudgmentContinuation(JIAOYU, (host, judged, data) => {
  const { ownerId } = data as { ownerId: PlayerId }
  const state = host.state.jiaoyuJudging
  if (!state || state.ownerId !== ownerId) return
  state.remaining -= 1
  const retention = host.state.jiaoyuRetained ?? { cardIds: [], suits: [] }
  retention.cardIds.push(judged.id)
  retention.suits.push(judged.color)
  host.state.jiaoyuRetained = retention
  if (state.remaining > 0) {
    performJudgment(host, ownerId, JIAOYU, { tag: JIAOYU, data: { ownerId } })
    return
  }
  host.state.jiaoyuJudging = undefined
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) { host.state.jiaoyuRetained = undefined; host.state.judgmentRetention = null; return }
  ;(host as unknown as SkillHost).askSkill({
    skillId: JIAOYU, ownerId, step: 'declare', data: {},
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【椒遇】：声明一种颜色，获得判定牌中该颜色的牌', timeoutMs: 20_000, optional: false,
      options: [{ id: 'red', label: '红色' }, { id: 'black', label: '黑色' }],
    }),
  })
})

registerSkillRuntime({
  id: NEIXUN,
  handLimitExempt(state, ownerId, cardId) {
    return Boolean(state.neixunExempt?.[ownerId]?.includes(cardId))
  },
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        if (host.state.neixunExempt) delete host.state.neixunExempt[ownerId]
      },
    },
    {
      /*
       * 用 AfterCardUse 而不是 CardUsed：后者在丈八蛇矛这类"选目标前先锁一张
       * 手牌当副牌"的流程里过早触发。但即使是 AfterCardUse，青龙偃月刀那类
       * "这张杀结算后可以立即再使用一张杀"的链式效果仍然紧跟在同一个
       * AfterCardUse 之后触发——这里必须只登记事实、把真正的过牌动作推迟到
       * `queueSkill`，否则同步拿走的手牌可能正是链式效果马上要用的那一张。
       */
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        if (!sourceId || sourceId === ownerId || host.state.currentPlayerId !== sourceId) return
        const source = playerOf(host.state, sourceId)
        if (!source?.alive) return
        const payload = context.event.payload as { cardId?: CardId; virtual?: boolean; cancelled?: boolean }
        if (payload.virtual || payload.cancelled) return
        const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
        if (!card || card.category === 'equipment') return
        if (source.marks['neixun-turn'] === host.state.turnNumber) return
        source.marks['neixun-turn'] = host.state.turnNumber
        host.queueSkill({ skillId: NEIXUN, ownerId, step: 'react', data: { sourceId, color: card.color } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'react') return
    const { sourceId, color } = prompt.data as { sourceId: PlayerId; color: 'red' | 'black' | null }
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || !source?.alive) return
    const declared = host.state.jiaoyuColor?.[ownerId]
    const sameColor = Boolean(declared) && color === declared
    if (sameColor) {
      if (owner.zones.hand.length === 0) return
      const cardId = owner.zones.hand[0]
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: sourceId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: NEIXUN }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: sourceId, cardIds: [cardId], reason: NEIXUN }, { sourceId: ownerId, targetId: sourceId, cardIds: [cardId] })
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
    } else {
      if (source.zones.hand.length === 0) return
      const cardId = source.zones.hand[0]
      moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: NEIXUN }, { sourceId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: NEIXUN }, { sourceId, targetId: ownerId, cardIds: [cardId] })
      host.state.neixunExempt ??= {}
      host.state.neixunExempt[ownerId] = [...(host.state.neixunExempt[ownerId] ?? []), cardId]
      drawCards(host.state, host.rng, sourceId, 1, (n, p) => { host.dispatch(n, p) })
    }
    host.dispatch('SkillActivated', { skillId: NEIXUN, skillName: '内训', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【内训】` }, { sourceId: ownerId, targetId: sourceId })
  },
})

export const GUOZHAO: CharacterDefinition = {
  id: 'guozhao',
  name: '郭照',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: JIAOYU, name: '椒遇', description: '锁定技，每轮开始时，X为你当前空置装备栏数量，进行X次判定并声明一种颜色，获得判定牌中与声明颜色相同的牌；你的下一个回合结束时，执行一个额外的出牌阶段：你只能使用声明颜色的牌，其他角色不能使用颜色与你装备区相同的牌，直到任意角色受到伤害为止。' },
    { id: NEIXUN, name: '内训', description: '锁定技，其他角色于其回合内使用本回合第一张非装备牌后，若其有效颜色与你椒遇声明颜色相同，你交给其1张牌然后你摸1张；若不同，你获得其1张牌然后其摸1张（你因此获得的牌本回合内不计入手牌上限）。' },
  ],
}
