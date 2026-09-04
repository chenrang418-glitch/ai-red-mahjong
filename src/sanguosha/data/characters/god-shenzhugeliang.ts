import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { DAWU_STATE, KUANGFENG_STATE, applyTargetState } from '../../engine/target-state'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 神诸葛亮。经典「神话再临·神」版本。
 *
 * - **七星**：游戏开始时，将牌堆顶七张牌扣置于你的武将牌上，称为「星」，
 *   并可以用任意数量的手牌交换等量的「星」；此后每个摸牌阶段结束时（摸完牌后），
 *   可以再用任意数量的手牌交换等量的「星」。
 * - **狂风**：结束阶段，你可以移去一张「星」并指定一名角色：
 *   直到你的下回合开始前，该角色每次受到火焰伤害时此伤害 +1。
 * - **大雾**：结束阶段，你可以移去任意张「星」并选择等量角色：
 *   直到你的下回合开始前，防止这些角色受到的非雷电伤害。
 *
 * **经典七星没有「手牌上限 +7」**，「星」也不计入手牌、不影响手牌上限。
 */

export const QIXING = 'qixing'
export const KUANGFENG = 'kuangfeng'
export const DAWU = 'dawu'

/** 「星」这一堆的 key。和技能 id 同名，跟周泰「创」、邓艾「田」同一套约定。 */
export const STAR_PILE = QIXING

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 神诸葛亮武将牌上的「星」。 */
export function starsOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.characterPiles[STAR_PILE] ?? []
}

// ─────────────────────────────── 七星 ───────────────────────────────

/**
 * 问要不要换星。
 *
 * 分两步：先选手牌，再选等量的「星」。两步都答完才**一次性互换**，
 * 中途不产生「失去牌 / 获得牌」的时机。
 */
function askSwapHand(host: SkillHost, ownerId: PlayerId): boolean {
  const owner = playerOf(host.state, ownerId)
  const stars = starsOf(host.state, ownerId)
  if (!owner?.alive || stars.length === 0 || owner.zones.hand.length === 0) return false
  // 已经有别的技能在等回答时不插队；队列会把这次机会挪到牌局干净的时候
  if (host.state.skillResolution) return false
  host.askSkill({
    skillId: QIXING, ownerId, step: 'swap-hand',
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【七星】：选择任意数量的手牌，与等量的「星」交换（现有 ${stars.length} 张星）`,
      timeoutMs: 30_000, optional: true, purpose: 'skill',
      cardIds: [...owner.zones.hand], hiddenCardSlots: [],
      min: 0, max: Math.min(owner.zones.hand.length, stars.length),
    }),
  })
  return true
}

registerSkillRuntime({
  id: QIXING,
  announcesSelf: true,

  /**
   * 游戏开始时把牌堆顶七张**扣置**到武将牌上。
   *
   * 是真实移动，不是复制；这七张牌从此不在牌堆里，计入牌张守恒。
   * 登记进 `hiddenCharacterPiles`，`buildPlayerView` 才知道要对别人裁掉牌面——
   * 别人只看得到张数。
   */
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    owner.hiddenCharacterPiles = [...new Set([...(owner.hiddenCharacterPiles ?? []), STAR_PILE])]
    for (let index = 0; index < 7; index += 1) {
      const cardId = host.state.zones.drawPile[0]
      if (!cardId) break
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: STAR_PILE })
    }
    host.dispatch('SkillActivated', {
      skillId: QIXING, skillName: '七星', playerId: ownerId,
      // 「星」是扣置的，事件里**不能**带具体牌面
      logText: `${owner.nickname}将牌堆顶 ${starsOf(host.state, ownerId).length} 张牌扣置为「星」`,
    }, { sourceId: ownerId })
    /*
     * 开局的第一次换星要走**延后队列**，不能当场发问。
     *
     * `onGameStart` 是所有人依次初始化技能资源的地方（左慈化身也在这里），
     * 当场 `askSkill` 会和别人的初始化撞上「已有技能正在等待回应」。
     */
    host.queueSkill({ skillId: QIXING, ownerId, step: 'offer', data: {} })
  },

  triggers: [{
    /**
     * 摸牌阶段**结束时**（摸完牌之后）再给一次换星机会。
     *
     * 不是摸牌阶段开始前——那是另一个版本的写法。
     */
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      host.queueSkill({ skillId: QIXING, ownerId, step: 'offer', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    askSwapHand(host, ownerId)
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'swap-hand') {
      const handCards = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      if (handCards.length === 0) return
      const stars = starsOf(host.state, ownerId)
      if (stars.length < handCards.length) return
      host.askSkill({
        skillId: QIXING, ownerId, step: 'swap-star', data: { handCards },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【七星】：选择 ${handCards.length} 张「星」换入手牌`,
          timeoutMs: 30_000, optional: false, purpose: 'skill',
          // 「星」只有他自己看得到，这条请求也只发给他
          cardIds: [...stars], hiddenCardSlots: [],
          min: handCards.length, max: handCards.length,
        }),
      })
      return
    }

    if (resolution.step === 'swap-star') {
      const handCards = (resolution.data.handCards as CardId[]) ?? []
      const starCards = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const stars = starsOf(host.state, ownerId)
      // 落地前重新验一次：数量要等，两边的牌也都得还在原处
      if (handCards.length !== starCards.length) return
      if (!handCards.every((cardId) => owner.zones.hand.includes(cardId))) return
      if (!starCards.every((cardId) => stars.includes(cardId))) return

      /*
       * **原子交换**：先把手牌搬进星堆，再把选中的星搬进手牌。
       *
       * 这是七星技能内部的交换，**不是弃置 / 获得 / 被拿走**，所以
       * 全程不派发 `LoseCard` / `GainCard`——否则屯田、枭姬、行殇、固政
       * 这些「失去 / 获得牌」的技能会被错误触发。
       */
      for (const cardId of handCards) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: STAR_PILE })
      }
      for (const cardId of starCards) {
        moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: STAR_PILE }, { kind: 'hand', playerId: ownerId })
      }
      host.dispatch('SkillActivated', {
        skillId: QIXING, skillName: '七星', playerId: ownerId,
        // 换了几张是公开的，换的是哪几张不是
        logText: `${owner.nickname}发动【七星】，用 ${handCards.length} 张手牌交换等量的「星」`,
      }, { sourceId: ownerId })
    }
  },
})

