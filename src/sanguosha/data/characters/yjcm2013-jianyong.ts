import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { canPindian, claimPindianCards, registerPindianContinuation, startPindian } from '../../engine/pindian'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { TRICK_CARD_INFO } from '../ruleset-v1/card-info'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

const TRICK_CARD_NAMES = new Set(TRICK_CARD_INFO.map((info) => info.name))

/**
 * 简雍（一将成名 2013）。
 *
 * 【巧说】：出牌阶段开始时，简雍可以与一名角色拼点。若简雍赢，直到本回合结束，
 *          简雍使用的下一张【杀】可以额外选择一个目标（无距离限制）；
 *          若简雍没赢，直到本回合结束，简雍不能使用锦囊牌。
 * 【纵适】：每当简雍拼点，若简雍赢，获得两张拼点牌中点数较小的一张；
 *          若简雍没赢，获得简雍自己的那张拼点牌。
 *
 * 三处最容易做错的：
 *
 * 1. **巧说的加成只影响简雍下一张实际用出去的【杀】**——这里把「额外目标」
 *    落在 `extraSlashTargets` 上，用完（任意一张基本牌或非延时锦囊被使用）
 *    就清掉标记，不会连着影响第二张。
 * 2. **巧说没赢时禁的是锦囊的使用**，不是全部牌；平局按没赢处理。
 * 3. **纵适对任何一次拼点都生效**，不管这次拼点是谁发起的——挂在通用的
 *    `PindianEnd` 时机上，而不是巧说自己注册的续接（那个只在简雍自己发起
 *    「巧说」时才会跑，接不住高顺【陷阵】这类找简雍拼点的情形）。
 */

const QIAOSHUO = 'qiaoshuo'
// 与刘表【宗室】拼音相同，技能 id 不能撞；这里用「纵适」拼音全称避免冲突
const ZONGSHI = 'zongshi-jianyong'
const QIAOSHUO_TAG = 'jianyong-qiaoshuo'

/** 巧说的加成状态：'bonus' 额外一个目标，'malus' 禁止使用锦囊。回合号过期即失效。 */
const MODE_MARK = 'qiaoshuo-mode'
const TURN_MARK = 'qiaoshuo-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function qiaoshuoMode(state: SanguoshaState, ownerId: PlayerId): 'bonus' | 'malus' | null {
  const owner = playerOf(state, ownerId)
  if (!owner || owner.marks[TURN_MARK] !== state.turnNumber) return null
  return owner.marks[MODE_MARK] === 1 ? 'bonus' : owner.marks[MODE_MARK] === 2 ? 'malus' : null
}

function setQiaoshuoMode(state: SanguoshaState, ownerId: PlayerId, mode: 'bonus' | 'malus'): void {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  owner.marks[TURN_MARK] = state.turnNumber
  owner.marks[MODE_MARK] = mode === 'bonus' ? 1 : 2
}

function clearQiaoshuoMode(state: SanguoshaState, ownerId: PlayerId): void {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  delete owner.marks[TURN_MARK]
  delete owner.marks[MODE_MARK]
}

function qiaoshuoTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  if (!canPindian(state, ownerId)) return []
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && canPindian(state, candidate.id))
    .map((candidate) => candidate.id)
}

// ─────────────────────────────── 巧说 ───────────────────────────────

registerSkillRuntime({
  id: QIAOSHUO,
  announcesSelf: true,

  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const candidateIds = qiaoshuoTargets(host.state, ownerId)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: QIAOSHUO, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【巧说】：与一名角色拼点？',
          timeoutMs: 20_000, optional: true,
          candidateIds, min: 1, max: 1,
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !qiaoshuoTargets(host.state, ownerId).includes(targetId)) return
    startPindian(host, {
      id: `qiaoshuo-${host.state.seq}`,
      initiatorId: ownerId,
      opponentId: targetId,
      reason: QIAOSHUO,
      continuationTag: QIAOSHUO_TAG,
    })
  },

  // 巧说赢的那一张【杀】：额外一个目标，且这个额外目标无距离限制
  extraSlashTargets(state, ownerId) {
    return qiaoshuoMode(state, ownerId) === 'bonus' ? 1 : 0
  },
  /*
   * 巧说没赢：本回合不能使用锦囊牌。`prohibitsCardUse` 在
   * `legalPlayActions` 里对**使用**动作统一过滤（不止濒死求牌那一条路），
   * 走这条就不需要另起一套「本回合禁用牌名」的机制。
   */
  prohibitsCardUse(state, ownerId, context) {
    if (context.userId !== ownerId) return false
    if (qiaoshuoMode(state, ownerId) !== 'malus') return false
    return TRICK_CARD_NAMES.has(context.cardName)
  },
})

