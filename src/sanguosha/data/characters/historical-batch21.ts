import { moveCard, setCardAlias } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { resolveDamage, resumeTargetDamagePrevention } from '../../engine/damage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { queueExtraTurn, skipPhase } from '../../engine/turn'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { hiddenHandSlot } from '../../engine/cards/host'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 东吴独立历史人物补完批：吕凯、是仪、吕岱、冯熙、吕据、孙瑜、滕胤、
 * 滕公主、孙綝、滕芳兰。均此前项目未收录，全部作为独立 CharacterDefinition，
 * 不覆盖任何界/谋/族/国战/SP/神版本。
 *
 * 版本口径：吕凯【图南】【闭境】锁当前 OL（不是《一将成名》改版闭境）；
 * 其余九人按用户提供的《一将成名》当前版文本实现。
 *
 * 已知简化（引擎能力边界，非版本/规则错误，详见 commit 说明）：
 * - 吕凯【图南】"直接使用此牌"：只对牌名恰好是【杀】的情形实现（此时与
 *   "当普通杀使用"效果一致）；引擎没有通用的"任意牌类型即时执行"入口，
 *   对非杀的牌只提供"当普通杀使用"这一项，两项都不合法时正常放弃。
 * - 冯熙【驳言】的手牌来源限制简化为"直到本回合结束不能使用/打出任意牌"，
 *   引擎没有按物理来源（手牌 vs 武将牌/技能产牌）区分的通用锁。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function alivePlayers(state: SanguoshaState) {
  return state.players.filter((player) => player.alive)
}

/* ============================== 吕凯 ============================== */

const TUNAN = 'tunan'
const BIJING = 'bijing'

registerSkillRuntime({
  id: TUNAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, TUNAN)) return
      const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
      if (others.length === 0 || host.state.zones.drawPile.length === 0) return
      host.queueSkill({ skillId: TUNAN, ownerId, step: 'pick-target', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'pick-target') {
      const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
      if (others.length === 0 || host.state.zones.drawPile.length === 0) return
      host.askSkill({
        skillId: TUNAN, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【图南】：选择一名其他角色观看牌堆顶一张牌', timeoutMs: 20_000, optional: true,
          options: [...others.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'target-choose') {
      const { targetId, cardId } = prompt.data as { targetId: PlayerId; cardId: CardId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || host.state.zones.drawPile[host.state.zones.drawPile.length - 1] !== cardId) return
      const card = host.state.cards[cardId]
      if (!card) return
      const options: Array<{ id: string; label: string }> = []
      if (card.name === '杀') options.push({ id: 'use', label: `使用（${card.name}）` })
      else options.push({ id: 'as-slash', label: `当普通杀使用（${card.name}）` })
      options.push({ id: 'none', label: '不使用' })
      host.askSkill({
        skillId: TUNAN, ownerId, step: 'target-choose', data: { targetId, cardId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: `【图南】：牌堆顶是${card.name}，选择如何处理（可放弃）`, timeoutMs: 20_000, optional: true, options,
        }),
      })
      return
    }
    if (prompt.step === 'slash-target') {
      const { targetId, cardId } = prompt.data as { targetId: PlayerId; cardId: CardId; asSlash: boolean }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || host.state.zones.drawPile[host.state.zones.drawPile.length - 1] !== cardId) return
      const slashTargets = alivePlayers(host.state).filter((player) => player.id !== targetId)
      if (slashTargets.length === 0) return
      host.askSkill({
        skillId: TUNAN, ownerId, step: 'slash-target', data: prompt.data,
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【图南】：选择杀的目标', timeoutMs: 20_000, optional: true,
          options: [...slashTargets.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不使用' }],
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
      const cardId = host.state.zones.drawPile[host.state.zones.drawPile.length - 1]
      if (!cardId) return
      markUsedThisTurn(host.state, ownerId, TUNAN)
      host.queueSkill({ skillId: TUNAN, ownerId, step: 'target-choose', data: { targetId, cardId } })
      return
    }
    if (resolution.step === 'target-choose') {
      const { targetId, cardId } = resolution.data as { targetId: PlayerId; cardId: CardId }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!optionId || optionId === 'none' || host.state.zones.drawPile[host.state.zones.drawPile.length - 1] !== cardId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const slashTargets = alivePlayers(host.state).filter((player) => player.id !== targetId)
      if (slashTargets.length === 0) return
      host.queueSkill({ skillId: TUNAN, ownerId, step: 'slash-target', data: { targetId, cardId, asSlash: optionId === 'as-slash' } })
      return
    }
    if (resolution.step === 'slash-target') {
      const { targetId, cardId, asSlash } = resolution.data as { targetId: PlayerId; cardId: CardId; asSlash: boolean }
      const slashTargetId = (response.payload as { optionId?: string }).optionId
      if (!slashTargetId || slashTargetId === 'none') return
      const target = playerOf(host.state, targetId)
      const slashTarget = playerOf(host.state, slashTargetId)
      if (!target?.alive || !slashTarget?.alive || host.state.zones.drawPile[host.state.zones.drawPile.length - 1] !== cardId) return
      // 图南要求的实体 Card ID 进入 CardUse pipeline：先移入目标手牌，beginVirtualSlash 要求载体牌在使用者手上
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
      if (asSlash) setCardAlias(host.state, cardId, '杀')
      const used = host.beginVirtualSlash({ sourceId: targetId, targetId: slashTargetId, sourceSkillId: TUNAN, cardId })
      if (!used) {
        // 无法合法使用：牌退回牌堆顶，不留在目标手牌里
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'drawPile' }, { toTop: true })
      }
    }
  },
})

registerSkillRuntime({
  id: BIJING,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (payload.phase === 'finish' && payload.playerId === ownerId) {
          if (owner.zones.hand.length === 0) return
          host.queueSkill({ skillId: BIJING, ownerId, step: 'mark', data: {} })
          return
        }
        if (payload.phase === 'prepare' && payload.playerId === ownerId) {
          const cardId = host.state.bijingCardId?.[ownerId]
          if (host.state.bijingCardId) delete host.state.bijingCardId[ownerId]
          if (cardId && owner.zones.hand.includes(cardId)) {
            moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
            host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: BIJING }, { sourceId: ownerId, cardIds: [cardId] })
          }
          return
        }
        if (payload.phase === 'discard' && payload.playerId) {
          if (!host.state.bijingPenalty?.[payload.playerId]) return
          delete host.state.bijingPenalty[payload.playerId]
          const target = playerOf(host.state, payload.playerId)
          if (!target?.alive || target.zones.hand.length === 0) return
          const n = Math.min(2, target.zones.hand.length)
          const picked = [...target.zones.hand].slice(0, n)
          for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: payload.playerId }, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: payload.playerId, cardIds: picked, reason: BIJING }, { sourceId: payload.playerId, cardIds: picked })
        }
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        const cardId = host.state.bijingCardId?.[ownerId]
        if (!cardId || payload.playerId !== ownerId || !(payload.cardIds ?? []).includes(cardId)) return
        if (host.state.currentPlayerId === ownerId) return
        delete host.state.bijingCardId![ownerId]
        host.state.bijingPenalty ??= {}
        host.state.bijingPenalty[host.state.currentPlayerId] = true
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'mark') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: BIJING, ownerId, step: 'mark', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【闭境】：将一张手牌标记为"闭境"（可放弃）', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'mark') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner.zones.hand.includes(cardId)) return
    host.state.bijingCardId ??= {}
    host.state.bijingCardId[ownerId] = cardId
    host.dispatch('SkillActivated', { skillId: BIJING, skillName: '闭境', playerId: ownerId, logText: `${owner.nickname}发动【闭境】` }, { sourceId: ownerId, cardIds: [cardId] })
  },
})

