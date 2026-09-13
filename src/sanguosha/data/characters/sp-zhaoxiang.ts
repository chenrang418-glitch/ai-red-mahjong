import { drawCards } from '../../engine/draw'
import { replaceTemporarySkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { ALL_CHARACTERS, getCharacter } from './standard'
import type { ChooseGeneralRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 赵襄（三国杀 OL 经典身份 SP，当前 OL 版本；不是一将成名客户端"抽蜀势力
 * 技能"版）。
 *
 * 【芳魂】：赵襄使用【杀】或受到【杀】造成的伤害后，获得等量的"梅影"标记；
 *          只要仍持有梅影，可以消耗1枚发动【龙胆】并摸1张牌（直接复用赵云
 *          【龙胆】的 viewAs，用 source-bound 临时授予实现"仍有梅影就能用"）。
 * 【扶汉】：限定技，准备阶段若有梅影，可以移除所有梅影（累计计入本局总数），
 *          从随机5张蜀势力武将中选1张替换武将牌，maxHp=clamp(累计移除数,2,8)，
 *          然后回复1点体力。
 */

const FANGHUN = 'fanghun'
const FUHAN = 'fuhan'
const FUHAN_INVOKE = 'fuhan-invoke'
const MEIYING = 'meiying'
const FUHAN_TOTAL = 'fuhan-total-removed'
const FANGHUN_SOURCE = 'zhaoxiang:fanghun'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function meiyingOf(state: SanguoshaState, ownerId: PlayerId): number {
  return playerOf(state, ownerId)?.marks[MEIYING] ?? 0
}

/** 只要还有梅影，龙胆的 viewAs 就该对她可用；梅影清零立即收回。 */
function syncLongdanAccess(state: SanguoshaState, ownerId: PlayerId): void {
  replaceTemporarySkill(state, ownerId, FANGHUN_SOURCE, meiyingOf(state, ownerId) > 0 ? 'longdan' : null)
}

function gainMeiying(host: SkillHost, ownerId: PlayerId, amount: number): void {
  if (amount <= 0) return
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  owner.marks[MEIYING] = (owner.marks[MEIYING] ?? 0) + amount
  syncLongdanAccess(host.state, ownerId)
  host.dispatch('SkillActivated', { skillId: FANGHUN, skillName: '芳魂', playerId: ownerId, logText: `${owner.nickname}发动【芳魂】，获得${amount}枚梅影` }, { sourceId: ownerId })
}

function consumeMeiyingForLongdan(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner || (owner.marks[MEIYING] ?? 0) <= 0) return
  owner.marks[MEIYING] -= 1
  syncLongdanAccess(host.state, ownerId)
  host.dispatch('SkillActivated', { skillId: FANGHUN, skillName: '芳魂', playerId: ownerId, logText: `${owner.nickname}消耗1枚梅影发动【龙胆】，摸1张牌` }, { sourceId: ownerId })
  drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
}

function shuCandidatePool(state: SanguoshaState): CharacterDefinition[] {
  const seated = new Set(state.players.map((player) => player.characterId).filter(Boolean))
  return ALL_CHARACTERS.filter((character) => character.kingdom === 'shu' && character.pack !== 'entertainment' && !seated.has(character.id))
}

registerSkillRuntime({
  id: FANGHUN,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { amount?: number; cardName?: string }
        if (payload.cardName !== '杀' || (payload.amount ?? 0) <= 0) return
        const sourceId = context.event.sourceId
        const targetId = context.event.targetId
        if (sourceId === ownerId || targetId === ownerId) gainMeiying(host, ownerId, payload.amount ?? 0)
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId; cardName?: string; asCardName?: string }
        if (!payload.cardId) return
        const effective = payload.asCardName ?? payload.cardName
        if (effective !== '杀' || host.state.cards[payload.cardId]?.name !== '闪') return
        consumeMeiyingForLongdan(host, ownerId)
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId; cardName?: string }
        if (!payload.cardId || payload.cardName !== '闪' || host.state.cards[payload.cardId]?.name !== '杀') return
        consumeMeiyingForLongdan(host, ownerId)
      },
    },
  ],
})

registerSkillRuntime({
  id: FUHAN,
  limited: true,
  activeActions(state, ownerId) {
    if (state.phase !== 'prepare' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(FUHAN) || meiyingOf(state, ownerId) <= 0) return []
    return [{ id: FUHAN_INVOKE, label: '扶汉：移除所有梅影，替换为一名蜀势力武将' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== FUHAN_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(FUHAN)) return
    const removed = meiyingOf(host.state, ownerId)
    if (removed <= 0) return
    owner.usedLimitedSkills.push(FUHAN)
    owner.marks[MEIYING] = 0
    syncLongdanAccess(host.state, ownerId)
    owner.marks[FUHAN_TOTAL] = (owner.marks[FUHAN_TOTAL] ?? 0) + removed
    host.dispatch('SkillActivated', { skillId: FUHAN, skillName: '扶汉', playerId: ownerId, logText: `${owner.nickname}发动限定技【扶汉】，移除${removed}枚梅影` }, { sourceId: ownerId })

    const pool = [...shuCandidatePool(host.state)]
    const candidates: string[] = []
    for (let index = 0; index < 5 && pool.length > 0; index += 1) {
      candidates.push(pool.splice(host.rng.nextInt(pool.length), 1)[0].id)
    }
    if (candidates.length === 0) return
    host.askSkill({
      skillId: FUHAN, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseGeneralRequest => ({
        id: requestId, kind: 'choose-general', playerId: ownerId,
        prompt: '【扶汉】：选择一名蜀势力武将替换你的武将牌', timeoutMs: 30_000, optional: false,
        candidates, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const characterId = (response.payload as { characterId?: string }).characterId
    const character = characterId ? getCharacter(characterId) : undefined
    if (!character) return
    const totalRemoved = owner.marks[FUHAN_TOTAL] ?? 0
    owner.characterId = character.id
    owner.maxHp = Math.min(8, Math.max(2, totalRemoved))
    host.dispatch('SkillActivated', { skillId: FUHAN, skillName: '扶汉', playerId: ownerId, logText: `${owner.nickname}的武将牌被替换为${character.name}` }, { sourceId: ownerId, targetId: ownerId })
    const recovered = Math.min(1, Math.max(0, owner.maxHp - owner.hp))
    if (recovered > 0) {
      owner.hp += recovered
      host.dispatch('Recover', { playerId: ownerId, amount: recovered, reason: FUHAN }, { targetId: ownerId })
    }
  },
})

export const ZHAOXIANG: CharacterDefinition = {
  id: 'zhaoxiang',
  name: '赵襄',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: FANGHUN, name: '芳魂', description: '你使用【杀】或受到【杀】造成的伤害后，获得等量的"梅影"；只要仍持有梅影，可以消耗1枚发动【龙胆】并摸1张牌。' },
    { id: FUHAN, name: '扶汉', description: '限定技，准备阶段若你有梅影，可以移除所有梅影（累计计入本局总数），从随机5张蜀势力武将中选1张替换你的武将牌，体力上限变为2～8之间的累计移除数，然后回复1点体力。' },
  ],
}
