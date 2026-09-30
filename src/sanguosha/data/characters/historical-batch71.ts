import type { CardId, DamageNature, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { gainMaxHp, loseHp, loseMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { locateOwnedCard, moveCard, zoneCards } from '../../engine/zones'
import { effectiveCardColor } from '../../engine/skills/runtime'
import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { queueExtraTurn } from '../../engine/turn'
import { ALL_CHARACTERS } from './standard'
import { resolveDamage } from '../../engine/damage'
import { discardCardsByIds } from '../../engine/discard-all'
import { restoreCharacter, setChained } from '../../engine/character-state'
import { flipCharacter } from '../../engine/character-state'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { characterPileCardUseActions, skillOtherHandCardUseActions } from '../../engine/cards/basic'
import { getAttackRange, getDistance } from '../../engine/distance'
import { discardEntryOf } from '../../engine/discard-provenance'
import { reshuffleDrawPile } from '../../engine/deck'

const B = '-b71'
const sid = (name: string) => `${name}${B}`
const ZHOUYI_ZHUKOU = sid('zhukou-zhouyi')
const ZHOUYI_MOQING = sid('moqing-zhouyi')
const ZHOUYI_YUYUN = sid('yuyun-zhouyi')
const ZHANGNING_TIANZE = sid('tianze-zhangning')
const ZHANGNING_DIFA = sid('difa-zhangning')
const LAIYINGER_XIAOWU = sid('xiaowu-laiying')
const LAIYINGER_HUAPING = sid('huaping-laiying')
const LAIYINGER_SHAWU = sid('shawu-laiying')
const JIPING_XUNLI = sid('xunli-jiping')
const JIPING_ZHISHI = sid('zhishi-jiping')
const JIPING_LIEYI = sid('lieyi-jiping')
const CAOHUA_CAIYI = sid('caiyi-caohua')
const CAOHUA_GUII = sid('guili-caohua')
const LIUHUI_GUOYUAN = sid('guoyuan-liuhui')
const LIUHUI_JIESHU = sid('jieshu-liuhui')
const LIUHUI_GUSUAN = sid('gusuan-liuhui')
const LUYI_YAOYI = sid('yaoyi-luyi')
const LUYI_FUXUE = sid('fuxue-luyi')
const LUYI_SHOUTAN = sid('shoutan-shared')
const SUNLINGLUAN_LINGLE = sid('lingle-sunlingluan')
const SUNLINGLUAN_XIDI = sid('xidi-sunlingluan')
const ZHANGHENG_LIANGJUE = sid('liangjue-zhangheng')
const ZHANGHENG_DANGZAI = sid('dangzai-zhangheng')
const FENGFANG_DITING = sid('diting-fengfang')
const FENGFANG_BIHUO = sid('bihuo-fengfang')

type B71State = SanguoshaState & { b71?: Record<string, any> }
const stateOf = (state: SanguoshaState) => (state as B71State).b71 ??= {}
const playerOf = (state: SanguoshaState, id: PlayerId) => state.players.find((player) => player.id === id)
const living = (state: SanguoshaState) => state.players.filter((player) => player.alive)
const ownedCards = (state: SanguoshaState, playerId: PlayerId) => {
  const owner = playerOf(state, playerId)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)), ...owner.zones.judgingArea] : []
}
const canMoveJudgmentCard = (state: SanguoshaState, toId: PlayerId, cardId: CardId) => {
  const card = state.cards[cardId]
  const target = playerOf(state, toId)
  if (!card || card.category !== 'trick' || !target?.alive) return false
  if (card.name === '闪电' && state.players.some((p) => p.zones.judgingArea.some((id) => state.cards[id]?.name === '闪电'))) return false
  return !target.zones.judgingArea.some((id) => state.cards[id]?.name === card.name)
}

function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  if (!options.length) return
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId, prompt, timeoutMs: 25_000, optional, options,
  }) })
}

function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  cardIds: CardId[], min: number, max: number, prompt: string, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId, prompt, timeoutMs: 25_000, optional, purpose: 'skill', cardIds,
    hiddenCardSlots: [], min, max,
  }) })
}

function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  candidates: PlayerId[], min: number, max: number, prompt: string, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId, prompt, timeoutMs: 25_000, candidateIds: candidates, min, max, optional,
  }) })
}

const CAIYI_OPTIONS = {
  yang: [
    { id: 'recover', label: '回复X点体力' }, { id: 'draw', label: '摸X张牌' }, { id: 'restore', label: '复原武将牌' },
  ],
  yin: [
    { id: 'damage', label: '受到X点伤害' }, { id: 'discard', label: '弃X张牌' }, { id: 'turn-over', label: '翻面并横置' },
  ],
} as const

function caoyiRecord(state: SanguoshaState, ownerId: PlayerId) {
  const records = stateOf(state).caiyi ??= {}
  return records[ownerId] ??= { removed: { yang: [], yin: [] }, randomUsed: { yang: false, yin: false } }
}

function triggerZhangheng(host: SkillHost, ownerId: PlayerId): void {
  const target = playerOf(host.state, ownerId)
  if (!target?.alive) return
  drawCards(host.state, host.rng, ownerId, 2)
  if (target.alive && target.hp > 1) loseHp(host as never, ownerId, 1, ZHANGHENG_LIANGJUE)
}

registerSkillRuntime({
  id: CAOHUA_CAIYI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'finish' || usedThisPhase(state, ownerId, CAOHUA_CAIYI)) return []
    return [{ id: `skill:${CAOHUA_CAIYI}`, label: '发动【彩翼】' }]
  },
  invokeActive(host, ownerId) {
    const candidates = living(host.state).map((player) => player.id)
    if (!candidates.length || usedThisPhase(host.state, ownerId, CAOHUA_CAIYI)) return
    markUsedThisPhase(host.state, ownerId, CAOHUA_CAIYI)
    askTargets(host, CAOHUA_CAIYI, ownerId, 'target', ownerId, candidates, 1, 1, '【彩翼】：选择一名角色')
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'effect') return
    const data = prompt.data as { targetId: PlayerId; state: 'yang' | 'yin' }
    const target = playerOf(host.state, data.targetId)
    if (!target?.alive) return
    const record = caoyiRecord(host.state, ownerId)
    const removed = record.removed[data.state] as string[]
    const options: Array<{ id: string; label: string }> = [...CAIYI_OPTIONS[data.state].filter((option) => !removed.includes(option.id))]
    if (removed.length) options.push({ id: 'repeat', label: `随机执行一个已移除的${data.state === 'yang' ? '阳' : '阴'}选项` })
    if (!options.length) return
    askOption(host, CAOHUA_CAIYI, ownerId, 'effect', target.id, `【彩翼】：选择一项执行（X=${options.length}）`, options as Array<{ id: string; label: string }>, data, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const current = conversionStateOf(host.state, ownerId, CAOHUA_CAIYI)
      const state = current === 'yang' ? 'yang' : 'yin'
      host.queueSkill({ skillId: CAOHUA_CAIYI, ownerId, step: 'effect', data: { targetId, state } })
      return
    }
    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (target?.alive) {
        const available = new Set([...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))])
        const valid = ids.filter((id) => available.has(id))
        if (valid.length) discardCardsByIds(host as never, targetId, valid, CAOHUA_CAIYI)
      }
      toggleConversionState(host.state, ownerId, CAOHUA_CAIYI)
      return
    }
    if (resolution.step !== 'effect') return
    const selected = (response.payload as { optionId?: string }).optionId
    if (!selected) return
    const data = resolution.data as { targetId: PlayerId; state: 'yang' | 'yin' }
    const target = playerOf(host.state, data.targetId)
    const owner = playerOf(host.state, ownerId)
    if (!target?.alive || !owner?.alive) return
    const record = caoyiRecord(host.state, ownerId)
    const removed = record.removed[data.state] as string[]
    const count = CAIYI_OPTIONS[data.state].length - removed.length + (removed.length ? 1 : 0)
    const effect = selected === 'repeat' ? host.rng.pick(removed) : selected
    if (selected !== 'repeat' && (CAIYI_OPTIONS[data.state] as readonly { id: string }[]).some((option) => option.id === selected)) removed.push(selected)
    const x = Math.max(0, count)
    if (effect === 'recover') recover(host as never, target.id, x, ownerId)
    else if (effect === 'draw') drawCards(host.state, host.rng, target.id, x)
    else if (effect === 'restore') restoreCharacter(host as never, target.id, CAOHUA_CAIYI)
    else if (effect === 'damage') resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: x, sourceSkillId: CAOHUA_CAIYI })
    else if (effect === 'turn-over') { flipCharacter(host as never, target.id, CAOHUA_CAIYI); setChained(host as never, target.id, CAOHUA_CAIYI, true) }
    else if (effect === 'discard') {
      const cards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
      const max = Math.min(x, cards.length)
      if (max > 0) askCards(host, CAOHUA_CAIYI, ownerId, 'discard', target.id, cards, max, max, '【彩翼】：弃置指定数量的牌', { targetId: target.id, amount: max }, false)
      else toggleConversionState(host.state, ownerId, CAOHUA_CAIYI)
    }
    if (effect !== 'discard') toggleConversionState(host.state, ownerId, CAOHUA_CAIYI)
  },
})

registerSkillRuntime({
  id: CAOHUA_GUII,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      if (payload.playerId !== ownerId) return
      const record = stateOf(host.state).guili ??= {}
      if (record[ownerId]) return
      host.queueSkill({ skillId: CAOHUA_GUII, ownerId, step: 'select', data: { firstTurn: payload.turnNumber ?? host.state.turnNumber } })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      const record = (stateOf(host.state).guili ?? {})[ownerId] as { targetId?: PlayerId; firstTurn?: number; processedRounds?: number[] } | undefined
      if (!record?.targetId || payload.playerId !== record.targetId) return
      const round = host.state.roundNumber
      record.processedRounds ??= []
      if (record.processedRounds.includes(round)) return
      record.processedRounds.push(round)
      const dealtDamage = (host.state.damageHistory ?? []).some((entry) => entry.turnNumber === payload.turnNumber && entry.sourceId === record.targetId)
      if (!dealtDamage && playerOf(host.state, ownerId)?.alive) queueExtraTurn(host.state, ownerId, { skillId: CAOHUA_GUII, playerId: ownerId })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'select') return
    const candidates = living(host.state).filter((player) => player.id !== ownerId).map((player) => player.id)
    if (!candidates.length) { (stateOf(host.state).guili ??= {})[ownerId] = { selected: true }; return }
    askTargets(host, CAOHUA_GUII, ownerId, 'select', ownerId, candidates, 1, 1, '【归离】：选择一名角色', {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'select') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (targetId && playerOf(host.state, targetId)?.alive)
      (stateOf(host.state).guili ??= {})[ownerId] = { targetId, firstTurn: Number(resolution.data.firstTurn), processedRounds: [] }
  },
})