/* ============================== 是仪 ============================== */

const CUICHUAN = 'cuichuan'
const ZHENGXU = 'zhengxu'
const ZUOJIAN = 'zuojian'

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

function equipmentCount(state: SanguoshaState, playerId: PlayerId): number {
  const owner = playerOf(state, playerId)
  if (!owner) return 0
  return Object.values(owner.zones.equipment).filter(Boolean).length
}

registerSkillRuntime({
  id: CUICHUAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0 || usedThisTurn(host.state, ownerId, CUICHUAN)) return
      host.queueSkill({ skillId: CUICHUAN, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      if (owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: CUICHUAN, ownerId, step: 'discard', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【榱椽】：弃置一张手牌（可放弃）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'target') {
      const candidates = alivePlayers(host.state)
      host.askSkill({
        skillId: CUICHUAN, ownerId, step: 'target', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【榱椽】：选择一名角色随机获得一件其未装备类别的装备', timeoutMs: 20_000, optional: false,
          options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: CUICHUAN }, { sourceId: ownerId, cardIds: [cardId] })
      markUsedThisTurn(host.state, ownerId, CUICHUAN)
      host.queueSkill({ skillId: CUICHUAN, ownerId, step: 'target', data: {} })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { optionId?: string }).optionId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const slots: EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']
      const emptyCategories = new Set<'weapon' | 'armor' | 'horse'>()
      for (const slot of slots) {
        if (!target.zones.equipment[slot]) emptyCategories.add(equipmentCategoryOf(slot))
      }
      let gained = false
      for (const category of emptyCategories) {
        const cardId = findEquipmentInPool(host.state, category, host.rng)
        if (!cardId) continue
        const card = host.state.cards[cardId]
        if (!card?.equipmentSlot) continue
        const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
        moveCard(host.state, cardId, from, { kind: 'equipment', playerId: targetId!, slot: card.equipmentSlot })
        gained = true
        break
      }
      host.dispatch('SkillActivated', { skillId: CUICHUAN, skillName: '榱椽', playerId: ownerId, targetId, logText: `${owner.nickname}发动【榱椽】${gained ? '' : '（无合法装备）'}` }, { sourceId: ownerId, targetId })
      const x = equipmentCount(host.state, targetId!)
      if (x > 0) drawCards(host.state, host.rng, ownerId, x, (n, p) => { host.dispatch(n, p) })
      if (x === 4) {
        replaceTemporarySkill(host.state, ownerId, 'shiyi-cuichuan', null)
        const owner2 = playerOf(host.state, ownerId)
        if (owner2) owner2.grantedSkills = (owner2.grantedSkills ?? []).filter((id) => id !== CUICHUAN)
        replaceTemporarySkill(host.state, ownerId, 'shiyi-zuojian', ZUOJIAN)
        queueExtraTurn(host.state, targetId!, { skillId: CUICHUAN, playerId: ownerId })
        host.dispatch('SkillActivated', { skillId: CUICHUAN, skillName: '榱椽', playerId: ownerId, logText: `${owner.nickname}失去【榱椽】，获得【佐谏】` }, { sourceId: ownerId })
      }
    }
  },
})

registerSkillRuntime({
  id: ZHENGXU,
  offersTargetDamagePreventionAsk(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, `${ZHENGXU}:prevent`)) return false
    if (!(owner.marks.zhengxuLostCardThisTurn ?? 0)) return false
    host.queueSkill({ skillId: ZHENGXU, ownerId, step: 'prevent-ask', data: {} })
    return true
  },
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        owner.marks.zhengxuLostCardThisTurn = 1
        const n = payload.cardIds?.length ?? 0
        if (n <= 0) return
        if (!(owner.marks.zhengxuDamagedThisTurn ?? 0) || usedThisTurn(host.state, ownerId, `${ZHENGXU}:draw`)) return
        markUsedThisTurn(host.state, ownerId, `${ZHENGXU}:draw`)
        drawCards(host.state, host.rng, ownerId, n, (name, p) => { host.dispatch(name, p) })
        host.dispatch('SkillActivated', { skillId: ZHENGXU, skillName: '正序', playerId: ownerId, logText: `${owner.nickname}发动【正序】，摸了${n}张牌` }, { sourceId: ownerId })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks.zhengxuDamagedThisTurn = 1
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner) { owner.marks.zhengxuLostCardThisTurn = 0; owner.marks.zhengxuDamagedThisTurn = 0 }
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'prevent-ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !host.state.pendingTargetDamage) return
    host.askSkill({
      skillId: ZHENGXU, ownerId, step: 'prevent-ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【正序】：是否防止即将受到的伤害？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'prevent-ask') return
    const owner = playerOf(host.state, ownerId)
    const yes = (response.payload as { optionId?: string }).optionId === 'yes'
    markUsedThisTurn(host.state, ownerId, `${ZHENGXU}:prevent`)
    if (yes && owner?.alive) {
      resumeTargetDamagePrevention(host as never, true, ZHENGXU)
    } else {
      resumeTargetDamagePrevention(host as never, false)
    }
  },
})

registerSkillRuntime({
  id: ZUOJIAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      owner.marks.zuojianCardUseCount = 0
    },
  }, {
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      void payload
      const owner = playerOf(host.state, ownerId)
      if (owner?.alive && host.state.phase === 'play' && host.state.currentPlayerId === ownerId) {
        owner.marks.zuojianCardUseCount = (owner.marks.zuojianCardUseCount ?? 0) + 1
      }
    },
  }, {
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if ((owner.marks.zuojianCardUseCount ?? 0) < owner.hp) return
      host.queueSkill({ skillId: ZUOJIAN, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: ZUOJIAN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【佐谏】：选择一项', timeoutMs: 20_000, optional: true,
        options: [
          { id: 'draw', label: '装备数比你多的角色各摸一张牌' },
          { id: 'discard', label: '装备数比你少的角色各弃置一张手牌' },
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
    const myCount = equipmentCount(host.state, ownerId)
    if (optionId === 'draw') {
      const targets = alivePlayers(host.state).filter((player) => equipmentCount(host.state, player.id) > myCount)
      for (const target of targets) drawCards(host.state, host.rng, target.id, 1, (n, p) => { host.dispatch(n, p) })
      if (targets.length > 0) host.dispatch('SkillActivated', { skillId: ZUOJIAN, skillName: '佐谏', playerId: ownerId, logText: `${owner.nickname}发动【佐谏】` }, { sourceId: ownerId })
      return
    }
    const targets = alivePlayers(host.state).filter((player) => equipmentCount(host.state, player.id) < myCount && player.zones.hand.length > 0)
    for (const target of targets) {
      const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: ZUOJIAN }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
    }
    if (targets.length > 0) host.dispatch('SkillActivated', { skillId: ZUOJIAN, skillName: '佐谏', playerId: ownerId, logText: `${owner.nickname}发动【佐谏】` }, { sourceId: ownerId })
  },
})

