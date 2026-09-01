import { registerSkillRuntime, type ViewAsOption } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'
import { WEI_CHARACTERS } from './wei'
import { WEI_DAMAGE_CHARACTERS } from './wei-damage'

/**
 * 标准包武将。
 *
 * **只登记技能已经完整实现的武将。**任务书明令禁止「选将页看得到、技能其实没写」，
 * 所以这个数组就是「真的能玩」的清单，其余 21 将等实现完再加进来。
 *
 * 技能说明只在这里写一份，规则页直接读它，不另外维护副本。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

// —— 张飞【咆哮】——
registerSkillRuntime({
  id: 'paoxiao',
  // 锁定技，走和诸葛连弩同一个入口，不另写一套出杀次数逻辑
  unlimitedSlash: true,
})

// —— 马超【马术】——
registerSkillRuntime({
  id: 'mashu',
  // 距离修正只报数值，真正的计算仍然在 distance.ts 里
  distanceModifier: { toOthers: -1 },
})

// —— 关羽【武圣】——
registerSkillRuntime({
  id: 'wusheng',
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    const options: ViewAsOption[] = []
    for (const cardId of owner.zones.hand) {
      const card = state.cards[cardId]
      // 已经是杀的牌不需要转化；红色的其他牌才走武圣
      if (!card || card.color !== 'red' || card.name === '杀') continue
      options.push({ asCardName: '杀', cardId, label: `将【${card.name}】当【杀】使用` })
    }
    return options
  },
})

// —— 赵云【龙胆】——
registerSkillRuntime({
  id: 'longdan',
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    const options: ViewAsOption[] = []
    for (const cardId of owner.zones.hand) {
      const card = state.cards[cardId]
      if (!card) continue
      // 出牌阶段只有「闪当杀」有意义；「杀当闪」是响应阶段的事，见 dodgeViewAsOptions
      if (card.name === '闪') options.push({ asCardName: '杀', cardId, label: '将【闪】当【杀】使用' })
    }
    return options
  },
})

// —— 黄月英【集智】【奇才】——
registerSkillRuntime({
  id: 'jizhi',
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: string; cardName?: string }
      if (context.event.sourceId !== ownerId) return
      const cardId = payload.cardId
      if (!cardId) return
      // 只对非延时锦囊生效；延时锦囊放进判定区，不算「使用锦囊」触发集智
      const card = host.state.cards[cardId]
      if (!card || card.category !== 'trick') return
      if (DELAYED_TRICK_NAMES.has(card.name)) return
      const owner = host.state.players.find((candidate) => candidate.id === ownerId)
      if (!owner?.alive) return
      const drawn = host.state.zones.drawPile.shift()
      if (!drawn) return
      owner.zones.hand.push(drawn)
      host.dispatch('GainCard', { cardId: drawn, reason: '集智' }, { targetId: ownerId, cardIds: [drawn] })
    },
  }],
})

registerSkillRuntime({
  id: 'qicai',
  // 锁定技：使用锦囊无视距离。走统一入口，锦囊自己不重算距离。
  ignoresTrickDistance: true,
})

const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])


// —— 甘宁【奇袭】——
registerSkillRuntime({
  id: 'qixi',
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    const options: ViewAsOption[] = []
    for (const cardId of owner.zones.hand) {
      const card = state.cards[cardId]
      if (!card || card.color !== 'black' || card.name === '过河拆桥') continue
      options.push({ asCardName: '过河拆桥', cardId, label: `将【${card.name}】当【过河拆桥】使用` })
    }
    return options
  },
})

// —— 黄盖【苦肉】——
registerSkillRuntime({
  id: 'kurou',
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    // 体力只剩一点时发动会直接进濒死，规则允许，但 AI 不该主动送——交给 AI 评估
    if (!owner.alive || owner.hp <= 0) return []
    return [{ id: 'skill:kurou', label: '发动【苦肉】：失去一点体力，摸两张牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:kurou') throw new Error('苦肉动作不匹配')
    // 走统一伤害入口的「失去体力」不同：苦肉是失去体力，不是受到伤害，
    // 所以不触发伤害时机，但仍然可能进入濒死。
    const owner = playerOf(host.state, ownerId)
    owner.hp -= 1
    host.dispatch('LoseHp', { playerId: ownerId, amount: 1, reason: '苦肉' }, { targetId: ownerId })
    for (let index = 0; index < 2; index += 1) {
      const drawn = host.state.zones.drawPile.shift()
      if (!drawn) break
      owner.zones.hand.push(drawn)
      host.dispatch('GainCard', { cardId: drawn, reason: '苦肉' }, { targetId: ownerId, cardIds: [drawn] })
    }
  },
})

// —— 孙尚香【枭姬】——
registerSkillRuntime({
  id: 'xiaoji',
  triggers: [{
    event: 'LoseEquipment',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: string }
      if (payload.playerId !== ownerId) return
      const owner = host.state.players.find((candidate) => candidate.id === ownerId)
      if (!owner?.alive) return
      for (let index = 0; index < 2; index += 1) {
        const drawn = host.state.zones.drawPile.shift()
        if (!drawn) break
        owner.zones.hand.push(drawn)
        host.dispatch('GainCard', { cardId: drawn, reason: '枭姬' }, { targetId: ownerId, cardIds: [drawn] })
      }
    },
  }],
})

/** 需要打出【闪】时，哪些手牌可以转化成【闪】。 */
export function dodgeViewAsOptions(state: SanguoshaState, playerId: PlayerId): ViewAsOption[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player?.characterId) return []
  const skillIds = skillIdsOf(player.characterId)
  const options: ViewAsOption[] = []
  if (skillIds.includes('longdan')) {
    for (const cardId of player.zones.hand) {
      if (state.cards[cardId]?.name === '杀') options.push({ asCardName: '闪', cardId, label: '将【杀】当【闪】打出' })
    }
  }
  if (skillIds.includes('wusheng')) {
    // 武圣只能把红牌当【杀】用，不能当【闪】——这里刻意不加，免得以后误改
  }
  return options
}

