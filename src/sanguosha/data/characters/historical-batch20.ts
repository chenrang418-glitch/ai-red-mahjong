import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { resolveDamage, resumeSourceDamagePrevention, resumeTargetDamagePrevention } from '../../engine/damage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { registerSkillRuntime, replaceTemporarySkill, replaceTemporarySkills, type SkillHost } from '../../engine/skills/runtime'
import { skillIsRandomlyGrantable, skillPoolByKingdomAndMaxHp } from '../../engine/random-skill-pool'
import { getDistance } from '../../engine/distance'
import { effectiveKingdomOf } from '../../engine/huashen'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 独立历史人物第二十批：周群、蒲元、马元义、骆统、向朗、刘璿、荀勖、马邈、
 * 曹豹、张裕。均此前项目未收录，全部作为独立 CharacterDefinition，不覆盖
 * 任何界/谋/族/国战/SP/神版本。
 *
 * 版本口径：
 * - 周群【天候】按用户提供的 2026-04-16 调整后文本实现（观看牌堆顶 3 张、
 *   可用任意数量手牌等量交换、展示其中 1 张、按花色授予天气技能）；
 *   【谶说】/四个天气衍生技（烈暑/凝雾/骤雨/严霜）经 WebFetch 核对 sgsol wiki。
 * - 蒲元/马元义【兵祸】经 WebFetch 核对 sgsol wiki 当前文本。
 * - 骆统/向朗/刘璿/荀勖/马邈/曹豹/张裕按用户提供的《一将成名》当前版文本实现。
 *
 * 已知简化（引擎能力边界，详见 commit 说明，不属于版本错误）：
 * - 蒲元【神工】：本引擎没有"宝物"装备栏（只有 weapon/weapon2/armor/
 *   offensiveHorse/defensiveHorse），锻造范围收窄为武器/防具/坐骑三类；
 *   锻造来源从"游戏外新增装备"简化为"从牌堆/弃牌堆随机取一张对应类别装备"，
 *   不引入官方"助力/妨害"多人投票子流程。
 * - 周群【天候】的"等量交换"简化为一次性选择手牌与牌堆顶两个池子，按
 *   两边选择数量的较小值配对交换，不强制两侧数量预先相等。
 * - 荀勖【笛音】"失去七次牌"按 CardMove 事件次数累计（非按牌堆栈计数）。
 * - 向朗【愆正】的两张回收判定牌类型简化为在技能发动时一次性声明，不额外
 *   实现"任意时点插入"。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function alivePlayers(state: SanguoshaState) {
  return state.players.filter((player) => player.alive)
}

function nameCharLength(name: string): number {
  return [...name].length
}

/* ============================== 周群 ============================== */

const TIANHOU = 'tianhou'
const CHANSHUO = 'chanshuo'
const LIESHU = 'lieshu'
const NINGWU = 'ningwu'
const ZHOUYU_WEATHER = 'zhouyuweather'
const YANSHUANG = 'yanshuang'

const WEATHER_BY_SUIT: Record<string, string> = {
  heart: LIESHU,
  diamond: NINGWU,
  spade: ZHOUYU_WEATHER,
  club: YANSHUANG,
}
const WEATHER_NAME: Record<string, string> = {
  [LIESHU]: '烈暑', [NINGWU]: '凝雾', [ZHOUYU_WEATHER]: '骤雨', [YANSHUANG]: '严霜',
}

