import { skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { EquipmentSlot, SanguoshaState } from './types'
import { assertCardConservation } from './zones'
import { huashenEligibleSkills } from './huashen'

const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

/** 用于单测、无头压测和服务端提交后的完整状态校验。 */
export function assertGameInvariants(state: SanguoshaState): void {
  if (state.players.length < 5 || state.players.length > 8) throw new Error('身份局玩家数量必须为 5～8')
  if (new Set(state.players.map((player) => player.id)).size !== state.players.length) throw new Error('玩家 id 不唯一')
  const seats = state.players.map((player) => player.seat).sort((left, right) => left - right)
  if (seats.some((seat, index) => seat !== index)) throw new Error('玩家座次必须连续且唯一')
  if (!state.players.some((player) => player.id === state.currentPlayerId)) throw new Error('当前玩家不存在')

  for (const candidate of state.players) {
    /*
     * 体力上限允许为 0。
     *
     * 规则上「体力上限降为 0」就是死亡（董卓【崩坏】一直选减上限能走到这一步），
     * 这时候体力也是 0、角色进濒死然后阵亡——这是一个合法的终局状态，
     * 不是坏数据。**负数**才是真的错。
     */
    if (!Number.isInteger(candidate.hp) || !Number.isInteger(candidate.maxHp) || candidate.maxHp < 0 || candidate.hp > candidate.maxHp) {
      throw new Error(`玩家体力非法：${candidate.id}`)
    }
    if (!candidate.alive && !candidate.identityRevealed) throw new Error(`死亡角色身份未公开：${candidate.id}`)
    // 「存活 + 非正体力 + 不在濒死」正常情况下是坏状态，唯一的例外是
    // 明确声明了自己撑得住的锁定技（周泰【不屈】）。例外走 survivesAtZeroHp
    // 这个统一入口，**不在这里写武将 id 特判**。
    const survivesAtZero = candidate.characterId
      ? skillsOf(state, candidate.id, skillIdsOf).some((runtime) => runtime.survivesAtZeroHp?.(state, candidate.id))
      : false
    const suspendedDyingPlayerId = state.guhuoResponse?.suspendedDying?.playerId
    if (candidate.alive && candidate.hp <= 0 && state.dying?.playerId !== candidate.id
      && suspendedDyingPlayerId !== candidate.id && !survivesAtZero) {
      throw new Error(`存活角色处于非濒死的非正体力：${candidate.id}`)
    }
    for (const slot of EQUIPMENT_SLOTS) {
      const cardId = candidate.zones.equipment[slot]
      if (cardId && state.cards[cardId]?.equipmentSlot !== slot) throw new Error(`装备槽类型不匹配：${candidate.id}/${slot}`)
    }
  }

  const requestIds = state.pendingRequests.map((request) => request.id)
  if (new Set(requestIds).size !== requestIds.length) throw new Error('Request id 不唯一')
  for (const request of state.pendingRequests) {
    if (!state.players.some((candidate) => candidate.id === request.playerId && candidate.alive)) throw new Error(`Request 响应玩家非法：${request.id}`)
  }
  /*
   * 每个待回答的「打出牌」请求都必须有主。
   *
   * 无主的请求意味着某个结算状态被覆盖掉了，而请求还挂在那里：玩家点下去
   * 只会收到「卡牌响应 Request 已经过期」，整局就此卡死。青龙偃月刀的追杀
   * 覆盖多目标【杀】就是这么翻的车，约一千局出一次，靠肉眼根本看不出来。
   * 放在不变量里，以后任何一条路径犯同样的错都会在压测里当场暴露。
   */
  const claimedRequestIds = new Set<string>()
  const resolution = state.cardResolution as { requestId?: string | null; effect?: { requestId?: string | null } } | null
  for (const id of [resolution?.requestId, resolution?.effect?.requestId, (state.judgment as { requestId?: string | null } | null)?.requestId, state.skillResolution?.requestId]) {
    if (id) claimedRequestIds.add(id)
  }
  for (const request of state.pendingRequests) {
    if (request.kind !== 'respond-card') continue
    if (!claimedRequestIds.has(request.id)) throw new Error(`无主的卡牌响应 Request：${request.id}`)
  }

  if (state.dying) {
    const target = state.players.find((candidate) => candidate.id === state.dying!.playerId)
    if (!target?.alive || target.hp > 0) throw new Error('DyingState 与目标状态不一致')
    if (state.dying.requestId && !state.pendingRequests.some((request) => request.id === state.dying!.requestId && request.kind === 'rescue')) {
      throw new Error('DyingState 指向不存在的救援 Request')
    }
  } else if (state.pendingRequests.some((request) => request.kind === 'rescue')) {
    throw new Error('存在救援 Request 但没有 DyingState')
  }
  if (state.damageChain) {
    if (state.damageChain.amount <= 0) throw new Error('属性伤害传导参数非法')
    if (new Set(state.damageChain.remainingTargetIds).size !== state.damageChain.remainingTargetIds.length) throw new Error('属性伤害传导目标重复')
    if (state.damageChain.remainingTargetIds.some((id) => !state.players.some((candidate) => candidate.id === id))) throw new Error('属性伤害传导目标不存在')
  }
  if (state.judgment) {
    if (!state.zones.processingArea.includes(state.judgment.delayedCardId)) throw new Error('结算中的延时锦囊不在处理区')
    if (state.judgment.stage === 'awaiting-nullification') {
      const requestId = state.judgment.requestId
      if (!state.pendingRequests.some((request) => request.id === requestId && request.kind === 'respond-card')) throw new Error('延时锦囊缺少无懈响应 Request')
    }
  }
  for (const zone of state.privateZones ?? []) {
    // 私有区的主人必须真实存在：主人没了还留着区，牌就永远拿不回来
    if (!state.players.some((candidate) => candidate.id === zone.ownerId)) {
      throw new Error(`私有牌区的主人不存在：${zone.id}`)
    }
  }
  const pindian = state.pindian
  if (pindian && pindian.stage === 'selecting') {
    // 还没交牌的那一方必须挂着请求；已经交了的那张必须在他自己的私有区里
    for (const [playerId, cardId] of [[pindian.initiatorId, pindian.initiatorCardId], [pindian.opponentId, pindian.opponentCardId]] as const) {
      const zone = (state.privateZones ?? []).find((candidate) => candidate.id === `pindian:${pindian.id}:${playerId}`)
      if (cardId) {
        if (!zone?.cards.includes(cardId)) throw new Error(`拼点已选的牌不在私有区：${playerId}`)
        if (zone.ownerId !== playerId) throw new Error(`拼点私有区的主人不对：${playerId}`)
      } else {
        const requestId = pindian.requestIds[playerId]
        if (!state.pendingRequests.some((request) => request.id === requestId && request.kind === 'choose-cards')) {
          throw new Error(`拼点缺少对应的选牌 Request：${playerId}`)
        }
      }
    }
  }
  if (state.pindianSettlement) {
    if (state.pindian) throw new Error('拼点选牌与牌去向结算不能同时存在')
    if (state.pindianSettlement.cardIds.length !== 2
      || state.pindianSettlement.cardIds.some((cardId) => !state.zones.processingArea.includes(cardId))) {
      throw new Error('待结算的拼点牌不完整或不在处理区')
    }
  }
  const decision = state.groupDecision
  if (decision) {
    // 已经收齐还挂着，说明续接没跑；参与者不存在说明状态是脏的
    const waiting = decision.playerIds.filter((playerId) => decision.responses[playerId] === undefined)
    if (waiting.length === 0) throw new Error('多人决定已经收齐却没有结束')
    for (const playerId of waiting) {
      if (!state.players.some((candidate) => candidate.id === playerId)) {
        throw new Error(`多人决定的参与者不存在：${playerId}`)
      }
      const requestId = decision.requestIds[playerId]
      if (!state.pendingRequests.some((request) => request.id === requestId)) {
        throw new Error(`多人决定缺少对应的 Request：${playerId}`)
      }
    }
  }
  if (state.retrial) {
    // 改判窗口开着时，判定牌必须还在处理区，而且一定挂着一个改判 Request——
    // 少了任何一项都说明判定卡在半路，牌局会静默停住
    if (!state.zones.processingArea.includes(state.retrial.judgeCardId)) throw new Error('改判中的判定牌不在处理区')
    const requestId = state.retrial.requestId
    if (!state.pendingRequests.some((request) => request.id === requestId && request.kind === 'choose-cards' && request.purpose === 'retrial')) {
      throw new Error('改判窗口缺少对应的 Request')
    }
  }
  if (state.judgmentRetention) {
    /*
     * 暂存中的判定牌必须还在处理区，而且不能重复收同一张。
     * 漏在别的区域说明有人把它当普通判定牌处理掉了，
     * 之后「统一交给某人」就会凭空多牌或少牌。
     */
    const retained = state.judgmentRetention.cardIds
    for (const cardId of retained) {
      if (!state.zones.processingArea.includes(cardId)) throw new Error(`暂存的判定牌不在处理区：${cardId}`)
    }
    if (new Set(retained).size !== retained.length) throw new Error('同一张判定牌被暂存了多次')
    if (state.judgmentRetention.suits.length !== retained.length) throw new Error('暂存判定牌与花色记录数量对不上')
  }
  for (const forced of state.forcedAwakenings ?? []) {
    // 已经觉醒过还留着放行记录，说明清理漏了；留着会让下一次判断读到过期状态
    const owner = state.players.find((candidate) => candidate.id === forced.playerId)
    if (owner?.awakenedSkills?.includes(forced.skillId)) {
      throw new Error(`已经觉醒的技能仍留着强制觉醒记录：${forced.playerId}/${forced.skillId}`)
    }
  }
  if (state.turnUsage.slashUses < 0 || state.turnUsage.wineUses < 0 || state.turnUsage.wineDamageBonus < 0) throw new Error('回合用牌计数非法')
  if (state.cardResolution) {
    if (!state.zones.processingArea.includes(state.cardResolution.cardId)) throw new Error('结算中的实体牌不在处理区')
    const stage = state.cardResolution.stage
    /*
     * 结算被**合法地停住**的几种情况，这时候它身上没有请求是正常的：
     * 判定进行中（八卦阵、铁骑）、改判窗口开着（鬼才、鬼道）、
     * 正在收多人决定（于吉【蛊惑】的质疑），或者正在拼点。
     * 不排除这几种，「八卦阵判定 + 有人能改判」就会误报成坏状态。
     */
    const parked = Boolean(state.judgment || state.retrial || state.groupDecision || state.pindian || state.pindianSettlement)
    // 「成为目标时」那一步挂的是技能 Request，不是求闪 Request
    if (parked) {
      // 停住期间不检查请求，等结算继续时再查
    } else if (stage === 'awaiting-intercept') {
      if (!state.skillResolution) throw new Error('成为目标阶段缺少技能等待状态')
    } else if (stage === 'awaiting-dodge' || stage === 'awaiting-nullification') {
      if (!state.cardResolution.requestId || !state.pendingRequests.some((request) => request.id === state.cardResolution!.requestId && request.kind === 'respond-card')) {
        throw new Error('卡牌结算缺少响应 Request')
      }
    } else if (stage === 'awaiting-dying' && state.cardResolution.requestId) {
      throw new Error('等待濒死结算时不应保留卡牌响应 Request')
    }
    // awaiting-effect 期间可以挂着请求（南蛮要杀、决斗轮流出杀、拆桥选牌），
    // 也可以没有请求（伤害刚结算完、正等着推进下一个目标），两种都合法。
  } else {
    // 判定阶段的无懈请求挂在 state.judgment 上，不属于 cardResolution，要排除掉。
    // JudgmentState 是联合类型，只有等待无懈那一支才有 requestId。
    const judgmentRequestId = state.judgment?.stage === 'awaiting-nullification' ? state.judgment.requestId : null
    const skillRequestId = state.skillResolution?.requestId ?? null
    if (state.pendingRequests.some((request) => request.kind === 'respond-card' && request.id !== judgmentRequestId && request.id !== skillRequestId)) {
      throw new Error('存在卡牌响应 Request 但没有结算状态')
    }
  }

  if (state.skillResolution) {
    const { requestId, ownerId } = state.skillResolution
    if (!state.pendingRequests.some((request) => request.id === requestId)) throw new Error('技能等待状态指向不存在的 Request')
    if (!state.players.some((player) => player.id === ownerId)) throw new Error('技能等待状态的拥有者不存在')
  }

  for (const prompt of state.skillQueue) {
    if (!state.players.some((player) => player.id === prompt.ownerId)) throw new Error('排队技能的拥有者不存在')
  }

  if (state.huashen) {
    const remaining = state.huashen.remainingCharacterIds
    const owned = Object.values(state.huashen.owners).flatMap((owner) => owner.characterIds)
    if (new Set(remaining).size !== remaining.length || new Set(owned).size !== owned.length) throw new Error('化身牌池存在重复武将')
    if (remaining.some((characterId) => owned.includes(characterId))) throw new Error('化身剩余牌池与已持有化身重叠')
    const seated = new Set(state.players.map((player) => player.characterId).filter(Boolean))
    if ([...remaining, ...owned].some((characterId) => seated.has(characterId))) throw new Error('化身牌池包含本局已上场武将')
    for (const [playerId, owner] of Object.entries(state.huashen.owners)) {
      if (!state.players.some((player) => player.id === playerId && player.characterId === 'zuoci')) throw new Error(`化身拥有者非法：${playerId}`)
      if ((owner.activeCharacterId === null) !== (owner.activeSkillId === null)) throw new Error(`化身公开武将与技能状态不一致：${playerId}`)
      if (owner.activeCharacterId && !owner.characterIds.includes(owner.activeCharacterId)) throw new Error(`当前化身不属于拥有者：${playerId}`)
      if (owner.activeCharacterId && owner.activeSkillId
        && !huashenEligibleSkills(owner.activeCharacterId).some((skill) => skill.id === owner.activeSkillId)) {
        throw new Error(`当前化身技能不合法：${playerId}/${owner.activeSkillId}`)
      }
      const temporary = state.players.find((player) => player.id === playerId)?.temporaryGrantedSkills
        .filter((entry) => entry.source === `huashen:${playerId}`) ?? []
      if (owner.activeSkillId && (temporary.length !== 1 || temporary[0].skillId !== owner.activeSkillId)) throw new Error(`化身临时技能记账不一致：${playerId}`)
    }
  }

  if (state.status === 'game-over' && (!state.result || state.pendingRequests.length > 0)) throw new Error('结束状态缺少结果或仍有 Request')
  if (state.status !== 'game-over' && state.result) throw new Error('未结束牌局不应存在胜负结果')
  assertCardConservation(state)
}
