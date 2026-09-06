import { handleEquipmentLost } from '../../engine/equipment'
import { redistributeHands } from '../../engine/hand-redistribution'
import { applySeatPermutation, seatOrderWithFixedLord } from '../../engine/seat-permutation'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { moveCard } from '../../engine/zones'
import type { ArrangeOptionsRequest, ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神鲁肃。
 *
 * 【榻谟】：身份局游戏开始时，你可以重新安排除主公外所有角色的座次。
 * 【定州】：出牌阶段限一次，选择一名场上有牌的其他角色，令其场上牌数为 X，
 *   你交给其 X 张手牌，然后获得其场上的所有牌。
 * 【智盟】：你的回合结束后，你可以选择一名其他角色，将双方手牌混合后随机
 *   平均分配（总数为奇数时你多拿一张）。
 *
 * 三个技能各踩一处不同的坑：
 *
 * - 榻谟动的是**座位表本身**，而座位号在这个引擎里同时也是 `players` 的数组下标；
 * - 定州搬的是**场上牌**（装备区 + 判定区），装备离场的时机一个都不能少；
 * - 智盟是**真的重新分牌**，不是补数量差，而且随机必须用牌局自己的种子。
 */

const TAMO = 'tamo'
const DINGZHOU = 'dingzhou'
const ZHIMENG = 'zhimeng'

const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 场上牌 = 装备区 + 判定区。手牌不算。 */
function fieldCardsOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  const equipped = EQUIPMENT_SLOTS
    .map((slot) => player.zones.equipment[slot])
    .filter((cardId): cardId is CardId => !!cardId)
  return [...equipped, ...player.zones.judgingArea]
}

// ─────────────────────────────── 榻谟 ───────────────────────────────

registerSkillRuntime({
  id: TAMO,
  onGameStart(host, ownerId) {
    // 只有身份局有主公，也只有身份局谈得上「除主公外重排」
    if (host.state.setup.mode !== 'identity') return
    const lord = host.state.players.find((candidate) => candidate.identity === 'lord')
    if (!lord) return
    const others = host.state.players.filter((candidate) => candidate.id !== lord.id)
    if (others.length < 2) return
    host.queueSkill({ skillId: TAMO, ownerId, step: 'seat', data: { picked: [] } })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'seat') return
    askSeatOrder(host, ownerId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'seat') return
    const optionIds = (response.payload as { optionIds?: string[] }).optionIds ?? []
    const lord = host.state.players.find((candidate) => candidate.identity === 'lord')
    if (!lord) return
    if (optionIds.length !== host.state.players.length - 1) return
    /*
     * 主公的位置锁死，其余角色按给定顺序依次填进剩下的空位。
     * 不能把这份排列直接当整张座位表——那样主公会被挤走。
     */
    const order = seatOrderWithFixedLord(host.state, lord.id, optionIds)
    applySeatPermutation(host.state, order)
    host.dispatch('SkillActivated', {
      skillId: TAMO, skillName: '榻谟', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【榻谟】，重新安排了座次`,
    }, { sourceId: ownerId })
  },
})

/**
 * 一次定完整张座位表。
 *
 * 用排列请求而不是连问 N 次单选：八人局连问七次，玩家排到第五个时已经
 * 看不到前面排成什么样了，改主意只能等超时；联机时每一步还各要一个网络往返。
 * 排列请求可以边点边看整条座次、可以撤销，只付一次往返，
 * 而且「必须是全排列」由请求层统一校验，双射是天然的。
 */
function askSeatOrder(host: SkillHost, ownerId: PlayerId): void {
  const lord = host.state.players.find((candidate) => candidate.identity === 'lord')
  if (!lord) return
  const others = host.state.players.filter((candidate) => candidate.id !== lord.id)
  if (others.length === 0) return
  host.askSkill({
    skillId: TAMO, ownerId, step: 'seat', data: {},
    build: (requestId): ArrangeOptionsRequest => ({
      id: requestId, kind: 'arrange-options', playerId: ownerId,
      prompt: `【榻谟】：按新的座次顺序点选（${lord.nickname}的位置不变）`,
      timeoutMs: 40_000, optional: true,
      options: others.map((candidate) => ({ id: candidate.id, label: candidate.nickname })),
    }),
  })
}

// ─────────────────────────────── 定州 ───────────────────────────────

/** 定州的合法目标：场上有牌、而且神鲁肃付得起 X 张手牌的其他角色。 */
function dingzhouTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .filter((candidate) => {
      const count = fieldCardsOf(state, candidate.id).length
      // 付不起就不该列为候选：不能让玩家点进去才被告知「牌不够」
      return count >= 1 && owner.zones.hand.length >= count
    })
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: DINGZHOU,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, DINGZHOU)) return []
    if (dingzhouTargets(state, ownerId).length === 0) return []
    return [{ id: DINGZHOU, label: '发动【定州】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== DINGZHOU) return
    const candidateIds = dingzhouTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    if (usedThisTurn(host.state, ownerId, DINGZHOU)) return
    markUsedThisTurn(host.state, ownerId, DINGZHOU)
    host.askSkill({
      skillId: DINGZHOU, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【定州】：选择一名场上有牌的其他角色',
        timeoutMs: 25_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      // 落地前重新验一次：发问期间对方的场上牌可能已经变了
      if (!targetId || !dingzhouTargets(host.state, ownerId).includes(targetId)) return
      const owner = playerOf(host.state, ownerId)!
      const count = fieldCardsOf(host.state, targetId).length
      host.askSkill({
        skillId: DINGZHOU, ownerId, step: 'pay', data: { targetId, count },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【定州】：交给${playerOf(host.state, targetId)?.nickname} ${count} 张手牌`,
          timeoutMs: 30_000, optional: false, purpose: 'skill',
          cardIds: [...owner.zones.hand], hiddenCardSlots: [],
          min: count, max: count,
        }),
      })
      return
    }
    if (resolution.step !== 'pay') return
    const targetId = String(resolution.data.targetId ?? '')
    const count = Number(resolution.data.count ?? 0)
    const paid = (response.payload as { cardIds: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    if (paid.length !== count || !paid.every((cardId) => owner.zones.hand.includes(cardId))) return

    host.dispatch('SkillActivated', {
      skillId: DINGZHOU, skillName: '定州', playerId: ownerId, targetId,
      logText: `${owner.nickname}对${target.nickname}发动【定州】，交出 ${count} 张牌并获得其场上所有牌`,
    }, { sourceId: ownerId, targetId })

    /*
     * 先付后取。
     *
     * 反过来的话，神鲁肃会先拿到对方的装备，那些牌就混进了他的手牌，
     * 「交给其 X 张手牌」有可能把刚拿到的牌又还回去。
     */
    for (const cardId of paid) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
    }
    host.dispatch('GainCard', { playerId: targetId, cardIds: paid, reason: DINGZHOU }, { sourceId: ownerId, targetId, cardIds: paid })

    // 场上牌要在付完之后重新取一遍：付牌过程本身可能改变了对方的场上牌
    const taken: CardId[] = []
    for (const slot of EQUIPMENT_SLOTS) {
      const cardId = target.zones.equipment[slot]
      if (!cardId) continue
      moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'hand', playerId: ownerId })
      // 装备离场走正常路径：白银狮子、枭姬这些效果该触发就触发
      handleEquipmentLost(host as never, targetId, cardId)
      taken.push(cardId)
    }
    for (const cardId of [...target.zones.judgingArea]) {
      moveCard(host.state, cardId, { kind: 'judgingArea', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      taken.push(cardId)
    }
    if (taken.length > 0) {
      host.dispatch('GainCard', { playerId: ownerId, cardIds: taken, reason: DINGZHOU }, { sourceId: ownerId, targetId, cardIds: taken })
    }
  },
})

