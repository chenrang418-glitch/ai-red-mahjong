import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { resumeTargetDamagePrevention } from '../../engine/damage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { canUseSlash } from '../../engine/slash-rules'
import {
  abolishSlot, abolishableSlotsOf, equipmentSlotsOf, isSlotAbolished,
} from '../../engine/equipment-slots'
import { handleEquipmentLost, type EquipmentHost } from '../../engine/equipment'
import { createVirtualTrick, virtualTrickChoices } from '../../engine/virtual-trick'
import { instantTrickActions } from '../../engine/cards/tricks'
import { executeUseCardAction } from '../../engine/cards/basic'
import { attackRangeCovers } from '../../engine/ask-use-slash'
import {
  allSkillRuntimes, getSkillRuntime, grantSkill, ownedSkillIds, registerSkillRuntime,
  replaceTemporarySkill, type SkillHost, type ViewAsOption,
} from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 魏晋—汉末独立人物补完批：钟琰、嵇康、宣公主、清河公主、曹宇、薛灵芸、
 * 夏侯令女、刘宏、唐姬、王允。均为项目此前未收录的独立历史人物，采用当前
 * 三国杀OL身份模式版本（宣公主/清河公主为晋/魏OL在线版；夏侯令女因OL无完整
 * 身份页改锁《一将成名》当前版；王濬/司马孚同批先例已用过同样处理）。
 *
 * 钟琰严禁做成族钟琰（不含保族/观骨/啸咏）；王允严禁做成族王允（不含族版
 * 谋逞分支）；清河公主/薛灵芸严禁混入《一将成名》端的同名异文本版本。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ============================== 钟琰 ==============================

const BOLAN = 'bolan'
const YIFA = 'yifa'

/** 博览候选池：从技能运行时表按 bolanEligible 元数据动态过滤，不硬编码具体技能。 */
function bolanCandidates(): string[] {
  return allSkillRuntimes().filter((runtime) => runtime.bolanEligible).map((runtime) => runtime.id)
}

function bolanSkillName(skillId: string): string {
  return getSkillRuntime(skillId) ? skillId : skillId
}

registerSkillRuntime({
  id: BOLAN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || !payload.playerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (payload.playerId === ownerId) {
          host.queueSkill({ skillId: BOLAN, ownerId, step: 'self-ask', data: {} })
        } else {
          host.queueSkill({ skillId: BOLAN, ownerId, step: 'other-offer', data: { targetId: payload.playerId } })
        }
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'self-ask') {
      host.askSkill({
        skillId: BOLAN, ownerId, step: 'self-ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【博览】：是否发动？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'other-offer') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.hp <= 0) return
      host.askSkill({
        skillId: BOLAN, ownerId, step: 'other-offer', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【博览】：是否失去1点体力，令钟琰为你随机选择技能？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '失去1点体力' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'other-pick-start') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const pool = bolanCandidates()
      if (pool.length === 0) return
      const picks = pickThree(host, pool)
      host.askSkill({
        skillId: BOLAN, ownerId, step: 'other-pick', data: { targetId, picks },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【博览】：为${target.nickname}选择获得1个技能（候选${picks.length}个）`, timeoutMs: 20_000, optional: false,
          options: picks.map((id) => ({ id, label: `【${bolanSkillName(id)}】` })),
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'self-ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const pool = bolanCandidates()
      if (pool.length === 0) return
      const picks = pickThree(host, pool)
      host.askSkill({
        skillId: BOLAN, ownerId, step: 'self-pick', data: { picks },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【博览】：选择获得1个技能（本次Play Phase内有效，候选${picks.length}个）`, timeoutMs: 20_000, optional: false,
          options: picks.map((id) => ({ id, label: `【${bolanSkillName(id)}】` })),
        }),
      })
      return
    }
    if (resolution.step === 'self-pick') {
      const skillId = (response.payload as { optionId?: string }).optionId
      if (!skillId) return
      replaceTemporarySkill(host.state, ownerId, BOLAN, skillId)
      host.dispatch('SkillActivated', { skillId: BOLAN, skillName: '博览', playerId: ownerId, logText: `${owner.nickname}发动【博览】，直到本回合结束获得【${bolanSkillName(skillId)}】` }, { sourceId: ownerId })
      return
    }
    if (resolution.step === 'other-offer') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      loseHp(host as never, targetId, 1, BOLAN)
      // loseHp 可能让目标进入濒死，留下一个待回应的救援 Request；不能在同一次
      // resume 里紧接着再问一次，交给 queueSkill 挪到下一个安全点
      host.queueSkill({ skillId: BOLAN, ownerId, step: 'other-pick-start', data: { targetId } })
      return
    }
    if (resolution.step === 'other-pick') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const skillId = (response.payload as { optionId?: string }).optionId
      if (!target?.alive || !skillId) return
      replaceTemporarySkill(host.state, targetId, `${BOLAN}:${targetId}`, skillId)
      host.dispatch('SkillActivated', { skillId: BOLAN, skillName: '博览', playerId: ownerId, targetId, logText: `${owner.nickname}发动【博览】，${target.nickname}直到本回合结束获得【${bolanSkillName(skillId)}】` }, { sourceId: ownerId, targetId })
    }
  },
})

function pickThree(host: SkillHost, pool: string[]): string[] {
  const shuffled = [...pool]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = host.rng.nextInt(i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, 3)
}

registerSkillRuntime({
  id: YIFA,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { sourceId?: PlayerId; targetIds?: PlayerId[]; cardId?: CardId; cardName?: string }
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId) return
      if (!(payload.targetIds ?? []).includes(ownerId)) return
      const card = payload.cardId ? host.state.cards[payload.cardId] : null
      const isSlash = payload.cardName === '杀'
      const isBlackTrick = card && card.category === 'trick' && card.color === 'black' && !isSlash
      if (!isSlash && !isBlackTrick) return
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      host.state.yifaTurnMods = [...(host.state.yifaTurnMods ?? []), { targetId: sourceId, turnNumber: host.state.turnNumber, delta: -1 }]
      host.dispatch('SkillActivated', { skillId: YIFA, skillName: '仪法', playerId: ownerId, targetId: sourceId, logText: `${source.nickname}使用的牌指定钟琰为目标，本回合手牌上限-1` }, { sourceId: ownerId, targetId: sourceId })
    },
  }],
  maxCardsBonus(state, ownerId) {
    return (state.yifaTurnMods ?? [])
      .filter((entry) => entry.targetId === ownerId && entry.turnNumber === state.turnNumber)
      .reduce((sum, entry) => sum + entry.delta, 0)
  },
})

// ============================== 嵇康 ==============================

const QINGXIAN = 'qingxian'
const JUEXIANG = 'juexiang'
const HEXIAN = 'hexian'
const ROUXIAN = 'rouxian'
const LIEXIAN = 'liexian'
const JIXIAN = 'jixian2'
const JUEXIANG_PROTECT = 'juexiang-protect'

function equippableFromDrawPile(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  return state.zones.drawPile.filter((cardId) => {
    const card = state.cards[cardId]
    if (!card || card.category !== 'equipment' || !card.equipmentSlot) return false
    return equipmentSlotsOf(state, playerId).some((slot) => slot === card.equipmentSlot || (card.equipmentSlot === 'weapon' && slot === 'weapon2'))
  })
}

function equipFromDrawPile(host: EquipmentHost & SkillHost, playerId: PlayerId, cardId: CardId): boolean {
  const card = host.state.cards[cardId]
  const player = playerOf(host.state, playerId)
  if (!card || !player || !card.equipmentSlot) return false
  const preferred = card.equipmentSlot === 'weapon'
    ? (equipmentSlotsOf(host.state, playerId).includes('weapon2') && player.zones.equipment.weapon && !player.zones.equipment.weapon2 ? 'weapon2' : 'weapon')
    : card.equipmentSlot
  const slot = preferred as EquipmentSlot
  if (!equipmentSlotsOf(host.state, playerId).includes(slot)) return false
  const replaced = player.zones.equipment[slot]
  moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'equipment', playerId, slot })
  if (replaced) handleEquipmentLost(host, playerId, replaced)
  host.dispatch('CardMove', { cardId, reason: 'equip' }, { targetId: playerId, cardIds: [cardId] })
  return card.suit === 'club'
}

