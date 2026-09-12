import { moveCard, setCardAlias } from '../../engine/zones'
import { effectiveCardColor, registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import { huashenEligibleSkills } from '../../engine/huashen'
import { drawCards } from '../../engine/draw'
import { hiddenHandSlot } from '../../engine/cards/host'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹爽（三国杀 OL 经典身份 SP）。
 *
 * 【托孤】：一名角色死亡时，曹爽可以获得其一个技能（主公技、限定技、
 *          觉醒技、隐匿技除外），并失去上一次通过托孤获得的技能——
 *          直接复用【化身】的资格判定和 `replaceTemporarySkill` 的
 *          按来源替换语义，不会误删曹爽从别处获得的同名技能。
 * 【擅专】：曹爽对一名其他角色造成伤害后，若其判定区没有牌，可以将
 *          其一张牌置入其判定区（非延时锦囊按颜色视为乐不思蜀/兵粮寸断）；
 *          曹爽结束阶段若本回合没有造成过伤害，可以摸一张牌。
 */

const TUOGU = 'tuogu'
const SHANZHUAN = 'shanzhuan'
const SHANZHUAN_DAMAGED_MARK = `${SHANZHUAN}-damaged`

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: TUOGU,
  triggers: [{
    event: 'Death',
    handle(host, ownerId, context) {
      const deadId = context.event.targetId
      if (!deadId || deadId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const dead = playerOf(host.state, deadId)
      if (!owner?.alive || !dead?.characterId) return
      const eligible = huashenEligibleSkills(dead.characterId)
      if (eligible.length === 0) return
      host.queueSkill({ skillId: TUOGU, ownerId, step: 'ask', data: { deadId, options: eligible } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    const { options } = prompt.data as { options: Array<{ id: string; name: string }> }
    host.askSkill({
      skillId: TUOGU, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【托孤】：获得一个技能（可以放弃）', timeoutMs: 20_000, optional: true,
        options: [...options.map((skill) => ({ id: skill.id, label: skill.name })), { id: 'none', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const skillId = (response.payload as { optionId?: string }).optionId
    if (!skillId || skillId === 'none') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    replaceTemporarySkill(host.state, ownerId, TUOGU, skillId)
    host.dispatch('SkillActivated', { skillId: TUOGU, skillName: '托孤', playerId: ownerId, logText: `${owner.nickname}发动【托孤】，获得技能` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: SHANZHUAN,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.sourceId === ownerId) markUsedThisPhase(host.state, ownerId, SHANZHUAN_DAMAGED_MARK)
        const targetId = context.event.targetId
        if (context.event.sourceId !== ownerId || !targetId || targetId === ownerId) return
        const target = playerOf(host.state, targetId)
        if (!target?.alive || target.zones.judgingArea.length > 0) return
        const hidden = target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index))
        const visible = Object.values(target.zones.equipment).filter((cardId): cardId is CardId => !!cardId)
        if (hidden.length + visible.length === 0) return
        host.queueSkill({ skillId: SHANZHUAN, ownerId, step: 'ask', data: { targetId } })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || usedThisPhase(host.state, ownerId, SHANZHUAN_DAMAGED_MARK)) return
        drawCards(host.state, host.rng, ownerId, 1, (name, eventPayload) => { host.dispatch(name, eventPayload) })
        host.dispatch('SkillActivated', { skillId: SHANZHUAN, skillName: '擅专', playerId: ownerId, logText: `${owner.nickname}发动【擅专】，摸牌` }, { sourceId: ownerId })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!playerOf(host.state, ownerId)?.alive || !target?.alive || target.zones.judgingArea.length > 0) return
    const hidden = target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index))
    const visible = Object.values(target.zones.equipment).filter((cardId): cardId is CardId => !!cardId)
    if (hidden.length + visible.length === 0) return
    host.askSkill({
      skillId: SHANZHUAN, ownerId, step: 'pick', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【擅专】：可以将${target.nickname}的一张牌置入其判定区`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: visible, hiddenCardSlots: hidden, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!playerOf(host.state, ownerId)?.alive || !target?.alive || target.zones.judgingArea.length > 0) return
    const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
    if (!picked) return

    let cardId: CardId
    let from: { kind: 'hand'; playerId: PlayerId } | { kind: 'equipment'; playerId: PlayerId; slot: keyof typeof target.zones.equipment }
    const hiddenIndex = target.zones.hand.findIndex((_, index) => hiddenHandSlot(targetId, index) === picked)
    if (hiddenIndex >= 0) {
      cardId = target.zones.hand[hiddenIndex]
      from = { kind: 'hand', playerId: targetId }
    } else {
      const slot = (Object.keys(target.zones.equipment) as Array<keyof typeof target.zones.equipment>)
        .find((key) => target.zones.equipment[key] === picked)
      if (!slot) return
      cardId = picked as CardId
      from = { kind: 'equipment', playerId: targetId, slot }
    }

    const color = effectiveCardColor(host.state, targetId, cardId)
    const isDelayedTrick = DELAYED_TRICKS.has(host.state.cardAliases[cardId] ?? host.state.cards[cardId]?.name ?? '')
    moveCard(host.state, cardId, from, { kind: 'judgingArea', playerId: targetId })
    if (!isDelayedTrick) setCardAlias(host.state, cardId, color === 'red' ? '乐不思蜀' : '兵粮寸断')
    host.dispatch('SkillActivated', { skillId: SHANZHUAN, skillName: '擅专', playerId: ownerId, targetId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【擅专】` }, { sourceId: ownerId, targetId })
  },
})

export const CAOSHUANG: CharacterDefinition = {
  id: 'caoshuang',
  name: '曹爽',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: TUOGU, name: '托孤', description: '一名角色死亡时，曹爽可以获得其一个技能（主公技、限定技、觉醒技、隐匿技除外），然后失去上一次通过托孤获得的技能。' },
    { id: SHANZHUAN, name: '擅专', description: '曹爽对一名其他角色造成伤害后，若其判定区没有牌，可以将其一张牌置入其判定区（非延时锦囊按颜色视为【乐不思蜀】或【兵粮寸断】）；曹爽结束阶段，若本回合没有造成过伤害，可以摸一张牌。' },
  ],
}