/* ============================== 吕岱 ============================== */

const QINGUO = 'qinguo'

registerSkillRuntime({
  id: QINGUO,
  triggers: [{
    event: 'CardMove',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { cardIds?: CardId[] }
      void payload
      const current = equipmentCount(host.state, ownerId)
      const last = owner.marks.qinguoLastCount ?? current
      owner.marks.qinguoLastCount = current
      if (current === last) return
      if (current === owner.hp) {
        recover(host as never, ownerId, 1, QINGUO)
        host.dispatch('SkillActivated', { skillId: QINGUO, skillName: '勤国', playerId: ownerId, logText: `${owner.nickname}发动【勤国】` }, { sourceId: ownerId })
      }
    },
  }, {
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; playerId?: PlayerId }
      const sourceId = context.event.sourceId
      if (sourceId !== ownerId) return
      if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
      const cardId = payload.cardId
      const card = cardId ? host.state.cards[cardId] : undefined
      if (card?.category !== 'equipment') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
      if (candidates.length === 0) return
      host.queueSkill({ skillId: QINGUO, ownerId, step: 'slash-target', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'slash-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: QINGUO, ownerId, step: 'slash-target', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【勤国】：可以视为使用一张【杀】（可放弃）', timeoutMs: 20_000, optional: true,
        options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'slash-target') return
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: QINGUO })
  },
})

/* ============================== 冯熙 ============================== */

const YUSUI = 'yusui'
const BOYAN = 'boyan'

registerSkillRuntime({
  id: YUSUI,
  triggers: [{
    event: 'BeforeCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { targetIds?: PlayerId[]; cardId?: CardId }
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId) return
      if (!(payload.targetIds ?? []).includes(ownerId)) return
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      if (card?.color !== 'black') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, YUSUI)) return
      markUsedThisTurn(host.state, ownerId, YUSUI)
      host.queueSkill({ skillId: YUSUI, ownerId, step: 'ask', data: { sourceId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { sourceId } = prompt.data as { sourceId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || !source?.alive) return
    host.askSkill({
      skillId: YUSUI, ownerId, step: 'ask', data: { sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【玉碎】：是否失去1点体力并选择一项？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      loseHp(host as never, ownerId, 1, YUSUI)
      const owner2 = playerOf(host.state, ownerId)
      if (!owner2?.alive) return
      host.askSkill({
        skillId: YUSUI, ownerId, step: 'branch', data: { sourceId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【玉碎】：选择一项', timeoutMs: 20_000, optional: false,
          options: [{ id: 'hand', label: '令其弃牌至与你手牌数相同' }, { id: 'hp', label: '令其失去体力至与你体力值相同' }],
        }),
      })
      return
    }
    if (resolution.step === 'branch') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      const me = playerOf(host.state, ownerId)
      if (!me) return
      if (optionId === 'hand') {
        const diff = source.zones.hand.length - me.zones.hand.length
        if (diff > 0) {
          host.askSkill({
            skillId: YUSUI, ownerId, step: 'hand-discard', data: { sourceId, diff },
            build: (requestId): ChooseCardsRequest => ({
              id: requestId, kind: 'choose-cards', playerId: sourceId,
              prompt: `【玉碎】：弃置${diff}张手牌`, timeoutMs: 20_000, optional: false,
              purpose: 'skill', cardIds: [...source.zones.hand], hiddenCardSlots: [], min: diff, max: diff,
            }),
          })
        } else {
          host.dispatch('SkillActivated', { skillId: YUSUI, skillName: '玉碎', playerId: ownerId, targetId: sourceId, logText: `${me.nickname}发动【玉碎】` }, { sourceId: ownerId, targetId: sourceId })
        }
        return
      }
      const hpDiff = source.hp - me.hp
      if (hpDiff > 0) loseHp(host as never, sourceId, hpDiff, YUSUI)
      host.dispatch('SkillActivated', { skillId: YUSUI, skillName: '玉碎', playerId: ownerId, targetId: sourceId, logText: `${me.nickname}发动【玉碎】` }, { sourceId: ownerId, targetId: sourceId })
      return
    }
    if (resolution.step === 'hand-discard') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => source.zones.hand.includes(id))
      if (picked.length === 0) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: picked, reason: YUSUI }, { sourceId: ownerId, targetId: sourceId, cardIds: picked })
      host.dispatch('SkillActivated', { skillId: YUSUI, skillName: '玉碎', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【玉碎】` }, { sourceId: ownerId, targetId: sourceId })
    }
  },
})

registerSkillRuntime({
  id: BOYAN,
  prohibitsCardUse(state, ownerId, context) {
    const target = state.boyanLockedUntilTurnEnd?.[context.userId]
    return target === ownerId && state.turnNumber === (state.boyanLockedTurnNumber?.[context.userId] ?? -1)
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, BOYAN)) return
      const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
      if (others.length === 0) return
      host.queueSkill({ skillId: BOYAN, ownerId, step: 'target', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
    if (others.length === 0) return
    host.askSkill({
      skillId: BOYAN, ownerId, step: 'target', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【驳言】：选择一名其他角色（可放弃）', timeoutMs: 20_000, optional: true,
        options: [...others.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!target?.alive || !owner?.alive) return
    markUsedThisTurn(host.state, ownerId, BOYAN)
    const targetHand = Math.min(target.maxHp, 5)
    const diff = targetHand - target.zones.hand.length
    if (diff > 0) drawCards(host.state, host.rng, targetId, diff, (n, p) => { host.dispatch(n, p) })
    host.state.boyanLockedUntilTurnEnd ??= {}
    host.state.boyanLockedTurnNumber ??= {}
    host.state.boyanLockedUntilTurnEnd[targetId] = ownerId
    host.state.boyanLockedTurnNumber[targetId] = host.state.turnNumber
    host.dispatch('SkillActivated', { skillId: BOYAN, skillName: '驳言', playerId: ownerId, targetId, logText: `${owner.nickname}发动【驳言】` }, { sourceId: ownerId, targetId })
  },
})

/* ============================== 吕据 ============================== */

const ZHENGYUE = 'zhengyue'
const ZHENGYUE_PILE = 'zhengyue'

registerSkillRuntime({
  id: ZHENGYUE,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || (owner.characterPiles[ZHENGYUE_PILE] ?? []).length > 0) return
        if (host.state.zones.drawPile.length === 0) return
        host.queueSkill({ skillId: ZHENGYUE, ownerId, step: 'ask-count', data: {} })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        if (sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId }
        const owner = playerOf(host.state, ownerId)
        const pile = owner?.characterPiles[ZHENGYUE_PILE] ?? []
        if (!owner?.alive || pile.length === 0 || !payload.cardId) return
        const usedCard = host.state.cards[payload.cardId]
        const firstCard = host.state.cards[pile[0]]
        if (!usedCard || !firstCard) return
        const matched = usedCard.rank === firstCard.rank || usedCard.suit === firstCard.suit || usedCard.name === firstCard.name
        if (matched) {
          const firstId = pile[0]
          moveCard(host.state, firstId, { kind: 'characterPile', playerId: ownerId, pile: ZHENGYUE_PILE }, { kind: 'discardPile' })
          drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
          host.dispatch('SkillActivated', { skillId: ZHENGYUE, skillName: '征越', playerId: ownerId, logText: `${owner.nickname}发动【征越】，摸了2张牌` }, { sourceId: ownerId })
          return
        }
        if (!host.state.zones.discardPile.includes(payload.cardId) || pile.length >= 5) return
        // 三项全不同：将刚用过的实体牌置入 pile（此时它应已进入弃牌堆末尾，取回改放 pile）
        moveCard(host.state, payload.cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: ZHENGYUE_PILE })
        const owner2 = playerOf(host.state, ownerId)
        if (owner2) {
          owner2.marks.zhengyueDepositedThisTurn = (owner2.marks.zhengyueDepositedThisTurn ?? 0) + 1
          if (owner2.marks.zhengyueDepositedThisTurn >= 2) owner2.marks.zhengyueNoHandUse = 1
        }
        host.dispatch('SkillActivated', { skillId: ZHENGYUE, skillName: '征越', playerId: ownerId, logText: `${owner.nickname}发动【征越】，将此牌置入征越` }, { sourceId: ownerId })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner) { owner.marks.zhengyueDepositedThisTurn = 0; owner.marks.zhengyueNoHandUse = 0 }
      },
    },
  ],
  // prohibitsCardUse 只按牌名判断（引擎没有把具体 cardId 传进这个钩子），
  // 吕据本身没有手牌以外的牌来源，按牌名挡等价于挡住手牌来源
  prohibitsCardUse(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || !owner.marks.zhengyueNoHandUse) return false
    if (context.userId !== ownerId) return false
    return owner.zones.hand.some((cardId) => state.cards[cardId]?.name === context.cardName)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-count') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const max = Math.min(5, host.state.zones.drawPile.length)
    host.askSkill({
      skillId: ZHENGYUE, ownerId, step: 'ask-count', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【征越】：选择至多${max}张牌堆顶的牌置于武将牌上（可放弃）`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: host.state.zones.drawPile.slice(-max).reverse(), hiddenCardSlots: [], min: 0, max,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask-count') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const top = host.state.zones.drawPile.slice(-Math.min(5, host.state.zones.drawPile.length)).reverse()
    const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => top.includes(id))
    if (picked.length === 0) return
    for (const cardId of picked) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: ZHENGYUE_PILE })
    host.dispatch('SkillActivated', { skillId: ZHENGYUE, skillName: '征越', playerId: ownerId, logText: `${owner.nickname}发动【征越】，将${picked.length}张牌置于武将牌上` }, { sourceId: ownerId, cardIds: picked })
  },
})