registerSkillRuntime({
  id: QINGXIAN,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId || host.state.dying) return
        const sourceId = context.event.sourceId
        if (!sourceId || sourceId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        const source = playerOf(host.state, sourceId)
        if (!owner?.alive || !source?.alive) return
        host.queueSkill({ skillId: QINGXIAN, ownerId, step: 'ask', data: { targetId: sourceId } })
      },
    },
    {
      event: 'Recover',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId || host.state.dying) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId)
        if (others.length === 0) return
        host.queueSkill({ skillId: QINGXIAN, ownerId, step: 'pick-target', data: {} })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'pick-target') {
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: QINGXIAN, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【清弦】：选择一名其他角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!target?.alive || host.state.dying) return
    host.askSkill({
      skillId: QINGXIAN, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【清弦】：是否令${target.nickname}执行一项？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive || host.state.dying) return
      host.askSkill({
        skillId: QINGXIAN, ownerId, step: 'ask', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【清弦】：是否令${playerOf(host.state, targetId)!.nickname}执行一项？`, timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (resolution.step === 'ask') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      const options: Array<{ id: string; label: string }> = [{ id: 'lose', label: '失去1点体力，随机使用一张装备牌' }]
      if (equipmentSlotsOf(host.state, targetId).some((slot) => target.zones.equipment[slot])) {
        options.push({ id: 'discard', label: '回复1点体力，弃置一张装备牌' })
      }
      host.askSkill({
        skillId: QINGXIAN, ownerId, step: 'choose', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【清弦】：请选择', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }
    if (resolution.step === 'choose') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      host.dispatch('SkillActivated', { skillId: QINGXIAN, skillName: '清弦', playerId: ownerId, targetId, logText: `${owner.nickname}发动【清弦】` }, { sourceId: ownerId, targetId })
      if (optionId === 'lose') {
        loseHp(host as never, targetId, 1, QINGXIAN)
        if (!playerOf(host.state, targetId)?.alive) return
        const candidates = equippableFromDrawPile(host.state, targetId)
        if (candidates.length === 0) return
        const cardId = candidates[host.rng.nextInt(candidates.length)]
        const isClub = equipFromDrawPile(host as never, targetId, cardId)
        if (isClub) drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      } else if (optionId === 'discard') {
        recover(host as never, targetId, 1, ownerId)
        const slot = equipmentSlotsOf(host.state, targetId).find((s) => target.zones.equipment[s])
        if (!slot) return
        const cardId = target.zones.equipment[slot]!
        const isClub = host.state.cards[cardId]?.suit === 'club'
        moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'discardPile' })
        handleEquipmentLost(host as never, targetId, cardId)
        if (isClub) drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      }
    }
  },
})

const JUEXIANG_GRANTS = [
  { id: HEXIAN, name: '和弦' },
  { id: ROUXIAN, name: '柔弦' },
  { id: LIEXIAN, name: '烈弦' },
  { id: JIXIAN, name: '激弦' },
]

registerSkillRuntime({
  id: JUEXIANG,
  triggers: [{
    event: 'Death',
    allowDeadOwner: true,
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: JUEXIANG, ownerId, step: 'pick-target', data: { candidateIds }, allowDeadOwner: true })
    },
  }],
  allowsDeadResponder: true,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    const alive = candidateIds.filter((id) => playerOf(host.state, id)?.alive)
    if (alive.length === 0) return
    host.askSkill({
      skillId: JUEXIANG, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【绝响】：选择一名角色随机获得衍生技能', timeoutMs: 20_000, optional: false,
        candidateIds: alive, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    const owned = new Set(ownedSkillIds(host.state, targetId))
    const pool = JUEXIANG_GRANTS.filter((entry) => !owned.has(entry.id))
    const grants = pool.length > 0 ? pool : JUEXIANG_GRANTS
    const picked = grants[host.rng.nextInt(grants.length)]
    grantSkill(host.state, targetId, picked.id)
    host.state.qinggouEverGranted = [...(host.state.qinggouEverGranted ?? []), targetId]
    replaceTemporarySkill(host.state, targetId, JUEXIANG_PROTECT, JUEXIANG_PROTECT)
    host.state.permanentDamageBonus ??= {}
    host.dispatch('SkillActivated', { skillId: JUEXIANG, skillName: '绝响', playerId: ownerId, targetId, logText: `${target.nickname}通过【绝响】获得【${picked.name}】` }, { sourceId: ownerId, targetId })
  },
})

/** 绝响保护：直到该角色下个真实回合开始前，不能成为其他角色使用梅花牌的目标。 */
registerSkillRuntime({
  id: JUEXIANG_PROTECT,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      replaceTemporarySkill(host.state, ownerId, JUEXIANG_PROTECT, null)
    },
  }],
  prohibitsTarget(state, ownerId, sourceId, cardName, cardId) {
    void cardName
    if (sourceId === ownerId || !cardId) return false
    return state.cards[cardId]?.suit === 'club'
  },
})

registerSkillRuntime({
  id: HEXIAN,
  triggers: [{
    event: 'Recover',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId || host.state.dying) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (others.length === 0) return
      host.queueSkill({ skillId: HEXIAN, ownerId, step: 'pick', data: { candidateIds: others } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    const alive = candidateIds.filter((id) => playerOf(host.state, id)?.alive)
    if (alive.length === 0) return
    host.askSkill({
      skillId: HEXIAN, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【和弦】：选择一名其他角色回复1点体力', timeoutMs: 20_000, optional: true,
        candidateIds: alive, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    recover(host as never, targetId, 1, ownerId)
    host.dispatch('SkillActivated', { skillId: HEXIAN, skillName: '和弦', playerId: ownerId, targetId, logText: `${owner.nickname}发动【和弦】` }, { sourceId: ownerId, targetId })
    const slot = equipmentSlotsOf(host.state, targetId).find((s) => playerOf(host.state, targetId)!.zones.equipment[s])
    if (!slot) return
    const cardId = playerOf(host.state, targetId)!.zones.equipment[slot]!
    moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'discardPile' })
    handleEquipmentLost(host as never, targetId, cardId)
  },
})

registerSkillRuntime({
  id: ROUXIAN,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || host.state.dying) return
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const source = playerOf(host.state, sourceId)
      if (!owner?.alive || !source?.alive) return
      host.queueSkill({ skillId: ROUXIAN, ownerId, step: 'ask', data: { targetId: sourceId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!target?.alive || host.state.dying) return
    host.askSkill({
      skillId: ROUXIAN, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【柔弦】：是否令${target.nickname}回复1点体力？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    recover(host as never, targetId, 1, ownerId)
    host.dispatch('SkillActivated', { skillId: ROUXIAN, skillName: '柔弦', playerId: ownerId, targetId, logText: `${owner.nickname}发动【柔弦】` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: LIEXIAN,
  triggers: [{
    event: 'Recover',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId || host.state.dying) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (others.length === 0) return
      host.queueSkill({ skillId: LIEXIAN, ownerId, step: 'pick', data: { candidateIds: others } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    const alive = candidateIds.filter((id) => playerOf(host.state, id)?.alive)
    if (alive.length === 0) return
    host.askSkill({
      skillId: LIEXIAN, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【烈弦】：选择一名其他角色失去1点体力', timeoutMs: 20_000, optional: true,
        candidateIds: alive, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive) return
    loseHp(host as never, targetId, 1, LIEXIAN)
    host.dispatch('SkillActivated', { skillId: LIEXIAN, skillName: '烈弦', playerId: ownerId, targetId, logText: `${owner.nickname}发动【烈弦】` }, { sourceId: ownerId, targetId })
    if (!playerOf(host.state, targetId)?.alive) return
    const candidates = equippableFromDrawPile(host.state, targetId)
    if (candidates.length === 0) return
    const cardId = candidates[host.rng.nextInt(candidates.length)]
    equipFromDrawPile(host as never, targetId, cardId)
  },
})

registerSkillRuntime({
  id: JIXIAN,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || host.state.dying) return
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const source = playerOf(host.state, sourceId)
      if (!owner?.alive || !source?.alive) return
      host.queueSkill({ skillId: JIXIAN, ownerId, step: 'ask', data: { targetId: sourceId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!target?.alive || host.state.dying) return
    host.askSkill({
      skillId: JIXIAN, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【激弦】：是否令${target.nickname}失去1点体力，随机使用一张装备牌？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    host.dispatch('SkillActivated', { skillId: JIXIAN, skillName: '激弦', playerId: ownerId, targetId, logText: `${owner.nickname}发动【激弦】` }, { sourceId: ownerId, targetId })
    loseHp(host as never, targetId, 1, JIXIAN)
    if (!playerOf(host.state, targetId)?.alive) return
    const candidates = equippableFromDrawPile(host.state, targetId)
    if (candidates.length === 0) return
    const cardId = candidates[host.rng.nextInt(candidates.length)]
    equipFromDrawPile(host as never, targetId, cardId)
  },
})

// ============================== 宣公主 ==============================

const GAOLING = 'gaoling'
const QIMEI = 'qimei'
const ZHUIJI = 'zhuiji'

registerSkillRuntime({
  id: GAOLING,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (host.state.gaolingUsed ?? []).includes(ownerId)) return
      host.state.gaolingUsed = [...(host.state.gaolingUsed ?? []), ownerId]
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.queueSkill({ skillId: GAOLING, ownerId, step: 'pick', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    const alive = candidateIds.filter((id) => playerOf(host.state, id)?.alive)
    if (alive.length === 0) return
    host.askSkill({
      skillId: GAOLING, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【高陵】：选择一名角色回复1点体力', timeoutMs: 20_000, optional: true,
        candidateIds: alive, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive) return
    recover(host as never, targetId, 1, ownerId)
    host.dispatch('SkillActivated', { skillId: GAOLING, skillName: '高陵', playerId: ownerId, targetId, logText: `${owner.nickname}发动【高陵】` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: QIMEI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: QIMEI, ownerId, step: 'pick', data: { candidateIds } })
      },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) { handleQimeiHand(host, ownerId, (context.event.payload as { playerId?: PlayerId }).playerId) },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) { handleQimeiHand(host, ownerId, (context.event.payload as { playerId?: PlayerId }).playerId) },
    },
    {
      event: 'Recover',
      handle(host, ownerId, context) { handleQimeiHp(host, ownerId, (context.event.payload as { playerId?: PlayerId }).playerId) },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) { handleQimeiHp(host, ownerId, context.event.targetId) },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: QIMEI, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【齐眉】：选择一名其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive) return
    host.state.qimeiLink = { ownerId, targetId, expiresTurn: host.state.turnNumber + 1 }
    host.dispatch('SkillActivated', { skillId: QIMEI, skillName: '齐眉', playerId: ownerId, targetId, logText: `${owner.nickname}发动【齐眉】，与${playerOf(host.state, targetId)!.nickname}建立牵绊` }, { sourceId: ownerId, targetId })
  },
})

function handleQimeiHand(host: SkillHost, skillOwnerId: PlayerId, changedId: PlayerId | undefined): void {
  const link = host.state.qimeiLink
  if (!link || link.ownerId !== skillOwnerId) return
  if (changedId !== link.ownerId && changedId !== link.targetId) return
  if (host.state.qimeiHandUsed === host.state.turnNumber) return
  const owner = playerOf(host.state, link.ownerId)
  const target = playerOf(host.state, link.targetId)
  if (!owner?.alive || !target?.alive) return
  if (owner.zones.hand.length !== target.zones.hand.length) return
  host.state.qimeiHandUsed = host.state.turnNumber
  const other = changedId === link.ownerId ? link.targetId : link.ownerId
  drawCards(host.state, host.rng, other, 1, (n, p) => { host.dispatch(n, p) })
  host.dispatch('SkillActivated', { skillId: QIMEI, skillName: '齐眉', playerId: skillOwnerId, targetId: other, logText: `齐眉：手牌数相等，${playerOf(host.state, other)!.nickname}摸1张牌` }, { sourceId: skillOwnerId, targetId: other })
}

function handleQimeiHp(host: SkillHost, skillOwnerId: PlayerId, changedId: PlayerId | undefined): void {
  const link = host.state.qimeiLink
  if (!link || link.ownerId !== skillOwnerId) return
  if (changedId !== link.ownerId && changedId !== link.targetId) return
  if (host.state.qimeiHpUsed === host.state.turnNumber) return
  const owner = playerOf(host.state, link.ownerId)
  const target = playerOf(host.state, link.targetId)
  if (!owner?.alive || !target?.alive) return
  if (owner.hp !== target.hp) return
  host.state.qimeiHpUsed = host.state.turnNumber
  const other = changedId === link.ownerId ? link.targetId : link.ownerId
  drawCards(host.state, host.rng, other, 1, (n, p) => { host.dispatch(n, p) })
  host.dispatch('SkillActivated', { skillId: QIMEI, skillName: '齐眉', playerId: skillOwnerId, targetId: other, logText: `齐眉：体力值相等，${playerOf(host.state, other)!.nickname}摸1张牌` }, { sourceId: skillOwnerId, targetId: other })
}

registerSkillRuntime({
  id: ZHUIJI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: ZHUIJI, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const debts = (host.state.zhuijiDebt ?? []).filter((entry) => entry.ownerId === ownerId && entry.turnNumber === host.state.turnNumber)
        if (debts.length === 0) return
        host.state.zhuijiDebt = (host.state.zhuijiDebt ?? []).filter((entry) => !(entry.ownerId === ownerId && entry.turnNumber === host.state.turnNumber))
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        for (const debt of debts) {
          if (debt.kind === 'losehp1') { loseHp(host as never, ownerId, 1, ZHUIJI); continue }
          const count = Math.min(2, owner.zones.hand.length)
          if (count === 0) continue
          host.queueSkill({ skillId: ZHUIJI, ownerId, step: 'discard', data: { count } })
        }
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      host.askSkill({
        skillId: ZHUIJI, ownerId, step: 'ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【追姬】：请选择', timeoutMs: 20_000, optional: true,
          options: [
            { id: 'recover', label: '立即回复1点体力，本阶段结束时弃置2张牌' },
            { id: 'draw', label: '立即摸2张牌，本阶段结束时失去1点体力' },
          ],
        }),
      })
      return
    }
    if (prompt.step === 'discard') {
      const { count } = prompt.data as { count: number }
      const actual = Math.min(count, owner.zones.hand.length)
      if (actual <= 0) return
      host.askSkill({
        skillId: ZHUIJI, ownerId, step: 'discard', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【追姬】：弃置${actual}张牌`, timeoutMs: 20_000, optional: false,
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: actual, max: actual, purpose: 'skill',
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'recover') {
        recover(host as never, ownerId, 1, ownerId)
        host.dispatch('SkillActivated', { skillId: ZHUIJI, skillName: '追姬', playerId: ownerId, logText: `${owner.nickname}发动【追姬】，立即回复1点体力` }, { sourceId: ownerId })
        host.state.zhuijiDebt = [...(host.state.zhuijiDebt ?? []), { ownerId, kind: 'discard2', turnNumber: host.state.turnNumber }]
      } else if (optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: ZHUIJI, skillName: '追姬', playerId: ownerId, logText: `${owner.nickname}发动【追姬】，立即摸2张牌` }, { sourceId: ownerId })
        host.state.zhuijiDebt = [...(host.state.zhuijiDebt ?? []), { ownerId, kind: 'losehp1', turnNumber: host.state.turnNumber }]
      }
      return
    }
    if (resolution.step === 'discard') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const actual = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (actual.length === 0) return
      for (const cardId of actual) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: actual, reason: ZHUIJI }, { sourceId: ownerId, cardIds: actual })
    }
  },
})

