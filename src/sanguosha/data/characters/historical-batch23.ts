import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { resolveDamage, killPlayer, resumeTargetDamagePrevention } from '../../engine/damage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { registerSkillRuntime, replaceTemporarySkills, grantSkill, type SkillHost } from '../../engine/skills/runtime'
import { abolishSlot, abolishableSlotsOf, equipmentSlotsOf } from '../../engine/equipment-slots'
import { handleEquipmentLost } from '../../engine/equipment'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, Identity, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 历史人物第二十三批：胡金定、曹安民、赵昂、夏侯杰、史阿、葛玄、童渊、
 * 赵直、刘晔、陈珪。均此前项目未收录，全部作为独立 CharacterDefinition，
 * 不覆盖任何界/谋/族/国战/SP/神版本。
 *
 * 版本口径：胡金定锁 OL 当前【轻缘】【重身】；曹安民锁《一将成名》【险卫】
 * （不是"谋曹安民"或民间曹昂变体）；赵昂/夏侯杰/葛玄/童渊/赵直/陈珪锁
 * 《一将成名》当前版；史阿锁 2026 当前【砺刃】【剑出】【击格】；刘晔锁
 * 【破垣】【画策】+专属装备【霹雳车】，经 WebFetch 核对 wiki.biligame.com
 * 当前文本。
 *
 * 已知简化（引擎能力边界，非版本/规则错误，均已在对应位置注释说明）：
 * - 刘晔【霹雳车】：官方定义为"宝物"，本引擎无宝物栏，沿用批22大攻车的
 *   既有简化映射到武器栏。
 * - 史阿【剑出】"所有闪视为杀"：项目没有先例定义这句话的确切机制边界，
 *   按最贴近规则文本的方式落地为"手牌闪可以当杀主动使用"这一具体能力
 *   （通过既有 viewAs 钩子），不改变闪本身响应杀的正常用途。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function alivePlayers(state: SanguoshaState) {
  return state.players.filter((player) => player.alive)
}

/** 身份阵营：主忠一边，反贼一边，内奸永远独立一方（不与任何人同阵营，含另一个内奸）。 */
function campOf(identity: Identity): 'loyal' | 'rebel' | 'renegade' {
  if (identity === 'renegade') return 'renegade'
  if (identity === 'rebel') return 'rebel'
  return 'loyal'
}
function sameCamp(a: Identity, b: Identity): boolean {
  if (a === 'renegade' || b === 'renegade') return false
  return campOf(a) === campOf(b)
}

/* ============================== 胡金定 ============================== */

const QINGYUAN = 'qingyuan'
const ZHONGSHEN = 'zhongshen'

registerSkillRuntime({
  id: QINGYUAN,
  triggers: [
    {
      event: 'GameStart',
      handle(host, ownerId) {
        const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
        if (candidates.length === 0) return
        host.queueSkill({ skillId: QINGYUAN, ownerId, step: 'pick-first', data: {} })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.marks.qingyuanSecondPicked) return
        owner.marks.qingyuanSecondPicked = 1
        const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
        if (candidates.length === 0) return
        host.queueSkill({ skillId: QINGYUAN, ownerId, step: 'pick-second', data: {} })
      },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const targets = host.state.qingyuanTargets?.[ownerId] ?? []
        if (!payload.playerId || !targets.includes(payload.playerId)) return
        if (usedThisTurn(host.state, ownerId, QINGYUAN)) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const pool = targets
          .map((id) => playerOf(host.state, id))
          .filter((player): player is NonNullable<typeof player> => Boolean(player?.alive && player.zones.hand.length > 0))
        if (pool.length === 0) return
        markUsedThisTurn(host.state, ownerId, QINGYUAN)
        const target = pool[host.rng.nextInt(pool.length)]
        const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
        moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: QINGYUAN }, { sourceId: target.id, targetId: ownerId, cardIds: [cardId] })
        host.dispatch('SkillActivated', { skillId: QINGYUAN, skillName: '轻缘', playerId: ownerId, targetId: target.id, logText: `${owner.nickname}发动【轻缘】` }, { sourceId: ownerId, targetId: target.id })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'pick-first' || prompt.step === 'pick-second') {
      const existing = host.state.qingyuanTargets?.[ownerId] ?? []
      const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && !existing.includes(player.id))
      const pool = prompt.step === 'pick-second' && candidates.length === 0
        ? alivePlayers(host.state).filter((player) => player.id !== ownerId)
        : candidates
      if (pool.length === 0) return
      host.askSkill({
        skillId: QINGYUAN, ownerId, step: prompt.step, data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【轻缘】：选择一名其他角色', timeoutMs: 20_000, optional: false,
          options: pool.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId) return
    host.state.qingyuanTargets ??= {}
    const existing = host.state.qingyuanTargets[ownerId] ?? []
    if (existing.includes(targetId)) return
    host.state.qingyuanTargets[ownerId] = [...existing, targetId]
    const owner = playerOf(host.state, ownerId)
    if (owner) host.dispatch('SkillActivated', { skillId: QINGYUAN, skillName: '轻缘', playerId: ownerId, targetId, logText: `${owner.nickname}发动【轻缘】选择了目标` }, { sourceId: ownerId, targetId })
    void resolution
  },
})

registerSkillRuntime({
  id: ZHONGSHEN,
  triggers: [
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        const reds = (payload.cardIds ?? []).filter((id) => host.state.cards[id]?.color === 'red')
        if (reds.length === 0) return
        host.state.zhongshenRedCardIds ??= {}
        host.state.zhongshenRedCardIds[ownerId] = [...new Set([...(host.state.zhongshenRedCardIds[ownerId] ?? []), ...reds])]
      },
    },
    {
      event: 'RoundStart',
      handle(host, ownerId) {
        if (host.state.zhongshenRedCardIds) delete host.state.zhongshenRedCardIds[ownerId]
      },
    },
  ],
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner) return []
    const eligible = (state.zhongshenRedCardIds?.[ownerId] ?? []).filter((id) => owner.zones.hand.includes(id))
    return eligible.map((cardId) => ({ asCardName: '闪', cardId, label: '重身：当【闪】' }))
  },
})

/* ============================== 曹安民 ============================== */

const XIANWEI = 'xianwei'
const ABOLISHABLE_ORDER: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

