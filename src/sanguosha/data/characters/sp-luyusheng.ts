import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陆郁生（三国杀 OL 经典身份 SP，普通版，不是族陆郁生）。
 *
 * 【藏心】：锁定技，摸牌阶段开始时展示牌堆底3张（仍留在牌堆底），
 *          额外摸X张（X=其中红桃数）；每个 TurnInstance 第一次即将受到
 *          伤害时，展示牌堆底3张，可以弃置其中任意张，弃的红桃数量为X，
 *          此伤害-X（最低为0）。
 * 【润微】：任意已受伤角色的弃牌阶段开始时，陆郁生可以选择：令其摸1张牌，
 *          然后其本阶段手牌上限-1；或令其弃1张牌，然后其本阶段手牌上限+1。
 */

const CANGXIN = 'cangxin'
const RUNWEI = 'runwei'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function bottomThree(state: SanguoshaState): CardId[] {
  const pile = state.zones.drawPile
  return pile.slice(Math.max(0, pile.length - 3))
}

registerSkillRuntime({
  id: CANGXIN,
  triggers: [
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const bottom = bottomThree(host.state)
        if (bottom.length === 0) return
        host.dispatch('CardMove', { cardIds: bottom, reason: CANGXIN, revealed: true }, { sourceId: ownerId })
        const x = bottom.filter((id) => host.state.cards[id]?.suit === 'heart').length
        host.dispatch('SkillActivated', { skillId: CANGXIN, skillName: '藏心', playerId: ownerId, logText: `${owner.nickname}发动【藏心】，展示牌堆底，额外摸${x}张` }, { sourceId: ownerId })
        if (x > 0) drawCards(host.state, host.rng, ownerId, x, (n, p) => { host.dispatch(n, p) })
      },
    },
    {
      /*
       * BeforeDamage 本身就是"金额尚未定案"的同步时机点，改写 payload.amount
       * 必须在这个事件处理器里当场完成——推迟到技能队列再问，
       * 金额早就已经被读走定案了。所以这里不问"弃哪几张"，
       * 直接弃掉展示出的全部红桃（红桃对减伤只有好处，没有取舍的必要）。
       */
      event: 'BeforeDamage',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (owner.marks[CANGXIN + '-turn'] === host.state.turnNumber) return
        owner.marks[CANGXIN + '-turn'] = host.state.turnNumber
        const bottom = bottomThree(host.state)
        if (bottom.length === 0) return
        host.dispatch('CardMove', { cardIds: bottom, reason: CANGXIN, revealed: true }, { sourceId: ownerId })
        const hearts = bottom.filter((id) => host.state.cards[id]?.suit === 'heart')
        if (hearts.length === 0) return
        for (const cardId of hearts) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: hearts, reason: CANGXIN }, { sourceId: ownerId, cardIds: hearts })
        const payload = context.event.payload as { amount?: number }
        payload.amount = Math.max(0, (typeof payload.amount === 'number' ? payload.amount : 0) - hearts.length)
        host.dispatch('SkillActivated', { skillId: CANGXIN, skillName: '藏心', playerId: ownerId, logText: `${owner.nickname}发动【藏心】，弃${hearts.length}张红桃，伤害-${hearts.length}` }, { sourceId: ownerId })
      },
    },
  ],
})

registerSkillRuntime({
  id: RUNWEI,
  maxCardsBonus(state, ownerId) {
    const entry = state.luyushengRunweiMod
    if (!entry || entry.targetId !== ownerId || entry.phaseInstanceId !== state.discardPhaseLedger?.phaseInstanceId) return 0
    return entry.delta
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'discard' || !payload.playerId) return
      const targetId = payload.playerId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || target.hp >= target.maxHp) return
      host.queueSkill({ skillId: RUNWEI, ownerId, step: 'ask', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    host.askSkill({
      skillId: RUNWEI, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【润微】：选择一项', timeoutMs: 20_000, optional: true,
        options: [{ id: 'draw', label: '令其摸1张牌，本阶段手牌上限-1' }, { id: 'discard', label: '令其弃1张牌，本阶段手牌上限+1' }, { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const optionId = (response.payload as { optionId?: string }).optionId
    if (!owner?.alive || !target?.alive || (optionId !== 'draw' && optionId !== 'discard')) return
    const phaseInstanceId = host.state.discardPhaseLedger?.phaseInstanceId
    if (!phaseInstanceId) return
    host.dispatch('SkillActivated', { skillId: RUNWEI, skillName: '润微', playerId: ownerId, logText: `${owner.nickname}发动【润微】` }, { sourceId: ownerId, targetId })
    if (optionId === 'draw') {
      drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
      host.state.luyushengRunweiMod = { targetId, phaseInstanceId, delta: -1 }
      return
    }
    if (target.zones.hand.length > 0) {
      const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: RUNWEI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    }
    host.state.luyushengRunweiMod = { targetId, phaseInstanceId, delta: 1 }
  },
})

export const LUYUSHENG: CharacterDefinition = {
  id: 'luyusheng',
  name: '陆郁生',
  kingdom: 'wu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: CANGXIN, name: '藏心', description: '锁定技，摸牌阶段开始时展示牌堆底3张，额外摸X张（X=其中红桃数）；每个 TurnInstance 第一次即将受到伤害时，展示牌堆底3张，可以弃置其中任意张，此伤害-X（X=弃置的红桃数，最低为0）。' },
    { id: RUNWEI, name: '润微', description: '任意已受伤角色的弃牌阶段开始时，你可以令其摸1张牌然后本阶段手牌上限-1，或令其弃1张牌然后本阶段手牌上限+1。' },
  ],
}