// ============================== 清河公主 ==============================

const ZHENGOU = 'zhengou'
const CHANGJI = 'changji'

registerSkillRuntime({
  id: ZHENGOU,
  interceptBystanderTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || !context.sourceId || context.targetId === ownerId) return false
    const target = playerOf(host.state, context.targetId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive || target.zones.hand.length === 0) return false
    if (!attackRangeCovers(host.state, ownerId, context.targetId)) return false
    const nonBasic = owner.zones.hand.filter((id) => host.state.cards[id]?.category !== 'basic')
    const options: Array<{ id: string; label: string }> = []
    if (nonBasic.length > 0) options.push({ id: 'discard', label: '弃置1张非基本牌' })
    options.push({ id: 'losehp', label: '失去1点体力' })
    host.askSkill({
      skillId: ZHENGOU, ownerId, step: 'ask', data: { targetId: context.targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【谮构】：是否发动，令${target.nickname}这次可能打出的【闪】无效并获得之？`, timeoutMs: 20_000, optional: true,
        options: [...options, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!owner?.alive || !target?.alive || optionId === 'no' || !optionId) { host.resumeCardTarget(); return }
      if (optionId === 'discard') {
        const nonBasic = owner.zones.hand.filter((id) => host.state.cards[id]?.category !== 'basic')
        if (nonBasic.length === 0) { host.resumeCardTarget(); return }
        host.askSkill({
          skillId: ZHENGOU, ownerId, step: 'discard', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: '【谮构】：弃置1张非基本牌', timeoutMs: 20_000, optional: false,
            cardIds: nonBasic, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
          }),
        })
        return
      }
      loseHp(host as never, ownerId, 1, ZHENGOU)
      applyZhengou(host, ownerId, targetId)
      return
    }
    if (resolution.step === 'discard') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const owner = playerOf(host.state, ownerId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) { host.resumeCardTarget(); return }
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ZHENGOU }, { sourceId: ownerId, cardIds: [cardId] })
      applyZhengou(host, ownerId, targetId)
    }
  },
})

function applyZhengou(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive) { host.resumeCardTarget(); return }
  const current = host.state.cardResolution
  if (current?.kind === 'slash') current.remainingTargetIds = current.remainingTargetIds.filter((id) => id !== targetId)
  host.dispatch('SkillActivated', { skillId: ZHENGOU, skillName: '谮构', playerId: ownerId, targetId, logText: `${owner.nickname}发动【谮构】` }, { sourceId: ownerId, targetId })
  const dodgeId = target.zones.hand.find((id) => host.state.cards[id]?.name === '闪')
  if (dodgeId) {
    moveCard(host.state, dodgeId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [dodgeId], reason: ZHENGOU }, { sourceId: targetId, cardIds: [dodgeId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [dodgeId], reason: ZHENGOU }, { sourceId: targetId, targetId: ownerId, cardIds: [dodgeId] })
  }
  host.resumeCardTarget()
}

registerSkillRuntime({
  id: CHANGJI,
  triggers: [
    {
      event: 'DamageCaused',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const ledger = host.state.changjiDamageDealt?.turnNumber === host.state.turnNumber ? host.state.changjiDamageDealt.ids : []
        const targetId = context.event.targetId
        if (!targetId || ledger.includes(targetId)) return
        host.state.changjiDamageDealt = { turnNumber: host.state.turnNumber, ids: [...ledger, targetId] }
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const sourceId = context.event.sourceId
        if (!sourceId) return
        const ledger = host.state.changjiDamageTaken?.turnNumber === host.state.turnNumber ? host.state.changjiDamageTaken.ids : []
        if (ledger.includes(sourceId)) return
        host.state.changjiDamageTaken = { turnNumber: host.state.turnNumber, ids: [...ledger, sourceId] }
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || !payload.playerId) return
        const turnOwnerId = payload.playerId
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const dealt = host.state.changjiDamageDealt?.turnNumber === host.state.turnNumber && host.state.changjiDamageDealt.ids.includes(turnOwnerId)
        const taken = host.state.changjiDamageTaken?.turnNumber === host.state.turnNumber && host.state.changjiDamageTaken.ids.includes(turnOwnerId)
        if (!dealt && !taken) return
        host.queueSkill({ skillId: CHANGJI, ownerId, step: 'ask', data: { turnOwnerId, dealt, taken } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { turnOwnerId, dealt, taken } = prompt.data as { turnOwnerId: PlayerId; dealt: boolean; taken: boolean }
    const owner = playerOf(host.state, ownerId)
    const turnOwner = playerOf(host.state, turnOwnerId)
    if (!owner?.alive || !turnOwner?.alive) return
    if (dealt) {
      host.askSkill({
        skillId: CHANGJI, ownerId, step: 'draw', data: { turnOwnerId, taken },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【长姬】：本回合曾对${turnOwner.nickname}造成伤害，是否令其摸2张牌？`, timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
    } else if (taken) {
      host.askSkill({
        skillId: CHANGJI, ownerId, step: 'discard', data: { turnOwnerId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【长姬】：本回合曾受到${turnOwner.nickname}的伤害，是否令其弃置2张牌？`, timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'draw') {
      const { turnOwnerId, taken } = resolution.data as { turnOwnerId: PlayerId; taken: boolean }
      const turnOwner = playerOf(host.state, turnOwnerId)
      if (turnOwner?.alive && (response.payload as { optionId?: string }).optionId === 'yes') {
        drawCards(host.state, host.rng, turnOwnerId, 2, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: CHANGJI, skillName: '长姬', playerId: ownerId, targetId: turnOwnerId, logText: `${owner.nickname}发动【长姬】，令${turnOwner.nickname}摸2张牌` }, { sourceId: ownerId, targetId: turnOwnerId })
      }
      if (taken) {
        host.askSkill({
          skillId: CHANGJI, ownerId, step: 'discard', data: { turnOwnerId },
          build: (requestId): ChooseOptionRequest => ({
            id: requestId, kind: 'choose-option', playerId: ownerId,
            prompt: `【长姬】：本回合曾受到${playerOf(host.state, turnOwnerId)?.nickname ?? ''}的伤害，是否令其弃置2张牌？`, timeoutMs: 20_000, optional: true,
            options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
          }),
        })
      }
      return
    }
    if (resolution.step === 'discard') {
      const { turnOwnerId } = resolution.data as { turnOwnerId: PlayerId }
      const turnOwner = playerOf(host.state, turnOwnerId)
      if (!turnOwner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      const count = Math.min(2, turnOwner.zones.hand.length)
      if (count === 0) return
      const toDiscard = [...turnOwner.zones.hand].slice(0, count)
      for (const cardId of toDiscard) moveCard(host.state, cardId, { kind: 'hand', playerId: turnOwnerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: turnOwnerId, cardIds: toDiscard, reason: CHANGJI }, { sourceId: turnOwnerId, cardIds: toDiscard })
      host.dispatch('SkillActivated', { skillId: CHANGJI, skillName: '长姬', playerId: ownerId, targetId: turnOwnerId, logText: `${owner.nickname}发动【长姬】，令${turnOwner.nickname}弃置2张牌` }, { sourceId: ownerId, targetId: turnOwnerId })
    }
  },
})

// ============================== 曹宇 ==============================

const GONGJIE = 'gongjie'
const XIANGXU = 'xiangxu'
const XIANGZUO = 'xiangzuo'

registerSkillRuntime({
  id: GONGJIE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || !payload.playerId) return
      if (host.state.gongjieRoundTurn === host.state.roundNumber) return
      host.state.gongjieRoundTurn = host.state.roundNumber
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: GONGJIE, ownerId, step: 'pick-targets', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-targets') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: GONGJIE, ownerId, step: 'pick-targets', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【恭节】：选择任意名其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: Math.min(candidateIds.length, owner.zones.hand.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-targets') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const alive = targetIds.filter((id) => playerOf(host.state, id)?.alive)
    if (alive.length === 0) return
    host.state.gongjieHistory ??= {}
    const givenSuits = new Set<Suit>()
    for (const targetId of alive) {
      if (owner.zones.hand.length === 0) break
      const cardId = owner.zones.hand[0]
      const suit = host.state.cards[cardId]?.suit
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: GONGJIE }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: GONGJIE }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      if (suit) givenSuits.add(suit)
      host.state.gongjieHistory[ownerId] = [...(host.state.gongjieHistory[ownerId] ?? []), targetId]
    }
    host.dispatch('SkillActivated', { skillId: GONGJIE, skillName: '恭节', playerId: ownerId, logText: `${owner.nickname}发动【恭节】` }, { sourceId: ownerId })
    if (givenSuits.size > 0) drawCards(host.state, host.rng, ownerId, givenSuits.size, (n, p) => { host.dispatch(n, p) })
  },
})

registerSkillRuntime({
  id: XIANGXU,
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) { checkXiangxuMinimum(host, ownerId, (context.event.payload as { playerId?: PlayerId }).playerId) },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) { checkXiangxuMinimum(host, ownerId, (context.event.payload as { playerId?: PlayerId }).playerId) },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (!payload.playerId || host.state.currentPlayerId !== payload.playerId) return
        const pending = host.state.xiangxuPending
        if (!pending || pending.ownerId !== ownerId || pending.turnNumber !== host.state.turnNumber) return
        host.state.xiangxuPending = undefined
        const owner = playerOf(host.state, ownerId)
        const turnOwner = playerOf(host.state, payload.playerId)
        if (!owner?.alive || !turnOwner?.alive) return
        host.queueSkill({ skillId: XIANGXU, ownerId, step: 'ask', data: { target: Math.min(turnOwner.zones.hand.length, 5) } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: XIANGXU, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【相胥】：是否将手牌调整至当前回合角色的手牌数（至多5张）？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const { target } = resolution.data as { target: number }
    host.state.xiangzuUsed = true
    host.dispatch('SkillActivated', { skillId: XIANGXU, skillName: '相胥', playerId: ownerId, logText: `${owner.nickname}发动【相胥】` }, { sourceId: ownerId })
    if (owner.zones.hand.length < target) {
      drawCards(host.state, host.rng, ownerId, target - owner.zones.hand.length, (n, p) => { host.dispatch(n, p) })
    } else if (owner.zones.hand.length > target) {
      const excess = owner.zones.hand.length - target
      const toDiscard = [...owner.zones.hand].slice(0, excess)
      for (const cardId of toDiscard) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: toDiscard, reason: XIANGXU }, { sourceId: ownerId, cardIds: toDiscard })
      if (toDiscard.length >= 2) recover(host as never, ownerId, 1, ownerId)
    }
  },
})

function checkXiangxuMinimum(host: SkillHost, ownerId: PlayerId, changedId: PlayerId | undefined): void {
  if (!changedId) return
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const minHand = Math.min(...host.state.players.filter((p) => p.alive).map((p) => p.zones.hand.length))
  if (owner.zones.hand.length !== minHand) return
  if (host.state.xiangxuPending?.ownerId === ownerId && host.state.xiangxuPending.turnNumber === host.state.turnNumber) return
  host.state.xiangxuPending = { ownerId, turnNumber: host.state.turnNumber }
}

registerSkillRuntime({
  id: XIANGZUO,
  allowsDeadResponder: true,
  triggers: [{
    event: 'EnterDying',
    allowDeadOwner: true,
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId || usedThisTurn(host.state, ownerId, `${XIANGZUO}-limit`)) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      markUsedThisTurn(host.state, ownerId, `${XIANGZUO}-limit`)
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      // EnterDying 触发时濒死/求桃流程自己的 Request 还在搭建，不能在这里同步 askSkill——
      // 会跟它抢占同一个结算位；交给 queueSkill 挪到下一个安全点再问
      host.queueSkill({ skillId: XIANGZUO, ownerId, step: 'pick-target', data: { candidateIds }, allowDeadOwner: true })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    const alive = candidateIds.filter((id) => playerOf(host.state, id)?.alive)
    if (alive.length === 0) return
    host.askSkill({
      skillId: XIANGZUO, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【襄胙】：选择一名其他角色，交给其任意数量的牌', timeoutMs: 20_000, optional: true,
        candidateIds: alive, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    // 襄胙"进入濒死时"发动，答题时可能已经死亡（allowsDeadResponder 已声明），不按存活拦
    if (!owner) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: XIANGZUO, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【襄胙】：选择交给对方的牌（至少1张）', timeoutMs: 20_000, optional: false,
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length, purpose: 'skill',
        }),
      })
      return
    }
    if (resolution.step === 'give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const actual = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (!target?.alive || actual.length === 0) return
      for (const cardId of actual) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: actual, reason: XIANGZUO }, { sourceId: ownerId, cardIds: actual })
      host.dispatch('GainCard', { playerId: targetId, cardIds: actual, reason: XIANGZUO }, { sourceId: ownerId, targetId, cardIds: actual })
      host.dispatch('SkillActivated', { skillId: XIANGZUO, skillName: '襄胙', playerId: ownerId, targetId, logText: `${owner.nickname}发动【襄胙】，交给${target.nickname}${actual.length}张牌` }, { sourceId: ownerId, targetId })
      // 双历史条件：对A发动过恭节 且 本局曾发动过相胥（相胥本身无目标，按官方技能完整含义取"本局已发动过"）
      const gongjieHit = (host.state.gongjieHistory?.[ownerId] ?? []).includes(targetId)
      if (gongjieHit && host.state.xiangzuUsed) recover(host as never, ownerId, actual.length, ownerId)
    }
  },
})

// ============================== 薛灵芸 ==============================

const SIQI = 'siqi'
const QIAOZHI = 'qiaozhi'
/** 官方"思泣"最多亮出的连续红牌张数：经查证当前 OL 页面取值为 3。 */
const SIQI_MAX_REVEAL = 3

registerSkillRuntime({
  id: SIQI,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: SIQI, ownerId, step: 'ask', data: {} })
    },
  }],
  redirectsOwnDiscardToBottom(state, ownerId, cardId) {
    void ownerId
    return state.cards[cardId]?.color === 'red'
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const revealed = revealBottomRedRun(host.state)
    if (revealed.length === 0) return
    host.askSkill({
      skillId: SIQI, ownerId, step: 'ask', data: { revealed },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【思泣】：是否亮出牌堆底${revealed.length}张连续红牌？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const { revealed } = resolution.data as { revealed: CardId[] }
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    for (const cardId of revealed) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    host.dispatch('CardMove', { cardIds: revealed, reason: 'siqi-reveal' }, { sourceId: ownerId, cardIds: revealed })
    host.dispatch('SkillActivated', { skillId: SIQI, skillName: '思泣', playerId: ownerId, logText: `${owner.nickname}发动【思泣】，亮出${revealed.length}张连续红牌` }, { sourceId: ownerId })
    let used = 0
    const remaining = [...revealed]
    while (remaining.length > 0) {
      const cardId = remaining[0]
      const name = host.state.cards[cardId]?.name
      const usable = name === '桃' || name === '无中生有' || host.state.cards[cardId]?.category === 'equipment'
      if (!usable) break
      remaining.shift()
      used += 1
      if (name === '桃') {
        recover(host as never, ownerId, 1, ownerId)
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      } else if (name === '无中生有') {
        drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      } else {
        equipFromDrawPileCard(host as never, ownerId, cardId)
      }
    }
    const unused = revealed.filter((id) => remaining.includes(id))
    if (unused.length > 0) {
      for (const cardId of unused) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
      drawCards(host.state, host.rng, ownerId, unused.length, (n, p) => { host.dispatch(n, p) })
    }
    void used
  },
})

function revealBottomRedRun(state: SanguoshaState): CardId[] {
  const revealed: CardId[] = []
  for (let i = state.zones.drawPile.length - 1; i >= 0 && revealed.length < SIQI_MAX_REVEAL; i -= 1) {
    const cardId = state.zones.drawPile[i]
    if (state.cards[cardId]?.color !== 'red') break
    revealed.push(cardId)
  }
  return revealed
}

/** 装备一张牌堆底/处理区来的实体装备（薛灵芸思泣使用亮出的装备）。 */
function equipFromDrawPileCard(host: EquipmentHost & SkillHost, playerId: PlayerId, cardId: CardId): void {
  const card = host.state.cards[cardId]
  const player = playerOf(host.state, playerId)
  if (!card?.equipmentSlot || !player) return
  const slot = card.equipmentSlot as EquipmentSlot
  if (!equipmentSlotsOf(host.state, playerId).includes(slot)) return
  const replaced = player.zones.equipment[slot]
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId, slot })
  if (replaced) handleEquipmentLost(host, playerId, replaced)
}

registerSkillRuntime({
  id: QIAOZHI,
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId !== ownerId) return
        const locked = host.state.qiaozhiLockedCardId?.[ownerId]
        if (!locked || !(payload.cardIds ?? []).includes(locked)) return
        if (host.state.qiaozhiLockedCardId) delete host.state.qiaozhiLockedCardId[ownerId]
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        if (host.state.qiaozhiLockedCardId?.[ownerId]) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        host.queueSkill({ skillId: QIAOZHI, ownerId, step: 'ask', data: {} })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || host.state.qiaozhiLockedCardId?.[ownerId]) return
    host.askSkill({
      skillId: QIAOZHI, ownerId, step: 'discard', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【巧织】：弃置1张手牌', timeoutMs: 20_000, optional: true,
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1, purpose: 'skill',
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: QIAOZHI }, { sourceId: ownerId, cardIds: [cardId] })
      const top = host.state.zones.drawPile.slice(0, 2)
      if (top.length === 0) return
      host.state.zones.drawPile = host.state.zones.drawPile.slice(top.length)
      host.state.zones.processingArea.push(...top)
      host.dispatch('CardMove', { cardIds: top, reason: 'qiaozhi-reveal' }, { sourceId: ownerId, cardIds: top })
      host.dispatch('SkillActivated', { skillId: QIAOZHI, skillName: '巧织', playerId: ownerId, logText: `${owner.nickname}发动【巧织】` }, { sourceId: ownerId })
      if (top.length === 1) {
        moveCard(host.state, top[0], { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: top, reason: QIAOZHI }, { targetId: ownerId, cardIds: top })
        host.state.qiaozhiLockedCardId = { ...(host.state.qiaozhiLockedCardId ?? {}), [ownerId]: top[0] }
        return
      }
      host.askSkill({
        skillId: QIAOZHI, ownerId, step: 'pick', data: { top },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【巧织】：获得其中1张', timeoutMs: 20_000, optional: false,
          cardIds: top, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
        }),
      })
      return
    }
    if (resolution.step === 'pick') {
      const { top } = resolution.data as { top: CardId[] }
      const [pickedId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const remaining = top.filter((id) => host.state.zones.processingArea.includes(id))
      if (remaining.length === 0) return
      const gained = pickedId && remaining.includes(pickedId) ? pickedId : remaining[0]
      moveCard(host.state, gained, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [gained], reason: QIAOZHI }, { targetId: ownerId, cardIds: [gained] })
      host.state.qiaozhiLockedCardId = { ...(host.state.qiaozhiLockedCardId ?? {}), [ownerId]: gained }
      const leftover = remaining.filter((id) => id !== gained)
      for (const id of leftover) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
    }
  },
})

// ============================== 夏侯令女 ==============================

const FUPING = 'fuping'
const WEILIE = 'weilie'

registerSkillRuntime({
  id: FUPING,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { sourceId?: PlayerId; cardId?: CardId; cardName?: string }
        if (context.event.sourceId !== ownerId && payload.sourceId !== ownerId) return
        markFupingNameUsed(host.state, ownerId, payload.cardId, payload.cardName)
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId | null; cardName?: string }
        if (payload.playerId !== ownerId) return
        markFupingNameUsed(host.state, ownerId, payload.cardId ?? undefined, payload.cardName)
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { targetIds?: PlayerId[]; cardName?: string; virtual?: boolean }
        const sourceId = context.event.sourceId
        if (!sourceId || sourceId === ownerId || payload.virtual || !(payload.targetIds ?? []).includes(ownerId)) return
        const cardName = payload.cardName
        if (!cardName || (host.state.fupingNames ?? []).includes(cardName)) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const abolishable = abolishableSlotsOf(host.state, ownerId)
        if (abolishable.length === 0) return
        host.queueSkill({ skillId: FUPING, ownerId, step: 'ask', data: { cardName } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { cardName } = prompt.data as { cardName: string }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (host.state.fupingNames ?? []).includes(cardName) || abolishableSlotsOf(host.state, ownerId).length === 0) return
    host.askSkill({
      skillId: FUPING, ownerId, step: 'ask', data: { cardName },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【浮萍】：是否废除一个装备栏，记录牌名【${cardName}】？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { cardName } = resolution.data as { cardName: string }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const abolishable = abolishableSlotsOf(host.state, ownerId)
    if (abolishable.length === 0) return
    const slot = abolishable[0]
    const existing = owner.zones.equipment[slot]
    if (existing) {
      moveCard(host.state, existing, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
      handleEquipmentLost(host as never, ownerId, existing)
    }
    abolishSlot(host.state, ownerId, slot)
    host.state.everAbolishedSlots ??= {}
    host.state.everAbolishedSlots[ownerId] = [...new Set([...(host.state.everAbolishedSlots[ownerId] ?? []), slot])]
    host.state.fupingNames = [...(host.state.fupingNames ?? []), cardName]
    host.state.weilieCharges = (host.state.weilieCharges ?? 1) + 1
    host.dispatch('SkillActivated', { skillId: FUPING, skillName: '浮萍', playerId: ownerId, logText: `${owner.nickname}发动【浮萍】，记录【${cardName}】，废除一个装备栏` }, { sourceId: ownerId })
  },
  ignoresDistanceTo(state, ownerId, targetId) { void targetId; return allSlotsEverAbolished(state, ownerId) },
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const names = state.fupingNames ?? []
    if (!owner?.alive || names.length === 0) return []
    const turnUsed = state.fupingTurnUsed?.turnNumber === state.turnNumber ? state.fupingTurnUsed.names : []
    const nonBasic = owner.zones.hand.filter((id) => state.cards[id]?.category !== 'basic')
    const options: ViewAsOption[] = []
    for (const name of names) {
      if (turnUsed.includes(name)) continue
      for (const cardId of nonBasic) options.push({ cardId, asCardName: name, label: `当【${name}】使用/打出` })
    }
    return options
  },
})

const BASE_EQUIPMENT_SLOTS: EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

/** 四个基础装备栏是否都"曾经"被废除过——记录历史，不因后来恢复而清空。 */
function allSlotsEverAbolished(state: SanguoshaState, ownerId: PlayerId): boolean {
  const ever = state.everAbolishedSlots?.[ownerId] ?? []
  return BASE_EQUIPMENT_SLOTS.every((slot) => ever.includes(slot))
}

/** 浮萍"每种记录牌名每Turn限一次"的落地记账：用/打出的有效牌名命中已记录名单时才记一笔。 */
function markFupingNameUsed(state: SanguoshaState, ownerId: PlayerId, cardId: CardId | undefined, cardName: string | undefined): void {
  if (!cardId || !cardName) return
  const names = state.fupingNames ?? []
  if (!names.includes(cardName)) return
  if (state.cardAliases[cardId] !== cardName) return
  void ownerId
  const used = state.fupingTurnUsed?.turnNumber === state.turnNumber ? state.fupingTurnUsed.names : []
  if (used.includes(cardName)) return
  state.fupingTurnUsed = { turnNumber: state.turnNumber, names: [...used, cardName] }
}

registerSkillRuntime({
  id: WEILIE,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || (state.weilieCharges ?? 1) <= 0 || owner.zones.hand.length === 0 || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    return [{ id: 'skill:weilie', label: `发动【炜烈】（剩余${state.weilieCharges ?? 1}次）` }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:weilie') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (host.state.weilieCharges ?? 1) <= 0 || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: WEILIE, ownerId, step: 'discard', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【炜烈】：弃置1张牌', timeoutMs: 20_000, optional: false,
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId) || (host.state.weilieCharges ?? 1) <= 0) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: WEILIE }, { sourceId: ownerId, cardIds: [cardId] })
      host.state.weilieCharges = (host.state.weilieCharges ?? 1) - 1
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: WEILIE, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【炜烈】：选择一名角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      recover(host as never, targetId, 1, ownerId)
      host.dispatch('SkillActivated', { skillId: WEILIE, skillName: '炜烈', playerId: ownerId, targetId, logText: `${owner.nickname}发动【炜烈】` }, { sourceId: ownerId, targetId })
      const after = playerOf(host.state, targetId)
      if (after?.alive && after.hp < after.maxHp) drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
    }
  },
})

// ============================== 刘宏 ==============================

const YUJUE = 'yujue'
const ZHIHU = 'zhihu'
const TUXING = 'tuxing'

registerSkillRuntime({
  id: YUJUE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, YUJUE) || abolishableSlotsOf(host.state, ownerId).length === 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: YUJUE, ownerId, step: 'ask', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, YUJUE) || abolishableSlotsOf(host.state, ownerId).length === 0) return
    host.askSkill({
      skillId: YUJUE, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【鬻爵】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const abolishable = abolishableSlotsOf(host.state, ownerId)
      if (abolishable.length === 0) return
      markUsedThisTurn(host.state, ownerId, YUJUE)
      const slot = abolishable[0]
      const existing = owner.zones.equipment[slot]
      if (existing) {
        moveCard(host.state, existing, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
        handleEquipmentLost(host as never, ownerId, existing)
      }
      abolishSlot(host.state, ownerId, slot)
      host.dispatch('SkillActivated', { skillId: TUXING, skillName: '图兴', playerId: ownerId, logText: `${owner.nickname}的一个装备栏被废除` }, { sourceId: ownerId })
      applyTuxingOnAbolish(host, ownerId, slot)
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: YUJUE, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【鬻爵】：选择一名有手牌的其他角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      host.askSkill({
        skillId: YUJUE, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: `【鬻爵】：交给${owner.nickname}1张手牌`, timeoutMs: 20_000, optional: false,
          cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
        }),
      })
      return
    }
    if (resolution.step === 'give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: YUJUE }, { sourceId: targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: YUJUE }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      if (host.state.zhihuGrant) replaceTemporarySkill(host.state, host.state.zhihuGrant.targetId, ZHIHU, null)
      replaceTemporarySkill(host.state, targetId, ZHIHU, ZHIHU)
      host.state.zhihuGrant = { sourceId: ownerId, targetId }
      host.dispatch('SkillActivated', { skillId: YUJUE, skillName: '鬻爵', playerId: ownerId, targetId, logText: `${owner.nickname}发动【鬻爵】，${target.nickname}获得【执笏】直到${owner.nickname}下个回合开始` }, { sourceId: ownerId, targetId })
    }
  },
})

const ZHIHU_TURN_LIMIT = 2

registerSkillRuntime({
  id: ZHIHU,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== host.state.zhihuGrant?.sourceId) return
        replaceTemporarySkill(host.state, ownerId, ZHIHU, null)
        host.state.zhihuGrant = undefined
      },
    },
    {
      event: 'DamageCaused',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId || !context.event.targetId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (owner.marks['zhihu-turn'] !== host.state.turnNumber) { owner.marks['zhihu-turn'] = host.state.turnNumber; owner.marks['zhihu-count'] = 0 }
        if ((owner.marks['zhihu-count'] ?? 0) >= ZHIHU_TURN_LIMIT) return
        owner.marks['zhihu-count'] = (owner.marks['zhihu-count'] ?? 0) + 1
        drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: ZHIHU, skillName: '执笏', playerId: ownerId, logText: `${owner.nickname}发动【执笏】，摸2张牌` }, { sourceId: ownerId })
      },
    },
  ],
})

registerSkillRuntime({
  id: TUXING,
})

function applyTuxingOnAbolish(host: SkillHost, ownerId: PlayerId, slot: EquipmentSlot): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (!ownedSkillIds(host.state, ownerId).includes(TUXING)) return
  owner.maxHp += 1
  recover(host as never, ownerId, 1, ownerId)
  host.dispatch('MaxHpChange', { playerId: ownerId, delta: 1 }, { targetId: ownerId })
  void slot
  if (allSlotsEverAbolished(host.state, ownerId) || BASE_EQUIPMENT_SLOTS.every((s) => isSlotAbolished(host.state, ownerId, s))) {
    if (!(host.state.tuxingAllSlotsTriggered ?? []).includes(ownerId)) {
      host.state.tuxingAllSlotsTriggered = [...(host.state.tuxingAllSlotsTriggered ?? []), ownerId]
      loseMaxHp(host as never, ownerId, 4, TUXING)
      host.state.permanentDamageBonus ??= {}
      host.state.permanentDamageBonus[ownerId] = (host.state.permanentDamageBonus[ownerId] ?? 0) + 1
      host.dispatch('SkillActivated', { skillId: TUXING, skillName: '图兴', playerId: ownerId, logText: `${owner.nickname}的装备栏首次全部被废除，减4点体力上限，本局伤害永久+1` }, { sourceId: ownerId })
    }
  }
  host.state.everAbolishedSlots ??= {}
  host.state.everAbolishedSlots[ownerId] = [...new Set([...(host.state.everAbolishedSlots[ownerId] ?? []), slot])]
}

// ============================== 唐姬 ==============================

const KANGGE = 'kangge'
const JIELIE = 'jielie'

registerSkillRuntime({
  id: KANGGE,
  allowsDeadResponder: true,
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId || host.state.kanggeTarget) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: KANGGE, ownerId, step: 'pick-target', data: { candidateIds } })
      },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const target = host.state.kanggeTarget
        if (!target) return
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId !== target || host.state.currentPlayerId === target) return
        const count = payload.cardIds?.length ?? 0
        if (count === 0) return
        const used = host.state.kanggeDrawCount?.turnNumber === host.state.turnNumber ? host.state.kanggeDrawCount.count : 0
        const grant = Math.max(0, Math.min(count, 3 - used))
        if (grant === 0) return
        host.state.kanggeDrawCount = { turnNumber: host.state.turnNumber, count: used + grant }
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        drawCards(host.state, host.rng, ownerId, grant, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: KANGGE, skillName: '抗歌', playerId: ownerId, logText: `${owner.nickname}发动【抗歌】，摸${grant}张牌` }, { sourceId: ownerId })
      },
    },
    {
      event: 'EnterDying',
      allowDeadOwner: true,
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== host.state.kanggeTarget) return
        const roundKey = host.state.roundNumber
        if (host.state.kanggeRoundRescue === roundKey) return
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        host.queueSkill({ skillId: KANGGE, ownerId, step: 'rescue-ask', data: { targetId: payload.playerId, roundKey }, allowDeadOwner: true })
      },
    },
    {
      event: 'Death',
      allowDeadOwner: true,
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== host.state.kanggeTarget) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)), ...owner.zones.judgingArea]
        if (cardIds.length > 0) {
          for (const cardId of cardIds) {
            const from = owner.zones.hand.includes(cardId)
              ? { kind: 'hand' as const, playerId: ownerId }
              : owner.zones.judgingArea.includes(cardId)
                ? { kind: 'judgingArea' as const, playerId: ownerId }
                : { kind: 'equipment' as const, playerId: ownerId, slot: (Object.entries(owner.zones.equipment).find(([, id]) => id === cardId)?.[0] as never) }
            moveCard(host.state, cardId, from, { kind: 'discardPile' })
          }
          host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: KANGGE }, { sourceId: ownerId, cardIds })
        }
        host.dispatch('SkillActivated', { skillId: KANGGE, skillName: '抗歌', playerId: ownerId, logText: `${owner.nickname}发动【抗歌】，弃置所有牌` }, { sourceId: ownerId })
        loseHp(host as never, ownerId, 1, KANGGE)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'pick-target') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: KANGGE, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【抗歌】：选择一名其他角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'rescue-ask') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      host.askSkill({
        skillId: KANGGE, ownerId, step: 'rescue-ask', data: prompt.data,
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【抗歌】：是否令${target.nickname}回复体力至1点？`, timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive) return
      host.state.kanggeTarget = targetId
      host.dispatch('SkillActivated', { skillId: KANGGE, skillName: '抗歌', playerId: ownerId, targetId, logText: `${owner.nickname}发动【抗歌】，绑定${playerOf(host.state, targetId)!.nickname}` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'rescue-ask') {
      const { targetId, roundKey } = resolution.data as { targetId: PlayerId; roundKey: number }
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      if (!owner || !target?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      host.state.kanggeRoundRescue = roundKey
      const need = 1 - target.hp
      if (need > 0) recover(host as never, targetId, need, ownerId)
      host.dispatch('SkillActivated', { skillId: KANGGE, skillName: '抗歌', playerId: ownerId, targetId, logText: `${owner.nickname}发动【抗歌】，${target.nickname}回复体力至1点` }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: JIELIE,
  offersTargetDamagePreventionAsk(host, ownerId, context) {
    if (!context.sourceId || context.sourceId === host.state.kanggeTarget) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    host.queueSkill({ skillId: JIELIE, ownerId, step: 'ask', data: { amount: context.amount } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !host.state.pendingTargetDamage) { resumeTargetDamagePrevention(host as never, false); return }
    host.askSkill({
      skillId: JIELIE, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【节烈】：是否防止此伤害，改为失去等量体力？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask') {
      const { amount } = resolution.data as { amount: number }
      if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') { resumeTargetDamagePrevention(host as never, false); return }
      resumeTargetDamagePrevention(host as never, true, JIELIE)
      host.dispatch('SkillActivated', { skillId: JIELIE, skillName: '节烈', playerId: ownerId, logText: `${owner.nickname}发动【节烈】，防止伤害并失去${amount}点体力` }, { sourceId: ownerId })
      loseHp(host as never, ownerId, amount, JIELIE)
      if (!playerOf(host.state, ownerId)?.alive) return
      const suits: Suit[] = ['spade', 'heart', 'club', 'diamond']
      host.askSkill({
        skillId: JIELIE, ownerId, step: 'suit', data: { amount },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【节烈】：选择一种花色', timeoutMs: 20_000, optional: false,
          options: suits.map((suit) => ({ id: suit, label: suit })),
        }),
      })
      return
    }
    if (resolution.step === 'suit') {
      const { amount } = resolution.data as { amount: number }
      const suit = (response.payload as { optionId?: string }).optionId as Suit | undefined
      const targetId = host.state.kanggeTarget
      if (!suit || !targetId || !playerOf(host.state, targetId)?.alive) return
      const candidates = host.state.zones.discardPile.filter((id) => host.state.cards[id]?.suit === suit)
      if (candidates.length === 0) return
      const pool = [...candidates]
      const count = Math.min(amount, pool.length)
      const picked: CardId[] = []
      for (let i = 0; i < count; i += 1) {
        const index = host.rng.nextInt(pool.length)
        picked.push(...pool.splice(index, 1))
      }
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: picked, reason: JIELIE }, { targetId, cardIds: picked })
    }
  },
})

// ============================== 王允 ==============================

const LIANJI = 'lianji'
const MOUCHENG = 'moucheng'
const JINGONG = 'jingong'

function weaponsInDrawPile(state: SanguoshaState): CardId[] {
  return state.zones.drawPile.filter((id) => state.cards[id]?.category === 'equipment' && state.cards[id]?.equipmentSlot === 'weapon')
}

registerSkillRuntime({
  id: LIANJI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.marks['lianji-lost'] || usedThisTurn(host.state, ownerId, LIANJI) || owner.zones.hand.length === 0) return
        if (weaponsInDrawPile(host.state).length === 0) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: LIANJI, ownerId, step: 'ask', data: { candidateIds } })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        void ownerId
        const cardId = context.event.cardIds?.[0]
        if (!cardId || !(host.state.lianjiSlashCardIds ?? []).includes(cardId)) return
        host.state.lianjiDamageDealt = true
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, LIANJI) || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: LIANJI, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【连计】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const { candidateIds } = resolution.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: LIANJI, ownerId, step: 'pick-target', data: { candidateIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【连计】：弃置1张手牌，选择一名其他角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: LIANJI, ownerId, step: 'discard', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【连计】：弃置1张手牌', timeoutMs: 20_000, optional: false,
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
        }),
      })
      return
    }
    if (resolution.step === 'discard') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      markUsedThisTurn(host.state, ownerId, LIANJI)
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: LIANJI }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: LIANJI, skillName: '连计', playerId: ownerId, targetId, logText: `${owner.nickname}发动【连计】` }, { sourceId: ownerId, targetId })
      const weapons = weaponsInDrawPile(host.state)
      if (weapons.length === 0) return
      const weaponId = weapons[host.rng.nextInt(weapons.length)]
      const replaced = target.zones.equipment.weapon
      moveCard(host.state, weaponId, { kind: 'drawPile' }, { kind: 'equipment', playerId: targetId, slot: 'weapon' })
      if (replaced) handleEquipmentLost(host as never, targetId, replaced)
      host.dispatch('CardMove', { cardId: weaponId, reason: 'equip' }, { targetId, cardIds: [weaponId] })
      const hasSlashCard = target.zones.hand.some((id) => host.state.cards[id]?.name === '杀')
      const canSlashAny = hasSlashCard && canUseSlash(host.state, targetId, false)
        && host.state.players.some((candidate) => candidate.alive && candidate.id !== targetId)
      const options: Array<{ id: string; label: string }> = []
      if (canSlashAny) options.push({ id: 'slash', label: '对王允指定的一名角色使用一张【杀】' })
      options.push({ id: 'give', label: '将武器交给王允指定的一名角色' })
      host.askSkill({
        skillId: LIANJI, ownerId, step: 'branch', data: { targetId, weaponId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【连计】：请选择', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }
    if (resolution.step === 'branch') {
      const { targetId } = resolution.data as { targetId: PlayerId; weaponId: CardId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'slash') {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== targetId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: LIANJI, ownerId, step: 'slash-pick', data: { targetId },
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: `【连计】：选择一名角色作为${target.nickname}【杀】的目标`, timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: 1,
          }),
        })
        return
      }
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: LIANJI, ownerId, step: 'give-pick', data: { targetId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【连计】：选择一名角色获得这把武器', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'slash-pick') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!target?.alive || !victimId || !playerOf(host.state, victimId)?.alive) return
      const cardId = target.zones.hand.find((id) => host.state.cards[id]?.name === '杀')
      if (!cardId || !canUseSlash(host.state, targetId, false)) return
      host.dispatch('SkillActivated', { skillId: LIANJI, skillName: '连计', playerId: ownerId, targetId, logText: `${target.nickname}对${playerOf(host.state, victimId)!.nickname}使用【杀】` }, { sourceId: ownerId, targetId })
      host.state.lianjiSlashCardIds = [...(host.state.lianjiSlashCardIds ?? []), cardId]
      host.beginVirtualSlash({ sourceId: targetId, targetId: victimId, sourceSkillId: LIANJI, cardId })
      return
    }
    if (resolution.step === 'give-pick') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [recipientId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const recipient = recipientId ? playerOf(host.state, recipientId) : undefined
      if (!target?.alive || !recipient?.alive) return
      const weaponId = target.zones.equipment.weapon
      if (!weaponId) return
      moveCard(host.state, weaponId, { kind: 'equipment', playerId: targetId, slot: 'weapon' }, { kind: 'hand', playerId: recipientId! })
      handleEquipmentLost(host as never, targetId, weaponId)
      host.dispatch('GainCard', { playerId: recipientId!, cardIds: [weaponId], reason: LIANJI }, { targetId: recipientId!, cardIds: [weaponId] })
      host.dispatch('SkillActivated', { skillId: LIANJI, skillName: '连计', playerId: ownerId, targetId: recipientId, logText: `王允将${target.nickname}的武器交给${recipient.nickname}` }, { sourceId: ownerId, targetId: recipientId })
    }
  },
})