// ────────────────────────── 狂风 / 大雾 ──────────────────────────

/** 结束阶段的公共入口：移去若干「星」，给若干角色挂状态。 */
function askStarState(
  host: SkillHost,
  ownerId: PlayerId,
  skillId: string,
  label: string,
  maxTargets: number,
): boolean {
  const stars = starsOf(host.state, ownerId)
  const others = host.state.players.filter((player) => player.alive)
  if (stars.length === 0 || others.length === 0) return false
  // 狂风和大雾挂在同一个结束阶段，前一个还在等回答时不插队
  if (host.state.skillResolution) return false
  host.askSkill({
    skillId, ownerId, step: 'stars',
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【${label}】：移去「星」（现有 ${stars.length} 张）`,
      timeoutMs: 20_000, optional: true, purpose: 'skill',
      cardIds: [...stars], hiddenCardSlots: [],
      min: 0, max: Math.min(stars.length, maxTargets, others.length),
    }),
  })
  return true
}

/** 移去选中的「星」——真实移动到弃牌堆，Card ID 不变。 */
function removeStars(host: SkillHost, ownerId: PlayerId, cardIds: CardId[]): void {
  for (const cardId of cardIds) {
    if (!starsOf(host.state, ownerId).includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: STAR_PILE }, { kind: 'discardPile' })
  }
}

registerSkillRuntime({
  id: KUANGFENG,
  announcesSelf: true,

  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      host.queueSkill({ skillId: KUANGFENG, ownerId, step: 'offer', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    // 狂风只移去一张星、只指定一名角色
    askStarState(host, ownerId, KUANGFENG, '狂风', 1)
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'stars') {
      const cardIds = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      if (cardIds.length !== 1) return
      const candidateIds = host.state.players.filter((player) => player.alive).map((player) => player.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: KUANGFENG, ownerId, step: 'target', data: { cardIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【狂风】：令一名角色受到的火焰伤害 +1（直到你的下回合开始前）',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const cardIds = (resolution.data.cardIds as CardId[]) ?? []
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      removeStars(host, ownerId, cardIds)
      applyTargetState(host.state, targetId, KUANGFENG_STATE, ownerId, KUANGFENG)
      host.dispatch('SkillActivated', {
        skillId: KUANGFENG, skillName: '狂风', playerId: ownerId, targetIds: [targetId],
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【狂风】，${playerOf(host.state, targetId)?.nickname}受到的火焰伤害 +1`,
      }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: DAWU,
  announcesSelf: true,

  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      host.queueSkill({ skillId: DAWU, ownerId, step: 'offer', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    // 大雾可以移去任意张星，指定等量角色
    askStarState(host, ownerId, DAWU, '大雾', host.state.players.filter((player) => player.alive).length)
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'stars') {
      const cardIds = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      if (cardIds.length === 0) return
      const candidateIds = host.state.players.filter((player) => player.alive).map((player) => player.id)
      if (candidateIds.length < cardIds.length) return
      host.askSkill({
        skillId: DAWU, ownerId, step: 'targets', data: { cardIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【大雾】：选择 ${cardIds.length} 名角色，防止其受到的非雷电伤害（直到你的下回合开始前）`,
          timeoutMs: 20_000, optional: false,
          candidateIds, min: cardIds.length, max: cardIds.length,
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const cardIds = (resolution.data.cardIds as CardId[]) ?? []
      const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      if (targetIds.length !== cardIds.length) return
      removeStars(host, ownerId, cardIds)
      for (const targetId of targetIds) {
        if (!playerOf(host.state, targetId)?.alive) continue
        applyTargetState(host.state, targetId, DAWU_STATE, ownerId, DAWU)
      }
      host.dispatch('SkillActivated', {
        skillId: DAWU, skillName: '大雾', playerId: ownerId, targetIds,
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【大雾】，防止 ${targetIds.length} 名角色受到的非雷电伤害`,
      }, { sourceId: ownerId })
    }
  },
})

export const SHENZHUGELIANG: CharacterDefinition = {
  id: 'shenzhugeliang',
  name: '神·诸葛亮',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 3,
  pack: 'god',
  skills: [
    {
      id: QIXING,
      name: '七星',
      description: '游戏开始时，你将牌堆顶七张牌扣置于你的武将牌上，称为「星」，并可以用任意数量的手牌交换等量的「星」；此后每个摸牌阶段结束时，你可以用任意数量的手牌交换等量的「星」。',
    },
    {
      id: KUANGFENG,
      name: '狂风',
      description: '结束阶段，你可以移去一张「星」并指定一名角色：直到你的下回合开始前，该角色每次受到火焰伤害时，此伤害+1。',
    },
    {
      id: DAWU,
      name: '大雾',
      description: '结束阶段，你可以移去X张「星」并选择X名角色：直到你的下回合开始前，防止这些角色受到的非雷电伤害。',
    },
  ],
}