/* ============================== 孙瑜 ============================== */

const QUANSHOU = 'quanshou'
const SHEXUE = 'shexue'

registerSkillRuntime({
  id: QUANSHOU,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || !payload.playerId) return
        const target = playerOf(host.state, payload.playerId)
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || !target?.alive) return
        if (target.zones.hand.length > target.maxHp) return
        host.queueSkill({ skillId: QUANSHOU, ownerId, step: 'ask', data: { targetId: target.id } })
      },
    },
    {
      event: 'CardResolved',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { targetCancelled?: boolean }
        const sourceId = context.event.sourceId
        if (!payload.targetCancelled || !sourceId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || host.state.currentPlayerId !== sourceId) return
        if (host.state.quanshouCounterTarget?.[ownerId] !== sourceId) return
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: QUANSHOU, skillName: '劝守', playerId: ownerId, logText: `${owner.nickname}发动【劝守】，摸了1张牌` }, { sourceId: ownerId })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || !payload.playerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner?.alive && host.state.quanshouCounterTarget?.[ownerId] === payload.playerId) delete host.state.quanshouCounterTarget[ownerId]
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    host.askSkill({
      skillId: QUANSHOU, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【劝守】：选择一项令${target.nickname}执行（可放弃）`, timeoutMs: 20_000, optional: true,
        options: [
          { id: 'draw', label: '摸牌至体力上限（至多5），本回合杀次数-1' },
          { id: 'counter', label: '本回合其使用的牌被抵消后你摸1张牌' },
          { id: 'none', label: '不发动' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { targetId } = resolution.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (!optionId || optionId === 'none') return
    if (optionId === 'draw') {
      const targetHand = Math.min(target.maxHp, 5)
      const diff = targetHand - target.zones.hand.length
      if (diff > 0) drawCards(host.state, host.rng, targetId, diff, (n, p) => { host.dispatch(n, p) })
      target.marks.quanshouSlashPenalty = 1
      host.dispatch('SkillActivated', { skillId: QUANSHOU, skillName: '劝守', playerId: ownerId, targetId, logText: `${owner.nickname}发动【劝守】` }, { sourceId: ownerId, targetId })
      return
    }
    host.state.quanshouCounterTarget ??= {}
    host.state.quanshouCounterTarget[ownerId] = targetId
    host.dispatch('SkillActivated', { skillId: QUANSHOU, skillName: '劝守', playerId: ownerId, targetId, logText: `${owner.nickname}发动【劝守】` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: SHEXUE,
  globalSlashUses(state, ownerId) {
    return playerOf(state, ownerId)?.marks.quanshouSlashPenalty ? -1 : 0
  },
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        void ownerId
        const payload = context.event.payload as { cardName?: string; playerId?: PlayerId; asCardName?: string }
        const sourceId = context.event.sourceId
        if (!sourceId || host.state.phase !== 'play' || host.state.currentPlayerId !== sourceId) return
        const name = payload.asCardName ?? payload.cardName
        const card = name ? Object.values(host.state.cards).find((c) => c.name === name) : undefined
        void card
        if (!name) return
        const cardDef = host.state.cards[Object.keys(host.state.cards).find((id) => host.state.cards[id].name === name) ?? '']
        const category = cardDef?.category
        if (category !== 'basic' && !(category === 'trick' && !DELAYED_TRICKS.has(name))) return
        host.state.shexueHistory ??= {}
        host.state.shexueHistory[sourceId] ??= { turnNumber: host.state.turnNumber, names: [] }
        if (host.state.shexueHistory[sourceId].turnNumber !== host.state.turnNumber) {
          host.state.shexueHistory[sourceId] = { turnNumber: host.state.turnNumber, names: [] }
        }
        if (!host.state.shexueHistory[sourceId].names.includes(name)) host.state.shexueHistory[sourceId].names.push(name)
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const prevTurn = host.state.turnNumber - 1
        const prevOwnerId = host.state.shexuePrevTurnOwners?.[prevTurn]
        const names = prevOwnerId ? host.state.shexueHistory?.[prevOwnerId]?.names ?? [] : []
        if (!names.length || owner.zones.hand.length === 0) return
        host.queueSkill({ skillId: SHEXUE, ownerId, step: 'convert', data: { names, sourceLabel: 'prev' } })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        host.state.shexuePrevTurnOwners ??= {}
        host.state.shexuePrevTurnOwners[host.state.turnNumber] = ownerId
        const names = host.state.shexueHistory?.[ownerId]?.names ?? []
        if (names.length === 0) return
        host.state.shexueOffer = { fromTurn: host.state.turnNumber, names }
      },
    },
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const offer = host.state.shexueOffer
        if (!offer) return
        host.state.shexueOffer = undefined
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        host.queueSkill({ skillId: SHEXUE, ownerId, step: 'convert', data: { names: offer.names, sourceLabel: 'offer' } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'convert') return
    const { names } = prompt.data as { names: string[] }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: SHEXUE, ownerId, step: 'convert', data: { names },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【设学】：可以将1张牌当${names.join('/')}中的一张使用（可放弃）`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'convert') return
    const { names } = resolution.data as { names: string[] }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner.zones.hand.includes(cardId) || names.length === 0) return
    setCardAlias(host.state, cardId, names[0])
    host.dispatch('SkillActivated', { skillId: SHEXUE, skillName: '设学', playerId: ownerId, logText: `${owner.nickname}发动【设学】，将一张牌当${names[0]}使用` }, { sourceId: ownerId, cardIds: [cardId] })
  },
})