registerSkillRuntime({
  id: MOUCHENG,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId || host.state.moucheng) return
      if (!host.state.lianjiDamageDealt) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.state.moucheng = true
      owner.marks['lianji-lost'] = 1
      grantSkill(host.state, ownerId, JINGONG)
      host.dispatch('SkillActivated', { skillId: MOUCHENG, skillName: '谋逞', playerId: ownerId, logText: `${owner.nickname}发动【谋逞】，失去【连计】，获得【矜功】` }, { sourceId: ownerId })
    },
  }],
})

registerSkillRuntime({
  id: JINGONG,
  triggers: [
    {
      event: 'DamageCaused',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        markUsedThisTurn(host.state, ownerId, `${JINGONG}-dealt`)
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || !usedThisTurn(host.state, ownerId, JINGONG) || usedThisTurn(host.state, ownerId, `${JINGONG}-dealt`)) return
        loseHp(host as never, ownerId, 1, JINGONG)
      },
    },
  ],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, JINGONG) || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const equip = owner.zones.hand.filter((id) => state.cards[id]?.category === 'equipment' || state.cards[id]?.name === '杀')
    if (equip.length === 0 || virtualTrickChoices(state, ownerId).length === 0) return []
    return [{ id: 'skill:jingong', label: '发动【矜功】：将一张装备/杀当普通锦囊使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:jingong') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, JINGONG)) return
    const eligible = owner.zones.hand.filter((id) => host.state.cards[id]?.category === 'equipment' || host.state.cards[id]?.name === '杀')
    if (eligible.length === 0) return
    host.askSkill({
      skillId: JINGONG, ownerId, step: 'pick-card', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【矜功】：选择一张装备牌或【杀】当普通锦囊使用', timeoutMs: 20_000, optional: false,
        cardIds: eligible, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-card') return
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId) || usedThisTurn(host.state, ownerId, JINGONG)) return
    const choices = virtualTrickChoices(host.state, ownerId)
    if (choices.length === 0) return
    markUsedThisTurn(host.state, ownerId, JINGONG)
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JINGONG }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: JINGONG, skillName: '矜功', playerId: ownerId, logText: `${owner.nickname}发动【矜功】` }, { sourceId: ownerId })
    const name = choices[host.rng.nextInt(choices.length)]
    const virtualId = createVirtualTrick(host.state, ownerId, name, JINGONG)
    const legalActions = instantTrickActions(host.state, ownerId, virtualId, name).filter((action) => action.kind === 'use-card')
    if (legalActions.length === 0) { delete host.state.cards[virtualId]; return }
    const action = legalActions[host.rng.nextInt(legalActions.length)]
    executeUseCardAction(host as never, ownerId, action)
  },
})