registerSkillRuntime({
  id: ZHANGHENG_LIANGJUE,
  triggers: [{ event: 'CardZoneMoved', handle(host, ownerId, context) {
    const payload = context.event.payload as { fromKind?: string; fromPlayerId?: PlayerId | null; toKind?: string; toPlayerId?: PlayerId | null; color?: string | null }
    if (payload.color !== 'black') return
    const field = (kind?: string) => kind === 'equipment' || kind === 'judgingArea'
    let events = 0
    if (field(payload.fromKind) && payload.fromPlayerId === ownerId
      && !(field(payload.toKind) && payload.toPlayerId === ownerId)) events += 1
    if (field(payload.toKind) && payload.toPlayerId === ownerId
      && !(field(payload.fromKind) && payload.fromPlayerId === ownerId)) events += 1
    if (field(payload.fromKind) && field(payload.toKind) && payload.fromPlayerId === ownerId && payload.toPlayerId === ownerId) events += 2
    for (let index = 0; index < events; index += 1) triggerZhangheng(host, ownerId)
  } }],
})

registerSkillRuntime({
  id: ZHANGHENG_DANGZAI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || payload.phase !== 'play') return
    const candidates = living(host.state).filter((player) => player.id !== ownerId && player.zones.judgingArea.length).map((player) => player.id)
    if (candidates.length) host.queueSkill({ skillId: ZHANGHENG_DANGZAI, ownerId, step: 'target', data: { candidates } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const candidates = (prompt.data.candidates as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive && playerOf(host.state, id)!.zones.judgingArea.length)
    if (candidates.length) askTargets(host, ZHANGHENG_DANGZAI, ownerId, 'target', ownerId, candidates, 1, 1, '【挡灾】：选择一名判定区有牌的其他角色')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : null
      if (!target?.alive || !target.zones.judgingArea.length) return
      askCards(host, ZHANGHENG_DANGZAI, ownerId, 'cards', ownerId, [...target.zones.judgingArea], 0, target.zones.judgingArea.length, '【挡灾】：选择移动的判定区牌', { targetId }, true)
      return
    }
    if (resolution.step !== 'cards') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!target?.alive || !playerOf(host.state, ownerId)?.alive) return
    for (const cardId of cards) {
      if (!target.zones.judgingArea.includes(cardId) || !canMoveJudgmentCard(host.state, ownerId, cardId)) continue
      moveCard(host.state, cardId, { kind: 'judgingArea', playerId: targetId }, { kind: 'judgingArea', playerId: ownerId })
    }
  },
})

// Zhou Yi's awakening grants the separately defined official derivative skill.
const YUYUN_OPTIONS = [
  { id: 'draw', label: '摸两张牌' }, { id: 'damage', label: '对一名其他角色造成1点伤害，本回合对其使用【杀】无距离和次数限制' },
  { id: 'hand-limit', label: '本回合手牌上限无限' }, { id: 'take', label: '获得一名其他角色区域里的一张牌' },
  { id: 'fill', label: '令一名其他角色将手牌摸至体力上限（至多5张）' },
]
function continueYuyun(host: SkillHost, ownerId: PlayerId, remaining: number, selected: string[]) {
  const options = YUYUN_OPTIONS.filter((option) => !selected.includes(option.id))
  if (remaining <= 0 || options.length === 0) return
  host.queueSkill({ skillId: ZHOUYI_YUYUN, ownerId, step: 'effects', data: { remaining, selected, options } })
}

registerSkillRuntime({
  id: ZHOUYI_ZHUKOU,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { sourceId?: PlayerId; finalAmount?: number }
      if (payload.sourceId !== ownerId || (payload.finalAmount ?? 0) <= 0 || host.state.currentPlayerId !== ownerId) return
      const key = `${ownerId}:${host.state.turnNumber}`
      const data = stateOf(host.state)
      data.zhouyiDamageTurn ??= {}
      data.zhouyiDamageTurn[key] = true
      if (host.state.phase !== 'play' || data.zhouyiPlayDamageTurn?.[key]) return
      data.zhouyiPlayDamageTurn ??= {}
      data.zhouyiPlayDamageTurn[key] = true
      const used = host.state.cardUseHistory?.filter((entry) => entry.turnNumber === host.state.turnNumber && entry.sourceId === ownerId).length ?? 0
      host.queueSkill({ skillId: ZHOUYI_ZHUKOU, ownerId, step: 'draw', data: { count: used } })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'finish') return
      const damaged = (stateOf(host.state).zhouyiDamageTurn ?? {}) as Record<string, boolean>
      if (damaged[`${ownerId}:${host.state.turnNumber}`]) return
      const candidates = living(host.state).filter((player) => player.id !== ownerId).map((player) => player.id)
      if (candidates.length < 2) return
      host.queueSkill({ skillId: ZHOUYI_ZHUKOU, ownerId, step: 'end-choice', data: { candidates } })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turnNumber = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
      const damaged = stateOf(host.state).zhouyiDamageTurn as Record<string, boolean> | undefined
      if (damaged) for (const key of Object.keys(damaged)) if (key.startsWith(`${ownerId}:`) && Number(key.slice(ownerId.length + 1)) <= turnNumber) delete damaged[key]
      const playDamaged = stateOf(host.state).zhouyiPlayDamageTurn as Record<string, boolean> | undefined
      if (playDamaged) for (const key of Object.keys(playDamaged)) if (key.startsWith(`${ownerId}:`) && Number(key.slice(ownerId.length + 1)) <= turnNumber) delete playDamaged[key]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'draw') {
      const count = Number(prompt.data.count)
      if (count > 0 && playerOf(host.state, ownerId)?.alive)
        askOption(host, ZHOUYI_ZHUKOU, ownerId, 'draw-confirm', ownerId, `【逐寇】：是否摸${count}张牌？`, [{ id: 'draw', label: '摸牌' }])
      return
    }
    if (prompt.step === 'end-choice') {
      const candidates = (prompt.data.candidates as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive)
      if (candidates.length < 2) return
      askTargets(host, ZHOUYI_ZHUKOU, ownerId, 'end-targets', ownerId, candidates, 2, 2, '【逐寇】：选择两名角色各造成1点伤害')
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw-confirm') {
      if ((response.payload as { optionId?: string }).optionId === 'draw') {
        const count = Number(resolution.data.count)
        if (count > 0 && playerOf(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, count)
      }
      return
    }
    if (resolution.step !== 'end-targets') return
    const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    for (const id of ids) if (playerOf(host.state, id)?.alive) host.dispatch('SkillActivated', { skillId: ZHOUYI_ZHUKOU, playerId: ownerId, targetId: id, damage: 1 }, { sourceId: ownerId, targetId: id, sourceSkillId: ZHOUYI_ZHUKOU })
    for (const id of ids) if (playerOf(host.state, id)?.alive) resolveDamage(host as never, { sourceId: ownerId, targetId: id, amount: 1, sourceSkillId: ZHOUYI_ZHUKOU })
  },
})

registerSkillRuntime({
  id: ZHOUYI_MOQING,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      return Boolean(owner && state.players.filter((player) => player.hp < player.maxHp).length > owner.hp)
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      gainMaxHp(host as never, ownerId, 3, ZHOUYI_MOQING)
      recover(host as never, ownerId, 3, ownerId)
      owner.permanentlyLostSkills ??= []
      if (!owner.permanentlyLostSkills.includes(ZHOUYI_ZHUKOU)) owner.permanentlyLostSkills.push(ZHOUYI_ZHUKOU)
      grantSkill(host.state, ownerId, ZHOUYI_YUYUN)
    },
  },
})