/* ============================== 滕胤 ============================== */

const CHENJIAN = 'chenjian'
const XIXIU = 'xixiu'

registerSkillRuntime({
  id: CHENJIAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || host.state.zones.drawPile.length === 0) return
      const x = Math.min(owner.marks.chenjianRevealCount ?? 3, 5, host.state.zones.drawPile.length)
      const revealed = host.state.zones.drawPile.slice(-x).reverse()
      for (const cardId of revealed) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
      host.dispatch('SkillActivated', { skillId: CHENJIAN, skillName: '陈见', playerId: ownerId, logText: `${owner.nickname}发动【陈见】，亮出了${revealed.length}张牌` }, { sourceId: ownerId, cardIds: revealed })
      host.state.chenjianRevealed = { ownerId, cardIds: revealed, op1: false, op2: false }
      host.queueSkill({ skillId: CHENJIAN, ownerId, step: 'op1', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const revealed = host.state.chenjianRevealed
    if (!revealed || revealed.ownerId !== ownerId) return
    if (prompt.step === 'op1') {
      if (owner.zones.hand.length === 0) { host.queueSkill({ skillId: CHENJIAN, ownerId, step: 'op2', data: {} }); return }
      host.askSkill({
        skillId: CHENJIAN, ownerId, step: 'op1', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【陈见】操作一：弃置一张牌，选花色（可放弃）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'op1-target') {
      const { suit } = prompt.data as { suit: string }
      const candidates = alivePlayers(host.state)
      host.askSkill({
        skillId: CHENJIAN, ownerId, step: 'op1-target', data: { suit },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【陈见】：选择一名角色获得同花色的亮出牌', timeoutMs: 20_000, optional: false,
          options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
      return
    }
    if (prompt.step === 'op2') {
      const current = host.state.chenjianRevealed
      if (!current || current.cardIds.length === 0) { finishChenjian(host, ownerId); return }
      host.askSkill({
        skillId: CHENJIAN, ownerId, step: 'op2', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【陈见】操作二：使用亮出的一张牌（可放弃）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...current.cardIds], hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const revealed = host.state.chenjianRevealed
    if (!revealed) return
    if (resolution.step === 'op1') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) { host.queueSkill({ skillId: CHENJIAN, ownerId, step: 'op2', data: {} }); return }
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: CHENJIAN }, { sourceId: ownerId, cardIds: [cardId] })
      revealed.op1 = true
      const card = host.state.cards[cardId]
      host.queueSkill({ skillId: CHENJIAN, ownerId, step: 'op1-target', data: { suit: card?.suit ?? 'spade' } })
      return
    }
    if (resolution.step === 'op1-target') {
      const { suit } = resolution.data as { suit: string }
      const targetId = (response.payload as { optionId?: string }).optionId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const current = host.state.chenjianRevealed
      if (target?.alive && current) {
        const matched = current.cardIds.filter((id) => host.state.cards[id]?.suit === suit)
        for (const id of matched) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId! })
        current.cardIds = current.cardIds.filter((id) => !matched.includes(id))
        if (matched.length > 0) host.dispatch('GainCard', { playerId: targetId, cardIds: matched, reason: CHENJIAN }, { sourceId: ownerId, targetId, cardIds: matched })
      }
      host.queueSkill({ skillId: CHENJIAN, ownerId, step: 'op2', data: {} })
      return
    }
    if (resolution.step === 'op2') {
      const current = host.state.chenjianRevealed
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardId && current?.cardIds.includes(cardId)) {
        current.op2 = true
        current.cardIds = current.cardIds.filter((id) => id !== cardId)
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: `${CHENJIAN}:use-prep` }, { sourceId: ownerId, cardIds: [cardId] })
        host.dispatch('SkillActivated', { skillId: CHENJIAN, skillName: '陈见', playerId: ownerId, logText: `${owner.nickname}发动【陈见】，使用了一张亮出的牌` }, { sourceId: ownerId, cardIds: [cardId] })
      }
      finishChenjian(host, ownerId)
    }
  },
})

function finishChenjian(host: SkillHost, ownerId: PlayerId): void {
  const revealed = host.state.chenjianRevealed
  const owner = playerOf(host.state, ownerId)
  if (revealed && revealed.ownerId === ownerId) {
    for (const cardId of revealed.cardIds) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
    if (revealed.op1 && revealed.op2 && owner) {
      owner.marks.chenjianRevealCount = Math.min(5, (owner.marks.chenjianRevealCount || 3) + 1)
    }
    host.state.chenjianRevealed = undefined
  }
  if (owner?.alive && owner.zones.hand.length > 0) {
    const picked = [...owner.zones.hand]
    for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: `${CHENJIAN}:recast` }, { sourceId: ownerId, cardIds: picked })
    drawCards(host.state, host.rng, ownerId, picked.length, (n, p) => { host.dispatch(n, p) })
  }
}

