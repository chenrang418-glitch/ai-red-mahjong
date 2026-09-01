import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseSuitRequest, ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { PlayerId, Suit } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

// —— 吕蒙【克己】——
registerSkillRuntime({
  id: 'keji',
  triggers: [
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardName?: string }
        if (payload.playerId !== ownerId || payload.cardName !== '杀') return
        if (host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
        const owner = host.state.players.find((player) => player.id === ownerId)
        if (owner) owner.marks.kejiRespondedSlash = 1
      },
    },
    {
      event: 'DiscardPhase',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const owner = host.state.players.find((player) => player.id === ownerId)
        if (payload.playerId !== ownerId || host.state.turnUsage.slashUses > 0 || owner?.marks.kejiRespondedSlash) return
        if (!owner?.alive || owner.zones.hand.length <= Math.max(0, owner.hp)) return
        context.cancel()
        host.askSkill({
          skillId: 'keji',
          ownerId,
          step: 'ask',
          build: (requestId): ChooseOptionRequest => ({
            id: requestId,
            kind: 'choose-option',
            playerId: ownerId,
            prompt: '本回合没有使用或打出过【杀】，是否发动【克己】跳过弃牌阶段？',
            timeoutMs: 20_000,
            optional: true,
            options: [{ id: 'yes', label: '发动【克己】' }, { id: 'no', label: '正常弃牌' }],
          }),
        })
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId) {
        const owner = host.state.players.find((player) => player.id === ownerId)
        if (owner) delete owner.marks.kejiRespondedSlash
      },
    },
  ],
  resume(host, ownerId, _resolution, response: GameResponse) {
    if ((response.payload as { optionId: string }).optionId === 'yes') return
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!owner?.alive) return
    const count = owner.zones.hand.length - Math.max(0, owner.hp)
    if (count <= 0) return
    const request: ChooseCardsRequest = {
      id: `request-keji-discard-${host.state.seq}-${host.state.decisions.length}`,
      kind: 'choose-cards',
      playerId: ownerId,
      prompt: `弃置 ${count} 张手牌`,
      timeoutMs: 30_000,
      optional: false,
      purpose: 'discard-phase',
      cardIds: [...owner.zones.hand],
      hiddenCardSlots: [],
      min: count,
      max: count,
    }
    host.state.pendingRequests.push(request)
  },
})

// —— 周瑜【英姿】——
registerSkillRuntime({
  id: 'yingzi',
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      context.cancel()
      host.askSkill({
        skillId: 'yingzi',
        ownerId,
        step: 'ask',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId,
          kind: 'choose-option',
          playerId: ownerId,
          prompt: '是否发动【英姿】额外摸一张牌？',
          timeoutMs: 20_000,
          optional: true,
          options: [{ id: 'yes', label: '发动【英姿】' }, { id: 'no', label: '正常摸牌' }],
        }),
      })
    },
  }],
  resume(host, ownerId, _resolution, response) {
    const invoked = (response.payload as { optionId: string }).optionId === 'yes'
    drawForSkill(host, ownerId, invoked ? 3 : 2, invoked ? '英姿' : 'draw')
  },
})

// —— 周瑜【反间】——
registerSkillRuntime({
  id: 'fanjian',
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.usedLimitedSkills.includes('fanjian')) return []
    if (!state.players.some((player) => player.alive && player.id !== ownerId)) return []
    return [{ id: 'skill:fanjian', label: '发动【反间】：令一名角色猜测花色并获得你的一张随机手牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:fanjian') throw new Error('反间动作不匹配')
    const candidateIds = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    host.askSkill({
      skillId: 'fanjian',
      ownerId,
      step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId,
        kind: 'choose-targets',
        playerId: ownerId,
        prompt: '选择【反间】的目标',
        timeoutMs: 20_000,
        optional: false,
        candidateIds,
        min: 1,
        max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      host.askSkill({
        skillId: 'fanjian',
        ownerId,
        step: 'suit',
        data: { targetId },
        build: (requestId): ChooseSuitRequest => ({
          id: requestId,
          kind: 'choose-suit',
          playerId: targetId,
          prompt: '猜测【反间】牌的花色',
          timeoutMs: 20_000,
          optional: false,
          suits: ['spade', 'heart', 'club', 'diamond'],
        }),
      })
      return
    }

    const targetId = resolution.data.targetId as PlayerId
    const declaredSuit = (response.payload as { suit: Suit }).suit
    const owner = host.state.players.find((player) => player.id === ownerId)
    const target = host.state.players.find((player) => player.id === targetId)
    if (!owner?.alive || !target?.alive || owner.zones.hand.length === 0) return
    const cardId = owner.zones.hand[host.rng.nextInt(owner.zones.hand.length)]
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
    owner.usedLimitedSkills.push('fanjian')
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '反间' }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: '反间', revealed: true }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    if (host.state.cards[cardId].suit !== declaredSuit) {
      resolveDamage(host, { sourceId: ownerId, targetId, amount: 1, nature: 'normal' })
    }
  },
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId) {
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (owner) owner.usedLimitedSkills = owner.usedLimitedSkills.filter((skillId) => skillId !== 'fanjian')
    },
  }],
})