registerPindianContinuation(QIAOSHUO_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = result.initiatorId
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (result.outcome === 'initiator-win') {
    setQiaoshuoMode(host.state, ownerId, 'bonus')
    skillHost.dispatch('SkillActivated', {
      skillId: QIAOSHUO, skillName: '巧说', playerId: ownerId,
      logText: `${owner.nickname}拼点赢了，本回合下一张【杀】可以额外选择一个目标`,
    }, { sourceId: ownerId })
  } else {
    setQiaoshuoMode(host.state, ownerId, 'malus')
    skillHost.dispatch('SkillActivated', {
      skillId: QIAOSHUO, skillName: '巧说', playerId: ownerId,
      logText: `${owner.nickname}没有拼点赢，本回合不能使用锦囊牌`,
    }, { sourceId: ownerId })
  }
})

/** 消耗巧说的加成/惩罚：简雍使用了下一张符合条件的基本牌或非延时锦囊牌。 */
registerSkillRuntime({
  id: `${QIAOSHUO}-consume`,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      // 没赢的「本回合不能使用锦囊」是持续到回合结束的限制，不因用过一张牌就解除；
      // 只有赢了的「下一张额外目标」才是用一次就消耗掉的一次性加成。
      if (qiaoshuoMode(host.state, ownerId) !== 'bonus') return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const cardName = payload.cardName
      if (!cardName) return
      const category = payload.cardId ? host.state.cards[payload.cardId]?.category : undefined
      const isQualifying = category === 'basic' || (category === 'trick' && !DELAYED_TRICKS.has(cardName))
      if (!isQualifying) return
      clearQiaoshuoMode(host.state, ownerId)
    },
  }],
})

// ─────────────────────────────── 纵适 ───────────────────────────────

registerSkillRuntime({
  id: ZONGSHI,
  triggers: [{
    event: 'PindianEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as {
        initiatorId: PlayerId; opponentId: PlayerId
        initiatorCardId: CardId; opponentCardId: CardId
        initiatorRank: number; opponentRank: number
        outcome: 'initiator-win' | 'opponent-win' | 'tie'
      }
      const isInitiator = payload.initiatorId === ownerId
      const isOpponent = payload.opponentId === ownerId
      if (!isInitiator && !isOpponent) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const won = (isInitiator && payload.outcome === 'initiator-win') || (isOpponent && payload.outcome === 'opponent-win')
      let claimId: CardId
      if (won) {
        claimId = payload.initiatorRank <= payload.opponentRank ? payload.initiatorCardId : payload.opponentCardId
      } else {
        claimId = isInitiator ? payload.initiatorCardId : payload.opponentCardId
      }
      const claimed = claimPindianCards(host as never, ownerId, [claimId])
      if (claimed.length === 0) return
      host.dispatch('SkillActivated', {
        skillId: ZONGSHI, skillName: '纵适', playerId: ownerId, cardIds: claimed,
        logText: `${owner.nickname}发动【纵适】，获得一张拼点牌`,
      }, { sourceId: ownerId, cardIds: claimed })
    },
  }],
})

export const JIANYONG: CharacterDefinition = {
  id: 'jianyong',
  name: '简雍',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2013',
  skills: [
    {
      id: QIAOSHUO,
      name: '巧说',
      description: '出牌阶段开始时，简雍可以与一名角色拼点。若简雍赢，直到本回合结束，简雍使用的下一张【杀】可以额外选择一个目标（无距离限制）；若简雍没赢，直到本回合结束，简雍不能使用锦囊牌。',
    },
    {
      id: ZONGSHI,
      name: '纵适',
      description: '每当简雍拼点，若简雍赢，获得两张拼点牌中点数较小的一张；若简雍没赢，获得简雍自己的那张拼点牌。',
    },
  ],
}