registerSkillRuntime({
  id: XIXIU,
  triggers: [{
    event: 'TargetSpecified',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { targetIds?: PlayerId[]; cardId?: CardId }
      if (!(payload.targetIds ?? []).includes(ownerId)) return
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !card) return
      const hasSameSuit = Object.values(owner.zones.equipment).some((cardId) => cardId && host.state.cards[cardId]?.suit === card.suit)
      if (!hasSameSuit) return
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: XIXIU, skillName: '皙秀', playerId: ownerId, logText: `${owner.nickname}发动【皙秀】，摸了1张牌` }, { sourceId: ownerId })
    },
  }],
  protectsCardFromDiscard(state, ownerId, cardId) {
    const owner = playerOf(state, ownerId)
    if (!owner) return false
    const equipped = Object.values(owner.zones.equipment).filter(Boolean)
    return equipped.length === 1 && equipped[0] === cardId
  },
})

/* ============================== 滕公主 ============================== */

const XINGCHONG = 'xingchong'
const LIUNIAN = 'liunian'

registerSkillRuntime({
  id: XINGCHONG,
  triggers: [{
    event: 'RoundStart',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: XINGCHONG, ownerId, step: 'draw', data: {} })
    },
  }, {
    event: 'LoseCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId) return
      const revealed = host.state.xingchongRevealed?.[ownerId] ?? []
      if (revealed.length === 0) return
      const lost = (payload.cardIds ?? []).filter((id) => revealed.includes(id))
      if (lost.length === 0) return
      host.state.xingchongRevealed![ownerId] = revealed.filter((id) => !lost.includes(id))
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      drawCards(host.state, host.rng, ownerId, lost.length * 2, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: XINGCHONG, skillName: '幸宠', playerId: ownerId, logText: `${owner.nickname}发动【幸宠】，摸了${lost.length * 2}张牌` }, { sourceId: ownerId })
    },
  }, {
    event: 'RoundStart',
    handle(host, ownerId) {
      if (host.state.xingchongRevealed) host.state.xingchongRevealed[ownerId] = []
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'draw') {
      host.askSkill({
        skillId: XINGCHONG, ownerId, step: 'draw', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【幸宠】：可以摸任意张牌（不超过体力上限${owner.maxHp}）`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [], hiddenCardSlots: Array.from({ length: owner.maxHp }, (_, i) => `xingchong-draw-${i}`), min: 0, max: owner.maxHp,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'draw') {
      const n = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).length
      if (n > 0) drawCards(host.state, host.rng, ownerId, n, (name, p) => { host.dispatch(name, p) })
      const remain = owner.maxHp - n
      if (remain <= 0 || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: XINGCHONG, ownerId, step: 'show', data: { cap: Math.min(remain, owner.zones.hand.length) },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【幸宠】：可以展示至多${Math.min(remain, owner.zones.hand.length)}张手牌`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(remain, owner.zones.hand.length),
        }),
      })
      return
    }
    if (resolution.step === 'show') {
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (picked.length === 0) return
      host.state.xingchongRevealed ??= {}
      host.state.xingchongRevealed[ownerId] = [...(host.state.xingchongRevealed[ownerId] ?? []), ...picked]
      host.dispatch('SkillActivated', { skillId: XINGCHONG, skillName: '幸宠', playerId: ownerId, logText: `${owner.nickname}发动【幸宠】，展示了${picked.length}张手牌` }, { sourceId: ownerId, cardIds: picked })
    }
  },
})

registerSkillRuntime({
  id: LIUNIAN,
  maxCardsBonus(state, ownerId) {
    return playerOf(state, ownerId)?.marks.liunianMaxCardsBonus ?? 0
  },
  triggers: [{
    event: 'DeckReshuffled',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { total?: number }
      const total = payload.total ?? 0
      if (total !== 1 && total !== 2) return
      host.state.liunianPending ??= {}
      host.state.liunianPending[ownerId] = [...(host.state.liunianPending[ownerId] ?? []), total]
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      void context
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const pending = host.state.liunianPending?.[ownerId] ?? []
      if (pending.length === 0) return
      host.state.liunianPending![ownerId] = []
      for (const n of pending) {
        if (n === 1) {
          owner.maxHp += 1
          host.dispatch('MaxHpChange', { playerId: ownerId, amount: 1, reason: LIUNIAN }, { targetId: ownerId })
        } else if (n === 2) {
          if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, LIUNIAN)
          owner.marks.liunianMaxCardsBonus = 10
        }
      }
      host.dispatch('SkillActivated', { skillId: LIUNIAN, skillName: '流年', playerId: ownerId, logText: `${owner.nickname}发动【流年】` }, { sourceId: ownerId })
    },
  }],
})

/* ============================== 孙綝 ============================== */

const ZIGU = 'zigu'
const ZUOWEI = 'zuowei'

registerSkillRuntime({
  id: ZIGU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0 || usedThisTurn(host.state, ownerId, ZIGU)) return
      const hasEquipment = alivePlayers(host.state).some((player) => Object.values(player.zones.equipment).some(Boolean))
      if (!hasEquipment) return
      host.queueSkill({ skillId: ZIGU, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      if (owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: ZIGU, ownerId, step: 'discard', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【自固】：弃置一张牌（可放弃）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'target') {
      const candidates: Array<{ id: string; label: string }> = []
      for (const player of alivePlayers(host.state)) {
        for (const [slot, cardId] of Object.entries(player.zones.equipment)) {
          if (!cardId) continue
          candidates.push({ id: `${player.id}:${slot}:${cardId}`, label: `${player.nickname}的${host.state.cards[cardId]?.name ?? ''}` })
        }
      }
      if (candidates.length === 0) return
      host.askSkill({
        skillId: ZIGU, ownerId, step: 'target', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【自固】：选择一张场上装备牌获得', timeoutMs: 20_000, optional: false,
          options: candidates,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ZIGU }, { sourceId: ownerId, cardIds: [cardId] })
      markUsedThisTurn(host.state, ownerId, ZIGU)
      host.queueSkill({ skillId: ZIGU, ownerId, step: 'target', data: {} })
      return
    }
    if (resolution.step === 'target') {
      const value = (response.payload as { optionId?: string }).optionId
      if (!value) return
      const [fromId, slot, cardId] = value.split(':')
      const from = playerOf(host.state, fromId)
      if (!from?.alive || from.zones.equipment[slot as EquipmentSlot] !== cardId) return
      moveCard(host.state, cardId, { kind: 'equipment', playerId: fromId, slot: slot as EquipmentSlot }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZIGU }, { sourceId: ownerId, targetId: fromId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: ZIGU, skillName: '自固', playerId: ownerId, logText: `${owner.nickname}发动【自固】` }, { sourceId: ownerId })
      if (fromId === ownerId) {
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      }
    }
  },
})