registerSkillRuntime({
  id: TIANHOU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const top = host.state.zones.drawPile.slice(-3).reverse()
      if (top.length === 0) return
      host.state.tianhouTop = top
      host.queueSkill({ skillId: TIANHOU, ownerId, step: 'swap-out', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) { host.state.tianhouTop = undefined; return }
    if (prompt.step === 'swap-out') {
      const top = host.state.tianhouTop ?? []
      if (owner.zones.hand.length === 0 || top.length === 0) {
        host.queueSkill({ skillId: TIANHOU, ownerId, step: 'reveal', data: {} })
        return
      }
      host.askSkill({
        skillId: TIANHOU, ownerId, step: 'swap-out', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【天候】：观看牌堆顶 ${top.length} 张牌，选择至多 ${Math.min(owner.zones.hand.length, top.length)} 张手牌交换（可不选）`,
          timeoutMs: 20_000, optional: true, purpose: 'skill',
          cardIds: [...owner.zones.hand], hiddenCardSlots: [],
          min: 0, max: Math.min(owner.zones.hand.length, top.length),
        }),
      })
      return
    }
    if (prompt.step === 'swap-in') {
      const { handOut } = prompt.data as { handOut: CardId[] }
      const top = host.state.tianhouTop ?? []
      host.askSkill({
        skillId: TIANHOU, ownerId, step: 'swap-in', data: { handOut },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【天候】：选择 ${handOut.length} 张牌堆顶的牌换入手牌`,
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: [...top], hiddenCardSlots: [],
          min: handOut.length, max: handOut.length,
        }),
      })
      return
    }
    if (prompt.step === 'reveal') {
      const top = host.state.tianhouTop ?? []
      if (top.length === 0) { host.state.tianhouTop = undefined; return }
      host.askSkill({
        skillId: TIANHOU, ownerId, step: 'reveal', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【天候】：展示牌堆顶三张牌中的一张', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...top], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'grant') {
      const { cardId } = prompt.data as { cardId: CardId }
      const candidates = alivePlayers(host.state)
      if (candidates.length === 0) { host.state.tianhouTop = undefined; return }
      host.askSkill({
        skillId: TIANHOU, ownerId, step: 'grant', data: { cardId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【天候】：选择一名角色获得对应天气技能', timeoutMs: 20_000, optional: false,
          options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) { host.state.tianhouTop = undefined; return }
    if (resolution.step === 'swap-out') {
      const handOut = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (handOut.length === 0) { host.queueSkill({ skillId: TIANHOU, ownerId, step: 'reveal', data: {} }); return }
      host.queueSkill({ skillId: TIANHOU, ownerId, step: 'swap-in', data: { handOut } })
      return
    }
    if (resolution.step === 'swap-in') {
      const { handOut } = resolution.data as { handOut: CardId[] }
      const top = host.state.tianhouTop ?? []
      const topIn = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => top.includes(id))
      const n = Math.min(handOut.length, topIn.length)
      for (let i = 0; i < n; i += 1) {
        moveCard(host.state, handOut[i], { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
        moveCard(host.state, topIn[i], { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      }
      host.dispatch('SkillActivated', { skillId: TIANHOU, skillName: '天候', playerId: ownerId, logText: `${owner.nickname}发动【天候】，交换了${n}张牌` }, { sourceId: ownerId })
      const newTop = [...topIn.slice(n), ...top.filter((id) => !topIn.includes(id))]
      host.state.tianhouTop = newTop
      host.queueSkill({ skillId: TIANHOU, ownerId, step: 'reveal', data: {} })
      return
    }
    if (resolution.step === 'reveal') {
      const top = host.state.tianhouTop ?? []
      const [cardId] = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => top.includes(id))
      if (!cardId) { host.state.tianhouTop = undefined; return }
      const card = host.state.cards[cardId]
      host.dispatch('SkillActivated', {
        skillId: TIANHOU, skillName: '天候', playerId: ownerId, result: 'reveal',
        logText: `${owner.nickname}展示了牌堆顶一张牌：${card?.name ?? ''}`,
      }, { sourceId: ownerId, cardIds: [cardId] })
      host.queueSkill({ skillId: TIANHOU, ownerId, step: 'grant', data: { cardId } })
      return
    }
    if (resolution.step === 'grant') {
      const { cardId } = resolution.data as { cardId: CardId }
      const targetId = (response.payload as { optionId?: string }).optionId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      host.state.tianhouTop = undefined
      if (!target?.alive) return
      const card = host.state.cards[cardId]
      const weatherId = card ? WEATHER_BY_SUIT[card.suit] : undefined
      if (!weatherId) return
      const prevTargetId = host.state.zhouqunWeatherTargetId
      if (prevTargetId && prevTargetId !== targetId) replaceTemporarySkill(host.state, prevTargetId, 'zhouqun-tianhou', null)
      replaceTemporarySkill(host.state, targetId!, 'zhouqun-tianhou', weatherId)
      host.state.zhouqunWeatherTargetId = targetId
      host.dispatch('SkillActivated', {
        skillId: TIANHOU, skillName: '天候', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【天候】，令${target.nickname}获得【${WEATHER_NAME[weatherId]}】`,
      }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: LIESHU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || !payload.playerId || payload.playerId === ownerId) return
      const target = playerOf(host.state, payload.playerId)
      if (!target?.alive) return
      const maxHp = Math.max(...alivePlayers(host.state).map((player) => player.hp))
      if (target.hp !== maxHp) return
      loseHp(host as never, target.id, 1, LIESHU)
    },
  }],
})

registerSkillRuntime({
  id: YANSHUANG,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || !payload.playerId || payload.playerId === ownerId) return
      const target = playerOf(host.state, payload.playerId)
      if (!target?.alive) return
      const minHp = Math.min(...alivePlayers(host.state).map((player) => player.hp))
      if (target.hp !== minHp) return
      loseHp(host as never, target.id, 1, YANSHUANG)
    },
  }],
})

registerSkillRuntime({
  id: NINGWU,
  triggers: [{
    event: 'BeforeCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId) return
      if (payload.cardName !== '杀') return
      const targetIds = payload.targetIds ?? []
      if (targetIds.length !== 1) return
      const [targetId] = targetIds
      if (getDistance(host.state, sourceId, targetId) <= 1) return
      // 简化：不走标准判定区/改判流程，直接亮出牌堆顶一张牌同步比点
      const cardId = host.state.zones.drawPile[host.state.zones.drawPile.length - 1]
      if (!cardId) return
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
      const judgeCard = host.state.cards[cardId]
      const slashCard = host.state.cards[(context.event.payload as { cardId?: CardId }).cardId ?? '']
      host.dispatch('SkillActivated', {
        skillId: NINGWU, skillName: '凝雾', playerId: ownerId,
        logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【凝雾】，判定：${judgeCard?.name ?? ''}`,
      }, { sourceId: ownerId, cardIds: [cardId] })
      if (judgeCard && slashCard && judgeCard.rank > slashCard.rank) context.cancel()
    },
  }],
})

registerSkillRuntime({
  id: ZHOUYU_WEATHER,
  triggers: [
    {
      event: 'BeforeDamage',
      handle(host, ownerId, context) {
        void host
        const sourceId = context.event.sourceId
        if (!sourceId || sourceId === ownerId) return
        if (context.event.damageNature !== 'fire') return
        context.cancel()
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.damageNature !== 'thunder') return
        const targetId = context.event.targetId
        if (!targetId) return
        const adjacent = alivePlayers(host.state).filter((player) => getDistance(host.state, targetId, player.id) === 1)
        /*
         * 不能在这一个事件handler里对多名角色连续同步 loseHp：如果不止一人被
         * 打到 0 血，第二个 enterDying 会撞上"已有濒死流程正在进行"（state.dying
         * 只有一个槽位）。改走 queueSkill 逐个排队，drainSkillQueue 天然只在
         * !dying 时才继续，濒死之间自动串行。
         */
        for (const player of adjacent) {
          host.queueSkill({ skillId: ZHOUYU_WEATHER, ownerId, step: 'lose-hp', data: { targetId: player.id } })
        }
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    void ownerId
    if (prompt.step !== 'lose-hp') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    loseHp(host as never, targetId, 1, ZHOUYU_WEATHER)
  },
})

registerSkillRuntime({
  id: CHANSHUO,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidates = alivePlayers(host.state).filter((player) => player.zones.hand.length > 0)
      if (candidates.length === 0) return
      host.queueSkill({ skillId: CHANSHUO, ownerId, step: 'pick-target', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'pick-target') {
      const candidates = alivePlayers(host.state).filter((player) => player.zones.hand.length > 0)
      if (candidates.length === 0) return
      host.askSkill({
        skillId: CHANSHUO, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【谶说】：选择一名角色展示一张手牌（可以放弃）', timeoutMs: 20_000, optional: true,
          options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'reveal-hand') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.zones.hand.length === 0) return
      host.askSkill({
        skillId: CHANSHUO, ownerId, step: 'reveal-hand', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【谶说】：展示一张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-target') {
      const targetId = (response.payload as { optionId?: string }).optionId
      if (!targetId || targetId === 'none') return
      host.queueSkill({ skillId: CHANSHUO, ownerId, step: 'reveal-hand', data: { targetId } })
      return
    }
    if (resolution.step === 'reveal-hand') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [refCardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !refCardId || !target.zones.hand.includes(refCardId)) return
      const refCard = host.state.cards[refCardId]
      host.dispatch('SkillActivated', {
        skillId: CHANSHUO, skillName: '谶说', playerId: ownerId, targetId,
        logText: `${target.nickname}展示了一张手牌：${refCard?.name ?? ''}`,
      }, { sourceId: ownerId, targetId, cardIds: [refCardId] })
      const revealed: CardId[] = []
      let count = 0
      while (count < 3) {
        const cardId = host.state.zones.drawPile[host.state.zones.drawPile.length - 1]
        if (!cardId) break
        moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
        revealed.push(cardId)
        const card = host.state.cards[cardId]
        host.dispatch('SkillActivated', {
          skillId: CHANSHUO, skillName: '谶说', playerId: ownerId,
          logText: `【谶说】亮出牌堆顶一张牌：${card?.name ?? ''}`,
        }, { sourceId: ownerId, cardIds: [cardId] })
        count += 1
        if (!refCard || !card) break
        const matched = card.category === refCard.category
          || card.suit === refCard.suit
          || card.rank === refCard.rank
          || nameCharLength(card.name) === nameCharLength(refCard.name)
        if (!matched) break
      }
      for (const cardId of revealed) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      if (revealed.length > 0) {
        host.dispatch('SkillActivated', {
          skillId: CHANSHUO, skillName: '谶说', playerId: ownerId,
          logText: `${owner.nickname}获得了${revealed.length}张展示的牌堆牌`,
        }, { sourceId: ownerId, cardIds: revealed })
      }
    }
  },
})

/* ============================== 蒲元 ============================== */

const QISI = 'qisi'
const SHENGONG = 'shengong'
const SHENGONG_PILE = 'shengong-scrapped'

function equipmentCategoryOf(slot: EquipmentSlot): 'weapon' | 'armor' | 'horse' {
  if (slot === 'weapon' || slot === 'weapon2') return 'weapon'
  if (slot === 'armor') return 'armor'
  return 'horse'
}

function findEquipmentInPool(state: SanguoshaState, category: 'weapon' | 'armor' | 'horse', rng: { nextInt(n: number): number }): CardId | null {
  const pools: CardId[][] = [state.zones.drawPile, state.zones.discardPile]
  for (const pool of pools) {
    const matches = pool.filter((cardId) => {
      const card = state.cards[cardId]
      return card?.category === 'equipment' && card.equipmentSlot && equipmentCategoryOf(card.equipmentSlot) === category
    })
    if (matches.length > 0) return matches[rng.nextInt(matches.length)]
  }
  return null
}

registerSkillRuntime({
  id: QISI,
  triggers: [
    {
      event: 'GameStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        const categories: Array<'weapon' | 'armor' | 'horse'> = ['weapon', 'armor', 'horse']
        const shuffled = [...categories]
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          const j = host.rng.nextInt(i + 1)
          ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }
        for (const category of shuffled.slice(0, 2)) {
          const cardId = findEquipmentInPool(host.state, category, host.rng)
          if (!cardId) continue
          const card = host.state.cards[cardId]
          if (!card?.equipmentSlot) continue
          const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
          moveCard(host.state, cardId, from, { kind: 'equipment', playerId: ownerId, slot: card.equipmentSlot })
        }
        host.dispatch('SkillActivated', { skillId: QISI, skillName: '奇思', playerId: ownerId, logText: `${owner.nickname}发动【奇思】，获得了两件不同副类别的装备` }, { sourceId: ownerId })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: QISI, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.marks.qisiDrawLess) return
        owner.marks.qisiDrawLess = 0
        const payload = context.event.payload as { count?: number }
        payload.count = Math.max(0, (payload.count ?? 2) - 1)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: QISI, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【奇思】：可以少摸一张牌，声明一种装备类别获得对应装备', timeoutMs: 20_000, optional: true,
        options: [
          { id: 'weapon', label: '武器' }, { id: 'armor', label: '防具' }, { id: 'horse', label: '坐骑' },
          { id: 'none', label: '不发动' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (!optionId || optionId === 'none') return
    const category = optionId as 'weapon' | 'armor' | 'horse'
    const cardId = findEquipmentInPool(host.state, category, host.rng)
    owner.marks.qisiDrawLess = 1
    if (!cardId) return
    const card = host.state.cards[cardId]
    if (!card?.equipmentSlot) return
    const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
    moveCard(host.state, cardId, from, { kind: 'equipment', playerId: ownerId, slot: card.equipmentSlot })
    host.dispatch('SkillActivated', { skillId: QISI, skillName: '奇思', playerId: ownerId, logText: `${owner.nickname}发动【奇思】，获得了${card.name}` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: SHENGONG,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const options: Array<{ id: string; label: string }> = []
    for (const category of ['weapon', 'armor', 'horse'] as const) {
      if (usedThisTurn(state, ownerId, `${SHENGONG}:${category}`)) continue
      const slots: EquipmentSlot[] = category === 'weapon' ? ['weapon', 'weapon2'] : category === 'armor' ? ['armor'] : ['offensiveHorse', 'defensiveHorse']
      if (slots.some((slot) => owner.zones.equipment[slot])) options.push({ id: `${SHENGONG}:${category}`, label: `【神工】：弃置${category === 'weapon' ? '武器' : category === 'armor' ? '防具' : '坐骑'}锻造` })
    }
    return options
  },
  invokeActive(host, ownerId, actionId) {
    const category = actionId.split(':')[1] as 'weapon' | 'armor' | 'horse'
    shengongDiscardEquipment(host, ownerId, category)
  },
  triggers: [
    {
      event: 'CardMove',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardIds?: CardId[] }
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        const destroyed = (payload.cardIds ?? []).filter((cardId) => host.state.zones.discardPile.includes(cardId) && (host.state.shengongCardIds ?? []).includes(cardId))
        if (destroyed.length === 0) return
        for (const cardId of destroyed) {
          moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: SHENGONG_PILE })
          host.state.shengongCardIds = (host.state.shengongCardIds ?? []).filter((id) => id !== cardId)
          owner.marks.shengongDestroyedThisTurn = (owner.marks.shengongDestroyedThisTurn ?? 0) + 1
        }
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const n = owner.marks.shengongDestroyedThisTurn ?? 0
        owner.marks.shengongDestroyedThisTurn = 0
        if (n > 0) drawCards(host.state, host.rng, ownerId, n, (name, p) => { host.dispatch(name, p) })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const { cardId, category } = prompt.data as { cardId: CardId; category: 'weapon' | 'armor' | 'horse' }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = alivePlayers(host.state)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: SHENGONG, ownerId, step: 'target', data: { cardId, category },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【神工】：选择一名角色装备锻造出的装备', timeoutMs: 20_000, optional: false,
        options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const { cardId, category: _category } = resolution.data as { cardId: CardId; category: 'weapon' | 'armor' | 'horse' }
    void _category
    const targetId = (response.payload as { optionId?: string }).optionId
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    const card = host.state.cards[cardId]
    if (!card?.equipmentSlot) return
    const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
    moveCard(host.state, cardId, from, { kind: 'equipment', playerId: targetId!, slot: card.equipmentSlot })
    host.state.shengongCardIds = [...(host.state.shengongCardIds ?? []), cardId]
    host.dispatch('SkillActivated', { skillId: SHENGONG, skillName: '神工', playerId: ownerId, targetId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【神工】，锻造出${card.name}装备给${target.nickname}` }, { sourceId: ownerId, targetId })
  },
})

function shengongDiscardEquipment(host: SkillHost, ownerId: PlayerId, category: 'weapon' | 'armor' | 'horse'): boolean {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return false
  const usageId = `${SHENGONG}:${category}`
  if (usedThisTurn(host.state, ownerId, usageId)) return false
  const slots: EquipmentSlot[] = category === 'weapon' ? ['weapon', 'weapon2'] : category === 'armor' ? ['armor'] : ['offensiveHorse', 'defensiveHorse']
  const equippedSlot = slots.find((slot) => owner.zones.equipment[slot])
  if (!equippedSlot) return false
  const cardId = owner.zones.equipment[equippedSlot]!
  markUsedThisTurn(host.state, ownerId, usageId)
  moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot: equippedSlot }, { kind: 'discardPile' })
  const forgedCardId = findEquipmentInPool(host.state, category, host.rng)
  if (!forgedCardId) return true
  host.queueSkill({ skillId: SHENGONG, ownerId, step: 'target', data: { cardId: forgedCardId, category } })
  return true
}

/* ============================== 马元义 ============================== */

const JIBING = 'jibing'
const WANGJING = 'wangjing'
const MOUCUAN = 'moucuan'
const BINGHUO = 'binghuo'

function livingKingdomCount(state: SanguoshaState): number {
  return new Set(alivePlayers(state).map((player) => effectiveKingdomOf(state, player.id))).size
}

function bingIds(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const marked = state.mayuanyiBingCardIds?.[ownerId] ?? []
  const inHand = marked.filter((cardId) => owner.zones.hand.includes(cardId))
  if (inHand.length !== marked.length && state.mayuanyiBingCardIds) state.mayuanyiBingCardIds[ownerId] = inHand
  return inHand
}

function bingCount(state: SanguoshaState, ownerId: PlayerId): number {
  return bingIds(state, ownerId).length
}

registerSkillRuntime({
  id: JIBING,
  viewAs(state, ownerId) {
    return bingIds(state, ownerId).flatMap((cardId) => ([
      { asCardName: '杀', cardId, label: '兵：当【杀】使用/打出' },
      { asCardName: '闪', cardId, label: '兵：当【闪】使用/打出' },
    ]))
  },
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const x = livingKingdomCount(host.state)
        if (bingCount(host.state, ownerId) >= x) return
        host.queueSkill({ skillId: JIBING, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId }
        if (!payload.cardId || !(host.state.mayuanyiBingCardIds?.[ownerId] ?? []).includes(payload.cardId)) return
        host.state.mayuanyiBingUsedThisTurn ??= {}
        host.state.mayuanyiBingUsedThisTurn[ownerId] = (host.state.mayuanyiBingUsedThisTurn[ownerId] ?? 0) + 1
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: JIBING, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【集兵】：是否改为将牌堆顶两张牌置为"兵"？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '正常摸牌' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const taken: CardId[] = []
    for (let i = 0; i < 2; i += 1) {
      const cardId = host.state.zones.drawPile[host.state.zones.drawPile.length - 1]
      if (!cardId) break
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      taken.push(cardId)
    }
    host.state.mayuanyiBingCardIds ??= {}
    host.state.mayuanyiBingCardIds[ownerId] = [...(host.state.mayuanyiBingCardIds[ownerId] ?? []), ...taken]
    host.dispatch('SkillActivated', { skillId: JIBING, skillName: '集兵', playerId: ownerId, logText: `${owner.nickname}发动【集兵】，获得了${taken.length}张"兵"` }, { sourceId: ownerId, cardIds: taken })
  },
})

registerSkillRuntime({
  id: WANGJING,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      const owner = playerOf(host.state, ownerId)
      if (!owner || !payload.cardId || !(host.state.mayuanyiBingCardIds?.[ownerId] ?? []).includes(payload.cardId)) return
      const opponentId = payload.targetIds?.[0]
      if (!opponentId) return
      const maxHp = Math.max(...alivePlayers(host.state).map((player) => player.hp))
      const opponent = playerOf(host.state, opponentId)
      if (opponent?.hp !== maxHp) return
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: WANGJING, skillName: '往京', playerId: ownerId, logText: `${owner!.nickname}发动【往京】，摸了1张牌` }, { sourceId: ownerId })
    },
  }],
})

registerSkillRuntime({
  id: MOUCUAN,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      if (!owner?.alive || owner.marks.moucuanAwakened) return false
      return bingCount(state, ownerId) >= livingKingdomCount(state)
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      owner.marks.moucuanAwakened = 1
      loseMaxHp(host as never, ownerId, 1, MOUCUAN)
      replaceTemporarySkill(host.state, ownerId, 'mayuanyi-moucuan', BINGHUO)
      host.dispatch('SkillActivated', { skillId: MOUCUAN, skillName: '谋篡', playerId: ownerId, logText: `${owner.nickname}发动【谋篡】，获得了【兵祸】` }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: BINGHUO,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || !payload.playerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (!(host.state.mayuanyiBingUsedThisTurn?.[ownerId] ?? 0)) return
      host.queueSkill({ skillId: BINGHUO, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = alivePlayers(host.state)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: BINGHUO, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【兵祸】：是否令一名角色进行判定？黑色对其造成1点雷电伤害', timeoutMs: 20_000, optional: true,
        options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const cardId = host.state.zones.drawPile[host.state.zones.drawPile.length - 1]
    if (!cardId) return
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    const card = host.state.cards[cardId]
    host.dispatch('SkillActivated', { skillId: BINGHUO, skillName: '兵祸', playerId: ownerId, targetId, logText: `${owner.nickname}发动【兵祸】，判定：${card?.name ?? ''}` }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    if (card?.color === 'black') resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'thunder', cardName: null })
  },
})

/* ============================== 骆统 ============================== */

const RENZHENG = 'renzheng'
const JINJIAN = 'jinjian'

registerSkillRuntime({
  id: RENZHENG,
  triggers: [{
    event: 'DamageSettled',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { requestedAmount?: number; finalAmount?: number }
      const requested = payload.requestedAmount ?? 0
      const final = payload.finalAmount ?? 0
      if (final >= requested) return
      drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: RENZHENG, skillName: '仁政', playerId: ownerId, logText: `${owner.nickname}发动【仁政】，摸了2张牌` }, { sourceId: ownerId })
    },
  }],
})

registerSkillRuntime({
  id: JINJIAN,
  offersSourceDamagePreventionAsk(host, ownerId, context) {
    if (!context.targetId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    host.queueSkill({ skillId: JINJIAN, ownerId, step: 'out-ask', data: {} })
    return true
  },
  offersTargetDamagePreventionAsk(host, ownerId, context) {
    if (!context.sourceId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    host.queueSkill({ skillId: JINJIAN, ownerId, step: 'in-ask', data: {} })
    return true
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (owner) { owner.marks.jinjianOutPenalty = 0; owner.marks.jinjianInPenalty = 0 }
    },
  }],
  outgoingDamage(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    if (!owner?.marks.jinjianOutPenalty) return null
    owner.marks.jinjianOutPenalty = 0
    return { amount: Math.max(0, context.amount - 1) }
  },
  incomingDamage(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    if (!owner?.marks.jinjianInPenalty) return null
    owner.marks.jinjianInPenalty = 0
    return { amount: context.amount + 1 }
  },
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) {
      if (prompt.step === 'out-ask' && host.state.pendingSourceDamage) resumeSourceDamagePrevention(host as never, false)
      if (prompt.step === 'in-ask' && host.state.pendingTargetDamage) resumeTargetDamagePrevention(host as never, false)
      return
    }
    if (prompt.step === 'out-ask') {
      if (!host.state.pendingSourceDamage) return
      host.askSkill({
        skillId: JINJIAN, ownerId, step: 'out-ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【进谏】：是否令此伤害+1？（本回合下次你造成的伤害将-1）', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'in-ask') {
      if (!host.state.pendingTargetDamage) return
      host.askSkill({
        skillId: JINJIAN, ownerId, step: 'in-ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【进谏】：是否令此伤害-1？（本回合下次你受到的伤害将+1）', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    const yes = (response.payload as { optionId?: string }).optionId === 'yes'
    if (resolution.step === 'out-ask') {
      if (yes && owner?.alive && host.state.pendingSourceDamage) {
        const options = host.state.pendingSourceDamage.options as { amount?: number }
        options.amount = (options.amount ?? 1) + 1
        host.dispatch('SkillActivated', { skillId: JINJIAN, skillName: '进谏', playerId: ownerId, logText: `${owner.nickname}发动【进谏】，令此伤害+1` }, { sourceId: ownerId })
        // Resume this already-boosted damage before arming the next-damage penalty;
        // otherwise outgoingDamage would consume the penalty on the same hit.
        resumeSourceDamagePrevention(host as never, false)
        owner.marks.jinjianOutPenalty = 1
        return
      }
      resumeSourceDamagePrevention(host as never, false)
      return
    }
    if (resolution.step === 'in-ask') {
      if (yes && owner?.alive && host.state.pendingTargetDamage) {
        const options = host.state.pendingTargetDamage.options as { amount?: number }
        const reduced = (options.amount ?? 1) - 1
        owner.marks.jinjianInPenalty = 1
        host.dispatch('SkillActivated', { skillId: JINJIAN, skillName: '进谏', playerId: ownerId, logText: `${owner.nickname}发动【进谏】，令此伤害-1` }, { sourceId: ownerId })
        if (reduced <= 0) { resumeTargetDamagePrevention(host as never, true); return }
        options.amount = reduced
      }
      resumeTargetDamagePrevention(host as never, false)
    }
  },
})

/* ============================== 向朗 ============================== */

const KANJI = 'kanji'
const QIANZHENG = 'qianzheng'

function handSuitsAllDistinct(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner) return false
  const suits = owner.zones.hand.map((cardId) => state.cards[cardId]?.suit).filter((suit): suit is NonNullable<typeof suit> => Boolean(suit))
  return new Set(suits).size === suits.length
}

registerSkillRuntime({
  id: KANJI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: KANJI, ownerId, step: 'ask', data: { used: 0 } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { used } = prompt.data as { used: number }
    if (used >= 2) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: KANJI, ownerId, step: 'ask', data: { used },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【勘集】：是否展示所有手牌？（本回合还可发动${2 - used}次）`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { used } = resolution.data as { used: number }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    host.dispatch('SkillActivated', { skillId: KANJI, skillName: '勘集', playerId: ownerId, logText: `${owner.nickname}发动【勘集】，展示了所有手牌` }, { sourceId: ownerId, cardIds: [...owner.zones.hand] })
    if (handSuitsAllDistinct(host.state, ownerId)) {
      drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
      const suits = new Set(owner.zones.hand.map((cardId) => host.state.cards[cardId]?.suit))
      if (['spade', 'heart', 'club', 'diamond'].every((suit) => suits.has(suit as never))) host.state.xianglangSkipDiscard = { [ownerId]: true, ...host.state.xianglangSkipDiscard }
    }
    host.queueSkill({ skillId: KANJI, ownerId, step: 'ask', data: { used: used + 1 } })
  },
})

registerSkillRuntime({
  id: QIANZHENG,
  triggers: [{
    event: 'BeforeCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[]; cardId?: CardId }
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId) return
      if (!(payload.targetIds ?? []).includes(ownerId)) return
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      if (!card) return
      const isSlash = card.name === '杀'
      const isPlainTrick = card.category === 'trick' && !DELAYED_TRICKS.has(card.name)
      if (!isSlash && !isPlainTrick) return
      const usageId = `${QIANZHENG}:${host.state.turnNumber}`
      const count = playerOf(host.state, ownerId)?.marks.qianzhengUsedTurn ?? 0
      if (count >= 2) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length < 2) return
      void usageId
      host.state.qianzhengWatch ??= {}
      host.state.qianzhengWatch[payload.cardId!] = ownerId
      host.queueSkill({ skillId: QIANZHENG, ownerId, step: 'ask', data: { effectiveType: card.category, watchCardId: payload.cardId } })
    },
  }, {
    event: 'CardMove',
    handle(host, ownerId, context) {
      const watch = host.state.qianzhengWatch ?? {}
      const payload = context.event.payload as { cardIds?: CardId[] }
      for (const cardId of payload.cardIds ?? []) {
        if (watch[cardId] !== ownerId) continue
        if (!host.state.zones.discardPile.includes(cardId)) continue
        const card = host.state.cards[cardId]
        if (card?.virtual) { delete watch[cardId]; continue }
        delete watch[cardId]
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('SkillActivated', { skillId: QIANZHENG, skillName: '愆正', playerId: ownerId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【愆正】，获得了结算完毕的牌` }, { sourceId: ownerId, cardIds: [cardId] })
      }
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { effectiveType } = prompt.data as { effectiveType: string }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return
    host.askSkill({
      skillId: QIANZHENG, ownerId, step: 'ask', data: { effectiveType },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【愆正】：可以重铸两张类型均与当前牌不同的手牌（可放弃）', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 2,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { effectiveType } = resolution.data as { effectiveType: string }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
    if (picked.length !== 2) return
    if (picked.some((id) => host.state.cards[id]?.category === effectiveType)) return
    owner.marks.qianzhengUsedTurn = (owner.marks.qianzhengUsedTurn ?? 0) + 1
    for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: QIANZHENG }, { sourceId: ownerId, cardIds: picked })
    drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
    host.dispatch('SkillActivated', { skillId: QIANZHENG, skillName: '愆正', playerId: ownerId, logText: `${owner.nickname}发动【愆正】，重铸了两张牌` }, { sourceId: ownerId })
  },
})

/* ============================== 刘璿 ============================== */

const MOGUI = 'mogui'
const ZUNJIAN = 'zunjian'
const RENCHENG = 'rencheng'

registerSkillRuntime({
  id: MOGUI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || payload.playerId !== ownerId) return
        const removed = owner.marks.moguiRemoved ?? 0
        if (payload.phase === 'judge' && !(removed & 1)) host.queueSkill({ skillId: MOGUI, ownerId, step: 'judge', data: {} })
        if (payload.phase === 'draw' && !(removed & 2)) host.queueSkill({ skillId: MOGUI, ownerId, step: 'draw', data: {} })
        if (payload.phase === 'discard' && !(removed & 4)) host.queueSkill({ skillId: MOGUI, ownerId, step: 'discard', data: {} })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'judge') {
      const candidates = alivePlayers(host.state)
      host.askSkill({
        skillId: MOGUI, ownerId, step: 'judge', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【漠规】：是否令一名角色回复1点体力并弃置其判定区的牌？', timeoutMs: 20_000, optional: true,
          options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'draw') {
      const candidates = alivePlayers(host.state)
      host.askSkill({
        skillId: MOGUI, ownerId, step: 'draw', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【漠规】：是否令一名角色摸牌数+1、【杀】使用次数+1？', timeoutMs: 20_000, optional: true,
          options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'discard') {
      if (owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: MOGUI, ownerId, step: 'discard', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【漠规】：可以弃置至多5张牌', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(5, owner.zones.hand.length),
        }),
      })
      return
    }
    if (prompt.step === 'discard-target') {
      const { n } = prompt.data as { n: number }
      const candidates = alivePlayers(host.state)
      if (candidates.length === 0) return
      host.askSkill({
        skillId: MOGUI, ownerId, step: 'discard-target', data: { n },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【漠规】：选择一名角色摸牌', timeoutMs: 20_000, optional: false,
          options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'judge') {
      const targetId = (response.payload as { optionId?: string }).optionId
      owner.marks.moguiRemoved = (owner.marks.moguiRemoved ?? 0) | 1
      if (!targetId || targetId === 'none') return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      if (target.hp < target.maxHp) recover(host as never, targetId, 1, MOGUI)
      const judging = [...target.zones.judgingArea]
      for (const cardId of judging) moveCard(host.state, cardId, { kind: 'judgingArea', playerId: targetId }, { kind: 'discardPile' })
      if (judging.length > 0) host.dispatch('LoseCard', { playerId: targetId, cardIds: judging, reason: MOGUI }, { sourceId: ownerId, targetId, cardIds: judging })
      host.dispatch('SkillActivated', { skillId: MOGUI, skillName: '漠规', playerId: ownerId, targetId, logText: `${owner.nickname}发动【漠规】` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'draw') {
      const targetId = (response.payload as { optionId?: string }).optionId
      owner.marks.moguiRemoved = (owner.marks.moguiRemoved ?? 0) | 2
      if (!targetId || targetId === 'none') return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      target.marks.liuxuanDrawBonus = 1
      target.marks.liuxuanSlashBonus = 1
      host.dispatch('SkillActivated', { skillId: MOGUI, skillName: '漠规', playerId: ownerId, targetId, logText: `${owner.nickname}发动【漠规】` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'discard') {
      owner.marks.moguiRemoved = (owner.marks.moguiRemoved ?? 0) | 4
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      const n = picked.length
      const candidates = alivePlayers(host.state)
      if (n === 0 || candidates.length === 0) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: MOGUI }, { sourceId: ownerId, cardIds: picked })
      host.queueSkill({ skillId: MOGUI, ownerId, step: 'discard-target', data: { n } })
      return
    }
    if (resolution.step === 'discard-target') {
      const { n } = resolution.data as { n: number }
      const targetId = (response.payload as { optionId?: string }).optionId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      drawCards(host.state, host.rng, targetId!, n, (name, p) => { host.dispatch(name, p) })
      host.dispatch('SkillActivated', { skillId: MOGUI, skillName: '漠规', playerId: ownerId, targetId, logText: `${owner.nickname}发动【漠规】，${target.nickname}摸了${n}张牌` }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: ZUNJIAN,
  awakening: {
    phase: 'play',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      if (!owner?.alive || owner.marks.zunjianAwakened) return false
      return (owner.marks.moguiRemoved ?? 0) === 7
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      owner.marks.zunjianAwakened = 1
      recover(host as never, ownerId, 1, ZUNJIAN)
      host.dispatch('SkillActivated', { skillId: ZUNJIAN, skillName: '遵谏', playerId: ownerId, logText: `${owner.nickname}发动【遵谏】` }, { sourceId: ownerId })
      host.queueSkill({ skillId: ZUNJIAN, ownerId, step: 'branch', data: {} })
    },
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'branch') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: ZUNJIAN, ownerId, step: 'branch', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【遵谏】：选择一项', timeoutMs: 20_000, optional: false,
        options: [{ id: 'a', label: '摸2张牌，重置【漠规】' }, { id: 'b', label: '回复1点体力，失去【漠规】，修改【仁诚】' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'branch') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'a') {
      drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
      owner.marks.moguiRemoved = 0
    } else if (optionId === 'b') {
      recover(host as never, ownerId, 1, ZUNJIAN)
      replaceTemporarySkills(host.state, ownerId, 'liuxuan-mogui', [])
      owner.marks.liuxuanRenchengModified = 1
    }
  },
})

registerSkillRuntime({
  id: RENCHENG,
  globalSlashUses(state, ownerId) {
    return playerOf(state, ownerId)?.marks.liuxuanSlashBonus ?? 0
  },
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase === 'finish' && payload.playerId) {
          const target = playerOf(host.state, payload.playerId)
          if (target) { target.marks.liuxuanDrawBonus = 0; target.marks.liuxuanSlashBonus = 0 }
        }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (usedThisTurn(host.state, ownerId, RENCHENG)) return
        host.queueSkill({ skillId: RENCHENG, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        const bonus = playerOf(host.state, ownerId)?.marks.liuxuanDrawBonus ?? 0
        if (!bonus) return
        const payload = context.event.payload as { count?: number }
        payload.count = (payload.count ?? 2) + bonus
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    markUsedThisTurn(host.state, ownerId, RENCHENG)
    const modified = Boolean(owner.marks.liuxuanRenchengModified)
    const drawN = modified ? 3 : 2
    drawCards(host.state, host.rng, ownerId, drawN, (n, p) => { host.dispatch(n, p) })
    host.dispatch('SkillActivated', { skillId: RENCHENG, skillName: '仁诚', playerId: ownerId, logText: `${owner.nickname}发动【仁诚】，摸了${drawN}张牌` }, { sourceId: ownerId })
    const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
    if (others.length === 0 || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: RENCHENG, ownerId, step: 'give-target', data: { modified },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【仁诚】：选择一名其他角色给予牌（可以放弃）', timeoutMs: 20_000, optional: true,
        options: [...others.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'give-target') {
      const { modified } = resolution.data as { modified: boolean }
      const targetId = (response.payload as { optionId?: string }).optionId
      if (!targetId || targetId === 'none') return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const cap = modified ? 3 : 2
      host.askSkill({
        skillId: RENCHENG, ownerId, step: 'give-cards', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【仁诚】：交给${target.nickname}至多${cap}张牌`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(cap, owner.zones.hand.length),
        }),
      })
      return
    }
    if (resolution.step === 'give-cards') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (picked.length === 0) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: picked, reason: RENCHENG }, { sourceId: ownerId, targetId, cardIds: picked })
      host.dispatch('SkillActivated', { skillId: RENCHENG, skillName: '仁诚', playerId: ownerId, targetId, logText: `${owner.nickname}发动【仁诚】，给予了${target.nickname} ${picked.length}张牌` }, { sourceId: ownerId, targetId })
      if (!owner.marks.liuxuanRenchengModified) return
      const categories = new Set(picked.map((id) => host.state.cards[id]?.category))
      if (categories.has('basic')) target.marks.liuxuanNoDistanceLimit = 1
      if (categories.has('trick')) {
        host.queueSkill({ skillId: RENCHENG, ownerId, step: 'trick-bonus', data: {} })
      }
      if (categories.has('equipment')) {
        if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, RENCHENG)
        if (target.hp < target.maxHp) recover(host as never, targetId, 1, RENCHENG)
      }
      return
    }
    if (resolution.step === 'trick-bonus') {
      const candidates = alivePlayers(host.state).filter((player) => player.zones.hand.length + Object.values(player.zones.equipment).filter(Boolean).length + player.zones.judgingArea.length > 0)
      if (candidates.length === 0) return
      host.askSkill({
        skillId: RENCHENG, ownerId, step: 'trick-discard', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【仁诚】：选择一名角色弃置其区域内一张牌', timeoutMs: 20_000, optional: true,
          options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
        }),
      })
    }
  },
})

