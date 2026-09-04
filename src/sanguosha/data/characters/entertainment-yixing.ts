import type { LegalAction } from '../../engine/actions'
import { executeUseCardAction } from '../../engine/cards/basic'
import { beginPhysicalCard, finishPhysicalCard } from '../../engine/cards/host'
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, QueuedSkillPrompt, SanguoshaState } from '../../engine/types'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import type { CharacterDefinition } from './types'

const LIGUI = 'ligui'
const XINZHENG = 'xinzheng'
const RULE = 'ligui:rule'
const ROUND = 'ligui:round'
const AFFECTED_COUNT = 'ligui:affected-count'
const RESENTMENT = 'xinzheng:resentment'
const ANGER_ACTIVE = 'xinzheng:anger-active'
const ANGER_QUEUED = 'xinzheng:anger-queued'

const RULE_NONE = 0
const RULE_WINE = 1
const RULE_LIMIT = 2
const RULE_STUDY = 3

const affectedKey = (playerId: PlayerId) => `ligui:affected:${playerId}`
const studyKey = (ownerId: PlayerId) => `ligui:study:${ownerId}`
const playCountKey = (ownerId: PlayerId) => `ligui:play-count:${ownerId}`
const playBlockedKey = (ownerId: PlayerId) => `ligui:play-blocked:${ownerId}`
const angerPendingKey = (playerId: PlayerId) => `xinzheng:anger-pending:${playerId}`
const angerAttackerKey = (playerId: PlayerId) => `xinzheng:anger-attacker:${playerId}`

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) throw new Error(`玩家不存在：${playerId}`)
  return player
}

function isRoundStart(state: SanguoshaState, playerId: PlayerId): boolean {
  return state.players.reduce((seat, player) => Math.min(seat, player.seat), Number.MAX_SAFE_INTEGER)
    === playerOf(state, playerId).seat
}

function discardableIds(state: SanguoshaState, playerId: PlayerId, excluded: readonly CardId[] = []): CardId[] {
  const player = playerOf(state, playerId)
  const excludedSet = new Set(excluded)
  return [
    ...player.zones.hand,
    ...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id)),
  ].filter((id) => !excludedSet.has(id))
}

function discardForRule(host: SkillHost, playerId: PlayerId, cardId: CardId, reason: string): boolean {
  const from = locateOwnedCard(host.state, playerId, cardId)
  if (!from || from.kind === 'judgingArea') return false
  moveCard(host.state, cardId, from, { kind: 'discardPile' })
  if (from.kind === 'equipment') handleEquipmentLost(host, playerId, cardId)
  host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason }, { sourceId: playerId, cardIds: [cardId] })
  return true
}

function queueAnger(host: SkillHost, ownerId: PlayerId, kind: 'start' | 'next'): void {
  const owner = playerOf(host.state, ownerId)
  if (owner.marks[ANGER_QUEUED]) return
  owner.marks[ANGER_QUEUED] = 1
  host.queueSkill({ skillId: XINZHENG, ownerId, step: 'anger', data: { kind } })
}

function recordAffected(host: SkillHost, ownerId: PlayerId, actorId: PlayerId, reason: string): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner.alive || actorId === ownerId || owner.identity !== 'lord') return
  if (owner.marks[affectedKey(actorId)]) return
  owner.marks[affectedKey(actorId)] = owner.marks[ROUND] ?? 1
  const next = (owner.marks[AFFECTED_COUNT] ?? 0) + 1
  owner.marks[AFFECTED_COUNT] = next % 3
  host.dispatch('SkillActivated', {
    playerId: ownerId, skillId: LIGUI, skillName: '立规', result: 'affected', affectedPlayerId: actorId, reason,
    logText: `${playerOf(host.state, actorId).nickname}受到【立规】影响`,
  }, { sourceId: ownerId, targetId: actorId })
  if (next < 3) return
  const resentment = Math.min(3, (owner.marks[RESENTMENT] ?? 0) + 1)
  owner.marks[RESENTMENT] = resentment
  host.dispatch('SkillActivated', {
    playerId: ownerId, skillId: XINZHENG, skillName: '新政', result: 'resentment', resentment,
    logText: `众人怨气渐生，${owner.nickname}获得1枚【怨】`,
  }, { sourceId: ownerId })
  if (resentment === 3 && !owner.marks[ANGER_ACTIVE]) queueAnger(host, ownerId, 'start')
}