registerSkillRuntime({
  id: ZHOUYI_YUYUN,
  fixedMaxCards(state, ownerId) {
    return stateOf(state).yuyunUnlimitedHand?.[ownerId] === state.turnNumber ? Number.POSITIVE_INFINITY : null
  },
  ignoresDistanceTo(state, ownerId, targetId) {
    return (stateOf(state).yuyunDamageTargets?.[ownerId] as Array<{ targetId: PlayerId; untilTurn: number }> | undefined)
      ?.some((entry) => entry.targetId === targetId && entry.untilTurn === state.turnNumber) ?? false
  },
  ignoresSlashUsesTo(state, ownerId, targetId) {
    return (stateOf(state).yuyunDamageTargets?.[ownerId] as Array<{ targetId: PlayerId; untilTurn: number }> | undefined)
      ?.some((entry) => entry.targetId === targetId && entry.untilTurn === state.turnNumber) ?? false
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId; phase?: string }).playerId !== ownerId
      || (context.event.payload as { phase?: string }).phase !== 'play') return
    host.queueSkill({ skillId: ZHOUYI_YUYUN, ownerId, step: 'cost', data: {} })
  } }, { event: 'QuitDying', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId || !stateOf(host.state).yuyunCostWaiting?.[ownerId]) return
    delete stateOf(host.state).yuyunCostWaiting[ownerId]
    const owner = playerOf(host.state, ownerId)
    if (owner?.alive) continueYuyun(host, ownerId, Math.min(5, Math.max(0, owner.maxHp - owner.hp) + 1), [])
  } }, { event: 'Death', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) delete stateOf(host.state).yuyunCostWaiting?.[ownerId]
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    const turn = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
    if (stateOf(host.state).yuyunUnlimitedHand?.[ownerId] === turn) delete stateOf(host.state).yuyunUnlimitedHand[ownerId]
    const targets = stateOf(host.state).yuyunDamageTargets?.[ownerId] as Array<{ targetId: PlayerId; untilTurn: number }> | undefined
    if (targets) stateOf(host.state).yuyunDamageTargets[ownerId] = targets.filter((entry) => entry.untilTurn > turn)
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'cost') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      askOption(host, ZHOUYI_YUYUN, ownerId, 'cost', ownerId, '【玉殒】：失去1点体力或减1点体力上限', [
        { id: 'hp', label: '失去1点体力' }, ...(owner.maxHp > 1 ? [{ id: 'max-hp', label: '减1点体力上限' }] : []),
      ], {}, false)
      return
    }
    if (prompt.step === 'effects') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      askOption(host, ZHOUYI_YUYUN, ownerId, 'effects', ownerId, '【玉殒】：选择尚未执行的效果', [
        { id: 'draw', label: '摸两张牌' }, { id: 'damage', label: '对一名其他角色造成1点伤害，本回合对其使用【杀】无距离和次数限制' },
        { id: 'hand-limit', label: '本回合手牌上限无限' }, { id: 'take', label: '获得一名其他角色区域里的一张牌' },
        { id: 'fill', label: '令一名其他角色将手牌摸至体力上限（至多5张）' },
      ].filter((option) => ((prompt.data.selected as string[] | undefined) ?? []).includes(option.id) === false), prompt.data)
    }
  },
  resume(host, ownerId, resolution, response) {
    const selected = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'cost') {
      if (selected === 'hp') {
        stateOf(host.state).yuyunCostWaiting ??= {}
        stateOf(host.state).yuyunCostWaiting[ownerId] = true
        loseHp(host as never, ownerId, 1, ZHOUYI_YUYUN)
      }
      else if (selected === 'max-hp') loseMaxHp(host as never, ownerId, 1, ZHOUYI_YUYUN)
      else return
      const owner = playerOf(host.state, ownerId)
      if (selected === 'max-hp' && owner?.alive) {
        stateOf(host.state).yuyunCostWaiting ??= {}
        stateOf(host.state).yuyunCostWaiting[ownerId] = true
      }
      if (host.state.dying?.playerId === ownerId) return
      delete stateOf(host.state).yuyunCostWaiting?.[ownerId]
      if (!owner?.alive) return
      continueYuyun(host, ownerId, Math.min(5, Math.max(0, owner.maxHp - owner.hp) + 1), [])
      return
    }
    if (resolution.step === 'damage-target' || resolution.step === 'take-target' || resolution.step === 'fill-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : null
      if (!targetId || !target?.alive) return
      const nextRemaining = Number(resolution.data.remaining)
      const selectedEffects = resolution.data.selectedEffects as string[]
      if (resolution.step === 'damage-target') {
        const record = stateOf(host.state).yuyunDamageTargets ??= {}
        record[ownerId] ??= []
        record[ownerId].push({ targetId, untilTurn: host.state.turnNumber })
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, sourceSkillId: ZHOUYI_YUYUN })
      } else if (resolution.step === 'fill-target') {
        drawCards(host.state, host.rng, targetId, Math.max(0, Math.min(5, target.maxHp) - target.zones.hand.length))
      } else {
        const candidates = [...ownedCards(host.state, targetId), ...target.zones.judgingArea]
        if (candidates.length) askCards(host, ZHOUYI_YUYUN, ownerId, 'take-card', ownerId, candidates, 1, 1,
          '【玉殒】：选择获得一张区域牌', { targetId, remaining: nextRemaining, selectedEffects })
        else continueYuyun(host, ownerId, nextRemaining, selectedEffects)
      }
      if (resolution.step !== 'take-target') continueYuyun(host, ownerId, nextRemaining, selectedEffects)
      return
    }
    if (resolution.step === 'take-card') {
      const targetId = resolution.data.targetId as PlayerId
      const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const from = id ? locateOwnedCard(host.state, targetId, id) : null
      if (id && from) moveCard(host.state, id, from, { kind: 'hand', playerId: ownerId })
      continueYuyun(host, ownerId, Number(resolution.data.remaining), resolution.data.selectedEffects as string[])
      return
    }
    if (resolution.step !== 'effects' || !selected) return
    const data = resolution.data as { remaining: number; selected: string[] }
    const done = [...(data.selected ?? []), selected]
    if (selected === 'draw') drawCards(host.state, host.rng, ownerId, 2)
    if (selected === 'hand-limit') {
      stateOf(host.state).yuyunUnlimitedHand ??= {}
      stateOf(host.state).yuyunUnlimitedHand[ownerId] = host.state.turnNumber
    }
    const step = selected === 'damage' ? 'damage-target' : selected === 'take' ? 'take-target' : selected === 'fill' ? 'fill-target' : null
    const nextRemaining = data.remaining - 1
    if (step) {
      const candidates = living(host.state).filter((player) => player.id !== ownerId && (selected !== 'fill'
        || player.zones.hand.length < Math.min(5, player.maxHp)) && (selected !== 'take' || ownedCards(host.state, player.id).length > 0 || player.zones.judgingArea.length > 0))
        .map((player) => player.id)
      if (candidates.length) askTargets(host, ZHOUYI_YUYUN, ownerId, step, ownerId, candidates, 1, 1,
        `【玉殒】：${selected === 'damage' ? '选择受伤角色' : selected === 'take' ? '选择获得其区域牌的角色' : '选择摸牌角色'}`,
        { remaining: nextRemaining, selectedEffects: done })
      else continueYuyun(host, ownerId, nextRemaining, done)
    } else {
      continueYuyun(host, ownerId, nextRemaining, done)
    }
  },
})

registerSkillRuntime({
  id: ZHANGNING_TIANZE,
  triggers: [
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; fromKind?: string }
      const actorId = context.event.sourceId
      if (!actorId || actorId === _ownerId || host.state.phase !== 'play' || payload.fromKind !== 'hand' || !payload.cardId
        || host.state.cards[payload.cardId]?.color !== 'black') return
      const data = stateOf(host.state)
      data.tianzeSeenBlack ??= {}
      const seenKey = `${_ownerId}:${actorId}:${host.state.turnNumber}`
      if (data.tianzeSeenBlack[seenKey]) return
      data.tianzeSeenBlack[seenKey] = true
      const actorKey = `${_ownerId}:${actorId}:${host.state.turnNumber}`
      data.tianzePending ??= {}
      if (data.tianzePending[actorKey]) return
      data.tianzePending[actorKey] = { cardId: payload.cardId, ownerId: _ownerId, cardName: payload.cardName }
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      if (!payload.cardId) return
      const data = stateOf(host.state)
      const key = `${ownerId}:${context.event.sourceId}:${host.state.turnNumber}`
      const pending = data.tianzePending?.[key]
      if (!pending || pending.cardId !== payload.cardId || pending.ownerId !== ownerId) return
      delete data.tianzePending[key]
      if (data.tianzeUsedTurn?.[ownerId] === host.state.turnNumber) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: ZHANGNING_TIANZE, ownerId, step: 'pay', data: { targetId: context.event.sourceId, cardId: payload.cardId } })
    } },
    { event: 'JudgeResult', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      if (card?.color === 'black') drawCards(host.state, host.rng, ownerId, 1)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turn = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
      const pending = stateOf(host.state).tianzePending as Record<string, { ownerId: PlayerId }> | undefined
      if (pending) for (const [key, entry] of Object.entries(pending)) if (entry.ownerId === ownerId || key.endsWith(`:${turn}`)) delete pending[key]
      const seen = stateOf(host.state).tianzeSeenBlack as Record<string, boolean> | undefined
      if (seen) for (const key of Object.keys(seen)) if (key.endsWith(`:${turn}`)) delete seen[key]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pay' || stateOf(host.state).tianzeUsedTurn?.[ownerId] === host.state.turnNumber) return
    const owner = playerOf(host.state, ownerId)
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const cards = ownedCards(host.state, ownerId).filter((id) => host.state.cards[id]?.color === 'black')
    if (!cards.length) return
    askCards(host, ZHANGNING_TIANZE, ownerId, 'pay', ownerId, cards, 1, 1, '【天则】：弃置一张黑色牌，对此角色造成1点伤害', { targetId })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pay') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const card = cardId ? host.state.cards[cardId] : undefined
    if (!owner?.alive || !cardId || !card || card.color !== 'black' || !ownedCards(host.state, ownerId).includes(cardId)
      || stateOf(host.state).tianzeUsedTurn?.[ownerId] === host.state.turnNumber || !playerOf(host.state, targetId)?.alive) return
    discardCardsByIds(host as never, ownerId, [cardId], ZHANGNING_TIANZE)
    stateOf(host.state).tianzeUsedTurn ??= {}
    stateOf(host.state).tianzeUsedTurn[ownerId] = host.state.turnNumber
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, sourceSkillId: ZHANGNING_TIANZE })
  },
})

registerSkillRuntime({
  id: ZHANGNING_DIFA,
  triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (payload.playerId !== ownerId) return
    const data = stateOf(host.state)
    if (data.difaUsedTurn?.[ownerId] === host.state.turnNumber) return
    const redIds = (payload.cardIds ?? []).filter((id) => host.state.cards[id]?.color === 'red' && playerOf(host.state, ownerId)?.zones.hand.includes(id))
    const hasTrick = [...host.state.zones.drawPile, ...host.state.zones.discardPile].some((id) => host.state.cards[id]?.category === 'trick')
    if (hasTrick) for (const cardId of redIds) host.queueSkill({ skillId: ZHANGNING_DIFA, ownerId, step: 'replace', data: { cardId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'replace' || stateOf(host.state).difaUsedTurn?.[ownerId] === host.state.turnNumber) return
    const cardId = prompt.data.cardId as CardId
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.color !== 'red') return
    askOption(host, ZHANGNING_DIFA, ownerId, 'replace', ownerId, '【地法】：是否弃置此红色牌并获得一张锦囊牌？', [
      { id: 'yes', label: '弃置此牌并选择一张锦囊牌' },
    ], { cardId })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'take-trick') {
      const optionId = (response.payload as { optionId?: string }).optionId ?? ''
      const [kind, cardId] = optionId.split(':') as ['draw' | 'discard' | string, CardId]
      const zone = kind === 'draw' ? host.state.zones.drawPile : kind === 'discard' ? host.state.zones.discardPile : null
      if (zone?.includes(cardId) && host.state.cards[cardId]?.category === 'trick') {
        moveCard(host.state, cardId, { kind: kind === 'draw' ? 'drawPile' : 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHANGNING_DIFA }, { targetId: ownerId, cardIds: [cardId] })
      }
      return
    }
    if (resolution.step !== 'replace' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const cardId = resolution.data.cardId as CardId
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.color !== 'red'
      || stateOf(host.state).difaUsedTurn?.[ownerId] === host.state.turnNumber) return
    discardCardsByIds(host as never, ownerId, [cardId], ZHANGNING_DIFA)
    stateOf(host.state).difaUsedTurn ??= {}
    stateOf(host.state).difaUsedTurn[ownerId] = host.state.turnNumber
    const names = [...new Set(Object.values(host.state.cards).filter((candidate) => candidate.category === 'trick').map((candidate) => candidate.name))]
    host.askSkill({ skillId: ZHANGNING_DIFA, ownerId, step: 'take-trick', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【地法】：选择牌堆或弃牌堆中一张锦囊牌', timeoutMs: 25_000, optional: false,
      options: names.flatMap((name) => {
        const drawId = host.state.zones.drawPile.find((candidate) => host.state.cards[candidate]?.name === name)
        const discardId = host.state.zones.discardPile.find((candidate) => host.state.cards[candidate]?.name === name)
        return [drawId && { id: `draw:${drawId}`, label: `牌堆：${name}` }, discardId && { id: `discard:${discardId}`, label: `弃牌堆：${name}` }].filter((entry): entry is { id: string; label: string } => Boolean(entry))
      }),
    }) })
  },
})