/* ============================== 荀勖 ============================== */

const DIYIN = 'diyin'
const BOQIA = 'boqia'

registerSkillRuntime({
  id: DIYIN,
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        owner.marks.diyinLossEvents = (owner.marks.diyinLossEvents ?? 0) + 1
        if (owner.marks.diyinLossEvents % 7 === 0) owner.marks.diyinCharges = (owner.marks.diyinCharges ?? 0) + 1
      },
    },
    {
      event: 'CardMove',
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || !(owner.marks.diyinCharges ?? 0)) return
        const payload = context.event.payload as { cardIds?: CardId[] }
        const cardId = (payload.cardIds ?? []).find((id) => host.state.zones.discardPile.includes(id))
        if (!cardId) return
        owner.marks.diyinCharges -= 1
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('SkillActivated', { skillId: DIYIN, skillName: '笛音', playerId: ownerId, logText: `${owner.nickname}发动【笛音】，获得了一张牌` }, { sourceId: ownerId, cardIds: [cardId] })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        for (const player of alivePlayers(host.state)) {
          if (player.hp === owner.hp) drawCards(host.state, host.rng, player.id, 1, (n, p) => { host.dispatch(n, p) })
        }
      },
    },
  ],
})

registerSkillRuntime({
  id: BOQIA,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 3 || usedThisTurn(state, ownerId, BOQIA)) return []
    return [{ id: `${BOQIA}:declare`, label: '【博洽】：将三张牌当基本牌/非伤害类普通锦囊使用' }]
  },
  activeActionUsesCard: true,
  invokeActive(host, ownerId) {
    // 每种成功声明都会在下面 resume 里把这个标记撤掉（花色/类型全不同即视为未发动）；
    // 这里先标记住是为了防止 AI 对着一组不满足条件的手牌反复尝试同一个空转动作
    markUsedThisTurn(host.state, ownerId, BOQIA)
    host.queueSkill({ skillId: BOQIA, ownerId, step: 'pick', data: {} })
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.boqiaUsedNamesThisTurn = 0
      host.state.boqiaUsedNames = host.state.boqiaUsedNames ?? {}
      delete host.state.boqiaUsedNames[ownerId]
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'pick') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length < 3) return
      host.askSkill({
        skillId: BOQIA, ownerId, step: 'pick', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【博洽】：选择三张手牌（花色全不同或牌型全不同才能发动）', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 3, max: 3,
        }),
      })
      return
    }
    if (prompt.step !== 'target') return
    const { cardIds } = prompt.data as { cardIds: CardId[] }
    const candidates = alivePlayers(host.state)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: BOQIA, ownerId, step: 'target', data: { cardIds },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【博洽】：选择一名角色调整其手牌数至其体力上限', timeoutMs: 20_000, optional: false,
        options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick') {
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (picked.length !== 3) return
      const suits = new Set(picked.map((id) => host.state.cards[id]?.suit))
      const types = new Set(picked.map((id) => host.state.cards[id]?.category))
      if (suits.size !== 3 && types.size !== 3) return
      const names = picked.map((id) => host.state.cards[id]?.name ?? '')
      host.state.boqiaUsedNames ??= {}
      host.state.boqiaUsedNames[ownerId] ??= []
      if (names.some((name) => host.state.boqiaUsedNames![ownerId].includes(name))) return
      host.state.boqiaUsedNames[ownerId].push(...names)
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: BOQIA }, { sourceId: ownerId, cardIds: picked })
      // 花色/牌型全不同才能发动，因此这里天然满足"视为本回合未发动"：撤掉 invokeActive 时立的占位标记
      if (owner.turnUsedSkills) owner.turnUsedSkills = owner.turnUsedSkills.filter((id) => id !== BOQIA)
      host.queueSkill({ skillId: BOQIA, ownerId, step: 'target', data: { cardIds: picked } })
      return
    }
    if (resolution.step !== 'target') return
    const { cardIds } = resolution.data as { cardIds: CardId[] }
    void cardIds
    const targetId = (response.payload as { optionId?: string }).optionId
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    const diff = target.maxHp - target.zones.hand.length
    if (diff > 0) drawCards(host.state, host.rng, targetId!, diff, (n, p) => { host.dispatch(n, p) })
    else if (diff < 0) {
      const toDiscard = target.zones.hand.slice(0, -diff)
      for (const cardId of toDiscard) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId! }, { kind: 'discardPile' })
      if (toDiscard.length > 0) host.dispatch('LoseCard', { playerId: targetId, cardIds: toDiscard, reason: BOQIA }, { sourceId: ownerId, targetId, cardIds: toDiscard })
    }
    host.dispatch('SkillActivated', { skillId: BOQIA, skillName: '博洽', playerId: ownerId, targetId, logText: `${owner.nickname}发动【博洽】` }, { sourceId: ownerId, targetId })
  },
})

