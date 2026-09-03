import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { loseHp } from '../../engine/hp'
import { hiddenHandSlot } from '../../engine/cards/host'
import type { ChooseCardsRequest, ChooseOptionRequest, DistributeCardsRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 「受到伤害后」触发的武将。
 *
 * 这些技能**不能在 Damaged 事件里当场发问**：那时候伤害结算还没走完，
 * 濒死救援可能正插在中间，等玩家回答时要拿的牌也可能已经移动了。
 * 所以统一走 `queueSkill`：触发时只把需要的事实抓下来，
 * 等牌局回到干净状态（没有请求、没有濒死、没有牌在结算）再发问。
 *
 * 代价是队列里的前提可能已经失效，所以每个 `startQueued` 都要重新确认一遍，
 * 不成立就安静地放弃——这比在错误的时机发问要好。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

function yesNo(requestId: string, playerId: PlayerId, prompt: string): ChooseOptionRequest {
  return {
    id: requestId,
    kind: 'choose-option',
    playerId,
    prompt,
    timeoutMs: 20_000,
    optional: true,
    options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
  }
}

function chose(response: GameResponse, optionId: string): boolean {
  return (response.payload as { optionId: string }).optionId === optionId
}

/**
 * 受到伤害时把事实抓进队列。`perPoint` 用来支持「每受到 1 点伤害」的技能：
 * 受到 2 点就排两次，而不是一次伤害事件只问一遍。
 *
 * 导出给其他包的同类技能复用（荀彧【节命】），不要再复制一份。
 */
export function queueOnDamaged(
  skillId: string,
  host: SkillHost,
  ownerId: PlayerId,
  context: { event: { targetId?: PlayerId; sourceId?: PlayerId; payload: Record<string, unknown> } },
  perPoint: boolean,
): void {
  const event = context.event
  if (event.targetId !== ownerId) return
  const times = perPoint ? Math.max(1, Number(event.payload.amount ?? 1)) : 1
  for (let index = 0; index < times; index += 1) {
    host.queueSkill({
      skillId,
      ownerId,
      step: 'ask',
      data: {
        sourceId: event.sourceId ?? null,
        cardId: (event.payload.cardId as CardId | null) ?? null,
      },
    })
  }
}

// —— 曹操【奸雄】——
registerSkillRuntime({
  id: 'jianxiong',
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) { queueOnDamaged('jianxiong', host, ownerId, context, false) },
  }],
  startQueued(host, ownerId, prompt) {
    const cardId = prompt.data.cardId as CardId | null
    // 造成伤害的牌用完之后进弃牌堆；已经被别人拿走或洗回牌堆就作罢
    if (!cardId || !host.state.zones.discardPile.includes(cardId)) return
    host.askSkill({
      skillId: 'jianxiong',
      ownerId,
      step: 'ask',
      data: { cardId },
      build: (requestId) => yesNo(requestId, ownerId, `发动【奸雄】？获得造成伤害的【${host.state.cards[cardId]?.name ?? '牌'}】`),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (!chose(response, 'yes')) return
    const cardId = resolution.data.cardId as CardId
    // 发问期间牌可能又动了，这里必须再确认一次
    if (!host.state.zones.discardPile.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '奸雄' }, { targetId: ownerId, cardIds: [cardId] })
  },
})

// —— 司马懿【反馈】——
registerSkillRuntime({
  id: 'fankui',
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) { queueOnDamaged('fankui', host, ownerId, context, false) },
  }],
  startQueued(host, ownerId, prompt) {
    const sourceId = prompt.data.sourceId as PlayerId | null
    if (!sourceId || sourceId === ownerId) return
    const source = host.state.players.find((candidate) => candidate.id === sourceId)
    if (!source?.alive) return
    const equipment = Object.values(source.zones.equipment).filter((id): id is CardId => Boolean(id))
    if (source.zones.hand.length === 0 && equipment.length === 0) return
    host.askSkill({
      skillId: 'fankui',
      ownerId,
      step: 'pick',
      data: { sourceId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: ownerId,
        prompt: `发动【反馈】：获得 ${source.nickname} 的一张牌`,
        timeoutMs: 20_000,
        optional: true,
        purpose: 'skill',
        // 手牌是暗的，只给占位槽；装备是公开的，可以直接列出来
        cardIds: equipment,
        hiddenCardSlots: source.zones.hand.map((_, index) => hiddenHandSlot(sourceId, index)),
        min: 1,
        max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const sourceId = resolution.data.sourceId as PlayerId
    const source = host.state.players.find((candidate) => candidate.id === sourceId)
    if (!source?.alive) return
    const [picked] = (response.payload as { cardIds: string[] }).cardIds
    const hiddenIndex = source.zones.hand.findIndex((_, index) => hiddenHandSlot(sourceId, index) === picked)
    if (hiddenIndex >= 0) {
      const cardId = source.zones.hand[hiddenIndex]
      moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: '反馈' }, { targetId: sourceId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '反馈' }, { targetId: ownerId, cardIds: [cardId] })
      return
    }
    const slot = (Object.keys(source.zones.equipment) as EquipmentSlot[])
      .find((key) => source.zones.equipment[key] === picked)
    if (!slot) throw new Error('反馈选中的牌不在来源的区域里')
    moveCard(host.state, picked, { kind: 'equipment', playerId: sourceId, slot }, { kind: 'hand', playerId: ownerId })
    host.dispatch('LoseEquipment', { playerId: sourceId, cardIds: [picked], reason: '反馈' }, { targetId: sourceId, cardIds: [picked] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: '反馈' }, { targetId: ownerId, cardIds: [picked] })
  },
})