registerSkillRuntime({
  id: ZUOWEI,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      if (sourceId !== ownerId) return
      if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const equipCount = Object.values(owner.zones.equipment).filter(Boolean).length
      const x = Math.max(equipCount, 1)
      const payload = context.event.payload as { cardId?: CardId }
      if (owner.zones.hand.length > x) {
        host.state.zuoweiNoResponse ??= {}
        host.state.zuoweiNoResponse[payload.cardId ?? ''] = true
        host.dispatch('SkillActivated', { skillId: ZUOWEI, skillName: '作威', playerId: ownerId, logText: `${owner.nickname}发动【作威】，此牌不可响应` }, { sourceId: ownerId })
        return
      }
      if (owner.zones.hand.length === x) {
        host.queueSkill({ skillId: ZUOWEI, ownerId, step: 'damage', data: {} })
        return
      }
      if (usedThisTurn(host.state, ownerId, ZUOWEI)) return
      markUsedThisTurn(host.state, ownerId, ZUOWEI)
      drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: ZUOWEI, skillName: '作威', playerId: ownerId, logText: `${owner.nickname}发动【作威】，摸了2张牌` }, { sourceId: ownerId })
    },
  }],
  slashUndodgeable(state, ownerId, targetId, cardId) {
    void ownerId
    void targetId
    return Boolean(cardId && state.zuoweiNoResponse?.[cardId])
  },
  trickUnresponsive(state, ownerId, targetId, cardName, cardId) {
    void ownerId
    void targetId
    void cardName
    return Boolean(cardId && state.zuoweiNoResponse?.[cardId])
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'damage') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
    if (others.length === 0) return
    host.askSkill({
      skillId: ZUOWEI, ownerId, step: 'damage', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【作威】：可以对一名其他角色造成1点伤害（可放弃）', timeoutMs: 20_000, optional: true,
        options: [...others.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'damage') return
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const owner = playerOf(host.state, ownerId)
    if (owner) host.dispatch('SkillActivated', { skillId: ZUOWEI, skillName: '作威', playerId: ownerId, targetId, logText: `${owner.nickname}发动【作威】` }, { sourceId: ownerId, targetId })
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
  },
})

/* ============================== 滕芳兰 ============================== */

const LUOCHONG = 'luochong'
const AICHEN = 'aichen'