registerSkillRuntime({
  id: XIANWEI,
  globalIgnoresDistanceTo(state, ownerId, attackerId, targetId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.marks.xianweiAllSlotsAbolished) return false
    return attackerId !== ownerId && targetId === ownerId
  },
  ignoresDistanceTo(state, ownerId) {
    return Boolean(playerOf(state, ownerId)?.marks.xianweiAllSlotsAbolished)
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const remaining = abolishableSlotsOf(host.state, ownerId).filter((slot) => ABOLISHABLE_ORDER.includes(slot))
      if (remaining.length === 0) return
      const slot = ABOLISHABLE_ORDER.find((candidate) => remaining.includes(candidate))
      if (!slot) return
      const equipped = owner.zones.equipment[slot]
      if (equipped) {
        moveCard(host.state, equipped, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
        handleEquipmentLost(host as never, ownerId, equipped)
      }
      abolishSlot(host.state, ownerId, slot)
      host.dispatch('SkillActivated', { skillId: XIANWEI, skillName: '险卫', playerId: ownerId, logText: `${owner.nickname}发动【险卫】，废除了${slot}` }, { sourceId: ownerId })
      const n = equipmentSlotsOf(host.state, ownerId).length
      if (n > 0) drawCards(host.state, host.rng, ownerId, n, (name, payload2) => { host.dispatch(name, payload2) })
      host.queueSkill({ skillId: XIANWEI, ownerId, step: 'target', data: { slot } })
      if (abolishableSlotsOf(host.state, ownerId).length === 0 && !owner.marks.xianweiAllSlotsAbolished) {
        owner.marks.xianweiAllSlotsAbolished = 1
        owner.maxHp += 2
        owner.hp += 2
        host.dispatch('MaxHpChange', { playerId: ownerId, maxHp: owner.maxHp, hp: owner.hp, amount: 2, trimmed: 0, reason: XIANWEI }, { targetId: ownerId })
        host.dispatch('SkillActivated', { skillId: XIANWEI, skillName: '险卫', playerId: ownerId, logText: `${owner.nickname}装备栏全部废除，体力上限+2` }, { sourceId: ownerId })
      }
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const { slot } = prompt.data as { slot: EquipmentSlot }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
    if (others.length === 0) return
    host.askSkill({
      skillId: XIANWEI, ownerId, step: 'target', data: { slot },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【险卫】：选择一名其他角色', timeoutMs: 20_000, optional: false,
        options: others.map((player) => ({ id: player.id, label: player.nickname })),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { slot } = resolution.data as { slot: EquipmentSlot }
    const targetId = (response.payload as { optionId?: string }).optionId
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    const category = slot === 'weapon' ? 'weapon' : slot === 'armor' ? 'armor' : 'horse'
    const found = host.state.zones.drawPile.find((id) => {
      const card = host.state.cards[id]
      if (!card || card.category !== 'equipment' || !card.equipmentSlot) return false
      const cat = card.equipmentSlot === 'weapon' || card.equipmentSlot === 'weapon2' ? 'weapon' : card.equipmentSlot === 'armor' ? 'armor' : 'horse'
      return cat === category
    })
    if (found) {
      const card = host.state.cards[found]!
      // 直接从牌堆移入装备区（不经手牌中转）：经手牌会先广播 GainCard，
      // 中途可能被其他"获得牌后"反应技能（如胡金定轻缘）抢先把这张牌
      // 从手牌里拿走，导致紧接着的装备移动找不到来源区域。
      moveCard(host.state, found, { kind: 'drawPile' }, { kind: 'equipment', playerId: targetId!, slot: card.equipmentSlot! })
      host.dispatch('SkillActivated', { skillId: XIANWEI, skillName: '险卫', playerId: ownerId, targetId, logText: `${target.nickname}使用了【险卫】找到的装备` }, { sourceId: ownerId, targetId })
    } else {
      drawCards(host.state, host.rng, targetId!, 1, (n, p) => { host.dispatch(n, p) })
    }
  },
})

/* ============================== 赵昂 ============================== */

const ZHONGJIE = 'zhongjie'
const SUSHOU = 'sushou'

/*
 * 忠节需要在"求桃"流程进行中插入一个可选动作，而不是走 queueSkill——
 * queueSkill 只在牌局干净（没有濒死）时才继续，濒死流程本身正是它要
 * 介入的那个"不干净"的时刻，两者天然冲突。改用引擎已有的 rescueActions /
 * invokeRescueAction：这条公共入口就是给"求桃时刻的额外选项"用的
 * （文档原话），语义完全对得上，不需要新增机制。
 */
registerSkillRuntime({
  id: ZHONGJIE,
  triggers: [{
    event: 'LoseHp',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; hp?: number }
      const targetId = payload.playerId
      if (!targetId || (payload.hp ?? 1) > 0) return
      host.state.zhongjieLoseHpDying ??= {}
      host.state.zhongjieLoseHpDying[targetId] = true
    },
  }, {
    event: 'QuitDying',
    handle(host, ownerId, context) {
      void ownerId
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId && host.state.zhongjieLoseHpDying) delete host.state.zhongjieLoseHpDying[payload.playerId]
    },
  }, {
    event: 'Death',
    handle(host, ownerId, context) {
      void ownerId
      if (context.event.targetId && host.state.zhongjieLoseHpDying) delete host.state.zhongjieLoseHpDying[context.event.targetId]
    },
  }, {
    event: 'RoundStart',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.zhongjieRoundUsed = 0
    },
  }],
  rescueActions(state, ownerId, dyingPlayerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || (owner.marks.zhongjieRoundUsed ?? 0) >= 1) return []
    if (!state.zhongjieLoseHpDying?.[dyingPlayerId]) return []
    return [{ id: ZHONGJIE, label: '忠节：令其回复1点体力并摸1张牌' }]
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== ZHONGJIE) return false
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, dyingPlayerId)
    if (!owner?.alive || !target?.alive) return false
    owner.marks.zhongjieRoundUsed = 1
    recover(host, dyingPlayerId, 1, ownerId)
    drawCards(host.state, host.rng, dyingPlayerId, 1, (n, p) => { host.dispatch(n, p) })
    host.dispatch('SkillActivated', { skillId: ZHONGJIE, skillName: '忠节', playerId: ownerId, targetId: dyingPlayerId, logText: `${owner.nickname}发动【忠节】` }, { sourceId: ownerId, targetId: dyingPlayerId })
    return true
  },
})

registerSkillRuntime({
  id: SUSHOU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || !payload.playerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const target = playerOf(host.state, payload.playerId)
      if (!target?.alive) return
      const isUniqueMax = alivePlayers(host.state).every((player) => player.id === target.id || player.zones.hand.length < target.zones.hand.length)
      if (!isUniqueMax || target.zones.hand.length === 0) return
      host.queueSkill({ skillId: SUSHOU, ownerId, step: 'ask', data: { targetId: target.id } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.hp <= 0) return
    host.askSkill({
      skillId: SUSHOU, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【夙守】：是否失去1点体力发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      loseHp(host, ownerId, 1, SUSHOU)
      host.dispatch('SkillActivated', { skillId: SUSHOU, skillName: '夙守', playerId: ownerId, targetId, logText: `${owner.nickname}发动【夙守】` }, { sourceId: ownerId, targetId })
      host.queueSkill({ skillId: SUSHOU, ownerId, step: 'draw', data: { targetId } })
      return
    }
    if (resolution.step === 'draw') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const x = Math.max(0, owner.maxHp - owner.hp)
      if (x > 0) drawCards(host.state, host.rng, ownerId, x, (n, p) => { host.dispatch(n, p) })
      if (host.state.currentPlayerId === ownerId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.zones.hand.length === 0) return
      const n2 = Math.floor(target.zones.hand.length / 2)
      const shown = [...target.zones.hand].slice(0, n2)
      if (shown.length === 0 || owner.zones.hand.length === 0) return
      const cap = Math.min(x, shown.length, owner.zones.hand.length)
      if (cap <= 0) return
      host.askSkill({
        skillId: SUSHOU, ownerId, step: 'swap-give', data: { targetId, shown, cap },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【夙守】：可以选择至多${cap}张自己的手牌，与看到的牌等量交换`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: cap,
        }),
      })
      return
    }
    if (resolution.step === 'swap-give') {
      const { targetId, shown } = resolution.data as { targetId: PlayerId; shown: CardId[]; cap: number }
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      const give = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (give.length === 0) return
      const validShown = shown.filter((id) => target.zones.hand.includes(id))
      const n = Math.min(give.length, validShown.length)
      if (n === 0) return
      host.askSkill({
        skillId: SUSHOU, ownerId, step: 'swap-take', data: { targetId, give: give.slice(0, n), shown: validShown.slice(0, n), n },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【夙守】：从看到的牌中选择${n}张换入`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: validShown.slice(0, n), hiddenCardSlots: [], min: n, max: n,
        }),
      })
      return
    }
    if (resolution.step === 'swap-take') {
      const { targetId, give, shown } = resolution.data as { targetId: PlayerId; give: CardId[]; shown: CardId[]; n: number }
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      const take = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => shown.includes(id) && target.zones.hand.includes(id))
      const validGive = give.filter((id) => owner.zones.hand.includes(id))
      const count = Math.min(take.length, validGive.length)
      if (count === 0) return
      for (let i = 0; i < count; i += 1) {
        moveCard(host.state, validGive[i], { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
        moveCard(host.state, take[i], { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      }
      host.dispatch('GainCard', { playerId: targetId, cardIds: validGive.slice(0, count), reason: SUSHOU }, { sourceId: ownerId, targetId, cardIds: validGive.slice(0, count) })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: take.slice(0, count), reason: SUSHOU }, { sourceId: targetId, targetId: ownerId, cardIds: take.slice(0, count) })
    }
  },
})