registerSkillRuntime({
  id: FENGFANG_DITING,
  cardIneffectiveForTarget(state, ownerId, sourceId, _cardName, cardId) {
    if (!cardId || !sourceId) return false
    const record = stateOf(state).diting?.[sourceId]
    return record?.ownerId === ownerId && (record.effectiveCardId ?? record.cardId) === cardId && record.turnNumber === state.turnNumber
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      const targetId = p.playerId
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : null
      if (p.phase !== 'play' || !targetId || targetId === ownerId || !owner?.alive || !target?.alive
        || getDistance(host.state, targetId, ownerId) > getAttackRange(host.state, targetId) || !target.zones.hand.length) return
      host.queueSkill({ skillId: FENGFANG_DITING, ownerId, step: 'offer', data: { targetId, turnNumber: host.state.turnNumber } })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      if (!sourceId) return
      const record = stateOf(host.state).diting?.[sourceId]
      const p = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; targetIds?: PlayerId[] }
      if (!record || record.ownerId !== ownerId || record.turnNumber !== host.state.turnNumber
        || !p.cardId || !(p.cardIds ?? [p.cardId]).includes(record.cardId)) return
      record.effectiveCardId = p.cardId
      record.usedTargetIds = p.targetIds ?? []
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      const sourceId = context.event.sourceId
      const record = sourceId ? stateOf(host.state).diting?.[sourceId] : null
      if (!sourceId || record?.ownerId !== ownerId || record.turnNumber !== host.state.turnNumber || p.cardId !== record.effectiveCardId) return
      if (!(record.usedTargetIds ?? p.targetIds ?? []).includes(ownerId) && playerOf(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 2)
      delete stateOf(host.state).diting[sourceId]
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      const record = p.playerId ? stateOf(host.state).diting?.[p.playerId] : null
      if (p.phase !== 'play' || !record || record.ownerId !== ownerId || record.turnNumber !== host.state.turnNumber) return
      const target = playerOf(host.state, p.playerId!)
      const cardId = record.cardId as CardId
      if (target?.alive && target.zones.hand.includes(cardId) && playerOf(host.state, ownerId)?.alive) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: FENGFANG_DITING },
          { sourceId: target.id, targetId: ownerId, cardIds: [cardId] })
      }
      delete stateOf(host.state).diting[p.playerId!]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      askOption(host, FENGFANG_DITING, ownerId, 'offer', ownerId, '【谛听】：是否观看并选择其手牌？',
        [{ id: 'yes', label: '发动【谛听】' }], prompt.data)
      return
    }
    if (prompt.step !== 'look') return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!target?.alive || !owner?.alive || host.state.currentPlayerId !== targetId) return
    const count = Math.min(Math.max(0, owner.hp), target.zones.hand.length)
    if (!count) return
    askCards(host, FENGFANG_DITING, ownerId, 'look-cards', ownerId, [...target.zones.hand], count, count,
      `【谛听】：观看${count}张手牌`, { targetId, turnNumber: Number(prompt.data.turnNumber), count }, false)
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId === 'yes')
        host.queueSkill({ skillId: FENGFANG_DITING, ownerId, step: 'look', data: resolution.data })
      return
    }
    if (!target?.alive || host.state.currentPlayerId !== targetId) return
    if (resolution.step === 'look-cards') {
      const seen = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => target.zones.hand.includes(id))
      if (seen.length !== resolution.data.count) return
      askCards(host, FENGFANG_DITING, ownerId, 'choose-card', ownerId, seen, 1, 1,
        '【谛听】：秘密选择其中一张牌', { targetId, turnNumber: resolution.data.turnNumber, cardIds: seen }, false)
      return
    }
    if (resolution.step !== 'choose-card') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const seen = resolution.data.cardIds as CardId[] | undefined
    if (!cardId || !seen?.includes(cardId) || !target.zones.hand.includes(cardId)) return
    stateOf(host.state).diting ??= {}
    stateOf(host.state).diting[targetId] = { ownerId, cardId, turnNumber: Number(resolution.data.turnNumber) }
  },
})

registerSkillRuntime({
  id: FENGFANG_BIHUO,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const p = context.event.payload as { finalAmount?: number }
      if ((p.finalAmount ?? 0) <= 0) return
      const sign = context.event.targetId === ownerId && context.event.sourceId !== ownerId ? 1
        : context.event.sourceId === ownerId && context.event.targetId !== ownerId ? -1 : 0
      if (sign) host.queueSkill({ skillId: FENGFANG_BIHUO, ownerId, step: 'choose', data: { sign } })
    } },
    { event: 'TurnStart', handle(host, _ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId) return
      const pending = stateOf(host.state).bihuoPending?.[targetId]
      if (!pending?.length) return
      host.state.drawPhaseBonuses ??= {}
      host.state.drawPhaseBonuses[targetId] = (host.state.drawPhaseBonuses[targetId] ?? 0)
        + pending.reduce((sum: number, value: number) => sum + value, 0)
      delete stateOf(host.state).bihuoPending[targetId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const candidates = living(host.state).map((player) => player.id)
    if (candidates.length) askTargets(host, FENGFANG_BIHUO, ownerId, 'choose-target', ownerId, candidates, 1, 1,
      `【避祸】：选择一名角色，其下回合摸牌阶段摸牌数${Number(prompt.data.sign) > 0 ? '+1' : '-1'}`, prompt.data)
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'choose-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    stateOf(host.state).bihuoPending ??= {}
    stateOf(host.state).bihuoPending[targetId] ??= []
    stateOf(host.state).bihuoPending[targetId].push(Number(resolution.data.sign))
  },
})

const hasConversionTechnique = (state: SanguoshaState, playerId: PlayerId): boolean => {
  const player = playerOf(state, playerId)
  const character = ALL_CHARACTERS.find((item) => item.id === player?.characterId)
  return Boolean(character?.skills.some((skill) => skill.description.includes('转换技')))
}
function conversionModeOf(state: SanguoshaState, playerId: PlayerId): 'yang' | 'yin' {
  const player = playerOf(state, playerId)
  const character = ALL_CHARACTERS.find((item) => item.id === player?.characterId)
  const conversion = character?.skills.find((skill) => skill.description.includes('转换技'))
  return conversionStateOf(state, playerId, conversion?.id ?? LUYI_SHOUTAN)
}

registerSkillRuntime({
  id: LUYI_YAOYI,
  onGameStart(host, _ownerId) {
    for (const player of host.state.players) if (!hasConversionTechnique(host.state, player.id)) grantSkill(host.state, player.id, LUYI_SHOUTAN)
  },
  globalProhibitsSourceTarget(state, _ownerId, sourceId, targetId) {
    return sourceId !== targetId && playerOf(state, sourceId)?.alive === true && playerOf(state, targetId)?.alive === true
      && conversionModeOf(state, sourceId) === conversionModeOf(state, targetId)
  },
})

registerSkillRuntime({
  id: LUYI_SHOUTAN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || !owner.grantedSkills?.includes(LUYI_SHOUTAN) && owner.characterId !== ALL_CHARACTERS.find((c) => c.name === '卢弈')?.id
      || owner.characterId !== ALL_CHARACTERS.find((c) => c.name === '卢弈')?.id && usedThisPhase(state, ownerId, LUYI_SHOUTAN)) return []
    const yin = conversionModeOf(state, ownerId) === 'yin'
    const cards = owner.zones.hand.filter((id) => yin ? hostColor(state, ownerId, id) === 'black' : hostColor(state, ownerId, id) !== 'black')
    const luyi = owner.characterId === ALL_CHARACTERS.find((c) => c.name === '卢弈')?.id
    return luyi || cards.length ? [{ id: `skill:${LUYI_SHOUTAN}`, label: `发动【手谈】（${yin ? '阴' : '阳'}）` }] : []
  },
  invokeActive(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const luyi = owner.characterId === ALL_CHARACTERS.find((c) => c.name === '卢弈')?.id
    if (luyi) { toggleConversionState(host.state, ownerId, LUYI_SHOUTAN); return }
    const yin = conversionModeOf(host.state, ownerId) === 'yin'
    const cards = owner.zones.hand.filter((id) => yin ? hostColor(host.state, ownerId, id) === 'black' : hostColor(host.state, ownerId, id) !== 'black')
    if (!cards.length || usedThisPhase(host.state, ownerId, LUYI_SHOUTAN)) return
    askCards(host, LUYI_SHOUTAN, ownerId, 'discard', ownerId, cards, 1, 1,
      `【手谈】：弃置一张${yin ? '黑色' : '非黑色'}手牌以转换状态`, {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const luyiId = ALL_CHARACTERS.find((c) => c.name === '卢弈')?.id
    if (!owner?.alive || owner.characterId === luyiId || usedThisPhase(host.state, ownerId, LUYI_SHOUTAN)) return
    const yin = conversionModeOf(host.state, ownerId) === 'yin'
    const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!id || !owner.zones.hand.includes(id) || (yin ? hostColor(host.state, ownerId, id) !== 'black' : hostColor(host.state, ownerId, id) === 'black')) return
    discardCardsByIds(host as never, ownerId, [id], LUYI_SHOUTAN)
    markUsedThisPhase(host.state, ownerId, LUYI_SHOUTAN)
    toggleConversionState(host.state, ownerId, LUYI_SHOUTAN)
  },
})