/* ============================== 马邈 ============================== */

const ZHANGGUAN = 'zhangguan'
const CONGFENG = 'congfeng'

registerSkillRuntime({
  id: ZHANGGUAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: ZHANGGUAN, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: ZHANGGUAN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【仗关】：是否将手牌数调整至体力值？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const diff = owner.hp - owner.zones.hand.length
      if (diff === 0) {
        if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ZHANGGUAN)
        host.dispatch('SkillActivated', { skillId: ZHANGGUAN, skillName: '仗关', playerId: ownerId, logText: `${owner.nickname}发动【仗关】` }, { sourceId: ownerId })
        return
      }
      if (diff > 0) {
        drawCards(host.state, host.rng, ownerId, diff, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: ZHANGGUAN, skillName: '仗关', playerId: ownerId, logText: `${owner.nickname}发动【仗关】，摸了${diff}张牌` }, { sourceId: ownerId })
        return
      }
      const discardCount = -diff
      host.askSkill({
        skillId: ZHANGGUAN, ownerId, step: 'discard', data: { discardCount },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【仗关】：弃置${discardCount}张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: discardCount, max: discardCount,
        }),
      })
      return
    }
    if (resolution.step === 'discard') {
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (picked.length === 0) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: ZHANGGUAN }, { sourceId: ownerId, cardIds: picked })
      host.dispatch('SkillActivated', { skillId: ZHANGGUAN, skillName: '仗关', playerId: ownerId, logText: `${owner.nickname}发动【仗关】，弃置了${picked.length}张牌` }, { sourceId: ownerId })
      const turnOwner = playerOf(host.state, host.state.currentPlayerId)
      if (!turnOwner?.alive || turnOwner.id === ownerId) return
      const pool = [...turnOwner.zones.hand]
      if (pool.length === 0) return
      const cardId = pool[host.rng.nextInt(pool.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: turnOwner.id }, { kind: 'hand', playerId: ownerId })
      // GainCard 会被下面 CONGFENG 自己的触发器听到，"额外随机再获得一张"由那边统一处理，这里不重复调用
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: `${ZHANGGUAN}:gain` }, { sourceId: turnOwner.id, targetId: ownerId, cardIds: [cardId] })
    }
  },
})