/*
 * 郭嘉【天妒】——判定牌生效后可以拿走它。
 *
 * 走队列而不是在 JudgeResult 里当场发问：那时候判定还没走完
 * （延时锦囊的效果、闪电的伤害都在后面），当场插一个请求会打断结算。
 * 排队之后判定牌已经进了弃牌堆，从那里取回来——和洛神同一个套路。
 */
registerSkillRuntime({
  id: 'tiandu',
  triggers: [{
    event: 'JudgeResult',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; judgeCardId?: CardId }
      if (payload.playerId !== ownerId) return
      if (!payload.judgeCardId) return
      host.queueSkill({ skillId: 'tiandu', ownerId, step: 'ask', data: { judgeCardId: payload.judgeCardId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const judgeCardId = prompt.data.judgeCardId as CardId
    if (!playerOf(host.state, ownerId).alive) return
    // 队列里的前提可能已经失效：判定牌可能被别的效果拿走，或者洗回了牌堆
    if (!host.state.zones.discardPile.includes(judgeCardId)) return
    const card = host.state.cards[judgeCardId]
    host.askSkill({
      skillId: 'tiandu',
      ownerId,
      step: 'ask',
      data: { judgeCardId },
      build: (requestId) => yesNo(requestId, ownerId, `发动【天妒】？获得判定牌【${card?.name ?? '判定牌'}】`),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (!chose(response, 'yes')) return
    const judgeCardId = resolution.data.judgeCardId as CardId
    // 从发问到回答之间牌可能又动了，再确认一次
    if (!host.state.zones.discardPile.includes(judgeCardId)) return
    if (!playerOf(host.state, ownerId).alive) return
    moveCard(host.state, judgeCardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [judgeCardId], reason: '天妒' }, { targetId: ownerId, cardIds: [judgeCardId] })
  },
})

// —— 夏侯惇【刚烈】——
const GANGLIE_TAG = 'ganglie'

registerJudgmentContinuation(GANGLIE_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const sourceId = data.sourceId as PlayerId
  if (judged.suit === 'heart') return
  const source = host.state.players.find((candidate) => candidate.id === sourceId)
  if (!source?.alive) return
  // 手牌不足两张就没得选，直接失去体力
  if (source.zones.hand.length < 2) {
    loseHp(host, sourceId, 1, '刚烈')
    return
  }
  host.askSkill({
    skillId: 'ganglie',
    ownerId,
    step: 'choose',
    data: { sourceId },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      // 这一问是问伤害来源，不是问夏侯惇
      playerId: sourceId,
      prompt: '【刚烈】：弃置两张手牌，或失去一点体力',
      timeoutMs: 20_000,
      optional: false,
      options: [{ id: 'discard', label: '弃置两张手牌' }, { id: 'lose-hp', label: '失去一点体力' }],
    }),
  })
})

registerSkillRuntime({
  id: 'ganglie',
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) { queueOnDamaged('ganglie', host, ownerId, context, false) },
  }],
  startQueued(host, ownerId, prompt) {
    const sourceId = prompt.data.sourceId as PlayerId | null
    if (!sourceId || sourceId === ownerId) return
    if (!host.state.players.some((candidate) => candidate.id === sourceId && candidate.alive)) return
    host.askSkill({
      skillId: 'ganglie',
      ownerId,
      step: 'ask',
      data: { sourceId },
      build: (requestId) => yesNo(requestId, ownerId, '发动【刚烈】？判定不为红桃则伤害来源弃两张手牌或失去一点体力'),
    })
  },
  resume(host, ownerId, resolution, response) {
    const sourceId = resolution.data.sourceId as PlayerId
    const source = host.state.players.find((candidate) => candidate.id === sourceId)

    if (resolution.step === 'ask') {
      if (!chose(response, 'yes')) return
      if (!source?.alive) return
      // 判定可能因为改判挂起，红桃与否要等续接才知道
      performJudgment(host, ownerId, '刚烈', { tag: GANGLIE_TAG, data: { ownerId, sourceId } })
      return
    }

    if (!source?.alive) return
    if (resolution.step === 'choose') {
      if (chose(response, 'lose-hp') || source.zones.hand.length < 2) {
        loseHp(host, sourceId, 1, '刚烈')
        return
      }
      host.askSkill({
        skillId: 'ganglie',
        ownerId,
        step: 'discard',
        data: { sourceId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: sourceId,
          prompt: '【刚烈】：弃置两张手牌',
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds: [...source.zones.hand],
          hiddenCardSlots: [],
          min: 2,
          max: 2,
        }),
      })
      return
    }

    const cardIds = (response.payload as { cardIds: CardId[] }).cardIds
    if (cardIds.some((cardId) => !source.zones.hand.includes(cardId))) throw new Error('刚烈弃置的牌不在手上')
    for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: sourceId, cardIds, reason: '刚烈' }, { targetId: sourceId, cardIds })
  },
})

