import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { lockCardColor } from '../../engine/card-play-lock'
import { effectiveCardColor, registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹真（一将成名 2014）。
 *
 * 【司敌】：其他角色的出牌阶段开始时，曹真可以弃置一张非基本牌，且这张牌的
 *          颜色必须与曹真装备区中至少一张牌的颜色相同；若如此做，直到这个
 *          出牌阶段结束，该角色不能使用或打出与曹真弃置牌颜色相同的牌。
 *          此出牌阶段结束时，若该角色本阶段没有使用过【杀】，视为曹真对其
 *          使用一张【杀】。
 *
 * 三处最容易做错的：
 *
 * 1. **颜色封锁看有效颜色**：转化技的子牌一样被拦，走既有的
 *    `card-play-lock` 统一入口，不能靠红底牌转出黑色虚拟牌绕过去。
 * 2. **「本阶段用过杀」按这个出牌阶段实例计数**，额外出牌阶段各自独立，
 *    走 `phase-usage.ts` 的阶段账本，不按整个回合算。
 * 3. **只有曹真这次真的锁了这个人的这个阶段**，阶段结束时才补一刀；
 *    没锁过（比如没弃成）不触发强制杀。
 */

const SIDI = 'sidi'
const SLASH_USED_MARK = 'sidi-slash-used'
const LOCKED_THIS_PHASE_MARK = 'sidi-locked-phase'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function equippedColors(state: SanguoshaState, ownerId: PlayerId): Set<'red' | 'black'> {
  const owner = playerOf(state, ownerId)
  if (!owner) return new Set()
  const colors = new Set<'red' | 'black'>()
  for (const cardId of Object.values(owner.zones.equipment)) {
    if (!cardId) continue
    const color = effectiveCardColor(state, ownerId, cardId)
    if (color) colors.add(color)
  }
  return colors
}

function discardCandidates(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  const colors = equippedColors(state, ownerId)
  if (colors.size === 0) return []
  return owner.zones.hand.filter((cardId) => {
    const card = state.cards[cardId]
    if (!card || card.category === 'basic') return false
    const color = effectiveCardColor(state, ownerId, cardId)
    return color != null && colors.has(color)
  })
}

registerSkillRuntime({
  id: SIDI,
  announcesSelf: true,

  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId === ownerId || !payload.playerId) return
        // 排队而不是当场问：同一次阶段开始可能撞上别的角色技能已经挂起的发问。
        host.queueSkill({ skillId: SIDI, ownerId, step: 'discard', data: { actorId: payload.playerId } })
      },
    },
    /*
     * 记录**任何人**这个出牌阶段有没有用过杀——挂在曹真自己的技能上，
     * 触发时读的是事件里的使用者，不是曹真本人。
     */
    {
      event: 'AfterCardUse',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { cardName?: string }
        if (payload.cardName !== '杀') return
        const userId = context.event.sourceId as PlayerId | undefined
        if (!userId) return
        markUsedThisPhase(host.state, userId, SLASH_USED_MARK)
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || !payload.playerId || payload.playerId === ownerId) return
        const actorId = payload.playerId
        const owner = playerOf(host.state, ownerId)
        const actor = playerOf(host.state, actorId)
        if (!owner?.alive || !actor?.alive) return
        if (!usedThisPhase(host.state, actorId, LOCKED_THIS_PHASE_MARK)) return
        if (usedThisPhase(host.state, actorId, SLASH_USED_MARK)) return
        host.dispatch('SkillActivated', {
          skillId: SIDI, skillName: '司敌', playerId: ownerId, targetId: actorId,
          logText: `${actor.nickname}本阶段没有使用过【杀】，视为${owner.nickname}对其使用一张【杀】`,
        }, { sourceId: ownerId, targetId: actorId })
        host.beginVirtualSlash({ sourceId: ownerId, targetId: actorId, sourceSkillId: SIDI })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const actorId = prompt.data.actorId as PlayerId
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = discardCandidates(host.state, ownerId)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: SIDI, ownerId, step: 'discard', data: { actorId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【司敌】：弃置一张非基本牌（颜色需与你装备区某牌相同）',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const actorId = resolution.data.actorId as PlayerId
    const actor = playerOf(host.state, actorId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner?.alive || !actor?.alive || !discardCandidates(host.state, ownerId).includes(cardId)) return
    const color = effectiveCardColor(host.state, ownerId, cardId)
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: SIDI }, { targetId: ownerId, cardIds: [cardId] })
    if (color == null || !lockCardColor(host.state, { targetId: actorId, color, sourceId: ownerId, skillId: SIDI })) return
    markUsedThisPhase(host.state, actorId, LOCKED_THIS_PHASE_MARK)
    host.dispatch('SkillActivated', {
      skillId: SIDI, skillName: '司敌', playerId: ownerId, targetId: actorId,
      logText: `${owner.nickname}发动【司敌】，${actor.nickname}本阶段不能使用或打出${color === 'red' ? '红色' : '黑色'}牌`,
    }, { sourceId: ownerId, targetId: actorId })
  },
})

export const CAOZHEN: CharacterDefinition = {
  id: 'caozhen',
  name: '曹真',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2014',
  skills: [
    {
      id: SIDI,
      name: '司敌',
      description: '其他角色的出牌阶段开始时，曹真可以弃置一张非基本牌，且这张牌的颜色必须与曹真装备区中至少一张牌的颜色相同；若如此做，直到这个出牌阶段结束，该角色不能使用或打出与曹真弃置牌颜色相同的牌。此出牌阶段结束时，若该角色本阶段没有使用过【杀】，视为曹真对其使用一张【杀】。',
    },
  ],
}
