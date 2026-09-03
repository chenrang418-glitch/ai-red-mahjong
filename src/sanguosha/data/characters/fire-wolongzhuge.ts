import { effectiveCardColor, registerSkillRuntime, type ViewAsOption } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

export const BAZHEN = 'bazhen'
export const HUOJI = 'huoji'
export const KANPO = 'kanpo'

function handViewAs(
  state: SanguoshaState,
  ownerId: PlayerId,
  color: 'red' | 'black',
  asCardName: string,
  skillName: string,
): ViewAsOption[] {
  const owner = state.players.find((player) => player.id === ownerId)
  if (!owner?.alive) return []
  return owner.zones.hand
    .filter((cardId) => effectiveCardColor(state, ownerId, cardId) === color)
    .filter((cardId) => state.cards[cardId]?.name !== asCardName)
    .map((cardId) => ({ asCardName, cardId, label: `发动【${skillName}】：将【${state.cards[cardId].name}】当【${asCardName}】使用` }))
}

registerSkillRuntime({
  id: BAZHEN,
  virtualArmor: () => '八卦阵',
})

registerSkillRuntime({
  id: HUOJI,
  viewAs(state, ownerId) {
    return handViewAs(state, ownerId, 'red', '火攻', '火计')
  },
})

registerSkillRuntime({
  id: KANPO,
  viewAs(state, ownerId) {
    return handViewAs(state, ownerId, 'black', '无懈可击', '看破')
  },
})

export const WOLONG_ZHUGE: CharacterDefinition = {
  id: 'wolongzhuge',
  name: '卧龙诸葛',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'fire',
  skills: [
    { id: BAZHEN, name: '八阵', description: '锁定技，若你的装备区里没有防具牌，视为你装备着【八卦阵】。' },
    { id: HUOJI, name: '火计', description: '你可以将一张红色手牌当【火攻】使用。' },
    { id: KANPO, name: '看破', description: '你可以将一张黑色手牌当【无懈可击】使用。' },
  ],
}