/* ============================== 夏侯杰 ============================== */

const LIEDAN = 'liedan'
const ZHUANGDAN = 'zhuangdan'

function equipmentCountOf(state: SanguoshaState, playerId: PlayerId): number {
  const player = playerOf(state, playerId)
  return player ? Object.values(player.zones.equipment).filter(Boolean).length : 0
}

registerSkillRuntime({
  id: LIEDAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || !payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, payload.playerId)
      if (!owner?.alive || !target?.alive) return
      if (owner.marks.zhuangdanDisabled) return
      let wins = 0
      if (owner.zones.hand.length > target.zones.hand.length) wins += 1
      if (owner.hp > target.hp) wins += 1
      if (equipmentCountOf(host.state, ownerId) > equipmentCountOf(host.state, target.id)) wins += 1
      if (wins > 0) {
        drawCards(host.state, host.rng, ownerId, Math.min(3, wins), (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: LIEDAN, skillName: '裂胆', playerId: ownerId, targetId: target.id, logText: `${owner.nickname}发动【裂胆】，摸了${wins}张牌` }, { sourceId: ownerId, targetId: target.id })
      }
      if (wins === 3) {
        owner.maxHp += 1
        owner.hp += 1
        host.dispatch('MaxHpChange', { playerId: ownerId, maxHp: owner.maxHp, hp: owner.hp, amount: 1, trimmed: 0, reason: LIEDAN }, { targetId: ownerId })
      }
      const losses = (owner.zones.hand.length <= target.zones.hand.length ? 1 : 0)
        + (owner.hp <= target.hp ? 1 : 0)
        + (equipmentCountOf(host.state, ownerId) <= equipmentCountOf(host.state, target.id) ? 1 : 0)
      if (losses === 3) {
        loseHp(host, ownerId, 1, LIEDAN)
        const owner2 = playerOf(host.state, ownerId)
        if (owner2?.alive) {
          owner2.marks.lieMarks = (owner2.marks.lieMarks ?? 0) + 1
          host.dispatch('SkillActivated', { skillId: LIEDAN, skillName: '裂胆', playerId: ownerId, logText: `${owner2.nickname}发动【裂胆】，失去1点体力并获得一枚裂` }, { sourceId: ownerId })
        }
      }
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (owner?.alive && (owner.marks.lieMarks ?? 0) >= 5) killPlayer(host as never, ownerId, ownerId, LIEDAN)
    },
  }],
})

registerSkillRuntime({
  id: ZHUANGDAN,
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (!payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.marks.zhuangdanDisabled) return
      const isUniqueMax = alivePlayers(host.state).every((player) => player.id === ownerId || player.zones.hand.length < owner.zones.hand.length)
      if (!isUniqueMax) return
      owner.marks.zhuangdanDisabled = 1
      host.dispatch('SkillActivated', { skillId: ZHUANGDAN, skillName: '壮胆', playerId: ownerId, logText: `${owner.nickname}发动【壮胆】，裂胆失效直到本回合结束` }, { sourceId: ownerId })
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.zhuangdanDisabled = 0
    },
  }],
})

/* ============================== 史阿 ============================== */

const LIREN = 'liren'
const JIANCHU = 'jianchu'
const JIGE = 'jige'

registerSkillRuntime({
  id: LIREN,
  overridesAttackRange() {
    return 2
  },
  resolvedCardRecipient(state, ownerId, context) {
    if (context.cardName !== '杀' || context.cancelled) return false
    if (cardDamageDealt(state, context.cardId) <= 0) return false
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return false
    if ((owner.marks.lirenTurnCount ?? 0) >= 3) return false
    owner.marks.lirenTurnCount = (owner.marks.lirenTurnCount ?? 0) + 1
    return true
  },
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || !payload.playerId) return
        const player = playerOf(host.state, payload.playerId)
        if (player) player.marks.lirenTurnCount = 0
      },
    },
    {
      event: 'CardResolved',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string; cancelled?: boolean }
        if (payload.cardName !== '杀' || !payload.cancelled) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: LIREN, skillName: '砺刃', playerId: ownerId, logText: `${owner.nickname}发动【砺刃】` }, { sourceId: ownerId })
      },
    },
    {
      event: 'Death',
      allowDeadOwner: true,
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
        if (candidates.length === 0) return
        host.queueSkill({ skillId: LIREN, ownerId, step: 'transfer', data: {} })
      },
    },
  ],
  allowsDeadResponder: true,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'transfer') return
    const candidates = alivePlayers(host.state)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: LIREN, ownerId, step: 'transfer', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【砺刃】：可以选择一名角色永久获得【砺刃】', timeoutMs: 20_000, optional: true,
        options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    void resolution
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    grantSkill(host.state, targetId, LIREN)
    host.dispatch('SkillActivated', { skillId: LIREN, skillName: '砺刃', playerId: ownerId, targetId, logText: `${target.nickname}永久获得了【砺刃】` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: JIANCHU,
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId || host.state.phase === 'draw') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.marks.jianchuAwakened) return
      owner.marks.jianchuOutsideDrawCount = (owner.marks.jianchuOutsideDrawCount ?? 0) + (payload.cardIds?.length ?? 0)
      if ((owner.marks.jianchuOutsideDrawCount ?? 0) < 5) return
      owner.marks.jianchuAwakened = 1
      recover(host, ownerId, 1, ownerId)
      grantSkill(host.state, ownerId, JIGE)
      host.dispatch('SkillActivated', { skillId: JIANCHU, skillName: '剑出', playerId: ownerId, logText: `${owner.nickname}觉醒，获得【击格】` }, { sourceId: ownerId })
    },
  }],
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.marks.jianchuAwakened) return []
    return owner.zones.hand
      .filter((id) => state.cards[id]?.name === '闪')
      .map((cardId) => ({ asCardName: '杀', cardId, label: '剑出：当【杀】' }))
  },
})

