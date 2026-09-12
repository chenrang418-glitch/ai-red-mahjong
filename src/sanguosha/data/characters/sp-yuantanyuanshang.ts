import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { lockCardCategory } from '../../engine/card-play-lock'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 袁谭袁尚（三国杀 OL 经典身份 SP）。
 *
 * 【内伐】：出牌阶段开始时可以发动。先选择一项：摸2张牌，或获得场上
 *          （装备区/判定区）一张牌；然后弃置1张牌。若弃的是基本牌：直到
 *          回合结束不能使用锦囊/装备（`lockCardCategory` 复用），【杀】
 *          使用次数上限+X、可额外指定1个目标（`grantTurnSlashBonus` 复用）。
 *          若弃的不是基本牌：直到回合结束不能使用基本牌，本回合前两次
 *          使用装备牌后各摸X张。X 在弃牌完成时按当前手牌结构算好并封顶5，
 *          此后不再随手牌变化重算。
 *
 * 「使用非延时普通锦囊时可以目标+1或-1」这一半本批未实现：现有引擎只有
 * `interceptTarget`（锦囊**目标**一侧的同步拦截点，董允【舍宴】用的就是
 * 这个）没有对称的**使用者**一侧同步拦截点，用普通事件触发器直接
 * `askSkill` 会在真实对局里和锦囊自身的“挑一张牌”结算抢占
 * `cardResolution`（压测已复现崩溃）。补一个源头侧的同步拦截钩子超出本批
 * 最小改动范围，作为已知限制记录，只实现内伐的其余部分。
 */

const NEIFA = 'neifa'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function fieldCardCandidates(state: SanguoshaState): CardId[] {
  const result: CardId[] = []
  for (const player of state.players) {
    if (!player.alive) continue
    result.push(...Object.values(player.zones.equipment).filter((cardId): cardId is CardId => !!cardId))
    result.push(...player.zones.judgingArea)
  }
  return result
}

function locate(state: SanguoshaState, cardId: CardId): { kind: 'equipment'; playerId: PlayerId; slot: string } | { kind: 'judgingArea'; playerId: PlayerId } | null {
  for (const player of state.players) {
    for (const [slot, equipped] of Object.entries(player.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: player.id, slot }
    }
    if (player.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: player.id }
  }
  return null
}

registerSkillRuntime({
  id: NEIFA,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: NEIFA, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const neifa = host.state.neifaState?.[ownerId]
        if (!neifa || neifa.turnNumber !== host.state.turnNumber || neifa.x <= 0 || neifa.equipUseCount >= 2) return
        const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
        if (payload.cancelled || !payload.cardId || host.state.cards[payload.cardId]?.category !== 'equipment') return
        neifa.equipUseCount += 1
        drawCards(host.state, host.rng, ownerId, neifa.x, (name, drawPayload) => { host.dispatch(name, drawPayload) })
        host.dispatch('SkillActivated', { skillId: NEIFA, skillName: '内伐', playerId: ownerId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【内伐】，装备过牌摸${neifa.x}张` }, { sourceId: ownerId })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      host.askSkill({
        skillId: NEIFA, ownerId, step: 'ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【内伐】：是否发动？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'draw', label: '摸2张牌' }, { id: 'gain', label: '获得场上一张牌' }, { id: 'none', label: '不发动' }],
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'none' || !optionId) return
      if (optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
        host.dispatch('SkillActivated', { skillId: NEIFA, skillName: '内伐', playerId: ownerId, logText: `${owner.nickname}发动【内伐】，摸牌` }, { sourceId: ownerId })
        askDiscard(host, ownerId)
        return
      }
      const candidates = fieldCardCandidates(host.state)
      if (candidates.length === 0) { askDiscard(host, ownerId); return }
      host.dispatch('SkillActivated', { skillId: NEIFA, skillName: '内伐', playerId: ownerId, logText: `${owner.nickname}发动【内伐】` }, { sourceId: ownerId })
      host.askSkill({
        skillId: NEIFA, ownerId, step: 'gain-pick', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【内伐】：获得场上一张牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'gain-pick') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const from = cardId ? locate(host.state, cardId) : null
      if (!cardId || !from) { askDiscard(host, ownerId); return }
      if (from.kind === 'equipment') {
        moveCard(host.state, cardId, { kind: 'equipment', playerId: from.playerId, slot: from.slot as never }, { kind: 'hand', playerId: ownerId })
        handleEquipmentLost(host as never, from.playerId, cardId)
      } else {
        moveCard(host.state, cardId, { kind: 'judgingArea', playerId: from.playerId }, { kind: 'hand', playerId: ownerId })
      }
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: NEIFA }, { targetId: ownerId, cardIds: [cardId] })
      askDiscard(host, ownerId)
      return
    }

    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      const isBasic = host.state.cards[cardId]?.category === 'basic'
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: NEIFA }, { sourceId: ownerId, cardIds: [cardId] })
      const branch: 'basic' | 'nonbasic' = isBasic ? 'basic' : 'nonbasic'
      const restrictedCount = owner.zones.hand.filter((handCardId) => {
        const category = host.state.cards[handCardId]?.category
        return branch === 'basic' ? (category === 'trick' || category === 'equipment') : category === 'basic'
      }).length
      const x = Math.min(5, restrictedCount)
      host.state.neifaState ??= {}
      host.state.neifaState[ownerId] = { branch, x, turnNumber: host.state.turnNumber, equipUseCount: 0 }
      if (branch === 'basic') {
        lockCardCategory(host.state, { targetId: ownerId, category: 'trick', sourceId: ownerId, skillId: `${NEIFA}-trick` })
        lockCardCategory(host.state, { targetId: ownerId, category: 'equipment', sourceId: ownerId, skillId: `${NEIFA}-equip` })
        grantTurnSlashBonus(host.state, ownerId, { extraUses: x, extraTargets: 1 })
      } else {
        lockCardCategory(host.state, { targetId: ownerId, category: 'basic', sourceId: ownerId, skillId: `${NEIFA}-basic` })
      }
    }
  },
})

function askDiscard(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || owner.zones.hand.length === 0) return
  host.askSkill({
    skillId: NEIFA, ownerId, step: 'discard', data: {},
    build: (requestId: string): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: '【内伐】：弃置1张牌', timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
}

export const YUANTAN_YUANSHANG: CharacterDefinition = {
  id: 'yuantan_yuanshang',
  name: '袁谭袁尚',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: NEIFA, name: '内伐', description: '出牌阶段开始时可以发动：选择摸2张牌或获得场上一张牌，然后弃置1张牌。弃基本牌：直到回合结束不能使用锦囊/装备，【杀】使用次数上限+X且可额外指定1个目标；弃非基本牌：直到回合结束不能使用基本牌，使用非延时普通锦囊时可以目标+1或-1，本回合前两次使用装备牌各摸X张（X按弃牌时手牌里被限制的牌数计算，封顶5）。' },
  ],
}
