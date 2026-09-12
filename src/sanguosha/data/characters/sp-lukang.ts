import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { loseMaxHp } from '../../engine/hp'
import { handleEquipmentLost } from '../../engine/equipment'
import { ABOLISHABLE_SLOTS, abolishSlot, isSlotAbolished } from '../../engine/equipment-slots'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { grantSkill, registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import type { SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陆抗（三国杀 OL 经典身份 SP）。
 *
 * 【谦节】：锁定技，陆抗不能进入横置状态、不能成为延时锦囊的目标、
 *          不能成为其他角色发起的拼点的目标。
 * 【决堰】：出牌阶段限一次，选择一个尚未废除的装备栏类别并永久废除，
 *          获得对应收益。本项目引擎没有“宝物栏”这个装备槽，宝物栏分支
 *          按“视为已废除”处理（不摧毁任何真实的槽），只给集智效果。
 * 【破势】：觉醒技，装备栏全部废除或体力为1时，准备阶段强制觉醒：
 *          失去1点体力上限，摸牌至体力上限，永久失去决堰，获得怀柔。
 * 【怀柔】：出牌阶段可以反复重铸装备牌。
 */

const QIANJIE = 'qianjie'
const JUEYAN = 'jueyan'
const POSHI = 'poshi'
const HUAIROU = 'huairou'
const TREASURE_USED_MARK = 'lukang-treasure-used'
const JUEYAN_TREASURE_SOURCE = 'lukang-jueyan-treasure'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: QIANJIE,
  preventsChaining: true,
  prohibitsBeingPindianTarget: true,
  prohibitsTarget(_state, _ownerId, _sourceId, cardName) {
    return DELAYED_TRICKS.has(cardName)
  },
})

registerSkillRuntime({
  id: JUEYAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(JUEYAN) || owner.awakenedSkills.includes(POSHI)) return []
    const options = availableJueyanOptions(state, ownerId)
    return options.length > 0 ? [{ id: JUEYAN, label: '决堰：废除一个装备栏类别' }] : []
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== JUEYAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(JUEYAN)) return
    const options = availableJueyanOptions(host.state, ownerId)
    if (options.length === 0) return
    host.askSkill({
      skillId: JUEYAN, ownerId, step: 'choose',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【决堰】：选择一个装备栏类别废除', timeoutMs: 20_000, optional: false, options,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(JUEYAN)) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (!optionId) return
    owner.turnUsedSkills.push(JUEYAN)
    host.dispatch('SkillActivated', { skillId: JUEYAN, skillName: '决堰', playerId: ownerId, logText: `${owner.nickname}发动【决堰】` }, { sourceId: ownerId })

    if (optionId === 'weapon') {
      abolishEquipmentSlot(host, ownerId, 'weapon')
      grantTurnSlashBonus(host.state, ownerId, { extraUses: 3 })
    } else if (optionId === 'armor') {
      abolishEquipmentSlot(host, ownerId, 'armor')
      drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
      host.state.lukangArmorMaxCardsTurn = host.state.turnNumber
    } else if (optionId === 'mount') {
      abolishEquipmentSlot(host, ownerId, 'offensiveHorse')
      abolishEquipmentSlot(host, ownerId, 'defensiveHorse')
      host.state.lukangMountUnlimitedTurn = host.state.turnNumber
    } else if (optionId === 'treasure') {
      owner.marks[TREASURE_USED_MARK] = 1
      replaceTemporarySkill(host.state, ownerId, JUEYAN_TREASURE_SOURCE, 'jizhi')
      host.state.lukangTreasureGrantTurn = host.state.turnNumber
    }
  },

  maxCardsBonus(state, _ownerId) {
    return state.lukangArmorMaxCardsTurn === state.turnNumber ? 3 : 0
  },
  ignoresDistanceTo(state, _ownerId) {
    return state.lukangMountUnlimitedTurn === state.turnNumber
  },

  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId) {
      if (host.state.lukangTreasureGrantTurn === host.state.turnNumber) {
        replaceTemporarySkill(host.state, ownerId, JUEYAN_TREASURE_SOURCE, null)
      }
    },
  }],
})