// ─────────────────────────────── 智盟 ───────────────────────────────

registerSkillRuntime({
  id: ZHIMENG,
  triggers: [{
    /** 自己的回合结束后。 */
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (zhimengTargets(host.state, ownerId).length === 0) return
      host.queueSkill({ skillId: ZHIMENG, ownerId, step: 'target', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const candidateIds = zhimengTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ZHIMENG, ownerId, step: 'target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【智盟】：与哪名角色混合手牌并重新平均分配',
        timeoutMs: 25_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
    if (!targetId || !zhimengTargets(host.state, ownerId).includes(targetId)) return
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const total = owner.zones.hand.length + target.zones.hand.length
    /*
     * **真的重新分牌**，不是补数量差。两人都是三张时结果仍是三比三，
     * 但具体哪三张必须重新随机——这正是这个技能的意义所在。
     * 随机用牌局自己的种子，同一个种子必须走出同一个结果。
     */
    const result = redistributeHands(host.state, host.rng, ownerId, targetId)
    /*
     * 战报只说牌数，**绝不说是哪几张**。
     * 手牌是暗信息，重新分配之后双方各自的手牌同样是暗信息。
     */
    host.dispatch('SkillActivated', {
      skillId: ZHIMENG, skillName: '智盟', playerId: ownerId, targetId,
      logText: `${owner.nickname}对${target.nickname}发动【智盟】，${total} 张手牌重新分配为 ${result.initiatorCards.length} / ${result.targetCards.length}`,
    }, { sourceId: ownerId, targetId })
  },
})

/** 智盟的候选：其他存活角色。双方至少要有一张牌才有意义。 */
function zhimengTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .filter((candidate) => candidate.zones.hand.length + owner.zones.hand.length > 0)
    .map((candidate) => candidate.id)
}

export const SHENLUSU: CharacterDefinition = {
  id: 'shenlusu',
  name: '神·鲁肃',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 3,
  pack: 'god',
  skills: [
    {
      id: TAMO,
      name: '榻谟',
      description: '身份局游戏开始时，你可以重新安排除主公外所有角色的座次。',
    },
    {
      id: DINGZHOU,
      name: '定州',
      description: '出牌阶段限一次，你可以选择一名场上有牌的其他角色，令其场上的牌数为X，你交给其X张手牌，然后获得其场上的所有牌。',
    },
    {
      id: ZHIMENG,
      name: '智盟',
      description: '你的回合结束后，你可以选择一名其他角色，将你与其的手牌混合后随机平均分配（总数为奇数时你多获得一张）。',
    },
  ],
}