// —— 郭嘉【遗计】——
registerSkillRuntime({
  id: 'yiji',
  triggers: [{
    // 「每受到 1 点伤害」，所以按点数排队，受到 2 点就排两次
    event: 'Damaged',
    handle(host, ownerId, context) { queueOnDamaged('yiji', host, ownerId, context, true) },
  }],
  startQueued(host, ownerId) {
    host.askSkill({
      skillId: 'yiji',
      ownerId,
      step: 'ask',
      build: (requestId) => yesNo(requestId, ownerId, '发动【遗计】？摸两张牌，然后分配给任意角色'),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if (!chose(response, 'yes')) return
      const owner = playerOf(host.state, ownerId)
      const drawn: CardId[] = []
      for (let index = 0; index < 2; index += 1) {
        const cardId = host.state.zones.drawPile.shift()
        if (!cardId) break
        owner.zones.hand.push(cardId)
        drawn.push(cardId)
      }
      if (drawn.length === 0) return
      host.dispatch('GainCard', { playerId: ownerId, cardIds: drawn, reason: '遗计' }, { targetId: ownerId, cardIds: drawn })
      const recipientIds = host.state.players.filter((player) => player.alive).map((player) => player.id)
      host.askSkill({
        skillId: 'yiji',
        ownerId,
        step: 'distribute',
        data: { drawn },
        build: (requestId): DistributeCardsRequest => ({
          id: requestId,
          kind: 'distribute-cards',
          playerId: ownerId,
          prompt: '把这些牌分配给任意角色，留给自己就不分配',
          timeoutMs: 25_000,
          optional: true,
          cardIds: drawn,
          recipientIds,
          min: 0,
          max: drawn.length,
        }),
      })
      return
    }

    const assignments = (response.payload as { assignments: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments
    const owner = playerOf(host.state, ownerId)
    for (const { cardId, recipientId } of assignments) {
      if (recipientId === ownerId) continue
      // 分配期间牌可能已经不在手上了（这中间没有别的操作，但仍然防一手）
      if (!owner.zones.hand.includes(cardId)) continue
      const recipient = host.state.players.find((player) => player.id === recipientId)
      if (!recipient?.alive) continue
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: recipientId })
      host.dispatch('GainCard', { playerId: recipientId, cardIds: [cardId], reason: '遗计' }, { targetId: recipientId, cardIds: [cardId] })
    }
  },
})

// —— 司马懿【鬼才】——
//
// 「每当一名角色的判定牌生效前，你可以打出一张手牌代替之。」
//
// 判定原本是一次同步翻牌，没有任何插入点；鬼才要求玩家**看到牌面之后**再决定，
// 所以判定被拆成了「翻牌 → 逐人询问改判 → 结算」（见 engine/judgment.ts）。
// 这里只负责报告「我现在有哪些牌能用来改判」，问不问、问几轮由判定引擎统一安排——
// 技能自己不判断该不该改，也不碰判定结果。
//
// 手牌为空就返回空数组，判定引擎会跳过他，不会发出一个点不动的请求。
registerSkillRuntime({
  id: 'guicai',
  retrial(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    // 任何一名角色的判定都能改，包括司马懿自己的
    return owner?.alive ? [...owner.zones.hand] : []
  },
})

export const WEI_DAMAGE_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'caocao',
    name: '曹操',
    kingdom: 'wei',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [
      { id: 'jianxiong', name: '奸雄', description: '每当你受到伤害后，你可以获得造成伤害的牌。' },
      { id: 'hujia', name: '护驾', description: '主公技。你需要打出【闪】时，其他魏势力角色可以代你打出。' },
    ],
  },
  {
    id: 'simayi',
    name: '司马懿',
    kingdom: 'wei',
    gender: 'male',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'fankui', name: '反馈', description: '每当你受到伤害后，你可以获得伤害来源的一张牌。' },
      { id: 'guicai', name: '鬼才', description: '每当一名角色的判定牌生效前，你可以打出一张手牌代替之。' },
    ],
  },
  {
    id: 'xiahoudun',
    name: '夏侯惇',
    kingdom: 'wei',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'ganglie', name: '刚烈', description: '每当你受到伤害后，你可以进行判定：若结果不为红桃，则伤害来源需弃置两张手牌，否则失去一点体力。' }],
  },
  {
    id: 'guojia',
    name: '郭嘉',
    kingdom: 'wei',
    gender: 'male',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'tiandu', name: '天妒', description: '每当你的判定牌生效后，你可以获得此牌。' },
      { id: 'yiji', name: '遗计', description: '每当你受到一点伤害后，你可以摸两张牌，然后可以将这两张牌分配给任意角色。' },
    ],
  },
] as const