registerSkillRuntime({
  id: LUYI_FUXUE,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (p.playerId === ownerId && p.phase === 'prepare') host.queueSkill({ skillId: LUYI_FUXUE, ownerId, step: 'take', data: {} })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (p.playerId !== ownerId || p.phase !== 'finish') return
      const record = stateOf(host.state).fuxueCards?.[ownerId] as CardId[] | undefined
      if (!record) return
      const player = playerOf(host.state, ownerId)
      if (player?.alive && !record.some((id) => player.zones.hand.includes(id))) drawCards(host.state, host.rng, ownerId, Math.max(0, player.hp))
      delete stateOf(host.state).fuxueCards[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'take') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = host.state.zones.discardPile.filter((id) => {
      const reason = discardEntryOf(host.state, id)?.reason
      return reason === 'discard' || reason === 'judgment'
    })
    if (candidates.length) askCards(host, LUYI_FUXUE, ownerId, 'take', ownerId, candidates, 0,
      Math.min(owner.hp, candidates.length), '【复学】：选择至多X张非因使用进入弃牌堆的牌', {}, true)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'take') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = ids.filter((id) => {
      const reason = discardEntryOf(host.state, id)?.reason
      return host.state.zones.discardPile.includes(id) && (reason === 'discard' || reason === 'judgment')
    })
    stateOf(host.state).fuxueCards ??= {}
    stateOf(host.state).fuxueCards[ownerId] = [...valid]
    for (const id of valid) moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    if (valid.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: valid, reason: LUYI_FUXUE },
      { sourceId: ownerId, targetId: ownerId, cardIds: valid })
  },
})

function hostColor(state: SanguoshaState, ownerId: PlayerId, cardId: CardId) { return effectiveCardColor(state, ownerId, cardId) }

function liuhuiCircle(state: SanguoshaState, ownerId: PlayerId): { points: number[]; recorded: number[]; pending?: { ranks: number[] } } {
  const records = stateOf(state).liuhui ??= {}
  return records[ownerId] ??= { points: [], recorded: [] }
}
function liuhuiCardZones(state: SanguoshaState): Array<{ zone: ReturnType<typeof locateOwnedCard>; cardId: CardId }> {
  const result: Array<{ zone: ReturnType<typeof locateOwnedCard>; cardId: CardId }> = []
  for (const id of state.zones.drawPile) result.push({ zone: { kind: 'drawPile' }, cardId: id })
  for (const player of state.players) {
    for (const id of player.zones.hand) result.push({ zone: { kind: 'hand', playerId: player.id }, cardId: id })
    for (const id of player.zones.judgingArea) result.push({ zone: { kind: 'judgingArea', playerId: player.id }, cardId: id })
    for (const id of Object.values(player.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)))
      result.push({ zone: locateOwnedCard(state, player.id, id), cardId: id })
    for (const [pile, ids] of Object.entries(player.characterPiles ?? {})) for (const id of ids)
      result.push({ zone: { kind: 'characterPile', playerId: player.id, pile }, cardId: id })
  }
  return result.filter((entry): entry is { zone: NonNullable<typeof entry.zone>; cardId: CardId } => Boolean(entry.zone))
}
function liuhuiTakeRanks(host: SkillHost, ownerId: PlayerId, ranks: number[]): void {
  const rankSet = new Set(ranks)
  const matches = liuhuiCardZones(host.state).filter(({ cardId }) => {
    const card = host.state.cards[cardId]
    return card?.rank !== undefined && card?.rank !== null && rankSet.has(card.rank)
  })
  const gained: CardId[] = []
  for (const { zone, cardId } of matches) {
    if (!zone || !zoneCards(host.state, zone).includes(cardId) || zone.kind === 'hand' && zone.playerId === ownerId) continue
    moveCard(host.state, cardId, zone, { kind: 'hand', playerId: ownerId })
    gained.push(cardId)
  }
  if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: LIUHUI_GUOYUAN },
    { sourceId: ownerId, targetId: ownerId, cardIds: gained })
}

registerSkillRuntime({
  id: LIUHUI_GUOYUAN,
  onGameStart(host, ownerId) {
    const record = liuhuiCircle(host.state, ownerId)
    if (!record.points.length) record.points = host.rng.shuffle(Array.from({ length: 13 }, (_, index) => index + 1))
  },
  handLimitExempt(state, ownerId, cardId) {
    const points = liuhuiCircle(state, ownerId).points
    const rank = state.cards[cardId]?.rank
    return rank !== undefined && rank !== null && !points.includes(rank)
  },
  triggers: [{ event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const rank = cardId ? host.state.cards[cardId]?.rank : null
    const record = liuhuiCircle(host.state, ownerId)
    if (!cardId || rank === undefined || rank === null || !record.points.includes(rank) || record.recorded.includes(rank) || record.pending) return
    record.recorded.push(rank)
    if (record.recorded.length < record.points.length) return
    record.pending = { ranks: [record.recorded[0], record.recorded[record.recorded.length - 1]] }
    if (playerOf(host.state, ownerId)?.awakenedSkills?.includes(LIUHUI_GUSUAN)) {
      host.queueSkill({ skillId: LIUHUI_GUOYUAN, ownerId, step: 'modified', data: { chosen: [], ranks: record.pending.ranks } })
    } else finishLiuhuiCircle(host, ownerId)
  } }, { event: 'TurnEnd', handle(host, ownerId) {
    const player = playerOf(host.state, ownerId)
    const record = liuhuiCircle(host.state, ownerId)
    if (!player?.alive || player.awakenedSkills?.includes(LIUHUI_GUSUAN) || record.points.length !== 3) return
    player.awakenedSkills ??= []
    player.awakenedSkills.push(LIUHUI_GUSUAN)
    loseMaxHp(host as never, ownerId, 1, LIUHUI_GUSUAN)
    host.dispatch('SkillAwakened', { playerId: ownerId, skillId: LIUHUI_GUSUAN }, { sourceId: ownerId })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'modified') return
    const chosen = prompt.data.chosen as PlayerId[]
    const candidates = living(host.state).filter((player) => !chosen.includes(player.id)).map((player) => player.id)
    if (!candidates.length || chosen.length >= 3) { finishLiuhuiCircle(host, ownerId); return }
    askTargets(host, LIUHUI_GUOYUAN, ownerId, 'modified-target', ownerId, candidates, 0, 1,
      `【割圆·改】：选择第${chosen.length + 1}名角色，或结束选择`, prompt.data, true)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'modified-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) { finishLiuhuiCircle(host, ownerId); return }
      const chosen = [...(resolution.data.chosen as PlayerId[]), targetId]
      const index = chosen.length - 1
      if (index === 0) {
        const target = playerOf(host.state, targetId)
        if (target?.alive) drawCards(host.state, host.rng, targetId, 3)
        host.queueSkill({ skillId: LIUHUI_GUOYUAN, ownerId, step: 'modified', data: { chosen, ranks: resolution.data.ranks } })
      } else if (index === 1) {
        const target = playerOf(host.state, targetId)
        const cards = target ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
        const count = Math.min(4, cards.length)
        if (count) askCards(host, LIUHUI_GUOYUAN, ownerId, 'modified-discard', targetId, cards, count, count,
          '【割圆·改】：弃置四张牌', { chosen, ranks: resolution.data.ranks, targetId }, false)
        else host.queueSkill({ skillId: LIUHUI_GUOYUAN, ownerId, step: 'modified', data: { chosen, ranks: resolution.data.ranks } })
      } else {
        finishLiuhuiCircle(host, ownerId)
        liuhuiReplaceHandWithBottom(host, targetId)
      }
      return
    }
    if (resolution.step === 'modified-discard') {
      const targetId = resolution.data.targetId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const target = playerOf(host.state, targetId)
      const available = new Set(target ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))] : [])
      const valid = ids.filter((id) => available.has(id))
      if (valid.length) discardCardsByIds(host as never, targetId, valid, LIUHUI_GUOYUAN)
      host.queueSkill({ skillId: LIUHUI_GUOYUAN, ownerId, step: 'modified', data: { chosen: resolution.data.chosen, ranks: resolution.data.ranks } })
    }
  },
})

function finishLiuhuiCircle(host: SkillHost, ownerId: PlayerId): void {
  const record = liuhuiCircle(host.state, ownerId)
  const pending = record.pending as { ranks: number[] } | undefined
  if (!pending) return
  if (!playerOf(host.state, ownerId)?.awakenedSkills?.includes(LIUHUI_GUSUAN)) liuhuiTakeRanks(host, ownerId, pending.ranks)
  const remove = new Set(pending.ranks)
  record.points = record.points.filter((rank: number) => !remove.has(rank))
  record.recorded = []
  delete record.pending
}
function liuhuiReplaceHandWithBottom(host: SkillHost, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  while (host.state.zones.drawPile.length < 5 && reshuffleDrawPile(host.state, host.rng, (name, data) => host.dispatch(name, data)) > 0) { /* replenish the bottom five */ }
  const oldBottom = host.state.zones.drawPile.slice(-5)
  for (const id of oldBottom) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'processingArea' })
  for (const id of [...target.zones.hand]) moveCard(host.state, id, { kind: 'hand', playerId: targetId }, { kind: 'drawPile' })
  for (const id of oldBottom) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
  if (oldBottom.length) host.dispatch('GainCard', { playerId: targetId, cardIds: oldBottom, reason: LIUHUI_GUOYUAN },
    { sourceId: targetId, targetId, cardIds: oldBottom })
}

registerSkillRuntime({
  id: LIUHUI_JIESHU,
  handLimitExempt(state, ownerId, cardId) {
    return !liuhuiCircle(state, ownerId).points.includes(state.cards[cardId]?.rank ?? -1)
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const p = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      const rank = host.state.cards[p.cardId ?? p.cardIds?.[0] ?? '']?.rank
      if (rank !== undefined && rank !== null && liuhuiCircle(host.state, ownerId).points.includes(rank)) drawCards(host.state, host.rng, ownerId, 1)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const p = context.event.payload as { cardId?: CardId }
      const rank = p.cardId ? host.state.cards[p.cardId]?.rank : null
      if (rank !== undefined && rank !== null && liuhuiCircle(host.state, ownerId).points.includes(rank)) drawCards(host.state, host.rng, ownerId, 1)
    } },
  ],
})

registerSkillRuntime({ id: LIUHUI_GUSUAN })

