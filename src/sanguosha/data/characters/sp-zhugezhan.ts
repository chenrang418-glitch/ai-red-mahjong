import { moveCard } from '../../engine/zones'
import { revealTopCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 诸葛瞻（三国杀 OL 经典身份 SP）。
 *
 * 【罪论】：诸葛瞻结束阶段，观看牌堆顶3张牌，X为「本回合造成过伤害／
 *          本回合未弃置过牌／当前手牌数全场最少（含并列）」三项满足数量，
 *          获得其中X张，其余放回牌堆顶；X=0时改为诸葛瞻和选定的一名角色
 *          各失去1点体力。
 * 【父荫】：锁定技，每个回合诸葛瞻第一次成为杀/决斗的目标后，若使用者
 *          当前手牌数不小于诸葛瞻，这张牌对诸葛瞻无效——即使第一次没有
 *          满足条件，本回合的次数仍然消耗掉。
 */

const ZUILUN = 'zuilun'
const FUYIN = 'fuyin'
const ZUILUN_DAMAGE_MARK = 'zuilun-damaged-turn'
const ZUILUN_DISCARD_MARK = 'zuilun-discarded-turn'
const FUYIN_USED_MARK = 'fuyin-used-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isHandFewest(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return false
  return state.players.every((candidate) => !candidate.alive || candidate.zones.hand.length >= owner.zones.hand.length)
}

registerSkillRuntime({
  id: ZUILUN,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks[ZUILUN_DAMAGE_MARK] = host.state.turnNumber
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks[ZUILUN_DISCARD_MARK] = host.state.turnNumber
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const conditions = [
          owner.marks[ZUILUN_DAMAGE_MARK] === host.state.turnNumber,
          owner.marks[ZUILUN_DISCARD_MARK] !== host.state.turnNumber,
          isHandFewest(host.state, ownerId),
        ]
        const x = conditions.filter(Boolean).length
        const revealed = revealTopCards(host.state, host.rng, 3, ZUILUN, (name, drawPayload) => { host.dispatch(name, drawPayload) })
        if (revealed.length === 0) return
        host.dispatch('SkillActivated', { skillId: ZUILUN, skillName: '罪论', playerId: ownerId, logText: `${owner.nickname}发动【罪论】，X=${x}` }, { sourceId: ownerId })
        if (x === 0) {
          for (let index = revealed.length - 1; index >= 0; index -= 1) {
            moveCard(host.state, revealed[index], { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
          }
          const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
          if (candidateIds.length === 0) return
          host.queueSkill({ skillId: ZUILUN, ownerId, step: 'punish-target', data: { candidateIds } })
          return
        }
        const gained = revealed.slice(0, Math.min(x, revealed.length))
        const remaining = revealed.slice(gained.length)
        for (const cardId of gained) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        if (gained.length > 0) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: ZUILUN }, { targetId: ownerId, cardIds: gained })
        for (let index = remaining.length - 1; index >= 0; index -= 1) {
          moveCard(host.state, remaining[index], { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
        }
      },
    },
    {
      // X=0 分支：双方各失去 1 点体力。濒死结算期间不能嵌套第二次，
      // 先手那次若触发濒死，这里等濒死真正结束（存活或死亡）再补上另一方。
      event: 'QuitDying',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const pending = host.state.pendingZuilunLoseHp
        if (!pending || pending.ownerId !== ownerId || payload.playerId !== pending.pendingPlayerId) return
        delete host.state.pendingZuilunLoseHp
        // 这一刻 `host.state.dying` 还没被调用方清空（QuitDying 在置空之前派发），
        // 这里不能直接 loseHp——排队等下一次 drainSkillQueue（那时 dying 已清空）再补。
        host.queueSkill({ skillId: ZUILUN, ownerId, step: 'followup-losehp', data: { pendingPlayerId: pending.pendingPlayerId } })
      },
    },
    {
      event: 'Death',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const pending = host.state.pendingZuilunLoseHp
        if (!pending || pending.ownerId !== ownerId || payload.playerId !== pending.pendingPlayerId) return
        delete host.state.pendingZuilunLoseHp
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'followup-losehp') {
      const { pendingPlayerId } = prompt.data as { pendingPlayerId: PlayerId }
      if (playerOf(host.state, pendingPlayerId)?.alive) loseHp(host as never, pendingPlayerId, 1, ZUILUN)
      return
    }
    if (prompt.step !== 'punish-target') return
    if (!playerOf(host.state, ownerId)?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: ZUILUN, ownerId, step: 'punish-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【罪论】：选择一名其他角色，双方各失去1点体力', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'punish-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    // 濒死结算期间不能再嵌套第二次；先手这次若触发濒死，另一方的 LoseHp 记下来，等濒死结算完再补
    loseHp(host as never, targetId!, 1, ZUILUN)
    if (host.state.dying) {
      host.state.pendingZuilunLoseHp = { ownerId, pendingPlayerId: ownerId }
      return
    }
    if (playerOf(host.state, ownerId)?.alive) loseHp(host as never, ownerId, 1, ZUILUN)
  },
})

registerSkillRuntime({
  id: FUYIN,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string }
      if (context.event.targetId !== ownerId || (payload.cardName !== '杀' && payload.cardName !== '决斗')) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.marks[FUYIN_USED_MARK] === host.state.turnNumber) return
      owner.marks[FUYIN_USED_MARK] = host.state.turnNumber
      const sourceId = context.event.sourceId
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      if (source?.alive && sourceId && source.zones.hand.length >= owner.zones.hand.length) {
        host.state.fuyinPending ??= {}
        host.state.fuyinPending[ownerId] = { sourceId, turnNumber: host.state.turnNumber }
      }
    },
  }],

  /**
   * 无副作用的纯查询：引擎在同一次判定里会调用两次（一次决定要不要挡下，
   * 一次找出是哪个技能挡的用来发日志），这里如果在第一次调用时就
   * `delete` 掉 pending，第二次调用会读到空值、日志也就报不出来
   * （规则本身没错，只是少了一行 SkillActivated）。改用 `turnNumber`
   * 让它在本回合内保持一致地返回 true，本回合结束后自然过期，
   * 不需要显式清理。
   */
  cardEffectInvalid(state, ownerId, sourceId, cardName) {
    if (cardName !== '杀' && cardName !== '决斗' || !sourceId) return false
    const pending = state.fuyinPending?.[ownerId]
    return !!pending && pending.sourceId === sourceId && pending.turnNumber === state.turnNumber
  },
})

export const ZHUGEZHAN: CharacterDefinition = {
  id: 'zhugezhan',
  name: '诸葛瞻',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: ZUILUN, name: '罪论', description: '结束阶段，观看牌堆顶3张牌，X为“本回合造成过伤害/本回合未弃置过牌/当前手牌数全场最少”三项满足数量，获得其中X张，其余放回牌堆顶；X=0时改为你和选定的一名角色各失去1点体力。' },
    { id: FUYIN, name: '父荫', description: '锁定技，每个回合你第一次成为杀/决斗的目标后，若使用者当前手牌数不小于你，这张牌对你无效。' },
  ],
}