registerSkillRuntime({
  id: JIGE,
  offersTargetDamagePreventionAsk(host, ownerId, context) {
    if (context.cardName !== '杀' || !context.cardId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    const baseRank = host.state.cards[context.cardId]?.rank ?? 0
    const eligible = owner.zones.hand.filter((id) => host.state.cards[id]?.name === '杀' && (host.state.cards[id]?.rank ?? 0) > baseRank)
    if (eligible.length === 0) return false
    host.askSkill({
      skillId: JIGE, ownerId, step: 'defend', data: { eligible },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【击格】：可以打出一张点数更大的【杀】抵消这张杀', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: eligible, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
    return true
  },
  triggers: [{
    /*
     * 官方文本是"造成伤害时，Damage+(S-T)"，即改动同一次伤害的数值。
     * 引擎目前只有 DamageCaused 时机做同步数值修正、没有可安全挂起
     * 询问的伤害内追加点；因此按"伤害结算完毕后立即追加一次独立伤害"
     * 落地，玩家可见结果一致（总伤害仍是原始值+额外值），已知简化点是
     * 追加的这部分不会再触发原伤害同一实例上的藤甲/连环等属性判定。
     */
    event: 'Damaged',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      if (sourceId !== ownerId || !targetId) return
      const payload = context.event.payload as { cardName?: string }
      if (payload.cardName !== '杀') return
      host.queueSkill({ skillId: JIGE, ownerId, step: 'attack-ask', data: { targetId } })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'defend') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) { resumeTargetDamagePrevention(host as never, false); return }
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIGE }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: JIGE, skillName: '击格', playerId: ownerId, logText: `${owner.nickname}发动【击格】抵消了这张杀` }, { sourceId: ownerId })
      resumeTargetDamagePrevention(host as never, true, JIGE)
      return
    }
    if (resolution.step === 'attack-ask') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const ownSlashes = owner.zones.hand.filter((id) => host.state.cards[id]?.name === '杀')
      const targetSlashes = target.zones.hand.filter((id) => host.state.cards[id]?.name === '杀')
      for (const cardId of ownSlashes) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      if (ownSlashes.length > 0) host.dispatch('LoseCard', { playerId: ownerId, cardIds: ownSlashes, reason: JIGE }, { sourceId: ownerId, cardIds: ownSlashes })
      for (const cardId of targetSlashes) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      if (targetSlashes.length > 0) host.dispatch('LoseCard', { playerId: targetId, cardIds: targetSlashes, reason: JIGE }, { sourceId: ownerId, targetId, cardIds: targetSlashes })
      host.dispatch('SkillActivated', { skillId: JIGE, skillName: '击格', playerId: ownerId, targetId, logText: `${owner.nickname}发动【击格】` }, { sourceId: ownerId, targetId })
      const extra = Math.max(0, ownSlashes.length - targetSlashes.length)
      if (extra > 0 && target.alive) resolveDamage(host as never, { sourceId: ownerId, targetId, amount: extra, nature: 'normal', cardName: null })
    }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'attack-ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const ownSlashes = owner.zones.hand.filter((id) => host.state.cards[id]?.name === '杀')
    host.askSkill({
      skillId: JIGE, ownerId, step: 'attack-ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【击格】：是否弃置双方所有【杀】以追加伤害？（自己${ownSlashes.length}张）`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
})

/* ============================== 葛玄 ============================== */

const LIANHUA = 'lianhua'
const ZHAFU = 'zhafu'
const GEXUAN_ZHIYAN = 'gexuan-zhiyan'
const GEXUAN_GONGXIN = 'gexuan-gongxin'

function findCardInPoolByName(state: SanguoshaState, name: string): CardId | undefined {
  return state.zones.drawPile.find((id) => state.cards[id]?.name === name)
}

function gainFromDeckByName(host: SkillHost, playerId: PlayerId, name: string, reason: string): void {
  const cardId = findCardInPoolByName(host.state, name)
  if (!cardId) return
  moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  host.dispatch('GainCard', { playerId, cardIds: [cardId], reason }, { targetId: playerId, cardIds: [cardId] })
}

// 直言/攻心两支未能在可信来源核实到附加给葛玄的确切官方文本，为避免凭记忆
// 臆造功能性被动，这两支只挂名（不附加除下方真实获得的牌以外的效果）。
registerSkillRuntime({ id: GEXUAN_ZHIYAN })
registerSkillRuntime({ id: GEXUAN_GONGXIN })

registerSkillRuntime({
  id: LIANHUA,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (host.state.currentPlayerId === ownerId) return
        const targetId = context.event.targetId
        if (!targetId || targetId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        const target = playerOf(host.state, targetId)
        if (!owner?.alive || !target) return
        const color = sameCamp(owner.identity, target.identity) ? 'red' : 'black'
        host.state.danxueMarks ??= {}
        const list = host.state.danxueMarks[ownerId] ?? []
        host.state.danxueMarks[ownerId] = [...list, color]
        host.dispatch('SkillActivated', { skillId: LIANHUA, skillName: '炼化', playerId: ownerId, logText: `${owner.nickname}获得了一枚丹血` }, { sourceId: ownerId })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const marks = host.state.danxueMarks?.[ownerId] ?? []
        const total = marks.length
        const reds = marks.filter((c) => c === 'red').length
        const blacks = total - reds
        if (host.state.danxueMarks) delete host.state.danxueMarks[ownerId]
        if (total <= 3) {
          replaceTemporarySkills(host.state, ownerId, `${LIANHUA}:${ownerId}`, ['yingzi'])
          gainFromDeckByName(host, ownerId, '桃', LIANHUA)
        } else if (reds > blacks) {
          replaceTemporarySkills(host.state, ownerId, `${LIANHUA}:${ownerId}`, ['guanxing'])
          gainFromDeckByName(host, ownerId, '无中生有', LIANHUA)
        } else if (blacks > reds) {
          replaceTemporarySkills(host.state, ownerId, `${LIANHUA}:${ownerId}`, [GEXUAN_ZHIYAN])
          gainFromDeckByName(host, ownerId, '顺手牵羊', LIANHUA)
        } else {
          replaceTemporarySkills(host.state, ownerId, `${LIANHUA}:${ownerId}`, [GEXUAN_GONGXIN])
          gainFromDeckByName(host, ownerId, '杀', LIANHUA)
          gainFromDeckByName(host, ownerId, '决斗', LIANHUA)
        }
        host.dispatch('SkillActivated', { skillId: LIANHUA, skillName: '炼化', playerId: ownerId, logText: `${owner.nickname}发动【炼化】` }, { sourceId: ownerId })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        replaceTemporarySkills(host.state, ownerId, `${LIANHUA}:${ownerId}`, [])
      },
    },
  ],
})

