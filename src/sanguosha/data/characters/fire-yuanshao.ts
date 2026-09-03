import { executeUseCardAction } from '../../engine/cards/basic'
import { instantTrickActions } from '../../engine/cards/tricks'
import type { ChooseCardsRequest, GameResponse } from '../../engine/requests'
import { effectiveCardSuit, registerSkillRuntime } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { getCharacter } from './standard'
import type { CharacterDefinition } from './types'

/**
 * 火包·袁绍。经典火包版本，不是界限突破。
 *
 * 【乱击】走的是「主动技 → 选两张牌 → 服务端校验 → 生成一次普通的万箭齐发使用」，
 * **不是**把所有两两组合都枚举成合法动作：十张手牌就是 45 种组合，越到后期越夸张，
 * 而且每一步都要重算。丈八蛇矛（两张手牌当一张杀）用的就是这条路，这里照搬。
 *
 * 万箭本身一行都不重复：目标生成、无懈轮询、求闪、伤害、濒死、雷击、天香
 * 全部走现有的即时锦囊管线。乱击只负责「把两张牌变成一次万箭的使用」。
 */

export const LUANJI = 'luanji'
export const XUEYI = 'xueyi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 判断「同花色」用的花色。
 *
 * 走 `effectiveCardSuit` 而不是 `card.suit`：项目里花色可以被技能改写
 * （小乔【红颜】把黑桃当红桃），其余规则都读有效花色，乱击不能自己开一套。
 */
function suitOf(state: SanguoshaState, playerId: PlayerId, cardId: CardId): string | null {
  return state.cards[cardId] ? effectiveCardSuit(state, playerId, cardId) : null
}

/** 手上是否存在两张同花色的牌——没有就不给这个动作。 */
export function canLuanji(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive || owner.zones.hand.length < 2) return false
  const seen = new Set<string>()
  for (const cardId of owner.zones.hand) {
    const suit = suitOf(state, ownerId, cardId)
    if (!suit) continue
    if (seen.has(suit)) return true
    seen.add(suit)
  }
  return false
}

/**
 * 校验这两张牌能不能当万箭用。
 *
 * **服务端自己验，不信客户端**：两张必须都是自己的手牌、必须是两张不同的牌、
 * 必须同花色。装备区、判定区、专属牌堆、私有区的牌一律不行——它们根本不在
 * `zones.hand` 里，这一条检查同时把它们挡住了。
 */
export function validateLuanjiCards(state: SanguoshaState, ownerId: PlayerId, cardIds: readonly CardId[]): string | null {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return '角色不存在或已阵亡'
  if (cardIds.length !== 2) return '【乱击】需要正好两张手牌'
  const [first, second] = cardIds
  if (first === second) return '【乱击】必须是两张不同的牌'
  for (const cardId of cardIds) {
    if (!owner.zones.hand.includes(cardId)) return '【乱击】只能使用自己的手牌'
  }
  const firstSuit = suitOf(state, ownerId, first)
  const secondSuit = suitOf(state, ownerId, second)
  if (!firstSuit || firstSuit !== secondSuit) return '【乱击】的两张牌必须花色相同'
  return null
}

registerSkillRuntime({
  id: LUANJI,
  announcesSelf: true,
  activeActionUsesCard: true,

  activeActions(state, ownerId) {
    // 经典乱击**没有次数限制**，只要凑得出两张同花色就能再来一次
    if (!canLuanji(state, ownerId)) return []
    return [{ id: `skill:${LUANJI}`, label: '发动【乱击】：将两张花色相同的手牌当【万箭齐发】使用' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${LUANJI}`) throw new Error('乱击动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !canLuanji(host.state, ownerId)) return
    host.askSkill({
      skillId: LUANJI,
      ownerId,
      step: 'cards',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: ownerId,
        prompt: '【乱击】：选择两张花色相同的手牌当【万箭齐发】使用',
        timeoutMs: 25_000,
        // 选牌本身可以放弃：这一步还没消耗任何东西
        optional: true,
        purpose: 'skill',
        cardIds: [...owner.zones.hand],
        hiddenCardSlots: [],
        min: 0,
        max: 2,
      }),
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step !== 'cards') return
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    // 放弃：什么都不做，也不消耗任何东西
    if (cardIds.length === 0) return
    const error = validateLuanjiCards(host.state, ownerId, cardIds)
    // 校验不过就当没发动。**这是服务端的最后一道闸**，客户端说了不算
    if (error) return

    const owner = playerOf(host.state, ownerId)!
    host.dispatch('SkillActivated', {
      skillId: LUANJI, skillName: '乱击', playerId: ownerId, result: 'invoke', cardIds: [...cardIds],
      logText: `${owner.nickname}发动【乱击】，将两张手牌当【万箭齐发】使用`,
    }, { sourceId: ownerId, cardIds: [...cardIds] })

    /*
     * 交给普通的万箭齐发管线。
     *
     * 目标由 `instantTrickActions` 按现有规则生成（固定全体，逐目标算禁止目标），
     * 后面的无懈轮询、求闪、伤害、濒死一行都不重复。
     */
    const [carrier, extra] = cardIds
    const [action] = instantTrickActions(host.state, ownerId, carrier, '万箭齐发')
    if (!action || action.kind !== 'use-card') return
    // 第一张当主牌，第二张跟着一起进处理区、结算完一起进弃牌堆
    executeUseCardAction(host as never, ownerId, { ...action, cardIds: [carrier, extra] })
  },
})

// ─────────────────────────────── 血裔 ───────────────────────────────

/**
 * 其他**存活**的群势力角色数。
 *
 * 每次算手牌上限时现算，不在开局缓存：群雄角色阵亡之后袁绍的上限要立刻跟着降。
 * 死人不算，袁绍自己不算。
 */
export function xueyiBonus(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  // 主公技：只有坐主公位才生效
  if (!owner?.alive || owner.identity !== 'lord') return 0
  return state.players.filter((player) => {
    if (!player.alive || player.id === ownerId || !player.characterId) return false
    return getCharacter(player.characterId)?.kingdom === 'qun'
  }).length
}

registerSkillRuntime({
  id: XUEYI,
  // 锁定技，没有发动时机，只在算手牌上限时被读到
  maxCardsBonus(state, ownerId) {
    return xueyiBonus(state, ownerId)
  },
})

export const YUANSHAO: CharacterDefinition = {
  id: 'yuanshao',
  name: '袁绍',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'fire',
  skills: [
    {
      id: LUANJI,
      name: '乱击',
      description: '出牌阶段，你可以将两张花色相同的手牌当【万箭齐发】使用。',
    },
    {
      id: XUEYI,
      name: '血裔',
      description: '主公技，锁定技，你的手牌上限+X（X为其他存活群势力角色的数量）。',
    },
  ],
}