function drawForSkill(host: SkillHost, playerId: PlayerId, count: number, reason: string): void {
  const drawn = drawCards(host.state, host.rng, playerId, count)
  if (drawn.length > 0) host.dispatch('GainCard', { playerId, cardIds: drawn, reason }, { targetId: playerId, cardIds: drawn })
}

// —— 陆逊【谦逊】——
registerSkillRuntime({
  id: 'qianxun',
  prohibitsTarget(_state, _ownerId, _sourceId, cardName) {
    return cardName === '顺手牵羊' || cardName === '乐不思蜀'
  },
})

function queueLianying(host: SkillHost, ownerId: PlayerId): void {
  const owner = host.state.players.find((player) => player.id === ownerId)
  if (!owner?.alive || owner.zones.hand.length !== 0) return
  if (host.state.skillResolution?.skillId === 'lianying' && host.state.skillResolution.ownerId === ownerId) return
  if (host.state.skillQueue.some((prompt) => prompt.skillId === 'lianying' && prompt.ownerId === ownerId)) return
  host.queueSkill({ skillId: 'lianying', ownerId, step: 'ask', data: {} })
}

// —— 陆逊【连营】——
registerSkillRuntime({
  id: 'lianying',
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId === ownerId) queueLianying(host, ownerId)
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId === ownerId) queueLianying(host, ownerId)
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId === ownerId) queueLianying(host, ownerId)
      },
    },
  ],
  startQueued(host, ownerId) {
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: 'lianying',
      ownerId,
      step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: '是否发动【连营】摸一张牌？',
        timeoutMs: 20_000,
        optional: true,
        options: [{ id: 'yes', label: '发动【连营】' }, { id: 'no', label: '放弃' }],
      }),
    })
  },
  resume(host, ownerId, _resolution, response) {
    if ((response.payload as { optionId: string }).optionId === 'yes') drawForSkill(host, ownerId, 1, '连营')
  },
})


// —— 大乔【国色】——
// 【流离】的运行时在 engine/equipment-requests.ts：它要改杀的结算目标，
// 和雌雄双股剑走同一个「成为目标时」的插入点。这里只登记技能说明。
registerSkillRuntime({
  id: 'guose',
  viewAs(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    if (!owner) return []
    return owner.zones.hand
      .filter((cardId) => state.cards[cardId]?.suit === 'heart' && state.cards[cardId]?.name !== '乐不思蜀')
      .map((cardId) => ({
        asCardName: '乐不思蜀',
        cardId,
        label: `将【${state.cards[cardId].name}】当【乐不思蜀】使用`,
      }))
  },
})

export const WU_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'lvmeng',
    name: '吕蒙',
    kingdom: 'wu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'keji', name: '克己', description: '若你于出牌阶段内没有使用或打出过【杀】，你可以跳过弃牌阶段。' }],
  },
  {
    id: 'zhouyu',
    name: '周瑜',
    kingdom: 'wu',
    gender: 'male',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'yingzi', name: '英姿', description: '摸牌阶段，你可以多摸一张牌。' },
      { id: 'fanjian', name: '反间', description: '出牌阶段限一次，你可以令一名其他角色选择一种花色，然后其获得你的一张随机手牌并展示之；若花色不同，你对其造成1点伤害。' },
    ],
  },
  {
    id: 'daqiao',
    name: '大乔',
    kingdom: 'wu',
    gender: 'female',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'guose', name: '国色', description: '你可以将一张红桃牌当【乐不思蜀】使用。' },
      { id: 'liuli', name: '流离', description: '当你成为【杀】的目标时，你可以弃置一张牌，将此【杀】转移给你攻击范围内的另一名角色。' },
    ],
  },
  {
    id: 'luxun',
    name: '陆逊',
    kingdom: 'wu',
    gender: 'male',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'qianxun', name: '谦逊', description: '锁定技，你不能成为【顺手牵羊】和【乐不思蜀】的目标。' },
      { id: 'lianying', name: '连营', description: '每当你失去最后一张手牌时，你可以摸一张牌。' },
    ],
  },
] as const