function availableJueyanOptions(state: SanguoshaState, ownerId: PlayerId): Array<{ id: string; label: string }> {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const options: Array<{ id: string; label: string }> = []
  if (!isSlotAbolished(state, ownerId, 'weapon')) options.push({ id: 'weapon', label: '武器栏：本回合出杀次数+3' })
  if (!isSlotAbolished(state, ownerId, 'armor')) options.push({ id: 'armor', label: '防具栏：摸3张牌，本回合手牌上限+3' })
  if (!isSlotAbolished(state, ownerId, 'offensiveHorse') || !isSlotAbolished(state, ownerId, 'defensiveHorse')) {
    options.push({ id: 'mount', label: '坐骑栏：本回合使用牌无距离限制' })
  }
  if ((owner.marks[TREASURE_USED_MARK] ?? 0) <= 0) options.push({ id: 'treasure', label: '宝物栏：本回合获得【集智】' })
  return options
}

function abolishEquipmentSlot(host: SkillHost, ownerId: PlayerId, slot: (typeof ABOLISHABLE_SLOTS)[number]): void {
  if (isSlotAbolished(host.state, ownerId, slot)) return
  const owner = playerOf(host.state, ownerId)!
  const equipped = owner.zones.equipment[slot]
  if (equipped) {
    moveCard(host.state, equipped, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
    handleEquipmentLost(host as never, ownerId, equipped)
  }
  abolishSlot(host.state, ownerId, slot)
}

registerSkillRuntime({
  id: POSHI,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      if (!owner?.alive) return false
      if (owner.hp === 1) return true
      const mountAbolished = isSlotAbolished(state, ownerId, 'offensiveHorse') && isSlotAbolished(state, ownerId, 'defensiveHorse')
      const allAbolished = isSlotAbolished(state, ownerId, 'weapon') && isSlotAbolished(state, ownerId, 'armor') && mountAbolished
        && (owner.marks[TREASURE_USED_MARK] ?? 0) > 0
      return allAbolished
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      loseMaxHp(host as never, ownerId, 1, POSHI)
      const current = playerOf(host.state, ownerId)
      if (!current?.alive) return
      const need = Math.max(0, current.maxHp - current.zones.hand.length)
      if (need > 0) drawCards(host.state, host.rng, ownerId, need, (name, payload) => { host.dispatch(name, payload) })
      grantSkill(host.state, ownerId, HUAIROU)
      host.dispatch('SkillActivated', { skillId: POSHI, skillName: '破势', playerId: ownerId, logText: `${owner.nickname}发动【破势】，觉醒` }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: HUAIROU,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.every((cardId) => state.cards[cardId]?.category !== 'equipment')) return []
    return [{ id: HUAIROU, label: '怀柔：重铸一张装备牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== HUAIROU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const equipment = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === 'equipment')
    if (equipment.length === 0) return
    host.askSkill({
      skillId: HUAIROU, ownerId, step: 'pick',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【怀柔】：选择一张装备牌重铸', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: equipment, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.category !== 'equipment') return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }, { discardReason: 'other' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: 'recast' }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: HUAIROU, skillName: '怀柔', playerId: ownerId, logText: `${owner.nickname}发动【怀柔】，重铸一张装备牌` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const LUKANG: CharacterDefinition = {
  id: 'lukang',
  name: '陆抗',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: QIANJIE, name: '谦节', description: '锁定技，陆抗不能进入横置状态、不能成为延时锦囊的目标、不能成为其他角色发起的拼点的目标。' },
    { id: JUEYAN, name: '决堰', description: '出牌阶段限一次，选择一个尚未废除的装备栏类别并永久废除：武器栏，本回合出杀次数+3；防具栏，摸3张牌且本回合手牌上限+3；坐骑栏，本回合使用牌无距离限制；宝物栏，本回合获得【集智】。' },
    { id: POSHI, name: '破势', description: '觉醒技，准备阶段，若陆抗装备栏已全部废除或体力为1，强制发动：失去1点体力上限，摸牌至体力上限，永久失去【决堰】，获得【怀柔】。' },
    { id: HUAIROU, name: '怀柔', description: '出牌阶段，陆抗可以重铸一张装备牌（觉醒后获得，可反复发动）。', granted: true },
  ],
}