registerSkillRuntime({
  id: LUOCHONG,
  triggers: [{
    event: 'RoundStart',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const anyDiscardable = alivePlayers(host.state).some((player) => player.zones.hand.length + player.zones.judgingArea.length + Object.values(player.zones.equipment).filter(Boolean).length > 0)
      if (!anyDiscardable) return
      host.state.luochongState = { ownerId, remaining: 4, perTarget: {} }
      host.queueSkill({ skillId: LUOCHONG, ownerId, step: 'loop', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'loop') return
    const state = host.state.luochongState
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !state || state.ownerId !== ownerId || state.remaining <= 0) { host.state.luochongState = undefined; return }
    const candidates = alivePlayers(host.state).filter((player) => player.zones.hand.length + player.zones.judgingArea.length + Object.values(player.zones.equipment).filter(Boolean).length > 0)
    if (candidates.length === 0) { host.state.luochongState = undefined; return }
    host.askSkill({
      skillId: LUOCHONG, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【落宠】：还可弃置${state.remaining}张牌，选择一名角色（可结束）`, timeoutMs: 20_000, optional: true,
        options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '结束' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state.luochongState
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !state) return
    if (resolution.step === 'pick-target') {
      const targetId = (response.payload as { optionId?: string }).optionId
      if (!targetId || targetId === 'none') { finishLuochong(host, ownerId); return }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) { host.queueSkill({ skillId: LUOCHONG, ownerId, step: 'loop', data: {} }); return }
      const visible = [...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea]
      const hidden = target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index))
      host.askSkill({
        skillId: LUOCHONG, ownerId, step: 'pick-cards', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【落宠】：弃置${target.nickname}至多${state.remaining}张牌`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: visible, hiddenCardSlots: hidden, min: 0, max: state.remaining,
        }),
      })
      return
    }
    if (resolution.step === 'pick-cards') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const raw = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || raw.length === 0) { host.queueSkill({ skillId: LUOCHONG, ownerId, step: 'loop', data: {} }); return }
      // 手牌是暗的，响应里拿到的是占位槽，这里按目标当前手牌解析成真实 cardId
      const resolved = raw.map((picked) => {
        const hiddenIndex = target.zones.hand.findIndex((_, index) => hiddenHandSlot(targetId, index) === picked)
        return hiddenIndex >= 0 ? target.zones.hand[hiddenIndex] : picked
      })
      const n = Math.min(resolved.length, state.remaining)
      const picked = resolved.slice(0, n)
      for (const cardId of picked) {
        const zone: 'equipment' | 'judgingArea' | 'hand' = Object.values(target.zones.equipment).includes(cardId) ? 'equipment' : target.zones.judgingArea.includes(cardId) ? 'judgingArea' : 'hand'
        if (zone === 'equipment') {
          const slot = (Object.entries(target.zones.equipment).find(([, id]) => id === cardId) ?? [])[0] as EquipmentSlot
          moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'discardPile' })
        } else if (zone === 'judgingArea') {
          moveCard(host.state, cardId, { kind: 'judgingArea', playerId: targetId }, { kind: 'discardPile' })
        } else {
          moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        }
      }
      host.dispatch('LoseCard', { playerId: targetId, cardIds: picked, reason: LUOCHONG }, { sourceId: ownerId, targetId, cardIds: picked })
      host.dispatch('SkillActivated', { skillId: LUOCHONG, skillName: '落宠', playerId: ownerId, targetId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【落宠】` }, { sourceId: ownerId, targetId, cardIds: picked })
      state.perTarget[targetId] = (state.perTarget[targetId] ?? 0) + picked.length
      if (targetId === ownerId && picked.length > 0) host.state.aichenSelfDiscardedThisRound = true
      state.remaining -= picked.length
      if (state.perTarget[targetId] > 2) state.remaining = Math.min(state.remaining, 3)
      if (state.remaining <= 0) { finishLuochong(host, ownerId); return }
      host.queueSkill({ skillId: LUOCHONG, ownerId, step: 'loop', data: {} })
    }
  },
})

function finishLuochong(host: SkillHost, ownerId: PlayerId): void {
  host.state.luochongState = undefined
  if (host.state.zones.drawPile.length > 80 && host.state.aichenSelfDiscardedThisRound) {
    const owner = playerOf(host.state, ownerId)
    if (owner?.alive) {
      drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: AICHEN, skillName: '哀尘', playerId: ownerId, logText: `${owner.nickname}发动【哀尘】，摸了2张牌` }, { sourceId: ownerId })
    }
  }
  host.state.aichenSelfDiscardedThisRound = false
}

registerSkillRuntime({
  id: AICHEN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || host.state.zones.drawPile.length <= 40) return
      skipPhase(host.state, 'discard')
    },
  }],
  prohibitsOwnResponse(state, ownerId, cardName) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.zones.drawPile.length >= 40) return false
    const cardId = owner.zones.hand.find((id) => state.cards[id]?.name === cardName)
    return Boolean(cardId && state.cards[cardId]?.suit === 'spade')
  },
})

/* ============================== 角色定义 ============================== */

export const HISTORICAL_BATCH21_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'lvkai', name: '吕凯', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: TUNAN, name: '图南', description: '出牌阶段限一次，你令一名其他角色观看牌堆顶一张牌，其可以选择无距离限制地使用这张牌，或将这张牌当普通【杀】使用（若均无法合法使用则技能正常结束，此牌仍留在牌堆顶）。' },
      { id: BIJING, name: '闭境', description: '结束阶段，你可以将一张手牌标记为"闭境"；若"闭境牌"在你回合外离开你的手牌，当前回合角色的弃牌阶段开始时须弃置两张牌；你的准备阶段，你弃置仍在你手牌中的"闭境牌"。' },
    ],
  },
  {
    id: 'shiyi', name: '是仪', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: CUICHUAN, name: '榱椽', description: '出牌阶段限一次，你弃置一张手牌，选择一名角色，其随机获得一件自己未装备类别的装备牌，然后你摸等同于其装备数量的牌；若其装备数量因此为4，你失去【榱椽】，获得【佐谏】，然后其在当前回合结束后获得一个额外回合。' },
      { id: ZHENGXU, name: '正序', description: '每回合限一次，若你本回合已失去过牌，你即将受到伤害时可以防止之；每回合限一次，若你本回合已受到过伤害，你下次失去牌后摸等量的牌。' },
      { id: ZUOJIAN, name: '佐谏', granted: true, description: '锁定技，出牌阶段结束时，若你本阶段使用的牌数不小于你的体力值，你可以选择一项：令所有装备数比你多的角色各摸一张牌；或弃置所有装备数比你少的角色各一张手牌。' },
    ],
  },
  {
    id: 'lvdai', name: '吕岱', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: QINGUO, name: '勤国', description: '你的回合内，你使用装备牌结算完毕后，可以视为对一名其他角色使用一张【杀】；当你装备区里的牌因移动而变化后，若你的装备数与你的体力值相同，你回复1点体力。' },
    ],
  },
  {
    id: 'fengxi', name: '冯熙', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: YUSUI, name: '玉碎', description: '每回合限一次，当你成为其他角色使用的黑色牌的目标后，你可以失去1点体力，然后选择一项：令其弃牌至与你手牌数相同；或令其失去体力至与你体力值相同（均只能向下调整）。' },
      { id: BOYAN, name: '驳言', description: '出牌阶段限一次，选择一名其他角色，其摸牌至其体力上限（最多摸至5张），然后直到本回合结束，其不能使用或打出牌。' },
    ],
  },
  {
    id: 'lvju', name: '吕据', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: ZHENGYUE, name: '征越', description: '回合开始时，若你的武将牌上没有"征越牌"，你可以将牌堆顶至多五张牌置于你的武将牌上；你使用一张牌结算完毕后，若"征越牌"中第一张与之点数、花色、名称任一相同，将其弃置，你摸两张牌；若三者均不同，将这张牌置入"征越牌"（最多五张，通过此法本回合已置入两张后，你本回合不能使用手牌）。' },
    ],
  },
  {
    id: 'sunyu', name: '孙瑜', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: QUANSHOU, name: '劝守', description: '一名角色的回合开始时，若其手牌数不大于其体力上限，你可以令其选择一项：摸牌至体力上限（最多摸至5张），本回合【杀】的使用次数-1；或本回合其使用的牌被抵消后，你摸一张牌。' },
      { id: SHEXUE, name: '设学', description: '你的出牌阶段开始时，你可以将一张牌当上一个回合角色出牌阶段使用过的一张基本牌或非延时锦囊使用（无距离和次数限制）；你的出牌阶段结束时，下一个回合角色可以将一张牌当你本阶段使用过的一张基本牌或非延时锦囊使用（无距离和次数限制）。' },
    ],
  },
  {
    id: 'tengyin', name: '滕胤', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: CHENJIAN, name: '陈见', description: '准备阶段，你亮出牌堆顶X张牌（X初始为3，最多为5），然后你可以依次执行以下操作各一次：一、弃置一张牌，指定一种花色，选择一名角色获得所亮出的牌中该花色的所有牌；二、使用所亮出的牌中的一张。若两项均执行，X+1；然后你重铸所有手牌。' },
      { id: XIXIU, name: '皙秀', description: '锁定技，你成为其他角色使用牌的目标后，若你的装备区里有至少一张牌与之花色相同，你摸一张牌；锁定技，其他角色不能弃置你装备区里的最后一张牌。' },
    ],
  },
  {
    id: 'tenggongzhu', name: '滕公主', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: XINGCHONG, name: '幸宠', description: '每轮开始时，你可以摸任意张牌，然后展示等量或更少的手牌（两者之和不超过你的体力上限）；本轮内，你每因此失去一张展示的牌，摸两张牌。' },
      { id: LIUNIAN, name: '流年', description: '锁定技，game内第一次洗牌后，当前回合结束时你体力上限+1；第二次洗牌后，当前回合结束时你回复1点体力，且本局手牌上限永久+10。' },
    ],
  },
  {
    id: 'sunchen', name: '孙綝', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: ZIGU, name: '自固', description: '出牌阶段限一次，你弃置一张牌，然后获得场上一张装备牌；若你没有因此获得其他角色的装备牌，你摸一张牌。' },
      { id: ZUOWEI, name: '作威', description: '你的回合内，你每使用一张牌，X为你的装备数（至少为1）：若你的手牌数大于X，此牌不可被响应；若等于X，你可以对一名其他角色造成1点伤害；若小于X，你可以摸两张牌（本回合限一次）。' },
    ],
  },
  {
    id: 'tengfanglan', name: '滕芳兰', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: LUOCHONG, name: '落宠', description: '每轮游戏开始时，你可以弃置任意名角色区域内共计至多四张牌（若对同一名角色弃置超过两张，本次可弃置总数上限-1）。' },
      { id: AICHEN, name: '哀尘', description: '锁定技，若牌堆牌数大于80，你发动【落宠】且弃置了自己区域内至少一张牌，你摸两张牌；若牌堆牌数大于40，你跳过弃牌阶段；若牌堆牌数小于40，你不能打出黑桃牌响应。' },
    ],
  },
]