function triggerCongfengExtra(host: SkillHost, gainerId: PlayerId, sourceOfCardId: PlayerId): void {
  const source = playerOf(host.state, sourceOfCardId)
  const gainer = playerOf(host.state, gainerId)
  if (!source?.alive || !gainer?.alive) return
  const pool = [...source.zones.hand]
  if (pool.length === 0) return
  const cardId = pool[host.rng.nextInt(pool.length)]
  host.state.congfengNoRecurse = true
  moveCard(host.state, cardId, { kind: 'hand', playerId: sourceOfCardId }, { kind: 'hand', playerId: gainerId })
  host.dispatch('GainCard', { playerId: gainerId, cardIds: [cardId], reason: `${CONGFENG}:extra` }, { sourceId: sourceOfCardId, targetId: gainerId, cardIds: [cardId] })
  host.dispatch('SkillActivated', { skillId: CONGFENG, skillName: '从风', playerId: gainerId, logText: `${gainer.nickname}发动【从风】，额外随机获得一张牌` }, { sourceId: sourceOfCardId, targetId: gainerId })
  host.state.congfengNoRecurse = false
}

registerSkillRuntime({
  id: CONGFENG,
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      if (host.state.congfengNoRecurse) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { playerId?: PlayerId }
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === payload.playerId) return
      if (payload.playerId === ownerId && sourceId !== ownerId) {
        // 马邈从其他角色处获得牌后，额外随机获得其一张
        triggerCongfengExtra(host as never, ownerId, sourceId)
        return
      }
      if (sourceId === ownerId && payload.playerId && payload.playerId !== ownerId) {
        // 其他角色从马邈处获得牌后，马邈额外随机获得其一张
        triggerCongfengExtra(host as never, ownerId, payload.playerId)
      }
    },
  }],
})

