import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { resolveDamage } from '../../engine/damage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 吕玲绮（三国杀 OL 新版身份 SP，绮武/妆戎——不是一将成名帼武版）。
 *
 * 【绮武】：出牌阶段限一次，弃置任意张牌（至少1张），X=弃牌花色种类数，
 *          视为使用一张无距离限制、无次数限制的【杀】；目标需要弃置X张牌
 *          （不足则弃全部）；若弃牌中含【闪】，吕玲绮获得这些【闪】且本回
 *          合不计入手牌上限；若完全不含【闪】，此杀不可响应。
 * 【妆戎】：锁定技，回合开始时从4件专属装备（本批新增：无双方天戟/束发
 *          紫金冠/红锦百花袍/玲珑狮蛮带，因项目装备栏无"宝物"类型，紫金冠
 *          借用 weapon2 槽位）中随机选一件装入对应空置装备栏；本回合内
 *          这些装备效果发动达2次且本局未曾成长过，则体力上限+1、回复1点。
 */

const QIWU = 'qiwu'
const ZHUANGRONG = 'zhuangrong'

const ITEM_WUSHUANG = '无双方天戟'
const ITEM_ZIJIN = '束发紫金冠'
const ITEM_BAIHUA = '红锦百花袍'
const ITEM_SHIMAN = '玲珑狮蛮带'
const ITEMS: Array<{ name: string; slot: EquipmentSlot; attackRange?: number }> = [
  { name: ITEM_WUSHUANG, slot: 'weapon', attackRange: 4 },
  { name: ITEM_ZIJIN, slot: 'weapon2' },
  { name: ITEM_BAIHUA, slot: 'armor' },
  { name: ITEM_SHIMAN, slot: 'defensiveHorse' },
]

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function locateCardAnywhere(state: SanguoshaState, cardId: CardId): { kind: 'hand' | 'equipment'; playerId: PlayerId; slot?: EquipmentSlot } | { kind: 'drawPile' | 'discardPile' } | null {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  for (const player of state.players) {
    if (player.zones.hand.includes(cardId)) return { kind: 'hand', playerId: player.id }
    for (const [slot, id] of Object.entries(player.zones.equipment)) {
      if (id === cardId) return { kind: 'equipment', playerId: player.id, slot: slot as EquipmentSlot }
    }
  }
  return null
}

function recordActivation(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  const turnMark = 'zhuangrong-count-turn'
  if (owner.marks[turnMark] !== host.state.turnNumber) {
    owner.marks[turnMark] = host.state.turnNumber
    owner.marks['zhuangrong-count'] = 0
  }
  owner.marks['zhuangrong-count'] = (owner.marks['zhuangrong-count'] ?? 0) + 1
}