function consumeInvalidWine(
  host: SkillHost,
  ownerId: PlayerId,
  action: Extract<LegalAction, { kind: 'use-card' }>,
  countsAsLigui: boolean,
): void {
  const [cardId] = action.cardIds
  const source = locateOwnedCard(host.state, action.playerId, cardId)
  if (!source || source.kind === 'judgingArea') return
  if (beginPhysicalCard(host, action.playerId, cardId, action.targetIds, '酒', source)) {
    finishPhysicalCard(host, action.playerId, cardId, action.targetIds, true, '酒')
  }
  if (countsAsLigui) recordAffected(host, ownerId, action.playerId, '禁酒未弃牌')
}

function resetRound(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  owner.marks[ROUND] = (owner.marks[ROUND] ?? 0) + 1
  owner.marks[RULE] = RULE_NONE
  owner.marks[AFFECTED_COUNT] = 0
  for (const key of Object.keys(owner.marks)) {
    if (key.startsWith('ligui:affected:')) delete owner.marks[key]
  }
  for (const player of host.state.players) {
    delete player.marks[studyKey(ownerId)]
    delete player.marks[playCountKey(ownerId)]
    delete player.marks[playBlockedKey(ownerId)]
  }
  host.queueSkill({ skillId: LIGUI, ownerId, step: 'choose-rule', data: { round: owner.marks[ROUND] } })
}