registerSkillRuntime({
  id: ZHAFU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId || playerOf(host.state, ownerId)?.marks.zhafuUsed) return
      const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
      if (candidates.length === 0) return
      host.queueSkill({ skillId: ZHAFU, ownerId, step: 'ask', data: {} })
    },
  }, {
    event: 'PhaseStart',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'discard' || !payload.playerId) return
      const targetId = payload.playerId
      if (host.state.zhafuPendingTarget !== targetId) return
      host.state.zhafuPendingTarget = undefined
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.zones.hand.length <= 1) return
      host.queueSkill({ skillId: ZHAFU, ownerId: host.state.zhafuOwnerId ?? targetId, step: 'keep', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (prompt.step === 'ask') {
      if (!owner?.alive) return
      const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
      if (candidates.length === 0) return
      host.askSkill({
        skillId: ZHAFU, ownerId, step: 'ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【札符】：选择一名其他角色', timeoutMs: 20_000, optional: false,
          options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
      return
    }
    if (prompt.step === 'keep') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.zones.hand.length === 0) return
      host.askSkill({
        skillId: ZHAFU, ownerId, step: 'keep', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【札符】：选择保留一张手牌，其余交给葛玄', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const targetId = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      owner.marks.zhafuUsed = 1
      host.state.zhafuPendingTarget = targetId
      host.state.zhafuOwnerId = ownerId
      host.dispatch('SkillActivated', { skillId: ZHAFU, skillName: '札符', playerId: ownerId, targetId, logText: `${owner.nickname}发动【札符】` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'keep') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      const [keepId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const rest = target.zones.hand.filter((id) => id !== keepId)
      for (const cardId of rest) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      if (rest.length > 0) host.dispatch('GainCard', { playerId: ownerId, cardIds: rest, reason: ZHAFU }, { sourceId: targetId, targetId: ownerId, cardIds: rest })
    }
  },
})

/* ============================== 童渊 ============================== */

const CHAOFENG = 'chaofeng'
const CHUANSHU = 'chuanshu'
const CHUANYUN = 'chuanyun'

registerSkillRuntime({
  id: CHAOFENG,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks.chaofengPhaseUsed = 0
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.marks.chaofengPhaseUsed || owner.zones.hand.length === 0) return
        const payload = context.event.payload as { cardName?: string }
        host.queueSkill({ skillId: CHAOFENG, ownerId, step: 'ask', data: { damageCardName: payload.cardName ?? null } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.marks.chaofengPhaseUsed || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: CHAOFENG, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【朝凤】：可以弃置一张手牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { damageCardName } = resolution.data as { damageCardName: string | null }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner.zones.hand.includes(cardId)) return
    owner.marks.chaofengPhaseUsed = 1
    const discardedCard = host.state.cards[cardId]
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: CHAOFENG }, { sourceId: ownerId, cardIds: [cardId] })
    drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
    const damageCard = damageCardName ? Object.values(host.state.cards).find((c) => c.name === damageCardName) : undefined
    if (discardedCard?.color && damageCard?.color && discardedCard.color === damageCard.color) {
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
    }
    host.dispatch('SkillActivated', { skillId: CHAOFENG, skillName: '朝凤', playerId: ownerId, logText: `${owner.nickname}发动【朝凤】` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: CHUANSHU,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.marks.chuanshuUsed || owner.hp >= owner.maxHp) return
        const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
        if (candidates.length === 0) return
        host.queueSkill({ skillId: CHUANSHU, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'Death',
      allowDeadOwner: true,
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner?.marks.chuanshuUsed) return
        const candidates = alivePlayers(host.state)
        if (candidates.length === 0) return
        host.queueSkill({ skillId: CHUANSHU, ownerId, step: 'ask', data: {} })
      },
    },
  ],
  allowsDeadResponder: true,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (owner?.marks.chuanshuUsed) return
    const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: CHUANSHU, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【传术】：可以选择一名其他角色永久获得【朝凤】', timeoutMs: 20_000, optional: true,
        options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    void resolution
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const owner = playerOf(host.state, ownerId)
    if (!owner || owner.marks.chuanshuUsed) return
    owner.marks.chuanshuUsed = 1
    grantSkill(host.state, targetId, CHAOFENG)
    if (owner.alive) {
      grantSkill(host.state, ownerId, 'longdan')
      grantSkill(host.state, ownerId, 'congjian')
      grantSkill(host.state, ownerId, CHUANYUN)
    }
    host.dispatch('SkillActivated', { skillId: CHUANSHU, skillName: '传术', playerId: ownerId, targetId, logText: `${target.nickname}永久获得了【朝凤】` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: CHUANYUN,
  triggers: [{
    event: 'TargetSpecified',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }
      if (payload.cardName !== '杀' || context.event.sourceId !== ownerId) return
      const targetId = payload.targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !target?.alive) return
      const equipped = Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
      if (equipped.length === 0) return
      host.queueSkill({ skillId: CHUANYUN, ownerId, step: 'ask', data: { targetId: target.id } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive) return
    const equipped = Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
    if (equipped.length === 0) return
    host.askSkill({
      skillId: CHUANYUN, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【穿云】：是否令${target.nickname}随机弃置一张装备区里的牌？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const equipped = Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
    if (equipped.length === 0) return
    const cardId = equipped[host.rng.nextInt(equipped.length)]
    const slot = (Object.entries(target.zones.equipment).find(([, id]) => id === cardId) ?? [])[0] as EquipmentSlot
    moveCard(host.state, cardId, { kind: 'equipment', playerId: target.id, slot }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: CHUANYUN }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: CHUANYUN, skillName: '穿云', playerId: ownerId, targetId: target.id, logText: `${owner.nickname}发动【穿云】` }, { sourceId: ownerId, targetId: target.id })
  },
})

/* ============================== 赵直 ============================== */

const TONGGUAN = 'tongguan'
const MENGJIE = 'mengjie'
type TongguanAttribute = 'wuyong' | 'ganggying' | 'duomou' | 'guojue' | 'renzhi'
const TONGGUAN_LABELS: Record<TongguanAttribute, string> = {
  wuyong: '武勇', ganggying: '刚硬', duomou: '多谋', guojue: '果决', renzhi: '仁智',
}

registerSkillRuntime({
  id: TONGGUAN,
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const targetId = payload.playerId
        if (!targetId) return
        const owner = playerOf(host.state, ownerId)
        const target = playerOf(host.state, targetId)
        if (!owner?.alive || !target?.alive) return
        if (host.state.tongguanAssigned?.includes(targetId)) return
        const counts = host.state.tongguanCounts ?? {}
        const options = (Object.keys(TONGGUAN_LABELS) as TongguanAttribute[]).filter((attr) => (counts[attr] ?? 0) < 2)
        if (options.length === 0) return
        host.queueSkill({ skillId: TONGGUAN, ownerId, step: 'assign', data: { targetId, options } })
      },
    },
    {
      event: 'Damaged',
      handle(host, _ownerId, context) {
        const sourceId = context.event.sourceId
        if (!sourceId || host.state.currentPlayerId !== sourceId) return
        const player = playerOf(host.state, sourceId)
        if (player) player.marks.tongguanTurnDamage = 1
      },
    },
    {
      event: 'Recover',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (!payload.playerId || host.state.currentPlayerId !== payload.playerId) return
        const player = playerOf(host.state, payload.playerId)
        if (player) player.marks.tongguanTurnRecovered = 1
      },
    },
    {
      event: 'GainCard',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; reason?: string }
        if (!payload.playerId || host.state.currentPlayerId !== payload.playerId) return
        const player = playerOf(host.state, payload.playerId)
        if (!player) return
        if (payload.reason === 'draw' && host.state.phase !== 'draw') player.marks.tongguanTurnDrawOutside = 1
      },
    },
    {
      event: 'LoseCard',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const sourceId = context.event.sourceId
        if (!payload.playerId || host.state.currentPlayerId !== sourceId || sourceId === payload.playerId) return
        const player = playerOf(host.state, sourceId!)
        if (player) player.marks.tongguanTurnTook = 1
      },
    },
    {
      event: 'GainCard',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const sourceId = context.event.sourceId
        if (!payload.playerId || host.state.currentPlayerId !== payload.playerId || sourceId === payload.playerId || !sourceId) return
        const player = playerOf(host.state, payload.playerId)
        if (player) player.marks.tongguanTurnTook = 1
      },
    },
    {
      event: 'GainCard',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const sourceId = context.event.sourceId
        if (!payload.playerId || host.state.currentPlayerId !== sourceId || sourceId === payload.playerId || !sourceId) return
        const player = playerOf(host.state, sourceId)
        if (player) player.marks.tongguanTurnGave = 1
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const targetId = payload.playerId
        if (!targetId) return
        const owner = playerOf(host.state, ownerId)
        const target = playerOf(host.state, targetId)
        if (!owner?.alive || !target) return
        const attr = host.state.tongguanAttributeOf?.[targetId] as TongguanAttribute | undefined
        if (!attr) return
        let done = false
        if (attr === 'wuyong') done = Boolean(target.marks.tongguanTurnDamage)
        else if (attr === 'ganggying') done = Boolean(target.marks.tongguanTurnRecovered) || target.zones.hand.length > target.hp
        else if (attr === 'duomou') done = Boolean(target.marks.tongguanTurnDrawOutside)
        else if (attr === 'guojue') done = Boolean(target.marks.tongguanTurnTook)
        else if (attr === 'renzhi') done = Boolean(target.marks.tongguanTurnGave)
        target.marks.tongguanTurnDamage = 0
        target.marks.tongguanTurnRecovered = 0
        target.marks.tongguanTurnDrawOutside = 0
        target.marks.tongguanTurnTook = 0
        target.marks.tongguanTurnGave = 0
        if (!done) return
        host.queueSkill({ skillId: MENGJIE, ownerId, step: attr, data: { targetId } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'assign') return
    const { targetId, options } = prompt.data as { targetId: PlayerId; options: TongguanAttribute[] }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    host.askSkill({
      skillId: TONGGUAN, ownerId, step: 'assign', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【统观】：为${target.nickname}选择一项属性`, timeoutMs: 20_000, optional: false,
        options: options.map((attr) => ({ id: attr, label: TONGGUAN_LABELS[attr] })),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { targetId } = resolution.data as { targetId: PlayerId }
    const attr = (response.payload as { optionId?: string }).optionId as TongguanAttribute | undefined
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || !attr) return
    host.state.tongguanAssigned = [...(host.state.tongguanAssigned ?? []), targetId]
    host.state.tongguanAttributeOf ??= {}
    host.state.tongguanAttributeOf[targetId] = attr
    host.state.tongguanCounts ??= {}
    host.state.tongguanCounts[attr] = (host.state.tongguanCounts[attr] ?? 0) + 1
    host.dispatch('SkillActivated', { skillId: TONGGUAN, skillName: '统观', playerId: ownerId, targetId, logText: `${target.nickname}被赋予了【${TONGGUAN_LABELS[attr]}】` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: MENGJIE,
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const step = prompt.step as TongguanAttribute
    if (step === 'wuyong') {
      const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
      if (others.length === 0) return
      host.askSkill({
        skillId: MENGJIE, ownerId, step, data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【梦解】：武勇，选择一名其他角色造成1点伤害', timeoutMs: 20_000, optional: false,
          options: others.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
      return
    }
    if (step === 'ganggying') {
      host.askSkill({
        skillId: MENGJIE, ownerId, step, data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【梦解】：刚硬，选择一名角色回复1点体力', timeoutMs: 20_000, optional: false,
          options: alivePlayers(host.state).map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
      return
    }
    if (step === 'duomou') {
      drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: MENGJIE, skillName: '梦解', playerId: ownerId, logText: `${owner.nickname}发动【梦解】：多谋，摸了2张牌` }, { sourceId: ownerId })
      return
    }
    if (step === 'guojue') {
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const pool = [...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.hand]
      if (pool.length === 0) return
      const n = Math.min(2, pool.length)
      const picked: CardId[] = []
      const remaining = [...pool]
      for (let i = 0; i < n; i += 1) picked.push(...remaining.splice(host.rng.nextInt(remaining.length), 1))
      for (const cardId of picked) {
        const zone: 'equipment' | 'hand' = Object.values(target.zones.equipment).includes(cardId) ? 'equipment' : 'hand'
        if (zone === 'equipment') {
          const slot = (Object.entries(target.zones.equipment).find(([, id]) => id === cardId) ?? [])[0] as EquipmentSlot
          moveCard(host.state, cardId, { kind: 'equipment', playerId: target.id, slot }, { kind: 'discardPile' })
        } else {
          moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
        }
      }
      host.dispatch('LoseCard', { playerId: target.id, cardIds: picked, reason: MENGJIE }, { sourceId: ownerId, targetId: target.id, cardIds: picked })
      host.dispatch('SkillActivated', { skillId: MENGJIE, skillName: '梦解', playerId: ownerId, targetId: target.id, logText: `${owner.nickname}发动【梦解】：果决` }, { sourceId: ownerId, targetId: target.id })
      return
    }
    if (step === 'renzhi') {
      const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
      if (others.length === 0) return
      host.askSkill({
        skillId: MENGJIE, ownerId, step, data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【梦解】：仁智，选择一名其他角色摸至体力上限（最多5）', timeoutMs: 20_000, optional: false,
          options: others.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const step = resolution.step as TongguanAttribute
    if (step === 'wuyong') {
      const targetId = (response.payload as { optionId?: string }).optionId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.dispatch('SkillActivated', { skillId: MENGJIE, skillName: '梦解', playerId: ownerId, targetId, logText: `${owner.nickname}发动【梦解】：武勇` }, { sourceId: ownerId, targetId })
      resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, nature: 'normal', cardName: null })
      return
    }
    if (step === 'ganggying') {
      const targetId = (response.payload as { optionId?: string }).optionId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.dispatch('SkillActivated', { skillId: MENGJIE, skillName: '梦解', playerId: ownerId, targetId, logText: `${owner.nickname}发动【梦解】：刚硬` }, { sourceId: ownerId, targetId })
      recover(host, targetId!, 1, ownerId)
      return
    }
    if (step === 'renzhi') {
      const targetId = (response.payload as { optionId?: string }).optionId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const cap = Math.min(target.maxHp, 5)
      const need = Math.max(0, cap - target.zones.hand.length)
      if (need > 0) drawCards(host.state, host.rng, targetId!, need, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: MENGJIE, skillName: '梦解', playerId: ownerId, targetId, logText: `${owner.nickname}发动【梦解】：仁智` }, { sourceId: ownerId, targetId })
    }
  },
})

/* ============================== 刘晔 ============================== */

const POYUAN = 'poyuan'
const HUACE = 'huace'
const PILIHUO_PILE = 'pilihuo-destroyed'
let pilihuoSeq = 0

function hasPilihuo(state: SanguoshaState, ownerId: PlayerId): CardId | undefined {
  const owner = playerOf(state, ownerId)
  if (!owner) return undefined
  return Object.values(owner.zones.equipment).find((id) => id && state.cards[id]?.name === '霹雳车')
}

/**
 * 霹雳车官方定义为"宝物"，本引擎没有宝物栏（沿用文件头张奋大攻车的既有
 * 简化），映射到武器栏；attackRange 给基础值 1（不改变距离，无距离限制
 * 另有独立的 slashIgnoresDistance 钩子负责）。
 */
function equipPilihuo(state: SanguoshaState, ownerId: PlayerId): void {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  const oldWeapon = owner.zones.equipment.weapon
  if (oldWeapon) state.zones.discardPile.push(oldWeapon)
  pilihuoSeq += 1
  const cardId: CardId = `pilihuo:${state.seq}:${pilihuoSeq}`
  state.cards[cardId] = {
    id: cardId, ruleset: state.rulesetVersion, expansion: 'maneuvering',
    name: '霹雳车', suit: 'diamond', rank: 9, color: 'red', category: 'equipment', equipmentSlot: 'weapon', attackRange: 1,
  }
  owner.zones.equipment.weapon = cardId
}

function isOwnTurnWithPilihuo(state: SanguoshaState, ownerId: PlayerId): boolean {
  return state.currentPlayerId === ownerId && Boolean(hasPilihuo(state, ownerId))
}

registerSkillRuntime({
  id: POYUAN,
  slashIgnoresDistance(state, ownerId) {
    return isOwnTurnWithPilihuo(state, ownerId)
  },
  recoverAmountBonus(state, _targetId, sourceId) {
    if (!sourceId) return 0
    return isOwnTurnWithPilihuo(state, sourceId) ? 1 : 0
  },
  triggers: [
    {
      event: 'GameStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (!hasPilihuo(host.state, ownerId)) { equipPilihuo(host.state, ownerId); return }
        const others = alivePlayers(host.state).filter((player) => player.id !== ownerId && Object.values(player.zones.equipment).some(Boolean))
        if (others.length > 0) host.queueSkill({ skillId: POYUAN, ownerId, step: 'discard', data: {} })
      },
    },
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (!hasPilihuo(host.state, ownerId)) { equipPilihuo(host.state, ownerId); return }
        const others = alivePlayers(host.state).filter((player) => player.id !== ownerId && Object.values(player.zones.equipment).some(Boolean))
        if (others.length > 0) host.queueSkill({ skillId: POYUAN, ownerId, step: 'discard', data: {} })
      },
    },
    {
      event: 'DamageCaused',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
        const payload = context.event.payload as { cardName?: unknown; amount?: number }
        if (payload.cardName !== '杀' || !hasPilihuo(host.state, ownerId)) return
        payload.amount = Math.max(0, Math.trunc(Number(payload.amount ?? 0))) + 1
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string }
        drawOnOutsideTurnBasicUse(host, ownerId, context.event.sourceId, payload.cardName)
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string }
        drawOnOutsideTurnBasicUse(host, ownerId, context.event.sourceId, payload.cardName)
      },
    },
    {
      event: 'CardMove',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardIds?: CardId[] }
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        for (const cardId of payload.cardIds ?? []) {
          const card = host.state.cards[cardId]
          if (card?.name !== '霹雳车') continue
          const inDiscard = host.state.zones.discardPile.includes(cardId)
          const handOwner = host.state.players.find((player) => player.zones.hand.includes(cardId))
          if (!inDiscard && !handOwner) continue
          if (inDiscard) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: PILIHUO_PILE })
          else moveCard(host.state, cardId, { kind: 'hand', playerId: handOwner!.id }, { kind: 'characterPile', playerId: ownerId, pile: PILIHUO_PILE })
        }
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const others = alivePlayers(host.state).filter((player) => player.id !== ownerId && Object.values(player.zones.equipment).some(Boolean))
    if (others.length === 0) return
    host.askSkill({
      skillId: POYUAN, ownerId, step: 'discard', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【破垣】：可以弃置一名其他角色装备区至多两张牌', timeoutMs: 20_000, optional: true,
        options: [...others.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    void resolution
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const equipped = Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
    const n = Math.min(2, equipped.length)
    const picked: CardId[] = []
    const remaining = [...equipped]
    for (let i = 0; i < n; i += 1) picked.push(...remaining.splice(host.rng.nextInt(remaining.length), 1))
    for (const cardId of picked) {
      const slot = (Object.entries(target.zones.equipment).find(([, id]) => id === cardId) ?? [])[0] as EquipmentSlot
      moveCard(host.state, cardId, { kind: 'equipment', playerId: target.id, slot }, { kind: 'discardPile' })
    }
    if (picked.length > 0) host.dispatch('LoseCard', { playerId: target.id, cardIds: picked, reason: POYUAN }, { sourceId: ownerId, targetId: target.id, cardIds: picked })
    host.dispatch('SkillActivated', { skillId: POYUAN, skillName: '破垣', playerId: ownerId, targetId, logText: `${owner.nickname}发动【破垣】` }, { sourceId: ownerId, targetId })
  },
})

function drawOnOutsideTurnBasicUse(host: SkillHost, ownerId: PlayerId, sourceId: PlayerId | undefined, cardName: string | undefined): void {
  if (!sourceId || sourceId !== ownerId || host.state.currentPlayerId === ownerId) return
  if (!cardName) return
  const card = Object.values(host.state.cards).find((c) => c.name === cardName)
  if (card?.category !== 'basic' || !hasPilihuo(host.state, ownerId)) return
  drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
}

registerSkillRuntime({
  id: HUACE,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        void ownerId
        const payload = context.event.payload as { cardName?: string }
        if (!payload.cardName || !INSTANT_TRICKS.has(payload.cardName)) return
        host.state.currentRoundUsedTrickNames ??= []
        if (!host.state.currentRoundUsedTrickNames.includes(payload.cardName)) host.state.currentRoundUsedTrickNames.push(payload.cardName)
      },
    },
    {
      event: 'RoundStart',
      handle(host, ownerId) {
        void ownerId
        host.state.previousRoundUsedTrickNames = [...(host.state.currentRoundUsedTrickNames ?? [])]
        host.state.currentRoundUsedTrickNames = []
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks.huaceUsed = 0
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cardName?: string }
        if (context.event.sourceId !== ownerId || !payload.cardId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        const printedName = host.state.cards[payload.cardId]?.name
        if (printedName && payload.cardName && printedName !== payload.cardName && INSTANT_TRICKS.has(payload.cardName)) {
          owner.marks.huaceUsed = 1
        }
      },
    },
  ],
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.marks.huaceUsed) return []
    const usedLastRound = new Set(state.previousRoundUsedTrickNames ?? [])
    const candidates = [...INSTANT_TRICKS].filter((name) => !usedLastRound.has(name))
    return owner.zones.hand.flatMap((cardId) => candidates.map((name) => ({ asCardName: name, cardId, label: `画策：当【${name}】` })))
  },
})

/* ============================== 陈珪 ============================== */

const YINGTU = 'yingtu'
const CONGSHI = 'congshi'

function livingNeighborsOf(state: SanguoshaState, playerId: PlayerId): { prev: PlayerId | null; next: PlayerId | null } {
  const sorted = [...state.players].filter((player) => player.alive).sort((left, right) => left.seat - right.seat)
  const index = sorted.findIndex((player) => player.id === playerId)
  if (index < 0 || sorted.length < 2) return { prev: null, next: null }
  const prev = sorted[(index - 1 + sorted.length) % sorted.length].id
  const next = sorted[(index + 1) % sorted.length].id
  return { prev, next }
}

registerSkillRuntime({
  id: YINGTU,
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (!payload.playerId || host.state.phase === 'draw') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, YINGTU)) return
      const { prev, next } = livingNeighborsOf(host.state, ownerId)
      let side: 'prev' | 'next' | null = null
      if (payload.playerId === prev) side = 'prev'
      else if (payload.playerId === next) side = 'next'
      if (!side) return
      const from = playerOf(host.state, payload.playerId)
      if (!from?.alive || from.zones.hand.length === 0) return
      markUsedThisTurn(host.state, ownerId, YINGTU)
      const cardId = from.zones.hand[host.rng.nextInt(from.zones.hand.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: from.id }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: YINGTU }, { sourceId: from.id, targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: YINGTU, skillName: '营图', playerId: ownerId, targetId: from.id, logText: `${owner.nickname}发动【营图】` }, { sourceId: ownerId, targetId: from.id })
      if (owner.zones.hand.length === 0) return
      const otherSideId = side === 'prev' ? next : prev
      if (!otherSideId) return
      host.queueSkill({ skillId: YINGTU, ownerId, step: 'give', data: { otherSideId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'give') return
    const { otherSideId } = prompt.data as { otherSideId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, otherSideId)
    if (!owner?.alive || !target?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: YINGTU, ownerId, step: 'give', data: { otherSideId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【营图】：交给${target.nickname}一张牌`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { otherSideId } = resolution.data as { otherSideId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, otherSideId)
    if (!owner?.alive || !target?.alive) return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner.zones.hand.includes(cardId)) return
    const card = host.state.cards[cardId]
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: otherSideId })
    host.dispatch('GainCard', { playerId: otherSideId, cardIds: [cardId], reason: YINGTU }, { sourceId: ownerId, targetId: otherSideId, cardIds: [cardId] })
    if (card?.category === 'equipment' && card.equipmentSlot) {
      const slotFree = !target.zones.equipment[card.equipmentSlot]
      if (target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: otherSideId }, { kind: 'equipment', playerId: otherSideId, slot: card.equipmentSlot })
        host.dispatch('SkillActivated', { skillId: YINGTU, skillName: '营图', playerId: ownerId, targetId: otherSideId, logText: `${target.nickname}使用了【营图】送来的装备` }, { sourceId: ownerId, targetId: otherSideId })
      }
      void slotFree
    }
  },
})