// ============================== 角色定义 ==============================

export const WEI_JIN_HISTORICAL_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'zhongyan', name: '钟琰', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: BOLAN, name: '博览', description: '出牌阶段开始时，你可以随机获得3个当前可动态授予的"出牌阶段限一次"武将技能候选，选择1个直到本阶段结束获得；其他角色于自己的出牌阶段限一次，可以失去1点体力，由你为其选择1个技能直到其本阶段结束获得。' },
      { id: YIFA, name: '仪法', description: '锁定技，其他角色使用【杀】或黑色普通锦囊指定你为目标后，其本回合手牌上限-1。' },
    ],
  },
  {
    id: 'jikang', name: '嵇康', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: QINGXIAN, name: '清弦', description: '你受到伤害/回复体力后，若没有角色处于濒死，可以令伤害来源/一名其他角色执行一项：1.失去1点体力，随机使用一张装备牌；2.回复1点体力，弃置一张装备牌。若使用/弃置的牌为梅花，你摸1张牌。' },
      { id: JUEXIANG, name: '绝响', description: '你死亡时，可以令一名角色随机获得【和弦】【柔弦】【烈弦】【激弦】中的一个（优先从其尚未拥有的技能中抽取），然后直到其下回合开始，其不能成为其他角色使用梅花牌的目标。' },
      { id: HEXIAN, name: '和弦', description: '你回复体力后，若没有角色处于濒死，可以令一名其他角色回复1点体力，然后弃置其一张装备牌。' },
      { id: ROUXIAN, name: '柔弦', description: '你受到伤害后，若没有角色处于濒死，可以令伤害来源回复1点体力。' },
      { id: LIEXIAN, name: '烈弦', description: '你回复体力后，若没有角色处于濒死，可以令一名其他角色失去1点体力，然后随机使用一张装备牌。' },
      { id: JIXIAN, name: '激弦', description: '你受到伤害后，若没有角色处于濒死，可以令伤害来源失去1点体力，然后随机使用一张装备牌。' },
    ],
  },
  {
    id: 'xuangongzhu', name: '宣公主', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: GAOLING, name: '高陵', description: '隐匿技。你于其他角色的回合登场时（若无隐匿系统，改为游戏开始后第一次进入其他角色回合时，每局一次），可以令一名角色回复1点体力。' },
      { id: QIMEI, name: '齐眉', description: '准备阶段，你可以选择一名其他角色，直到你下个回合开始：你与其中一方的手牌数发生变化后，若两者相等，另一方摸1张牌（每回合限一次）；你与其中一方的体力值发生变化后，若两者相等，另一方摸1张牌（每回合限一次）。' },
      { id: ZHUIJI, name: '追姬', description: '出牌阶段开始时，你可以选择一项：回复1点体力，本阶段结束时弃置2张牌；或摸2张牌，本阶段结束时失去1点体力。' },
    ],
  },
  {
    id: 'qinghegongzhu', name: '清河公主', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: ZHENGOU, name: '谮构', description: '你攻击范围内的一名角色使用/打出【闪】时，你可以弃置1张非基本牌或失去1点体力，然后令这张【闪】无效并获得之。' },
      { id: CHANGJI, name: '长姬', description: '结束阶段，若本回合角色的回合内你曾对其造成过伤害，你可以令其摸2张牌；若你曾受到过其伤害，你可以令其弃置2张牌（两项可分别独立发动）。' },
    ],
  },
  {
    id: 'caoyu', name: '曹宇', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: GONGJIE, name: '恭节', description: '每轮的第一名角色回合开始时，你可以选择任意名其他角色，各交给其1张牌，然后你摸X张牌，X为本次因此获得牌的角色所获牌的不同花色数。' },
      { id: XIANGXU, name: '相胥', description: '当你的手牌数变为全场最少（含并列）时，本回合结束时你可以将手牌调整至当前回合角色的手牌数（至多5张）；若你因此弃置了至少2张牌，你回复1点体力。' },
      { id: XIANGZUO, name: '襄胙', description: '限定技，你进入濒死状态时，可以选择一名其他角色，交给其任意数量的牌（至少1张）；若你本局曾对其发动过【恭节】，且本局曾发动过【相胥】，你回复等量的体力。' },
    ],
  },
  {
    id: 'xuelingyun', name: '薛灵芸', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: SIQI, name: '思泣', description: '锁定技，你的红色实体牌因正常流程将进入弃牌堆时，改为置于牌堆底。你受到伤害后，可以亮出牌堆底至多3张连续的红色牌，然后依次使用其中的【桃】【无中生有】及装备牌；未能使用的牌，你摸等量的牌。' },
      { id: QIAOZHI, name: '巧织', description: '出牌阶段，你可以弃置1张手牌，然后亮出牌堆顶2张牌，获得其中1张。若你仍持有以此获得的牌，此技能失效，直到你失去那张牌。' },
    ],
  },
  {
    id: 'xiahoulingnv', name: '夏侯令女', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: FUPING, name: '浮萍', description: '你成为其他角色使用牌的目标且此牌结算完成后，若其牌名本局尚未被浮萍记录，你可以废除一个尚未废除的装备栏并记录此牌名；你可以将1张非基本牌当已记录的牌名使用或打出（每种牌名每回合限一次）。若你的装备栏均已被废除过，你使用牌无距离限制。' },
      { id: WEILIE, name: '炜烈', description: '出牌阶段，你可以弃置1张牌，令一名角色回复1点体力，然后若其体力未满，摸1张牌（可用次数初始为1，每记录一个新的浮萍牌名+1）。' },
    ],
  },
  {
    id: 'liuhong', name: '刘宏', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: YUJUE, name: '鬻爵', description: '出牌阶段限一次，你可以废除一个装备栏，然后选择一名有手牌的其他角色，其交给你1张手牌，然后其获得技能【执笏】直到你下个回合开始。' },
      { id: TUXING, name: '图兴', description: '锁定技，每当你废除一个装备栏后，你加1点体力上限并回复1点体力；当你的装备栏首次全部被废除后，你减4点体力上限，然后你本局之后造成的伤害+1。' },
    ],
  },
  {
    id: 'tangji', name: '唐姬', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: KANGGE, name: '抗歌', description: '你的第一个回合开始时，你选择一名其他角色，永久绑定：其于回合外获得手牌后，你摸等量的牌（每回合至多3张）；其进入濒死时，你可以每轮限一次地令其回复体力至1点；其死亡时，你弃置所有牌，然后失去1点体力。' },
      { id: JIELIE, name: '节烈', description: '当绑定角色以外的角色对你造成伤害时，你可以防止此伤害，然后失去等量体力，并选择一种花色，令绑定角色从弃牌堆中随机获得至多等量张该花色的牌。' },
    ],
  },
  {
    id: 'wangyun', name: '王允', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: LIANJI, name: '连计', description: '出牌阶段限一次，你可以弃置1张手牌并选择一名其他角色A，令A随机使用牌堆中一张武器牌，然后A选择一项：对你指定的一名角色使用一张【杀】；或将武器交给你指定的一名角色。' },
      { id: MOUCHENG, name: '谋逞', description: '觉醒技，准备阶段，若你本局通过【连计】产生的【杀】曾经造成过真实伤害，你失去【连计】，获得【矜功】。' },
      { id: JINGONG, name: '矜功', description: '出牌阶段限一次，你可以将一张装备牌或【杀】当一张普通锦囊牌使用；若你本回合未以此造成过伤害，结束阶段你失去1点体力。' },
    ],
  },
]