function startStudyDiscard(host: SkillHost, ownerId: PlayerId, prompt: QueuedSkillPrompt): void {
  const actorId = String(prompt.data.actorId ?? '')
  const actor = host.state.players.find((candidate) => candidate.id === actorId)
  const owner = playerOf(host.state, ownerId)
  if (!actor?.alive || owner.marks[RULE] !== RULE_STUDY || Number(prompt.data.round) !== owner.marks[ROUND]) return
  const cardIds = discardableIds(host.state, actorId)
  if (cardIds.length === 0) return
  host.askSkill({
    skillId: LIGUI,
    ownerId,
    step: 'study-discard',
    data: { actorId, round: owner.marks[ROUND] },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: actorId,
      prompt: '【静习】：弃置一张牌', timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: LIGUI,
  announcesSelf: true,
  interceptPlayAction(host, ownerId, action) {
    if (action.asCardName !== '酒' || action.playerId === ownerId) return false
    const owner = playerOf(host.state, ownerId)
    const actor = playerOf(host.state, action.playerId)
    const regulation = owner.marks[RULE] === RULE_WINE
    const shanshuiSuppression = owner.identity === 'lord' && actor.characterId === 'shanshui'
    if (!regulation && !shanshuiSuppression) return false
    const cardIds = discardableIds(host.state, actor.id, action.cardIds)
    if (cardIds.length === 0) {
      consumeInvalidWine(host, ownerId, action, regulation)
      return true
    }
    host.askSkill({
      skillId: LIGUI,
      ownerId,
      step: 'wine-cost',
      data: { action: structuredClone(action), actorId: actor.id, regulation },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: actor.id,
        prompt: '使用【酒】须额外弃置一张牌；不弃则此【酒】无效', timeoutMs: 20_000,
        optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
    return true
  },
  prohibitsCardUse(state, ownerId, context) {
    if (context.dyingPlayerId || context.userId === ownerId) return false
    return state.phase === 'play' && state.currentPlayerId === context.userId
      && playerOf(state, context.userId).marks[playBlockedKey(ownerId)] === state.turnNumber
  },
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const playerId = String((context.event.payload as { playerId?: unknown }).playerId ?? '')
        if (isRoundStart(host.state, playerId)) resetRound(host, ownerId)
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        if (!sourceId || sourceId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner.marks[RULE] === RULE_LIMIT && host.state.phase === 'play' && host.state.currentPlayerId === sourceId) {
          const actor = playerOf(host.state, sourceId)
          const key = playCountKey(ownerId)
          actor.marks[key] = (actor.marks[key] ?? 0) + 1
          if (actor.marks[key] === 3) {
            actor.marks[playBlockedKey(ownerId)] = host.state.turnNumber
            recordAffected(host, ownerId, sourceId, '限行')
          }
        }
        if (owner.marks[RULE] === RULE_STUDY && host.state.currentPlayerId !== sourceId) {
          const actor = playerOf(host.state, sourceId)
          const key = studyKey(ownerId)
          if (actor.marks[key] === host.state.turnNumber) return
          actor.marks[key] = host.state.turnNumber
          host.queueSkill({ skillId: LIGUI, ownerId, step: 'study-discard', data: { actorId: sourceId, round: owner.marks[ROUND] } })
        }
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        const owner = playerOf(host.state, ownerId)
        if (!sourceId || sourceId === ownerId || owner.marks[RULE] !== RULE_STUDY || host.state.currentPlayerId === sourceId) return
        const actor = playerOf(host.state, sourceId)
        const key = studyKey(ownerId)
        if (actor.marks[key] === host.state.turnNumber) return
        actor.marks[key] = host.state.turnNumber
        host.queueSkill({ skillId: LIGUI, ownerId, step: 'study-discard', data: { actorId: sourceId, round: owner.marks[ROUND] } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'study-discard') {
      startStudyDiscard(host, ownerId, prompt)
      return
    }
    if (prompt.step !== 'choose-rule') return
    const owner = playerOf(host.state, ownerId)
    if (!owner.alive || Number(prompt.data.round) !== owner.marks[ROUND]) return
    host.askSkill({
      skillId: LIGUI, ownerId, step: 'choose-rule', data: { round: owner.marks[ROUND] },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【立规】：选择本轮规定', timeoutMs: 25_000, optional: false,
        options: [
          { id: 'wine', label: '禁酒' }, { id: 'limit', label: '限行' },
          { id: 'study', label: '静习' }, { id: 'none', label: '不立规' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'choose-rule') {
      if (Number(resolution.data.round) !== owner.marks[ROUND]) return
      const option = (response.payload as { optionId: string }).optionId
      owner.marks[RULE] = option === 'wine' ? RULE_WINE : option === 'limit' ? RULE_LIMIT : option === 'study' ? RULE_STUDY : RULE_NONE
      const label = option === 'wine' ? '禁酒' : option === 'limit' ? '限行' : option === 'study' ? '静习' : null
      host.dispatch('SkillActivated', {
        playerId: ownerId, skillId: LIGUI, skillName: '立规', result: label ? 'rule' : 'none', rule: label,
        logText: label ? `${owner.nickname}制定了【${label}】` : `${owner.nickname}本轮未制定规定`,
      }, { sourceId: ownerId })
      return
    }
    if (resolution.step === 'wine-cost') {
      const action = resolution.data.action as Extract<LegalAction, { kind: 'use-card' }>
      const selected = (response.payload as { cardIds: CardId[] }).cardIds
      const paid = selected.length === 1 && discardForRule(host, action.playerId, selected[0], LIGUI)
      if (paid) {
        if (Boolean(resolution.data.regulation)) recordAffected(host, ownerId, action.playerId, '禁酒弃牌')
        executeUseCardAction(host, action.playerId, action, { skipPlayInterceptors: true })
      } else consumeInvalidWine(host, ownerId, action, Boolean(resolution.data.regulation))
      return
    }
    if (resolution.step === 'study-discard') {
      const actorId = String(resolution.data.actorId ?? '')
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      if (cardId && discardForRule(host, actorId, cardId, LIGUI)) recordAffected(host, ownerId, actorId, '静习弃牌')
    }
  },
})

function angerOrder(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  return [...state.players]
    .sort((left, right) => ((left.seat - owner.seat + state.players.length) % state.players.length)
      - ((right.seat - owner.seat + state.players.length) % state.players.length))
    .filter((player) => player.id !== ownerId)
    .map((player) => player.id)
}

function beginAnger(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  owner.marks[RESENTMENT] = 0
  owner.marks[AFFECTED_COUNT] = 0
  owner.marks[ANGER_ACTIVE] = 1
  for (const playerId of angerOrder(host.state, ownerId)) owner.marks[angerPendingKey(playerId)] = 1
  host.dispatch('SkillActivated', {
    playerId: ownerId, skillId: XINZHENG, skillName: '新政', result: 'anger-start', logText: `群情激愤！${owner.nickname}触发【群怒】`,
  }, { sourceId: ownerId })
  askNextAngerPlayer(host, ownerId)
}

function finishAnger(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  delete owner.marks[ANGER_ACTIVE]
  delete owner.marks[ANGER_QUEUED]
  for (const key of Object.keys(owner.marks)) {
    if (key.startsWith('xinzheng:anger-pending:') || key.startsWith('xinzheng:anger-attacker:')) delete owner.marks[key]
  }
  host.dispatch('SkillActivated', { playerId: ownerId, skillId: XINZHENG, skillName: '新政', result: 'anger-finished' }, { sourceId: ownerId })
}

function askNextAngerPlayer(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner.alive || !owner.marks[ANGER_ACTIVE]) return
  const nextId = angerOrder(host.state, ownerId).find((playerId) => owner.marks[angerPendingKey(playerId)])
  if (!nextId) {
    finishAnger(host, ownerId)
    return
  }
  const next = playerOf(host.state, nextId)
  if (!next.alive) {
    delete owner.marks[angerPendingKey(nextId)]
    askNextAngerPlayer(host, ownerId)
    return
  }
  const slashIds = next.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
  host.askSkill({
    skillId: XINZHENG, ownerId, step: 'anger-choice', data: { actorId: nextId, slashIds },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: nextId,
      prompt: `【群怒】：对${owner.nickname}出【杀】，或失去1点体力`, timeoutMs: 25_000, optional: false,
      options: slashIds.length > 0
        ? [{ id: 'slash', label: '出杀' }, { id: 'lose-hp', label: '不出：失去1点体力' }]
        : [{ id: 'lose-hp', label: '没有杀：失去1点体力' }],
    }),
  })
}

function angerLoseHp(host: SkillHost, ownerId: PlayerId, actorId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  delete owner.marks[angerPendingKey(actorId)]
  queueAnger(host, ownerId, 'next')
  host.dispatch('SkillActivated', {
    playerId: ownerId, skillId: XINZHENG, skillName: '新政', result: 'refuse', targetIds: [actorId],
    logText: `${playerOf(host.state, actorId).nickname}拒绝出杀，失去1点体力`,
  }, { sourceId: ownerId, targetId: actorId })
  loseHp(host, actorId, 1, XINZHENG)
}

registerSkillRuntime({
  id: XINZHENG,
  announcesSelf: true,
  triggers: [
    {
      event: 'DamageInflicted', priority: 100,
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        const sourceId = context.event.sourceId
        if (context.event.targetId !== ownerId || !sourceId || !owner.marks[ANGER_ACTIVE] || !owner.marks[angerAttackerKey(sourceId)]) return
        const payload = context.event.payload as { amount?: number }
        const amount = Math.max(0, Math.trunc(Number(payload.amount ?? 0)))
        payload.amount = Math.min(amount, Math.max(0, owner.hp - 1))
      },
    },
    {
      event: 'AfterDamage', priority: -20,
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        const sourceId = context.event.sourceId
        if (context.event.targetId !== ownerId || !sourceId || !owner.marks[ANGER_ACTIVE] || !owner.marks[angerAttackerKey(sourceId)]) return
        const amount = Math.max(0, Math.trunc(Number((context.event.payload as { amount?: unknown }).amount ?? 0)))
        if (amount > 0) drawCards(host.state, host.rng, ownerId, amount * 2, (name, payload) => host.dispatch(name, { ...payload, reason: XINZHENG }))
      },
    },
    {
      event: 'AfterCardUse', priority: -100,
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        const sourceId = context.event.sourceId
        const cardName = String((context.event.payload as { cardName?: unknown }).cardName ?? '')
        if (!sourceId || cardName !== '杀' || !owner.marks[ANGER_ACTIVE] || !owner.marks[angerAttackerKey(sourceId)]) return
        delete owner.marks[angerAttackerKey(sourceId)]
        queueAnger(host, ownerId, 'next')
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    delete owner.marks[ANGER_QUEUED]
    if (!owner.alive || owner.identity !== 'lord') return
    if (prompt.data.kind === 'start') beginAnger(host, ownerId)
    else askNextAngerPlayer(host, ownerId)
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    const actorId = String(resolution.data.actorId ?? '')
    const actor = host.state.players.find((candidate) => candidate.id === actorId)
    if (!owner.alive || !actor?.alive || !owner.marks[ANGER_ACTIVE] || !owner.marks[angerPendingKey(actorId)]) {
      queueAnger(host, ownerId, 'next')
      return
    }
    if (resolution.step === 'anger-choice') {
      const option = (response.payload as { optionId: string }).optionId
      if (option !== 'slash') {
        angerLoseHp(host, ownerId, actorId)
        return
      }
      const slashIds = actor.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
      if (slashIds.length === 0) {
        angerLoseHp(host, ownerId, actorId)
        return
      }
      host.askSkill({
        skillId: XINZHENG, ownerId, step: 'anger-card', data: { actorId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: actorId,
          prompt: `【群怒】：选择一张【杀】对${owner.nickname}使用`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: slashIds, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'anger-card') return
    const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
    if (!actor.zones.hand.includes(cardId) || host.state.cards[cardId]?.name !== '杀') {
      angerLoseHp(host, ownerId, actorId)
      return
    }
    delete owner.marks[angerPendingKey(actorId)]
    owner.marks[angerAttackerKey(actorId)] = 1
    host.dispatch('SkillActivated', {
      playerId: ownerId, skillId: XINZHENG, skillName: '新政', result: 'slash', targetIds: [actorId],
      logText: `${actor.nickname}响应【群怒】，对${owner.nickname}使用【杀】`,
    }, { sourceId: actorId, targetId: ownerId, cardIds: [cardId] })
    host.beginVirtualSlash({ sourceId: actorId, targetId: ownerId, sourceSkillId: XINZHENG, cardId })
  },
})

export const YIXING: CharacterDefinition = {
  id: 'yixing', name: '奕星', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'entertainment',
  skills: [
    {
      id: LIGUI, name: '立规',
      description: '每轮开始时，你可以选择一项“规定”本轮生效：禁酒——其他角色使用【酒】须额外弃1，否则无效；限行——其他角色出牌阶段使用第3张牌后不能再使用牌；静习——其他角色于回合外首次使用或打出牌后须弃1张牌。',
    },
    {
      id: XINZHENG, name: '新政',
      description: '主公技。每累计3名其他角色受【立规】影响，你获得1枚“怨”（至多3枚）。获得第3枚时清除“怨”并触发“群怒”：其他角色依次对你使用一张无距离限制的【杀】，或失去1点体力。你可以正常响应；期间你每失去1点体力摸2张牌，且体力不会因此降至1以下。若你为主公，善水使用【酒】须额外弃1张牌，否则无效。',
    },
  ],
}