registerSkillRuntime({
  id: QIWU,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(QIWU)) return []
    return [{ id: QIWU, label: '绮武：弃任意张牌，视为使用无距离/次数限制的杀' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== QIWU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(QIWU)) return
    host.askSkill({
      skillId: QIWU, ownerId, step: 'pick-discard', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【绮武】：弃置任意张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-discard') {
      const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (cardIds.length === 0) return
      owner.turnUsedSkills.push(QIWU)
      const suits = new Set(cardIds.map((id) => host.state.cards[id]?.suit).filter(Boolean))
      const x = suits.size
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: QIWU }, { sourceId: ownerId, cardIds })
      host.dispatch('SkillActivated', { skillId: QIWU, skillName: '绮武', playerId: ownerId, logText: `${owner.nickname}发动【绮武】，弃${cardIds.length}张牌（X=${x}）` }, { sourceId: ownerId })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: QIWU, ownerId, step: 'pick-target', data: { x, ownDiscards: cardIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【绮武】：选择目标（无距离限制）', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-target') {
      const { x, ownDiscards } = resolution.data as { x: number; ownDiscards: CardId[] }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const n = Math.min(x, target.zones.hand.length)
      if (n === 0) { finishQiwu(host, ownerId, targetId, ownDiscards, []); return }
      host.askSkill({
        skillId: QIWU, ownerId, step: 'target-discard', data: { targetId, ownDiscards, n },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: `【绮武】：弃置${n}张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: n, max: n,
        }),
      })
      return
    }

    if (resolution.step === 'target-discard') {
      const { targetId, ownDiscards } = resolution.data as { targetId: PlayerId; ownDiscards: CardId[] }
      const target = playerOf(host.state, targetId)
      const chosen = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => target?.zones.hand.includes(id))
      if (!target?.alive) return
      for (const cardId of chosen) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      if (chosen.length > 0) host.dispatch('LoseCard', { playerId: targetId, cardIds: chosen, reason: QIWU }, { sourceId: ownerId, targetId, cardIds: chosen })
      finishQiwu(host, ownerId, targetId, ownDiscards, chosen)
    }
  },
  handLimitExempt(state, ownerId, cardId) {
    const entry = state.lvlingqiQiwuDodge?.[ownerId]
    return !!entry && entry.turnNumber === state.turnNumber && entry.cardIds.includes(cardId)
  },
  slashUndodgeable(state, ownerId, targetId) {
    const pending = state.lvlingqiQiwuPending
    return !!pending && pending.ownerId === ownerId && pending.targetId === targetId && pending.noDodge
  },
  triggers: [{
    event: 'CardResolved',
    handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId) host.state.lvlingqiQiwuPending = undefined
    },
  }],
})

function finishQiwu(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, ownDiscards: CardId[], targetDiscards: CardId[]): void {
  const allDiscards = [...ownDiscards, ...targetDiscards]
  const dodgeIds = allDiscards.filter((id) => host.state.cards[id]?.name === '闪' && host.state.zones.discardPile.includes(id))
  if (dodgeIds.length > 0) {
    for (const cardId of dodgeIds) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: dodgeIds, reason: QIWU }, { targetId: ownerId, cardIds: dodgeIds })
    host.state.lvlingqiQiwuDodge ??= {}
    host.state.lvlingqiQiwuDodge[ownerId] = { turnNumber: host.state.turnNumber, cardIds: dodgeIds }
  }
  host.state.lvlingqiQiwuPending = { ownerId, targetId, noDodge: dodgeIds.length === 0 }
  host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: QIWU })
}

function checkZhuangrongAwaken(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || owner.marks['zhuangrong-awakened']) return
  if (owner.marks['zhuangrong-count-turn'] !== host.state.turnNumber || (owner.marks['zhuangrong-count'] ?? 0) < 2) return
  owner.marks['zhuangrong-awakened'] = 1
  owner.maxHp += 1
  recover(host as never, ownerId, 1, ownerId)
  host.dispatch('SkillActivated', { skillId: ZHUANGRONG, skillName: '妆戎', playerId: ownerId, logText: `${owner.nickname}的【妆戎】成长，体力上限+1` }, { sourceId: ownerId })
}

registerSkillRuntime({
  id: ZHUANGRONG,
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const empty = ITEMS.filter((item) => !owner.zones.equipment[item.slot])
        if (empty.length === 0) return
        const pick = empty[host.rng.nextInt(empty.length)]
        let cardId = host.state.lvlingqiItemIds?.[pick.name]
        const from = cardId ? locateCardAnywhere(host.state, cardId) : null
        if (!cardId || !from) {
          cardId = `special:lvlingqi:${pick.name}:${host.state.seq}`
          host.state.cards[cardId] = {
            id: cardId, ruleset: host.state.rulesetVersion, expansion: 'standard', name: pick.name,
            suit: 'spade', rank: 1, color: 'black', category: 'equipment', equipmentSlot: pick.slot,
            ...(pick.attackRange ? { attackRange: pick.attackRange } : {}),
          }
          host.state.lvlingqiItemIds ??= {}
          host.state.lvlingqiItemIds[pick.name] = cardId
          owner.zones.equipment[pick.slot] = cardId
        } else if (from.kind === 'hand' || from.kind === 'equipment') {
          moveCard(host.state, cardId, from.kind === 'hand' ? { kind: 'hand', playerId: from.playerId } : { kind: 'equipment', playerId: from.playerId, slot: from.slot! }, { kind: 'equipment', playerId: ownerId, slot: pick.slot })
        } else {
          moveCard(host.state, cardId, { kind: from.kind }, { kind: 'equipment', playerId: ownerId, slot: pick.slot })
        }
        host.dispatch('SkillActivated', { skillId: ZHUANGRONG, skillName: '妆戎', playerId: ownerId, logText: `${owner.nickname}发动【妆戎】，装备【${pick.name}】` }, { sourceId: ownerId })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.equipment.weapon !== host.state.lvlingqiItemIds?.[ITEM_WUSHUANG]) return
        const payload = context.event.payload as { cardName?: string }
        if (payload.cardName !== '杀') return
        recordActivation(host, ownerId)
        checkZhuangrongAwaken(host, ownerId)
        host.queueSkill({ skillId: ZHUANGRONG, ownerId, step: 'wushuang-ask', data: { targetId: context.event.targetId } })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.equipment.weapon2 !== host.state.lvlingqiItemIds?.[ITEM_ZIJIN]) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: ZHUANGRONG, ownerId, step: 'zijin-ask', data: { candidateIds } })
      },
    },
    {
      event: 'BeforeDamage',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.equipment.armor !== host.state.lvlingqiItemIds?.[ITEM_BAIHUA]) return
        const payload = context.event.payload as { amount?: number }
        const nature = context.event.damageNature
        if (nature !== 'fire' && nature !== 'thunder') return
        payload.amount = 0
        recordActivation(host, ownerId)
        checkZhuangrongAwaken(host, ownerId)
        host.dispatch('SkillActivated', { skillId: ZHUANGRONG, skillName: '妆戎', playerId: ownerId, logText: `${owner.nickname}的【红锦百花袍】防止了属性伤害` }, { sourceId: ownerId })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'wushuang-ask') {
      host.askSkill({
        skillId: ZHUANGRONG, ownerId, step: 'wushuang-choice', data: prompt.data,
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【无双方天戟】：摸1张牌，或弃置目标1张牌', timeoutMs: 20_000, optional: true,
          options: [{ id: 'draw', label: '摸1张牌' }, { id: 'discard', label: '弃置目标1张牌' }, { id: 'none', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'zijin-ask') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: ZHUANGRONG, ownerId, step: 'zijin-choice', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【束发紫金冠】：是否对一名角色造成1点伤害？', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'wushuang-choice') {
      const { targetId } = resolution.data as { targetId?: PlayerId }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      } else if (optionId === 'discard' && targetId) {
        const target = playerOf(host.state, targetId)
        if (target?.alive && target.zones.hand.length > 0) {
          const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
          moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: ZHUANGRONG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        }
      }
      return
    }
    if (resolution.step === 'zijin-choice') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      recordActivation(host, ownerId)
      checkZhuangrongAwaken(host, ownerId)
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
      return
    }
    if (resolution.step === 'shiman-judge') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'yes' || host.state.zones.drawPile.length === 0) { host.resumeCardTarget(); return }
      const cardId = host.state.zones.drawPile[0]
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
      host.dispatch('CardMove', { cardIds: [cardId], reason: ZHUANGRONG, revealed: true }, { sourceId: ownerId })
      recordActivation(host, ownerId)
      checkZhuangrongAwaken(host, ownerId)
      const isHeart = host.state.cards[cardId]?.suit === 'heart'
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      if (isHeart) {
        const current = host.state.cardResolution
        if (current?.kind === 'slash') current.targetCancelled = true
        else if (current?.kind === 'trick' && !current.cancelledTargetIds.includes(ownerId)) current.cancelledTargetIds.push(ownerId)
        host.dispatch('SkillActivated', { skillId: ZHUANGRONG, skillName: '妆戎', playerId: ownerId, logText: `${owner.nickname}的【玲珑狮蛮带】判定为红桃，此牌对其无效` }, { sourceId: ownerId })
      }
      host.resumeCardTarget()
    }
  },
  interceptTarget(host, ownerId, context) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.equipment.defensiveHorse !== host.state.lvlingqiItemIds?.[ITEM_SHIMAN]) return false
    const resolution = host.state.cardResolution
    const singleTarget = resolution?.kind === 'slash' ? true : resolution?.kind === 'trick' ? resolution.targetIds.length === 1 : false
    if (!singleTarget || context.sourceId === ownerId) return false
    host.askSkill({
      skillId: ZHUANGRONG, ownerId, step: 'shiman-judge', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【玲珑狮蛮带】：是否判定？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '判定' }, { id: 'no', label: '不判定' }],
      }),
    })
    return true
  },
})

export const LVLINGQI: CharacterDefinition = {
  id: 'lvlingqi',
  name: '吕玲绮',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: QIWU, name: '绮武', description: '出牌阶段限一次，弃置任意张牌，X=弃牌花色种类数，视为使用一张无距离限制、无次数限制的【杀】；目标弃置X张牌；弃牌中含【闪】则你获得且本回合不计手牌上限，否则此杀不可响应。' },
    { id: ZHUANGRONG, name: '妆戎', description: '锁定技，回合开始时从4件专属装备中随机装入一件空置装备栏；本回合这些装备效果发动达2次且本局未成长过，体力上限+1、回复1点。' },
  ],
}