/* ============================== 曹豹 ============================== */

const YANJIU = 'yanjiu'
const POYIN = 'poyin'

registerSkillRuntime({
  id: POYIN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (payload.phase === 'play') {
        drawCards(host.state, host.rng, ownerId, owner.maxHp, (n, p) => { host.dispatch(n, p) })
        host.state.caobaoJiuCardIds ??= {}
        host.state.caobaoJiuCardIds[ownerId] = []
        host.queueSkill({ skillId: POYIN, ownerId, step: 'mark', data: {} })
      }
      if (payload.phase === 'finish') host.queueSkill({ skillId: POYIN, ownerId, step: 'challenge', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'mark') {
      const n = Math.max(0, owner.maxHp - owner.hp) || owner.hp
      const cap = Math.min(n, owner.zones.hand.length)
      if (cap <= 0) return
      host.askSkill({
        skillId: POYIN, ownerId, step: 'mark', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【迫饮】：选择${cap}张手牌视为"酒"`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: cap,
        }),
      })
      return
    }
    if (prompt.step === 'challenge') {
      const maxHand = Math.max(...alivePlayers(host.state).map((player) => player.zones.hand.length))
      const challengers = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.zones.hand.length === maxHand)
      if (challengers.length !== 1) return
      host.state.poyinChallenger = challengers[0].id
      host.askSkill({
        skillId: POYIN, ownerId, step: 'challenge', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: challengers[0].id,
          prompt: '【迫饮】：质疑曹豹手牌中"酒"多于非"酒"？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '质疑' }, { id: 'no', label: '不质疑' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'mark') {
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      host.state.caobaoJiuCardIds ??= {}
      host.state.caobaoJiuCardIds[ownerId] = picked
      if (picked.length > 0) host.dispatch('SkillActivated', { skillId: POYIN, skillName: '迫饮', playerId: ownerId, logText: `${owner.nickname}发动【迫饮】，${picked.length}张手牌视为"酒"` }, { sourceId: ownerId, cardIds: picked })
      return
    }
    if (resolution.step === 'challenge') {
      const challengerId = host.state.poyinChallenger
      host.state.poyinChallenger = undefined
      if (!challengerId || (response.payload as { optionId?: string }).optionId !== 'yes') return
      const jiuIds = host.state.caobaoJiuCardIds?.[ownerId] ?? []
      const jiuCount = jiuIds.filter((id) => owner.zones.hand.includes(id)).length
      const nonJiuCount = owner.zones.hand.length - jiuCount
      const success = jiuCount > nonJiuCount
      if (success) {
        const cardId = host.state.zones.drawPile.find((id) => host.state.cards[id]?.name === '杀')
        if (cardId) {
          moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: challengerId })
          host.dispatch('GainCard', { playerId: challengerId, cardIds: [cardId], reason: `${POYIN}:challenge` }, { targetId: challengerId, cardIds: [cardId] })
        }
        host.dispatch('SkillActivated', { skillId: POYIN, skillName: '迫饮', playerId: challengerId, logText: `质疑成功，${playerOf(host.state, challengerId)?.nickname ?? ''}获得了一张【杀】` }, { sourceId: challengerId })
      } else {
        host.askSkill({
          skillId: POYIN, ownerId, step: 'recast', data: {},
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: '【迫饮】：质疑失败，可以重铸任意张牌', timeoutMs: 20_000, optional: true,
            purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: owner.zones.hand.length,
          }),
        })
      }
      return
    }
    if (resolution.step === 'recast') {
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (picked.length === 0) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: POYIN }, { sourceId: ownerId, cardIds: picked })
      drawCards(host.state, host.rng, ownerId, picked.length, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: POYIN, skillName: '迫饮', playerId: ownerId, logText: `${owner.nickname}发动【迫饮】，重铸了${picked.length}张牌` }, { sourceId: ownerId })
    }
  },
  viewAs(state, ownerId) {
    const ids = state.caobaoJiuCardIds?.[ownerId] ?? []
    const owner = playerOf(state, ownerId)
    return ids.filter((id) => owner?.zones.hand.includes(id)).map((cardId) => ({ asCardName: '酒', cardId, label: '视为酒' }))
  },
})

registerSkillRuntime({
  id: YANJIU,
  incomingDamage(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    if (!owner?.marks.yanjiuNextSlashBonus || context.cardName !== '杀') return null
    owner.marks.yanjiuNextSlashBonus = 0
    return { amount: context.amount + 1 }
  },
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { asCardName?: string; cardId?: CardId }
        if (payload.asCardName !== '酒' && host.state.cards[payload.cardId ?? '']?.name !== '酒') return
        const jiuIds = host.state.caobaoJiuCardIds?.[ownerId]
        if (!jiuIds || !payload.cardId || !jiuIds.includes(payload.cardId)) return
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks.yanjiuWineUses = (owner.marks.yanjiuWineUses ?? 0) + 1
      },
    },
    {
      // 引擎没有单独的"轮次结束"事件，用下一轮开始时结算上一轮的账
      event: 'RoundStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const x = owner.marks.yanjiuWineUses ?? 0
        owner.marks.yanjiuWineUses = 0
        if (x > 0) {
          loseHp(host as never, ownerId, x, YANJIU)
          host.queueSkill({ skillId: YANJIU, ownerId, step: 'target', data: {} })
        } else if (owner.hp < owner.maxHp) {
          recover(host as never, ownerId, 1, YANJIU)
        }
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: YANJIU, ownerId, step: 'target', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【厌酒】：选择一名其他角色，其下次受到的【杀】伤害+1', timeoutMs: 20_000, optional: true,
        options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    target.marks.yanjiuNextSlashBonus = 1
    host.dispatch('SkillActivated', { skillId: YANJIU, skillName: '厌酒', playerId: ownerId, targetId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【厌酒】` }, { sourceId: ownerId, targetId })
  },
})

/* ============================== 张裕 ============================== */

const XIANGCHEN = 'xiangchen'
const MINGDING = 'mingding'

function offerXiangchen(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  host.queueSkill({ skillId: XIANGCHEN, ownerId, step: 'target', data: {} })
}

registerSkillRuntime({
  id: XIANGCHEN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase === 'play' && payload.playerId === ownerId) {
          if (usedThisTurn(host.state, ownerId, XIANGCHEN)) return
          markUsedThisTurn(host.state, ownerId, XIANGCHEN)
          offerXiangchen(host as never, ownerId)
          return
        }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        for (const source of [...(host.state.xiangchenGrantSources?.[ownerId] ?? [])]) {
          replaceTemporarySkill(host.state, source.targetId, `zhangyu-xiangchen:${source.targetId}`, null)
        }
        if (host.state.xiangchenGrantSources) delete host.state.xiangchenGrantSources[ownerId]
      },
    },
    {
      // "可以再次发动"：不受出牌阶段限一次约束，直接绕过 markUsedThisTurn 那道闸门
      event: 'LoseHp',
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId && payload.playerId !== host.state.zhangyuXiangchenLastTargetId) return
        offerXiangchen(host as never, ownerId)
      },
    },
    {
      event: 'Recover',
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId && payload.playerId !== host.state.zhangyuXiangchenLastTargetId) return
        offerXiangchen(host as never, ownerId)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'target') {
      const candidates = alivePlayers(host.state)
      if (candidates.length === 0) return
      host.askSkill({
        skillId: XIANGCHEN, ownerId, step: 'target', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【相谶】：选择一名角色作为筛选依据（可以放弃）', timeoutMs: 20_000, optional: true,
          options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'pick') {
      const { candidates } = prompt.data as { candidates: Array<{ id: string; name: string; characterName: string }> }
      const historyCount = (host.state.zhangyuXiangchenHistory?.[ownerId] ?? []).length
      if (historyCount >= 3) {
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: XIANGCHEN, skillName: '相谶', playerId: ownerId, logText: `${owner.nickname}发动【相谶】，已获得3个技能，改为摸1张牌` }, { sourceId: ownerId })
        return
      }
      host.askSkill({
        skillId: XIANGCHEN, ownerId, step: 'pick', data: { candidates, targetId: (prompt.data as { targetId?: string }).targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【相谶】：选择获得一个技能', timeoutMs: 20_000, optional: false,
          options: candidates.map((c) => ({ id: c.id, label: `${c.name}（${c.characterName}）` })),
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'target') {
      const targetId = (response.payload as { optionId?: string }).optionId
      if (!targetId || targetId === 'none') return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      host.state.zhangyuXiangchenLastTargetId = targetId
      const targetKingdom = effectiveKingdomOf(host.state, targetId)
      if (!targetKingdom) return
      const pool = skillPoolByKingdomAndMaxHp(targetKingdom, target.maxHp)
        .filter((skill) => skillIsRandomlyGrantable(skill.id))
      if (pool.length === 0) return
      const shuffled = [...pool]
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = host.rng.nextInt(i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      const candidates = shuffled.slice(0, 3).map((skill) => ({ id: skill.id, name: skill.name, characterName: skill.characterName }))
      if (candidates.length === 0) return
      host.queueSkill({ skillId: XIANGCHEN, ownerId, step: 'pick', data: { candidates, targetId } })
      return
    }
    if (resolution.step === 'pick') {
      const { candidates } = resolution.data as { candidates: Array<{ id: string; name: string }>; targetId: string }
      const skillId = (response.payload as { optionId?: string }).optionId
      const picked = candidates.find((c) => c.id === skillId)
      if (!picked) return
      replaceTemporarySkill(host.state, ownerId, `zhangyu-xiangchen:${ownerId}`, picked.id)
      host.state.xiangchenGrantSources ??= {}
      host.state.xiangchenGrantSources[ownerId] ??= []
      host.state.xiangchenGrantSources[ownerId].push({ targetId: ownerId })
      host.state.zhangyuXiangchenHistory ??= {}
      host.state.zhangyuXiangchenHistory[ownerId] ??= []
      if (!host.state.zhangyuXiangchenHistory[ownerId].includes(picked.id)) host.state.zhangyuXiangchenHistory[ownerId].push(picked.id)
      host.dispatch('SkillActivated', { skillId: XIANGCHEN, skillName: '相谶', playerId: ownerId, logText: `${owner.nickname}发动【相谶】，获得了【${picked.name}】` }, { sourceId: ownerId })
    }
  },
})

registerSkillRuntime({
  id: MINGDING,
  limited: true,
  dyingIntercept(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(MINGDING)) return false
    owner.usedLimitedSkills.push(MINGDING)
    replaceTemporarySkills(host.state, ownerId, `zhangyu-xiangchen:${ownerId}`, [])
    owner.grantedSkills = (owner.grantedSkills ?? []).filter((skillId) => skillId === MINGDING)
    owner.hp = 1
    host.state.zhangyuDamagePreventionUntilTurn = host.state.turnNumber + 1
    host.dispatch('SkillActivated', { skillId: MINGDING, skillName: '命定', playerId: ownerId, logText: `${owner.nickname}发动【命定】` }, { sourceId: ownerId })
    const cap = Math.min(5, (host.state.zhangyuXiangchenHistory?.[ownerId] ?? []).length)
    if (cap > 0) drawCards(host.state, host.rng, ownerId, cap, (n, p) => { host.dispatch(n, p) })
    const history = host.state.zhangyuXiangchenHistory?.[ownerId] ?? []
    const shuffled = [...history]
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = host.rng.nextInt(i + 1)
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    for (const skillId of shuffled.slice(0, 3)) replaceTemporarySkills(host.state, ownerId, `zhangyu-mingding-skill:${skillId}`, [skillId])
    return true
  },
  preventsDamage(state, ownerId) {
    if ((state.zhangyuDamagePreventionUntilTurn ?? -1) < state.turnNumber) return false
    return playerOf(state, ownerId)?.usedLimitedSkills.includes(MINGDING) ?? false
  },
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (!owner.usedLimitedSkills.includes(MINGDING)) return
      if (host.state.turnNumber < (host.state.zhangyuDamagePreventionUntilTurn ?? Infinity)) return
      host.state.zhangyuDamagePreventionUntilTurn = undefined
      if (owner.hp <= 0) return
      loseHp(host as never, ownerId, owner.hp, MINGDING)
    },
  }],
})