export const STANDARD_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'zhangfei',
    name: '张飞',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'paoxiao', name: '咆哮', description: '锁定技，你使用【杀】没有次数限制。' }],
  },
  {
    id: 'machao',
    name: '马超',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'mashu', name: '马术', description: '锁定技，你计算与其他角色的距离时，始终减一。' }],
  },
  {
    id: 'guanyu',
    name: '关羽',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'wusheng', name: '武圣', description: '你可以将一张红色牌当【杀】使用。' }],
  },
  {
    id: 'huangyueying',
    name: '黄月英',
    kingdom: 'shu',
    gender: 'female',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'jizhi', name: '集智', description: '每当你使用一张非延时类锦囊牌时，你可以摸一张牌。' },
      { id: 'qicai', name: '奇才', description: '锁定技，你使用锦囊牌无距离限制。' },
    ],
  },
  {
    id: 'ganning',
    name: '甘宁',
    kingdom: 'wu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'qixi', name: '奇袭', description: '你可以将一张黑色牌当【过河拆桥】使用。' }],
  },
  {
    id: 'huanggai',
    name: '黄盖',
    kingdom: 'wu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'kurou', name: '苦肉', description: '出牌阶段，你可以失去一点体力，然后摸两张牌。' }],
  },
  {
    id: 'sunshangxiang',
    name: '孙尚香',
    kingdom: 'wu',
    gender: 'female',
    maxHp: 3,
    pack: 'standard',
    skills: [{ id: 'xiaoji', name: '枭姬', description: '每当你失去一张装备区里的牌时，你可以摸两张牌。' }],
  },
  {
    id: 'zhaoyun',
    name: '赵云',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'longdan', name: '龙胆', description: '你可以将【杀】当【闪】、将【闪】当【杀】使用或打出。' }],
  },
  // 需要向玩家发问的技能单独放一个文件，那里的注释解释了哪些时机还不能安全挂起
  ...WEI_CHARACTERS,
  // 「受到伤害后」触发的技能走延后发问队列，原因见 wei-damage.ts 顶部
  ...WEI_DAMAGE_CHARACTERS,
] as const

const BY_ID = new Map(STANDARD_CHARACTERS.map((character) => [character.id, character]))

export function getCharacter(characterId: string): CharacterDefinition | undefined {
  return BY_ID.get(characterId)
}

export function skillIdsOf(characterId: string): string[] {
  return BY_ID.get(characterId)?.skills.map((skill) => skill.id) ?? []
}

export function allCharacterIds(): string[] {
  return STANDARD_CHARACTERS.map((character) => character.id)
}

/** 这名玩家使用锦囊时是否无视距离（奇才）。 */
export function ignoresTrickDistance(state: SanguoshaState, playerId: PlayerId): boolean {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player?.characterId) return false
  return skillIdsOf(player.characterId).includes('qicai')
}