registerSkillRuntime({
  id: CONGSHI,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId || payload.cancelled || !payload.cardId) return
      const card = host.state.cards[payload.cardId]
      if (card?.category !== 'equipment') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const actorCount = Object.values(playerOf(host.state, sourceId)?.zones.equipment ?? {}).filter(Boolean).length
      const maxCount = Math.max(...alivePlayers(host.state).map((player) => Object.values(player.zones.equipment).filter(Boolean).length))
      if (actorCount < maxCount) return
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: CONGSHI, skillName: '从势', playerId: ownerId, logText: `${owner.nickname}发动【从势】` }, { sourceId: ownerId })
    },
  }],
})

/* ============================== 角色定义 ============================== */

export const HISTORICAL_BATCH23_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'hujinding', name: '胡金定', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: QINGYUAN, name: '轻缘', description: '锁定技，游戏开始时选择一名其他角色；本局首次受到伤害后，再选择一名其他角色。这些角色获得牌后，你每回合限一次，从中随机选择一名有手牌的角色，获得其一张随机手牌。' },
      { id: ZHONGSHEN, name: '重身', locked: true, description: '锁定技，你本轮内获得的红色牌，你可以将其当【闪】使用或打出。' },
    ],
  },
  {
    id: 'caoanmin', name: '曹安民', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: XIANWEI, name: '险卫', locked: true, description: '锁定技，准备阶段，你废除一个未废除的装备栏，然后摸X张牌（X为你未废除的装备栏数），令一名其他角色使用牌堆中第一张对应类别的装备牌（没有则摸一张牌）。所有装备栏首次全部废除后，你的体力上限+2，然后你与其他角色始终视为处于攻击范围内。' },
    ],
  },
  {
    id: 'zhaoang', name: '赵昂', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: ZHONGJIE, name: '忠节', description: '每轮限一次，当一名角色因失去体力进入濒死时，你可以令其回复1点体力，然后摸1张牌。' },
      { id: SUSHOU, name: '夙守', description: '一名角色的出牌阶段开始时，若其手牌数为全场唯一最多，你可以失去1点体力，然后摸X张牌（X为你已损失的体力值）；若不是你的回合，你可以观看其手牌中的一半，并用至多X张手牌与其等量交换。' },
    ],
  },
  {
    id: 'xiahoujie', name: '夏侯杰', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: LIEDAN, name: '裂胆', locked: true, description: '锁定技，其他角色的准备阶段，你与其比较手牌数、体力值、装备数：每项你更多则摸1张牌（最多3张），三项都更多则你的体力上限+1；三项都不比其更多，你失去1点体力并获得一枚"裂"；"裂"达到5枚时你死亡。' },
      { id: ZHUANGDAN, name: '壮胆', locked: true, description: '锁定技，其他角色的回合结束时，若你的手牌数为全场唯一最多，本回合结束前【裂胆】失效直到你回合结束。' },
    ],
  },
  {
    id: 'shia', name: '史阿', kingdom: 'qun', gender: 'male', maxHp: 5, pack: 'sp',
    skills: [
      { id: LIREN, name: '砺刃', locked: true, description: '锁定技，你的攻击范围始终为2；任何角色使用【杀】造成伤害后，若该【杀】能被你合法取得，你获得之（每回合限3张）；【杀】被真正抵消后，你摸1张牌；你死亡时可以令一名角色永久获得【砺刃】。' },
      { id: JIANCHU, name: '剑出', description: '觉醒技，你在摸牌阶段外累计获得5张牌后，回复1点体力并获得【击格】；此后你可以将【闪】当【杀】使用。' },
      { id: JIGE, name: '击格', description: '你成为【杀】的目标时，可以打出一张点数更大的【杀】抵消之；你使用【杀】对一名角色造成伤害时，可以弃置你与其所有的【杀】，若你弃置的数量更多，此伤害额外+差值。' },
    ],
  },
  {
    id: 'gexuan', name: '葛玄', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: LIANHUA, name: '炼化', description: '你的回合外，当其他角色受到伤害后，你获得1个"丹血"（与你同阵营为红色，否则为黑色，颜色不公开）直到你的下个出牌阶段开始；准备阶段，按你的丹血数量与红黑分布获得对应的牌并获得对应技能直到本回合结束。' },
      { id: ZHAFU, name: '札符', description: '限定技，出牌阶段，你可以选择一名其他角色；其下一个弃牌阶段开始时，其选择保留一张手牌，其余交给你。' },
    ],
  },
  {
    id: 'tongyuan', name: '童渊', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: CHAOFENG, name: '朝凤', description: '出牌阶段限一次，当你使用牌造成伤害后，你可以弃置一张手牌，然后摸1张牌；若弃置的牌与造成伤害的牌颜色相同，你额外摸1张牌；若类型相同，此伤害+1。' },
      { id: CHUANSHU, name: '传术', description: '限定技，你的准备阶段（你已受伤）或你死亡时，你可以选择一名其他角色，其永久获得【朝凤】，然后你获得【龙胆】【从谏】【穿云】。' },
    ],
  },
  {
    id: 'zhaozhi', name: '赵直', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: TONGGUAN, name: '统观', locked: true, description: '锁定技，每名角色本局第一个回合开始时，你为其选择武勇/刚硬/多谋/果决/仁智之一（每种至多分配给2人）。' },
      { id: MENGJIE, name: '梦解', description: '一名角色的回合结束时，若其完成了自己被分配的属性对应条件，你执行对应效果：武勇对一人造成1点伤害；刚硬回复一人1点体力；多谋摸2张牌；果决弃置一名角色至多2张牌；仁智令一名角色摸至体力上限（至多5）。' },
    ],
  },
  {
    id: 'liuye', name: '刘晔', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: POYUAN, name: '破垣', locked: true, description: '锁定技，游戏开始时或回合开始时，若你的装备区里没有【霹雳车】，将之置入你的装备区，否则你可以弃置一名其他角色装备区里至多两张牌。' },
      { id: HUACE, name: '画策', description: '出牌阶段限一次，你可以将一张手牌当作上一轮没有角色使用过的普通锦囊牌使用。' },
    ],
  },
  {
    id: 'chengui', name: '陈珪', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: YINGTU, name: '营图', description: '每回合限一次，当你的上家或下家在摸牌阶段外获得牌后，你可以获得其一张牌，然后交给其另一侧的邻居一张牌（若为装备牌，其立即使用之）。' },
      { id: CONGSHI, name: '从势', locked: true, description: '锁定技，任意角色使用装备牌后，若其装备区内的装备数为全场最多之一，你摸1张牌。' },
    ],
  },
]