registerSkillRuntime({
  id: SUNLINGLUAN_LINGLE,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const p = context.event.payload as { finalAmount?: number }
    const sourceId = context.event.sourceId
    if (!sourceId || (p.finalAmount ?? 0) <= 0) return
    const data = stateOf(host.state)
    data.lingleDamageByTurn ??= {}
    const turnKey = String(host.state.turnNumber)
    data.lingleCountedEvents ??= {}
    if (!data.lingleCountedEvents[context.event.id]) {
      data.lingleCountedEvents[context.event.id] = true
      data.lingleDamageByTurn[turnKey] = (data.lingleDamageByTurn[turnKey] ?? 0) + p.finalAmount!
    }
    data.lingleSourcesByRound ??= {}
    const seenKey = `${host.state.roundNumber}:${sourceId}`
    if (data.lingleSourcesByRound[seenKey]) return
    data.lingleSourcesByRound[seenKey] = true
    if (!playerOf(host.state, ownerId)?.alive) return
    const count = sourceId === host.state.currentPlayerId ? 1 : data.lingleDamageByTurn[turnKey]
    drawCards(host.state, host.rng, ownerId, Math.max(1, Math.trunc(count)))
  } }, { event: 'TurnEnd', handle(host, _ownerId, context) {
    const turn = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
    delete stateOf(host.state).lingleDamageByTurn?.[String(turn)]
    delete stateOf(host.state).lingleCountedEvents
    const oldRound = host.state.roundNumber - 1
    for (const key of Object.keys(stateOf(host.state).lingleSourcesByRound ?? {}))
      if (Number(key.split(':')[0]) < oldRound) delete stateOf(host.state).lingleSourcesByRound[key]
  } }],
})

