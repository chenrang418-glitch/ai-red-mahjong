import { moveCard } from '../../engine/zones'
import { continueDyingRescue } from '../../engine/damage'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { HUNZI } from './mountain-sunce'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孙翊（三国杀《一将成名》官方当前版本）。
 *
 * 【激峭】：出牌阶段开始时，将牌堆顶X张牌（X为体力上限）置于武将牌上，
 *          称为"激峭牌"，只持续到本阶段结束；每使用1张牌后，若仍有
 *          激峭牌，可以获得其中1张，然后视剩余激峭牌红黑数量是否相等
 *          回复1点体力或失去1点体力（相等则回复，含0/0）。
 * 【凶疑】：限定技，你处于濒死状态时可以发动：若徐氏不在场，回复至3点
 *          体力并将你的武将牌替换为徐氏；若徐氏在场，回复至1点体力并
 *          获得【魂姿】。
 */

const JIQIAO = 'jiqiao'
const XIONGYI = 'xiongyi'
const PILE = 'jiqiao'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function pileOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.characterPiles?.[PILE] ?? []
}

registerSkillRuntime({
  id: JIQIAO,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const x = Math.min(owner.maxHp, host.state.zones.drawPile.length)
        if (x <= 0) return
        const top = host.state.zones.drawPile.slice(0, x)
        for (const cardId of top) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: PILE })
        host.dispatch('SkillActivated', { skillId: JIQIAO, skillName: '激峭', playerId: ownerId, logText: `${owner.nickname}发动【激峭】，获得${top.length}张"激峭牌"` }, { sourceId: ownerId })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || pileOf(host.state, ownerId).length === 0) return
        host.queueSkill({ skillId: JIQIAO, ownerId, step: 'pick', data: {} })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const remaining = pileOf(host.state, ownerId)
        for (const cardId of remaining) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'discardPile' })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    const pile = pileOf(host.state, ownerId)
    if (!owner?.alive || pile.length === 0) return
    host.askSkill({
      skillId: JIQIAO, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【激峭】：获得一张"激峭牌"', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: pile, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !cardId || !pileOf(host.state, ownerId).includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: JIQIAO }, { targetId: ownerId, cardIds: [cardId] })
    const remaining = pileOf(host.state, ownerId)
    const redCount = remaining.filter((id) => host.state.cards[id]?.color === 'red').length
    const blackCount = remaining.filter((id) => host.state.cards[id]?.color === 'black').length
    if (redCount === blackCount) {
      if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ownerId)
    } else if (owner.alive) {
      loseHp(host as never, ownerId, 1, JIQIAO)
    }
  },
})

registerSkillRuntime({
  id: XIONGYI,
  dyingIntercept(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(XIONGYI)) return false
    host.askSkill({
      skillId: XIONGYI, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '你处于濒死状态，是否发动限定技【凶疑】？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【凶疑】' }, { id: 'no', label: '不发动' }],
      }),
    })
    return 'pending'
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask' || host.state.dying?.playerId !== ownerId) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if ((response.payload as { optionId?: string }).optionId !== 'yes' || owner.usedLimitedSkills.includes(XIONGYI)) {
      continueDyingRescue(host)
      if (!host.state.dying) host.resumeAfterDying()
      return
    }
    owner.usedLimitedSkills.push(XIONGYI)
    const xushiInPlay = host.state.players.some((candidate) => candidate.alive && candidate.characterId === 'xushi')
    if (!xushiInPlay) {
      owner.characterId = 'xushi'
      owner.maxHp = 3
      const recovered = Math.max(0, Math.min(owner.maxHp, 3) - owner.hp)
      owner.hp = Math.min(owner.maxHp, 3)
      if (recovered > 0) host.dispatch('Recover', { playerId: ownerId, amount: recovered, reason: XIONGYI }, { targetId: ownerId })
      host.dispatch('SkillActivated', { skillId: XIONGYI, skillName: '凶疑', playerId: ownerId, logText: `${owner.nickname}发动【凶疑】，武将牌被替换为徐氏` }, { sourceId: ownerId })
    } else {
      const recovered = Math.max(0, Math.min(owner.maxHp, 1) - owner.hp)
      owner.hp = Math.min(owner.maxHp, 1)
      if (recovered > 0) host.dispatch('Recover', { playerId: ownerId, amount: recovered, reason: XIONGYI }, { targetId: ownerId })
      owner.grantedSkills = [...(owner.grantedSkills ?? []), HUNZI]
      host.dispatch('SkillActivated', { skillId: XIONGYI, skillName: '凶疑', playerId: ownerId, logText: `${owner.nickname}发动【凶疑】，获得【魂姿】` }, { sourceId: ownerId })
    }
    host.dispatch('QuitDying', { playerId: ownerId, hp: owner.hp, reason: XIONGYI }, { targetId: ownerId })
    host.state.dying = null
    host.resumeAfterDying()
  },
})

export const SUNYI: CharacterDefinition = {
  id: 'sunyi',
  name: '孙翊',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: JIQIAO, name: '激峭', description: '出牌阶段开始时，将牌堆顶X张牌置于武将牌上，称为"激峭牌"（X为体力上限），只持续到本阶段结束；每使用1张牌后，若仍有激峭牌，可以获得其中1张，然后视剩余激峭牌红黑数量是否相等回复1点体力或失去1点体力。' },
    { id: XIONGYI, name: '凶疑', description: '限定技，你处于濒死状态时可以发动：若徐氏不在场，回复至3点体力并将你的武将牌替换为徐氏；若徐氏在场，回复至1点体力并获得【魂姿】。' },
  ],
}