/* ============================== 角色定义 ============================== */

export const HISTORICAL_BATCH20_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'zhouqun', name: '周群', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: TIANHOU, name: '天候', locked: true, description: '锁定技，结束阶段，你观看牌堆顶的三张牌，并可以用任意数量的手牌等量交换，然后展示其中的一张，令一名角色获得对应花色的天气技能，直到你下次发动天候：红桃-烈暑，方块-凝雾，黑桃-骤雨，梅花-严霜。' },
      { id: CHANSHUO, name: '谶说', description: '准备阶段，你可以令一名角色展示一张手牌，然后亮出牌堆顶一张牌，若两张牌的牌型/花色/点数/牌名字数存在相同项，且本次通过谶说已亮出的牌堆牌不足三张，则重复此过程，然后你获得所有通过谶说亮出的牌堆牌。' },
      { id: LIESHU, name: '烈暑', locked: true, granted: true, description: '锁定技，其他角色的结束阶段，若其体力值是全场最高，其失去1点体力。' },
      { id: NINGWU, name: '凝雾', locked: true, granted: true, description: '锁定技，当一名其他角色使用【杀】指定不与其相邻的角色为唯一目标时，进行判定，若结果的点数大于此【杀】的点数，此【杀】无效。' },
      { id: ZHOUYU_WEATHER, name: '骤雨', locked: true, granted: true, description: '锁定技，防止其他角色造成的火焰伤害；当一名角色受到雷电伤害后，与其相邻的角色各失去1点体力。' },
      { id: YANSHUANG, name: '严霜', locked: true, granted: true, description: '锁定技，其他角色的结束阶段，若其体力值是全场最低，其失去1点体力。' },
    ],
  },
  {
    id: 'puyuan', name: '蒲元', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: QISI, name: '奇思', description: '游戏开始时，你随机获得两张不同副类别的装备牌置入你的装备区。摸牌阶段，你可以少摸一张牌，然后声明一种装备类别，从牌堆或弃牌堆中随机获得一张对应的牌。' },
      { id: SHENGONG, name: '神工', description: '出牌阶段，你可以弃置一张武器/防具/坐骑牌，锻造出一张对应类别的装备牌置入一名角色的装备区（每种类别每回合限一次）；由此进入弃牌堆的装备牌改为销毁，你于当前回合结束阶段摸等量的牌。' },
    ],
  },
  {
    id: 'mayuanyi', name: '马元义', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: JIBING, name: '集兵', description: '摸牌阶段，若你的"兵"数小于场上势力数，你可以改为将牌堆顶两张牌置于你的武将牌上，称为"兵"；你可以将一张"兵"当【杀】、【闪】使用或打出。' },
      { id: WANGJING, name: '往京', locked: true, description: '锁定技，当你将"兵"当【杀】、【闪】使用或打出时，若对方是全场体力值最大的角色之一，你摸一张牌。' },
      { id: MOUCUAN, name: '谋篡', description: '觉醒技，准备阶段，若你的"兵"数不小于场上势力数，你减1点体力上限并获得技能"兵祸"。' },
      { id: BINGHUO, name: '兵祸', granted: true, description: '一名角色的结束阶段，若你本回合将"兵"当【杀】、【闪】使用或打出过，你可以令一名角色进行一次判定，若结果为黑色，你对其造成1点雷电伤害。' },
    ],
  },
  {
    id: 'luotong', name: '骆统', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: RENZHENG, name: '仁政', locked: true, description: '锁定技，当任意一次伤害被减少或防止后，你摸两张牌（同一次伤害只触发一次）。' },
      { id: JINJIAN, name: '进谏', description: '你即将造成伤害时，可以令此伤害+1，然后本回合你下次造成的伤害-1，且不能再发动进谏；你即将受到伤害时，可以令此伤害-1，然后本回合你下次受到的伤害+1，且不能再发动进谏。' },
    ],
  },
  {
    id: 'xianglang', name: '向朗', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: KANJI, name: '勘集', description: '出牌阶段限两次，你可以展示所有手牌，若这些手牌花色均不同，你摸两张牌；若此时你的手牌中黑桃/红桃/梅花/方块齐全，你跳过本回合的弃牌阶段。' },
      { id: QIANZHENG, name: '愆正', description: '每轮限两次，你成为其他角色使用的【杀】或普通非延时锦囊牌的目标时，你可以重铸两张类型均与之不同的手牌；此牌结算完毕后，你可以获得之。' },
    ],
  },
  {
    id: 'liuxuan', name: '刘璿', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: MOGUI, name: '漠规', description: '你的回合内，你有以下三个选项，每执行一项后将其永久移除，直到遵谏重置或你失去此技能：判定阶段开始时，你可以令一名角色回复1点体力，然后弃置其判定区里的牌；摸牌阶段开始时，你可以令一名角色本阶段摸牌数+1、【杀】使用次数+1；弃牌阶段开始时，你可以弃置至多五张牌，然后令一名角色摸等量的牌。' },
      { id: ZUNJIAN, name: '遵谏', description: '觉醒技，你的回合开始时，若【漠规】的三个选项均已被移除，你回复1点体力，然后选择一项：摸两张牌，重置【漠规】；或再回复1点体力，然后失去【漠规】，并永久修改【仁诚】。' },
      { id: RENCHENG, name: '仁诚', description: '出牌阶段限一次，你摸两张牌，然后可以将至多两张牌交给一名其他角色（被【遵谏】修改后：摸三张牌，可以交给一名其他角色至多三张牌；若这些牌中包含基本牌，目标角色本回合使用牌无距离限制；若包含普通锦囊，你可以弃置一名角色区域内一张牌；若包含装备牌，你与目标角色各回复1点体力）。' },
    ],
  },
  {
    id: 'xunxu', name: '荀勖', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: DIYIN, name: '笛音', locked: true, description: '锁定技，你每失去七次牌，下一张将进入弃牌堆的牌改为由你获得；你受到伤害后，所有体力值与你相同的角色各摸一张牌。' },
      { id: BOQIA, name: '博洽', description: '每轮限一次，你可以将三张牌当任意基本牌或非伤害类普通锦囊使用（若这些牌花色均不同或牌型均不同，视为本回合未发动）；此牌结算完毕后，你可以令一名角色的手牌数调整至其体力上限；每种牌名每回合限一次。' },
    ],
  },
  {
    id: 'mamiao', name: '马邈', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: ZHANGGUAN, name: '仗关', description: '每个回合开始时，你可以将你的手牌数调整至体力值；若因此没有变化，你回复1点体力；若因此减少，你获得当前回合角色一张牌（你自己的回合除外）。' },
      { id: CONGFENG, name: '从风', locked: true, description: '锁定技，你不因【从风】获得其他角色的牌后，你额外随机获得其一张牌；其他角色不因【从风】获得你的牌后，你额外随机获得其一张牌。' },
    ],
  },
  {
    id: 'caobao', name: '曹豹', kingdom: 'qun', gender: 'male', maxHp: 5, initialHp: 4, pack: 'sp',
    skills: [
      { id: POYIN, name: '迫饮', locked: true, description: '锁定技，你回合开始时摸体力上限张牌，然后选择等量于已损失体力值或体力值的手牌视为"酒"；你回合结束时，若全场手牌数最多的角色唯一，其可以质疑你手牌中"酒"是否多于非"酒"，质疑成功获得一张【杀】，失败你可以重铸任意张牌。' },
      { id: YANJIU, name: '厌酒', locked: true, description: '锁定技，轮次结束时，你本轮次因【迫饮】视为"酒"的牌被使用/打出过X次，你失去X点体力；若X大于0，你选择一名其他角色，其下次受到【杀】的伤害+1；若X为0，你回复1点体力。' },
    ],
  },
  {
    id: 'zhangyu', name: '张裕', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: XIANGCHEN, name: '相谶', description: '出牌阶段限一次，你选择一名角色，随机从武将势力与其相同、体力上限与其相同的技能中展示三个，你选择一个获得，直到你当前回合结束（若你已通过相谶获得过三个技能，改为摸一张牌）；你的体力值变化，或上次相谶目标的体力值变化后，你可以再次发动相谶。' },
      { id: MINGDING, name: '命定', description: '限定技，你进入濒死状态时，你可以失去除【命定】外的所有技能，然后回复至1点体力，防止你直到下个回合结束受到的所有伤害，然后摸X张牌（X为你本局通过相谶曾经获得过的不同技能数，最多5），随机重新获得本局相谶历史技能池中至多三个技能；下个回合结束时，你失去所有体力，进入濒死状态。' },
    ],
  },
]