registerSkillRuntime({
  id: SUNLINGLUAN_XIDI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play' || stateOf(state).xidi?.[ownerId]) return []
    const candidates = living(state).filter((player) => player.id !== ownerId
      && !(state.damageHistory ?? []).some((entry) => entry.sourceId === player.id && entry.turnNumber === state.turnNumber))
    return candidates.length ? [{ id: `skill:${SUNLINGLUAN_XIDI}`, label: '发动【盻睇】' }] : []
  },
  invokeActive(host, ownerId) {
    const candidates = living(host.state).filter((player) => player.id !== ownerId
      && !(host.state.damageHistory ?? []).some((entry) => entry.sourceId === player.id && entry.turnNumber === host.state.turnNumber))
      .map((player) => player.id)
    if (candidates.length) askTargets(host, SUNLINGLUAN_XIDI, ownerId, 'target', ownerId, candidates, 1, 1,
      '【盻睇】：选择一名本回合未造成过伤害的其他角色')
  },
  interceptPlayAction(host, ownerId, action) {
    const targetId = stateOf(host.state).xidi?.[ownerId] as PlayerId | undefined
    const owner = playerOf(host.state, ownerId)
    if (!targetId || action.playerId !== ownerId || action.kind !== 'use-card' || !action.cardIds.length
      || action.id.startsWith('play:recast:') || !action.cardIds.every((id) => owner?.zones.hand.includes(id))) return false
    const cardIds = [...action.cardIds]
    const actions = skillOtherHandCardUseActions(host.state, targetId, ownerId, cardIds, action.asCardName, SUNLINGLUAN_XIDI, action.nature)
    if (!actions.length) { delete stateOf(host.state).xidi?.[ownerId]; return true }
    host.askSkill({ skillId: SUNLINGLUAN_XIDI, ownerId, step: 'use-as-target', data: { targetId, cardIds, asCardName: action.asCardName, nature: action.nature }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【盻睇】：选择${playerOf(host.state, targetId)?.nickname ?? '目标角色'}使用此牌的合法方式`,
      timeoutMs: 25_000, optional: false, options: actions.map((item) => ({ id: item.id, label: item.label })),
    }) })
    return true
  },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId }
    if (p.playerId === ownerId) delete stateOf(host.state).xidi?.[ownerId]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && playerOf(host.state, targetId)?.alive) {
        stateOf(host.state).xidi ??= {}
        stateOf(host.state).xidi[ownerId] = targetId
      }
      return
    }
    if (resolution.step !== 'use-as-target') return
    const targetId = resolution.data.targetId as PlayerId
    const cardIds = resolution.data.cardIds as CardId[]
    const actionId = (response.payload as { optionId?: string }).optionId
    if (!actionId || !cardIds?.length || !cardIds.every((cardId) => playerOf(host.state, ownerId)?.zones.hand.includes(cardId))) return
    host.beginSkillCardUseFromOtherHand(targetId, ownerId, cardIds, SUNLINGLUAN_XIDI, actionId,
      resolution.data.asCardName as string, resolution.data.nature as DamageNature | undefined)
    delete stateOf(host.state).xidi?.[ownerId]
  },
})


const JIPING_PILE = JIPING_XUNLI
const plaguePile = (state: SanguoshaState, ownerId: PlayerId): CardId[] => playerOf(state, ownerId)?.characterPiles[JIPING_PILE] ?? []

registerSkillRuntime({
  id: JIPING_XUNLI,
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const { cardId, reason } = context.event.payload as { cardId?: CardId; reason?: string }
      const pile = plaguePile(host.state, ownerId)
      if (!cardId || reason !== 'discard' || host.state.cards[cardId]?.color !== 'black' || pile.length >= 9
        || !host.state.zones.discardPile.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: JIPING_PILE })
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (p.playerId === ownerId && p.phase === 'play' && plaguePile(host.state, ownerId).length)
        host.queueSkill({ skillId: JIPING_XUNLI, ownerId, step: 'exchange', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'exchange') return
    const hand = playerOf(host.state, ownerId)?.zones.hand.filter((id) => host.state.cards[id]?.color === 'black') ?? []
    const count = Math.min(hand.length, plaguePile(host.state, ownerId).length)
    if (count) askCards(host, JIPING_XUNLI, ownerId, 'exchange-hand', ownerId, hand, 0, count,
      '【询疠】：选择任意张黑色手牌交换等量“疠”')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'exchange-hand') {
      const hand = playerOf(host.state, ownerId)?.zones.hand ?? []
      const selected = ((response.payload as { cardIds?: CardId[] }).cardIds ?? [])
        .filter((id) => hand.includes(id) && host.state.cards[id]?.color === 'black')
      if (selected.length) askCards(host, JIPING_XUNLI, ownerId, 'exchange-plague', ownerId,
        [...plaguePile(host.state, ownerId)], selected.length, selected.length, '【询疠】：选择等量“疠”交换', { handIds: selected })
      return
    }
    if (resolution.step !== 'exchange-plague') return
    const hand = playerOf(host.state, ownerId)?.zones.hand ?? []
    const pile = plaguePile(host.state, ownerId)
    const handIds = (resolution.data.handIds as CardId[]).filter((id) => hand.includes(id) && host.state.cards[id]?.color === 'black')
    const plagueIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => pile.includes(id))
    if (handIds.length !== plagueIds.length) return
    for (const id of plagueIds) moveCard(host.state, id, { kind: 'characterPile', playerId: ownerId, pile: JIPING_PILE }, { kind: 'hand', playerId: ownerId })
    for (const id of handIds) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: JIPING_PILE })
  },
})

registerSkillRuntime({
  id: JIPING_ZHISHI,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (p.playerId === ownerId && p.phase === 'finish') host.queueSkill({ skillId: JIPING_ZHISHI, ownerId, step: 'select', data: {} })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) delete stateOf(host.state).zhishiTarget?.[ownerId]
    } },
    { event: 'TargetConfirmed', handle(host, ownerId, context) {
      if ((context.event.payload as { cardName?: string }).cardName !== '杀'
        || context.event.targetId !== stateOf(host.state).zhishiTarget?.[ownerId]) return
      host.queueSkill({ skillId: JIPING_ZHISHI, ownerId, step: 'offer', data: { targetId: context.event.targetId } })
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === stateOf(host.state).zhishiTarget?.[ownerId])
        host.queueSkill({ skillId: JIPING_ZHISHI, ownerId, step: 'offer', data: { targetId: context.event.targetId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'select') {
      const ids = living(host.state).map((player) => player.id)
      if (ids.length) askTargets(host, JIPING_ZHISHI, ownerId, 'select-target', ownerId, ids, 1, 1, '【指誓】：选择一名角色')
    } else if (prompt.step === 'offer' && plaguePile(host.state, ownerId).length)
      askOption(host, JIPING_ZHISHI, ownerId, 'offer', ownerId, '【指誓】：是否移去任意张“疠”并令其摸等量牌？', [{ id: 'yes', label: '发动' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'select-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && playerOf(host.state, targetId)?.alive) {
        stateOf(host.state).zhishiTarget ??= {}
        stateOf(host.state).zhishiTarget[ownerId] = targetId
      }
      return
    }
    if (resolution.step === 'offer' && (response.payload as { optionId?: string }).optionId === 'yes') {
      const pile = plaguePile(host.state, ownerId)
      if (pile.length) askCards(host, JIPING_ZHISHI, ownerId, 'remove-plague', ownerId, [...pile], 0, pile.length,
        '【指誓】：选择移去的“疠”', { targetId: resolution.data.targetId })
      return
    }
    if (resolution.step === 'remove-plague') {
      const targetId = resolution.data.targetId as PlayerId
      const pile = plaguePile(host.state, ownerId)
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const selected = ids.filter((id) => pile.includes(id))
      for (const id of selected) moveCard(host.state, id, { kind: 'characterPile', playerId: ownerId, pile: JIPING_PILE }, { kind: 'discardPile' })
      if (selected.length && playerOf(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, selected.length)
    }
  },
})

registerSkillRuntime({
  id: JIPING_LIEYI,
  ignoresDistanceTo(state, ownerId, targetId) {
    const action = stateOf(state).lieyi?.[ownerId]
    return action?.targetId === targetId
  },
  ignoresTrickDistance(state, ownerId) { return Boolean(stateOf(state).lieyi?.[ownerId]) },
  ignoresSlashUsesTo(state, ownerId, targetId) { return stateOf(state).lieyi?.[ownerId]?.targetId === targetId },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play'
      && !usedThisPhase(state, ownerId, JIPING_LIEYI) && plaguePile(state, ownerId).length > 0
      ? [{ id: `skill:${JIPING_LIEYI}`, label: '发动【烈医】' }] : []
  },
  invokeActive(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner || usedThisPhase(host.state, ownerId, JIPING_LIEYI)) return
    const targets = living(host.state).filter((p) => p.id !== ownerId).map((p) => p.id)
    if (!targets.length || !plaguePile(host.state, ownerId).length) return
    markUsedThisPhase(host.state, ownerId, JIPING_LIEYI)
    askTargets(host, JIPING_LIEYI, ownerId, 'target', ownerId, targets, 1, 1, '【烈医】：选择一名其他角色')
  },
  triggers: [
    { event: 'EnterDying', handle(host, ownerId, context) {
      if (stateOf(host.state).lieyi?.[ownerId]?.targetId === (context.event.payload as { playerId?: PlayerId }).playerId)
        stateOf(host.state).lieyi[ownerId].enteredDying = true
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const run = stateOf(host.state).lieyi?.[ownerId]
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (run?.waitingCardId && run.waitingCardId === cardId) {
        run.waitingCardId = undefined
        host.queueSkill({ skillId: JIPING_LIEYI, ownerId, step: 'next', data: {} })
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'next') return
    const run = stateOf(host.state).lieyi?.[ownerId]
    if (!run || run.waitingCardId) return
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, run.targetId)
    if (!owner?.alive || !target?.alive || run.index >= run.cardIds.length) {
      if (target?.alive && !run.enteredDying && owner?.alive) loseHp(host as never, ownerId, 1, JIPING_LIEYI)
      delete stateOf(host.state).lieyi[ownerId]
      return
    }
    const cardId = run.cardIds[run.index++] as CardId
    const actions = characterPileCardUseActions(host.state, ownerId, ownerId, cardId, JIPING_LIEYI)
      .filter((action) => action.targetIds.includes(run.targetId))
    if (!actions.length) {
      const from = locateOwnedCard(host.state, ownerId, cardId, { includeCharacterPiles: true })
      if (from?.kind === 'characterPile') moveCard(host.state, cardId, from, { kind: 'discardPile' })
      host.queueSkill({ skillId: JIPING_LIEYI, ownerId, step: 'next', data: {} })
      return
    }
    run.waitingCardId = cardId
    host.performSkillCardAction({ playerId: ownerId, cardOwnerId: ownerId, cardId,
      sourceSkillId: JIPING_LIEYI, actionId: actions[0]!.id })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      stateOf(host.state).lieyi ??= {}
      stateOf(host.state).lieyi[ownerId] = { targetId, cardIds: [...plaguePile(host.state, ownerId)], index: 0, enteredDying: false }
      host.queueSkill({ skillId: JIPING_LIEYI, ownerId, step: 'next', data: {} })
      return
    }
  },
})

registerSkillRuntime({
  id: LAIYINGER_XIAOWU,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play'
      && !usedThisPhase(state, ownerId, LAIYINGER_XIAOWU)
      ? [{ id: `skill:${LAIYINGER_XIAOWU}`, label: '发动【绡舞】' }] : []
  },
  invokeActive(host, ownerId) {
    const others = living(host.state).filter((p) => p.id !== ownerId)
    if (!others.length) return
    const seats = living(host.state).map((p) => p.id)
    const seat = seats.indexOf(ownerId)
    const adjacent = [seats[(seat - 1 + seats.length) % seats.length]!, seats[(seat + 1) % seats.length]!]
    const unique = [...new Set(adjacent)]
    askOption(host, LAIYINGER_XIAOWU, ownerId, 'direction', ownerId, '【绡舞】：选择从哪一侧开始', unique.map((id, index) => ({
      id, label: index === 0 ? `从${playerOf(host.state, id)?.nickname ?? '上家'}方向开始` : `从${playerOf(host.state, id)?.nickname ?? '下家'}方向开始`,
    })), { seats }, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'direction') {
      const first = (response.payload as { optionId?: string }).optionId as PlayerId | undefined
      const seats = living(host.state).map((p) => p.id)
      const ownerSeat = seats.indexOf(ownerId)
      if (!first || !seats.includes(first) || ownerSeat < 0) return
      const clockwise = seats[(ownerSeat + 1) % seats.length] === first
      const direction: 1 | -1 = clockwise ? 1 : -1
      const ordered: PlayerId[] = []
      for (let offset = 1; offset < seats.length; offset++) ordered.push(seats[(ownerSeat + direction * offset + seats.length * 2) % seats.length]!)
      askOption(host, LAIYINGER_XIAOWU, ownerId, 'count', ownerId, '【绡舞】：选择连续角色人数',
        ordered.map((_, index) => ({ id: String(index + 1), label: `${index + 1}名角色` })), { ordered }, false)
      return
    }
    if (resolution.step === 'count') {
      const count = Number((response.payload as { optionId?: string }).optionId)
      const ordered = (resolution.data.ordered as PlayerId[]).slice(0, count)
      const owner = playerOf(host.state, ownerId)
      if (!owner || !ordered.length || usedThisPhase(host.state, ownerId, LAIYINGER_XIAOWU)) return
      markUsedThisPhase(host.state, ownerId, LAIYINGER_XIAOWU)
      stateOf(host.state).xiaowu ??= {}
      stateOf(host.state).xiaowu[ownerId] = { targets: ordered, index: 0, ownerChoices: 0, selfChoices: 0, selfTargets: [] }
      host.queueSkill({ skillId: LAIYINGER_XIAOWU, ownerId, step: 'ask-next', data: {} })
      return
    }
    if (resolution.step !== 'vote') return
    const record = stateOf(host.state).xiaowu?.[ownerId]
    if (!record) return
    const choice = (response.payload as { optionId?: string }).optionId
    if (choice === 'owner') { record.ownerChoices++; if (playerOf(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 1) }
    if (choice === 'self') {
      const voterId = resolution.data.voterId as PlayerId
      record.selfChoices++
      record.selfTargets.push(voterId)
      if (playerOf(host.state, voterId)?.alive) drawCards(host.state, host.rng, voterId, 1)
    }
    record.index++
    host.queueSkill({ skillId: LAIYINGER_XIAOWU, ownerId, step: 'ask-next', data: {} })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-next') return
    const record = stateOf(host.state).xiaowu?.[ownerId]
    if (!record) return
    while (record.index < record.targets.length && !playerOf(host.state, record.targets[record.index])?.alive) record.index++
    if (record.index >= record.targets.length) {
        if (record.ownerChoices > record.selfChoices && playerOf(host.state, ownerId)?.alive) {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks['沙'] = (owner.marks['沙'] ?? 0) + 1
      } else if (record.selfChoices > record.ownerChoices) {
        for (const targetId of record.selfTargets) if (playerOf(host.state, targetId)?.alive)
          resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, sourceSkillId: LAIYINGER_XIAOWU })
      }
      delete stateOf(host.state).xiaowu[ownerId]
      return
    }
    const voterId = record.targets[record.index] as PlayerId
    askOption(host, LAIYINGER_XIAOWU, ownerId, 'vote', voterId, '【绡舞】：选择一项', [
      { id: 'owner', label: '令来莺儿摸一张牌' }, { id: 'self', label: '自己摸一张牌' },
    ], { voterId }, false)
  },
})

registerSkillRuntime({
  id: LAIYINGER_SHAWU,
  triggers: [{ event: 'TargetConfirmed', handle(host, ownerId, context) {
    const p = context.event.payload as { cardName?: string }
    const targetId = context.event.targetId
    if (p.cardName !== '杀' || !targetId || context.event.sourceId !== ownerId) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const options = [
      ...(owner.zones.hand.length >= 2 ? [{ id: 'discard', label: '弃置两张手牌，对其造成1点伤害' }] : []),
      ...((owner.marks['沙'] ?? 0) > 0 ? [{ id: 'sand', label: '移去1枚“沙”，摸两张牌并对其造成1点伤害' }] : []),
    ]
    if (options.length) host.queueSkill({ skillId: LAIYINGER_SHAWU, ownerId, step: 'choose', data: { targetId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    const options = [
      ...(owner && owner.zones.hand.length >= 2 ? [{ id: 'discard', label: '弃置两张手牌，对其造成1点伤害' }] : []),
      ...(owner && (owner.marks['沙'] ?? 0) > 0 ? [{ id: 'sand', label: '移去1枚“沙”，摸两张牌并对其造成1点伤害' }] : []),
    ]
    askOption(host, LAIYINGER_SHAWU, ownerId, 'choose', ownerId, '【沙舞】：选择一项', options, prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose') {
      const option = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      const targetId = resolution.data.targetId as PlayerId
      if (!owner || !playerOf(host.state, targetId)?.alive) return
      if (option === 'sand' && (owner.marks['沙'] ?? 0) > 0) {
        owner.marks['沙']!--
        drawCards(host.state, host.rng, ownerId, 2)
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, sourceSkillId: LAIYINGER_SHAWU })
      } else if (option === 'discard' && owner.zones.hand.length >= 2) {
        askCards(host, LAIYINGER_SHAWU, ownerId, 'discard', ownerId, [...owner.zones.hand], 2, 2, '【沙舞】：弃置两张手牌', { targetId }, false)
      }
      return
    }
    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      const valid = ids.filter((id) => owner?.zones.hand.includes(id))
      if (valid.length === 2) {
        discardCardsByIds(host as never, ownerId, valid, LAIYINGER_SHAWU)
        if (playerOf(host.state, targetId)?.alive) resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, sourceSkillId: LAIYINGER_SHAWU })
      }
    }
  },
})

registerSkillRuntime({
  id: LAIYINGER_HUAPING,
  limited: true,
  triggers: [{ event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
    const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (!deadId) return
    const owner = playerOf(host.state, ownerId)
    const used = Boolean(stateOf(host.state).huapingUsed?.[ownerId])
    if (deadId === ownerId) {
      if (used) return
      const candidates = living(host.state).map((p) => p.id)
      if (candidates.length) host.queueSkill({ skillId: LAIYINGER_HUAPING, ownerId, step: 'death-transfer', data: { candidates } })
      return
    }
    if (!owner?.alive || used) return
    host.queueSkill({ skillId: LAIYINGER_HUAPING, ownerId, step: 'gain-dead', data: { deadId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'gain-dead') {
      askOption(host, LAIYINGER_HUAPING, ownerId, 'gain-dead', ownerId, '【化萍】：是否获得该角色所有武将技能？',
        [{ id: 'yes', label: '发动【化萍】' }], prompt.data)
      return
    }
    if (prompt.step === 'death-transfer') {
      const candidates = (prompt.data.candidates as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive)
      if (candidates.length) askTargets(host, LAIYINGER_HUAPING, ownerId, 'death-target', ownerId, candidates, 1, 1,
        '【化萍】：选择一名角色获得【沙舞】和所有“沙”标记')
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'gain-dead') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const deadId = resolution.data.deadId as PlayerId
      const dead = playerOf(host.state, deadId)
      const owner = playerOf(host.state, ownerId)
      if (!dead || !owner?.alive || stateOf(host.state).huapingUsed?.[ownerId]) return
      const definition = ALL_CHARACTERS.find((character) => character.id === dead.characterId)
      for (const skill of definition?.skills ?? []) grantSkill(host.state, ownerId, skill.id)
      owner.permanentlyLostSkills ??= []
      if (!owner.permanentlyLostSkills.includes(LAIYINGER_XIAOWU)) owner.permanentlyLostSkills.push(LAIYINGER_XIAOWU)
      const sand = owner.marks['沙'] ?? 0
      delete owner.marks['沙']
      if (sand) drawCards(host.state, host.rng, ownerId, sand)
      stateOf(host.state).huapingUsed ??= {}
      stateOf(host.state).huapingUsed[ownerId] = true
      return
    }
    if (resolution.step === 'death-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : null
      if (!target?.alive || stateOf(host.state).huapingUsed?.[ownerId]) return
      const owner = playerOf(host.state, ownerId)
      const sand = owner?.marks['沙'] ?? 0
      if (owner) delete owner.marks['沙']
      if (!targetId) return
      grantSkill(host.state, targetId, LAIYINGER_SHAWU)
      target.marks['沙'] = (target.marks['沙'] ?? 0) + sand
      stateOf(host.state).huapingUsed ??= {}
      stateOf(host.state).huapingUsed[ownerId] = true
    }
  },
})

const HISTORICAL_BATCH71_CHARACTERS_UNSORTED: CharacterDefinition[] = [
  { id: 'zhouyi-b71', name: '周夷', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHOUYI_ZHUKOU, name: '逐寇', description: '当你于每个回合的出牌阶段第一次造成伤害后，你可以摸X张牌（X为本回合你已使用的牌数）。你的结束阶段，若你本回合没有造成伤害，你可以对两名其他角色各造成1点伤害。' },
    { id: ZHOUYI_MOQING, name: '氓情', description: '觉醒技，准备阶段，若受伤角色数大于你的体力值，你加3点体力上限并回复3点体力，失去“逐寇”，获得“玉殒”。' },
    { id: ZHOUYI_YUYUN, name: '玉殒', description: '锁定技，出牌阶段开始时，你失去1点体力或减1点体力上限（体力上限至多减至1），然后选择至多X项（X为你已损失的体力值+1且至多为5）：摸两张牌；对一名其他角色造成1点伤害且本回合对其使用【杀】无距离和次数限制；本回合手牌上限无限；获得一名其他角色区域里的一张牌；令一名其他角色将手牌摸至体力上限（至多5张）。', locked: true, granted: true },
  ] },
  { id: 'zhangning-b71', name: '张宁', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANGNING_TIANZE, name: '天则', description: '其他角色于其出牌阶段内使用第一张黑色手牌结算完毕后，你可以弃置一张黑色牌对其造成1点伤害（每回合限触发一次）。其他角色的黑色判定牌生效后，你摸1张牌。' },
    { id: ZHANGNING_DIFA, name: '地法', description: '每回合限一次，当你于回合内获得红色牌后，你可以弃置此牌，然后选择1张锦囊牌从牌堆或弃牌堆获得。' },
  ] },
  { id: 'laiying-er-b71', name: '来莺儿', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: LAIYINGER_XIAOWU, name: '绡舞', description: '出牌阶段限一次，你可以从你的上家或下家起选择任意名座位连续的其他角色，每名角色依次选择一项：1.令你摸一张牌；2.自己摸一张牌。选择完成后，若令你摸牌的选择人数较多，你获得一个“沙”标记；若自己摸牌的选择人数较多，你对这些角色各造成1点伤害。' },
    { id: LAIYINGER_HUAPING, name: '化萍', description: '限定技，一名其他角色死亡时，你可以获得其所有武将技能，然后你失去“绡舞”和所有“沙”标记并摸等量的牌。你死亡时，若此技能未发动过，你可令一名其他角色获得技能“沙舞”和所有“沙”标记。' },
    { id: LAIYINGER_SHAWU, name: '沙舞', description: '当你使用【杀】指定目标后，你可以选择一项：1.弃置两张手牌，然后对其造成1点伤害；2.移去1枚“沙”并摸两张牌，然后对其造成1点伤害。', granted: true },
  ] },
  { id: 'jiping-b71', name: '吉平', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: JIPING_XUNLI, name: '询疠', description: '锁定技，黑色牌因弃置进入弃牌堆时，你将其置于你的武将牌上，称为“疠”（最多为9张）。出牌阶段开始时，你可以用任意张黑色手牌交换等量的“疠”。', locked: true },
    { id: JIPING_ZHISHI, name: '指誓', description: '结束阶段，你可以选择一名角色。直到你的下回合开始，该角色成为【杀】的目标后或进入濒死状态时，你可以移去任意数量的“疠”，然后令其摸等量的牌。' },
    { id: JIPING_LIEYI, name: '烈医', description: '出牌阶段限一次，你可以展示所有“疠”并选择一名其他角色，依次对该角色使用可以对其使用的牌（无视距离和次数），其余的牌置入弃牌堆。然后若该角色没因此进入濒死状态，你失去1点体力。' },
  ] },
  { id: 'caohua-b71', name: '曹华', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: CAOHUA_CAIYI, name: '彩翼', description: '转换技，结束阶段，你可令一名角色选择一项执行后移除：阳：回复X点体力、摸X张牌、复原武将牌、随机执行一个已移除的阳选项；阴：受到X点伤害、弃X张牌、翻面并横置、随机执行一个已移除的阴选项。（X为该状态剩余选项数量）' },
    { id: CAOHUA_GUII, name: '归离', description: '锁定技，你的第一个回合开始时，你选择一名其他角色。该角色每轮第一个回合结束后，若其本回合未造成伤害，你执行一个额外回合。', locked: true },
  ] },
  { id: 'liuhui-b71', name: '刘徽', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: LIUHUI_GUOYUAN, name: '割圆', description: '锁定技，游戏开始时，将A~K的所有点数随机排列成一个圆环。有牌进入弃牌堆时，将满足圆环进度的点数记录在圆环内。当圆环完成后，你获得牌堆和场上所有完成此圆环最初和最后点数的牌；觉醒后，改为依次选择至多三名不同角色，令第一名摸三张牌、第二名弃置四张牌、第三名以牌堆底五张牌替换其所有手牌。然后从圆环中移除首尾点数，重新开始圆环。', locked: true },
    { id: LIUHUI_JIESHU, name: '解术', description: '锁定技，非圆环内点数的牌不计入你的手牌上限。你使用或打出牌时，若满足圆环进度点数，你摸一张牌。', locked: true },
    { id: LIUHUI_GUSUAN, name: '股算', description: '觉醒技，每个回合结束时，若圆环剩余点数为3个，你减1点体力上限，并修改“割圆”。' },
  ] },
  { id: 'luyi-b71', name: '卢弈', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: LUYI_YAOYI, name: '邀弈', description: '锁定技，游戏开始时，给全场没有转换技的角色增加“手谈”。你发动“手谈”无需弃置牌且无次数限制。所有角色使用牌只能指定自己及与自己转换技状态不同的角色为目标。', locked: true },
    { id: LUYI_FUXUE, name: '复学', description: '准备阶段，你可以从弃牌堆中选择至多X张不是因使用而进入弃牌堆的牌获得。结束阶段，若你手中没有以此法获得的牌，你摸X张牌。（X为你的体力值）' },
    { id: LUYI_SHOUTAN, name: '手谈', description: '转换技，出牌阶段限一次，你可以弃置一张与当前转换状态颜色相应的手牌，然后转换状态。', granted: true },
  ] },
  { id: 'sunlingluan-b71', name: '孙翎鸾', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: SUNLINGLUAN_LINGLE, name: '聆乐', description: '锁定技，一名角色在本轮首次造成伤害后，你摸1张牌。若此时是该角色回合外，改为摸X张牌（X为本回合全场造成的伤害值）。', locked: true },
    { id: SUNLINGLUAN_XIDI, name: '盻睇', description: '出牌阶段，你可以选择一名本回合未造成过伤害的其他角色，你此阶段使用的下一张牌，视为该角色使用。' },
  ] },
  { id: 'zhangheng-b71', name: '张横', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHANGHENG_LIANGJUE, name: '粮绝', description: '锁定技，每有1张黑色牌进入或者离开你的判定区或装备区时，你摸两张牌，若你体力值大于1，失去1点体力。', locked: true },
    { id: ZHANGHENG_DANGZAI, name: '挡灾', description: '出牌阶段开始时，你可选择一名判定区里有牌的其他角色，然后将其判定区里的任意张牌移动到你的判定区。' },
  ] },
  { id: 'fengfang-b71', name: '冯方', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: FENGFANG_DITING, name: '谛听', description: '其他角色的出牌阶段开始时，若你在其攻击范围内，你可以观看其X张手牌（X为你的体力值），然后秘密选择其中一张。此阶段其使用此牌指定你为目标后，此牌对你无效；其使用此牌没有指定你为目标后，你摸两张牌；若其出牌阶段结束时此牌仍在手牌中，你获得之。' },
    { id: FENGFANG_BIHUO, name: '避祸', description: '当你受到其他角色造成的伤害后，你可令一名角色下回合的摸牌阶段摸牌数+1；当你对其他角色造成伤害后，你可令一名角色下回合的摸牌阶段摸牌数-1。' },
  ] },
]

const HISTORICAL_BATCH71_ORDER = HISTORICAL_BATCH71_CHARACTERS_UNSORTED.map((character) => character.id)
const HISTORICAL_BATCH71_ORDER_INDEX = new Map(HISTORICAL_BATCH71_ORDER.map((id, index) => [id, index]))
export const HISTORICAL_BATCH71_CHARACTERS: readonly CharacterDefinition[] = [...HISTORICAL_BATCH71_CHARACTERS_UNSORTED]
  .sort((left, right) => (HISTORICAL_BATCH71_ORDER_INDEX.get(left.id) ?? 0) - (HISTORICAL_BATCH71_ORDER_INDEX.get(right.id) ?? 0))

// Batch 71 runtimes continue below; all per-game state is plain serializable data.

